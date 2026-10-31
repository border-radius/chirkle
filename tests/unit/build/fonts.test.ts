import { describe, expect, it } from "vitest";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { readFileSync, readdirSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const { resolve } = process.getBuiltinModule("node:path") as typeof import("node:path");

const styles = resolve(import.meta.dirname, "../../../web/styles");
const sheets = [
  ...readdirSync(styles).filter((f) => f.endsWith(".css")),
  ...readdirSync(resolve(styles, "app")).map((f) => `app/${f}`),
].map((f) => ({ f, css: readFileSync(resolve(styles, f), "utf8") }));

describe("Inter (§7.7)", () => {
  it("draws people's text as typed: no contextual alternates (QA BUG-191: 32x1n as 32×1n, -> as an arrow)", () => {
    const tokens = sheets.find((s) => s.f === "app/tokens.css")!.css;
    const root = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("}", tokens.indexOf(":root {")));
    expect(root).toMatch(/font-feature-settings:\s*"calt" 0;/);
    // Nothing turns them back on, and nothing replaces the setting (font-feature-settings isn't additive).
    for (const { f, css } of sheets) {
      const others = [...css.matchAll(/font-feature-settings:[^;]+;/g)].map((m) => m[0]);
      expect(others, f).toEqual(f === "app/tokens.css" ? ['font-feature-settings: "calt" 0;'] : []);
    }
  });
});
