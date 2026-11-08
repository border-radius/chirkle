// Spawns a throwaway PocketBase process on a free port with its own temp data dir.
// Shared by the Vitest integration globalSetup and the Playwright webServer.
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SUPERUSER } from "./sql.ts";

const root = resolve(import.meta.dirname, "../..");
const bin = join(root, "bin/pocketbase");

export { SUPERUSER } from "./sql.ts";

export interface PocketBaseServer {
  url: string;
  dataDir: string;
  publicDir: string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Directory served as static files. Defaults to an empty dir inside the temp data dir. */
  publicDir?: string;
  port?: number;
  /** Reuse an existing data dir (kept on stop). Defaults to a fresh temp dir (removed on stop). */
  dataDir?: string;
  /** Pipe PocketBase stdout/stderr to this process (useful when debugging). */
  verbose?: boolean;
  /** Add the test-only POST /api/test/sql route (see runSql). */
  fixtureRoute?: boolean;
  /** Extra environment variables for the PocketBase process. */
  env?: Record<string, string>;
}

/**
 * A test-only route, added to a copy of pb_hooks (never to the repo's, so never deployed): superusers run fixture SQL
 * through PocketBase's own write connection. Writing to data.db from a second connection instead (another process)
 * can commit between a server transaction's read and its write, which then fails with "database is locked (517)" and
 * reaches the client as 400 "Failed to update record." (docs/REFACTOR.md item 30).
 */
const FIXTURE_ROUTE = `// Test-only (tests/support/pocketbase.ts): fixture SQL through the server's own write connection.
routerAdd(
  "POST",
  "/api/test/sql",
  (e) => {
    const { statements } = e.requestInfo().body;
    e.app.runInTransaction((tx) => {
      for (const s of statements) tx.db().newQuery(s.sql).bind(s.params || {}).execute();
    });
    return e.noContent(204);
  },
  $apis.requireSuperuserAuth(),
);

// The workers' lock (lib/worker.js), step by step: [{ op: "lock" | "beat" | "unlock" | "sleep" | "get", run, ms }].
// Each step's result in order; "lock" names the run by the handle it got.
routerAdd(
  "POST",
  "/api/test/worker-lock",
  (e) => {
    const w = require(\`\${__hooks}/lib/worker.js\`);
    const { name, staleMs, steps } = e.requestInfo().body;
    const runs = {};
    const out = [];
    for (const s of steps) {
      if (s.op === "lock") {
        runs[s.run] = w.lock(e.app, name, staleMs);
        out.push(runs[s.run] !== "");
      } else if (s.op === "beat") out.push(w.beat(e.app, name, runs[s.run]));
      else if (s.op === "unlock") out.push(w.unlock(e.app, name, runs[s.run]) ?? null);
      else if (s.op === "sleep") out.push(sleep(s.ms) ?? null);
      else if (s.op === "get") out.push(e.app.store().get(name) ? String(e.app.store().get(name)).split(" ")[0] === runs[s.run] : false);
    }
    return e.json(200, out);
  },
  $apis.requireSuperuserAuth(),
);
`;

/** A copy of pb_hooks with the fixture route added. */
async function hooksWithFixtureRoute(tmp: string): Promise<string> {
  const dir = join(tmp, "pb_hooks");
  await cp(join(root, "pb_hooks"), dir, { recursive: true });
  await writeFile(join(dir, "test_fixtures.pb.js"), FIXTURE_ROUTE);
  return dir;
}

export async function startPocketBase(opts: StartOptions = {}): Promise<PocketBaseServer> {
  const tmp = await mkdtemp(join(tmpdir(), "chirkle-pb-"));
  const dataDir = opts.dataDir ?? join(tmp, "pb_data");
  const publicDir = opts.publicDir ?? join(tmp, "pb_public");
  const hooksDir = opts.fixtureRoute ? await hooksWithFixtureRoute(tmp) : join(root, "pb_hooks");
  const dirArgs = [
    `--dir=${dataDir}`,
    `--migrationsDir=${join(root, "pb_migrations")}`,
    `--hooksDir=${hooksDir}`,
    // Never let tests write generated migrations into the repo.
    "--automigrate=false",
  ];

  await promisify(execFile)(bin, ["superuser", "upsert", SUPERUSER.email, SUPERUSER.password, ...dirArgs]);

  const port = opts.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  // --hooksPool as in the Dockerfile: room pages enrich their messages in parallel, and prefetching asks for many.
  const args = ["serve", `--http=127.0.0.1:${port}`, `--publicDir=${publicDir}`, "--hooksWatch=false", "--hooksPool=100", ...dirArgs];
  const proc = spawn(bin, args, {
    stdio: opts.verbose ? "inherit" : "pipe",
    // Never a Telegram or XMPP bot from the developer's own environment: only what a test passes (§26, §38). No link
    // previews either (§28), which would fetch whatever the tests link to, unless a test turns them on.
    env: { ...withoutBridges(process.env), LINK_PREVIEWS: "off", MEDIA_CRON: "off", ...opts.env },
  });

  let output = "";
  proc.stdout?.on("data", (d: Buffer) => (output += d));
  proc.stderr?.on("data", (d: Buffer) => (output += d));

  const stop = async () => {
    await kill(proc);
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    await waitForHealth(url, proc);
  } catch (err) {
    await stop();
    throw new Error(`${(err as Error).message}\n--- pocketbase output ---\n${output}`);
  }

  return { url, dataDir, publicDir, stop };
}

function withoutBridges(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(TELEGRAM_|XMPP_|CHIRKLE_XMPP_)/.test(k)));
}

export async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === "object" && addr ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

async function waitForHealth(url: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`pocketbase exited with code ${proc.exitCode}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`pocketbase did not become healthy within ${timeoutMs}ms`);
}

function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise((ok) => {
    const force = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    proc.once("exit", () => {
      clearTimeout(force);
      ok();
    });
    proc.kill("SIGTERM");
  });
}

export interface RateLimits {
  enabled: boolean;
  rules: { label: string; audience: string; duration: number; maxRequests: number }[];
}

/**
 * Turn off PocketBase's per-IP rate limits: every test client connects from 127.0.0.1, so limits meant for
 * real users would trip across unrelated tests. Returns the settings as the migrations left them.
 */
export async function disableRateLimits(url: string): Promise<RateLimits> {
  const { default: PocketBase } = await import("pocketbase");
  const admin = new PocketBase(url);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  const { rateLimits } = (await admin.settings.getAll()) as { rateLimits: RateLimits };
  await admin.settings.update({ rateLimits: { ...rateLimits, enabled: false } });
  return rateLimits;
}

/**
 * Turn linked instances on (DESIGN.md §33.2): the Application URL set to `appURL` (the server's own address by
 * default) and the site record's `federation` ticked. Over plain http on 127.0.0.1 it needs the server started with
 * FEDERATION_ALLOW_PRIVATE=1.
 */
export async function enableFederation(url: string, appURL = url): Promise<void> {
  const { default: PocketBase } = await import("pocketbase");
  const admin = new PocketBase(url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  await admin.settings.update({ meta: { appURL } });
  const site = await admin.collection("site").getFirstListItem("");
  await admin.collection("site").update(site.id, { federation: true });
}

/** Run `pocketbase migrate …` (e.g. `down 1`, `up`) on a stopped server's data dir, answering yes to its question. */
export function migrate(dataDir: string, ...args: string[]): void {
  execFileSync(
    bin,
    [
      "migrate",
      ...args,
      `--dir=${dataDir}`,
      `--migrationsDir=${join(root, "pb_migrations")}`,
      `--hooksDir=${join(root, "pb_hooks")}`,
      "--automigrate=false",
    ],
    { input: "y\n", stdio: "pipe" },
  );
}

/** Revert `file` (e.g. "1760000041_shared_files.js") and every migration after it, however many have been added since. */
export function migrateDownPast(dataDir: string, file: string): void {
  const count = readdirSync(join(root, "pb_migrations")).filter((f) => f.endsWith(".js") && f >= file).length;
  if (!count) throw new Error(`no migration ${file}`);
  migrate(dataDir, "down", String(count));
}
