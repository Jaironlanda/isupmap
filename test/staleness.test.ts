import { describe, expect, it } from "vitest";
import { staleness } from "../src/index";

const MIN = 60 * 1000;

describe("staleness", () => {
	it("flags a cold start (null updatedAt) as stale with no age", () => {
		expect(staleness(null, 1_000_000)).toEqual({ stale: true, ageMs: null });
	});

	it("is fresh within the stale window", () => {
		const now = 1_000_000_000;
		const r = staleness(now - 5 * MIN, now); // 5 min old, under the 15-min threshold
		expect(r.stale).toBe(false);
		expect(r.ageMs).toBe(5 * MIN);
	});

	it("is stale past three cron cycles (15 min)", () => {
		const now = 1_000_000_000;
		const r = staleness(now - 20 * MIN, now);
		expect(r.stale).toBe(true);
		expect(r.ageMs).toBe(20 * MIN);
	});

	it("clamps a future timestamp to age 0", () => {
		const now = 1_000_000_000;
		expect(staleness(now + 10 * MIN, now)).toEqual({ stale: false, ageMs: 0 });
	});
});
