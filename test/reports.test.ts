import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
	aggregateReports,
	detectSurges,
	insertReports,
	normalizeReason,
	pruneReports,
	REPORT_WINDOW_MS,
	reportSparklines,
	SPARK_HOURS,
	SURGE_BUCKET_MS,
} from "../src/reports";
import type { Surge, VoteMessage } from "../src/reports";
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
	await env.REPORTS_DB.prepare("DELETE FROM report_baseline").run();
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

	it("surfaces the surge flag from report_baseline", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [vote("svc-a", "h1", "US", "errors", now)]);
		// No baseline row yet → not surging.
		expect((await aggregateReports(env.REPORTS_DB, "svc-a", now)).surge).toBe(false);
		// A confirmed surge in report_baseline → reflected in the report payload.
		await env.REPORTS_DB.prepare(
			"INSERT INTO report_baseline (service_id, ewma_rate, ewma_var, surge, streak, surge_since, updated_at) VALUES ('svc-a', 1, 1, 1, 2, ?, ?)",
		).bind(now, now).run();
		expect((await aggregateReports(env.REPORTS_DB, "svc-a", now)).surge).toBe(true);
	});

	it("returns a 24-bucket hourly volume series", async () => {
		const now = Date.now();
		const hour = 60 * 60 * 1000;
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "h1", "US", "errors", now),           // this hour
			vote("svc-a", "h2", "GB", "slow", now),             // this hour
			vote("svc-a", "h3", "US", "unreachable", now - hour), // last hour
			vote("svc-a", "h4", "DE", "other", now - 50 * hour),  // outside 24h window
		]);
		const report = await aggregateReports(env.REPORTS_DB, "svc-a", now);

		expect(report.hourly).toHaveLength(SPARK_HOURS);
		expect(report.hourly.at(-1)?.count).toBe(2); // newest bucket: 2 this hour
		expect(report.hourly.reduce((s, p) => s + p.count, 0)).toBe(3); // the 50h-old one is excluded
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

describe("detectSurges", () => {
	// Passes are spaced just past the 30-min detection window so each pass only
	// "sees" the reports inserted for it — letting us script a volume timeline.
	const STEP = SURGE_BUCKET_MS + 60 * 1000;

	/** Insert `n` reports for `serviceId` inside the window ending at `at`, with unique IP hashes. */
	async function reportsAt(serviceId: string, n: number, at: number, tag: string): Promise<void> {
		if (n === 0) return;
		const rows = Array.from({ length: n }, (_, i) => vote(serviceId, `${tag}-${i}`, "US", "errors", at - 1000));
		await insertReports(env.REPORTS_DB, rows);
	}

	it("seeds a baseline on first sight and never surges on the first pass", async () => {
		const t = Date.now();
		await reportsAt("svc-a", 20, t, "first");
		const result = await detectSurges(env.REPORTS_DB, t);
		// First-seen service is seeded, not scored — absent from the output.
		expect(result.get("svc-a")).toBeUndefined();
		const row = await env.REPORTS_DB.prepare("SELECT * FROM report_baseline WHERE service_id = ?").bind("svc-a").first();
		expect(row).not.toBeNull();
		expect(row?.surge).toBe(0);
	});

	it("raises a surge after a sustained spike above a quiet baseline", async () => {
		let t = Date.now();
		// Warm a low, stable baseline (~1 report/window).
		for (let i = 0; i < 3; i++) {
			await reportsAt("svc-a", 1, t, `warm${i}`);
			await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		// First spike: anomalous but unconfirmed (one bucket).
		await reportsAt("svc-a", 12, t, "spike1");
		expect((await detectSurges(env.REPORTS_DB, t)).get("svc-a")?.surging).toBe(false);
		t += STEP;
		// Second consecutive spike: confirmed surge.
		await reportsAt("svc-a", 12, t, "spike2");
		const r = (await detectSurges(env.REPORTS_DB, t)).get("svc-a");
		expect(r?.surging).toBe(true);
		expect(r?.observed).toBe(12);
		expect(r?.since).toBeDefined();
	});

	it("does not surge below the absolute floor, however high the z-score", async () => {
		let t = Date.now();
		for (let i = 0; i < 3; i++) {
			await reportsAt("svc-a", 1, t, `warm${i}`);
			await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		// 4 reports is a big jump over a ~1 baseline (z ≥ 3) but under SURGE_MIN (5).
		for (let i = 0; i < 3; i++) {
			await reportsAt("svc-a", 4, t, `low${i}`);
			expect((await detectSurges(env.REPORTS_DB, t)).get("svc-a")?.surging).toBe(false);
			t += STEP;
		}
	});

	it("clears the surge once volume returns to normal", async () => {
		let t = Date.now();
		for (let i = 0; i < 3; i++) {
			await reportsAt("svc-a", 1, t, `warm${i}`);
			await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		for (let i = 0; i < 2; i++) {
			await reportsAt("svc-a", 12, t, `spike${i}`);
			await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		// Quiet pass (no new reports in window) → surge clears.
		const r = (await detectSurges(env.REPORTS_DB, t)).get("svc-a");
		expect(r?.observed).toBe(0);
		expect(r?.surging).toBe(false);
	});

	it("scores services independently", async () => {
		let t = Date.now();
		// Warm low baselines for both.
		for (let i = 0; i < 3; i++) {
			await reportsAt("svc-a", 1, t, `wa${i}`);
			await reportsAt("svc-b", 1, t, `wb${i}`);
			await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		// svc-a spikes for two consecutive buckets; svc-b stays calm.
		let res = new Map<string, Surge>();
		for (let i = 0; i < 2; i++) {
			await reportsAt("svc-a", 12, t, `sp${i}`);
			await reportsAt("svc-b", 1, t, `sb${i}`);
			res = await detectSurges(env.REPORTS_DB, t);
			t += STEP;
		}
		expect(res.get("svc-a")?.surging).toBe(true);
		expect(res.get("svc-b")?.surging).toBe(false);
	});
});

describe("reportSparklines", () => {
	const hour = 60 * 60 * 1000;

	it("returns a 24-bucket series per service with reports, oldest first", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "a1", "US", "errors", now),
			vote("svc-a", "a2", "GB", "slow", now),
			vote("svc-a", "a3", "US", "errors", now - hour),
			vote("svc-b", "b1", "DE", "errors", now),
		]);
		const sparks = await reportSparklines(env.REPORTS_DB, now);

		const a = sparks.get("svc-a");
		expect(a).toHaveLength(SPARK_HOURS);
		expect(a?.at(-1)).toBe(2); // newest hour
		expect(a?.at(-2)).toBe(1); // previous hour
		expect(a?.reduce((s, n) => s + n, 0)).toBe(3);
		expect(sparks.get("svc-b")?.at(-1)).toBe(1);
	});

	it("omits services with no reports in the 24h window", async () => {
		const now = Date.now();
		await insertReports(env.REPORTS_DB, [
			vote("svc-a", "old", "US", "errors", now - 50 * hour), // outside window
			vote("svc-b", "new", "US", "errors", now),
		]);
		const sparks = await reportSparklines(env.REPORTS_DB, now);
		expect(sparks.has("svc-a")).toBe(false);
		expect(sparks.has("svc-b")).toBe(true);
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
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(404);
	});

	it("returns a Report shape for a known service", async () => {
		// Use the first tracked service id.
		const { SERVICES } = await import("../src/services");
		const id = SERVICES[0].id;
		const req = new Request(`http://localhost/api/report/${id}`);
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
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
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
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
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
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
		const ctx = createExecutionContext();
		const res = await worker.fetch(req, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(202);
	});

	it("fails closed with 503 when VOTE_SALT is unset (won't store a reversible IP hash)", async () => {
		const { SERVICES } = await import("../src/services");
		const id = SERVICES[0].id;
		const original = env.VOTE_SALT;
		(env as { VOTE_SALT: string }).VOTE_SALT = "";
		try {
			const req = new Request(`http://localhost/api/report/${id}`, {
				method: "POST",
				headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.6" },
				body: JSON.stringify({ reason: "errors" }),
			});
			const ctx = createExecutionContext();
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(503);
		} finally {
			(env as { VOTE_SALT: string }).VOTE_SALT = original;
		}
	});
});
