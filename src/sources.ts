/**
 * Per-source-type status resolution.
 *
 * Each function takes a service and returns a normalized {@link ServiceStatus},
 * including a best-effort `details` object surfaced in the UI hover card.
 * All upstream fetches go through {@link fetchUpstream}, which adds a timeout
 * and Cloudflare edge caching so we don't hammer the upstream status pages.
 */

import { XMLParser } from "fast-xml-parser";
import type { Service, ServiceDetails, ServiceSource, ServiceStatus, StatusLevel } from "./services";

const UPSTREAM_TIMEOUT_MS = 8000;
/** Edge-cache upstream responses for this long (seconds). */
const UPSTREAM_CACHE_TTL = 30;
/** RSS incidents older than this are treated as resolved/stale. */
const RSS_FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function result(service: Service, status: StatusLevel, description: string, details?: ServiceDetails): ServiceStatus {
	return { id: service.id, name: service.name, category: service.category, weight: service.weight, status, description, details };
}

/** Fetch with an abort-based timeout and Cloudflare edge caching. */
async function fetchUpstream(url: string, init: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { "user-agent": "isUpMap-StatusMonitor/1.0 (+https://github.com)", ...(init.headers ?? {}) },
			// `cf` is honored by the Workers runtime (ignored locally / in other runtimes).
			cf: { cacheTtl: UPSTREAM_CACHE_TTL, cacheEverything: true },
		} as RequestInit);
	} finally {
		clearTimeout(timer);
	}
}

interface SummaryComponent {
	name?: string;
	status?: string;
	group?: boolean;
}

interface SummaryIncident {
	name?: string;
	impact?: string;
	shortlink?: string;
	updated_at?: string;
}

interface StatuspageSummary {
	page?: { url?: string; updated_at?: string };
	status?: { indicator?: string; description?: string };
	components?: SummaryComponent[];
	incidents?: SummaryIncident[];
}

/**
 * Atlassian Statuspage. We read `summary.json` (a superset of `status.json`)
 * so the hover card can show component rollups and active incidents.
 */
async function fetchStatuspage(service: Service, base: string): Promise<ServiceStatus> {
	const res = await fetchUpstream(`${base.replace(/\/$/, "")}/api/v2/summary.json`);
	if (!res.ok) return result(service, "unknown", `Status API returned HTTP ${res.status}`);

	const data = (await res.json()) as StatuspageSummary;
	const indicator = data.status?.indicator ?? "none";
	const description = data.status?.description ?? "";

	let status: StatusLevel;
	switch (indicator) {
		case "none":
			status = "up";
			break;
		case "minor":
		case "maintenance":
			status = "degraded";
			break;
		case "major":
		case "critical":
			status = "down";
			break;
		default:
			status = "unknown";
	}

	// Component rollup (skip group containers, which roll up their children).
	const components = (data.components ?? []).filter((c) => c.group !== true);
	const total = components.length;
	const impacted = components.filter((c) => c.status && c.status !== "operational").map((c) => c.name ?? "Unknown");
	const operational = total - impacted.length;

	const incident = data.incidents?.[0];
	const details: ServiceDetails = {
		url: data.page?.url,
		updatedAt: data.page?.updated_at,
		components: total > 0 ? { operational, total, impacted } : undefined,
		incident: incident
			? { name: incident.name ?? "Active incident", impact: incident.impact, url: incident.shortlink, updatedAt: incident.updated_at }
			: undefined,
	};

	return result(service, status, description || (status === "up" ? "All Systems Operational" : indicator), details);
}


interface FeedEntry {
	title: string;
	/** Raw entry body (RSS `description` / Atom `summary`|`content`); may contain HTML. */
	description: string;
	date: number | null;
	link: string | null;
}

/** Coerce a fast-xml-parser node (string, or `{ "#text": ... }` for CDATA/attrs) to a string. */
function nodeText(raw: unknown): string {
	if (raw == null) return "";
	if (typeof raw === "object") return String((raw as Record<string, unknown>)["#text"] ?? "");
	return String(raw);
}

/** Extract the most recent entry from a parsed RSS or Atom document. */
function latestEntry(doc: unknown): FeedEntry | null {
	const root = doc as Record<string, any>;
	// RSS 2.0: rss > channel > item[]   |   Atom: feed > entry[]
	const rssItems = root?.rss?.channel?.item;
	const atomEntries = root?.feed?.entry;
	const items = rssItems ?? atomEntries;
	if (!items) return null;

	const list = Array.isArray(items) ? items : [items];
	if (list.length === 0) return null;

	let best: FeedEntry | null = null;
	for (const item of list) {
		const rawDate = item.pubDate ?? item.updated ?? item.published ?? null;
		const parsed = rawDate ? Date.parse(rawDate) : NaN;
		const date = Number.isNaN(parsed) ? null : parsed;
		const title = nodeText(item.title);
		// RSS uses `description`; Atom uses `summary` or `content`.
		const description = nodeText(item.description ?? item.summary ?? item.content);
		// RSS link is a string; Atom link is an element with an href attribute.
		const linkRaw = item.link;
		const link = typeof linkRaw === "object" ? (linkRaw?.["@_href"] ?? null) : (linkRaw ?? null);
		const entry: FeedEntry = { title: title.trim(), description, date, link: link ? String(link) : null };
		if (!best || (entry.date ?? 0) > (best.date ?? 0)) best = entry;
	}
	return best;
}

const RESOLVED_RE = /\b(resolved|restored|recovered|completed|operating normally|operational)\b/i;
const DOWN_RE = /\b(outage|down|unavailable|major|critical|service disruption|degradation|degraded)\b/i;
/** Words that signal an ongoing-but-not-clearly-severe event (lower-severity than DOWN_RE). */
const ACTIVE_RE = /\b(investigating|identified|elevated|degraded|degradation|disruption|incident|partial)\b/i;

/**
 * Classify a feed entry to a status level.
 *
 * The authoritative signal on modern status feeds (Statuspage / Instatus /
 * status.io) is the `Status:` line in the entry **body**, not the title — an
 * incident keeps one fixed title from "Investigating" through "Resolved" while
 * the body advances through the lifecycle. So we read the body's state first
 * and only fall back to title/body keyword heuristics when there's no such line.
 */
function classifyEntry(title: string, description: string): StatusLevel {
	const text = `${title} ${description}`;

	// 1. Authoritative lifecycle state, e.g. "<b>Status: Monitoring</b>".
	const state = /status:\s*([a-z]+)/i.exec(description)?.[1]?.toLowerCase();
	if (state) {
		if (state === "resolved" || state === "completed" || state === "monitoring") return "up";
		if (state === "scheduled" || state === "maintenance") return "degraded";
		if (state === "investigating" || state === "identified") return DOWN_RE.test(text) ? "down" : "degraded";
		// "update" or an unrecognized state word: fall through to heuristics.
	}

	// 2. Title/body keyword heuristics.
	if (RESOLVED_RE.test(title)) return "up";
	if (DOWN_RE.test(text)) return "down";
	if (ACTIVE_RE.test(text)) return "degraded";

	// 3. Fresh but genuinely ambiguous: don't assert an incident color.
	return "unknown";
}

/**
 * RSS/Atom incident feeds: there's no top-level "current" field, so infer the
 * state from the most recent entry (see {@link classifyEntry}). A stale or
 * missing entry means the service is treated as up.
 */
async function fetchRss(service: Service, url: string): Promise<ServiceStatus> {
	const rssSource = service.source as Extract<ServiceSource, { type: "rss" }>;
	// Use the explicit statusUrl if provided; otherwise derive from the feed URL's origin.
	// entry.link points to a specific incident post — not the right target for "Visit status page".
	const statusPageUrl = rssSource.statusUrl ?? new URL(url).origin;

	const res = await fetchUpstream(url);
	if (!res.ok) return result(service, "unknown", `Feed returned HTTP ${res.status}`);

	const entry = latestEntry(xmlParser.parse(await res.text()));
	if (!entry || !entry.title) return result(service, "up", "No recent incidents reported", { url: statusPageUrl });

	const fresh = entry.date == null || Date.now() - entry.date < RSS_FRESH_WINDOW_MS;
	if (!fresh) {
		return result(service, "up", "No recent incidents reported", {
			url: statusPageUrl,
			note: `Last feed entry ${new Date(entry.date as number).toISOString()}`,
		});
	}

	const updatedAt = entry.date != null ? new Date(entry.date).toISOString() : undefined;
	const details: ServiceDetails = {
		url: statusPageUrl,
		updatedAt,
		incident: { name: entry.title, url: entry.link ?? undefined, updatedAt },
	};

	const status = classifyEntry(entry.title, entry.description);
	// A resolved/recovering incident isn't an active incident worth surfacing.
	if (status === "up") return result(service, "up", entry.title, { ...details, incident: undefined });
	return result(service, status, entry.title, details);
}

/**
 * Codes that mean "the server answered, it just refused this probe" — bot walls
 * and method/auth gates that big consumer sites serve to datacenter egress
 * (where the cron runs). These prove reachability, so they aren't an outage.
 */
const BOT_WALL_CODES = new Set([401, 403, 405, 406, 429]);

/** Plain reachability check for services without a status feed. */
async function fetchHttp(service: Service, url: string): Promise<ServiceStatus> {
	const httpSource = service.source as Extract<ServiceSource, { type: "http" }>;
	const start = Date.now();
	const res = await fetchUpstream(url, { method: "GET", redirect: "follow" });
	const ms = Date.now() - start;
	const baseDetails = { url: httpSource.statusUrl ?? url };
	if (res.ok || (res.status >= 300 && res.status < 400)) {
		return result(service, "up", `Reachable (HTTP ${res.status})`, { ...baseDetails, note: `Responded in ${ms}ms (HTTP ${res.status})` });
	}
	// A bot/auth wall means the host is alive; treat as reachable, not an outage.
	if (BOT_WALL_CODES.has(res.status)) {
		return result(service, "up", `Reachable (HTTP ${res.status})`, { ...baseDetails, note: `Probe blocked (HTTP ${res.status}) — host responded in ${ms}ms` });
	}
	return result(service, "degraded", `Unexpected response (HTTP ${res.status})`, { ...baseDetails, note: `Responded in ${ms}ms (HTTP ${res.status})` });
}

/** Resolve a single service's status, mapping any failure to `unknown`. */
export async function resolveStatus(service: Service): Promise<ServiceStatus> {
	try {
		switch (service.source.type) {
			case "statuspage":
				return await fetchStatuspage(service, service.source.base);
			case "rss":
				return await fetchRss(service, service.source.url);
			case "http":
				return await fetchHttp(service, service.source.url);
		}
	} catch (err) {
		const reason = err instanceof Error && err.name === "AbortError" ? "Timed out" : "Unreachable";
		return result(service, "unknown", reason);
	}
}
