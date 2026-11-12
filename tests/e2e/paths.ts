// Shared between the e2e global setup (global-setup.ts) and the specs (fixtures.ts).
// One server per Playwright worker (docs/REFACTOR.md item 62): worker `n` (TEST_PARALLEL_INDEX, 0 … workers − 1, kept
// by a worker that replaces a failed one) talks to the server on E2E_PORT + n with its own data dir, so a test never
// sees another worker's public rooms or their live events. Outside a worker (the config, global setup) the slot is 0.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The first worker's port; worker n's is this + n. */
export const E2E_FIRST_PORT = Number(process.env.E2E_PORT ?? 8091);

export const e2ePort = (slot: number): number => E2E_FIRST_PORT + slot;
export const e2eDataDir = (port: number): string => join(tmpdir(), `chirkle-e2e-${port}`);

export const E2E_PORT = e2ePort(Number(process.env.TEST_PARALLEL_INDEX ?? 0));
export const E2E_BASE = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_DATA_DIR = e2eDataDir(E2E_PORT);
