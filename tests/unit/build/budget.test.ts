import { describe, expect, it } from "vitest";
import { BUDGET, checkBudget, formatSizes } from "../../../scripts/lib/build-utils.mjs";

describe("checkBudget", () => {
  it("matches the design doc budget (§7.7)", () => {
    expect(BUDGET).toEqual({
      js: 49.75 * 1024,
      css: 11.05 * 1024,
      html: 1536,
      viewerJs: 4 * 1024,
      viewerCss: 1.5 * 1024,
      searchJs: 2 * 1024,
      accessJs: 3.1 * 1024,
      accessCss: 1.5 * 1024,
      mediaJs: 3 * 1024,
      mediaCss: 1024,
      collJs: 6.75 * 1024,
      collCss: 2 * 1024,
      notifyJs: 3 * 1024,
      emojiJs: 4.25 * 1024,
    });
  });

  it("returns no violations when every asset is under budget", () => {
    expect(
      checkBudget({
        js: 1000,
        css: 500,
        html: 300,
        viewerJs: 1000,
        viewerCss: 500,
        searchJs: 1000,
        accessJs: 1000,
        accessCss: 500,
        mediaJs: 1000,
        mediaCss: 500,
        collJs: 1000,
        collCss: 500,
        notifyJs: 1000,
        emojiJs: 1000,
      }),
    ).toEqual([]);
  });

  it("allows an asset exactly at its budget", () => {
    expect(checkBudget({ ...BUDGET })).toEqual([]);
  });

  it("names every asset over budget", () => {
    expect(
      checkBudget({
        js: BUDGET.js + 1,
        css: 10,
        html: BUDGET.html + 1,
        viewerJs: 10,
        viewerCss: BUDGET.viewerCss + 1,
        searchJs: 10,
        accessJs: 10,
        accessCss: 10,
        mediaJs: 10,
        mediaCss: 10,
        collJs: 10,
        collCss: BUDGET.collCss + 1,
        notifyJs: 10,
        emojiJs: 10,
      }),
    ).toEqual(["js", "html", "viewerCss", "collCss"]);
  });
});

describe("formatSizes", () => {
  it("prints gzipped KB against the budget and flags violations", () => {
    const out = formatSizes({
      js: 2048,
      css: 12 * 1024,
      html: 512,
      viewerJs: 1024,
      viewerCss: 512,
      searchJs: 1024,
      accessJs: 1024,
      accessCss: 512,
      mediaJs: 1024,
      mediaCss: 512,
      collJs: 1024,
      collCss: 512,
      notifyJs: 1024,
      emojiJs: 1024,
    });
    expect(out).toContain("js          2.00 KB / 49.75 KB");
    expect(out).toContain("viewerJs    1.00 KB / 4.00 KB");
    expect(out).toMatch(/css\s+12\.00 KB \/ 11\.05 KB\s+OVER/);
    expect(out).not.toMatch(/js .*OVER/);
  });
});
