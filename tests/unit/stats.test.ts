// The statistics page's figures (§40, web/src/stats/data.ts). TZ is UTC here (vitest.config.ts).

import { describe, expect, it } from "vitest";
import { lastDays, midnight, niceMax, peak, personHours, runs, type Sample } from "../../web/src/stats/data.ts";

const T = Date.parse("2026-11-09T15:00:00Z");
const MIN = 60_000;
const s = (t: number, online: number): Sample => [t, online, 0, online, 0];

describe("stats figures (§40)", () => {
  it("person-hours: each sample stands for its 5 minutes", () => {
    const samples = [s(T - 20 * MIN, 9), s(T - 10 * MIN, 6), s(T - 5 * MIN, 6)];
    expect(personHours(samples, T - 15 * MIN, 5)).toBe(1);
    expect(personHours([], T, 5)).toBe(0);
  });

  it("peak: the most at once since then, the first time reached", () => {
    const samples = [s(T - 30 * MIN, 9), s(T - 20 * MIN, 4), s(T - 10 * MIN, 7), s(T - 5 * MIN, 7)];
    expect(peak(samples, T - 25 * MIN)).toEqual({ online: 7, at: T - 10 * MIN });
    expect(peak(samples, T)).toBeNull();
    // A peak of nobody: no time (QA BUG-263).
    expect(peak([s(T - 10 * MIN, 0), s(T - 5 * MIN, 0)], T - 20 * MIN)).toEqual({ online: 0, at: 0 });
  });

  it("runs: a gap longer than two intervals breaks the line", () => {
    const samples = [s(T - 60 * MIN, 1), s(T - 55 * MIN, 1), s(T - 20 * MIN, 2), s(T - 15 * MIN, 2), s(T - 10 * MIN, 2)];
    expect(runs(samples, 0, 5).map((r) => r.length)).toEqual([2, 3]);
    expect(runs(samples, T - 30 * MIN, 5).map((r) => r.length)).toEqual([3]);
  });

  it("the last 30 days, oldest first, a day without messages as none", () => {
    const days = lastDays(
      [
        { day: "2026-11-09", messages: 5, people: 2 },
        { day: "2026-10-01", messages: 1, people: 1 },
      ],
      T,
    );
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ day: "2026-10-11", messages: 0, people: 0 });
    expect(days.at(-1)).toEqual({ day: "2026-11-09", messages: 5, people: 2 });
    expect(midnight(T, 1)).toBe(Date.parse("2026-11-08T00:00:00Z"));
  });

  it("an axis top is a tidy number at least the most", () => {
    expect([0, 3, 7, 11, 23, 180, 501].map((v) => niceMax(v))).toEqual([5, 5, 10, 20, 50, 200, 1000]);
  });
});
