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

const UPSTREAM_TIMEOUT_MS = 15000;
/** Edge-cache upstream responses for this long (seconds). */
const UPSTREAM_CACHE_TTL = 30;
/** RSS incidents older than this are treated as resolved/stale. */
const RSS_FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Pause before the single transient-failure retry (see {@link fetchWithRetry}). */
const RETRY_BACKOFF_MS = 300;

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	// fast-xml-parser caps entity expansions (default 1000) as DoS protection.
	// These are first-party status feeds, not untrusted input, and long incident
	// histories (e.g. Cursor, AWS) routinely concatenate >1000 HTML entities into
	// one document — which would otherwise throw and surface as "Unreachable".
	processEntities: { enabled: true, maxTotalExpansions: 1_000_000, maxExpandedLength: 10_000_000 },
});

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
			headers: { "user-agent": "IsUpMapBot/1.0 (+https://isupmap.com/bot)", ...(init.headers ?? {}) },
			// `cf` is honored by the Workers runtime (ignored locally / in other runtimes).
			cf: { cacheTtl: UPSTREAM_CACHE_TTL, cacheEverything: true },
		} as RequestInit);
	} finally {
		clearTimeout(timer);
	}
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * {@link fetchUpstream} with one retry on a *transient* failure — a thrown
 * network/timeout error or a `5xx` response. Status pages occasionally blip
 * (a brief 502, a dropped connection); without a retry that single blip would
 * collapse to `unknown` and hide the real status. One extra attempt after a
 * short backoff turns most blips into an accurate reading; a persistent failure
 * still surfaces (the 5xx is returned, or the error rethrown) so callers map it
 * to `unknown`/`down` as before.
 */
async function fetchWithRetry(url: string, init: RequestInit = {}): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const last = attempt > 0;
		try {
			const res = await fetchUpstream(url, init);
			// A 5xx on the first try is worth one retry; on the retry, return as-is.
			if (!last && res.status >= 500) {
				await delay(RETRY_BACKOFF_MS);
				continue;
			}
			return res;
		} catch (err) {
			if (last) throw err;
			await delay(RETRY_BACKOFF_MS);
		}
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
 * A Statuspage indicator reflects *peak* component severity, not *breadth*: a
 * single region in `major_outage` among hundreds of operational components still
 * sets `indicator: "major"`. Mapping that straight to `down` paints a service
 * fully red when ~98% of it is fine (observed on Elastic/Grafana during a
 * single-region cloud outage). So for a major/critical indicator we consult the
 * component rollup and only call it `down` when the major outage is *broad*;
 * a localized one is tempered to `degraded`.
 */
const STATUSPAGE_MIN_COMPONENTS = 4;
const STATUSPAGE_BROAD_MAJOR_FRACTION = 0.5;

function statuspageStatus(indicator: string, total: number, majorOutages: number): StatusLevel {
	switch (indicator) {
		case "none":
			return "up";
		case "minor":
		case "maintenance":
			return "degraded";
		case "major":
		case "critical":
			// Too few components to judge breadth (or none reported): trust the indicator.
			if (total < STATUSPAGE_MIN_COMPONENTS) return "down";
			// Broad major outage → down; a small, localized blast radius → degraded.
			return majorOutages / total >= STATUSPAGE_BROAD_MAJOR_FRACTION ? "down" : "degraded";
		default:
			return "unknown";
	}
}

/**
 * Atlassian Statuspage. We read `summary.json` (a superset of `status.json`)
 * so the hover card can show component rollups and active incidents.
 */
async function fetchStatuspage(service: Service, base: string): Promise<ServiceStatus> {
	const res = await fetchWithRetry(`${base.replace(/\/$/, "")}/api/v2/summary.json`);
	if (!res.ok) return result(service, "unknown", `Status API returned HTTP ${res.status}`);

	const data = (await res.json()) as StatuspageSummary;
	const indicator = data.status?.indicator ?? "none";
	const description = data.status?.description ?? "";

	// Component rollup (skip group containers, which roll up their children).
	const components = (data.components ?? []).filter((c) => c.group !== true);
	const total = components.length;
	const impacted = components.filter((c) => c.status && c.status !== "operational").map((c) => c.name ?? "Unknown");
	const operational = total - impacted.length;
	const majorOutages = components.filter((c) => c.status === "major_outage").length;

	const status = statuspageStatus(indicator, total, majorOutages);

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
	/** Raw entry body (RSS `description`|`content:encoded` / Atom `summary`|`content`); may contain HTML. */
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
		// RSS uses `description` (or namespaced `content:encoded`, kept verbatim by the
		// parser — e.g. PayPal); Atom uses `summary` or `content`.
		const description = nodeText(item.description ?? item["content:encoded"] ?? item.summary ?? item.content);
		// RSS link is a string; Atom link is an element with an href attribute.
		const linkRaw = item.link;
		const link = typeof linkRaw === "object" ? (linkRaw?.["@_href"] ?? null) : (linkRaw ?? null);
		const entry: FeedEntry = { title: title.trim(), description, date, link: link ? String(link) : null };
		if (!best || (entry.date ?? 0) > (best.date ?? 0)) best = entry;
	}
	return best;
}

const RESOLVED_RE = /\b(resolved|restored|recovered|completed|operating normally|operational|back to normal)\b/i;
const DOWN_RE = /\b(outage|down|unavailable|major|critical|service disruption|degradation|degraded)\b/i;
/** Words that signal an ongoing-but-not-clearly-severe event (lower-severity than DOWN_RE). */
const ACTIVE_RE = /\b(investigating|identified|elevated|degraded|degradation|disruption|incident|partial)\b/i;
/** Scheduled-maintenance markers (Statuspage/status.io). */
const MAINT_RE = /\b(scheduled|maintenance)\b/i;
/** Recovering/recovered markers for the body scan — includes "monitoring" (mitigation applied). */
const UP_RE = /\b(resolved|restored|recovered|completed|monitoring|operating normally|operational|back to normal)\b/i;

/**
 * Formal incident-update stage markers, as emitted by Statuspage / status.io /
 * Instatus: each update reads `Timestamp <Stage> - text` (e.g. "Investigating -",
 * "Monitoring -", "Resolved -"). The capture is the stage word; the trailing
 * dash distinguishes a real stage label from the same word used in prose
 * ("we are monitoring the situation"). The stage is usually wrapped in markup
 * (`<b>Resolved</b> - …`), so we strip tags before matching.
 */
const STAGE_RE = /\b(investigating|identified|monitoring|resolved|completed|scheduled)\b\s*[-–—]/gi;

/**
 * Infer state from the formal stage markers in the body. Providers disagree on
 * ordering — Slack lists updates newest-first, status.io (e.g. Roblox) lists them
 * oldest-first — so position is unreliable. But an incident only advances
 * (Investigating → Identified → Monitoring → Resolved), so the *furthest* stage
 * present is the current one regardless of order: a body that reached "Resolved -"
 * is up even if it opens with "Investigating -". Returns null when the body has
 * no formal stage markers (prose bodies fall through to {@link leadingSignal}).
 */
function stageSignal(description: string, text: string): StatusLevel | null {
	const plain = description.replace(/<[^>]+>/g, " ");
	const stages = new Set<string>();
	for (const m of plain.matchAll(STAGE_RE)) stages.add(m[1].toLowerCase());
	if (stages.size === 0) return null;
	// Recovering or done (incidents don't regress) → up.
	if (stages.has("resolved") || stages.has("completed") || stages.has("monitoring")) return "up";
	// Still active: severity from any down-keyword in the entry.
	if (stages.has("investigating") || stages.has("identified")) return DOWN_RE.test(text) ? "down" : "degraded";
	if (stages.has("scheduled")) return "degraded";
	return null;
}

/**
 * Infer the current state from the entry **body**. These feeds concatenate
 * updates newest-first, so the *earliest* lifecycle keyword in the body is the
 * latest update and reflects the current state — e.g. a body that leads with
 * "resolved" wins even when the (fixed) title still reads "Incident: ...".
 * Returns null when the body carries no lifecycle keyword at all.
 */
function leadingSignal(description: string): StatusLevel | null {
	if (!description) return null;
	const at = (re: RegExp): number => {
		const m = re.exec(description);
		return m ? m.index : Infinity;
	};
	const up = at(UP_RE);
	const maint = at(MAINT_RE);
	const incident = Math.min(at(DOWN_RE), at(ACTIVE_RE));
	const min = Math.min(up, maint, incident);
	if (min === Infinity) return null;
	if (min === up) return "up";
	if (min === maint) return "degraded";
	// An active incident leads: severity from any down-keyword in the body.
	return DOWN_RE.test(description) ? "down" : "degraded";
}

/**
 * Classify a feed entry to a status level.
 *
 * The authoritative signal on modern status feeds (Statuspage / Instatus /
 * status.io) lives in the entry **body**, not the title — an incident keeps one
 * fixed title from "Investigating" through "Resolved" while the body advances
 * through the lifecycle. So we read the body's explicit `Status:` line first,
 * then its leading lifecycle keyword, and only fall back to the title last.
 */
function classifyEntry(title: string, description: string): StatusLevel {
	const text = `${title} ${description}`;

	// 1. Explicit lifecycle line, e.g. "<b>Status: Monitoring</b>" / "Status: RESOLVED".
	const state = /status:\s*([a-z]+)/i.exec(description)?.[1]?.toLowerCase();
	if (state) {
		if (state === "resolved" || state === "completed" || state === "monitoring") return "up";
		if (state === "scheduled" || state === "maintenance") return "degraded";
		if (state === "investigating" || state === "identified") return DOWN_RE.test(text) ? "down" : "degraded";
		// "update" or an unrecognized state word: fall through.
	}

	// 2. Formal stage markers ("Investigating -" … "Resolved -"): the furthest
	//    stage reached wins, so a resolved status.io incident reads as up even when
	//    its body lists updates oldest-first (e.g. Roblox).
	const stage = stageSignal(description, text);
	if (stage) return stage;

	// 3. Prose body with no stage markers: newest-first leading keyword (Slack-style).
	const lead = leadingSignal(description);
	if (lead) return lead;

	// 4. Title-only fallback (feeds whose body carries no lifecycle keyword).
	if (RESOLVED_RE.test(title)) return "up";
	if (DOWN_RE.test(title)) return "down";
	if (ACTIVE_RE.test(title)) return "degraded";

	// 5. Fresh but genuinely ambiguous: don't assert an incident color.
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

	const res = await fetchWithRetry(url);
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
	const res = await fetchWithRetry(url, { method: "GET", redirect: "follow" });
	const ms = Date.now() - start;
	const baseDetails = { url: httpSource.statusUrl ?? url };
	if (res.ok || (res.status >= 300 && res.status < 400)) {
		return result(service, "up", `Reachable (HTTP ${res.status})`, { ...baseDetails, note: `Responded in ${ms}ms (HTTP ${res.status})` });
	}
	// A bot/auth wall means the host is alive; treat as reachable, not an outage.
	if (BOT_WALL_CODES.has(res.status)) {
		return result(service, "up", `Reachable (HTTP ${res.status})`, { ...baseDetails, note: `Probe blocked (HTTP ${res.status}) — host responded in ${ms}ms` });
	}
	// A server error (5xx) on the host itself means it's effectively down for users.
	if (res.status >= 500) {
		return result(service, "down", `Server error (HTTP ${res.status})`, { ...baseDetails, note: `Responded in ${ms}ms (HTTP ${res.status})` });
	}
	return result(service, "degraded", `Unexpected response (HTTP ${res.status})`, { ...baseDetails, note: `Responded in ${ms}ms (HTTP ${res.status})` });
}

/** Resolve a single service's status, mapping any failure to `unknown`. */
export async function resolveStatus(service: Service): Promise<ServiceStatus> {
	// Disabled services have no usable upstream feed — skip the fetch and surface
	// them as permanently `unknown` with the reason as the description.
	if (service.disabled) {
		return { ...result(service, "unknown", service.disabled), disabled: service.disabled };
	}
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
