// Shared test vectors (shared/vectors/): the cases every implementation of these rules must pass, the web's here and
// the server's (pb_hooks/lib/text.js), the app's in android/core/data/src/test/kotlin/chirkle/android/data/lib/VectorsTest.kt.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import jump from "../../shared/vectors/jump.json" with { type: "json" };
import mentions from "../../shared/vectors/mentions.json" with { type: "json" };
import text from "../../shared/vectors/text.json" with { type: "json" };
import { textLength } from "../../web/src/lib/limits.ts";
import { splitMentions } from "../../web/src/lib/mentions.ts";
import { foldKey, highlight, searchQuery, searchWords } from "../../web/src/views/room/search.ts";
import { fold, score } from "../../web/src/views/switcher.ts";

/** pb_hooks/lib/text.js: pure functions, a CommonJS module PocketBase loads (this package is ESM, so evaluated here). */
function hooksText(): { searchKey: (s: string) => string; isBlank: (s: string) => boolean } {
  const module = { exports: {} as never };
  new Function("module", readFileSync("pb_hooks/lib/text.js", "utf8"))(module);
  return module.exports;
}

/** pb_hooks/lib/handles.js's pure parts, with what it requires stubbed. */
function hooksHandles(): { handlesIn: (s: string) => string[]; handleFrom: (s: string) => string } {
  const module = { exports: {} as never };
  new Function("module", "require", "__hooks", readFileSync("pb_hooks/lib/handles.js", "utf8"))(module, () => ({}), "");
  return module.exports;
}

describe("shared vectors: mentions (§41)", () => {
  const server = hooksHandles();

  it("splits text into mentions, as the server finds them", () => {
    for (const c of mentions.mentions) {
      expect(splitMentions(c.input), c.input).toEqual(c.parts);
      expect(server.handlesIn(c.input), c.input).toEqual(c.handles);
    }
  });

  it("makes handles from names", () => {
    for (const c of mentions.handleFrom) expect(server.handleFrom(c.input), c.input).toBe(c.output);
  });
});

describe("shared vectors: text (§22.1, §29)", () => {
  const server = hooksText();

  it("foldKey, as the server's searchKey stores text_key", () => {
    for (const c of text.foldKey) {
      expect(foldKey(c.input)).toBe(c.output);
      expect(server.searchKey(c.input)).toBe(c.output);
    }
  });

  it("searchWords", () => {
    for (const c of text.searchWords) expect(searchWords(c.input)).toEqual(c.output);
  });

  it("searchQuery", () => {
    for (const c of text.searchQuery) expect(searchQuery(c.room, c.words, c.before ?? undefined)).toEqual(c.output.route);
  });

  it("highlight", () => {
    for (const c of text.highlight) expect(highlight(c.text, c.words)).toEqual(c.output);
  });

  it("textLength", () => {
    for (const c of text.textLength) expect(textLength(c.input)).toBe(c.output);
  });

  it("isBlank, as the server sees it", () => {
    for (const c of text.isBlank) expect(server.isBlank(c.input)).toBe(c.output);
  });
});

describe("shared vectors: jump to (§32)", () => {
  it("fold", () => {
    for (const c of jump.fold) expect(fold(c.input)).toBe(c.output);
  });

  it("score", () => {
    for (const c of jump.score) expect(score(c.name, fold(c.query))).toBe(c.output);
  });
});
