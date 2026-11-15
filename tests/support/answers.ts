// Every 2xx JSON answer of an /api/chat/* route that a test's SDK client gets is checked against the route's schema
// (shared/schema/answers.json, docs/REFACTOR.md item 54). A mismatch doesn't change what the call returns (the test
// goes on as it would); it is kept, and fails the test it happened in (tests/support/answers-setup.ts) with the route,
// the path in the answer and why.
import type PocketBase from "pocketbase";
import { checkAnswer } from "./schema.ts";

const mismatches: string[] = [];

/** The mismatches since the last call, cleared. */
export function takeMismatches(): string[] {
  return mismatches.splice(0);
}

/** Has `pb` check its answers (before any beforeSend of the test's own, which then replaces it). */
export function checkAnswers(pb: PocketBase): PocketBase {
  pb.beforeSend = (url, options) => {
    const method = options.method ?? "GET";
    const base = options.fetch ?? fetch;
    options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await base(input, init);
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/api/chat/") && res.ok && (res.headers.get("content-type") ?? "").includes("application/json")) {
        try {
          checkAnswer(method, path, await res.clone().json());
        } catch (err) {
          mismatches.push((err as Error).message);
        }
      }
      return res;
    };
    return { url, options };
  };
  return pb;
}
