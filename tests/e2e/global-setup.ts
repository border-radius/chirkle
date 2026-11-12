// Playwright global setup: builds pb_public/ (unless E2E_SKIP_BUILD), then serves it from one fresh server per worker
// (paths.ts, docs/REFACTOR.md item 62). Each worker's tests see only that worker's rooms and users: with one shared
// server every user saw every parallel test's public rooms, refetched the unread counts and prefetched those rooms on
// each one made, and another test's new room could outrank the one a test had just left (the switcher flake, BUG-268).
// The data dirs are predictable (fixtures.ts seed() writes straight into SQLite).
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { FullConfig } from "@playwright/test";
import { disableRateLimits, startPocketBase } from "../support/pocketbase.ts";
import { e2eDataDir, e2ePort } from "./paths.ts";

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  // Set when pb_public/ is already a fresh production build (CI's e2e jobs build just before).
  if (!process.env.E2E_SKIP_BUILD) execFileSync("npm", ["run", "build"], { stdio: "inherit" });

  const ports = Array.from({ length: Math.max(1, config.workers) }, (_, slot) => e2ePort(slot));
  const started = await Promise.allSettled(
    ports.map(async (port) => {
      const dataDir = e2eDataDir(port);
      await rm(dataDir, { recursive: true, force: true });
      const pb = await startPocketBase({
        publicDir: resolve("pb_public"),
        port,
        dataDir,
        verbose: process.env.PB_VERBOSE === "1",
        fixtureRoute: true,
      });
      await disableRateLimits(pb.url); // all of a worker's users sign up from 127.0.0.1
      return pb;
    }),
  );
  const servers = started.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  const failed = started.find((s) => s.status === "rejected");
  if (failed) {
    await Promise.all(servers.map((pb) => pb.stop()));
    throw failed.reason;
  }
  console.log(`e2e: ${servers.length} server(s) on ports ${ports[0]}–${ports.at(-1)}`);

  return async () => {
    await Promise.all(
      servers.map(async (pb) => {
        await pb.stop();
        await rm(pb.dataDir, { recursive: true, force: true });
      }),
    );
  };
}
