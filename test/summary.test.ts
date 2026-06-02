import { describe, expect, it } from "vitest";
import { summarize } from "../src/index";
import type { ApiService } from "../src/db";
import type { StatusLevel } from "../src/services";

function svc(id: string, status: StatusLevel): ApiService {
	return { id, name: id.toUpperCase(), category: "Test", weight: 1, status, description: "", uptime: { day: 1, week: 1 } };
}
function snapshot(statuses: StatusLevel[], updatedAt: number | null = 1000) {
	return { updatedAt, services: statuses.map((s, i) => svc(`s${i}`, s)) };
}

describe("summarize", () => {
	it("reports all operational when every service is up", () => {
		const s = summarize(snapshot(["up", "up", "up"]));
		expect(s.status).toBe("up");
		expect(s.message).toBe("All systems operational");
		expect(s.total).toBe(3);
		expect(s.counts).toEqual({ up: 3, degraded: 0, down: 0, unknown: 0 });
	});

	it("escalates to down when any service is down (worst wins)", () => {
		const s = summarize(snapshot(["up", "degraded", "down"]));
		expect(s.status).toBe("down");
		expect(s.message).toBe("1 down, 1 degraded");
	});

	it("is degraded when the worst status is degraded", () => {
		const s = summarize(snapshot(["up", "degraded", "degraded"]));
		expect(s.status).toBe("degraded");
		expect(s.message).toBe("2 degraded");
	});

	it("ignores unknown when at least one service is up", () => {
		const s = summarize(snapshot(["up", "unknown"]));
		expect(s.status).toBe("up");
		expect(s.message).toBe("All systems operational");
	});

	it("is unknown only when nothing is up/degraded/down", () => {
		const s = summarize(snapshot(["unknown", "unknown"]));
		expect(s.status).toBe("unknown");
		expect(s.message).toBe("Status unavailable");
	});

	it("handles an empty snapshot", () => {
		const s = summarize(snapshot([]));
		expect(s).toMatchObject({ status: "unknown", total: 0 });
	});

	it("passes through updatedAt", () => {
		expect(summarize(snapshot(["up"], 42)).updatedAt).toBe(42);
		expect(summarize(snapshot(["up"], null)).updatedAt).toBeNull();
	});
});
