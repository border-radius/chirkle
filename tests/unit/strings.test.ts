// Strings in one place (docs/REFACTOR.md item 56). The web's user-facing text is web/src/strings/<file>.ts, one module
// per source file (so a lazy screen's text stays in its chunk); the app's is each module's res/values/strings.xml, and
// core/data's core/data/src/main/kotlin/chirkle/android/data/lib/Strings.kt. This fails on text written inline
// anywhere else: a literal that reads as words. What only looks like it (key names, headers, selectors, class lists,
// field lists, SQL) is listed below by its value.

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings here are source code, with its ${…} in them

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Literals that read as words but aren't text anyone reads. */
const NOT_TEXT = new Set([
  // Key names (KeyboardEvent.key, .code, aria-keyshortcuts) and the drag type of files.
  "Enter",
  "Escape",
  "Backspace",
  "Home",
  "End",
  "Tab",
  "Slash",
  "Meta+/",
  "Control+/",
  "Files",
  // The product's name: the "chirps on Chirkle" link and the default site title; the server's own title replaces it.
  "Chirkle",
  // HTTP headers, and the fetch errors pb.ts imitates (the SDK matches on them).
  "If-None-Match",
  "Cache-Control",
  "Content-Type",
  "Authorization",
  "Accept",
  "Network request failed",
  "Aborted",
  // A developer's error, never shown: a screen composed outside :app.
  "No ChirkleServices provided",
  // The server field's example address (ServerScreen): a host name, the same in every language.
  "chat.example.org",
  // Byte units (formatBytes), as on the web.
  " MB",
]);

/** Values that are code: CSS selectors, class lists, fonts, ids, SVG paths, PocketBase field lists, filters and SQL. */
const CODE = [
  /^(\.{1,2}\/|\/|[a-z]+:\/\/?|market:|data:)/, // paths, imports, URLs
  /px$/, // CSS lengths
  /^[a-z]+(\.[A-Za-z]+)+\.?$/, // storage keys and intent actions: chat.draft., chirkle.android.READ
  /^\.[\w-]+|^[\w-]+\.[\w-]+(:\w+\(|\s\.)/, // selectors: .emoji-section.recent, .actions button
  /^\\\\|^[LyMdHmsSZ' .:-]+$|^'\w+' \d$/, // a regex, date patterns, a font feature
  /^[a-z]+\.[\w-]+(\[|\s|$)/, // li.msg, button.emoji, input.select
  /^(a, button|\(hover|\(pointer)/,
  /^\$\{[^}]*\} [a-z]+\.[\w-]+$/, // `${byId(id)} textarea.edit-input`
  /(^|\s)ic( |$)|\bi-[a-z]/, // icon classes
  /^[a-z][\w]*-[\w-]*( [a-z][\w-]*)*$|^[a-z]+ [a-z]+-[\w-]+$/, // class lists with a hyphen: "danger confirm-delete"
  /^\$\{[^}]*\}-[\w-]+ \$\{[^}]*\}-[\w-]+$/, // aria-describedby ids
  /px [A-Z]\w+,/, // a canvas font
  /^M\$\{/, // an SVG path
  /^[a-z_.]+(,[a-z_.:]+)+,?$/, // field and sort lists
  /\{:\w+\}|&&|\|\||:length/, // PocketBase filters
  /^(SELECT|INSERT|UPDATE|DELETE) /,
];

/** "Log in", `Must be ${n}…`, " or ", "sign up", `${n} found`: words, not code. */
function readsAsText(body: string, before = ""): boolean {
  const t = body.replace(/\$\{[^}]*\}|\$[a-zA-Z_]\w*/g, "X");
  if (NOT_TEXT.has(body) || CODE.some((re) => re.test(body))) return false;
  // A class list (given to class, or the start of one: `avatar s${px}`), or a link's rel.
  if (/\b(class|cls|className|classList|rel)\b[^,;]*$/.test(before) || /^[a-z][\w-]* [a-z][\w-]*X/.test(t)) return false;
  if (/^[A-Z][a-z]{2,}$/.test(t)) return true; // one word: "Retry"
  if (/^[A-Za-z]+$/.test(t) && /[a-z][A-Z]/.test(t)) return false; // CamelCase: ArrowDown, AbortError
  if (/^[A-Z][a-z]/.test(t) && t.length >= 4) return true;
  return /[A-Za-z]{2,}[,.;:!?…]? [A-Za-z]/.test(t) || /^\s+[A-Za-z]{2}|[A-Za-z]{2}\s+$/.test(t) || /^X [a-z]{2}/.test(t);
}

const WEB_LITERAL = /"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$\{[^}`]*\}|\$(?!\{))*`/g;
const KOTLIN_LITERAL = /"(?:[^"\\\n$]|\\.|\$\{[^}]*\}|\$(?!\{))*"/g;

function inline(file: string, literal: RegExp): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line: line.replace(/(^|\s)\/\/ .*$/, ""), n: i + 1 }))
    .filter(({ line }) => !/^\s*(\*|\/\*|\/\/|import |package )/.test(line))
    .flatMap(({ line, n }) =>
      [...line.matchAll(literal)].filter((m) => readsAsText(m[0].slice(1, -1), line.slice(0, m.index))).map((m) => `${file}:${n}: ${m[0]}`),
    );
}

const files = (dir: string, ext: string, skip: string[]): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return skip.includes(f) ? [] : files(p, ext, skip);
    return p.endsWith(ext) ? [p] : [];
  });

/** The web's sources, but its text modules and the emoji names (data, searched by name). */
const WEB = files("web/src", ".ts", ["strings"]).filter((f) => !/emoji-(names|data)\.ts$/.test(f));
/** The app's shipped sources: not tests, the test server, the baseline profile's journeys or the build's plugins. */
const APP = ["app", "feature", "core/ui", "core/data"]
  .flatMap((d) => files(join("android", d), ".kt", ["build", "test", "androidTest"]))
  .filter((f) => !f.endsWith("/lib/Strings.kt"));

describe("strings in one place", () => {
  it("the web has no inline text", () => {
    expect(WEB.flatMap((f) => inline(f, WEB_LITERAL))).toEqual([]);
  });

  it("the app has no inline text", () => {
    expect(APP.flatMap((f) => inline(f, KOTLIN_LITERAL))).toEqual([]);
  });

  it("tells text from code", () => {
    for (const s of ["Log in", "Retry", " or ", "sign up", "${n} found", "Must be ${n} characters.", "Couldn't save. $why"]) {
      expect(readsAsText(s), s).toBe(true);
    }
    for (const s of ["Enter", "ArrowDown", "li.msg", "brand has-logo", "id,room,author", "chat.notify", "ic ${i.icon}", "x"]) {
      expect(readsAsText(s), s).toBe(false);
    }
  });

  it("each strings module is imported by the file it is named after", () => {
    for (const mod of readdirSync("web/src/strings")) {
      const name = mod.replace(/\.ts$/, "");
      const users = WEB.filter((f) => readFileSync(f, "utf8").includes(`strings/${mod}"`));
      expect(users.length, `web/src/strings/${mod}`).toBeGreaterThan(0);
      expect(name).toMatch(/^[a-z-]+$/);
    }
  });
});
