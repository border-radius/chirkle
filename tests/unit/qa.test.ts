// docs/QA.md's bug tables say where each fix went (docs/REFACTOR.md item 55): QA pass 20 found six app bugs that were
// web fixes never ported. From the first table with a "Fix in" column on, every table with a Severity column has one,
// and each row's value is `web`, `app`, `server` and `<web|app> n/a (why)`, comma-separated (or `n/a (why)`; `—` while
// not fixed). Naming one client means naming the other: fixed there too, or n/a with the reason.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Table {
  line: number;
  header: string[];
  rows: { line: number; cells: string[] }[];
}

const cellsOf = (row: string) =>
  row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(" | ")
    .map((c) => c.trim());

function tables(md: string): Table[] {
  const out: Table[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("| ") || !lines[i + 1]?.startsWith("|---")) continue;
    const t: Table = { line: i + 1, header: cellsOf(lines[i]!), rows: [] };
    for (i += 2; lines[i]?.startsWith("| "); i++) t.rows.push({ line: i + 1, cells: cellsOf(lines[i]!) });
    out.push(t);
  }
  return out;
}

const ENTRY = /^(web|app|server|(web |app )?n\/a \([^)]+\))$/;

/** What is wrong with a "Fix in" value, or "" when nothing is. */
function fixInProblem(value: string, status: string): string {
  if (value === "—") return /^fixed/i.test(status) ? "fixed, but says where as —" : "";
  if (value === "") return "empty";
  const entries = value.split(/,\s*(?![^()]*\))/).map((e) => e.trim());
  const bad = entries.find((e) => !ENTRY.test(e));
  if (bad) return `"${bad}" isn't web, app, server or "<web|app> n/a (why)"`;
  const has = (who: string) => entries.some((e) => e === who || e.startsWith(`${who} n/a`));
  if (has("web") !== has("app"))
    return `says nothing of the ${has("web") ? "app" : "web"}: add it, or "${has("web") ? "app" : "web"} n/a (why)"`;
  return "";
}

describe("docs/QA.md", () => {
  const all = tables(readFileSync("docs/QA.md", "utf8")).filter((t) => t.header.includes("Severity"));
  const first = all.findIndex((t) => t.header.includes("Fix in"));

  it("has bug tables with the Fix in column", () => {
    expect(first).toBeGreaterThanOrEqual(0);
  });

  it("says where each fix went, from the first table with the column on", () => {
    const problems: string[] = [];
    for (const t of all.slice(first)) {
      const at = t.header.indexOf("Fix in");
      const status = t.header.indexOf("Status");
      if (at < 0) {
        problems.push(`line ${t.line}: a bug table without a "Fix in" column`);
        continue;
      }
      for (const r of t.rows) {
        if (r.cells.length !== t.header.length) problems.push(`line ${r.line}: ${r.cells.length} cells, the header has ${t.header.length}`);
        const why = fixInProblem(r.cells[at] ?? "", r.cells[status] ?? "");
        if (why) problems.push(`line ${r.line} (${r.cells[0]}): Fix in ${why}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("checks the values as it says", () => {
    expect(fixInProblem("server", "Fixed")).toBe("");
    expect(fixInProblem("server, web, app", "Fixed")).toBe("");
    expect(fixInProblem("web, app n/a (no such screen, yet)", "Fixed")).toBe("");
    expect(fixInProblem("n/a (the test's own race)", "Fixed")).toBe("");
    expect(fixInProblem("—", "Reported")).toBe("");
    expect(fixInProblem("—", "Fixed")).toMatch(/fixed/);
    expect(fixInProblem("web", "Fixed")).toMatch(/nothing of the app/);
    expect(fixInProblem("server, app", "Fixed")).toMatch(/nothing of the web/);
    expect(fixInProblem("web, android", "Fixed")).toMatch(/"android" isn't/);
    expect(fixInProblem("web, app n/a", "Fixed")).toMatch(/isn't/);
  });
});
