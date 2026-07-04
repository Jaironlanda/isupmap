import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyUptime } from "../src/db";
import worker from "../src/index";
import schemaSql from "../schema.sql?raw";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed "now": 2026-07-04T12:00:00Z — a half-elapsed UTC day. */
const NOW = Date.UTC(2026, 6, 4, 12);
const TODAY_START = Date.UTC(2026, 6, 4);

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
	await env.DB.batch([env.DB.prepare("DELETE FROM incidents"), env.DB.prepare("DELETE FROM current")]);
});

function insertIncident(serviceId: string, status: string, startedAt: number, endedAt: number | null) {
	return env.DB.prepare("INSERT INTO incidents (service_id, status, description, started_at, ended_at) VALUES (?, ?, NULL, ?, ?)")
		.bind(serviceId, status, startedAt, endedAt)
		.run();
}

describe("dailyUptime", () => {
	it("returns one fully-up entry per day when there are no incidents", async () => {
		const days = await dailyUptime(env.DB, "github", 90, NOW);
		expect(days).toHaveLength(90);
		expect(days.every((d) => d.uptime === 1 && d.worst === "up")).toBe(true);
		expect(days[89].date).toBe("2026-07-04"); // newest last
		expect(days[0].date).toBe(new Date(TODAY_START - 89 * DAY_MS).toISOString().slice(0, 10));
	});

	it("splits an incident spanning a UTC midnight across both days", async () => {
		// 23:00 July 3 → 01:00 July 4: one hour against each day.
		await insertIncident("github", "down", TODAY_START - 60 * 60_000, TODAY_START + 60 * 60_000);
		const days = await dailyUptime(env.DB, "github", 90, NOW);
		const [yesterday, today] = days.slice(-2);
		expect(yesterday.uptime).toBeCloseTo(1 - 1 / 24, 6);
		expect(yesterday.worst).toBe("down");
		// Today is measured over its elapsed 12 hours.
		expect(today.uptime).toBeCloseTo(1 - 1 / 12, 6);
		expect(today.worst).toBe("down");
	});

	it("clamps an open (unresolved) incident at now", async () => {
		await insertIncident("github", "degraded", NOW - 2 * 60 * 60_000, null);
		const days = await dailyUptime(env.DB, "github", 90, NOW);
		const today = days[89];
		expect(today.uptime).toBeCloseTo(1 - 2 / 12, 6);
		expect(today.worst).toBe("degraded");
	});

	it("down beats degraded for a day's worst status", async () => {
		await insertIncident("github", "degraded", NOW - 4 * 60 * 60_000, NOW - 3 * 60 * 60_000);
		await insertIncident("github", "down", NOW - 2 * 60 * 60_000, NOW - 60 * 60_000);
		const days = await dailyUptime(env.DB, "github", 90, NOW);
		expect(days[89].worst).toBe("down");
		expect(days[89].uptime).toBeCloseTo(1 - 2 / 12, 6);
	});

	it("ignores incidents fully outside the window and other services", async () => {
		await insertIncident("github", "down", NOW - 100 * DAY_MS, NOW - 95 * DAY_MS);
		await insertIncident("npm", "down", NOW - 60 * 60_000, null);
		const days = await dailyUptime(env.DB, "github", 90, NOW);
		expect(days.every((d) => d.uptime === 1 && d.worst === "up")).toBe(true);
	});
});

describe("GET /api/uptime/:id", () => {
	async function get(path: string): Promise<Response> {
		const req = new Request(`http://localhost${path}`);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		return res;
	}

	it("serves 90 daily entries plus the window average for a known service", async () => {
		const res = await get("/api/uptime/github");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { serviceId: string; days: unknown[]; uptime90: number };
		expect(body.serviceId).toBe("github");
		expect(body.days).toHaveLength(90);
		expect(body.uptime90).toBe(1); // empty incidents table → fully up
	});

	it("404s an unknown service id", async () => {
		const res = await get("/api/uptime/definitely-not-a-service");
		expect(res.status).toBe(404);
	});
});
