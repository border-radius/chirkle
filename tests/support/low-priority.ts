// Tests run in the background of someone's desktop: with every core busy (Chromium per worker, a server per worker,
// Vitest workers, ffmpeg) the machine was barely usable. The configs (playwright.config.ts, vitest.config.ts) import
// this first. It lowers this process's CPU priority to the lowest (nice 19). Every child process inherits that, so the
// test runs still use idle CPU at full speed but yield as soon as anything else wants it. It also gives each test run
// fewer workers than the runners' defaults. CI keeps both defaults. TEST_NICE=0 opts out; --workers / --maxWorkers
// still override the counts.
import { availableParallelism, constants, setPriority } from "node:os";

export const LOCAL = !process.env.CI;

if (LOCAL && process.env.TEST_NICE !== "0") {
  try {
    setPriority(constants.priority.PRIORITY_LOW);
  } catch {
    // not allowed here (some containers): run at normal priority
  }
}

/** Workers for a local run: `share` of the cores (at least one). The configs use it only when LOCAL. */
export const localWorkers = (share: number): number => Math.max(1, Math.floor(availableParallelism() * share));
