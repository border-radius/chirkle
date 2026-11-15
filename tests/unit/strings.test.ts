// Strings in one place (docs/REFACTOR.md item 56): the screens moved so far keep their user-facing text in their
// strings module (web/src/strings/<screen>.ts) or their module's strings.xml (the app), not inline. A screen is added
// here once moved; what is left is listed in docs/REFACTOR.md.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MOVED = [
  "web/src/views/login.ts",
  "android/feature/auth/src/main/kotlin/chirkle/android/feature/auth/AuthScreen.kt",
  "android/feature/auth/src/main/kotlin/chirkle/android/feature/auth/AuthViewModel.kt",
];

/** Literals that read as English text ("Log in", `Must be ${n}…`): a capital, then a lowercase letter, then more. */
const TEXT = /(["`])[A-Z][a-z][^"`\n]{2,}\1/g;

function inline(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line: line.replace(/\/\/.*$/, ""), n: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\*|import )/.test(line))
    .flatMap(({ line, n }) => [...line.matchAll(TEXT)].map((m) => `${file}:${n}: ${m[0]}`));
}

describe("strings in one place", () => {
  it.each(MOVED)("%s has no inline text", (file) => {
    expect(inline(file)).toEqual([]);
  });

  it("finds inline text where there is some", () => {
    expect(inline("web/src/views/profile.ts").length).toBeGreaterThan(0);
  });
});
