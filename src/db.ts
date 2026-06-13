/**
 * D1 persistence layer for isUpMap.
 *
 * The cron handler calls {@link persistSnapshot} each run; the HTTP API reads
 * via {@link readSnapshot} / {@link recentIncidents}. Only `degraded` and
 * `down` are treated as incident-worthy — `unknown` (a failed/timed-out probe)
 * is "no data", so it neither opens an incident nor counts as downtime.
 */

import type { ServiceStatus, StatusLevel } from "./services";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Resolved incidents older than this are pruned by the retention sweep. */
const RETENTION_MS = 90 * DAY_MS;

/** Statuses that constitute an ongoing incident. */
function isIncident(status: StatusLevel): boolean {
	return status === "degraded" || status === "down";
}

/**
 * Consecutive polls a non-up status must hold before it is "confirmed" (shown in
 * `current` / opens an incident). With a 5-minute cron, 2 means a bad reading must
 * survive ~5–10 min — long enough to ride out a single glitchy upstream response.
 */
const CONFIRM_THRESHOLD = 2;

/**
 * Flap-dampening: map the just-observed status to the status we actually commit,
 * given how many consecutive polls it has held (`streak`) and the previously
 * committed status (`prev`).
 *
 *   - `up`      → committed immediately (recovery is never delayed).
 *   - `unknown` → a failed/timed-out probe carries no information, so we HOLD the
 *                 previous committed status (a blip mustn't "resolve" a real
 *                 incident, nor flip a healthy service grey).
 *   - `degraded`/`down` → committed only once it has held for CONFIRM_THRESHOLD
 *                 polls; until then we hold the previous status. A lone glitch
 *                 (e.g. `down` then `up`) therefore never shows red or opens an
 *                 incident.
 */
function confirmStatus(observed: StatusLevel, streak: number, prev: StatusLevel | undefined): StatusLevel {
	if (observed === "up") return "up";
	if (observed === "unknown") return prev ?? "unknown";
	if (streak >= CONFIRM_THRESHOLD) return observed;
	return prev ?? "up";
}

interface ProbeStateRow {
	service_id: string;
	observed_status: StatusLevel;
	streak: number;
}

interface CurrentRow {
	service_id: string;
	name: string;
	category: string;
	weight: number;
	status: StatusLevel;
	description: string | null;
	details_json: string | null;
	updated_at: number;
}

interface IncidentIntervalRow {
	service_id: string;
	status: StatusLevel;
	started_at: number;
	ended_at: number | null;
}

export interface IncidentRecord {
	id: number;
	serviceId: string;
	serviceName: string | null;
	category: string | null;
	status: StatusLevel;
	description: string | null;
	startedAt: number;
	endedAt: number | null;
}

export interface ApiService {
	id: string;
	name: string;
	category: string;
	weight: number;
	status: StatusLevel;
	description: string;
	details?: unknown;
	uptime: { day: number; week: number };
	/** Reason the service is disabled (unreliable source), if applicable. */
	disabled?: string;
	/**
	 * Community-report surge overlay: true when an anomalous number of users are
	 * reporting problems right now (see detectSurges in src/reports.ts). Purely
	 * supplementary — it never drives `status`/color, only a UI hint.
	 */
	surge?: boolean;
	/**
	 * 24h hourly report-volume series (oldest first) for the per-tile sparkline.
	 * Omitted when a service has no reports in the window. Supplementary overlay
	 * only (see reportSparklines in src/reports.ts).
	 */
	spark?: number[];
}

/**
 * Persist a freshly-resolved snapshot: upsert every `current` row, and open /
 * close / update incident rows based on transitions vs the previous snapshot.
 * All writes run in a single batched (transactional) call.
 */
export async function persistSnapshot(db: D1Database, statuses: ServiceStatus[], now = Date.now()): Promise<void> {
	// One round-trip for the three things transition + flap-dampening logic needs:
	// the open incident per service, the per-service streak, and the previously
	// committed row (status + copy we hold onto while a non-up reading is unconfirmed).
	const [openRes, stateRes, currentRes] = await db.batch([
		db.prepare("SELECT service_id, status FROM incidents WHERE ended_at IS NULL"),
		db.prepare("SELECT service_id, observed_status, streak FROM probe_state"),
		db.prepare("SELECT service_id, status, description, details_json FROM current"),
	]);
	const open = new Map((openRes.results as { service_id: string; status: StatusLevel }[]).map((r) => [r.service_id, r.status]));
	const state = new Map((stateRes.results as ProbeStateRow[]).map((r) => [r.service_id, r]));
	const prevCurrent = new Map(
		(currentRes.results as { service_id: string; status: StatusLevel; description: string | null; details_json: string | null }[]).map((r) => [r.service_id, r]),
	);

	const upsertCurrent = db.prepare(
		`INSERT INTO current (service_id, name, category, weight, status, description, details_json, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(service_id) DO UPDATE SET
		   name = excluded.name, category = excluded.category, weight = excluded.weight,
		   status = excluded.status, description = excluded.description,
		   details_json = excluded.details_json, updated_at = excluded.updated_at`,
	);
	const upsertState = db.prepare(
		`INSERT INTO probe_state (service_id, observed_status, streak) VALUES (?, ?, ?)
		 ON CONFLICT(service_id) DO UPDATE SET observed_status = excluded.observed_status, streak = excluded.streak`,
	);
	const openIncident = db.prepare(
		"INSERT INTO incidents (service_id, status, description, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)",
	);
	const closeIncident = db.prepare("UPDATE incidents SET ended_at = ? WHERE service_id = ? AND ended_at IS NULL");
	const updateIncident = db.prepare("UPDATE incidents SET status = ?, description = ? WHERE service_id = ? AND ended_at IS NULL");

	const batch: D1PreparedStatement[] = [];

	for (const s of statuses) {
		const observed = s.status;
		const prevState = state.get(s.id);
		const streak = prevState && prevState.observed_status === observed ? prevState.streak + 1 : 1;
		batch.push(upsertState.bind(s.id, observed, streak));

		const prevRow = prevCurrent.get(s.id);
		const committed = confirmStatus(observed, streak, prevRow?.status);

		// When the committed status is the one we just observed, write its fresh
		// description/details; while holding the previous status (unconfirmed bad
		// reading, or an uninformative `unknown`), keep the previous copy so the
		// text matches the status shown.
		const fresh = committed === observed;
		const description = fresh ? (s.description ?? null) : (prevRow?.description ?? null);
		const detailsJson = fresh ? (s.details ? JSON.stringify(s.details) : null) : (prevRow?.details_json ?? null);
		batch.push(upsertCurrent.bind(s.id, s.name, s.category, s.weight, committed, description, detailsJson, now));

		const openStatus = open.get(s.id); // undefined unless an incident is open
		const wasIncident = openStatus != null;
		const nowIncident = isIncident(committed);

		if (!wasIncident && nowIncident) {
			batch.push(openIncident.bind(s.id, committed, description, now));
		} else if (wasIncident && !nowIncident) {
			batch.push(closeIncident.bind(now, s.id));
		} else if (wasIncident && nowIncident && openStatus !== committed) {
			batch.push(updateIncident.bind(committed, description, s.id));
		}
	}

	batch.push(
		db.prepare("INSERT INTO meta (key, value) VALUES ('last_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(now)),
	);

	await db.batch(batch);
}

/** Operational fraction (0..1) over a trailing window, derived from incidents. */
function uptimeFraction(intervals: IncidentIntervalRow[], windowMs: number, now: number): number {
	const windowStart = now - windowMs;
	let downtime = 0;
	for (const iv of intervals) {
		const start = Math.max(iv.started_at, windowStart);
		const end = Math.min(iv.ended_at ?? now, now);
		if (end > start) downtime += end - start;
	}
	const frac = 1 - downtime / windowMs;
	return Math.min(1, Math.max(0, frac));
}

/**
 * Read the current snapshot for the API, computing per-service 24h/7d uptime
 * from incident intervals. Returns `null` if the store hasn't been populated
 * yet (so callers can fall back to a live fetch).
 */
export async function readSnapshot(db: D1Database, now = Date.now()): Promise<{ updatedAt: number | null; services: ApiService[] } | null> {
	// One round-trip for all three reads (current snapshot, recent incidents,
	// last-run marker) instead of three sequential awaits. The empty-snapshot
	// early-return below only fires at cold start (before the first cron), so
	// running all three eagerly costs nothing in practice.
	const since = now - WEEK_MS;
	const [currentRes, incidentRes, lastRunRes] = await db.batch([
		db.prepare("SELECT * FROM current"),
		db.prepare("SELECT service_id, status, started_at, ended_at FROM incidents WHERE ended_at IS NULL OR ended_at >= ?").bind(since),
		db.prepare("SELECT value FROM meta WHERE key = 'last_run'"),
	]);

	const currentRows = currentRes.results as CurrentRow[];
	if (currentRows.length === 0) return null;

	const byService = new Map<string, IncidentIntervalRow[]>();
	for (const iv of incidentRes.results as IncidentIntervalRow[]) {
		const list = byService.get(iv.service_id) ?? [];
		list.push(iv);
		byService.set(iv.service_id, list);
	}

	const lastRun = (lastRunRes.results as { value: string }[])[0];

	const services: ApiService[] = currentRows.map((r) => {
		const intervals = byService.get(r.service_id) ?? [];
		return {
			id: r.service_id,
			name: r.name,
			category: r.category,
			weight: r.weight,
			status: r.status,
			description: r.description ?? "",
			details: r.details_json ? safeParse(r.details_json) : undefined,
			uptime: {
				day: uptimeFraction(intervals, DAY_MS, now),
				week: uptimeFraction(intervals, WEEK_MS, now),
			},
		};
	});

	return { updatedAt: lastRun ? Number(lastRun.value) : null, services };
}

/**
 * Most recent incidents (newest first), joined with the service name.
 * Pass `serviceId` to restrict to a single service (used by the detail sheet).
 */
export async function recentIncidents(db: D1Database, limit = 25, serviceId?: string): Promise<IncidentRecord[]> {
	const where = serviceId ? "WHERE i.service_id = ?" : "";
	const binds = serviceId ? [serviceId, limit] : [limit];
	const rows = await db
		.prepare(
			`SELECT i.id, i.service_id, c.name AS service_name, c.category, i.status, i.description, i.started_at, i.ended_at
			 FROM incidents i LEFT JOIN current c ON c.service_id = i.service_id
			 ${where}
			 ORDER BY i.started_at DESC LIMIT ?`,
		)
		.bind(...binds)
		.all<{
			id: number;
			service_id: string;
			service_name: string | null;
			category: string | null;
			status: StatusLevel;
			description: string | null;
			started_at: number;
			ended_at: number | null;
		}>();

	return rows.results.map((r) => ({
		id: r.id,
		serviceId: r.service_id,
		serviceName: r.service_name,
		category: r.category,
		status: r.status,
		description: r.description,
		startedAt: r.started_at,
		endedAt: r.ended_at,
	}));
}

/** Delete resolved incidents older than the retention window. Returns rows removed. */
export async function pruneIncidents(db: D1Database, now = Date.now()): Promise<number> {
	const res = await db.prepare("DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?").bind(now - RETENTION_MS).run();
	return res.meta.changes ?? 0;
}

function safeParse(json: string): unknown {
	try {
		return JSON.parse(json);
	} catch {
		return undefined;
	}
}
