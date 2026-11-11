#!/usr/bin/env node
// `npm start` / `npx chirkle`: run the production server. In a source checkout it builds web/ → pb_public/ first;
// the npm package ships pb_public/ built. The server (server/: PocketBase with the hot paths in Go) is built with Go in a
// checkout (`npm run setup`), and ships built for each platform in the npm package (bin/release/).
//
//   chirkle                          serve on http://127.0.0.1:8090 (HOST, PORT), data in ./pb_data (CHIRKLE_DATA)
//   chirkle chat.example.com         serve with HTTPS (Let's Encrypt) on :80/:443; any other `pocketbase serve` flags
//   chirkle superuser upsert <email> <password>
//                                    the other PocketBase commands, on the same data directory

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

// ---- the server: built from server/ in a checkout, else the package's own for this platform ----
let bin = join(ROOT, "bin/chirkle-server");
if (existsSync(join(ROOT, "server/go.mod"))) {
  run(process.execPath, [join(ROOT, "scripts/build-server.mjs")], { stdio: ["inherit", "ignore", "inherit"] });
} else {
  const os = { linux: "linux", darwin: "darwin" }[/** @type {string} */ (process.platform)];
  const arch = { x64: "amd64", arm64: "arm64" }[/** @type {string} */ (process.arch)];
  bin = join(ROOT, "bin/release", `${os}-${arch}`, "chirkle-server");
  if (!os || !arch || !existsSync(bin)) fail(`no server built for ${process.platform}-${process.arch} in this package`);
}

// ---- run it ----
/** @param {string[]} argv */
const exec = (argv) => {
  const pb = spawn(bin, argv, { stdio: "inherit" });
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
    // JS hook runtimes kept warm (as in the Dockerfile): the records API's hooks run in them.
    defaults["--hooksPool"] = "100";
  }
  const flags = Object.entries(defaults)
    .filter(([flag]) => !has(flag))
    .map(([flag, value]) => `${flag}=${value}`);
  exec([command, ...flags, ...rest]);
}
