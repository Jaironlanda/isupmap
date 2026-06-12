import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import schemaReportsSql from "../schema-reports.sql?raw";

// Rendering a /status/<id> page reads community reports from REPORTS_DB, so the
// schema must exist for the canonical (200) case to render.
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

beforeAll(() => applySchema(schemaReportsSql));

/**
 * The /status routes accept an optional trailing slash but the canonical URL
 * has none. Serving both forms 200 makes Search Console flag the slash variant
 * as "Alternate page with proper canonical tag", so the Worker 301-redirects
 * the slash form to its canonical, no-slash URL.
 */
async function fetchNoRedirect(path: string): Promise<Response> {
	const req = new Request(`http://localhost${path}`, { redirect: "manual" });
	const ctx = createExecutionContext();
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe("trailing-slash canonicalization", () => {
	it("301s /status/ to /status", async () => {
		const res = await fetchNoRedirect("/status/");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("http://localhost/status");
	});

	it("301s /status/<id>/ to /status/<id>", async () => {
		const res = await fetchNoRedirect("/status/github/");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("http://localhost/status/github");
	});

	it("preserves the query string when redirecting", async () => {
		const res = await fetchNoRedirect("/status/github/?utm_source=x");
		expect(res.status).toBe(301);
		expect(res.headers.get("location")).toBe("http://localhost/status/github?utm_source=x");
	});

	it("serves the canonical /status/<id> form directly (no redirect)", async () => {
		const res = await fetchNoRedirect("/status/github");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	it("404s an unknown service even with a trailing slash", async () => {
		const res = await fetchNoRedirect("/status/not-a-real-service/");
		expect(res.status).toBe(404);
	});
});
