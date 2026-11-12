import { defineConfig, devices } from "@playwright/test";
import { LOCAL, localWorkers } from "./tests/support/low-priority.ts";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  // Locally a quarter of the cores (2 of 8): each worker is a Chromium and a server, all at low priority
  // (tests/support/low-priority.ts). CI keeps Playwright's default.
  ...(LOCAL ? { workers: localWorkers(0.25) } : {}),
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Builds, then starts one server per worker on E2E_PORT (default 8091) + the worker's slot; fixtures.ts points each
  // worker's baseURL at its own (tests/e2e/paths.ts, docs/REFACTOR.md item 62). E2E_SKIP_BUILD=1 skips the build.
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    trace: "retain-on-failure",
    // The service worker fetches hashed assets itself, out of reach of page.route(); pwa.spec.ts allows it (§27).
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    ...(CI
      ? [
          { name: "firefox", use: { ...devices["Desktop Firefox"] } },
          { name: "webkit", use: { ...devices["Desktop Safari"] } },
        ]
      : []),
  ],
});
