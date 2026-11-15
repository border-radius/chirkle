#!/usr/bin/env node
// `npm run doctor`: is this machine ready to run the tests (docs/REFACTOR.md item 57)? Many "flakes" in the QA notes
// were the environment: a browser with no fonts (draws no text, keeps no input values: every login fails), a full
// TMPDIR, a stale server from an interrupted run still holding a port, a missing ffmpeg or versitygw silently skipping
// tests. Each check prints what is wrong and how to fix it.
//
//   npm run doctor                         every check, Chromium only
//   npm run doctor -- --browsers=chromium,firefox,webkit
//
// The Playwright global setup (tests/e2e/global-setup.ts) runs it with its own browsers and ports, and stops on a
// failure ("fail"); a warning ("warn") only says which tests will be skipped.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statfsSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Below this much free space in TMPDIR a run fails part way (each e2e worker's server, traces, builds). */
const MIN_TMP_BYTES = 1024 ** 3;
const LOW_TMP_BYTES = 4 * 1024 ** 3;
const FONTS_FIX = "install a font (e.g. fonts-dejavu-core), or point FONTCONFIG_FILE at a fonts.conf that has one";

/** @typedef {{ level: "ok" | "warn" | "fail", name: string, detail: string, fix?: string }} Finding */

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return r.error || r.status !== 0 ? null : `${r.stdout}${r.stderr}`;
}

/** @param {string} v "1.27" or "1.27.3" @returns {number[]} */
const parts = (v) => v.split(".").map(Number);
/** @param {number[]} a @param {number[]} b */
const atLeast = (a, b) => {
  for (let i = 0; i < b.length; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

/** @returns {Finding} */
function checkNode() {
  const want = /** @type {string} */ (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).engines.node).replace(/[^\d.]/g, "");
  const have = process.versions.node;
  return atLeast(parts(have), parts(want))
    ? { level: "ok", name: "node", detail: have }
    : { level: "fail", name: "node", detail: `${have}, package.json wants ${want} or newer`, fix: "install a newer Node" };
}

/** @returns {Finding[]} */
function checkServer() {
  const want = /^go (\S+)$/m.exec(readFileSync(join(ROOT, "server/go.mod"), "utf8"))?.[1] ?? "0";
  const out = run("go", ["version"]);
  const have = out && /go(\d+(?:\.\d+)*)/.exec(out)?.[1];
  /** @type {Finding[]} */
  const found = [];
  if (!have) {
    found.push({
      level: "fail",
      name: "go",
      detail: "not on the PATH",
      fix: `install Go ${want} (server/go.mod): it builds bin/chirkle-server`,
    });
  } else if (!atLeast(parts(have), parts(want))) {
    found.push({ level: "fail", name: "go", detail: `${have}, server/go.mod wants ${want}`, fix: `install Go ${want} or newer` });
  } else {
    found.push({ level: "ok", name: "go", detail: have });
  }

  const bin = join(ROOT, "bin/chirkle-server");
  if (!existsSync(bin)) {
    found.push({ level: "fail", name: "server", detail: "bin/chirkle-server is missing", fix: "npm run setup" });
    return found;
  }
  const server = join(ROOT, "server");
  const newest = Math.max(
    ...readdirSync(server)
      .filter((f) => /\.go$|^go\.(mod|sum)$/.test(f) && !f.endsWith("_test.go"))
      .map((f) => statSync(join(server, f)).mtimeMs),
  );
  const version = run(bin, ["--version"])?.trim();
  if (statSync(bin).mtimeMs < newest) {
    found.push({
      level: "warn",
      name: "server",
      detail: "bin/chirkle-server is older than server/",
      fix: "npm run setup (the test runs rebuild it too)",
    });
  } else {
    found.push({ level: "ok", name: "server", detail: version ?? "bin/chirkle-server" });
  }
  return found;
}

/** A tool some tests need: without it they are skipped locally (and fail in CI). @returns {Finding} */
function checkTool(/** @type {string} */ name, /** @type {string} */ env, /** @type {string[]} */ args, /** @type {string} */ skipped) {
  const cmd = process.env[env] || name;
  const out = run(cmd, args);
  if (out === null)
    return { level: "warn", name, detail: `not found (${env} or the PATH): ${skipped} are skipped`, fix: `install ${name}, or set ${env}` };
  return { level: "ok", name, detail: out.split("\n")[0]?.trim().slice(0, 60) ?? cmd };
}

/** @returns {Finding} */
function checkTmp() {
  const dir = tmpdir();
  let free;
  try {
    const s = statfsSync(dir);
    free = s.bavail * s.bsize;
  } catch (err) {
    return {
      level: "fail",
      name: "tmp",
      detail: `${dir}: ${/** @type {Error} */ (err).message}`,
      fix: "set TMPDIR to a writable directory",
    };
  }
  const gb = `${(free / 1024 ** 3).toFixed(1)} GB free in ${dir}`;
  if (free < MIN_TMP_BYTES)
    return {
      level: "fail",
      name: "tmp",
      detail: gb,
      fix: "free space there, or set TMPDIR elsewhere (old chirkle-* dirs are safe to remove)",
    };
  if (free < LOW_TMP_BYTES) return { level: "warn", name: "tmp", detail: gb, fix: "a full e2e run with traces may run out" };
  return { level: "ok", name: "tmp", detail: gb };
}

/** Servers left running by an interrupted test run (Linux: read from /proc). @returns {Finding} */
function checkStray() {
  if (!existsSync("/proc/self/cmdline")) return { level: "ok", name: "stray servers", detail: "not checked (no /proc)" };
  const stray = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let argv;
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue; // gone, or not ours
    }
    const exe = argv[0]?.split("/").pop();
    if ((exe === "chirkle-server" || exe === "pocketbase") && argv.includes("serve") && argv.some((a) => a.includes("chirkle-"))) {
      const http = argv.find((a) => a.startsWith("--http="))?.slice(7) ?? argv[argv.indexOf("--http") + 1] ?? "?";
      stray.push(`${pid} (${http})`);
    }
  }
  return stray.length
    ? {
        level: "warn",
        name: "stray servers",
        detail: `test servers still running: ${stray.join(", ")}`,
        fix: `kill ${stray.map((s) => s.split(" ")[0]).join(" ")} (unless a test run is going on)`,
      }
    : { level: "ok", name: "stray servers", detail: "none" };
}

/** @param {number} port @returns {Promise<boolean>} */
const portFree = (port) =>
  new Promise((done) => {
    const s = createServer();
    s.once("error", () => done(false));
    s.listen(port, "127.0.0.1", () => s.close(() => done(true)));
  });

/** @param {number[]} ports @returns {Promise<Finding>} */
async function checkPorts(ports) {
  const busy = [];
  for (const p of ports) if (!(await portFree(p))) busy.push(p);
  const range = ports.length > 1 ? `${ports[0]}–${ports.at(-1)}` : `${ports[0]}`;
  return busy.length
    ? {
        level: "fail",
        name: "ports",
        detail: `in use: ${busy.join(", ")}`,
        fix: "stop what holds them (a stray server above?), or set E2E_PORT to another first port",
      }
    : { level: "ok", name: "ports", detail: `${range} free` };
}

/**
 * Launches the browser and types into a page: catches a browser that isn't installed, misses its system libraries, or
 * has no fonts (it then draws no text and an <input> keeps no value).
 * @param {string} name @returns {Promise<Finding>}
 */
async function checkBrowser(name) {
  const label = `browser: ${name}`;
  /** @type {Record<string, import("playwright-core").BrowserType>} */
  const types = await import("playwright-core").then((pw) => ({ chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit }));
  const type = types[name];
  if (!type) return { level: "fail", name: label, detail: "unknown browser" };
  // Without fonts Chromium aborts (Skia's font manager) on the first page, and Playwright only says it closed.
  const conf = process.env.FONTCONFIG_FILE;
  const noFonts = { level: /** @type {const} */ ("fail"), name: label, detail: "", fix: FONTS_FIX };
  if (conf && !existsSync(conf)) return { ...noFonts, detail: `FONTCONFIG_FILE names a missing file (${conf})` };
  let browser;
  try {
    browser = await type.launch({ timeout: 30_000 });
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    const missing = /Executable doesn't exist|npx playwright install/.test(msg);
    // A missing system library is in the browser's stderr, quoted in the message; the first line only says it closed.
    const lib = /error while loading shared libraries: ([^:\s]+)/.exec(msg)?.[1];
    return {
      level: "fail",
      name: label,
      detail: missing
        ? "not installed"
        : lib
          ? `can't start: ${lib} is missing`
          : (msg.split("\n").find((l) => l.trim()) ?? msg).slice(0, 160),
      fix: missing
        ? `npx playwright install ${name}`
        : `npx playwright install --with-deps ${name} (or put its libraries on LD_LIBRARY_PATH)`,
    };
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="i"><span id="s">Chirkle</span>');
    await page.fill("#i", "doctor");
    const value = await page.inputValue("#i");
    const width = await page.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("s")).getBoundingClientRect().width);
    if (value !== "doctor" || width === 0) {
      return {
        level: "fail",
        name: label,
        detail: `no fonts: text is ${width}px wide, the input kept "${value}"`,
        fix: FONTS_FIX,
      };
    }
    return { level: "ok", name: label, detail: browser.version() };
  } catch (err) {
    const msg = /** @type {Error} */ (err).message;
    if (/has been closed|crashed/.test(msg)) return { ...noFonts, detail: "crashed on its first page (on Linux, most often: no fonts)" };
    return { level: "fail", name: label, detail: msg.split("\n")[0] ?? "" };
  } finally {
    await browser.close();
  }
}

/**
 * Every check, in order.
 * @param {{ browsers?: string[], ports?: number[], tools?: boolean }} [opts] `tools: false` leaves out what only some
 * tests need (ffmpeg, versitygw).
 * @returns {Promise<Finding[]>}
 */
export async function doctor({ browsers = ["chromium"], ports = [Number(process.env.E2E_PORT ?? 8091)], tools = true } = {}) {
  const found = [checkNode(), ...checkServer(), checkTmp(), checkStray(), await checkPorts(ports)];
  if (tools) {
    found.push(
      checkTool("ffmpeg", "FFMPEG", ["-version"], "video poster tests (media, attachments)"),
      checkTool("versitygw", "VERSITYGW", ["--version"], "S3 tests (media.s3)"),
    );
  }
  for (const b of browsers) found.push(await checkBrowser(b));
  return found;
}

/** @param {Finding[]} found */
export function report(found) {
  const mark = { ok: "✓", warn: "!", fail: "✗" };
  return found
    .map((f) => `${mark[f.level]} ${f.name.padEnd(17)} ${f.detail}${f.fix && f.level !== "ok" ? `\n  ${"".padEnd(17)} → ${f.fix}` : ""}`)
    .join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find((a) => a.startsWith("--browsers="));
  const browsers = arg ? arg.slice("--browsers=".length).split(",").filter(Boolean) : undefined;
  const found = await doctor(browsers ? { browsers } : {});
  console.log(report(found));
  const fails = found.filter((f) => f.level === "fail").length;
  const warns = found.filter((f) => f.level === "warn").length;
  console.log(fails ? `\n${fails} problem(s) to fix first.` : warns ? `\nReady; ${warns} warning(s).` : "\nReady.");
  process.exit(fails ? 1 : 0);
}
