// PocketBase runs pb_migrations/*.js in file-name order and records each by its file name (REFACTOR.md item 48). Two
// migrations with one numeric prefix run in the order of the rest of their names, which is only safe while they don't
// touch the same collection: a merge of two branches that both took the next number is caught here instead.

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Already shipped under one prefix (they touch different collections). Renaming either would make PocketBase run it
// again on every database that has it, so they stay; nothing may join them.
const SHIPPED_TWINS = new Set(["1760000045_mentions.js", "1760000045_password_reset.js"]);

const files = readdirSync("pb_migrations").filter((f) => f.endsWith(".js"));

describe("migrations", () => {
  it("are named <number>_<name>.js", () => {
    expect(files.filter((f) => !/^\d+_[a-z0-9_]+\.js$/.test(f))).toEqual([]);
  });

  it("each have their own numeric prefix", () => {
    const byPrefix = new Map<string, string[]>();
    for (const f of files) {
      const prefix = f.split("_")[0]!;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
    }
    const shared = [...byPrefix.values()].filter((names) => names.length > 1).flat();
    expect(shared.filter((f) => !SHIPPED_TWINS.has(f))).toEqual([]);
    // Both twins are still there, so the exception can't outlive them unnoticed.
    expect(shared.filter((f) => SHIPPED_TWINS.has(f)).sort()).toEqual([...SHIPPED_TWINS].sort());
  });
});
