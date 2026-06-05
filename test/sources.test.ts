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

	it("is degraded on a 5xx", async () => {
		fetchSpy.mockResolvedValue(reply("boom", 500));
		expect((await resolve()).status).toBe("degraded");
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
