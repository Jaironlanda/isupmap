/**
 * isUpMap — service status heatmap Worker.
 *
 * Static assets (the frontend in /public) are served automatically by the
 * Cloudflare runtime; this Worker handles the API and the cron.
 *
 *   - `scheduled` (cron, every 5m): resolve every service and persist a
 *     snapshot + incident transitions to D1.
 *   - `GET /api/status`: fast read of the persisted snapshot (with uptime).
 *     Falls back to a live fan-out before the first cron run populates D1.
 *   - `GET /api/incidents`: recent incident log.
 */

import { persistSnapshot, pruneIncidents, readSnapshot, recentIncidents, type ApiService } from "./db";
import { findService, renderNotFound, renderServicePage, renderSitemap, renderStatusIndex } from "./pages";
import { SERVICES, type ServiceStatus, type StatusLevel } from "./services";
import { resolveStatus } from "./sources";

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// Cron refreshes the snapshot every 5 min, so a 2-min TTL stays well
			// within the update cadence while roughly quartering cache misses.
			"cache-control": "public, max-age=120",
			// Defense-in-depth (the _headers file doesn't apply to Worker responses).
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			...(init.headers ?? {}),
		},
	});
}

/**
 * Worker-rendered markup (SSR status pages, sitemap). These responses bypass the
 * static-asset `_headers` file, so set security headers here. The pages ship no
 * scripts (`script-src 'none'`) and only inline CSS (`style-src 'unsafe-inline'`).
 */
function markup(body: string, contentType: string, init: ResponseInit = {}): Response {
	return new Response(body, {
		...init,
		headers: {
			"content-type": contentType,
			"cache-control": "public, max-age=60",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"content-security-policy":
				"default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'",
			...(init.headers ?? {}),
		},
	});
}

/** Resolve every service concurrently; failures become `unknown`. */
async function resolveAll(): Promise<ServiceStatus[]> {
	const settled = await Promise.allSettled(SERVICES.map(resolveStatus));
	return settled.map((outcome, i) => {
		if (outcome.status === "fulfilled") return outcome.value;
		const svc = SERVICES[i];
		return { id: svc.id, name: svc.name, category: svc.category, weight: svc.weight, status: "unknown", description: "Unreachable" };
	});
}

/** KV key holding the latest API-shaped snapshot, written by the cron each run. */
const SNAPSHOT_KEY = "snapshot:v1";

/**
 * A snapshot older than this is flagged `stale` so the UI can warn instead of
 * silently showing frozen data. Three cron cycles (cron runs every 5 min): a
 * single missed run is tolerated, a stalled cron is surfaced.
 */
const STALE_MS = 3 * 5 * 60 * 1000;

interface Snapshot {
	updatedAt: number | null;
	services: ApiService[];
}

/** Whether a snapshot is too old to trust, plus its age. A null `updatedAt` (cold start) is stale. */
export function staleness(updatedAt: number | null, now = Date.now()): { stale: boolean; ageMs: number | null } {
	if (updatedAt == null) return { stale: true, ageMs: null };
	const ageMs = Math.max(0, now - updatedAt);
	return { stale: ageMs > STALE_MS, ageMs };
}

/** A "warming" snapshot used before the first cron run has populated KV — every service unknown, no live fan-out. */
function warmingSnapshot(): Snapshot {
	return {
		updatedAt: null,
		services: SERVICES.map((svc) => ({
			id: svc.id,
			name: svc.name,
			category: svc.category,
			weight: svc.weight,
			status: "unknown",
			description: "Warming up — first check pending",
			uptime: { day: 1, week: 1 },
		})),
	};
}

/** Reasons keyed by service id for services disabled due to an unreliable source. */
const DISABLED_REASONS = new Map(SERVICES.filter((s) => s.disabled).map((s) => [s.id, s.disabled as string]));

/**
 * `disabled` is static config (not persisted), so stamp it onto the snapshot on
 * read and force those services to `unknown` regardless of any stale stored row.
 */
function decorateDisabled(services: ApiService[]): void {
	for (const s of services) {
		const reason = DISABLED_REASONS.get(s.id);
		if (reason) {
			s.disabled = reason;
			s.status = "unknown";
			s.description = reason;
		}
	}
}

/**
 * Load the current snapshot the way the public API exposes it: a fast KV read of
 * the blob the cron writes each run (no D1 query, no recompute on the hot path).
 * Any service added to SERVICES but not yet in the blob is surfaced as `unknown`
 * rather than invisible; before the first cron run we serve a "warming" snapshot
 * (never a live fan-out). `fromCache` lets callers decide what's cacheable.
 */
async function loadSnapshot(env: Env): Promise<{ snapshot: Snapshot; fromCache: boolean }> {
	const cached = (await env.SNAPSHOT_KV.get(SNAPSHOT_KEY, "json")) as Snapshot | null;
	const snapshot = cached ?? warmingSnapshot();

	// Surface any service present in SERVICES but missing from the (possibly older)
	// cached blob — e.g. one added since the last cron run.
	const known = new Set(snapshot.services.map((s) => s.id));
	for (const svc of SERVICES) {
		if (!known.has(svc.id)) {
			snapshot.services.push({ id: svc.id, name: svc.name, category: svc.category, weight: svc.weight, status: "unknown", description: "Pending first check", uptime: { day: 1, week: 1 } });
		}
	}
	// Stamp `disabled` (static config) at read time so it stays current even if the
	// cached blob predates a service being disabled.
	decorateDisabled(snapshot.services);
	return { snapshot, fromCache: cached != null };
}

/**
 * Resolve every service, persist to D1, and publish the finished snapshot to KV.
 * Shared by the cron and the cold-start path. Returns the service count.
 */
async function refreshSnapshot(env: Env): Promise<number> {
	const statuses = await resolveAll();
	await persistSnapshot(env.DB, statuses);
	const snapshot = await readSnapshot(env.DB);
	if (snapshot) await env.SNAPSHOT_KV.put(SNAPSHOT_KEY, JSON.stringify(snapshot));
	return statuses.length;
}

// Per-isolate guard: kick at most one cold-start populate at a time so a burst of
// first requests doesn't fan out repeatedly while KV is still empty.
let coldStartInFlight = false;

/**
 * When KV has no snapshot yet (before the first cron run), populate it once in the
 * background so the page self-heals on the next poll — without blocking this request
 * on an 80-service fan-out.
 */
function kickColdStart(env: Env, ctx: ExecutionContext): void {
	if (coldStartInFlight) return;
	coldStartInFlight = true;
	ctx.waitUntil(
		refreshSnapshot(env)
			.catch((err) => console.error("isUpMap cold-start populate failed:", err))
			.finally(() => {
				coldStartInFlight = false;
			}),
	);
}

export interface StatusSummary {
	/** Worst-case overall status across all services. */
	status: StatusLevel;
	/** Human-readable rollup, e.g. "All systems operational" or "2 down, 1 degraded". */
	message: string;
	/** Total number of tracked services. */
	total: number;
	/** Per-status service counts. */
	counts: Record<StatusLevel, number>;
	/** When the underlying snapshot was last updated (epoch ms), or null. */
	updatedAt: number | null;
}

/** Roll a snapshot up into a single overall status + headline. */
export function summarize(snapshot: Snapshot): StatusSummary {
	const counts: Record<StatusLevel, number> = { up: 0, degraded: 0, down: 0, unknown: 0 };
	for (const s of snapshot.services) counts[s.status]++;

	// Worst status wins; `unknown` only surfaces when there's nothing better.
	let status: StatusLevel;
	if (counts.down > 0) status = "down";
	else if (counts.degraded > 0) status = "degraded";
	else if (counts.up > 0) status = "up";
	else status = "unknown";

	let message: string;
	if (status === "up") {
		message = "All systems operational";
	} else if (status === "unknown") {
		message = "Status unavailable";
	} else {
		const parts: string[] = [];
		if (counts.down > 0) parts.push(`${counts.down} down`);
		if (counts.degraded > 0) parts.push(`${counts.degraded} degraded`);
		message = parts.join(", ");
	}

	return { status, message, total: snapshot.services.length, counts, updatedAt: snapshot.updatedAt };
}

/**
 * Per-IP rate limit for the expensive (cache-miss) API path. Shared NAT IPs may
 * share a bucket; 60/min is generous for the dashboard's ~1 poll / 45s. Returns
 * a 429 Response when the limit is exceeded, or null to proceed.
 */
async function rateLimit(request: Request, env: Env): Promise<Response | null> {
	const ip = request.headers.get("cf-connecting-ip") ?? "anon";
	const { success } = await env.API_RATE_LIMITER.limit({ key: ip });
	if (success) return null;
	return json({ error: "Rate limit exceeded" }, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Serve /analytics.js with the GA4 measurement ID injected from the GA_ID
		// var (see wrangler.jsonc). The committed file ships a G-XXXXXXXXXX
		// placeholder; when GA_ID is unset (e.g. forks) analytics is disabled.
		if (url.pathname === "/analytics.js") {
			const gaId = env.GA_ID?.trim();
			const headers = {
				"content-type": "text/javascript; charset=utf-8",
				"x-content-type-options": "nosniff",
				"cache-control": "public, max-age=3600",
			};
			if (!gaId) {
				return new Response("// Analytics disabled (no GA_ID configured).\n", { headers });
			}
			const asset = await env.ASSETS.fetch(new URL("/analytics.js", url.origin));
			const source = await asset.text();
			// Replace only the quoted placeholder (leave the explanatory comment intact).
			return new Response(source.replace(/"G-XXXXXXXXXX"/, JSON.stringify(gaId)), { headers });
		}

		if (url.pathname === "/api/status") {
			// Cache per-colo so the KV read is done at most once per TTL.
			const cache = caches.default;
			const cacheKey = new Request(new URL("/api/status", url.origin).toString(), { method: "GET" });
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			// Only the miss path (KV read) is rate-limited; cache hits above are
			// served cheaply to everyone, so a flood of repeats collapses onto the
			// cached response instead of 429s.
			const limited = await rateLimit(request, env);
			if (limited) return limited;

			const { snapshot, fromCache } = await loadSnapshot(env);
			const resp = json({ ...snapshot, ...staleness(snapshot.updatedAt) });
			if (fromCache) {
				// Cache real (KV-backed) snapshots only.
				ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			} else {
				// KV empty (before the first cron run): populate it in the background so
				// the next poll shows real data instead of the "warming" placeholder.
				kickColdStart(env, ctx);
			}
			return resp;
		}

		if (url.pathname === "/api/summary") {
			// Overall-status rollup for compact embeds (favicon/title, badges,
			// "All systems operational" banners). Same KV-read + per-colo caching.
			const cache = caches.default;
			const cacheKey = new Request(new URL("/api/summary", url.origin).toString(), { method: "GET" });
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			const limited = await rateLimit(request, env);
			if (limited) return limited;

			const { snapshot, fromCache } = await loadSnapshot(env);
			const resp = json({ ...summarize(snapshot), ...staleness(snapshot.updatedAt) });
			if (fromCache) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			else kickColdStart(env, ctx);
			return resp;
		}

		if (url.pathname === "/api/incidents") {
			const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
			// Cache per-colo keyed by the clamped limit (so arbitrary query strings
			// don't fragment the cache). Incidents change rarely → ~1 read/min/colo.
			const cache = caches.default;
			const cacheKey = new Request(new URL(`/api/incidents?limit=${limit}`, url.origin).toString(), { method: "GET" });
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			const limited = await rateLimit(request, env);
			if (limited) return limited;

			const resp = json({ incidents: await recentIncidents(env.DB, limit) });
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		// Crawlable sitemap, generated from SERVICES so it never drifts.
		if (url.pathname === "/sitemap.xml") {
			return markup(renderSitemap(), "application/xml; charset=utf-8", { headers: { "cache-control": "public, max-age=3600" } });
		}

		// Server-rendered status directory (good for crawl discovery + internal links).
		if (url.pathname === "/status" || url.pathname === "/status/") {
			return markup(renderStatusIndex(), "text/html; charset=utf-8", { headers: { "cache-control": "public, max-age=3600" } });
		}

		// Per-service SSR page: /status/<id>. Indexable content for "is X down?".
		const serviceMatch = url.pathname.match(/^\/status\/([a-z0-9-]+)\/?$/);
		if (serviceMatch) {
			const service = findService(serviceMatch[1]);
			if (!service) return markup(renderNotFound(), "text/html; charset=utf-8", { status: 404 });

			const cache = caches.default;
			const cacheKey = new Request(new URL(`/status/${service.id}`, url.origin).toString(), { method: "GET" });
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			const limited = await rateLimit(request, env);
			if (limited) return limited;

			const { snapshot } = await loadSnapshot(env);
			const current = snapshot.services.find((s) => s.id === service.id) ?? null;
			const resp = markup(renderServicePage(service, current, snapshot.updatedAt), "text/html; charset=utf-8");
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			// Resolve every service, persist to D1, and publish the snapshot to KV.
			const count = await refreshSnapshot(env);

			// Retention sweep once a day (~03:00 UTC): with a 5-minute cron, only the
			// :00 firing of hour 3 falls in this window, so it runs exactly once.
			const when = new Date(controller.scheduledTime);
			if (when.getUTCHours() === 3 && when.getUTCMinutes() < 5) {
				const pruned = await pruneIncidents(env.DB);
				console.log(`isUpMap cron: persisted ${count} services; pruned ${pruned} old incidents`);
			} else {
				console.log(`isUpMap cron: persisted ${count} services`);
			}
		} catch (err) {
			console.error("isUpMap cron failed:", err instanceof Error ? err.stack || err.message : String(err));
			throw err;
		}
	},
} satisfies ExportedHandler<Env>;
