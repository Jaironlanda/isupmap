/**
 * isUpMap — service status heatmap Worker.
 *
 * Static assets (the frontend in /public) are served automatically by the
 * Cloudflare runtime; this Worker handles the API and the cron.
 *
 *   - `scheduled` (cron, every 1m): resolve every service and persist a
 *     snapshot + incident transitions to D1.
 *   - `GET /api/status`: fast read of the persisted snapshot (with uptime).
 *     Falls back to a live fan-out before the first cron run populates D1.
 *   - `GET /api/incidents`: recent incident log.
 */

import { persistSnapshot, pruneIncidents, readSnapshot, recentIncidents, type ApiService } from "./db";
import { SERVICES, type ServiceStatus } from "./services";
import { resolveStatus } from "./sources";

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=30",
			// Defense-in-depth (the _headers file doesn't apply to Worker responses).
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
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

/** Cold-start fallback: live snapshot shaped like the persisted one (no history yet). */
function liveSnapshot(statuses: ServiceStatus[]): { updatedAt: number; services: ApiService[] } {
	return {
		updatedAt: Date.now(),
		services: statuses.map((s) => ({ ...s, description: s.description ?? "", uptime: { day: 1, week: 1 } })),
	};
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

		if (url.pathname.startsWith("/api/")) {
			// Per-IP rate limit. Shared NAT IPs may share a bucket; 60/min is
			// generous enough for the dashboard's ~1 poll / 45s that this is fine.
			const ip = request.headers.get("cf-connecting-ip") ?? "anon";
			const { success } = await env.API_RATE_LIMITER.limit({ key: ip });
			if (!success) {
				return json({ error: "Rate limit exceeded" }, { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
			}
		}

		if (url.pathname === "/api/status") {
			// Cache per-colo so the (potentially expensive) snapshot — especially
			// the cold-start live fan-out — is computed at most once per TTL.
			const cache = caches.default;
			const cacheKey = new Request(new URL("/api/status", url.origin).toString(), { method: "GET" });
			const hit = await cache.match(cacheKey);
			if (hit) return hit;

			const fromDb = await readSnapshot(env.DB);
			// Merge: any service added to SERVICES but not yet persisted by the cron
			// appears immediately as "unknown" rather than being invisible.
			if (fromDb) {
				const dbIds = new Set(fromDb.services.map((s) => s.id));
				for (const svc of SERVICES) {
					if (!dbIds.has(svc.id)) {
						fromDb.services.push({ id: svc.id, name: svc.name, category: svc.category, weight: svc.weight, status: "unknown", description: "Pending first check", uptime: { day: 1, week: 1 } });
					}
				}
			}
			const snapshot = fromDb ?? liveSnapshot(await resolveAll());
			const resp = json(snapshot);
			// Cache D1-backed responses, but skip a degenerate cold-start fallback
			// (everything `unknown`, e.g. a cold fan-out that timed out) so the next
			// request retries instead of serving the bad snapshot for the full TTL.
			const cacheable = fromDb !== null || snapshot.services.some((s) => s.status !== "unknown");
			if (cacheable) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
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

			const resp = json({ incidents: await recentIncidents(env.DB, limit) });
			ctx.waitUntil(cache.put(cacheKey, resp.clone()));
			return resp;
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		try {
			const statuses = await resolveAll();
			await persistSnapshot(env.DB, statuses);

			// Retention sweep once a day (~03:00 UTC): with a 5-minute cron, only the
			// :00 firing of hour 3 falls in this window, so it runs exactly once.
			const when = new Date(controller.scheduledTime);
			if (when.getUTCHours() === 3 && when.getUTCMinutes() < 5) {
				const pruned = await pruneIncidents(env.DB);
				console.log(`isUpMap cron: persisted ${statuses.length} services; pruned ${pruned} old incidents`);
			} else {
				console.log(`isUpMap cron: persisted ${statuses.length} services`);
			}
		} catch (err) {
			console.error("isUpMap cron failed:", err instanceof Error ? err.stack || err.message : String(err));
			throw err;
		}
	},
} satisfies ExportedHandler<Env>;
