// Shared test vectors (shared/vectors/): the cases every implementation of these rules must pass, the web's here and
// the server's (pb_hooks/lib/text.js), the app's in android/core/data/src/test/kotlin/chirkle/android/data/lib/VectorsTest.kt.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import jump from "../../shared/vectors/jump.json" with { type: "json" };
import mentions from "../../shared/vectors/mentions.json" with { type: "json" };
import text from "../../shared/vectors/text.json" with { type: "json" };
import { textLength } from "../../web/src/lib/limits.ts";
import { splitMentions } from "../../web/src/lib/mentions.ts";
import type { Collections, Room, User } from "../../web/src/lib/types.ts";
import { type AppState, initialState } from "../../web/src/store.ts";
import { foldKey, highlight, searchQuery, searchWords } from "../../web/src/views/room/search.ts";
import { fold, matches, score, targets } from "../../web/src/views/switcher.ts";

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
  it("order: targets, then matches", () => {
    for (const c of jump.order) expect(jumpNames(c), c.name).toEqual(c.output);
  });
});

type JumpRoom = { id: string; name?: string; dm?: string; created: string; last_message_at?: string };
type JumpCase = (typeof jump.order)[number] & { filler?: { count: number; created: string } };

/** A case of jump.order through targets() and matches(), as the switcher does: the names shown, in order. */
function jumpNames(c: JumpCase): string[] {
  const me: User = { id: "me", name: "Me" };
  const others = new Map<string, User>();
  const room = (r: JumpRoom, more: Partial<Room> = {}): Room => {
    if (r.dm) others.set(r.id, { id: `u-${r.id}`, name: r.dm });
    return {
      id: r.id,
      name: r.name ?? "",
      kind: r.dm ? "dm" : "room",
      created: r.created,
      last_message_at: r.last_message_at ?? "",
      members: r.dm ? ["me", `u-${r.id}`] : [],
      created_by: "x",
      ...more,
    } as Room;
  };
  const filler = Array.from({ length: c.filler?.count ?? 0 }, (_, i) => ({ id: `f${i}`, name: `room ${i}`, created: c.filler!.created }));
  const sections = {
    rooms: [...c.sections.rooms, ...filler].map((r) => room(r)),
    dms: c.sections.dms.map((r) => room(r)),
    hidden: c.sections.hidden.map((r) => room(r)),
    archived: c.sections.archived.map((r) => room(r, { archived: true })),
  };
  const s: AppState = {
    ...initialState(),
    user: me,
    activeRoomId: c.current,
    activeCollectionId: c.current,
    collections: {
      mine: c.collections.mine.map((x) => ({ public: true, items: 1, ...x })),
      subs: c.collections.subs.map((x) => ({ public: true, items: 1, ...x })),
    } as Collections,
  };
  const opened: Record<string, string> = c.opened;
  const all = targets({ sections: () => sections, unread: () => 0, other: (r) => others.get(r.id), opened: (id) => opened[id] ?? "" }, s);
  return matches(all, c.query).map((t) => t.name);
}
