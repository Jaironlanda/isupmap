import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IncidentRecord } from "../src/db";
import { persistSnapshot } from "../src/db";
import worker from "../src/index";
import { renderIncidentFeed } from "../src/pages";
import { SERVICES, type ServiceStatus, type StatusLevel } from "../src/services";
import schemaSql from "../schema.sql?raw";

function incident(over: Partial<IncidentRecord> = {}): IncidentRecord {
	return {
		id: 1,
		serviceId: "github",
		serviceName: "GitHub",
		category: "Developer & Cloud",
		status: "down",
		description: "Major outage",
		startedAt: 1_700_000_000_000,
		endedAt: null,
		...over,
	};
}

describe("renderIncidentFeed", () => {
	it("renders a valid Atom skeleton even with no incidents", () => {
		const xml = renderIncidentFeed([], undefined, 1_700_000_000_000);
		expect(xml).toContain(`<feed xmlns="http://www.w3.org/2005/Atom">`);
		expect(xml).toContain("<id>https://isupmap.com/feed.xml</id>");
		expect(xml).toContain(`<link href="https://isupmap.com/feed.xml" rel="self"`);
		expect(xml).toContain(`<updated>${new Date(1_700_000_000_000).toISOString()}</updated>`);
		expect(xml).not.toContain("<entry>");
	});

	it("renders an ongoing incident with a stable id and start time", () => {
		const xml = renderIncidentFeed([incident({ id: 42 })]);
		expect(xml).toContain("<title>GitHub is down</title>");
		expect(xml).toContain("<id>https://isupmap.com/status/github#incident-42</id>");
		expect(xml).toContain(`<published>${new Date(1_700_000_000_000).toISOString()}</published>`);
		expect(xml).toContain("ongoing as of the latest probe");
		expect(xml).toContain(`<link href="https://isupmap.com/status/github"/>`);
	});

	it("renders a resolved incident with duration, moving <updated> to the resolution", () => {
		const endedAt = 1_700_000_000_000 + 25 * 60_000;
		const xml = renderIncidentFeed([incident({ status: "degraded", endedAt })]);
		expect(xml).toContain("<title>Resolved: GitHub was degraded for 25m</title>");
		expect(xml).toContain(`<updated>${new Date(endedAt).toISOString()}</updated>`);
	});

	it("falls back to the service id when the name join is null", () => {
		const xml = renderIncidentFeed([incident({ serviceName: null })]);
		expect(xml).toContain("<title>github is down</title>");
	});

	it("escapes untrusted description text", () => {
		const xml = renderIncidentFeed([incident({ description: `<script>alert("x")</script> & more` })]);
		expect(xml).not.toContain("<script>");
		expect(xml).toContain("&lt;script&gt;");
		expect(xml).toContain("&amp; more");
	});

	it("scopes title, self link, and id to the service when one is given", () => {
		const svc = SERVICES.find((s) => s.id === "github")!;
		const xml = renderIncidentFeed([incident()], svc);
		expect(xml).toContain("<title>GitHub incidents — isUpMap</title>");
		expect(xml).toContain("<id>https://isupmap.com/status/github/feed.xml</id>");
		expect(xml).toContain(`<link href="https://isupmap.com/status/github/feed.xml" rel="self"`);
	});
});

describe("feed routes", () => {
	async function applySchema(sql: string) {
		const statements = sql
			.split(";")
			.map((chunk) =>
				chunk
					.split("\n")
					.filter((line) => !line.trim().startsWith("--"))
					.join("\n")
					.trim(),
			)
			.filter((s) => s.length > 0);
		for (const stmt of statements) await env.DB.prepare(stmt).run();
	}

	beforeAll(() => applySchema(schemaSql));

	beforeEach(async () => {
		await env.DB.batch([env.DB.prepare("DELETE FROM incidents"), env.DB.prepare("DELETE FROM current"), env.DB.prepare("DELETE FROM probe_state")]);
	});

	function status(id: string, level: StatusLevel, description = ""): ServiceStatus {
		return { id, name: id.toUpperCase(), category: "Test", weight: 1, status: level, description };
	}

	/** Open a confirmed incident: a non-up status must hold CONFIRM_THRESHOLD (2) polls. */
	async function openIncident(id: string, level: StatusLevel) {
		await persistSnapshot(env.DB, [status(id, level)], 1_700_000_000_000);
		await persistSnapshot(env.DB, [status(id, level, "It broke")], 1_700_000_300_000);
	}

	async function get(path: string): Promise<Response> {
		const req = new Request(`http://localhost${path}`);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it("serves the global Atom feed with open incidents", async () => {
		await openIncident("github", "down");
		const res = await get("/feed.xml");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/atom+xml");
		const xml = await res.text();
		expect(xml).toContain("GITHUB is down");
		expect(xml).toContain("/status/github#incident-");
	});

	it("scopes /status/<id>/feed.xml to that service", async () => {
		await openIncident("github", "down");
		await openIncident("npm", "degraded");
		const res = await get("/status/github/feed.xml");
		expect(res.status).toBe(200);
		const xml = await res.text();
		expect(xml).toContain("GITHUB is down");
		expect(xml).not.toContain("NPM");
	});

	it("404s a feed for an unknown service", async () => {
		const res = await get("/status/definitely-not-a-service/feed.xml");
		expect(res.status).toBe(404);
	});
});
