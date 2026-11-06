import { defineConfig } from "vitest/config";

// unit: no server. component (the client against the server, in happy-dom) and integration (the server's API and hooks)
// run against a real, throwaway PocketBase (temp data dir) started by tests/support/global-setup.ts.
const globalSetup = ["tests/support/global-setup.ts"];
// What the build defines (scripts/lib/build-utils.mjs).
const define = {
  VIEWER_CSS: JSON.stringify("/assets/viewer.css"),
  MEDIA_CSS: JSON.stringify("/assets/media.css"),
  COLLECTIONS_CSS: JSON.stringify("/assets/collections.css"),
  ACCESS_CSS: JSON.stringify("/assets/access.css"),
  EMOJI_CSS: JSON.stringify("/assets/emoji.css"),
};

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["web/src/**/*.ts"],
      reporter: ["text-summary", "text"],
    },
    projects: [
      {
        define,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "happy-dom",
          env: { TZ: "UTC" },
        },
      },
      {
        define,
        test: {
          name: "component",
          include: ["tests/component/**/*.test.ts"],
          environment: "happy-dom",
          globalSetup,
          // Node's built-in EventSource doesn't work under happy-dom; install a fetch-based one for the SDK.
          setupFiles: ["tests/support/eventsource.ts", "tests/support/cleanup.ts"],
          // Deterministic time formatting.
          env: { TZ: "UTC" },
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup,
          // Run files serially so rate-limit and realtime tests don't interfere with each other.
          fileParallelism: false,
          // Node 22 ships EventSource behind a flag; the PocketBase SDK needs it for realtime.
          execArgv: ["--experimental-eventsource", "--no-warnings=ExperimentalWarning"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
