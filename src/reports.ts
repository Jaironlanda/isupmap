/**
 * Community "report it's down" signal.
 *
 * Entirely separate from the authoritative status pipeline — reports are a
 * supplementary signal and never alter confirmStatus / incidents / the snapshot.
 *
 * Write path: POST /api/report/:id → VOTE_QUEUE → queue consumer → REPORTS_DB
 * Read path:  GET  /api/report/:id → KV (reportcount:<id>, 10-min TTL) → D1 on miss
 */

// ---- Constants --------------------------------------------------------------

/** One vote per IP-hash per service per window (24 h). */
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Aggregate counts over the trailing 7-day window. */
export const REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** One day, in ms — the bucket size for the 7-day report-volume timeline. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** One hour, in ms — the bucket size for the 24h report-volume sparkline. */
const HOUR_MS = 60 * 60 * 1000;

/** Number of daily buckets in the report-volume timeline. */
const TIMELINE_DAYS = 7;

/** Number of hourly buckets in the 24h report-volume sparkline (tiles + chart). */
export const SPARK_HOURS = 24;

/** Delete reports older than this during the daily retention sweep. */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** KV TTL for cached report counts (10 min). */
const KV_TTL_SECS = 600;

// ---- Types (public API shapes) ----------------------------------------------

export type ReportReason = "unreachable" | "errors" | "login" | "slow" | "other";

export interface CountryCount {
	country: string;
	count: number;
}

export interface ReasonCount {
	reason: ReportReason;
	count: number;
}

/** A single recent report row, surfaced in the "Latest reports" feed. */
export interface RecentReport {
	country: string;
	reason: ReportReason;
	ts: number;
}

/** One daily bucket in the 7-day report-volume timeline. */
export interface TimelinePoint {
	/** Start of the day bucket (ms epoch, UTC-aligned). */
	t: number;
	count: number;
}

export interface Report {
	windowMs: number;
	total: number;
	countries: CountryCount[];
	reasons: ReasonCount[];
	/** Up to 10 most-recent individual reports, newest first. */
	recent: RecentReport[];
	/** 7 daily buckets over the last 7 days, oldest first (report-volume chart). */
	timeline: TimelinePoint[];
	/** 24 hourly buckets over the last 24h, oldest first (Downdetector-style chart). */
	hourly: TimelinePoint[];
	/** Whether community reports are currently surging (anomaly confirmed). */
	surge: boolean;
}

/** Internal queue message shape — not part of the public API. */
export interface VoteMessage {
	serviceId: string;
	country: string;
	ipHash: string;
	reason: ReportReason;
	ts: number;
}

// ---- Reason enum ------------------------------------------------------------

/** Ordered code→label map. Single source of truth for server validation and the frontend. */
export const REPORT_REASONS: Record<ReportReason, string> = {
	unreachable: "Can't connect",
	errors: "Errors",
	login: "Can't log in",
	slow: "Slow",
	other: "Something else",
};

const VALID_REASONS = new Set(Object.keys(REPORT_REASONS) as ReportReason[]);

/** Coerce an unknown/missing reason string to `other`. */
export function normalizeReason(input: unknown): ReportReason {
	if (typeof input === "string" && VALID_REASONS.has(input as ReportReason)) {
		return input as ReportReason;
	}
	return "other";
}

// ---- D1 helpers (take a D1Database, called with env.REPORTS_DB) -------------

interface ReportRow {
	service_id: string;
	ip_hash: string;
	country: string;
	reason: string;
	bucket: number;
	ts: number;
}

/** Batch-insert vote rows into REPORTS_DB, silently ignoring duplicates (PK conflict). */
export async function insertReports(db: D1Database, rows: VoteMessage[]): Promise<void> {
	if (rows.length === 0) return;
	const stmt = db.prepare(
		"INSERT OR IGNORE INTO reports (service_id, ip_hash, country, reason, bucket, ts) VALUES (?, ?, ?, ?, ?, ?)",
	);
	await db.batch(
		rows.map((r) =>
			stmt.bind(
				r.serviceId,
				r.ipHash,
				r.country,
				r.reason,
				Math.floor(r.ts / DEDUP_WINDOW_MS),
				r.ts,
			),
		),
	);
}

interface CountRow {
	label: string;
	count: number;
}

interface RecentRow {
	country: string;
	reason: string;
	ts: number;
}

interface DayRow {
	day: number;
	count: number;
}

interface HourRow {
	hour: number;
	count: number;
}

/**
 * Aggregate recent reports for a service over the trailing REPORT_WINDOW_MS.
 * Returns 7-day totals plus per-country and per-reason breakdowns, the 10 newest
 * individual reports, and a 7-day daily volume timeline.
 */
export async function aggregateReports(db: D1Database, serviceId: string, now = Date.now()): Promise<Report> {
	const since = now - REPORT_WINDOW_MS;
	// 7-day timeline aligned to day boundaries so buckets are whole (UTC) days.
	const nowDay = Math.floor(now / DAY_MS);
	const firstDay = nowDay - (TIMELINE_DAYS - 1);
	const since7 = firstDay * DAY_MS;
	// 24h sparkline aligned to hour boundaries.
	const nowHour = Math.floor(now / HOUR_MS);
	const firstHour = nowHour - (SPARK_HOURS - 1);
	const since24 = firstHour * HOUR_MS;

	const [byCountry, byReason, latest, byDay, byHour, baseline] = await db.batch([
		db
			.prepare(
				"SELECT country AS label, COUNT(*) AS count FROM reports WHERE service_id = ? AND ts > ? GROUP BY country ORDER BY count DESC",
			)
			.bind(serviceId, since),
		db
			.prepare(
				"SELECT reason AS label, COUNT(*) AS count FROM reports WHERE service_id = ? AND ts > ? GROUP BY reason ORDER BY count DESC",
			)
			.bind(serviceId, since),
		db
			.prepare(
				"SELECT country, reason, ts FROM reports WHERE service_id = ? AND ts > ? ORDER BY ts DESC LIMIT 10",
			)
			.bind(serviceId, since),
		db
			.prepare(
				"SELECT ts / 86400000 AS day, COUNT(*) AS count FROM reports WHERE service_id = ? AND ts >= ? GROUP BY day",
			)
			.bind(serviceId, since7),
		db
			.prepare(
				"SELECT ts / 3600000 AS hour, COUNT(*) AS count FROM reports WHERE service_id = ? AND ts >= ? GROUP BY hour",
			)
			.bind(serviceId, since24),
		db.prepare("SELECT surge FROM report_baseline WHERE service_id = ?").bind(serviceId),
	]);

	const countries = (byCountry.results as CountRow[]).map((r) => ({ country: r.label, count: r.count }));
	const reasons = (byReason.results as CountRow[]).map((r) => ({ reason: r.label as ReportReason, count: r.count }));
	const recent = (latest.results as RecentRow[]).map((r) => ({ country: r.country, reason: r.reason as ReportReason, ts: r.ts }));
	const total = countries.reduce((s, c) => s + c.count, 0);

	// Densify the sparse day rows into a contiguous 7-bucket array (oldest first).
	const dayCounts = new Map((byDay.results as DayRow[]).map((r) => [r.day, r.count]));
	const timeline: TimelinePoint[] = [];
	for (let d = firstDay; d <= nowDay; d++) {
		timeline.push({ t: d * DAY_MS, count: dayCounts.get(d) ?? 0 });
	}

	// Densify the sparse hour rows into a contiguous 24-bucket array (oldest first).
	const hourCounts = new Map((byHour.results as HourRow[]).map((r) => [r.hour, r.count]));
	const hourly: TimelinePoint[] = [];
	for (let h = firstHour; h <= nowHour; h++) {
		hourly.push({ t: h * HOUR_MS, count: hourCounts.get(h) ?? 0 });
	}

	const surge = ((baseline.results as { surge: number }[])[0]?.surge ?? 0) === 1;

	return { windowMs: REPORT_WINDOW_MS, total, countries, reasons, recent, timeline, hourly, surge };
}

/**
 * 24h hourly report-volume series for *every* service that has reports, in one
 * query — the per-tile sparkline data folded into the snapshot by the cron.
 * Returns a contiguous {@link SPARK_HOURS}-length array (oldest first) per
 * service; services with no reports in the window are absent from the map.
 */
export async function reportSparklines(db: D1Database, now = Date.now()): Promise<Map<string, number[]>> {
	const nowHour = Math.floor(now / HOUR_MS);
	const firstHour = nowHour - (SPARK_HOURS - 1);
	const since = firstHour * HOUR_MS;

	const res = await db
		.prepare("SELECT service_id, ts / 3600000 AS hour, COUNT(*) AS count FROM reports WHERE ts >= ? GROUP BY service_id, hour")
		.bind(since)
		.all<{ service_id: string; hour: number; count: number }>();

	const byService = new Map<string, Map<number, number>>();
	for (const r of res.results) {
		const hours = byService.get(r.service_id) ?? new Map<number, number>();
		hours.set(r.hour, r.count);
		byService.set(r.service_id, hours);
	}

	const out = new Map<string, number[]>();
	for (const [id, hours] of byService) {
		const arr: number[] = [];
		for (let h = firstHour; h <= nowHour; h++) arr.push(hours.get(h) ?? 0);
		out.set(id, arr);
	}
	return out;
}

/** Delete reports older than the retention window. Returns the row count removed. */
export async function pruneReports(db: D1Database, now = Date.now()): Promise<number> {
	const res = await db.prepare("DELETE FROM reports WHERE ts < ?").bind(now - RETENTION_MS).run();
	return res.meta.changes ?? 0;
}

// ---- Surge detection (Downdetector-style anomaly signal) --------------------

/**
 * Trailing window whose report count is scored against the baseline. Wider than
 * the 5-minute cron interval so consecutive passes overlap and a brief lull
 * mid-incident doesn't drop the count to zero.
 */
export const SURGE_BUCKET_MS = 30 * 60 * 1000;
/** z-score at/above which the live count counts as a statistical outlier. */
export const SURGE_Z = 3;
/**
 * Absolute floor: never raise a surge on fewer than this many reports in the
 * window, however large the z-score. This is the deliberate blind spot for
 * low-traffic services — a handful of reports against a ~0 baseline yields a
 * huge z, but is far too thin to call. Better a miss than a false outage.
 */
export const SURGE_MIN = 5;
/**
 * Consecutive anomalous buckets required before the surge is shown. Mirrors the
 * status pipeline's CONFIRM_THRESHOLD (src/db.ts) so one noisy bucket can't flip
 * the badge.
 */
export const SURGE_CONFIRM = 2;
/** EWMA adaptation speed for the baseline (mean + variance). */
const SURGE_ALPHA = 0.1;

/** Per-service surge state returned by {@link detectSurges}. */
export interface Surge {
	serviceId: string;
	/** Reports observed in the trailing {@link SURGE_BUCKET_MS} window. */
	observed: number;
	/** Expected reports for this service/window (baseline mean before this pass). */
	baseline: number;
	/** How many standard deviations above baseline the observed count is. */
	z: number;
	/** True once an anomaly has held for {@link SURGE_CONFIRM} consecutive buckets. */
	surging: boolean;
	/** Epoch ms the (confirmed) surge opened, if currently surging. */
	since?: number;
}

interface BaselineRow {
	service_id: string;
	ewma_rate: number;
	ewma_var: number;
	surge: number;
	streak: number;
	surge_since: number | null;
	updated_at: number;
}

/**
 * Score each service's recent Community-Report volume against its own rolling
 * baseline and update that baseline — the anomaly half of a Downdetector-style
 * signal. Reads only the `reports` rows already collected; raises a `surging`
 * flag when the trailing-window count is both a statistical outlier (z ≥
 * {@link SURGE_Z}) and clears the absolute {@link SURGE_MIN} floor, sustained
 * for {@link SURGE_CONFIRM} passes.
 *
 * Stateful: maintains `report_baseline` (EWMA mean + variance) across calls.
 * The baseline is **frozen** while a service is anomalous so an ongoing surge
 * can't retrain the model to expect outages. First-seen services are seeded and
 * never surge on their first pass. Returns one entry per service that already
 * had a baseline (i.e. excludes just-seeded ones).
 *
 * Supplementary only: callers overlay the result; it never feeds confirmStatus.
 */
export async function detectSurges(db: D1Database, now = Date.now()): Promise<Map<string, Surge>> {
	const since = now - SURGE_BUCKET_MS;
	const [countsRes, baseRes] = await db.batch([
		db.prepare("SELECT service_id, COUNT(*) AS count FROM reports WHERE ts > ? GROUP BY service_id").bind(since),
		db.prepare("SELECT * FROM report_baseline"),
	]);

	const counts = new Map((countsRes.results as { service_id: string; count: number }[]).map((r) => [r.service_id, r.count]));
	const base = new Map((baseRes.results as BaselineRow[]).map((r) => [r.service_id, r]));

	const upsert = db.prepare(
		`INSERT INTO report_baseline (service_id, ewma_rate, ewma_var, surge, streak, surge_since, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(service_id) DO UPDATE SET
		   ewma_rate = excluded.ewma_rate, ewma_var = excluded.ewma_var, surge = excluded.surge,
		   streak = excluded.streak, surge_since = excluded.surge_since, updated_at = excluded.updated_at`,
	);

	const out = new Map<string, Surge>();
	const writes: D1PreparedStatement[] = [];

	// Union of services with a baseline and/or reports this window: a baselined
	// service with zero reports still needs its baseline to decay toward zero.
	for (const id of new Set([...base.keys(), ...counts.keys()])) {
		const observed = counts.get(id) ?? 0;
		const prev = base.get(id);

		// Cold start: seed the baseline, never surge on first sight.
		if (!prev) {
			writes.push(upsert.bind(id, observed, Math.max(observed, 1), 0, 0, null, now));
			continue;
		}

		// Variance is floored at 1 so a long-quiet baseline (var → 0) still needs a
		// few absolute reports — not a single one — to read as an outlier.
		const std = Math.sqrt(Math.max(prev.ewma_var, 1));
		const z = (observed - prev.ewma_rate) / std;
		const anomalous = observed >= SURGE_MIN && z >= SURGE_Z;
		const streak = anomalous ? prev.streak + 1 : 0;
		const surging = streak >= SURGE_CONFIRM;
		const since = surging ? (prev.surge_since ?? now) : null;

		// Freeze the baseline while anomalous so the spike can't inflate "normal".
		let rate = prev.ewma_rate;
		let varr = prev.ewma_var;
		if (!anomalous) {
			const diff = observed - rate;
			rate = SURGE_ALPHA * observed + (1 - SURGE_ALPHA) * rate;
			varr = (1 - SURGE_ALPHA) * (varr + SURGE_ALPHA * diff * diff);
		}

		writes.push(upsert.bind(id, rate, varr, surging ? 1 : 0, streak, since, now));
		out.set(id, { serviceId: id, observed, baseline: prev.ewma_rate, z, surging, since: since ?? undefined });
	}

	await db.batch(writes);
	return out;
}

// ---- Edge glue --------------------------------------------------------------

/** Normalize the CF country code, bucketing absent/unknown/Tor to "Unknown". */
export function countryOf(request: Request): string {
	const cf = (request as Request & { cf?: { country?: string } }).cf;
	const code = cf?.country;
	if (!code || code === "XX" || code === "T1") return "Unknown";
	return code;
}

/** SHA-256(ip + salt) as a hex string. Raw IP is never stored. */
export async function hashIp(ip: string, salt: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(ip + salt);
	const buf = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

const KV_PREFIX = "reportcount:";

/** Read a cached report count from KV; returns null on miss. */
export async function readCount(kv: KVNamespace, serviceId: string): Promise<Report | null> {
	return kv.get<Report>(`${KV_PREFIX}${serviceId}`, "json");
}

/** Write/refresh a report count into KV with a 10-min TTL. */
export async function writeCount(kv: KVNamespace, serviceId: string, report: Report): Promise<void> {
	await kv.put(`${KV_PREFIX}${serviceId}`, JSON.stringify(report), { expirationTtl: KV_TTL_SECS });
}
