// Message search (§29): the query it sends, the snippets it shows, and the bar in the room view.

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { foldKey, highlight, searchQuery, searchWords } from "../../../../web/src/views/room/search.ts";
import { instrument, seedMessages } from "../../../support/api.ts";
import { button, ids, key, me, mount, msgEl, newRoom, root, useRoomView } from "./harness.ts";

describe("search helpers", () => {
  it("fold like the server's nameKey: NFKC, full case folding, no invisible characters", () => {
    expect(foldKey("Straße ＡＢＣ Ü​ber")).toBe("strasse abc über");
    expect(foldKey("ПРИВЕТ")).toBe("привет");
    expect(foldKey("İSTANBUL İzmir")).toBe("istanbul izmir"); // not "i̇stanbul" (QA BUG-113)
  });

  it("split into folded words, each once, at most five", () => {
    expect(searchWords("  Hello   hello WORLD ")).toEqual(["hello", "world"]);
    expect(searchWords("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
    expect(searchWords(" ​ ")).toEqual([]);
  });

  it("ask for the room's newest page with the words, then the page older than the last result", () => {
    expect(searchQuery("r1", ["100%", "x"])).toEqual({ room: "r1", kind: "latest", args: {}, q: "100% x" });
    const q = searchQuery("r1", ["x"], { created: "2026-10-18 10:00:00.000Z", id: "abc" });
    expect(q).toEqual({ room: "r1", kind: "older", args: { created: "2026-10-18 10:00:00.000Z", id: "abc" }, q: "x" });
  });

  it("mark the matches, case-insensitively, starting shortly before the first", () => {
    expect(highlight("Say HELLO to hello.", ["hello"])).toEqual(["Say ", "HELLO", " to ", "hello", "."]);
    expect(highlight("one\n\ntwo", ["two"])).toEqual(["one ", "two", ""]);
    const long = `${"word ".repeat(30)}needle end`;
    const [lead, match] = highlight(long, ["needle"]);
    expect(lead!.startsWith("…")).toBe(true);
    expect(lead!.length).toBeLessThan(40);
    expect(match).toBe("needle");
    expect(highlight("a.b axb", ["a.b"])).toEqual(["", "a.b", " axb"]);
  });
});

describe("room view: search (§29)", () => {
  useRoomView();

  const toggle = () => root.querySelector<HTMLButtonElement>("header.room-header button.search-toggle")!;
  const field = () => root.querySelector<HTMLInputElement>(".room-search input");
  const status = () => root.querySelector(".room-search .search-status")!.textContent;
  const results = () => [...root.querySelectorAll<HTMLButtonElement>(".search-results .search-result")];
  const search = (q: string) => {
    field()!.value = q;
    key(field()!, "Enter");
  };

  it("finds messages, newest first, and goes to the one picked, loading the history around it", async () => {
    const room = await newRoom();
    const all = await seedMessages(room.id, me.user.id, 300, { text: (i) => (i % 100 === 5 ? `Needle number ${i}` : `msg ${i}`) });
    await mount(room);
    toggle().click();
    await vi.waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field()!.placeholder).toBe(`Search #${room.name}`);
    // A search box, without the browser's own clear "×" of type=search next to Close (QA BUG-114).
    expect([field()!.type, field()!.getAttribute("role")]).toEqual(["text", "searchbox"]);
    search("NEEDLE");
    await vi.waitFor(() => expect(status()).toBe("3 messages found."));
    expect(results().map((r) => r.querySelector(".body")!.textContent)).toEqual([
      "Needle number 205",
      "Needle number 105",
      "Needle number 5",
    ]);
    expect(results()[0]!.querySelector("mark")!.textContent).toBe("Needle");
    expect(ids()).not.toContain(all[5]!.id);
    results()[2]!.click();
    await vi.waitFor(() => expect(msgEl(all[5]!.id)?.classList.contains("target")).toBe(true));
    expect(root.querySelector<HTMLElement>(".search-results")!.hidden).toBe(true);
    // Back in the field, the results are there again.
    field()!.dispatchEvent(new FocusEvent("focus"));
    expect(root.querySelector<HTMLElement>(".search-results")!.hidden).toBe(false);
  });

  it("too many searches (429, the server's search limit) says so, not to check the connection (QA SEC-4)", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 3, { text: (i) => `hit ${i}` });
    await mount(room);
    toggle().click();
    await vi.waitFor(() => expect(field()).toBeTruthy());
    instrument(me.api).failNext("page", new ApiError("Too many searches.", 429));
    search("hit");
    await vi.waitFor(() => expect(status()).toBe("Too many attempts. Wait a few seconds and try again."));
    instrument(me.api).failNext("page", new ApiError("Failed to fetch.", 0));
    search("hit 1");
    await vi.waitFor(() => expect(status()).toBe("Couldn't search. Check your connection."));
  });

  it("says when nothing is found, pages through many results, and closes with Escape", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 60, { text: (i) => `hit ${i}` });
    await mount(room);
    toggle().click();
    await vi.waitFor(() => expect(field()).not.toBeNull());
    search("nope");
    await vi.waitFor(() => expect(status()).toBe("No messages found."));
    expect(results()).toEqual([]);
    search("hit");
    await vi.waitFor(() => expect(status()).toBe("50+ messages found."));
    button(root.querySelector(".search-results"), "Show older results")!.click();
    await vi.waitFor(() => expect(status()).toBe("60 messages found."));
    expect(results().at(-1)!.querySelector(".body")!.textContent).toBe("hit 0");
    expect(button(root.querySelector(".search-results"), "Show older results")).toBeNull();
    key(field()!, "Escape");
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(toggle());
  });
});
