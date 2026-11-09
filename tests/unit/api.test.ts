import { describe, expect, it, vi } from "vitest";
import { createApi, MSG_FIELDS, pageOptions } from "../../web/src/api.ts";
import { latest, older, withFiles } from "../../web/src/lib/cursor.ts";
import { createClient } from "../../web/src/pb.ts";
import { searchQuery } from "../../web/src/views/room/search.ts";

describe("pageOptions", () => {
  it("names the page and its cursor; the server writes the filter", () => {
    const c = { created: "2026-10-10 12:00:00.000Z", id: "m1" };
    expect(pageOptions(latest("r1"))).toEqual({
      kind: "latest",
      limit: 50,
      expand: "author,reply_to.author,forwarded_from",
      fields: MSG_FIELDS,
    });
    expect(pageOptions(withFiles(older("r1", c)), 200, 2)).toMatchObject({ kind: "older", ...c, files: "1", limit: 200, page: 2 });
    // Search (§29): the words, which the server matches.
    expect(pageOptions(searchQuery("r1", ["a%", "b"], c))).toMatchObject({ kind: "older", ...c, q: "a% b" });
  });
});

describe("MSG_FIELDS", () => {
  it("fetches only the fields the UI renders, never email", () => {
    expect(MSG_FIELDS.split(",")).toEqual([
      "id",
      "room",
      "text",
      "created",
      "updated",
      "edited_at",
      "deleted",
      "files",
      "file_names",
      "file_sources",
      "file_dims",
      "reactions",
      "previews",
      "author",
      "expand.author.id",
      "expand.author.name",
      "expand.author.avatar",
      "expand.author.no_dms",
      // which instance a stand-in is on (§33.4)
      "expand.author.instance",
      // the message a reply quotes (§19)
      "reply_to",
      "expand.reply_to.id",
      "expand.reply_to.author",
      "expand.reply_to.text",
      "expand.reply_to.deleted",
      "expand.reply_to.files",
      "expand.reply_to.expand.author.id",
      "expand.reply_to.expand.author.name",
      // who first wrote a forwarded message (§21.3)
      "forwarded_from",
      "forward_of",
      "expand.forwarded_from.id",
      "expand.forwarded_from.name",
      "mentions",
    ]);
    expect(MSG_FIELDS).not.toContain("email");
  });
});

describe("onConnect", () => {
  it("a first connect that fails is no unhandled rejection: the page started offline (QA BUG-85)", async () => {
    /** An EventSource that fails at once, as with no network. */
    class Offline {
      onerror: (() => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onerror?.());
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("EventSource", Offline);
    try {
      const api = createApi(createClient("http://offline.test"));
      const off = api.onConnect(() => {});
      await new Promise((r) => setTimeout(r, 10)); // an unhandled rejection would fail the run here
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
