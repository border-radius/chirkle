#!/usr/bin/env node
// `npm start` / `npx chirkle`: run the production server. In a source checkout it builds web/ → pb_public/ first;
// the npm package ships pb_public/ built. PocketBase (pinned, checksum-verified) is downloaded on the first run.
//
//   chirkle                          serve on http://127.0.0.1:8090 (HOST, PORT), data in ./pb_data (CHIRKLE_DATA)
//   chirkle chat.example.com         serve with HTTPS (Let's Encrypt) on :80/:443; any other `pocketbase serve` flags
//   chirkle superuser upsert <email> <password>
//                                    the other PocketBase commands, on the same data directory

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (process.platform === "win32") fail('Windows is not supported: run it in WSL, or use the Docker image (README "Deploying")');

/** @param {string} cmd @param {string[]} argv @param {import("node:child_process").SpawnSyncOptions} opts */
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", ...opts });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
};

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`chirkle: ${message}`);
  process.exit(1);
}

// ---- the frontend ----
if (existsSync(join(ROOT, "web")) && existsSync(join(ROOT, "node_modules/esbuild"))) {
  run(process.execPath, ["scripts/build.mjs"], { cwd: ROOT });
} else if (!existsSync(join(ROOT, "pb_public/index.html"))) {
  fail("pb_public/ is not built: run `npm install` (with dev dependencies) first");
}

// ---- PocketBase: next to the package when it can write there (a checkout, a local install), else in the cache ----
let binDir = join(ROOT, "bin");
try {
  mkdirSync(binDir, { recursive: true });
  accessSync(binDir, constants.W_OK);
} catch {
  binDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "chirkle");
}
run("sh", [join(ROOT, "scripts/fetch-pocketbase.sh")], {
  env: { ...process.env, PB_BIN_DIR: binDir },
  stdio: ["inherit", "ignore", "inherit"],
});

// ---- run it ----
/** @param {string[]} argv */
const exec = (argv) => {
  const pb = spawn(join(binDir, "pocketbase"), argv, { stdio: "inherit" });
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) process.on(signal, () => pb.kill(signal));
  pb.on("error", (err) => fail(err.message));
  pb.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
};
if (["--version", "-v", "--help", "-h", "help"].includes(args[0] ?? "")) {
  exec(args);
} else {
  serve();
}

function serve() {
  /** @param {string} flag */
  const has = (flag) => args.some((a) => a === flag || a.startsWith(`${flag}=`));
  const dataDir = resolve(process.env.CHIRKLE_DATA || "pb_data");
  const command = args[0] && !args[0].startsWith("-") && !args[0].includes(".") ? args[0] : "serve";
  const rest = command === "serve" && args[0] !== "serve" ? args : args.slice(1);
  /** @type {Record<string, string>} */
  const defaults = {
    "--dir": dataDir,
    "--migrationsDir": join(ROOT, "pb_migrations"),
    "--hooksDir": join(ROOT, "pb_hooks"),
  };
  if (command === "serve") {
    // With a domain (or --https) PocketBase picks :80/:443 itself.
    if (!has("--https") && !rest.some((a) => !a.startsWith("-"))) {
      defaults["--http"] = `${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "8090"}`;
    }
    defaults["--publicDir"] = join(ROOT, "pb_public");
    // PocketBase enriches a page of messages in parallel, one JS hook call each (as in the Dockerfile).
    defaults["--hooksPool"] = "100";
  }
  const flags = Object.entries(defaults)
    .filter(([flag]) => !has(flag))
    .map(([flag, value]) => `${flag}=${value}`);
  exec([command, ...flags, ...rest]);
}
