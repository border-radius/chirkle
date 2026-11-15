// The build puts web/src/strings/'s text back where it is used (scripts/lib/build-utils.mjs inlineStrings, docs/REFACTOR.md
// item 56): what it replaces, what it leaves, and that every real module comes out the same as written.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings here are source code, with its ${…} in them

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { inlineStrings } from "../../../scripts/lib/build-utils.mjs";

const MOD = [
  'export const LOG_IN = "Log in";',
  "export const LONG =",
  '  "A sentence long enough to be wrapped onto its own line.";',
  "export const welcome = (name: string) => `Welcome, ${name}!`;",
  "export const of = (n: number, total: number) => `${n} of ${total}`;",
  "export const backwards = (a: string, b: string) => `${b}, then ${a}`;",
  'export const pick = (mine: boolean) => `${mine ? "yours" : "theirs"}`;',
  "",
].join("\n");
const inline = (src: string) => inlineStrings(`import * as S from "../strings/x.ts";\n${src}`, () => MOD).split("\n")[1];

describe("inlineStrings", () => {
  it("puts constants in, wrapped or not", () => {
    expect(inline('h("a", {}, S.LOG_IN);')).toBe('h("a", {}, "Log in");');
    expect(inline("say(S.LONG);")).toBe('say("A sentence long enough to be wrapped onto its own line.");');
  });

  it("makes a template of a function that only puts its parameters in, in order", () => {
    expect(inline('t(S.welcome(user.name ?? "x"));')).toBe('t(`Welcome, ${user.name ?? "x"}!`);');
    expect(inline("t(S.of(f(1, [2, 3]), n + 1));")).toBe("t(`${f(1, [2, 3])} of ${n + 1}`);");
  });

  it("leaves other functions, names it doesn't know and other modules alone", () => {
    expect(inline('t(S.backwards("a", "b"));')).toBe('t(S.backwards("a", "b"));');
    expect(inline("t(S.pick(true));")).toBe("t(S.pick(true));");
    expect(inline("t(S.NOPE, T.LOG_IN);")).toBe("t(S.NOPE, T.LOG_IN);");
    expect(inline("t(S.welcome(`${a}`));")).toBe("t(S.welcome(`${a}`));");
  });

  it("leaves no constant of a real module behind", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? (f === "strings" ? [] : walk(p)) : p.endsWith(".ts") ? [p] : [];
      });
    for (const file of walk("web/src")) {
      const out = inlineStrings(readFileSync(file, "utf8"), (rel) => readFileSync(join(dirname(file), rel), "utf8"));
      // A constant is UPPER_CASE; what is left of S.* is functions with conditions in them.
      expect(out.match(/\b(S|Str)\.[A-Z][A-Z0-9_]*\b/g), file).toBeNull();
    }
  });
});
