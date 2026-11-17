import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJsonBytes, resolveStatus } from "../src/sources";
import type { Service, ServiceSource } from "../src/services";

// resolveStatus only touches the network via the global `fetch`; stub it so
// nothing leaves the test and we control every upstream response.
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchSpy = vi.fn();
	vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function svc(source: ServiceSource): Service {
	return { id: "svc", name: "Svc", category: "Test", weight: 1, source };
}
function reply(body: string, status = 200): Response {
	return new Response(body, { status });
}

describe("statuspage", () => {
	const base = "https://example.statuspage.io";

	function summaryBody(indicator: string, components: unknown[] = []) {
		return JSON.stringify({
			page: { url: base, updated_at: "2026-06-02T00:00:00Z" },
			status: { indicator, description: `desc-${indicator}` },
			components,
			incidents: [],
		});
	}
	const resolve = () => resolveStatus(svc({ type: "statuspage", base }));

	it("maps indicator 'none' to up", async () => {
		fetchSpy.mockResolvedValue(reply(summaryBody("none")));
		expect((await resolve()).status).toBe("up");
		// Reads summary.json off the configured base.
		expect(fetchSpy.mock.calls[0][0]).toBe(`${base}/api/v2/summary.json`);
	});

	it("maps 'minor' and 'maintenance' to degraded", async () => {
		fetchSpy.mockResolvedValueOnce(reply(summaryBody("minor")));
		expect((await resolve()).status).toBe("degraded");
		fetchSpy.mockResolvedValueOnce(reply(summaryBody("maintenance")));
		expect((await resolve()).status).toBe("degraded");
	});

	it("maps 'major' and 'critical' to down", async () => {
		fetchSpy.mockResolvedValueOnce(reply(summaryBody("major")));
		expect((await resolve()).status).toBe("down");
		fetchSpy.mockResolvedValueOnce(reply(summaryBody("critical")));
		expect((await resolve()).status).toBe("down");
	});

	// Build N components, the first `major` of them in major_outage, the rest operational.
	function components(total: number, major: number) {
		return Array.from({ length: total }, (_, i) => ({ name: `c${i}`, status: i < major ? "major_outage" : "operational" }));
	}

	it("tempers a region-localized major outage to degraded", async () => {
		// indicator=major but only 1 of 20 components down (a single region) → not a full outage.
		fetchSpy.mockResolvedValue(reply(summaryBody("major", components(20, 1))));
		expect((await resolve()).status).toBe("degraded");
	});

	it("keeps a broad major outage as down", async () => {
		// A majority of components in major_outage → genuinely down.
		fetchSpy.mockResolvedValue(reply(summaryBody("major", components(10, 6))));
		expect((await resolve()).status).toBe("down");
	});

	it("trusts a major indicator when components are too few to judge breadth", async () => {
		fetchSpy.mockResolvedValue(reply(summaryBody("major", components(2, 1))));
		expect((await resolve()).status).toBe("down");
	});

	it("maps an unrecognized indicator to unknown", async () => {
		fetchSpy.mockResolvedValue(reply(summaryBody("wat")));
		expect((await resolve()).status).toBe("unknown");
	});

	it("returns unknown on a non-OK HTTP response", async () => {
		fetchSpy.mockResolvedValue(reply("nope", 503));
		const r = await resolve();
		expect(r.status).toBe("unknown");
		expect(r.description).toContain("503");
	});

	it("rolls up components, skipping group containers", async () => {
		const components = [
			{ name: "Group", status: "operational", group: true },
			{ name: "API", status: "operational" },
			{ name: "Webhooks", status: "degraded_performance" },
		];
		fetchSpy.mockResolvedValue(reply(summaryBody("minor", components)));
		const r = await resolve();
		expect(r.details?.components).toEqual({ operational: 1, total: 2, impacted: ["Webhooks"] });
	});
});

describe("statuspage excludeGroups (Cloudflare-style per-location noise)", () => {
	const base = "https://www.cloudflarestatus.com";
	const resolve = () => resolveStatus(svc({ type: "statuspage", base, excludeGroups: ["Asia", "Europe"] }));

	// Two regional groups of PoPs plus a products group, mirroring cloudflarestatus.com.
	function cfSummary(o: { indicator: string; pops?: Record<string, string>; products?: Record<string, string>; incidents?: unknown[] }) {
		const groups = [
			{ id: "g-asia", name: "Asia", group: true, status: "operational" },
			{ id: "g-eu", name: "Europe", group: true, status: "operational" },
			{ id: "g-svc", name: "Cloudflare Sites and Services", group: true, status: "operational" },
		];
		const pops = Object.entries(o.pops ?? { "Hong Kong - (HKG)": "operational", "London - (LHR)": "operational" }).map(([name, status], i) => ({
			id: `pop-${i}`,
			name,
			status,
			group_id: i % 2 ? "g-eu" : "g-asia",
		}));
		const products = Object.entries(o.products ?? { CDN: "operational", DNS: "operational", Workers: "operational", R2: "operational" }).map(([name, status]) => ({
			id: `svc-${name}`,
			name,
			status,
			group_id: "g-svc",
		}));
		return JSON.stringify({
			page: { url: base, updated_at: "2026-11-17T00:00:00Z" },
			status: { indicator: o.indicator, description: "Partially Degraded Service" },
			components: [...groups, ...pops, ...products],
			incidents: o.incidents ?? [],
		});
	}

	it("reads up when only excluded PoPs are re-routed / in maintenance (indicator ignored)", async () => {
		fetchSpy.mockResolvedValue(reply(cfSummary({ indicator: "minor", pops: { "Hong Kong - (HKG)": "under_maintenance", "London - (LHR)": "partial_outage", "Dhaka - (DAC)": "partial_outage" } })));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.description).toBe("All Systems Operational");
		// Rollup counts products only; the ignored noise is surfaced in the note.
		expect(r.details?.components).toEqual({ operational: 4, total: 4, impacted: [] });
		expect(r.details?.note).toBe("3 components in ignored groups not operational (not counted)");
	});

	it("still reads degraded for a product incident (e.g. the Workers event-subscription incident)", async () => {
		fetchSpy.mockResolvedValue(
			reply(
				cfSummary({
					indicator: "minor",
					pops: { "Hong Kong - (HKG)": "partial_outage", "London - (LHR)": "operational" },
					products: { CDN: "operational", DNS: "operational", Workers: "degraded_performance", Queues: "degraded_performance" },
					incidents: [{ name: "Changes to Cloudflare Workers are not producing Event Subscription events", impact: "minor", components: [{ id: "svc-Workers" }, { id: "svc-Queues" }] }],
				}),
			),
		);
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Changes to Cloudflare Workers are not producing Event Subscription events");
		expect(r.details?.incident?.name).toBe(r.description);
	});

	it("ignores an incident that only touches excluded PoPs", async () => {
		fetchSpy.mockResolvedValue(reply(cfSummary({ indicator: "major", pops: { "Hong Kong - (HKG)": "major_outage", "London - (LHR)": "operational" }, incidents: [{ name: "HKG connectivity", impact: "major", components: [{ id: "pop-0" }] }] })));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.incident).toBeUndefined();
	});

	it("counts an incident that names no components", async () => {
		fetchSpy.mockResolvedValue(reply(cfSummary({ indicator: "minor", incidents: [{ name: "Elevated API errors", impact: "minor", components: [] }] })));
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Elevated API errors");
	});

	it("reads down for a broad product major outage", async () => {
		fetchSpy.mockResolvedValue(reply(cfSummary({ indicator: "critical", products: { CDN: "major_outage", DNS: "major_outage", Workers: "major_outage", R2: "operational" } })));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.description).toBe("Impacted: CDN, DNS, Workers");
	});

	it("leaves the upstream indicator in charge when excludeGroups is unset", async () => {
		fetchSpy.mockResolvedValue(reply(cfSummary({ indicator: "minor", pops: { "Hong Kong - (HKG)": "partial_outage", "London - (LHR)": "operational" } })));
		const r = await resolveStatus(svc({ type: "statuspage", base }));
		expect(r.status).toBe("degraded");
		expect(r.details?.note).toBeUndefined();
	});
});

describe("statuspage stale incidents", () => {
	const base = "https://status.elastic.co";
	const resolve = () => resolveStatus(svc({ type: "statuspage", base }));
	const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

	// 20 operational components + 7 me-south-1 components in major_outage, mirroring Elastic.
	function elasticSummary(incidents: unknown[], regionStatus = "major_outage") {
		const ok = Array.from({ length: 20 }, (_, i) => ({ id: `ok-${i}`, name: `Elasticsearch connectivity: AWS region-${i}`, status: "operational" }));
		const region = Array.from({ length: 7 }, (_, i) => ({ id: `mes-${i}`, name: `Component ${i}: AWS me-south-1`, status: regionStatus }));
		return JSON.stringify({
			page: { id: "abcdef123456", url: base, updated_at: daysAgo(0) },
			status: { indicator: "major", description: "Partial System Outage" },
			components: [...ok, ...region],
			incidents,
		});
	}
	const bahrain = (updatedDaysAgo: number) => ({
		name: "Connectivity disruption for AWS Bahrain (me-south-1)",
		impact: "major",
		updated_at: daysAgo(updatedDaysAgo),
		components: Array.from({ length: 7 }, (_, i) => ({ id: `mes-${i}` })),
	});

	it("drops an incident not updated in 14+ days, and the components it covers", async () => {
		fetchSpy.mockResolvedValue(reply(elasticSummary([bahrain(57)])));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.description).toBe("All Systems Operational");
		expect(r.details?.incident).toBeUndefined();
		expect(r.details?.components).toEqual({ operational: 20, total: 20, impacted: [] });
		expect(r.details?.note).toBe("Stale incident not counted (no update in 57 days): Connectivity disruption for AWS Bahrain (me-south-1)");
	});

	it("keeps a stale incident's operational components in the rollup (MongoDB-style)", async () => {
		fetchSpy.mockResolvedValue(reply(elasticSummary([bahrain(74)], "operational")));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.components).toEqual({ operational: 27, total: 27, impacted: [] });
		expect(r.details?.note).toContain("no update in 74 days");
	});

	it("keeps an incident updated within 14 days (weekly cadence, like Snowflake's)", async () => {
		fetchSpy.mockResolvedValue(reply(elasticSummary([bahrain(7)])));
		const r = await resolve();
		// Upstream indicator is trusted as before: a localized major outage → degraded.
		expect(r.status).toBe("degraded");
		expect(r.details?.incident?.name).toBe("Connectivity disruption for AWS Bahrain (me-south-1)");
		expect(r.details?.note).toBeUndefined();
	});

	it("still counts a live incident alongside a stale one", async () => {
		const live = { name: "Kibana login errors", impact: "minor", updated_at: daysAgo(0), components: [{ id: "ok-0" }] };
		const body = JSON.parse(elasticSummary([bahrain(57), live]));
		body.components[0].status = "degraded_performance";
		fetchSpy.mockResolvedValue(reply(JSON.stringify(body)));
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Kibana login errors");
		expect(r.details?.note).toContain("Stale incident not counted");
	});

	it("keeps a component a live incident also covers, even if a stale one names it", async () => {
		const live = { name: "me-south-1 relapse", impact: "major", updated_at: daysAgo(0), components: [{ id: "mes-0" }] };
		fetchSpy.mockResolvedValue(reply(elasticSummary([bahrain(57), live])));
		const r = await resolve();
		expect(r.details?.components?.total).toBe(21);
		expect(r.details?.components?.impacted).toEqual(["Component 0: AWS me-south-1"]);
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("me-south-1 relapse");
	});
});

describe("statuspage on incident.io (truncated summary components)", () => {
	const base = "https://status.supabase.com";
	const ULID = "01KJZVWMNKKQM1MY9H5QWY34VG";
	const regions = (n: number, bad: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `region-${i}`, status: bad[i] ?? "operational" }));
	const summary = (pageId: string, indicator = "none", components = regions(1)) =>
		JSON.stringify({ page: { id: pageId, url: `${base}/`, updated_at: "2026-11-17T06:33:11Z" }, status: { indicator, description: "desc" }, components, incidents: [] });

	it("reads the full list from components.json when the page id is an incident.io ULID", async () => {
		fetchSpy.mockResolvedValueOnce(reply(summary(ULID))).mockResolvedValueOnce(reply(JSON.stringify({ components: regions(189) })));
		const r = await resolveStatus(svc({ type: "statuspage", base }));
		expect(fetchSpy.mock.calls[1][0]).toBe(`${base}/api/v2/components.json`);
		expect(r.status).toBe("up");
		expect(r.details?.components).toEqual({ operational: 189, total: 189, impacted: [] });
	});

	it("uses the full list for breadth: a 1-region major outage is degraded, not down", async () => {
		// With only the summary's 1 component, total < 4 would trust the indicator → down.
		fetchSpy.mockResolvedValueOnce(reply(summary(ULID, "major"))).mockResolvedValueOnce(reply(JSON.stringify({ components: regions(189, { 5: "major_outage" }) })));
		const r = await resolveStatus(svc({ type: "statuspage", base }));
		expect(r.status).toBe("degraded");
		expect(r.details?.components?.impacted).toEqual(["region-5"]);
	});

	it("falls back to the summary's components if components.json fails", async () => {
		fetchSpy.mockResolvedValueOnce(reply(summary(ULID))).mockResolvedValueOnce(reply("nope", 404));
		const r = await resolveStatus(svc({ type: "statuspage", base }));
		expect(r.status).toBe("up");
		expect(r.details?.components?.total).toBe(1);
	});

	it("does not fetch components.json for an Atlassian page (12-char id)", async () => {
		fetchSpy.mockResolvedValue(reply(summary("kctbh9vrtdwd", "none", regions(12))));
		const r = await resolveStatus(svc({ type: "statuspage", base: "https://www.githubstatus.com" }));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(r.details?.components?.total).toBe(12);
	});
});

describe("cerebras (statuspage)", () => {
	const base = "https://status.cerebras.ai";
	const cerebras: Service = { id: "cerebras", name: "Cerebras", category: "AI", weight: 4, source: { type: "statuspage", base } };
	const resolve = () => resolveStatus(cerebras);

	function summaryBody(indicator: string, incidents: unknown[] = []) {
		return JSON.stringify({
			page: { url: `${base}/`, updated_at: "2026-06-10T00:00:00Z" },
			status: { indicator, description: indicator === "none" ? "All Systems Operational" : "Service Disruption" },
			components: [],
			incidents,
		});
	}

	it("returns up when indicator is none (healthy)", async () => {
		fetchSpy.mockResolvedValue(reply(summaryBody("none")));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(fetchSpy.mock.calls[0][0]).toBe(`${base}/api/v2/summary.json`);
	});

	it("returns down on a major indicator with a fresh active incident", async () => {
		const incidents = [
			{
				name: "API Inference Outage",
				impact: "critical",
				shortlink: "https://status.cerebras.ai/incidents/abc123",
				// Must be recent: incidents not updated in 14+ days are treated as stale.
				updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
			},
		];
		fetchSpy.mockResolvedValue(reply(summaryBody("major", incidents)));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.details?.incident?.name).toBe("API Inference Outage");
		expect(r.details?.incident?.url).toBe("https://status.cerebras.ai/incidents/abc123");
	});
});

describe("rss", () => {
	const url = "https://status.example.com/feed.rss";
	const resolve = () => resolveStatus(svc({ type: "rss", url }));

	function rss(title: string, pubDate: string, description = "") {
		// Real Statuspage/Instatus feeds CDATA-wrap the HTML body, so it survives as text.
		const desc = description ? `<description><![CDATA[${description}]]></description>` : "";
		return `<?xml version="1.0"?><rss><channel><item><title>${title}</title>${desc}<pubDate>${pubDate}</pubDate><link>https://x/1</link></item></channel></rss>`;
	}
	const now = () => new Date().toUTCString();
	const old = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toUTCString();

	it("is up when the latest entry reads as resolved", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Incident resolved", now())));
		expect((await resolve()).status).toBe("up");
	});

	it("is down on a fresh outage-keyword entry", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Major outage in us-east", now())));
		expect((await resolve()).status).toBe("down");
	});

	it("is degraded for a fresh active-incident entry", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Investigating elevated latency", now())));
		expect((await resolve()).status).toBe("degraded");
	});

	it("is unknown for a fresh but genuinely ambiguous entry", async () => {
		// No status word, no incident keyword: don't flip the tile to a hard color.
		fetchSpy.mockResolvedValue(reply(rss("Weekly status report", now())));
		expect((await resolve()).status).toBe("unknown");
	});

	it("trusts the body's 'Status: Monitoring' over a scary title", async () => {
		// Incidents keep a fixed title from Investigating → Resolved; the live
		// state lives in the body. A recovering incident must read as up.
		const body = "<b>Status: Monitoring</b><br/>We applied a mitigation and are monitoring.";
		fetchSpy.mockResolvedValue(reply(rss("Elevated error rates on the API", now(), body)));
		const r = await resolve();
		expect(r.status).toBe("up");
		// A recovering/resolved entry isn't surfaced as an active incident.
		expect(r.details?.incident).toBeUndefined();
	});

	it("treats a body 'Status: Resolved' as up despite an incident title", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Major outage in us-east", now(), "<b>Status: Resolved</b>")));
		expect((await resolve()).status).toBe("up");
	});

	it("treats a body 'Status: Investigating' as an active incident", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Some service event", now(), "<b>Status: Investigating</b>")));
		expect((await resolve()).status).toBe("degraded");
	});

	it("trusts a body that leads 'resolved' under an 'Incident:' title (Slack-style)", async () => {
		// No Status: line; the fixed title contains "Incident", but the body's
		// newest update says resolved — that must win.
		const body = "This issue is now resolved for all users. We've resolved the issue some users saw.";
		fetchSpy.mockResolvedValue(reply(rss("Incident: Trouble connecting or loading Slack", now(), body)));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.incident).toBeUndefined();
	});

	it("reads a resolved status.io incident as up despite an oldest-first body (Roblox)", async () => {
		// status.io lists updates oldest-first: Investigating → Monitoring → Resolved.
		// The furthest stage (Resolved) is the current state, even though the body opens
		// with "Investigating -".
		// Mirrors the real feed: each stage is wrapped in markup (<b>Stage</b> - …).
		const body =
			"<small>June 2, 2026 16:40 PDT</small><br /><b>Investigating</b> - We are investigating an issue with the Roblox player failing to launch.<br /><br />" +
			"<small>June 2, 2026 16:54 PDT</small><br /><b>Monitoring</b> - We have reverted the change and are seeing recovery.<br /><br />" +
			"<small>June 2, 2026 17:29 PDT</small><br /><b>Resolved</b> - This incident is resolved.";
		fetchSpy.mockResolvedValue(reply(rss("Issue opening Roblox on certain platforms", now(), body)));
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.incident).toBeUndefined();
	});

	it("reads an incident that reached 'Monitoring -' as up regardless of a leading 'Investigating -'", async () => {
		const body = "Investigating - elevated errors observed. Monitoring - mitigation applied, watching recovery.";
		fetchSpy.mockResolvedValue(reply(rss("Some service event", now(), body)));
		expect((await resolve()).status).toBe("up");
	});

	it("keeps a still-active 'Investigating -' incident as down when the body names an outage", async () => {
		const body = "May 6 17:43 PDT Investigating - We are aware of a major outage affecting connectivity.";
		fetchSpy.mockResolvedValue(reply(rss("Players may be unable to connect", now(), body)));
		expect((await resolve()).status).toBe("down");
	});

	it("treats a body leading 'Investigating' as degraded (status.io-style)", async () => {
		const body = "June 1, 2026 11:24 UTC Investigating - Customers may experience failures creating branches.";
		fetchSpy.mockResolvedValue(reply(rss("Issue with project operations", now(), body)));
		expect((await resolve()).status).toBe("degraded");
	});

	it("treats a body leading 'Scheduled' as degraded (maintenance)", async () => {
		const body = "May 21 01:20 PDT Scheduled - We will be performing routine database maintenance.";
		fetchSpy.mockResolvedValue(reply(rss("Scheduled Database Maintenance", now(), body)));
		expect((await resolve()).status).toBe("degraded");
	});

	it("is down when the body leads with an ongoing service disruption (AWS-style)", async () => {
		const body = "We are providing an update on the ongoing service disruption affecting one region.";
		fetchSpy.mockResolvedValue(reply(rss("Service disruption: Increased Error Rates", now(), body)));
		expect((await resolve()).status).toBe("down");
	});

	it("reads the body from a namespaced content:encoded element (PayPal-style)", async () => {
		// PayPal's feed carries the incident body in <content:encoded>, not <description>.
		// The parser keeps the namespace prefix, so without that fallback the body is lost
		// and a real incident collapses to the title-only path (here: a false 'unknown').
		const body = "May 6 17:43 PDT Investigating - We are aware of a major outage affecting payments.";
		const item = `<item><title>Service event (PP-LIVE-1)</title><content:encoded><![CDATA[${body}]]></content:encoded><pubDate>${now()}</pubDate><link>https://x/1</link></item>`;
		const feed = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${item}</channel></rss>`;
		fetchSpy.mockResolvedValue(reply(feed));
		expect((await resolve()).status).toBe("down");
	});

	it("is up when the latest entry is stale (outside the fresh window)", async () => {
		fetchSpy.mockResolvedValue(reply(rss("Major outage", old())));
		expect((await resolve()).status).toBe("up");
	});

	it("is up when the feed has no items", async () => {
		fetchSpy.mockResolvedValue(reply(`<?xml version="1.0"?><rss><channel></channel></rss>`));
		expect((await resolve()).status).toBe("up");
	});
});

describe("cloud providers (GCP & Azure RSS feeds)", () => {
	const now = () => new Date().toUTCString();
	const nowIso = () => new Date().toISOString();

	// Google Cloud publishes an Atom feed (feed > entry[]).
	function gcpAtom(title: string, summary: string, updated = nowIso()) {
		return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Google Cloud Service Health Updates</title><entry><title>${title}</title><link href="https://status.cloud.google.com/incidents/abc" rel="alternate"/><id>tag:abc</id><updated>${updated}</updated><summary type="html"><![CDATA[${summary}]]></summary></entry></feed>`;
	}
	const resolveGcp = () => resolveStatus(svc({ type: "rss", url: "https://status.cloud.google.com/en/feed.atom", statusUrl: "https://status.cloud.google.com/" }));

	it("GCP: a resolved incident reads as up", async () => {
		fetchSpy.mockResolvedValue(reply(gcpAtom("RESOLVED: Vertex AI elevated errors", "<p><b>Resolved</b> - The issue with Vertex AI has been mitigated and the service is operating normally.</p>")));
		const r = await resolveGcp();
		expect(r.status).toBe("up");
		expect(r.details?.url).toBe("https://status.cloud.google.com/");
	});

	it("GCP: a fresh active outage reads as down", async () => {
		fetchSpy.mockResolvedValue(reply(gcpAtom("Compute Engine experiencing a major outage", "<p>We are investigating a major outage affecting Compute Engine.</p>")));
		expect((await resolveGcp()).status).toBe("down");
	});

	// Regression: a "RESOLVED:" entry whose body is the incident report used to read
	// as down for the full 48h freshness window (12 false GCP incidents in prod).
	const incidentReport =
		"<p>Incident began at <strong>2026-10-19 23:00</strong> and ended at <strong>2026-10-20 05:08</strong>.</p><p><strong>Incident Report Summary</strong> A data center facility that hosts europe-west2-b experienced an external electrical power disruption. This resulted in service unavailability and a major outage for workloads in this zone.</p>";

	it("GCP: a 'RESOLVED:' title wins over an incident-report body", async () => {
		fetchSpy.mockResolvedValue(reply(gcpAtom("RESOLVED: Multiple services were experiencing issues in the europe-west2 region.", incidentReport)));
		const r = await resolveGcp();
		expect(r.status).toBe("up");
		expect(r.details?.incident).toBeUndefined();
	});

	it("Firebase: a 'RESOLVED:' title reads as up (same Google feed format)", async () => {
		fetchSpy.mockResolvedValue(reply(gcpAtom("RESOLVED: We are tracking a networking issue that may affect a significant part of the fleet", incidentReport)));
		const r = await resolveStatus(svc({ type: "rss", url: "https://status.firebase.google.com/en/feed.atom", statusUrl: "https://status.firebase.google.com" }));
		expect(r.status).toBe("up");
	});

	it("GCP: an 'UPDATE:' title carries no state, so the active body still reads as down", async () => {
		fetchSpy.mockResolvedValue(reply(gcpAtom("UPDATE: Multiple services are experiencing issues in the europe-west2 region.", "<p>We are investigating a major outage affecting multiple services.</p>")));
		expect((await resolveGcp()).status).toBe("down");
	});

	// Azure publishes an RSS 2.0 feed (rss > channel > item[]); it is often empty (no active incidents).
	const resolveAzure = () => resolveStatus(svc({ type: "rss", url: "https://azure.status.microsoft/en-us/status/feed/", statusUrl: "https://azure.status.microsoft/en-us/status" }));

	it("Azure: an empty feed reads as up", async () => {
		fetchSpy.mockResolvedValue(reply(`<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Azure Status</title></channel></rss>`));
		const r = await resolveAzure();
		expect(r.status).toBe("up");
		expect(r.details?.url).toBe("https://azure.status.microsoft/en-us/status");
	});

	it("Azure: a fresh outage item reads as down", async () => {
		const item = `<item><title>Service issue - Virtual Machines</title><description><![CDATA[Investigating - We are aware of a major outage affecting Virtual Machines.]]></description><pubDate>${now()}</pubDate><link>https://azure.status.microsoft/incident/1</link></item>`;
		fetchSpy.mockResolvedValue(reply(`<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Azure Status</title>${item}</channel></rss>`));
		expect((await resolveAzure()).status).toBe("down");
	});
});

describe("AWS Health current events (aws-health)", () => {
	const url = "https://health.aws.amazon.com/public/currentevents";
	const statusUrl = "https://health.aws.amazon.com/health/status";
	const resolve = () => resolveStatus(svc({ type: "aws-health", url, statusUrl }));
	const secsAgo = (hours: number) => String(Math.floor((Date.now() - hours * 3_600_000) / 1000));

	/** The real endpoint serves UTF-16 big-endian with a BOM. */
	function utf16be(text: string): Uint8Array {
		const out = new Uint8Array(2 + text.length * 2);
		out[0] = 0xfe;
		out[1] = 0xff;
		for (let i = 0; i < text.length; i++) {
			const u = text.charCodeAt(i);
			out[2 + i * 2] = u >> 8;
			out[3 + i * 2] = u & 0xff;
		}
		return out;
	}
	function event(o: { region: string; service?: string; sev: number; hoursAgo: number; logStatus?: number; summary?: string }) {
		const ts = secsAgo(o.hoursAgo);
		return {
			date: secsAgo(o.hoursAgo + 1),
			arn: `arn:aws:health:${o.region}::event/X`,
			region_name: o.region,
			status: String(o.sev),
			service_name: o.service ?? "Amazon EC2",
			summary: "Region event",
			event_log: [
				{ summary: "Investigating", message: "We are investigating.", status: 1, timestamp: Number(secsAgo(o.hoursAgo + 1)) },
				{ summary: o.summary ?? "Increased Error Rates", message: "Update.", status: o.logStatus ?? o.sev, timestamp: Number(ts) },
			],
		};
	}
	const respond = (events: unknown[]) => fetchSpy.mockResolvedValue(new Response(utf16be(JSON.stringify(events)), { status: 200 }));

	it("decodes the UTF-16 body and reads an empty event list as up", async () => {
		respond([]);
		const r = await resolve();
		expect(fetchSpy.mock.calls[0][0]).toBe(url);
		expect(r.status).toBe("up");
		expect(r.details?.url).toBe(statusUrl);
	});

	it("ignores long-running events with no recent updates, but notes them", async () => {
		// Mirrors the live state: two me-* disruptions open since March, last updated months ago.
		respond([event({ region: "UAE", service: "Multiple services", sev: 3, hoursAgo: 24 * 60 }), event({ region: "Bahrain", service: "Multiple services", sev: 3, hoursAgo: 24 * 60 })]);
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.note).toContain("2 long-running events");
		expect(r.details?.note).toContain("UAE, Bahrain");
		expect(r.details?.incident).toBeUndefined();
	});

	it("skips an event whose latest log entry is the resolution marker", async () => {
		respond([event({ region: "N. Virginia", sev: 1, hoursAgo: 1, logStatus: 0, summary: "[RESOLVED] Increased Error Rates" })]);
		expect((await resolve()).status).toBe("up");
	});

	it("reads a fresh single-region informational event as degraded", async () => {
		respond([event({ region: "N. Virginia", service: "AWS IAM Identity Center", sev: 1, hoursAgo: 1, summary: "Increased Connectivity issues" })]);
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("AWS IAM Identity Center (N. Virginia): Increased Connectivity issues");
		expect(r.details?.incident?.name).toBe(r.description);
	});

	it("tempers a single-region, single-service disruption to degraded", async () => {
		respond([event({ region: "Oregon", service: "Amazon EC2", sev: 3, hoursAgo: 1 })]);
		expect((await resolve()).status).toBe("degraded");
	});

	it("reads a fresh 'Multiple services' disruption as down", async () => {
		respond([event({ region: "N. Virginia", service: "Multiple services", sev: 3, hoursAgo: 1 })]);
		expect((await resolve()).status).toBe("down");
	});

	it("reads disruptions spanning two regions as down", async () => {
		respond([event({ region: "Oregon", sev: 3, hoursAgo: 1 }), event({ region: "Tokyo", sev: 3, hoursAgo: 2 })]);
		expect((await resolve()).status).toBe("down");
	});

	it("surfaces the most severe active event and counts the rest", async () => {
		respond([
			event({ region: "Tokyo", service: "Amazon S3", sev: 1, hoursAgo: 0.5 }),
			event({ region: "Oregon", service: "Amazon EC2", sev: 2, hoursAgo: 3, summary: "Elevated Launch Failures" }),
			event({ region: "UAE", service: "Multiple services", sev: 3, hoursAgo: 24 * 60 }),
		]);
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Amazon EC2 (Oregon): Elevated Launch Failures");
		expect(r.details?.note).toBe("2 active events; 1 long-running event with no recent updates (UAE)");
	});

	it("returns unknown on a non-OK response", async () => {
		fetchSpy.mockResolvedValue(new Response("nope", { status: 404 }));
		const r = await resolve();
		expect(r.status).toBe("unknown");
		expect(r.description).toContain("HTTP 404");
	});
});

describe("decodeJsonBytes", () => {
	const enc = (s: string, be: boolean, bom = true) => {
		const out: number[] = bom ? (be ? [0xfe, 0xff] : [0xff, 0xfe]) : [];
		for (let i = 0; i < s.length; i++) {
			const u = s.charCodeAt(i);
			out.push(...(be ? [u >> 8, u & 0xff] : [u & 0xff, u >> 8]));
		}
		return new Uint8Array(out).buffer;
	};
	const sample = '[{"region":"São Paulo","note":"🚀"}]'; // non-ASCII + a surrogate pair

	it("decodes UTF-8", () => expect(decodeJsonBytes(new TextEncoder().encode(sample).buffer as ArrayBuffer)).toBe(sample));
	it("decodes UTF-16 BE with a BOM", () => expect(decodeJsonBytes(enc(sample, true))).toBe(sample));
	it("decodes UTF-16 LE with a BOM", () => expect(decodeJsonBytes(enc(sample, false))).toBe(sample));
	it("detects BOM-less UTF-16 from the NUL byte position", () => {
		expect(decodeJsonBytes(enc(sample, true, false))).toBe(sample);
		expect(decodeJsonBytes(enc(sample, false, false))).toBe(sample);
	});
	it("decodes a body larger than one decode chunk", () => {
		const big = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ i, msg: "Increased Error Rates" })));
		expect(decodeJsonBytes(enc(big, true))).toBe(big);
	});
});

describe("http", () => {
	const url = "https://example.com/health";
	const resolve = () => resolveStatus(svc({ type: "http", url }));

	it("is up on 2xx", async () => {
		fetchSpy.mockResolvedValue(reply("ok", 200));
		expect((await resolve()).status).toBe("up");
	});

	it("is up on a 3xx redirect status", async () => {
		fetchSpy.mockResolvedValue(reply("", 301));
		expect((await resolve()).status).toBe("up");
	});

	it("is down on a persistent 5xx (server error)", async () => {
		fetchSpy.mockResolvedValue(reply("boom", 500));
		expect((await resolve()).status).toBe("down");
	});

	it("is up on a 403/429 bot wall (host responded, just refused the probe)", async () => {
		fetchSpy.mockResolvedValueOnce(reply("forbidden", 403));
		expect((await resolve()).status).toBe("up");
		fetchSpy.mockResolvedValueOnce(reply("rate limited", 429));
		expect((await resolve()).status).toBe("up");
	});

	it("is degraded on a 404", async () => {
		fetchSpy.mockResolvedValue(reply("missing", 404));
		expect((await resolve()).status).toBe("degraded");
	});
});

describe("transient retry", () => {
	const url = "https://example.com/health";
	const resolveHttp = () => resolveStatus(svc({ type: "http", url }));

	it("retries once after a 5xx and uses the recovered response", async () => {
		fetchSpy.mockResolvedValueOnce(reply("boom", 503)).mockResolvedValueOnce(reply("ok", 200));
		expect((await resolveHttp()).status).toBe("up");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("retries once after a thrown network error and recovers", async () => {
		fetchSpy.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce(reply("ok", 200));
		expect((await resolveHttp()).status).toBe("up");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("gives up after one retry (does not loop)", async () => {
		fetchSpy.mockRejectedValue(new Error("down"));
		expect((await resolveHttp()).status).toBe("unknown");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

describe("error handling", () => {
	it("maps a network error to unknown", async () => {
		fetchSpy.mockRejectedValue(new Error("boom"));
		const r = await resolveStatus(svc({ type: "http", url: "https://example.com/health" }));
		expect(r.status).toBe("unknown");
		expect(r.description).toBe("Unreachable");
	});

	it("maps an aborted (timed-out) request to unknown/Timed out", async () => {
		fetchSpy.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
		const r = await resolveStatus(svc({ type: "http", url: "https://example.com/health" }));
		expect(r.status).toBe("unknown");
		expect(r.description).toBe("Timed out");
	});
});

describe("Fireworks AI RSS feed", () => {
	const feedUrl = "https://status.fireworks.ai/feed.rss";
	const statusUrl = "https://status.fireworks.ai";
	const resolve = () => resolveStatus(svc({ type: "rss", url: feedUrl, statusUrl }));
	const now = () => new Date().toUTCString();

	function fireworksRss(title: string, pubDate: string) {
		return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Incidents | Fireworks AI</title><link>${statusUrl}/</link><item><title>${title}</title><link>${statusUrl}/</link><pubDate>${pubDate}</pubDate><description>${title}</description></item></channel></rss>`;
	}

	it("is up when the latest entry indicates recovery", async () => {
		fetchSpy.mockResolvedValue(reply(fireworksRss("API service recovered", now())));
		const r = await resolve();
		expect(r.status).toBe("up");
		// statusUrl must be surfaced so "Visit status page" links to the human page.
		expect(r.details?.url).toBe(statusUrl);
	});

	it("is down when the latest entry says the service went down", async () => {
		fetchSpy.mockResolvedValue(reply(fireworksRss("API service went down", now())));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.details?.url).toBe(statusUrl);
		// An active incident must be surfaced in the details.
		expect(r.details?.incident?.name).toBe("API service went down");
	});
});

describe("Firecrawl RSS feed (Betterstack)", () => {
	const feedUrl = "https://status.firecrawl.dev/feed.rss";
	const statusUrl = "https://status.firecrawl.dev";
	const resolve = () => resolveStatus(svc({ type: "rss", url: feedUrl, statusUrl }));
	const now = () => new Date().toUTCString();

	function firecrawlRss(title: string, pubDate: string, description = "") {
		const desc = description ? `<description><![CDATA[${description}]]></description>` : `<description>${title}</description>`;
		return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Incidents | Firecrawl</title><link>${statusUrl}/</link><item><title>${title}</title><link>${statusUrl}/incident/1</link><pubDate>${pubDate}</pubDate>${desc}</item></channel></rss>`;
	}

	it("is up when the latest entry body signals resolution", async () => {
		// Betterstack feeds keep a fixed incident title while the body advances
		// through the lifecycle; the resolution state lives in the description.
		fetchSpy.mockResolvedValue(reply(firecrawlRss("API is degraded", now(), "All services are back to normal and fully operational.")));
		const r = await resolve();
		expect(r.status).toBe("up");
		// statusUrl must be surfaced so "Visit status page" links to the human page.
		expect(r.details?.url).toBe(statusUrl);
	});

	it("is down when the latest entry signals an active outage", async () => {
		fetchSpy.mockResolvedValue(reply(firecrawlRss("API is degraded", now(), "Investigating - We are seeing a major outage affecting API requests.")));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.details?.url).toBe(statusUrl);
		// An active incident must be surfaced in the details.
		expect(r.details?.incident?.name).toBe("API is degraded");
	});
});

describe("Appwrite Atom feed (title state suffix)", () => {
	const feedUrl = "https://appwrite.online/feed.atom";
	const statusUrl = "https://appwrite.online";
	const resolve = () => resolveStatus(svc({ type: "rss", url: feedUrl, statusUrl }));
	const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

	// Mirrors appwrite.online/feed.atom: one entry per update, state appended to the
	// title, and within an incident the updates are listed oldest-first.
	function appwriteAtom(entries: { title: string; updated: string; content: string }[]) {
		const body = entries
			.map((e, i) => `<entry><title>${e.title}</title><id>${statusUrl}/#inc-${i}</id><updated>${e.updated}</updated><link href="${statusUrl}/#inc"></link><content>${e.content}</content></entry>`)
			.join("");
		return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Appwrite status</title><id>${statusUrl}/</id><updated>${ago(0)}</updated>${body}</feed>`;
	}

	it("reads a ': Resolved' title as up even when the prose body mentions the disruption", async () => {
		fetchSpy.mockResolvedValue(
			reply(
				appwriteAtom([
					{ title: "Slow storage operations in San Francisco: Degraded", updated: ago(300), content: "We're investigating intermittent slowness in Storage; some uploads time out." },
					{ title: "Slow storage operations in San Francisco: Resolved", updated: ago(10), content: "Storage has been working normally since 20:00 UTC. We're sorry for the disruption." },
				]),
			),
		);
		const r = await resolve();
		expect(r.status).toBe("up");
		expect(r.details?.url).toBe(statusUrl);
		expect(r.details?.incident).toBeUndefined();
	});

	it("reads a ': Degraded' title as degraded while the incident is open", async () => {
		fetchSpy.mockResolvedValue(
			reply(appwriteAtom([{ title: "Static Appwrite Sites return 500 errors: Degraded", updated: ago(5), content: "Requests to static sites are failing with HTTP 500 errors in all regions." }])),
		);
		const r = await resolve();
		expect(r.status).toBe("degraded");
		expect(r.details?.incident?.name).toBe("Static Appwrite Sites return 500 errors: Degraded");
	});

	it("reads a ': Maintenance' title as degraded", async () => {
		fetchSpy.mockResolvedValue(reply(appwriteAtom([{ title: "Analytics/Usage: Maintenance", updated: ago(5), content: "We're improving the underlying systems." }])));
		expect((await resolve()).status).toBe("degraded");
	});

	it("does not treat a title prefix like 'Incident:' as a state suffix", async () => {
		// Only a trailing lifecycle word counts; this falls through to the body (resolved).
		fetchSpy.mockResolvedValue(reply(appwriteAtom([{ title: "Incident: Degraded API latency", updated: ago(5), content: "Resolved - latency is back to normal." }])));
		expect((await resolve()).status).toBe("up");
	});
});

describe("Docker (incident.io Statuspage-compatible JSON)", () => {
	it("reads summary.json off dockerstatus.com", async () => {
		fetchSpy.mockResolvedValue(
			reply(
				JSON.stringify({
					page: { id: "01K74XC4TMWXW51JZXNY729350", name: "Docker", url: "https://www.dockerstatus.com/", updated_at: "2026-09-24T16:38:11Z" },
					status: { description: "All Systems Operational", indicator: "none" },
					components: [{ name: "Docker Hub Registry", status: "operational" }],
					incidents: [],
				}),
			),
		);
		const r = await resolveStatus(svc({ type: "statuspage", base: "https://www.dockerstatus.com" }));
		expect(fetchSpy.mock.calls[0][0]).toBe("https://www.dockerstatus.com/api/v2/summary.json");
		expect(r.status).toBe("up");
	});
});

describe("statuspage extraBases (Atlassian hub + product pages)", () => {
	const hub = "https://status.atlassian.com";
	const jira = "https://jira-software.status.atlassian.com";
	const conf = "https://confluence.status.atlassian.com";
	const atlassian = svc({ type: "statuspage", base: hub, extraBases: [jira, conf] });
	const page = (name: string, indicator: string, components: { id: string; name: string; status: string }[], incidents: unknown[] = []) =>
		JSON.stringify({ page: { id: name.toLowerCase(), name, url: `https://${name}.example` }, status: { indicator, description: indicator === "none" ? "All Systems Operational" : "Partially Degraded Service" }, components, incidents });
	function route(pages: Record<string, string | number>) {
		fetchSpy.mockImplementation(async (url: string) => {
			const hit = Object.entries(pages).find(([base]) => url === `${base}/api/v2/summary.json`);
			if (!hit) throw new Error(`unexpected ${url}`);
			return typeof hit[1] === "number" ? reply("", hit[1]) : reply(hit[1]);
		});
	}

	it("takes the worst product page and labels it, even though the hub is clear", async () => {
		route({
			[hub]: page("Atlassian", "none", []),
			[jira]: page("Jira Software", "minor", [{ id: "j1", name: "Viewing issues", status: "degraded_performance" }, { id: "j2", name: "Search", status: "operational" }]),
			[conf]: page("Confluence", "none", [{ id: "c1", name: "Editing", status: "operational" }]),
		});
		const r = await resolveStatus(atlassian);
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Jira Software: Partially Degraded Service");
		expect(r.details?.components).toEqual({ operational: 2, total: 3, impacted: ["Viewing issues"] });
		expect(r.details?.url).toBe("https://Atlassian.example");
	});

	it("surfaces a product page's incident", async () => {
		route({
			[hub]: page("Atlassian", "none", []),
			[jira]: page("Jira Software", "none", [{ id: "j1", name: "Search", status: "operational" }]),
			[conf]: page("Confluence", "major", [{ id: "c1", name: "Editing", status: "major_outage" }], [{ name: "Confluence editing unavailable", impact: "major", updated_at: new Date().toISOString(), components: [{ id: "c1" }] }]),
		});
		const r = await resolveStatus(atlassian);
		expect(r.details?.incident?.name).toBe("Confluence editing unavailable");
		expect(r.status).not.toBe("up");
	});

	it("skips a product page that fails and notes it", async () => {
		route({ [hub]: page("Atlassian", "none", []), [jira]: 500, [conf]: page("Confluence", "none", [{ id: "c1", name: "Editing", status: "operational" }]) });
		const r = await resolveStatus(atlassian);
		expect(r.status).toBe("up");
		expect(r.details?.note).toContain("jira-software.status.atlassian.com unavailable");
	});
});

describe("DocuSign status center JSON (docusign)", () => {
	const base = "https://health.docusign.com/production/1ds/ssg/apps/health/dynamic";
	const docusign = svc({ type: "docusign", url: base, statusUrl: "https://health.docusign.com/status" });
	const products = (statuses: Record<string, string>) =>
		JSON.stringify({
			components: [
				{ id: "g", name: "Products", type: "group", status: "available" },
				...Object.entries(statuses).map(([name, status], i) => ({ id: `p${i}`, name, type: "product", status, parentId: "g" })),
				{ id: "s1", name: "NA1", type: "site", status: "service_disruption", parentId: "p0" },
			],
		});
	const incident = (o: Partial<{ title: string; type: string; status: string; impact: string; updatedAt: string }>) => ({
		title: "Incident",
		type: "incident",
		status: "investigating",
		impact: "performance_degradation",
		updatedAt: new Date().toISOString(),
		...o,
	});
	function serve(components: string, incidents: unknown[] | number) {
		fetchSpy.mockImplementation(async (url: string) => {
			if (url === `${base}/components.json`) return reply(components);
			if (url === `${base}/incidents.json`) return typeof incidents === "number" ? reply("", incidents) : reply(JSON.stringify({ incidents }));
			throw new Error(`unexpected ${url}`);
		});
	}
	const healthy = { eSignature: "available", CLM: "available", Rooms: "available", Notary: "available" };

	it("is up when every product is available and incidents are resolved, canceled or scheduled", async () => {
		serve(products(healthy), [incident({ status: "resolved", impact: "service_disruption" }), incident({ type: "maintenance", status: "scheduled" }), incident({ type: "maintenance", status: "canceled" })]);
		const r = await resolveStatus(docusign);
		expect(r.status).toBe("up");
		expect(r.description).toBe("All Systems Operational");
		// Sites roll up into products: a site-level status alone doesn't count.
		expect(r.details?.components).toEqual({ operational: 4, total: 4, impacted: [] });
		expect(r.details?.url).toBe("https://health.docusign.com/status");
	});

	it("is degraded for an active performance-degradation incident", async () => {
		serve(products(healthy), [incident({ title: "Document Preview Unavailable on NA11 (Incident 6194)", status: "identified" })]);
		const r = await resolveStatus(docusign);
		expect(r.status).toBe("degraded");
		expect(r.description).toBe("Document Preview Unavailable on NA11 (Incident 6194)");
		expect(r.details?.incident?.name).toBe("Document Preview Unavailable on NA11 (Incident 6194)");
	});

	it("is down for a broad service disruption, degraded when it hits one product", async () => {
		serve(products({ eSignature: "service_disruption", CLM: "service_disruption", Rooms: "available", Notary: "available" }), []);
		expect((await resolveStatus(docusign)).status).toBe("down");
		serve(products({ ...healthy, eSignature: "service_disruption" }), []);
		const r = await resolveStatus(docusign);
		expect(r.status).toBe("degraded");
		expect(r.details?.components?.impacted).toEqual(["eSignature"]);
	});

	it("reads a maintenance in progress as degraded and ignores stale open incidents", async () => {
		serve(products(healthy), [incident({ type: "maintenance", status: "in_progress", title: "CLM maintenance" })]);
		expect((await resolveStatus(docusign)).status).toBe("degraded");
		serve(products(healthy), [incident({ updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() })]);
		expect((await resolveStatus(docusign)).status).toBe("up");
	});

	it("falls back to components when incidents.json fails, and is unknown when components.json fails", async () => {
		serve(products({ ...healthy, CLM: "performance_degradation" }), 500);
		expect((await resolveStatus(docusign)).status).toBe("degraded");
		fetchSpy.mockResolvedValue(reply("", 404));
		expect((await resolveStatus(docusign)).status).toBe("unknown");
	});
});

describe("Datadog RSS feed (Statuspage-format history)", () => {
	const url = "https://status.datadoghq.com/history.rss";
	const feed = (body: string) =>
		`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Datadog US1 Status - Incident History</title><item><title>Delayed Traces in APM</title><description>${body}</description><pubDate>${new Date().toUTCString()}</pubDate><link>https://status.datadoghq.com/incidents/x</link></item></channel></rss>`;
	const update = (stage: string, text: string) => `&lt;p&gt;&lt;small&gt;Nov  9, 20:35 UTC&lt;/small&gt;&lt;br&gt;&lt;strong&gt;${stage}&lt;/strong&gt; - ${text}&lt;/p&gt;`;

	it("is up once the newest update is Resolved", async () => {
		fetchSpy.mockResolvedValue(reply(feed(update("Resolved", "We have seen recovery on live data for APM.") + update("Identified", "Delayed traces in APM."))));
		expect((await resolveStatus(svc({ type: "rss", url }))).status).toBe("up");
	});

	it("is active while the incident is Identified", async () => {
		fetchSpy.mockResolvedValue(reply(feed(update("Identified", "Some users may see missing or delayed traces."))));
		expect((await resolveStatus(svc({ type: "rss", url }))).status).toBe("degraded");
	});
});

describe("disabled services", () => {
	it("short-circuits to unknown without fetching, surfacing the reason", async () => {
		const reason = "Upstream no longer publishes a usable feed.";
		const service: Service = { ...svc({ type: "rss", url: "https://example.com/feed.rss" }), disabled: reason };
		const r = await resolveStatus(service);
		expect(r.status).toBe("unknown");
		expect(r.description).toBe(reason);
		expect(r.disabled).toBe(reason);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("Mistral AI (Statuspage-compatible JSON)", () => {
	it("reads summary.json off status.mistral.ai instead of pinging the challenged HTML", async () => {
		fetchSpy.mockResolvedValue(
			reply(
				JSON.stringify({
					page: { id: "ae27f3c4-86a4-4290-a053-87252545d7f9", name: "Mistral AI Status", url: "https://status.mistral.ai", updated_at: "2026-10-15T11:30:27-07:00" },
					status: { indicator: "minor", description: "Minor Service Outage" },
					components: [
						{ id: "c1", name: "Completion API", status: "degraded_performance" },
						{ id: "c2", name: "Embedding API", status: "operational" },
					],
					incidents: [],
				}),
			),
		);
		const r = await resolveStatus(svc({ type: "statuspage", base: "https://status.mistral.ai" }));
		expect(fetchSpy.mock.calls[0][0]).toBe("https://status.mistral.ai/api/v2/summary.json");
		expect(r.status).toBe("degraded");
		expect(r.details?.components?.impacted).toEqual(["Completion API"]);
	});
});

describe("DeepSeek RSS feed (Flashduty)", () => {
	const url = "https://status.deepseek.com/history.rss";
	const resolve = () => resolveStatus(svc({ type: "rss", url, statusUrl: "https://status.deepseek.com" }));
	// Flashduty entity-encodes the HTML body and puts markup between "Status:" and the state.
	function feed(state: string) {
		const body = `&lt;p&gt;&lt;strong&gt;Status:&lt;/strong&gt; ${state}&lt;/p&gt;&lt;p&gt;We are aware of degraded performance.&lt;/p&gt;&lt;p&gt;&lt;strong&gt;Affected components:&lt;/strong&gt; 对话服务(Chatservice)&lt;/p&gt;`;
		return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>DeepSeek</title><item><title>DeepSeek 网页/Chat 性能下降（DeepSeek Web/Chat Degraded Performance）</title><link>https://status.deepseek.com/incidents/1</link><description>${body}</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
	}

	it("reads a resolved incident as up despite the problem wording in the body", async () => {
		fetchSpy.mockResolvedValue(reply(feed("resolved")));
		const r = await resolve();
		expect(fetchSpy.mock.calls[0][0]).toBe(url);
		expect(r.status).toBe("up");
		expect(r.details?.url).toBe("https://status.deepseek.com");
	});

	it("reads an investigating incident as active", async () => {
		fetchSpy.mockResolvedValue(reply(feed("investigating")));
		expect((await resolve()).status).toBe("down");
	});

	it("reads monitoring as recovering (up)", async () => {
		fetchSpy.mockResolvedValue(reply(feed("monitoring")));
		expect((await resolve()).status).toBe("up");
	});
});

describe("rss titleTags (status.x.ai shared by Grok and Cursor)", () => {
	const url = "https://status.x.ai/feed.xml";
	const item = (title: string, status: string, ageMin: number) =>
		`<item><title>${title}</title><description><![CDATA[<h3>Status: ${status}</h3><p>Severity: disruption</p>]]></description><pubDate>${new Date(Date.now() - ageMin * 60_000).toUTCString()}</pubDate><link>https://status.x.ai/x/1</link></item>`;
	const feed = (...items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel><title>SpaceXAI System Status</title>${items.join("")}</channel></rss>`;
	const grok = svc({ type: "rss", url, titleTags: ["grok.com", "Global (api.x.ai)"] });
	const cursor = svc({ type: "rss", url, titleTags: ["Cursor IDE (Desktop)", "cursor.com"] });

	it("keeps another product's newer incident off this tile", async () => {
		fetchSpy.mockImplementation(async () => reply(feed(item("[Cursor IDE (Desktop)] Elevated latency for composer", "INVESTIGATING", 5), item("[grok.com] Grok Degradation", "RESOLVED", 60))));
		expect((await resolveStatus(grok)).status).toBe("up");
		const c = await resolveStatus(cursor);
		expect(c.status).toBe("degraded");
		expect(c.description).toBe("[Cursor IDE (Desktop)] Elevated latency for composer");
	});

	it("matches tags case-insensitively and shows a shared incident on both tiles", async () => {
		fetchSpy.mockImplementation(async () => reply(feed(item("[CURSOR.COM] Elevated errors", "INVESTIGATING", 5), item("[Global (api.x.ai)] Elevated errors", "INVESTIGATING", 5))));
		expect((await resolveStatus(cursor)).status).toBe("degraded");
		expect((await resolveStatus(grok)).status).toBe("degraded");
	});

	it("is up with no recent incidents when no entry carries one of its tags", async () => {
		fetchSpy.mockImplementation(async () => reply(feed(item("[Voice] Enterprise Voice Degraded", "INVESTIGATING", 5), item("Untagged incident", "INVESTIGATING", 5))));
		const r = await resolveStatus(cursor);
		expect(r.status).toBe("up");
		expect(r.description).toBe("No recent incidents reported");
	});
});

describe("statuspage components allowlist (Replicate on cloudflarestatus.com)", () => {
	const base = "https://www.cloudflarestatus.com";
	const replicate = svc({ type: "statuspage", base, components: ["Replicate"], statusUrl: `${base}/services?search=replicate` });
	function summary(o: { replicate: string; others?: string; incidents?: unknown[] }) {
		return JSON.stringify({
			page: { id: "yh6f0r4529hb", url: base, updated_at: "2026-11-17T00:00:00Z" },
			status: { indicator: "major", description: "Major Service Outage" },
			components: [
				{ id: "g-svc", name: "Cloudflare Sites and Services", group: true, status: "major_outage" },
				{ id: "c-rep", name: "Replicate", status: o.replicate, group_id: "g-svc" },
				{ id: "c-cdn", name: "CDN/Cache", status: o.others ?? "major_outage", group_id: "g-svc" },
				{ id: "pop-1", name: "London - (LHR)", status: "partial_outage", group_id: "g-eu" },
			],
			incidents: o.incidents ?? [],
		});
	}
	const incident = (name: string, impact: string, componentIds: string[]) => ({ name, impact, updated_at: new Date().toISOString(), components: componentIds.map((id) => ({ id })) });

	it("ignores the rest of Cloudflare's page when Replicate is operational", async () => {
		fetchSpy.mockResolvedValue(reply(summary({ replicate: "operational", incidents: [incident("CDN outage", "critical", ["c-cdn"]), incident("Page-wide notice", "major", [])] })));
		const r = await resolveStatus(replicate);
		expect(r.status).toBe("up");
		expect(r.description).toBe("All Systems Operational");
		expect(r.details?.components).toEqual({ operational: 1, total: 1, impacted: [] });
		expect(r.details?.incident).toBeUndefined();
		expect(r.details?.url).toBe(`${base}/services?search=replicate`);
	});

	it("reflects the Replicate component and incidents naming it", async () => {
		fetchSpy.mockResolvedValue(reply(summary({ replicate: "major_outage", others: "operational", incidents: [incident("Replicate predictions failing", "major", ["c-rep"])] })));
		const r = await resolveStatus(replicate);
		expect(r.status).toBe("down");
		expect(r.description).toBe("Replicate predictions failing");
	});

	it("reads degraded for a minor incident on Replicate", async () => {
		fetchSpy.mockResolvedValue(reply(summary({ replicate: "degraded_performance", incidents: [incident("Slow cold boots", "minor", ["c-rep", "c-cdn"])] })));
		expect((await resolveStatus(replicate)).status).toBe("degraded");
	});
});
