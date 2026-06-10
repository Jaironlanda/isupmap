/**
 * Analytics Engine helpers for logging upstream fetch events.
 *
 * Schema (queryable via the AE SQL API / `wrangler analytics-engine sql`):
 *   index1   — service ID  (efficient per-service filtering)
 *   blob1    — URL fetched
 *   blob2    — source type: "statuspage" | "rss" | "http"
 *   blob3    — error message (empty string when the request succeeded)
 *   double1  — HTTP status code (0 for network / timeout errors)
 *   double2  — latency in milliseconds
 *   double3  — attempt index (0 = first try, 1 = retry)
 *   double4  — 1 if the response was ok (2xx), 0 otherwise
 */

export interface FetchEvent {
	serviceId: string;
	sourceType: string;
	url: string;
	statusCode: number;
	latencyMs: number;
	attempt: number;
	ok: boolean;
	error?: string;
}

export function logFetch(ae: AnalyticsEngineDataset | null | undefined, event: FetchEvent): void {
	if (!ae) return;
	ae.writeDataPoint({
		indexes: [event.serviceId],
		blobs: [event.url, event.sourceType, event.error ?? ""],
		doubles: [event.statusCode, event.latencyMs, event.attempt, event.ok ? 1 : 0],
	});
}
