import { describe, expect, it } from "vitest";
import { SIZE_KEY, THEME_KEY } from "../../../web/src/theme.ts";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const { resolve } = process.getBuiltinModule("node:path") as typeof import("node:path");
const { createHash } = process.getBuiltinModule("node:crypto") as typeof import("node:crypto");

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "../../..", path), "utf8");

describe("index.html's inline theme and text size script (§7.8)", () => {
  const html = read("web/index.html");
  const scripts = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map((m) => m[1]!);

  it("is the only inline script, and the CSP allows it by its hash", () => {
    expect(scripts).toHaveLength(1);
    const hash = createHash("sha256").update(scripts[0]!).digest("base64");
    expect(read("pb_hooks/lib/http.js")).toContain(`'sha256-${hash}'`);
  });

  it("reads the keys theme.ts saves, before the stylesheet", () => {
    expect(scripts[0]).toContain(`"${THEME_KEY}"`);
    expect(scripts[0]).toContain(`"${SIZE_KEY}"`);
    expect(html.indexOf("<script>")).toBeLessThan(html.indexOf("<!--CSS-->"));
  });
});
