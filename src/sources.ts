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
	date: number | null;
	link: string | null;
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
		const titleRaw = item.title;
		const title = typeof titleRaw === "object" ? (titleRaw["#text"] ?? "") : (titleRaw ?? "");
		// RSS link is a string; Atom link is an element with an href attribute.
		const linkRaw = item.link;
		const link = typeof linkRaw === "object" ? (linkRaw?.["@_href"] ?? null) : (linkRaw ?? null);
		const entry: FeedEntry = { title: String(title).trim(), date, link: link ? String(link) : null };
		if (!best || (entry.date ?? 0) > (best.date ?? 0)) best = entry;
	}
	return best;
}

const RESOLVED_RE = /\b(resolved|restored|recovered|completed|operating normally|operational)\b/i;
const DOWN_RE = /\b(outage|down|unavailable|major|critical|service disruption|degradation|degraded)\b/i;

/**
 * RSS/Atom incident feeds: there's no authoritative "current" field, so infer.
 * A recent entry that reads like an unresolved problem => down/degraded,
 * otherwise the service is treated as up.
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

	const details: ServiceDetails = {
		url: statusPageUrl,
		updatedAt: entry.date != null ? new Date(entry.date).toISOString() : undefined,
		incident: { name: entry.title, url: entry.link ?? undefined, updatedAt: entry.date != null ? new Date(entry.date).toISOString() : undefined },
	};

	if (RESOLVED_RE.test(entry.title)) return result(service, "up", entry.title, { ...details, incident: undefined });
	if (DOWN_RE.test(entry.title)) return result(service, "down", entry.title, details);
	// A fresh, ambiguous entry suggests an ongoing event worth surfacing.
	return result(service, "degraded", entry.title, details);
}

/** Plain reachability check for services without a status feed. */
async function fetchHttp(service: Service, url: string): Promise<ServiceStatus> {
	const httpSource = service.source as Extract<ServiceSource, { type: "http" }>;
	const start = Date.now();
	const res = await fetchUpstream(url, { method: "GET", redirect: "follow" });
	const ms = Date.now() - start;
	const details: ServiceDetails = { url: httpSource.statusUrl ?? url, note: `Responded in ${ms}ms (HTTP ${res.status})` };
	if (res.ok || (res.status >= 300 && res.status < 400)) {
		return result(service, "up", `Reachable (HTTP ${res.status})`, details);
	}
	return result(service, "degraded", `Unexpected response (HTTP ${res.status})`, details);
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
