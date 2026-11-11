#!/usr/bin/env node
// Build the Chirkle server (server/: PocketBase with the hot paths in Go, docs/REFACTOR.md item 47) with Go.
//
//   node scripts/build-server.mjs          bin/chirkle-server for this machine (`npm run setup`); a no-op while it is
//                                          newer than every file in server/
//   node scripts/build-server.mjs --all    bin/release/<os>-<arch>/chirkle-server for every platform the npm package
//                                          ships (prepack)
//
// Pure Go (PocketBase's SQLite is), so CGO is off and any machine builds every platform.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server");
/** @type {[string, string][]} What the npm package runs on (package.json "os" and "cpu"). */
const TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
];

/** @param {string} out @param {Record<string, string>} env */
function build(out, env = {}) {
  console.log(`building ${out.slice(ROOT.length + 1)}`);
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const r = spawnSync("go", ["build", "-trimpath", `-ldflags=-s -w -X main.version=${version}`, "-o", out, "."], {
    cwd: SERVER,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", ...env },
  });
  if (r.error) {
    console.error(`chirkle: Go is needed to build the server (server/, go.mod names the version): ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** The newest modification time of the server's sources. */
const newestSource = () =>
  Math.max(
    ...readdirSync(SERVER)
      .filter((f) => /\.go$|^go\.(mod|sum)$/.test(f) && !f.endsWith("_test.go"))
      .map((f) => statSync(join(SERVER, f)).mtimeMs),
  );

if (process.argv.includes("--all")) {
  for (const [os, arch] of TARGETS) build(join(ROOT, "bin/release", `${os}-${arch}`, "chirkle-server"), { GOOS: os, GOARCH: arch });
} else {
  const out = join(ROOT, "bin/chirkle-server");
  if (existsSync(out) && statSync(out).mtimeMs >= newestSource()) {
    console.log("bin/chirkle-server is up to date");
  } else {
    build(out);
  }
}
