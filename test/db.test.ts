import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { persistSnapshot, pruneIncidents, readSnapshot, recentIncidents } from "../src/db";
import type { ServiceStatus, StatusLevel } from "../src/services";
import schemaSql from "../schema.sql?raw";

/**
 * D1's `exec` is finicky about comments and multi-line statements, so split the
 * schema into individual statements (dropping `--` comment-only lines) and run
 * each via a prepared statement.
 */
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

function status(id: string, level: StatusLevel, description = ""): ServiceStatus {
	return { id, name: id.toUpperCase(), category: "Test", weight: 1, status: level, description };
}

async function openIncidents() {
	const rows = await env.DB.prepare("SELECT service_id, status FROM incidents WHERE ended_at IS NULL").all();
	return rows.results as { service_id: string; status: string }[];
}

beforeAll(() => applySchema(schemaSql));

// Storage is isolated per test, but wipe explicitly so ordering never matters.
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM incidents"),
		env.DB.prepare("DELETE FROM current"),
		env.DB.prepare("DELETE FROM meta"),
	]);
});

describe("persistSnapshot incident transitions", () => {
	it("opens an incident when a service goes non-up", async () => {
		await persistSnapshot(env.DB, [status("a", "down", "boom")], 1000);
		const open = await openIncidents();
		expect(open).toEqual([{ service_id: "a", status: "down" }]);
	});

	it("does not open an incident for 'unknown'", async () => {
		await persistSnapshot(env.DB, [status("a", "unknown")], 1000);
		expect(await openIncidents()).toHaveLength(0);
	});

	it("closes the open incident when the service recovers", async () => {
		await persistSnapshot(env.DB, [status("a", "down")], 1000);
		await persistSnapshot(env.DB, [status("a", "up")], 2000);
		expect(await openIncidents()).toHaveLength(0);
		const closed = await env.DB.prepare("SELECT started_at, ended_at FROM incidents").first<{ started_at: number; ended_at: number }>();
		expect(closed).toMatchObject({ started_at: 1000, ended_at: 2000 });
	});

	it("updates status in place without opening a new row when severity changes", async () => {
		await persistSnapshot(env.DB, [status("a", "degraded")], 1000);
		await persistSnapshot(env.DB, [status("a", "down")], 2000);
		const all = await env.DB.prepare("SELECT status, ended_at FROM incidents").all();
		expect(all.results).toHaveLength(1);
		expect(all.results[0]).toMatchObject({ status: "down", ended_at: null });
	});

	it("records last_run in meta", async () => {
		await persistSnapshot(env.DB, [status("a", "up")], 12345);
		const meta = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_run'").first<{ value: string }>();
		expect(meta?.value).toBe("12345");
	});
});

describe("readSnapshot", () => {
	it("returns null before any snapshot is persisted", async () => {
		expect(await readSnapshot(env.DB)).toBeNull();
	});

	it("returns current services with updatedAt from meta", async () => {
		await persistSnapshot(env.DB, [status("a", "up"), status("b", "degraded")], 5000);
		const snap = await readSnapshot(env.DB, 5000);
		expect(snap?.updatedAt).toBe(5000);
		expect(snap?.services.map((s) => s.id).sort()).toEqual(["a", "b"]);
	});

	it("computes uptime from incident intervals", async () => {
		const hour = 60 * 60 * 1000;
		// Down for one hour, then recovered.
		await persistSnapshot(env.DB, [status("a", "down")], 0);
		await persistSnapshot(env.DB, [status("a", "up")], hour);
		const snap = await readSnapshot(env.DB, hour); // now == recovery time
		const a = snap?.services.find((s) => s.id === "a")!;
		// 1h downtime over a 24h window => ~0.9583 day uptime.
		expect(a.uptime.day).toBeCloseTo(1 - 1 / 24, 4);
		expect(a.uptime.week).toBeCloseTo(1 - 1 / (24 * 7), 4);
	});

	it("keeps uptime at 1 for a service that was never down", async () => {
		await persistSnapshot(env.DB, [status("a", "up")], 1000);
		const snap = await readSnapshot(env.DB, 1000);
		expect(snap?.services[0].uptime).toEqual({ day: 1, week: 1 });
	});
});

describe("recentIncidents", () => {
	it("returns incidents newest-first, joined with the service name", async () => {
		await persistSnapshot(env.DB, [status("a", "down")], 1000);
		await persistSnapshot(env.DB, [status("b", "degraded")], 2000);
		const incidents = await recentIncidents(env.DB, 10);
		expect(incidents.map((i) => i.serviceId)).toEqual(["b", "a"]);
		expect(incidents[0].serviceName).toBe("B");
	});

	it("respects the limit", async () => {
		await persistSnapshot(env.DB, [status("a", "down")], 1000);
		await persistSnapshot(env.DB, [status("a", "up")], 1500);
		await persistSnapshot(env.DB, [status("a", "down")], 2000);
		expect(await recentIncidents(env.DB, 1)).toHaveLength(1);
	});
});

describe("pruneIncidents", () => {
	it("deletes resolved incidents older than the retention window, keeping recent/open ones", async () => {
		const now = 1_000_000_000_000;
		const oldStart = now - 200 * 24 * 60 * 60 * 1000;
		// One resolved-and-old, one open (current).
		await persistSnapshot(env.DB, [status("a", "down")], oldStart);
		await persistSnapshot(env.DB, [status("a", "up")], oldStart + 1000); // old incident closed
		await persistSnapshot(env.DB, [status("b", "down")], now); // still open

		const removed = await pruneIncidents(env.DB, now);
		expect(removed).toBe(1);
		const remaining = await env.DB.prepare("SELECT service_id FROM incidents").all();
		expect(remaining.results.map((r: any) => r.service_id)).toEqual(["b"]);
	});
});
