// Room view: loading, live updates, history windows and reconnects (§7.5, §7.6).

import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { dayLabel, parsePb } from "../../../../web/src/lib/time.ts";
import type { Message } from "../../../../web/src/lib/types.ts";
import { createRoomView } from "../../../../web/src/views/room.ts";
import { instrument, intercept, seedMessages, signedUp, viewContext } from "../../../support/api.ts";
import { fakeLayout } from "../../../support/dom.ts";
import { runSql } from "../../../support/sql.ts";
import {
  atBottom,
  beginning,
  bodyOf,
  button,
  captureHandler,
  composer,
  headerMenu,
  ids,
  io,
  layout,
  list,
  loaded,
  me,
  mount,
  msgEl,
  msgEls,
  navigate,
  newRoom,
  pill,
  ROW,
  root,
  sentinel,
  setLayout,
  setView,
  sleep,
  store,
  useRoomView,
  VIEWPORT,
  view,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("initial load (5.1)", () => {
    it("renders the latest 50 messages oldest-first, with a top sentinel for older history", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 120);
      await mount(room);
      expect(ids()).toEqual(seeded.slice(70).map((m) => m.id));
      expect(io.observing(sentinel("top"))).toBe(true);
      expect(beginning()).toBeNull();
      expect(sentinel("bottom")).toBeNull();
    });

    it("a short history shows the beginning marker instead of a top sentinel", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 3);
      await mount(room);
      expect(beginning()!.textContent).toBe(`Beginning of #${room.name}`);
      expect(sentinel("top")).toBeNull();
    });

    it("groups consecutive messages by author and shows author + time once per group", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const t0 = Date.now() - 600_000;
      await seedMessages(room.id, me.user.id, 3, { startAt: t0 });
      await seedMessages(room.id, other.user.id, 2, { startAt: t0 + 10_000 });
      await mount(room);
      const starts = msgEls().map((el) => el.classList.contains("group-start"));
      expect(starts).toEqual([true, false, false, true, false]);
      const first = msgEls()[0]!;
      expect(first.querySelector(".author")!.textContent).toBe("Me");
      expect(first.querySelector("time")!.getAttribute("datetime")).toBeTruthy();
      expect(msgEls()[1]!.querySelector(".author")).toBeNull();
    });

    it("a message's time links to it (/r/:id/m/:msgId)", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 1);
      await mount(room);
      const el = msgEls()[0]!;
      const link = el.querySelector<HTMLAnchorElement>(".meta a.permalink")!;
      expect(link.getAttribute("href")).toBe(`/r/${room.id}/m/${el.dataset.id}`);
      expect(link.querySelector("time")).not.toBeNull();
    });

    it("links in a message open in a new tab; anything else in it stays text (§7.6.3)", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 1, { text: () => "docs at https://example.com/a. not javascript:alert(1) or <b>x</b>" });
      await mount(room);
      const body = msgEls()[0]!.querySelector(".body")!;
      const links = [...body.querySelectorAll("a")];
      expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), a.textContent])).toEqual([
        ["https://example.com/a", "_blank", "noopener noreferrer nofollow", "https://example.com/a"],
      ]);
      expect(body.textContent).toBe("docs at https://example.com/a. not javascript:alert(1) or <b>x</b>");
      expect(body.querySelector("b")).toBeNull();
    });

    it("link previews show under the message, a line each: favicon and title; only http(s) links, data: icons (§28)", async () => {
      const room = await newRoom();
      const [m] = await seedMessages(room.id, me.user.id, 1, { text: () => "https://example.com/a https://example.org" });
      const icon = "data:image/png;base64,iVBORw0KGgo=";
      const previews = [
        { url: "https://example.com/a", title: "Example <b>A</b>", icon },
        { url: "https://example.org", title: "No icon", icon: "https://tracker.example/i.png" },
        { url: "javascript:alert(1)", title: "Bad", icon: "" },
      ];
      await runSql(inject("pbUrl"), [
        { sql: "UPDATE messages SET previews = {:p} WHERE id = {:id}", params: { p: JSON.stringify(previews), id: m!.id } },
      ]);
      await mount(room);
      const lines = [...msgEls()[0]!.querySelectorAll(".previews li a")];
      expect(
        lines.map((a) => [
          a.getAttribute("href"),
          a.getAttribute("target"),
          a.textContent,
          a.querySelector("img")?.getAttribute("src") ?? null,
        ]),
      ).toEqual([
        ["https://example.com/a", "_blank", "Example <b>A</b>", icon],
        ["https://example.org", "_blank", "No icon", null],
      ]);
      expect(msgEls()[0]!.querySelector(".previews b")).toBeNull();
    });

    it("inserts a date divider between days", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 4, { stepMs: 20 * 3_600_000 });
      await mount(room);
      const dividerEls = [...root.querySelectorAll("li.day")];
      // plain list items: a role override would break the <ol> list semantics (axe "list" rule)
      expect(dividerEls.every((d) => !d.hasAttribute("role"))).toBe(true);
      const dividers = dividerEls.map((d) => d.textContent);
      const expected = [...new Set(seeded.map((m) => dayLabel(parsePb(m.created))))];
      expect(expected.length).toBeGreaterThanOrEqual(3);
      expect(dividers).toEqual(expected);
    });

    it("starts scrolled to the bottom", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 60);
      await mount(room);
      expect(list().scrollHeight).toBeGreaterThan(VIEWPORT);
      expect(atBottom()).toBe(true);
    });

    it("shows the room name, marks the room active, and clears it on unmount", async () => {
      const room = await newRoom();
      await mount(room);
      expect(root.querySelector("header.room-header h1")!.textContent).toBe(`#${room.name}`);
      expect(store.get().activeRoomId).toBe(room.id);
      view!.unmount();
      setView(undefined);
      expect(store.get().activeRoomId).toBeNull();
      expect(root.childNodes).toHaveLength(0);
    });

    it("subscribes and fetches the first page in parallel", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      const release = ctl.hold("page");
      setView(createRoomView(viewContext(me.api, store, navigate)));
      view!.mount(root, { id: room.id });
      await vi.waitFor(() => expect(ctl.calls("subscribeMessages")).toBe(1));
      expect(ctl.calls("page")).toBe(1);
      release();
      await loaded();
    });

    it("QA BUG-61: a message sent after the first page was read, before realtime was set up, still shows", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      let open!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      // The server only gets the subscription once the gate opens: the page is read first.
      intercept(me.api, "subscribeMessages", (original) => async (roomId, fn) => {
        await gate;
        return original(roomId, fn);
      });
      setView(createRoomView(viewContext(me.api, store, navigate)));
      view!.mount(root, { id: room.id });
      setLayout(fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT }));
      await loaded();
      const m = await other.api.send({ id: newId(), room: room.id, text: "in the gap" });
      open();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("in the gap"));
      await other.api.unsubscribeAll();
    });

    it("an unknown room shows a not-found message", async () => {
      setView(createRoomView(viewContext(me.api, store, navigate)));
      view!.mount(root, { id: "doesnotexist123" });
      await vi.waitFor(() => expect(root.textContent).toContain("This room doesn't exist."));
      expect(composer()).toBeNull();
      // The page's heading, as a room's name is (QA BUG-90).
      expect(root.querySelector(".not-found h1")?.textContent).toBe("This room doesn't exist.");
    });

    it("unmount cancels the room's pending reads", async () => {
      const room = await newRoom();
      const signals: (AbortSignal | undefined)[] = [];
      intercept(me.api, "getRoom", (original) => (id, signal) => {
        signals.push(signal);
        return original(id, signal);
      });
      intercept(me.api, "page", (original) => (q, signal) => {
        signals.push(signal);
        return original(q, signal);
      });
      setView(createRoomView(viewContext(me.api, store, navigate)));
      view!.mount(root, { id: room.id });
      expect(signals).toHaveLength(2);
      expect(signals.every((s) => s && !s.aborted)).toBe(true);
      view!.unmount();
      setView(undefined);
      expect(signals.every((s) => s!.aborted)).toBe(true);
    });

    it("unmount unsubscribes and ignores events still in flight", async () => {
      const room = await newRoom();
      const handlers = captureHandler(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      view!.unmount();
      setView(undefined);
      handlers[0]!("create", {
        id: newId(),
        room: room.id,
        author: "x",
        text: "late",
        created: "",
        updated: "",
        edited_at: "",
        deleted: false,
      });
      expect(root.childNodes).toHaveLength(0);
      expect(ctl.calls("subscribeMessages")).toBe(1);
    });

    it("BUG-04: a failed room load shows an error with Retry instead of loading forever", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "here all along" });
      instrument(me.api).failNext("getRoom", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(list().textContent).toContain("Couldn't load this room.");
      expect(beginning()).toBeNull();
      expect(composer()).toBeNull(); // no writing into history you can't see
      button(list(), "Retry")!.click();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("here all along"));
      expect(list().textContent).not.toContain("Couldn't load");
      expect(composer()).not.toBeNull();
    });

    it("BUG-04: a failed load retries by itself when the connection comes back", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "back online" });
      const ctl = instrument(me.api);
      ctl.failNext("getRoom", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(list().textContent).toContain("Couldn't load this room.");
      ctl.reconnect();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("back online"));
    });

    it("a failed load retries when the browser is back online, though realtime stayed connected (QA BUG-123)", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "back online" });
      instrument(me.api).failNext("getRoom", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(list().textContent).toContain("Couldn't load this room.");
      dispatchEvent(new Event("online"));
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("back online"));
      dispatchEvent(new Event("online")); // loaded: nothing to do
      expect(list().textContent).not.toContain("Couldn't load");
    });

    it("BUG-05: a failed history load is not shown as an empty room", async () => {
      const room = await newRoom();
      await me.api.send({ id: newId(), room: room.id, text: "history" });
      instrument(me.api).failNext("page", new ApiError("Failed to fetch", 0));
      await mount(room);
      expect(beginning()).toBeNull();
      expect(list().textContent).toContain("Couldn't load this room.");
    });

    it("BUG-18: a link to a message that isn't in this room says so", async () => {
      const room = await newRoom();
      const elsewhere = await newRoom();
      const m = await me.api.send({ id: newId(), room: elsewhere.id, text: "elsewhere" });
      await mount(room, { msgId: m.id });
      expect(root.querySelector(".room-notice")!.textContent).toContain("isn't in this room");
    });
  });

  describe("live updates and scrolling (5.3)", () => {
    it("at the bottom, a new message is appended and the view follows it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      const m = await other.api.send({ id: newId(), room: room.id, text: "hi from other" });
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });

    it("scrolled up, a new message shows the pill instead of scrolling; the pill returns to the bottom", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      layout.scrollTo(0);
      const m = await other.api.send({ id: newId(), room: room.id, text: "while you read" });
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(list().scrollTop).toBe(0);
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("New messages");
      pill().click();
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });

    it("scrolling back to the bottom hides the pill", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      layout.scrollTo(0);
      await other.api.send({ id: newId(), room: room.id, text: "ping" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      layout.scrollToBottom();
      expect(pill().hidden).toBe(true);
    });
  });

  describe("windowed history (5.4)", () => {
    /** Assert the DOM shows a contiguous slice of `all`, and return it. */
    function contiguous(all: Message[]): Message[] {
      const shown = ids();
      const start = all.findIndex((m) => m.id === shown[0]);
      expect(start).toBeGreaterThanOrEqual(0);
      const slice = all.slice(start, start + shown.length);
      expect(shown).toEqual(slice.map((m) => m.id));
      return slice;
    }

    it("loading older messages keeps what you were looking at in place", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      await mount(room);
      layout.scrollTo(3 * ROW);
      const anchorId = msgEls().find((el) => el.offsetTop >= list().scrollTop)!.dataset.id!;
      const before = msgEl(anchorId)!.offsetTop - list().scrollTop;
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
      expect(msgEl(anchorId)!.offsetTop - list().scrollTop).toBe(before);
    });

    it("loading older messages from the very top keeps the view in place, so scrolling up keeps loading", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      await mount(room);
      layout.scrollTo(0); // the top message is the anchor; prepending changes its grouping and rebuilds it
      const firstId = ids()[0]!;
      const before = msgEl(firstId)!.offsetTop - list().scrollTop;
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
      expect(list().scrollTop).toBeGreaterThan(0);
      expect(msgEl(firstId)!.offsetTop - list().scrollTop).toBe(before);
    });

    it("away from the live edge, new messages show 'Jump to latest' instead of being appended", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await mount(room, { msgId: all[20]!.id });
      const m = await other.api.send({ id: newId(), room: room.id, text: "meanwhile" });
      // In history the button already shows "Jump to latest" (§22.7): wait for the new message to change it.
      await vi.waitFor(() => expect(pill().textContent).toBe("New messages · Jump to latest"));
      expect(pill().hidden).toBe(false);
      expect(ids()).not.toContain(m.id);
      pill().click();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(m.id));
      expect(sentinel("bottom")).toBeNull();
      expect(pill().hidden).toBe(true);
      expect(atBottom()).toBe(true);
    });

    it("Jump to beginning loads the first page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await mount(room);
      button(headerMenu(), "Jump to beginning")!.click();
      await vi.waitFor(() => expect(beginning()).not.toBeNull());
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(sentinel("bottom")).not.toBeNull();
      expect(list().scrollTop).toBe(0);
    });

    it("/r/:id/m/:msgId opens a window around that message and highlights it", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const target = all[150]!;
      await mount(room, { msgId: target.id });
      expect(ids()).toContain(all[149]!.id);
      expect(ids()).toContain(all[151]!.id);
      contiguous(all);
      expect(msgEl(target.id)!.classList.contains("target")).toBe(true);
      expect(sentinel("top")).not.toBeNull();
      expect(sentinel("bottom")).not.toBeNull();
    });
  });

  describe("reconnects (5.5)", () => {
    it("a reconnect refetches the room, so an archive missed while offline takes effect", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      intercept(me.api, "subscribeRooms", () => async () => async () => {}); // no live room events
      await mount(room);
      await me.api.setArchived(room.id, true);
      await sleep(200);
      expect(composer()).not.toBeNull();
      ctl.reconnect();
      await vi.waitFor(() => expect(composer()).toBeNull());
      expect(root.textContent).toContain("This room is archived. History is read-only.");
    });
  });

  describe("BUG-31: the list stays at the bottom when it gets shorter", () => {
    let resized: (() => void)[] = [];
    beforeEach(() => {
      resized = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            resized.push(cb);
          }
          observe() {}
          disconnect() {}
        },
      );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("at the bottom: a shorter list (tray opened, textarea grew) scrolls to stay at the bottom", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 40);
      await mount(room);
      expect(atBottom()).toBe(true);
      layout.setClientHeight(VIEWPORT - 120);
      for (const cb of resized) cb();
      expect(list().scrollTop).toBe(list().scrollHeight - (VIEWPORT - 120));
    });

    it("scrolled up into history: the position is left alone", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 40);
      await mount(room);
      layout.scrollTo(100);
      layout.setClientHeight(VIEWPORT - 120);
      for (const cb of resized) cb();
      expect(list().scrollTop).toBe(100);
    });
  });
});
