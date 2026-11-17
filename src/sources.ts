/**
 * Per-source-type status resolution.
 *
 * Each function takes a service and returns a normalized {@link ServiceStatus},
 * including a best-effort `details` object surfaced in the UI hover card.
 * All upstream fetches go through {@link fetchUpstream}, which adds a timeout
 * and Cloudflare edge caching so we don't hammer the upstream status pages.
 */

import { XMLParser } from "fast-xml-parser";
import { logFetch } from "./analytics";
import type { Service, ServiceDetails, ServiceSource, ServiceStatus, StatusLevel } from "./services";

/** Carries the Analytics Engine dataset + service context into fetch helpers. */
interface FetchCtx {
	ae: AnalyticsEngineDataset | null | undefined;
	serviceId: string;
	sourceType: string;
}

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
async function fetchWithRetry(url: string, init: RequestInit = {}, ctx?: FetchCtx): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const last = attempt > 0;
		const start = Date.now();
		try {
			const res = await fetchUpstream(url, init);
			const latencyMs = Date.now() - start;
			logFetch(ctx?.ae, { serviceId: ctx?.serviceId ?? "", sourceType: ctx?.sourceType ?? "", url, statusCode: res.status, latencyMs, attempt, ok: res.ok });
			// A 5xx on the first try is worth one retry; on the retry, return as-is.
			if (!last && res.status >= 500) {
				await delay(RETRY_BACKOFF_MS);
				continue;
			}
			return res;
		} catch (err) {
			const latencyMs = Date.now() - start;
			logFetch(ctx?.ae, { serviceId: ctx?.serviceId ?? "", sourceType: ctx?.sourceType ?? "", url, statusCode: 0, latencyMs, attempt, ok: false, error: err instanceof Error ? err.message : String(err) });
			if (last) throw err;
			await delay(RETRY_BACKOFF_MS);
		}
	}
}

interface SummaryComponent {
	id?: string;
	name?: string;
	status?: string;
	group?: boolean;
	group_id?: string | null;
}

interface SummaryIncident {
	name?: string;
	impact?: string;
	shortlink?: string;
	updated_at?: string;
	components?: { id?: string }[];
}

interface StatuspageSummary {
	page?: { id?: string; url?: string; updated_at?: string };
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

/** Severity order of Statuspage indicators, for taking the worst of several. */
const INDICATOR_RANK: Record<string, number> = { none: 0, maintenance: 1, minor: 2, major: 3, critical: 4 };
/** Component status → the indicator Statuspage would derive from it. */
const COMPONENT_INDICATOR: Record<string, string> = {
	operational: "none",
	under_maintenance: "maintenance",
	degraded_performance: "minor",
	partial_outage: "minor",
	major_outage: "major",
};
const worstIndicator = (a: string, b: string): string => ((INDICATOR_RANK[b] ?? 0) > (INDICATOR_RANK[a] ?? 0) ? b : a);

/**
 * An open incident the provider hasn't updated in this long is treated as
 * stale. Live incidents get updates at least weekly (Snowflake's 11-week
 * capacity incident was updated every ~7 days); a regional event left open for
 * months without updates — e.g. Elastic's AWS me-south-1 incident, open since
 * 2026-03 and last touched 2026-09-21 — would otherwise pin the tile forever.
 * Mirrors the AWS source, which ignores long-running events without updates.
 */
const STALE_INCIDENT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * incident.io hosts a Statuspage-compatible API, but its `summary.json` carries
 * only a subset of the components (Supabase: 1 of 189; most pages: 25) while
 * `components.json` has them all. incident.io page ids are 26-char ULIDs;
 * Atlassian's are 12-char, so the id tells the two apart.
 */
const INCIDENT_IO_PAGE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Best-effort full component list for an incident.io page; null keeps the summary's. */
async function fetchAllComponents(base: string, ctx?: FetchCtx): Promise<SummaryComponent[] | null> {
	try {
		const res = await fetchWithRetry(`${base}/api/v2/components.json`, {}, ctx);
		if (!res.ok) return null;
		const list = ((await res.json()) as { components?: SummaryComponent[] }).components;
		return Array.isArray(list) ? list : null;
	} catch {
		return null;
	}
}

/**
 * Atlassian Statuspage. We read `summary.json` (a superset of `status.json`)
 * so the hover card can show component rollups and active incidents.
 *
 * Normally the upstream indicator is trusted. It is instead **recomputed** —
 * worst status of the counted components, plus the impact of every counted
 * incident — when something must be discounted:
 *   - `excludeGroups`: components in those groups are dropped. For pages whose
 *     indicator is dominated by per-location noise — Cloudflare lists ~345
 *     datacenters, dozens always "Re-routed" or in maintenance.
 *   - Stale incidents (no update in {@link STALE_INCIDENT_MS}) are dropped along
 *     with the components they cover, and listed in the note.
 * An incident counts unless every component it names is discounted.
 */
async function fetchStatuspage(service: Service, base: string, ctx?: FetchCtx): Promise<ServiceStatus> {
	const root = base.replace(/\/$/, "");
	const res = await fetchWithRetry(`${root}/api/v2/summary.json`, {}, ctx);
	if (!res.ok) return result(service, "unknown", `Status API returned HTTP ${res.status}`);

	const data = (await res.json()) as StatuspageSummary;
	const src = service.source as Extract<ServiceSource, { type: "statuspage" }>;
	const excludeGroups = new Set(src.excludeGroups ?? []);
	let all = data.components ?? [];
	if (INCIDENT_IO_PAGE_ID_RE.test(data.page?.id ?? "")) {
		const full = await fetchAllComponents(root, ctx);
		if (full && full.length > all.length) all = full;
	}

	// Stale incidents, and the components only they cover (a component also named
	// by a live incident stays counted).
	const now = Date.now();
	const isStale = (i: SummaryIncident) => i.updated_at != null && now - Date.parse(i.updated_at) >= STALE_INCIDENT_MS;
	const allIncidents = data.incidents ?? [];
	const stale = allIncidents.filter(isStale);
	const liveCompIds = new Set(allIncidents.filter((i) => !isStale(i)).flatMap((i) => (i.components ?? []).map((c) => c.id)));
	const staleCompIds = new Set(stale.flatMap((i) => (i.components ?? []).map((c) => c.id)).filter((id) => !liveCompIds.has(id)));

	// Group containers whose name is excluded, and every component inside them.
	const excludedGroupIds = new Set(all.filter((c) => c.group === true && excludeGroups.has(c.name ?? "")).map((c) => c.id));
	const inExcludedGroup = (c: SummaryComponent) => excludedGroupIds.has(c.id) || (c.group_id != null && excludedGroupIds.has(c.group_id));
	// Only a stale incident's *non-operational* components are discounted; a healthy one stays in the rollup.
	const isDiscounted = (c: SummaryComponent) => inExcludedGroup(c) || (staleCompIds.has(c.id) && c.status !== "operational");
	const discountedIds = new Set(all.filter(isDiscounted).map((c) => c.id));

	// Component rollup (skip group containers, which roll up their children).
	const leaves = all.filter((c) => c.group !== true);
	const components = leaves.filter((c) => !isDiscounted(c));
	const total = components.length;
	const impacted = components.filter((c) => c.status && c.status !== "operational").map((c) => c.name ?? "Unknown");
	const operational = total - impacted.length;
	const majorOutages = components.filter((c) => c.status === "major_outage").length;

	let indicator = data.status?.indicator ?? "none";
	let description = data.status?.description ?? "";
	let incidents = allIncidents;
	const notes: string[] = [];

	if (excludedGroupIds.size > 0 || stale.length > 0) {
		incidents = allIncidents.filter((i) => !isStale(i) && (!i.components?.length || i.components.some((c) => !discountedIds.has(c.id))));
		indicator = "none";
		for (const c of components) indicator = worstIndicator(indicator, COMPONENT_INDICATOR[c.status ?? ""] ?? "none");
		for (const i of incidents) indicator = worstIndicator(indicator, i.impact ?? "none");
		// The upstream description reflects the discounted signal too, so derive our own.
		description = indicator === "none" ? "All Systems Operational" : (incidents[0]?.name ?? (impacted.length ? `Impacted: ${impacted.join(", ")}` : ""));
		const ignored = leaves.filter((c) => inExcludedGroup(c) && c.status && c.status !== "operational").length;
		if (ignored > 0) notes.push(`${ignored} component${ignored === 1 ? "" : "s"} in ignored groups not operational (not counted)`);
		for (const i of stale) {
			const days = Math.floor((now - Date.parse(i.updated_at as string)) / 86_400_000);
			notes.push(`Stale incident not counted (no update in ${days} days): ${i.name ?? "Unnamed incident"}`);
		}
	}
	const note = notes.length ? notes.join("; ") : undefined;

	const status = statuspageStatus(indicator, total, majorOutages);

	const incident = incidents[0];
	const details: ServiceDetails = {
		url: data.page?.url,
		updatedAt: data.page?.updated_at,
		components: total > 0 ? { operational, total, impacted } : undefined,
		incident: incident
			? { name: incident.name ?? "Active incident", impact: incident.impact, url: incident.shortlink, updatedAt: incident.updated_at }
			: undefined,
		note,
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
 * Per-update state suffix on the entry **title**, e.g. Appwrite's
 * "Slow storage operations in San Francisco: Resolved". Feeds in this style emit
 * one entry per update with the state appended, and the body is free prose that
 * often still describes the problem ("…we're sorry for the disruption"), so the
 * suffix — not the body — is the authoritative state. Anchored to the end of the
 * title and limited to lifecycle words so a prefix like "Incident: …" or
 * "RESOLVED: …" never matches.
 */
const TITLE_STATE_RE = /:\s*(resolved|completed|operational|monitoring|maintenance|degraded|partial outage|investigating|identified|major outage|outage|down)\s*$/i;
/**
 * Google's feeds (GCP, Firebase) prefix the title with the incident state:
 * "RESOLVED: …" once closed, "UPDATE: …" while open. A resolved entry's body is
 * the incident report ("Incident began at … a power disruption …"), which the
 * body heuristics read as an active outage — so the prefix wins. Only RESOLVED
 * is trusted; "UPDATE:" carries no state and falls through to the body.
 */
const TITLE_RESOLVED_PREFIX_RE = /^\s*resolved\s*:/i;

function titleStateSignal(title: string, text: string): StatusLevel | null {
	if (TITLE_RESOLVED_PREFIX_RE.test(title)) return "up";
	const state = TITLE_STATE_RE.exec(title)?.[1]?.toLowerCase();
	if (!state) return null;
	switch (state) {
		case "resolved":
		case "completed":
		case "operational":
		case "monitoring":
			return "up";
		case "maintenance":
		case "degraded":
		case "partial outage":
			return "degraded";
		case "investigating":
		case "identified":
			return DOWN_RE.test(text) ? "down" : "degraded";
		default: // major outage, outage, down
			return "down";
	}
}

/**
 * Classify a feed entry to a status level.
 *
 * The authoritative signal on modern status feeds (Statuspage / Instatus /
 * status.io) lives in the entry **body**, not the title — an incident keeps one
 * fixed title from "Investigating" through "Resolved" while the body advances
 * through the lifecycle. So we read the body's explicit `Status:` line first,
 * then its leading lifecycle keyword, and only fall back to the title last.
 * The exception is an explicit title state — a "…: Resolved" suffix (Appwrite)
 * or a "RESOLVED: …" prefix (GCP/Firebase) — which is checked first; see
 * {@link titleStateSignal}.
 */
function classifyEntry(title: string, description: string): StatusLevel {
	const text = `${title} ${description}`;

	// 0. Explicit title state: "…: Resolved" suffix (Appwrite) or "RESOLVED: …" prefix (Google).
	const titled = titleStateSignal(title, text);
	if (titled) return titled;

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
async function fetchRss(service: Service, url: string, ctx?: FetchCtx): Promise<ServiceStatus> {
	const rssSource = service.source as Extract<ServiceSource, { type: "rss" }>;
	// Use the explicit statusUrl if provided; otherwise derive from the feed URL's origin.
	// entry.link points to a specific incident post — not the right target for "Visit status page".
	const statusPageUrl = rssSource.statusUrl ?? new URL(url).origin;

	const res = await fetchWithRetry(url, {}, ctx);
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

/** An AWS event whose latest update is older than this is treated as stale. */
const AWS_FRESH_WINDOW_MS = RSS_FRESH_WINDOW_MS;
/** AWS event severities (Health Dashboard): 1 informational, 2 degradation, 3 disruption. */
const AWS_DISRUPTION = 3;
/** Final event-log status AWS writes when an event is resolved. */
const AWS_RESOLVED = 0;

interface AwsEventLog {
	status?: number | string;
	timestamp?: number | string;
	summary?: string;
	message?: string;
}

interface AwsEvent {
	arn?: string;
	date?: number | string;
	region_name?: string;
	service_name?: string;
	summary?: string;
	status?: number | string;
	event_log?: AwsEventLog[];
}

/**
 * Decode a JSON body that may be UTF-16. The AWS current-events endpoint serves
 * UTF-16 big-endian with a BOM, which `res.json()` (UTF-8) can't parse. Detect
 * the encoding from the BOM — or, without one, from the NUL byte position of the
 * leading ASCII `[`/`{` — and fall back to UTF-8.
 */
export function decodeJsonBytes(buf: ArrayBuffer): string {
	const b = new Uint8Array(buf);
	let be: boolean | null = null;
	let start = 0;
	if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) [be, start] = [true, 2];
	else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) [be, start] = [false, 2];
	else if (b.length >= 2 && b[0] === 0 && b[1] !== 0) be = true;
	else if (b.length >= 2 && b[0] !== 0 && b[1] === 0) be = false;
	if (be === null) return new TextDecoder().decode(b);

	// JS strings are UTF-16 code units, so surrogate pairs pass through intact.
	const CHUNK = 8192;
	let out = "";
	const units = new Uint16Array(CHUNK);
	for (let i = start; i + 1 < b.length; ) {
		let n = 0;
		for (; n < CHUNK && i + 1 < b.length; n++, i += 2) units[n] = be ? (b[i] << 8) | b[i + 1] : b[i] | (b[i + 1] << 8);
		out += String.fromCharCode(...units.subarray(0, n));
	}
	return out;
}

/** The newest entry of an AWS event's log (logs aren't guaranteed sorted). */
function awsLatestLog(event: AwsEvent): AwsEventLog | undefined {
	let best: AwsEventLog | undefined;
	for (const log of event.event_log ?? []) if (!best || Number(log.timestamp) > Number(best.timestamp)) best = log;
	return best;
}

/**
 * AWS Health Dashboard current events. The endpoint lists events that AWS hasn't
 * closed yet, each tagged with a region and severity (1 informational, 2 degradation,
 * 3 disruption). An event counts as **active** when its latest log entry isn't the
 * resolution marker (status 0) and was posted within the freshness window. AWS posts
 * hourly-ish updates during a live incident, but some regional events (e.g. the
 * 2026 me-central-1 / me-south-1 facility damage) stay open for months without
 * updates; those are surfaced in the note but don't color the tile, or AWS would be
 * permanently red.
 *
 * Like {@link statuspageStatus}, severity is tempered by breadth: an active event is
 * `degraded`, and only a disruption that is global, hits "Multiple services", or
 * spans 2+ regions is `down`.
 */
async function fetchAwsHealth(service: Service, url: string, ctx?: FetchCtx): Promise<ServiceStatus> {
	const src = service.source as Extract<ServiceSource, { type: "aws-health" }>;
	const statusPageUrl = src.statusUrl ?? new URL(url).origin;

	const res = await fetchWithRetry(url, {}, ctx);
	if (!res.ok) return result(service, "unknown", `Health API returned HTTP ${res.status}`);

	const events: unknown = JSON.parse(decodeJsonBytes(await res.arrayBuffer()));
	if (!Array.isArray(events)) return result(service, "unknown", "Unexpected Health API response");

	const now = Date.now();
	const active: { event: AwsEvent; log: AwsEventLog | undefined; at: number; severity: number }[] = [];
	const stale: AwsEvent[] = [];
	for (const event of events as AwsEvent[]) {
		const log = awsLatestLog(event);
		if (log && Number(log.status) === AWS_RESOLVED) continue;
		const at = Number(log?.timestamp ?? event.date) * 1000;
		if (!Number.isFinite(at) || now - at >= AWS_FRESH_WINDOW_MS) {
			stale.push(event);
			continue;
		}
		active.push({ event, log, at, severity: Number(event.status ?? log?.status) || 1 });
	}

	const staleNote = stale.length
		? `${stale.length} long-running event${stale.length === 1 ? "" : "s"} with no recent updates (${stale.map((e) => e.region_name ?? "unknown region").join(", ")})`
		: undefined;

	if (active.length === 0) {
		return result(service, "up", "No active incidents reported", { url: statusPageUrl, note: staleNote });
	}

	const isGlobal = (e: AwsEvent) => /global/i.test(e.region_name ?? "") || /:health:global:/.test(e.arn ?? "");
	const disruptions = active.filter((a) => a.severity >= AWS_DISRUPTION);
	const disruptedRegions = new Set(disruptions.map((a) => a.event.region_name ?? a.event.arn ?? ""));
	const broad = disruptions.some((a) => isGlobal(a.event) || /multiple services/i.test(a.event.service_name ?? "")) || disruptedRegions.size >= 2;
	const status: StatusLevel = broad ? "down" : "degraded";

	// Surface the most severe, then most recent, active event.
	active.sort((a, b) => b.severity - a.severity || b.at - a.at);
	const top = active[0];
	const name = `${top.event.service_name ?? "AWS"} (${top.event.region_name ?? "unknown region"}): ${top.log?.summary ?? top.event.summary ?? "Active event"}`;
	const updatedAt = new Date(top.at).toISOString();
	const notes = [`${active.length} active event${active.length === 1 ? "" : "s"}`, staleNote].filter(Boolean).join("; ");
	return result(service, status, name, {
		url: statusPageUrl,
		updatedAt,
		incident: { name, updatedAt, url: statusPageUrl },
		note: notes,
	});
}

/**
 * Codes that mean "the server answered, it just refused this probe" — bot walls
 * and method/auth gates that big consumer sites serve to datacenter egress
 * (where the cron runs). These prove reachability, so they aren't an outage.
 */
const BOT_WALL_CODES = new Set([401, 403, 405, 406, 429]);

/** Plain reachability check for services without a status feed. */
async function fetchHttp(service: Service, url: string, ctx?: FetchCtx): Promise<ServiceStatus> {
	const httpSource = service.source as Extract<ServiceSource, { type: "http" }>;
	const start = Date.now();
	const res = await fetchWithRetry(url, { method: "GET", redirect: "follow" }, ctx);
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
export async function resolveStatus(service: Service, ae?: AnalyticsEngineDataset | null): Promise<ServiceStatus> {
	// Disabled services have no usable upstream feed — skip the fetch and surface
	// them as permanently `unknown` with the reason as the description.
	if (service.disabled) {
		return { ...result(service, "unknown", service.disabled), disabled: service.disabled };
	}
	const ctx: FetchCtx = { ae, serviceId: service.id, sourceType: service.source.type };
	try {
		switch (service.source.type) {
			case "statuspage":
				return await fetchStatuspage(service, service.source.base, ctx);
			case "rss":
				return await fetchRss(service, service.source.url, ctx);
			case "http":
				return await fetchHttp(service, service.source.url, ctx);
			case "aws-health":
				return await fetchAwsHealth(service, service.source.url, ctx);
		}
	} catch (err) {
		const reason = err instanceof Error && err.name === "AbortError" ? "Timed out" : "Unreachable";
		return result(service, "unknown", reason);
	}
}
