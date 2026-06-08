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

/** Number of daily buckets in the report-volume timeline. */
const TIMELINE_DAYS = 7;

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

	const [byCountry, byReason, latest, byDay] = await db.batch([
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

	return { windowMs: REPORT_WINDOW_MS, total, countries, reasons, recent, timeline };
}

/** Delete reports older than the retention window. Returns the row count removed. */
export async function pruneReports(db: D1Database, now = Date.now()): Promise<number> {
	const res = await db.prepare("DELETE FROM reports WHERE ts < ?").bind(now - RETENTION_MS).run();
	return res.meta.changes ?? 0;
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
