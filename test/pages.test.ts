import { describe, expect, it } from "vitest";
import type { ApiService } from "../src/db";
import { findService, renderServicePage, renderSitemap, renderStatusIndex } from "../src/pages";
import { SERVICES, type Service, type StatusLevel } from "../src/services";

function apiService(id: string, status: StatusLevel, over: Partial<ApiService> = {}): ApiService {
	return { id, name: id.toUpperCase(), category: "Test", weight: 1, status, description: "", uptime: { day: 1, week: 1 }, ...over };
}
const svc: Service = SERVICES[0];

describe("renderServicePage", () => {
	it("renders an indexable page with canonical + status copy", () => {
		const html = renderServicePage(svc, apiService(svc.id, "down", { description: "Major outage" }), 1_700_000_000_000);
		expect(html).toContain(`<link rel="canonical" href="https://isupmap.com/status/${svc.id}" />`);
		expect(html).toContain(`Is ${svc.name} down?`);
		expect(html).toContain("Major outage"); // incident note surfaced
		expect(html).toContain("Down"); // status label
	});

	it("includes the report widget container", () => {
		const html = renderServicePage(svc, apiService(svc.id, "up"), 1000);
		expect(html).toContain(`data-report-widget`);
		expect(html).toContain(`data-service-id="${svc.id}"`);
	});

	it("links report.css and report.js", () => {
		const html = renderServicePage(svc, apiService(svc.id, "up"), 1000);
		expect(html).toContain(`<link rel="stylesheet" href="/report.css" />`);
		expect(html).toContain(`<script src="/report.js" type="module">`);
	});

	it("renders the service card with status, heartbeat, and official link", () => {
		const up = renderServicePage(svc, apiService(svc.id, "up"), 1000);
		expect(up).toContain("Operational"); // status label in the heartbeat indicator
		expect(up).toContain("sp-beat--up"); // heartbeat tone class
		expect(up).toContain(`Official ${svc.name} status page`);

		const unknown = renderServicePage(svc, null, 1000);
		expect(unknown).toContain("Unknown");
		expect(unknown).toContain("sp-beat--unknown");
	});

	it("mounts an empty community-reports card for the client to fill", () => {
		const html = renderServicePage(svc, apiService(svc.id, "up"), 1000);
		expect(html).toContain('class="sp-card" data-report-widget');
	});

	it("includes the map + MapLibre assets only when showMap is true", () => {
		const withMap = renderServicePage(svc, apiService(svc.id, "up"), 1000, "KEY", true);
		expect(withMap).toContain('id="sp-map"');
		expect(withMap).toContain("/lib/maplibre-gl.js");

		const solo = renderServicePage(svc, apiService(svc.id, "up"), 1000, "KEY", false);
		expect(solo).not.toContain('id="sp-map"');
		expect(solo).not.toContain("maplibre-gl");
		expect(solo).toContain("sp-wrap--solo");
		expect(solo).toContain("/report.js"); // community-reports widget still loads
	});

	it("escapes untrusted snapshot text", () => {
		const html = renderServicePage(svc, apiService(svc.id, "degraded", { description: "<img src=x onerror=alert(1)>" }), 1000);
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});

describe("findService", () => {
	it("resolves a known id and rejects an unknown one", () => {
		expect(findService(svc.id)?.name).toBe(svc.name);
		expect(findService("definitely-not-a-service")).toBeUndefined();
	});
});

describe("renderStatusIndex", () => {
	it("links every tracked service", () => {
		const html = renderStatusIndex();
		for (const s of SERVICES) expect(html).toContain(`/status/${s.id}`);
	});
});

describe("renderSitemap", () => {
	it("includes the homepage, directory, and one URL per service", () => {
		const xml = renderSitemap();
		expect(xml).toContain("<loc>https://isupmap.com/</loc>");
		expect(xml).toContain("<loc>https://isupmap.com/status</loc>");
		for (const s of SERVICES) expect(xml).toContain(`<loc>https://isupmap.com/status/${s.id}</loc>`);
		// Well-formed: one <url> per entry (home + directory + terms + privacy + bot + every service).
		const urlCount = (xml.match(/<url>/g) ?? []).length;
		expect(urlCount).toBe(SERVICES.length + 5);
	});
});
