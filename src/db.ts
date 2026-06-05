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
}

/**
 * Persist a freshly-resolved snapshot: upsert every `current` row, and open /
 * close / update incident rows based on transitions vs the previous snapshot.
 * All writes run in a single batched (transactional) call.
 */
export async function persistSnapshot(db: D1Database, statuses: ServiceStatus[], now = Date.now()): Promise<void> {
	// Transition detection only needs to know which services currently have an
	// OPEN incident. Reading those (0–few rows, served by idx_incidents_open) is
	// far cheaper than scanning every `current` row each minute.
	const openRows = await db
		.prepare("SELECT service_id, status FROM incidents WHERE ended_at IS NULL")
		.all<{ service_id: string; status: StatusLevel }>();
	const open = new Map(openRows.results.map((r) => [r.service_id, r.status]));

	const upsertCurrent = db.prepare(
		`INSERT INTO current (service_id, name, category, weight, status, description, details_json, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(service_id) DO UPDATE SET
		   name = excluded.name, category = excluded.category, weight = excluded.weight,
		   status = excluded.status, description = excluded.description,
		   details_json = excluded.details_json, updated_at = excluded.updated_at`,
	);
	const openIncident = db.prepare(
		"INSERT INTO incidents (service_id, status, description, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)",
	);
	const closeIncident = db.prepare("UPDATE incidents SET ended_at = ? WHERE service_id = ? AND ended_at IS NULL");
	const updateIncident = db.prepare("UPDATE incidents SET status = ?, description = ? WHERE service_id = ? AND ended_at IS NULL");

	const batch: D1PreparedStatement[] = [];

	for (const s of statuses) {
		batch.push(
			upsertCurrent.bind(s.id, s.name, s.category, s.weight, s.status, s.description ?? null, s.details ? JSON.stringify(s.details) : null, now),
		);

		const openStatus = open.get(s.id); // undefined unless an incident is open
		const wasIncident = openStatus != null;
		const nowIncident = isIncident(s.status);

		if (!wasIncident && nowIncident) {
			batch.push(openIncident.bind(s.id, s.status, s.description ?? null, now));
		} else if (wasIncident && !nowIncident) {
			batch.push(closeIncident.bind(now, s.id));
		} else if (wasIncident && nowIncident && openStatus !== s.status) {
			batch.push(updateIncident.bind(s.status, s.description ?? null, s.id));
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

/** Most recent incidents (newest first), joined with the service name. */
export async function recentIncidents(db: D1Database, limit = 25): Promise<IncidentRecord[]> {
	const rows = await db
		.prepare(
			`SELECT i.id, i.service_id, c.name AS service_name, c.category, i.status, i.description, i.started_at, i.ended_at
			 FROM incidents i LEFT JOIN current c ON c.service_id = i.service_id
			 ORDER BY i.started_at DESC LIMIT ?`,
		)
		.bind(limit)
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
