import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
	aggregateReports,
	insertReports,
	normalizeReason,
	pruneReports,
	REPORT_WINDOW_MS,
} from "../src/reports";
import type { VoteMessage } from "../src/reports";
import schemaReportsSql from "../schema-reports.sql?raw";

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
	for (const stmt of statements) await env.REPORTS_DB.prepare(stmt).run();
}

function vote(serviceId: string, ipHash: string, country: string, reason: VoteMessage["reason"], ts: number): VoteMessage {
	return { serviceId, ipHash, country, reason, ts };
}

beforeAll(() => applySchema(schemaReportsSql));

beforeEach(async () => {
	await env.REPORTS_DB.prepare("DELETE FROM reports").run();
});

describe("normalizeReason", () => {
	it("passes through valid reasons", () => {
		expect(normalizeReason("unreachable")).toBe("unreachable");
		expect(normalizeReason("errors")).toBe("errors");
		expect(normalizeReason("login")).toBe("login");
		expect(normalizeReason("slow")).toBe("slow");
		expect(normalizeReason("other")).toBe("other");
	});

	it("coerces unknown/missing values to 'other'", () => {
		expect(normalizeReason("unknown-garbage")).toBe("other");
		expect(normalizeReason(undefined)).toBe("other");
		expect(normalizeReason(null)).toBe("other");
		expect(normalizeReason(42)).toBe("other");
		expect(normalizeReason("")).toBe("other");
	});
});

describe("insertReports / aggregateReports", () => {
	it("aggregates by country and reason", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "hash1", "US", "errors", now),
			vote("svc-a", "hash2", "US", "slow", now),
			vote("svc-a", "hash3", "GB", "unreachable", now),
		]);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);
		expect(report.total).toBe(3);
		expect(report.countries.find((c) => c.country === "US")?.count).toBe(2);
		expect(report.countries.find((c) => c.country === "GB")?.count).toBe(1);
		expect(report.reasons.find((r) => r.reason === "errors")?.count).toBe(1);
		expect(report.reasons.find((r) => r.reason === "slow")?.count).toBe(1);
		expect(report.reasons.find((r) => r.reason === "unreachable")?.count).toBe(1);
	});

	it("ignores a duplicate (service, ip_hash, bucket) — first reason wins", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "hash1", "US", "errors", now),
			vote("svc-a", "hash1", "US", "slow", now), // same bucket → ignored
		]);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);
		expect(report.total).toBe(1);
		expect(report.reasons[0].reason).toBe("errors");
	});

	it("does not count votes outside the window", async () => {
		const now = Date.now();
		const old = now - REPORT_WINDOW_MS - 1000;
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "hash1", "US", "errors", old),
		]);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);
		expect(report.total).toBe(0);
	});

	it("isolates counts per service", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "hash1", "US", "errors", now),
			vote("svc-b", "hash2", "DE", "slow", now),
		]);
		const a = await aggregateReports(env.REPORTS_DB, "svc-a", now);
		const b = await aggregateReports(env.REPORTS_DB, "svc-b", now);
		expect(a.total).toBe(1);
		expect(b.total).toBe(1);
	});

	it("returns zero totals when no reports exist", async () => {
		const report = await aggregateReports(env.REPORTS_DB, "svc-nobody", Date.now());
		expect(report.total).toBe(0);
		expect(report.countries).toHaveLength(0);
		expect(report.reasons).toHaveLength(0);
		expect(report.recent).toHaveLength(0);
	});

	it("returns a 7-bucket daily volume timeline", async () => {
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "h1", "US", "errors", now),            // today
			vote("svc-a", "h2", "GB", "slow", now),              // today
			vote("svc-a", "h3", "US", "unreachable", now - day), // yesterday
			vote("svc-a", "h4", "DE", "other", now - 3 * day),   // 3 days ago
		]);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);

		expect(report.timeline).toHaveLength(7);
		expect(report.timeline.at(-1)?.count).toBe(2);        // newest bucket: 2 reports today
		expect(report.timeline.reduce((s, p) => s + p.count, 0)).toBe(4);
	});

	it("returns the newest reports first in `recent`, capped at 10", async () => {
		const now = Date.now();
		const rows = Array.from({ length: 12 }, (_, i) =>
			vote("svc-a", `hash${i}`, "US", "errors", now - i * 1000),
		);
		await insertReports(env.REPORTS_DB, rows);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);
		expect(report.recent).toHaveLength(10);
		// Newest (ts = now, smallest i) comes first.
		expect(report.recent[0].ts).toBe(now);
		expect(report.recent[0].ts).toBeGreaterThan(report.recent[9].ts);
	});
});

describe("pruneReports", () => {
	it("deletes old reports and keeps recent ones", async () => {
		const now = Date.now();
		const retention = 30 * 24 * 60 * 60 * 1000;
		const old = now - retention - 1000;
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "hash1", "US", "errors", old),
			vote("svc-a", "hash2", "US", "slow", now),
		]);
		const removed = await pruneReports(env.REPORTS_DB, now);
		expect(removed).toBe(1);
		const remaining = await env.REPORTS_DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
		expect(remaining?.n).toBe(1);
	});
});

describe("queue consumer", () => {
	it("inserts votes from the batch and refreshes KV", async () => {
		const now = Date.now();
		const msg: VoteMessage = { serviceId: "svc-a", country: "US", ipHash: "abc", reason: "errors", ts: now };

		const batch = {
			messages: [{ body: msg, ack: vi.fn(), retry: vi.fn() }],
			ackAll: vi.fn(),
			retryAll: vi.fn(),
		} as unknown as MessageBatch<VoteMessage>;

		await worker.queue!(batch, env);

		const row = await env.REPORTS_DB.prepare("SELECT COUNT(*) AS n FROM reports").first<{ n: number }>();
		expect(row?.n).toBe(1);

		const kv = await env.SNAPSHOT_KV.get("reportcount:svc-a", "json");
		expect(kv).not.toBeNull();
	});
});

describe("GET /api/report/:id", () => {
	it("returns 404 for an unknown service id", async () => {
		const req = new Request("http://localhost/api/report/not-a-real-service");
		const res = await worker.fetch(req, env, {} as ExecutionContext);
		expect(res.status).toBe(404);
	});

	it("returns a Report shape for a known service", async () => {
		// Use the first tracked service id.
		const { SERVICES } = await import("../src/services");
		const id = SERVICES[0].id;
		const req = new Request(`http://localhost/api/report/${id}`);
		const res = await worker.fetch(req, env, {} as ExecutionContext);
		expect(res.status).toBe(200);
		const body = await res.json() as Record<string, unknown>;
		expect(body).toHaveProperty("total");
		expect(body).toHaveProperty("countries");
		expect(body).toHaveProperty("reasons");
	});
});

describe("POST /api/report/:id", () => {
	it("returns 404 for an unknown service id", async () => {
		const req = new Request("http://localhost/api/report/not-real", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ reason: "errors" }),
		});
		const res = await worker.fetch(req, env, {} as ExecutionContext);
		expect(res.status).toBe(404);
	});

	it("enqueues and returns 202 with a report", async () => {
		const { SERVICES } = await import("../src/services");
		const id = SERVICES[0].id;
		const req = new Request(`http://localhost/api/report/${id}`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" },
			body: JSON.stringify({ reason: "slow" }),
		});
		const res = await worker.fetch(req, env, {} as ExecutionContext);
		expect(res.status).toBe(202);
		const body = await res.json() as { ok: boolean; report: Record<string, unknown> };
		expect(body.ok).toBe(true);
		expect(body.report).toHaveProperty("total");
	});

	it("coerces an invalid reason to 'other' (does not reject)", async () => {
		const { SERVICES } = await import("../src/services");
		const id = SERVICES[0].id;
		const req = new Request(`http://localhost/api/report/${id}`, {
			method: "POST",
			headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.5" },
			body: JSON.stringify({ reason: "completely-made-up" }),
		});
		const res = await worker.fetch(req, env, {} as ExecutionContext);
		expect(res.status).toBe(202);
	});
});
