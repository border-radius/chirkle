#!/usr/bin/env node
// Build the XMPP bridge's child (xmpp-bridge/, DESIGN.md §38.9) into bin/xmpp-bridge/<os>-<arch>: for this machine,
// or with --all for every platform the package runs on. Needs Go (the version xmpp-bridge/go.mod names).
//
//   node scripts/build-xmpp.mjs [--all]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "xmpp-bridge");
const VERSION = (await import(join(ROOT, "package.json"), { with: { type: "json" } })).default.version;

/** Go's names for Node's platform and architecture, or null where the package doesn't run. */
export function target(platform = process.platform, arch = process.arch) {
  const os = /** @type {Record<string, string>} */ ({ linux: "linux", darwin: "darwin" })[platform];
  const cpu = /** @type {Record<string, string>} */ ({ x64: "amd64", arm64: "arm64" })[arch];
  return os && cpu ? `${os}-${cpu}` : null;
}

/** Where this machine's child is, built or shipped: "" when there is none. */
export function binary(root = ROOT) {
  const t = target();
  const path = t ? join(root, "bin", "xmpp-bridge", t) : "";
  return path && existsSync(path) ? path : "";
}

/** @param {string} t "linux-amd64" */
function build(t) {
  const [goos, goarch] = t.split("-");
  const out = join(ROOT, "bin", "xmpp-bridge", t);
  const r = spawnSync("go", ["build", "-trimpath", `-ldflags=-s -w -X main.version=${VERSION}`, "-o", out, "."], {
    cwd: SRC,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`built ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = process.argv.includes("--all");
  const targets = all ? ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"] : [target()];
  if (targets.includes(null)) {
    console.error(`build-xmpp: ${process.platform}-${process.arch} isn't a platform the bridge is built for`);
    process.exit(1);
  }
  for (const t of /** @type {string[]} */ (targets)) build(t);
}
