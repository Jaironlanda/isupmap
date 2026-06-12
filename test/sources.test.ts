import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatus } from "../src/sources";
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
				updated_at: "2026-06-10T12:00:00Z",
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

describe("Mistral AI (http)", () => {
	const pingUrl = "https://status.mistral.ai";
	const statusUrl = "https://status.mistral.ai";
	const mistral: Service = {
		id: "mistral",
		name: "Mistral AI",
		category: "AI",
		weight: 6,
		source: { type: "http", url: pingUrl, statusUrl },
	};
	const resolve = () => resolveStatus(mistral);

	it("is up when the status page returns 200 (all clear)", async () => {
		fetchSpy.mockResolvedValue(reply("<!DOCTYPE html><html>OK</html>", 200));
		const r = await resolve();
		expect(r.status).toBe("up");
		// Pings the configured URL.
		expect(fetchSpy.mock.calls[0][0]).toBe(pingUrl);
		// statusUrl must be surfaced so "Visit status page" links correctly.
		expect(r.details?.url).toBe(statusUrl);
	});

	it("is down when the status page returns 500 (server error)", async () => {
		// Two calls: first attempt + one retry (both 5xx).
		fetchSpy.mockResolvedValue(reply("Internal Server Error", 500));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.details?.url).toBe(statusUrl);
	});
});

describe("DeepSeek (http)", () => {
	const pingUrl = "https://status.deepseek.com";
	const statusUrl = "https://status.deepseek.com";
	const deepseek: Service = {
		id: "deepseek",
		name: "DeepSeek",
		category: "AI",
		weight: 7,
		source: { type: "http", url: pingUrl, statusUrl },
	};
	const resolve = () => resolveStatus(deepseek);

	it("is up when the status page returns 200 (all clear)", async () => {
		fetchSpy.mockResolvedValue(reply("<!DOCTYPE html><html>OK</html>", 200));
		const r = await resolve();
		expect(r.status).toBe("up");
		// Pings the configured URL.
		expect(fetchSpy.mock.calls[0][0]).toBe(pingUrl);
		// statusUrl must be surfaced so "Visit status page" links correctly.
		expect(r.details?.url).toBe(statusUrl);
	});

	it("is down when the status page returns 500 (server error)", async () => {
		// Two calls: first attempt + one retry (both 5xx).
		fetchSpy.mockResolvedValue(reply("Internal Server Error", 500));
		const r = await resolve();
		expect(r.status).toBe("down");
		expect(r.details?.url).toBe(statusUrl);
	});
});
