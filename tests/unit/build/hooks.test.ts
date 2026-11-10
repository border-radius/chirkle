import { describe, expect, it } from "vitest";

// The unit project runs in happy-dom, where Vite refuses static imports of Node built-ins.
const { readdirSync, readFileSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
const { join, resolve } = process.getBuiltinModule("node:path") as typeof import("node:path");

const hooks = resolve(import.meta.dirname, "../../../pb_hooks");

/** Every .js file under pb_hooks/, with its source. */
function sources(dir = hooks): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d): [string, string][] => {
    const path = join(dir, d.name);
    if (d.isDirectory()) return sources(path);
    return d.name.endsWith(".js") ? [[path.slice(hooks.length + 1), readFileSync(path, "utf8")]] : [];
  });
}

describe("server hooks (docs/PERF.md §6)", () => {
  it("add no router middleware with a JS handler: it would hold a JS runtime for every request, realtime connections too", () => {
    for (const [file, src] of sources()) {
      // Code only: a comment may name it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/\brouterUse\(([^)]*)/g)) {
        // PocketBase's own middlewares ($apis.…) run in Go.
        expect(m[1]!.trim().startsWith("$apis."), `${file}: routerUse(${m[1]}`).toBe(true);
      }
    }
  });
});
