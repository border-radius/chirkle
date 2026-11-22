import { describe, expect, it } from "vitest";
import { PAGE_SIZE } from "../../../web/src/lib/cursor.ts";
import {
  applyPage,
  compare,
  emptyWindow,
  forwardHeader,
  group,
  lastOwnEditable,
  type MessageWindow,
  merge,
  quoteText,
  remove,
  startsGroup,
  trim,
  WINDOW_MAX,
} from "../../../web/src/lib/messages.ts";
import { toPb } from "../../../web/src/lib/time.ts";
import type { Message } from "../../../web/src/lib/types.ts";

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);
const at = (sec: number) => toPb(T0 + sec * 1000);

let n = 0;
function msg(p: Partial<Message> & { sec?: number } = {}): Message {
  const { sec = n, ...rest } = p;
  const id = rest.id ?? `m${String(n++).padStart(14, "0")}`;
  return {
    id,
    room: "r1",
    author: "u1",
    text: `text ${id}`,
    created: at(sec),
    updated: at(sec),
    edited_at: "",
    deleted: false,
    ...rest,
  };
}
/** n messages, one second apart, starting at `from` seconds. */
const seq = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => msg({ sec: from + i, id: `s${String(from + i).padStart(14, "0")}` }));
const win = (items: Message[], hasOlder = false, hasNewer = false): MessageWindow => ({ items, hasOlder, hasNewer });
const ids = (w: MessageWindow) => w.items.map((m) => m.id);

describe("constants", () => {
  it("window holds at most 300 messages", () => {
    expect(WINDOW_MAX).toBe(300);
  });

  it("emptyWindow has nothing on either side", () => {
    expect(emptyWindow()).toEqual({ items: [], hasOlder: false, hasNewer: false });
  });
});

describe("compare", () => {
  it("orders by created, then id", () => {
    const a = msg({ sec: 1, id: "b" });
    const b = msg({ sec: 2, id: "a" });
    const c = msg({ sec: 2, id: "c" });
    expect([c, b, a].sort(compare)).toEqual([a, b, c]);
  });
});

describe("merge", () => {
  it("sorts by (created, id), including out-of-order input and identical created", () => {
    const a = msg({ sec: 5, id: "aaa" });
    const b = msg({ sec: 5, id: "bbb" });
    const c = msg({ sec: 1, id: "zzz" });
    expect(ids(merge(emptyWindow(), [b, c, a]))).toEqual(["zzz", "aaa", "bbb"]);
  });

  it("dedupes by id", () => {
    const a = msg();
    const w = merge(merge(emptyWindow(), [a]), [{ ...a }]);
    expect(w.items).toHaveLength(1);
  });

  it("a server copy replaces a pending one (optimistic send ack)", () => {
    const pending = msg({ status: "pending", created: at(100), updated: at(100) });
    const { status: _s, ...server } = { ...pending, created: at(101), updated: at(101) };
    const w = merge(win([pending]), [server]);
    expect(w.items).toEqual([server]);
  });

  it("a server copy replaces a failed one", () => {
    const failed = msg({ status: "failed" });
    const { status: _s, ...server } = failed;
    expect(merge(win([failed]), [server]).items[0]!.status).toBeUndefined();
  });

  it("a stale pending copy never overwrites the server copy", () => {
    const server = msg();
    const w = merge(win([server]), [{ ...server, status: "pending" }]);
    expect(w.items[0]!.status).toBeUndefined();
  });

  it("the copy with the later `updated` wins (edits, soft deletes)", () => {
    const v1 = msg({ sec: 1, text: "v1" });
    const v2 = { ...v1, text: "v2", updated: at(50), edited_at: at(50) };
    expect(merge(win([v1]), [v2]).items[0]!.text).toBe("v2");
    // A stale fetch of v1 arriving after the realtime v2 must not revert it.
    expect(merge(win([v2]), [v1]).items[0]!.text).toBe("v2");
  });

  it("a soft delete replaces the text with the placeholder version", () => {
    const m = msg({ sec: 1 });
    const del = { ...m, text: "", deleted: true, updated: at(60) };
    expect(merge(win([m]), [del]).items[0]).toMatchObject({ deleted: true, text: "" });
  });

  it("prepends an older page", () => {
    const w = merge(win(seq(3, 10)), seq(3, 0));
    expect(ids(w)).toEqual([...seq(3, 0), ...seq(3, 10)].map((m) => m.id));
  });

  it("merging an empty page is a no-op (same window object)", () => {
    const w = win(seq(3));
    expect(merge(w, [])).toBe(w);
  });

  it("does not mutate its input", () => {
    const items = seq(2, 10);
    const w = win(items);
    merge(w, seq(2, 0));
    expect(w.items).toBe(items);
    expect(items).toHaveLength(2);
  });

  it("keeps hasOlder/hasNewer", () => {
    expect(merge(win(seq(1), true, true), seq(1, 5))).toMatchObject({ hasOlder: true, hasNewer: true });
  });
});

describe("remove", () => {
  it("removes by id", () => {
    const [a, b, c] = seq(3);
    expect(ids(remove(win([a!, b!, c!]), b!.id))).toEqual([a!.id, c!.id]);
  });

  it("is a no-op for an unknown id (same window object)", () => {
    const w = win(seq(3));
    expect(remove(w, "nope")).toBe(w);
  });
});

describe("trim", () => {
  it("bottom: drops the newest beyond max, sets hasNewer, returns dropped ids", () => {
    const items = seq(350);
    const { win: w, dropped } = trim(win(items), "bottom", WINDOW_MAX);
    expect(w.items).toHaveLength(300);
    expect(w.items[0]!.id).toBe(items[0]!.id);
    expect(w.items[299]!.id).toBe(items[299]!.id);
    expect(w.hasNewer).toBe(true);
    expect(w.hasOlder).toBe(false);
    expect(dropped).toEqual(items.slice(300).map((m) => m.id));
  });

  it("top: drops the oldest beyond max, sets hasOlder", () => {
    const items = seq(350);
    const { win: w, dropped } = trim(win(items), "top", WINDOW_MAX);
    expect(w.items).toHaveLength(300);
    expect(w.items[0]!.id).toBe(items[50]!.id);
    expect(w.hasOlder).toBe(true);
    expect(w.hasNewer).toBe(false);
    expect(dropped).toEqual(items.slice(0, 50).map((m) => m.id));
  });

  it("is a no-op at or under max", () => {
    const w = win(seq(300));
    expect(trim(w, "top", 300)).toEqual({ win: w, dropped: [] });
  });
});

describe("applyPage", () => {
  it("latest: resets the window at the live edge", () => {
    const page = seq(PAGE_SIZE, 100).reverse(); // newest-first, as the API returns it
    const { win: w } = applyPage(win(seq(5), true, true), page, "latest");
    expect(ids(w)).toEqual(seq(PAGE_SIZE, 100).map((m) => m.id));
    expect(w).toMatchObject({ hasOlder: true, hasNewer: false });
  });

  it("latest: a short page means the room's whole history is loaded", () => {
    const { win: w } = applyPage(emptyWindow(), seq(3).reverse(), "latest");
    expect(w).toMatchObject({ hasOlder: false, hasNewer: false });
  });

  it("first: resets the window at the beginning", () => {
    const { win: w } = applyPage(emptyWindow(), seq(PAGE_SIZE), "first");
    expect(w).toMatchObject({ hasOlder: false, hasNewer: true });
    const { win: short } = applyPage(emptyWindow(), seq(3), "first");
    expect(short).toMatchObject({ hasOlder: false, hasNewer: false });
  });

  it("older: a full page keeps hasOlder, a short page clears it", () => {
    const base = win(seq(PAGE_SIZE, 1000), true, false);
    expect(applyPage(base, seq(PAGE_SIZE, 500).reverse(), "older").win.hasOlder).toBe(true);
    expect(applyPage(base, seq(10, 500).reverse(), "older").win.hasOlder).toBe(false);
  });

  it("newer: a full page keeps hasNewer, a short page clears it", () => {
    const base = win(seq(PAGE_SIZE), false, true);
    expect(applyPage(base, seq(PAGE_SIZE, 500), "newer").win.hasNewer).toBe(true);
    expect(applyPage(base, seq(10, 500), "newer").win.hasNewer).toBe(false);
  });

  it("older: trims the bottom past WINDOW_MAX and reports the dropped ids", () => {
    const base = win(seq(280, 1000), true, false);
    const { win: w, dropped } = applyPage(base, seq(PAGE_SIZE, 500).reverse(), "older");
    expect(w.items).toHaveLength(300);
    expect(w).toMatchObject({ hasOlder: true, hasNewer: true });
    expect(dropped).toHaveLength(30);
    expect(dropped[0]).toBe(base.items[250]!.id);
  });

  it("newer: trims the top past WINDOW_MAX", () => {
    const base = win(seq(280), false, true);
    const { win: w, dropped } = applyPage(base, seq(PAGE_SIZE, 500), "newer");
    expect(w.items).toHaveLength(300);
    expect(w).toMatchObject({ hasOlder: true, hasNewer: true });
    expect(dropped).toEqual(base.items.slice(0, 30).map((m) => m.id));
  });

  it("an older page overlapping the window doesn't duplicate", () => {
    const base = win(seq(PAGE_SIZE, 100), true, false);
    const page = seq(PAGE_SIZE, 60).reverse(); // 60..109 overlaps 100..109
    const { win: w } = applyPage(base, page, "older");
    expect(new Set(ids(w)).size).toBe(w.items.length);
    expect(w.items).toHaveLength(90);
  });
});

describe("startsGroup / group", () => {
  it("starts a group at the first message and on author change", () => {
    const a = msg({ sec: 0, author: "u1" });
    const b = msg({ sec: 10, author: "u2" });
    expect(startsGroup(undefined, a)).toBe(true);
    expect(startsGroup(a, b)).toBe(true);
  });

  it("splits on a gap over 5:00, not at exactly 5:00", () => {
    const a = msg({ sec: 0 });
    expect(startsGroup(a, msg({ sec: 300 }))).toBe(false);
    expect(startsGroup(a, msg({ sec: 301 }))).toBe(true);
  });

  it("deleted placeholders take part in grouping like any message", () => {
    const a = msg({ sec: 0 });
    const del = msg({ sec: 10, deleted: true, text: "" });
    const c = msg({ sec: 20 });
    expect(group([a, del, c])).toEqual([[a, del, c]]);
  });

  it("groups a list into runs", () => {
    const a = msg({ sec: 0, author: "u1" });
    const b = msg({ sec: 5, author: "u1" });
    const c = msg({ sec: 6, author: "u2" });
    const d = msg({ sec: 1000, author: "u2" });
    expect(group([a, b, c, d])).toEqual([[a, b], [c], [d]]);
    expect(group([])).toEqual([]);
  });
});

describe("lastOwnEditable (Up-arrow edit, §7.6)", () => {
  it("returns my newest message, skipping deleted, pending, failed and others'", () => {
    const mine = msg({ sec: 1, author: "me" });
    const items = [
      msg({ sec: 0, author: "me" }),
      mine,
      msg({ sec: 2, author: "me", deleted: true, text: "" }),
      msg({ sec: 3, author: "me", status: "pending" }),
      msg({ sec: 4, author: "me", status: "failed" }),
      msg({ sec: 5, author: "other" }),
    ];
    expect(lastOwnEditable(win(items), "me")).toBe(mine);
  });

  it("returns undefined when nothing is editable", () => {
    expect(lastOwnEditable(win([msg({ author: "other" })]), "me")).toBeUndefined();
    expect(lastOwnEditable(emptyWindow(), "me")).toBeUndefined();
  });
});

describe("quoteText", () => {
  it("the text on one line; else its attachments; a deleted message, or a forward whose original was deleted, as deleted", () => {
    expect(quoteText({ text: " two\n lines ", deleted: false })).toBe("two lines");
    expect(quoteText({ text: "", deleted: false, files: ["a.png"] })).toBe("Attachment");
    expect(quoteText({ text: "", deleted: false, files: ["a.png", "b.pdf"] })).toBe("2 attachments");
    expect(quoteText({ text: "x", deleted: true })).toBe("Message deleted");
    expect(quoteText({ text: "", deleted: false, files: [] })).toBe("Message deleted");
  });
});

describe("forwardHeader", () => {
  it("splits off the line the Telegram bridge puts above a forward", () => {
    expect(forwardHeader("↪ Forwarded from Bob\nhello\nthere")).toEqual({ header: "↪ Forwarded from Bob", body: "hello\nthere" });
    expect(forwardHeader("↪ Forwarded from Bob")).toEqual({ header: "↪ Forwarded from Bob", body: "" });
  });

  it("leaves other text alone", () => {
    expect(forwardHeader("hello")).toEqual({ header: "", body: "hello" });
    expect(forwardHeader("hi\n↪ Forwarded from Bob")).toEqual({ header: "", body: "hi\n↪ Forwarded from Bob" });
    expect(forwardHeader("↪ Forwarded from \nx")).toEqual({ header: "", body: "↪ Forwarded from \nx" });
  });
});
