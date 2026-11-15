#!/usr/bin/env node
// The failure rate of each quarantined test (docs/REFACTOR.md item 58), from a Playwright JSON report of a
// `--repeat-each` run:
//
//   npx playwright test --grep @flaky --repeat-each=20 --retries=0 --reporter=json   (PLAYWRIGHT_JSON_OUTPUT_FILE=flaky.json)
//   node scripts/flaky-report.mjs flaky.json              a Markdown table (CI appends it to the job's summary)
//
// A test is tagged `@flaky` (test("…", { tag: "@flaky" }, …)) when it fails now and then for a reason not yet fixed;
// the regular runs leave it out (playwright.config.ts). Its fix removes the tag, and the docs/QA.md entry gives the
// rate before and after. Exits 0 always: a failure here is the measurement, not a broken build.

import { readFileSync } from "node:fs";

/** @typedef {import("@playwright/test/reporter").JSONReportSuite} Suite */

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/flaky-report.mjs <playwright-report.json>");
  process.exit(2);
}
/** @type {import("@playwright/test/reporter").JSONReport} */
const report = JSON.parse(readFileSync(file, "utf8"));

/** @type {Map<string, { runs: number, failed: number }>} */
const rows = new Map();
/** @param {Suite} suite @param {string[]} path */
function walk(suite, path) {
  const here = suite.title && suite.title !== suite.file ? [...path, suite.title] : path;
  for (const spec of suite.specs) {
    for (const t of spec.tests) {
      if (t.status === "skipped") continue;
      const key = `${t.projectName} · ${spec.file}:${spec.line} ${[...here, spec.title].join(" › ")}`;
      const row = rows.get(key) ?? { runs: 0, failed: 0 };
      row.runs++;
      if (t.status !== "expected") row.failed++;
      rows.set(key, row);
    }
  }
  for (const s of suite.suites ?? []) walk(s, here);
}
for (const s of report.suites) walk(s, []);

if (rows.size === 0) {
  console.log("No test is tagged @flaky.");
} else {
  console.log("| Test | Failed | Rate |\n|---|---:|---:|");
  for (const [key, { runs, failed }] of [...rows].sort((a, b) => b[1].failed / b[1].runs - a[1].failed / a[1].runs)) {
    console.log(`| ${key.replaceAll("|", "\\|")} | ${failed} of ${runs} | ${Math.round((100 * failed) / runs)}% |`);
  }
}
