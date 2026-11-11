import { describe, expect, it } from "vitest";
import { BUDGET, checkBudget, FEATURES, formatSizes } from "../../../scripts/lib/build-utils.mjs";

const sizes = (over: Partial<Parameters<typeof checkBudget>[0]> = {}) => ({
  critical: 1000,
  files: { "index.html": 100, "assets/app-AB12.js": 700, "assets/app-CD34.css": 200 },
  features: { viewer: 500, emoji: 900 },
  stats: 300,
  ...over,
});

describe("checkBudget (DESIGN.md §7.7)", () => {
  it("matches the design doc budget", () => {
    expect(BUDGET).toEqual({ critical: 62.5 * 1024, feature: 16 * 1024, stats: 10 * 1024 });
  });

  it("names every lazy feature the build has", () => {
    expect(Object.keys(FEATURES)).toEqual([
      "viewer",
      "search",
      "access",
      "media",
      "collections",
      "notify",
      "emoji",
      "inbox",
      "mention",
      "profile",
      "login",
      "forward",
      "people",
      "jump",
    ]);
  });

  it("returns no violations when everything is under budget, or exactly at it", () => {
    expect(checkBudget(sizes())).toEqual([]);
    expect(checkBudget(sizes({ critical: BUDGET.critical, features: { emoji: BUDGET.feature }, stats: BUDGET.stats }))).toEqual([]);
  });

  it("names what is over: the critical path as a whole, each feature, the stats page", () => {
    expect(
      checkBudget(sizes({ critical: BUDGET.critical + 1, features: { viewer: 10, emoji: BUDGET.feature + 1 }, stats: BUDGET.stats + 1 })),
    ).toEqual(["critical", "feature emoji", "stats"]);
  });
});

describe("formatSizes", () => {
  it("prints the critical path with its files, each feature and the stats page, and flags violations", () => {
    const out = formatSizes(sizes({ critical: 70 * 1024, features: { viewer: 1024, emoji: 20 * 1024 } }));
    expect(out).toMatch(/^critical path\s+70\.00 KB \/ 62\.50 KB\s+OVER$/m);
    expect(out).toMatch(/^ {2}assets\/app-AB12\.js\s+0\.68 KB$/m);
    expect(out).toMatch(/^ {2}viewer\s+1\.00 KB$/m);
    expect(out).toMatch(/^ {2}emoji\s+20\.00 KB {2}OVER$/m);
    expect(out).toMatch(/^stats page\s+0\.29 KB \/ 10\.00 KB$/m);
  });
});
