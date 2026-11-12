import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../../web/src/api.ts";
import { latest } from "../../../web/src/lib/cursor.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Message, Room } from "../../../web/src/lib/types.ts";
import { createScope, type Scope } from "../../../web/src/scope.ts";
import { type AppState, createStore, initialState, type Store, UNCOUNTED, upsertRoom } from "../../../web/src/store.ts";
import { type Change, createRoomController, type RoomController } from "../../../web/src/views/room/controller.ts";
import { instrument, intercept, memoryCache, type SignedUp, seedMessages, signedUp, subscribed, uniq } from "../../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("room controller (§7.5, no DOM)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let scope: Scope;
  let ctl: RoomController;
  let changes: Change[];
  /** What onBusy was told, in order. */
  let busy: boolean[];
  /** What the view would answer to "is the list at the bottom?". */
  let nearBottom: boolean;
  /** The room cache, for the tests that use one. */
  let cache: ReturnType<typeof memoryCache> | undefined;

  beforeEach(async () => {
    me = await signedUp("Me");
    // The unread counts are in, with none (initialState's UNCOUNTED is a page just loaded: QA BUG-93).
    store = createStore<AppState>({ ...initialState(), user: me.user, unread: new Map() });
    nearBottom = true;
    cache = undefined;
  });
  afterEach(async () => {
    scope?.dispose();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  // ---- helpers ----

  const newRoom = (owner: SignedUp = me): Promise<Room> => owner.api.createRoom(`room-${uniq()}`);
  const state = () => ctl.state();
  const ids = () => state().win.items.map((m) => m.id);
  const ready = () => vi.waitFor(() => expect(state().phase).toBe("ready"));
  const say = (who: SignedUp, room: Room, text = "hi") => who.api.send({ id: newId(), room: room.id, text });

  /** Start a controller (without waiting for the first load). */
  function start(room: Room | string, msgId?: string, api: Api = me.api) {
    scope = createScope();
    changes = [];
    busy = [];
    ctl = createRoomController({
      api,
      store,
      roomId: typeof room === "string" ? room : room.id,
      msgId,
      scope,
      nearBottom: () => nearBottom,
      onChange: (c) => changes.push(c),
      onBusy: (b) => busy.push(b),
      ...(cache && { cache }),
    });
    ctl.start();
  }

  /** Start, wait for the first page and for the realtime subscription. */
  async function open(room: Room, msgId?: string) {
    start(room, msgId);
    await ready();
    await subscribed(me.api);
  }

  /** The window must be a contiguous slice of `all`. */
  function contiguous(all: Message[]) {
    const shown = ids();
    const from = all.findIndex((m) => m.id === shown[0]);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(shown).toEqual(all.slice(from, from + shown.length).map((m) => m.id));
  }

  it("is busy while it fetches: the first load, history (§7.9)", async () => {
    const room = await newRoom();
    await seedMessages(room.id, me.user.id, 120);
    start(room);
    expect(busy).toEqual([true]);
    await ready();
    await vi.waitFor(() => expect(busy.at(-1)).toBe(false));
    // Never told the same twice in a row.
    expect(busy.every((b, k) => b === (k % 2 === 0))).toBe(true);
    const n = busy.length;
    const edge = ctl.loadEdge("top");
    expect(busy.slice(n)).toEqual([true]);
    await edge;
    expect(busy.slice(n)).toEqual([true, false]);
  });

  /** Drop realtime message events while `offline` (a dropped connection); `dropped` counts them. */
  function gateRealtime(api: Api) {
    const gate = { offline: false, dropped: 0 };
    intercept(
      api,
      "subscribeMessages",
      (original) => (roomId, fn) =>
        original(roomId, (action, rec) => {
          if (gate.offline) gate.dropped++;
          else fn(action, rec);
        }),
    );
    return gate;
  }

  // ---- first load ----

  describe("first load", () => {
    it("loads the latest page and asks to scroll to the bottom", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 120);
      start(room);
      expect(state().phase).toBe("loading");
      await ready();
      expect(ids()).toEqual(all.slice(70).map((m) => m.id));
      expect(state().win).toMatchObject({ hasOlder: true, hasNewer: false });
      expect(changes.at(-1)).toEqual({ render: {}, notice: "", scroll: "bottom" });
      expect(store.get().rooms.get(room.id)?.id).toBe(room.id);
    });

    it("a message id opens the window around it and asks to centre it", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      start(room, all[150]!.id);
      await ready();
      expect(state().targetId).toBe(all[150]!.id);
      expect(state().win).toMatchObject({ hasOlder: true, hasNewer: true });
      contiguous(all);
      expect(changes.at(-1)?.scroll).toBe("target");
    });

    it("a message from another room falls back to the latest page, with a notice", async () => {
      const room = await newRoom();
      const elsewhere = await say(me, await newRoom(), "elsewhere");
      const here = await say(me, room, "here");
      start(room, elsewhere.id);
      await ready();
      expect(ids()).toEqual([here.id]);
      expect(state().targetId).toBeNull();
      expect(changes.at(-1)).toMatchObject({
        scroll: "bottom",
        notice: "That message isn't in this room. Showing the latest messages instead.",
      });
    });

    it("an unknown room is not-found", async () => {
      start("doesnotexist123");
      await vi.waitFor(() => expect(state().phase).toBe("not-found"));
    });

    it("a failed load is 'failed' (never an empty window); retry() and a reconnect load again", async () => {
      const room = await newRoom();
      const m = await say(me, room, "here all along");
      const net = instrument(me.api);
      net.failNext("getRoom", new ApiError("Failed to fetch", 0));
      start(room);
      await vi.waitFor(() => expect(state().phase).toBe("failed"));
      net.failNext("page", new ApiError("Failed to fetch", 0));
      ctl.retry();
      expect(state().phase).toBe("loading");
      await vi.waitFor(() => expect(state().phase).toBe("failed")); // the page fails this time
      net.reconnect();
      await ready();
      expect(ids()).toEqual([m.id]);
    });

    it("live messages that arrive before the first page are replayed once it is in, without duplicates", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const seen: string[] = [];
      intercept(
        me.api,
        "subscribeMessages",
        (original) => (roomId, fn) =>
          original(roomId, (action, rec) => {
            seen.push(rec.id);
            fn(action, rec);
          }),
      );
      const net = instrument(me.api);
      const release = net.hold("page");
      start(room);
      await subscribed(me.api);
      const early = await say(other, room, "early bird");
      await vi.waitFor(() => expect(seen).toContain(early.id));
      expect(state().phase).toBe("loading");
      release();
      await ready();
      expect(ids().filter((id) => id === early.id)).toHaveLength(1);
    });

    it("opened again at once (the same room remounted), it still gets live messages", async () => {
      const room = await newRoom();
      await open(room);
      // The next view subscribes once the old one has unsubscribed, before that was sent: to the server nothing changed,
      // yet the new listener must still be bound.
      scope.dispose();
      await Promise.resolve();
      await open(room);
      const m = await say(me, room, "still live");
      await vi.waitFor(() => expect(ctl.find(m.id)).toBeDefined());
    });

    it("after the scope ends, nothing changes and nothing is reported", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      scope.dispose();
      const n = changes.length;
      await say(other, room, "late");
      await sleep(100);
      expect(changes).toHaveLength(n);
      expect(ids()).toEqual([]);
    });
  });

  // ---- the window ----

  describe("the window (§7.5)", () => {
    it("walks back to the very first message, never holding more than 300", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 1000);
      await open(room);
      let max = 0;
      for (let i = 0; i < 30 && state().win.hasOlder; i++) {
        await ctl.loadEdge("top");
        max = Math.max(max, ids().length);
        contiguous(all);
      }
      expect(state().win).toMatchObject({ hasOlder: false, hasNewer: true });
      expect(ids()[0]).toBe(all[0]!.id);
      expect(max).toBeLessThanOrEqual(300);
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("walks forward again to the live edge", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 450);
      await open(room, all[10]!.id);
      for (let i = 0; i < 20 && state().win.hasNewer; i++) {
        await ctl.loadEdge("bottom");
        expect(ids().length).toBeLessThanOrEqual(300);
        contiguous(all);
      }
      expect(state().win.hasNewer).toBe(false);
      expect(ids().at(-1)).toBe(all.at(-1)!.id);
    });

    it("runs one request per end at a time", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 200);
      const net = instrument(me.api);
      await open(room);
      const release = net.hold("page");
      // Counted from here: under load a reconnect may already have refetched a page.
      const before = net.calls("page");
      const a = ctl.loadEdge("top");
      const b = ctl.loadEdge("top");
      expect(net.calls("page")).toBe(before + 1); // one older page for both
      release();
      await Promise.all([a, b]);
      expect(ids()).toHaveLength(100);
    });

    it("jumps to the first or latest page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await open(room);
      await ctl.jump("first");
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(state().win).toMatchObject({ hasOlder: false, hasNewer: true });
      expect(changes.at(-1)).toEqual({ render: {}, notice: "", scroll: "top" });
      await ctl.jump("latest");
      expect(ids()).toEqual(all.slice(250).map((m) => m.id));
      expect(changes.at(-1)?.scroll).toBe("bottom");
    });

    it("discards a page that arrives after a jump", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      await open(room);
      // Each page response waits for its gate, released in an order the test chooses.
      const gates: (() => void)[] = [];
      intercept(me.api, "page", (original) => async (q, signal) => {
        const gate = new Promise<void>((r) => gates.push(r));
        const res = await original(q, signal);
        await gate;
        return res;
      });
      const stale = ctl.loadEdge("top");
      const jump = ctl.jump("first");
      gates[1]!(); // the jump's page arrives first…
      await jump;
      gates[0]!(); // …then the older page
      await stale;
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(state().win.hasOlder).toBe(false);
    });

    it("a jump during the first load wins over the late first page, and the room still becomes ready", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((r) => (releaseFirst = r));
      let n = 0;
      intercept(me.api, "page", (original) => async (q, signal) => {
        const res = await original(q, signal);
        if (n++ === 0) await firstHeld; // only the first load's page is slow
        return res;
      });
      start(room);
      await vi.waitFor(() => expect(n).toBe(1));
      await ctl.jump("first");
      expect(state().phase).toBe("loading");
      releaseFirst();
      await ready();
      expect(ids()).toEqual(all.slice(0, 50).map((m) => m.id));
      expect(changes.at(-1)?.scroll).toBeUndefined(); // the jump has positioned the list already
    });
  });

  // ---- realtime ----

  describe("realtime and the pill", () => {
    it("at the bottom, a new message is appended and followed", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      const m = await say(other, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      expect(state().pill).toBeNull();
    });

    it("scrolled up, a new message keeps the view in place and shows 'below' until dismissed", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      nearBottom = false;
      const m = await say(other, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
      expect(state().pill).toBe("below");
      ctl.dismissPill();
      expect(state().pill).toBeNull();
    });

    it("scrolled up, my own message (from another tab) is still followed", async () => {
      const room = await newRoom();
      await open(room);
      nearBottom = false;
      const m = await say(me, room);
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      expect(changes.at(-1)?.scroll).toBe("bottom");
    });

    it("a message changed in place keeps the list at the bottom, or in place when scrolled up (QA BUG-109)", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      const m = await say(other, room, "see https://example.com");
      await vi.waitFor(() => expect(ids()).toEqual([m.id]));
      // Growing (a reaction row, a longer text, link previews) must not slide it under the composer.
      await other.api.react(m.id, "👍", true);
      await vi.waitFor(() => expect(ctl.find(m.id)?.reactions).toHaveLength(1));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      expect(ctl.react(m.id, "👍", true)).not.toBeNull();
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      nearBottom = false;
      await other.api.edit(m.id, "see https://example.com\nand more");
      await vi.waitFor(() => expect(ctl.find(m.id)?.text).toContain("and more"));
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("in a background tab, a new message (even my own from another tab) keeps the view in place and shows 'below'", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await open(room);
      store.set({ away: true });
      const a = await say(other, room);
      await vi.waitFor(() => expect(ids()).toEqual([a.id]));
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
      const b = await say(me, room);
      await vi.waitFor(() => expect(ids()).toEqual([a.id, b.id]));
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
      expect(state().pill).toBe("below");
    });

    it("away from the live edge, a new message is not appended: the pill says 'history' until a jump", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await open(room, all[20]!.id);
      const m = await say(other, room);
      await vi.waitFor(() => expect(state().pill).toBe("history"));
      expect(ids()).not.toContain(m.id);
      ctl.dismissPill(); // only dismisses "below"
      expect(state().pill).toBe("history");
      await ctl.jump("latest");
      expect(state().pill).toBeNull();
      expect(ids().at(-1)).toBe(m.id);
    });

    it("edits and deletes apply to messages in the window; others are ignored", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const typo = await say(other, room, "tpyo");
      const gone = await say(other, room, "gone");
      await open(room);
      nearBottom = false; // scrolled up: what is on screen stays put (at the bottom it stays at the bottom)
      await other.api.edit(typo.id, "typo");
      await other.api.softDelete(gone.id);
      await vi.waitFor(() => expect(ctl.find(gone.id)?.deleted).toBe(true));
      expect(ctl.find(typo.id)?.text).toBe("typo");
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("a live reply quotes the message in the window, and keeps the quote through an edit", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const original = await say(other, room, "the original");
      const events: Message[] = [];
      intercept(
        me.api,
        "subscribeMessages",
        (subscribe) => (roomId, fn) =>
          subscribe(roomId, (a, m) => {
            events.push(m);
            fn(a, m);
          }),
      );
      await open(room);
      const fetched = vi.spyOn(me.api, "getMessage");
      const reply = await other.api.send({ id: newId(), room: room.id, text: "a reply", replyTo: original.id });
      await vi.waitFor(() => expect(ctl.find(reply.id)?.expand?.reply_to?.text).toBe("the original"));
      // The server no longer sends it with live events (docs/PERF.md §2.3).
      expect(events.find((m) => m.id === reply.id)?.expand?.reply_to).toBeUndefined();
      expect(ctl.find(reply.id)?.expand?.reply_to?.expand?.author?.name).toBe("Other");
      await other.api.edit(reply.id, "a reply, edited");
      await vi.waitFor(() => expect(ctl.find(reply.id)?.text).toBe("a reply, edited"));
      expect(ctl.find(reply.id)?.expand?.reply_to?.text).toBe("the original");
      expect(fetched).not.toHaveBeenCalled();
    });

    it("a live reply to a message beyond the window fetches its quote, once", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 120);
      await open(room);
      expect(ids()).not.toContain(all[0]!.id);
      const fetched = vi.spyOn(me.api, "getMessage");
      const reply = await other.api.send({ id: newId(), room: room.id, text: "way back", replyTo: all[0]!.id });
      await vi.waitFor(() => expect(ctl.find(reply.id)?.expand?.reply_to?.text).toBe(all[0]!.text));
      expect(fetched).toHaveBeenCalledTimes(1);
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
    });
  });

  // ---- reconnects ----

  describe("reconnects (§7.5)", () => {
    it("at the live edge, fetches everything missed while disconnected, in order", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 20);
      const gate = gateRealtime(me.api);
      const net = instrument(me.api);
      await open(room);
      gate.offline = true;
      const missed: Message[] = [];
      for (let i = 0; i < 80; i++) missed.push(await say(other, room, `missed ${i}`));
      await vi.waitFor(() => expect(gate.dropped).toBe(80));
      gate.offline = false;
      const pages = net.calls("page");
      net.reconnect();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(missed.at(-1)!.id));
      expect(ids().slice(-80)).toEqual(missed.map((m) => m.id));
      expect(net.calls("page") - pages).toBe(2); // 50 + 30
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
    });

    it("scrolled into history, fetches no new pages", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      const net = instrument(me.api);
      await open(room, all[10]!.id);
      const pages = net.calls("page");
      net.reconnect();
      await vi.waitFor(() => expect(net.calls("changes")).toBe(1));
      expect(net.calls("page")).toBe(pages);
    });

    it("BUG-01: applies edits and deletes missed while disconnected, also scrolled into history", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      const [secret, typo] = [all[10]!, all[11]!];
      const gate = gateRealtime(me.api);
      const net = instrument(me.api);
      await open(room, typo.id);
      expect(state().win.hasNewer).toBe(true);
      gate.offline = true;
      await me.api.softDelete(secret.id);
      await me.api.edit(typo.id, "typo");
      await vi.waitFor(() => expect(gate.dropped).toBe(2));
      expect(ctl.find(secret.id)?.deleted).toBe(false); // missed
      gate.offline = false;
      net.reconnect();
      await vi.waitFor(() => expect(ctl.find(secret.id)?.deleted).toBe(true));
      expect(ctl.find(typo.id)?.text).toBe("typo");
      expect(ctl.find(typo.id)?.edited_at).not.toBe("");
    });
  });

  // ---- sending ----

  describe("sending (§7.5)", () => {
    it("shows a pending copy at once, then the server's, never both", async () => {
      const room = await newRoom();
      await open(room);
      expect(ctl.send("hello")).toBe(true);
      const [pending] = state().win.items;
      expect(pending).toMatchObject({ text: "hello", status: "pending", author: me.user.id });
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      await vi.waitFor(() => expect(state().win.items[0]!.status).toBeUndefined());
      await sleep(50); // the realtime echo of our own create
      expect(ids()).toEqual([pending!.id]);
    });

    it("from history, jumps to the latest page first", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await open(room, all[10]!.id);
      ctl.send("from the past");
      await vi.waitFor(() => expect(state().win.items.at(-1)?.text).toBe("from the past"));
      expect(state().win.hasNewer).toBe(false);
      expect(ids()).toContain(all.at(-1)!.id);
    });

    it("not in an archived room", async () => {
      const room = await newRoom();
      await me.api.setArchived(room.id, true);
      await open(room);
      expect(ctl.send("hello")).toBe(false);
      expect(ids()).toEqual([]);
    });

    it("a failed send is marked failed; retrySend uses the same id; discard drops it", async () => {
      const room = await newRoom();
      const net = instrument(me.api);
      await open(room);
      net.failNext("send", new ApiError("Failed to fetch", 0));
      net.failNext("send", new ApiError("Failed to fetch", 0));
      ctl.send("try again");
      await vi.waitFor(() => expect(state().win.items[0]?.status).toBe("failed"));
      const id = ids()[0]!;
      await ctl.retrySend(id);
      expect(ctl.find(id)?.status).toBe("failed");
      await ctl.retrySend(id);
      expect(ctl.find(id)).toMatchObject({ text: "try again" });
      expect(ctl.find(id)?.status).toBeUndefined();

      net.failNext("send", new ApiError("Failed to fetch", 0));
      ctl.send("never mind");
      await vi.waitFor(() => expect(state().win.items.at(-1)?.status).toBe("failed"));
      ctl.discard(ids().at(-1)!);
      expect(ids()).toEqual([id]);
    });
  });

  // ---- edit / delete ----

  describe("edit and delete (§7.6)", () => {
    it("edit shows the new text at once and keeps the server's copy", async () => {
      const room = await newRoom();
      const m = await say(me, room, "tpyo");
      await open(room);
      const saving = ctl.edit(m.id, "typo");
      expect(ctl.find(m.id)?.text).toBe("typo");
      expect(await saving).toBe(true);
      expect(ctl.find(m.id)?.edited_at).not.toBe("");
    });

    it("edit returns null when there is nothing to save: unchanged, someone else's, or deleted", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = await say(me, room, "same");
      const theirs = await say(other, room, "theirs");
      await open(room);
      expect(ctl.edit(mine.id, "same")).toBeNull();
      expect(ctl.edit(theirs.id, "mine now")).toBeNull();
      expect(ctl.editable(theirs)).toBe(false);
      expect(await ctl.remove(mine.id)).toBe(true);
      expect(ctl.edit(mine.id, "back")).toBeNull();
      expect(ctl.lastEditable()).toBeUndefined();
    });

    it("a failed edit or delete puts the old message back and resolves false", async () => {
      const room = await newRoom();
      const m = await say(me, room, "original");
      const net = instrument(me.api);
      await open(room);
      nearBottom = false;
      net.failNext("edit", new ApiError("Failed to fetch", 0));
      const saving = ctl.edit(m.id, "changed");
      expect(ctl.find(m.id)?.text).toBe("changed");
      expect(await saving).toBe(false);
      expect(ctl.find(m.id)).toMatchObject({ text: "original", edited_at: "" });

      net.failNext("softDelete", new ApiError("Failed to fetch", 0));
      const deleting = ctl.remove(m.id);
      expect(ctl.find(m.id)).toMatchObject({ text: "", deleted: true });
      expect(await deleting).toBe(false);
      expect(ctl.find(m.id)).toMatchObject({ text: "original", deleted: false });
      expect(changes.at(-1)).toEqual({ render: { anchor: true } });
    });

    it("lastEditable is my newest message, skipping deleted ones", async () => {
      const room = await newRoom();
      const older = await say(me, room, "older");
      const newest = await say(me, room, "newest");
      await open(room);
      expect(ctl.lastEditable()?.id).toBe(newest.id);
      await ctl.remove(newest.id);
      expect(ctl.lastEditable()?.id).toBe(older.id);
    });
  });
  describe("reactions (§20.3)", () => {
    const shown = (id: string) => ctl.reactions(ctl.find(id)!).map((r) => [r.emoji, r.users.length]);

    it("mine shows at once and stays while it is on its way, over copies of the message that don't have it yet", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await say(me, room);
      // Hold my request before it reaches the server: copies from the server meanwhile don't have my reaction.
      let send!: () => void;
      const gate = new Promise<void>((r) => (send = r));
      intercept(me.api, "react", (original) => async (...args) => {
        await gate;
        return original(...args);
      });
      await open(room);
      const saving = ctl.react(m.id, "👍", true)!;
      expect(shown(m.id)).toEqual([["👍", 1]]);
      await other.api.react(m.id, "🎉", true);
      await vi.waitFor(() => expect(ctl.find(m.id)!.reactions).toEqual([{ emoji: "🎉", users: [other.user.id] }]));
      expect(shown(m.id)).toEqual([
        ["🎉", 1],
        ["👍", 1],
      ]);
      send();
      expect(await saving).toBe(true);
      expect(ctl.find(m.id)!.reactions).toEqual([
        { emoji: "🎉", users: [other.user.id] },
        { emoji: "👍", users: [me.user.id] },
      ]);
      expect(shown(m.id)).toEqual([
        ["🎉", 1],
        ["👍", 1],
      ]);
    });

    it("not on messages that aren't saved, are deleted, or are in an archived room", async () => {
      const room = await newRoom();
      const m = await say(me, room);
      const gone = await say(me, room);
      await me.api.softDelete(gone.id);
      await open(room);
      expect(ctl.react(gone.id, "👍", true)).toBeNull();
      expect(ctl.react("nosuchmessage00", "👍", true)).toBeNull();
      await me.api.setArchived(room.id, true);
      store.set(upsertRoom({ ...store.get().rooms.get(room.id)!, archived: true }));
      expect(ctl.reactable(ctl.find(m.id)!)).toBe(false);
      expect(ctl.react(m.id, "👍", true)).toBeNull();
    });

    it("a change that failed after I changed that reaction again isn't a failure: the later change says how it went", async () => {
      const room = await newRoom();
      const m = await say(me, room);
      let fail!: () => void;
      const failing = new Promise<never>((_, reject) => (fail = () => reject(new ApiError("offline", 0))));
      let calls = 0;
      intercept(
        me.api,
        "react",
        (original) =>
          (...args) =>
            ++calls === 1 ? failing : original(...args),
      );
      await open(room);
      const first = ctl.react(m.id, "👍", true)!;
      await vi.waitFor(() => expect(calls).toBe(1)); // on its way
      const second = ctl.react(m.id, "👍", false)!;
      fail();
      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(shown(m.id)).toEqual([]);
    });

    it("the answer brings the whole message: an edit I missed (realtime down) isn't hidden behind it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await say(other, room, "before");
      const gate = gateRealtime(me.api);
      await open(room);
      gate.offline = true;
      await other.api.edit(m.id, "after");
      expect(await ctl.react(m.id, "👍", true)).toBe(true);
      expect(ctl.find(m.id)).toMatchObject({ text: "after", reactions: [{ emoji: "👍", users: [me.user.id] }] });
      expect(ctl.find(m.id)!.expand?.author?.name).toBe("Other");
    });
  });

  describe("room cache (§7.5)", () => {
    beforeEach(() => {
      cache = memoryCache();
    });

    /** Visit the room once, so its latest page is kept. */
    async function visit(room: Room) {
      await open(room);
      scope.dispose();
    }

    it("shows the room as it was last time while the first page loads, then the page", async () => {
      const room = await newRoom();
      const before = await seedMessages(room.id, me.user.id, 60);
      await visit(room);
      expect(cache!.rooms.get(room.id)).toMatchObject({ user: me.user.id, hasOlder: true });
      expect(cache!.rooms.get(room.id)!.items.map((m) => m.id)).toEqual(before.slice(10).map((m) => m.id));
      const later = await say(me, room, "later");
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state()).toMatchObject({ phase: "ready", stale: true }));
      expect(ids()).toEqual(before.slice(10).map((m) => m.id));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(ids().at(-1)).toBe(later.id);
      expect(ids()).toHaveLength(50);
    });

    it("scrolled up over the kept window, the page doesn't take you to the bottom", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 60);
      await visit(room);
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      nearBottom = false;
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(changes.at(-1)).toEqual({ render: { anchor: true }, notice: "" });
    });

    it("QA BUG-96: shown at the first unread message, the page leaves the list where it is, even at the bottom", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      const all = await seedMessages(room.id, other.user.id, 60, { stepMs: 1, startAt: Date.now() - 100 });
      await me.api.markRead(room.id, all[49]!.created);
      cache!.put(me.user.id, room.id, { items: all.slice(10), hasOlder: true, unread: 10 });
      store.set({ unread: new Map([[room.id, 10]]) });
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state()).toMatchObject({ stale: true, unreadId: all[50]!.id }));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "target" });
      nearBottom = true; // scrolled down to the end meanwhile
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(changes.at(-1)).toEqual({ render: { anchor: true }, notice: "" });
    });

    it("with the count in, opens the kept window at the first unread message without waiting for the server", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      const all = await seedMessages(room.id, other.user.id, 30, { stepMs: 1, startAt: Date.now() - 100 });
      await me.api.markRead(room.id, all[26]!.created);
      store.set({ ...upsertRoom(room)(store.get()), unread: new Map([[room.id, 3]]) });
      cache!.put(me.user.id, room.id, { items: all, hasOlder: false, unread: 3 });
      const net = instrument(me.api);
      const release = [net.hold("firstUnread"), net.hold("page"), net.hold("getRoom")];
      start(room);
      await vi.waitFor(() => expect(state()).toMatchObject({ stale: true, unreadId: all[27]!.id }));
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "target" });
      // Live first: a subscription still pending when the page is in adds a catch-up page (QA BUG-61), which under load
      // made this count 2.
      await subscribed(me.api);
      for (const r of release) r();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(state().unreadId).toBe(all[27]!.id);
      // A few unread: the latest page has them, so it is the only page asked for (not the pages around the first).
      expect(net.calls("page")).toBe(1);
    });

    it("after a reload (no counts, no room list yet), the kept window and room show at once, then the server's first unread", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      const all = await seedMessages(room.id, other.user.id, 30, { stepMs: 1, startAt: Date.now() - 100 });
      await me.api.markRead(room.id, all[26]!.created);
      store.set({ unread: UNCOUNTED });
      cache!.put(me.user.id, room.id, { items: all, hasOlder: false, room });
      const net = instrument(me.api);
      const unreadAt = net.hold("firstUnread");
      const rest = [net.hold("page"), net.hold("getRoom")];
      start(room);
      await vi.waitFor(() => expect(state()).toMatchObject({ stale: true, unreadId: null }));
      expect(store.get().rooms.get(room.id)?.name).toBe(room.name);
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "bottom" });
      // QA BUG-102: shown at the bottom, but the unread messages may start further up: nothing is read yet.
      expect(state().unsure).toBe(true);
      unreadAt();
      await vi.waitFor(() => expect(state().unreadId).toBe(all[27]!.id));
      expect(state().unsure).toBe(false);
      expect(changes.at(-1)).toEqual({ render: {}, scroll: "target" });
      for (const r of rest) r();
      await vi.waitFor(() => expect(state().stale).toBe(false));
    });

    it("QA BUG-102: after a reload with nothing unread, the kept window is read once the server says so", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 3);
      store.set({ unread: UNCOUNTED });
      cache!.put(me.user.id, room.id, { items: all, hasOlder: false, room });
      const net = instrument(me.api);
      const unreadAt = net.hold("firstUnread");
      const page = net.hold("page");
      start(room);
      await vi.waitFor(() => expect(state()).toMatchObject({ stale: true, unsure: true }));
      const before = changes.length;
      unreadAt();
      await vi.waitFor(() => expect(state().unsure).toBe(false));
      expect(changes.slice(before)).toContainEqual({ render: { anchor: true } }); // the view reports what it shows now
      page();
      await vi.waitFor(() => expect(state().stale).toBe(false));
    });

    it("after a reload with more unread than were kept, the page goes to the first of them", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      const all = await seedMessages(room.id, other.user.id, 120, { stepMs: 1, startAt: Date.now() - 200 });
      await me.api.markRead(room.id, all[9]!.created);
      store.set({ unread: UNCOUNTED });
      cache!.put(me.user.id, room.id, { items: all.slice(-50), hasOlder: true, room });
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      await sleep(50); // the server has said where they start
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(state().unreadId).toBe(all[10]!.id);
      expect(changes.at(-1)).toMatchObject({ render: {}, scroll: "target" });
    });

    it("QA BUG-99: a count the kept page wasn't prefetched with (a message just came) waits for the server", async () => {
      const other = await signedUp("Other");
      const room = await newRoom(other);
      await sleep(20);
      const all = await seedMessages(room.id, other.user.id, 30, { stepMs: 1, startAt: Date.now() - 100 });
      await me.api.markRead(room.id, all[26]!.created);
      store.set({ ...upsertRoom(room)(store.get()), unread: new Map([[room.id, 3]]) });
      // Kept when only one was unread (or when you left, with none): the count would point at a message already read.
      cache!.put(me.user.id, room.id, { items: all.slice(0, 28), hasOlder: false, unread: 1 });
      const release = instrument(me.api).hold("page");
      start(room);
      await sleep(100);
      expect(state()).toMatchObject({ phase: "loading", unreadId: null });
      release();
      await vi.waitFor(() => expect(state()).toMatchObject({ phase: "ready", unreadId: all[27]!.id }));
    });

    it("QA BUG-98: a room that isn't there any more is forgotten, so it isn't shown again", async () => {
      // Not found (a reload, access lost while the app was closed): shown from the cache until the server says so.
      const gone = await newRoom();
      await seedMessages(gone.id, me.user.id, 3);
      cache!.put(me.user.id, "nosuchroom00000", {
        items: (await me.api.page(latest(gone.id))).map((m) => ({ ...m, room: "nosuchroom00000" })),
        hasOlder: false,
        room: { ...gone, id: "nosuchroom00000" },
      });
      start("nosuchroom00000");
      await vi.waitFor(() => expect(state().phase).toBe("not-found"));
      scope.dispose();
      expect(cache!.rooms.get("nosuchroom00000")!.items).toEqual([]);
      // Lost while in it (§23.4): the room list no longer has it.
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 3);
      await open(room);
      store.set({ rooms: new Map(), roomsStatus: "ready" });
      scope.dispose();
      expect(cache!.rooms.get(room.id)!.items).toEqual([]);
    });

    it("QA BUG-97: leaving the page keeps the window at once, not a second later", async () => {
      const room = await newRoom();
      await open(room);
      await say(me, room, "just now");
      await vi.waitFor(() => expect(ids()).toHaveLength(1));
      dispatchEvent(new Event("pagehide"));
      expect(cache!.rooms.get(room.id)!.items.map((m) => m.text)).toEqual(["just now"]);
    });

    it("QA BUG-100: what I send or edit while the kept window shows survives the page asked for before it", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await visit(room);
      const gate = gateRealtime(me.api); // no echo: the subscription isn't there yet
      gate.offline = true;
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      const old = state().win.items[2]!;
      expect(ctl.send("sent meanwhile")).toBe(true);
      await vi.waitFor(() =>
        expect(state().win.items.at(-1)).toMatchObject({ text: "sent meanwhile", updated: expect.stringMatching(/./) }),
      );
      await vi.waitFor(() => expect(state().win.items.at(-1)!.status).toBeUndefined());
      expect(await ctl.edit(old.id, "edited meanwhile")).toBe(true);
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(state().win.items.at(-1)!.text).toBe("sent meanwhile");
      expect(ctl.find(old.id)!.text).toBe("edited meanwhile");
      expect(ids()).toHaveLength(6);
    });

    it("QA BUG-103: the first page's copies replace the kept ones that are no newer: an author's new name or avatar shows", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await visit(room);
      const kept = cache!.rooms.get(room.id)!;
      // Copies from before a rename: kept with the tag of that page, which the server no longer gives.
      kept.tag = '"before"';
      for (const m of kept.items) m.expand = { author: { ...me.user, name: "Old name" } };
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      expect(state().win.items[0]!.expand?.author?.name).toBe("Old name");
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(state().win.items.map((m) => m.expand?.author?.name)).toEqual(Array(5).fill(me.user.name));
    });

    it("a reconnect while the kept window shows leaves it to the first page", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await visit(room);
      const net = instrument(me.api);
      const release = net.hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      net.reconnect();
      await sleep(50);
      expect(net.calls("page")).toBe(1);
      expect(net.calls("changes")).toBe(0);
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
    });

    it("a room the loaded room list lacks waits for the server, kept room or not", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await visit(room);
      store.set({ rooms: new Map(), roomsStatus: "ready" });
      const release = instrument(me.api).hold("getRoom");
      start(room);
      await sleep(50);
      expect(state()).toMatchObject({ phase: "loading", stale: false });
      release();
      await ready();
    });

    it("a message that arrives while the kept window shows survives the page", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await visit(room);
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      await subscribed(me.api);
      const m = await say(me, room, "meanwhile");
      await vi.waitFor(() => expect(ctl.find(m.id)).toBeDefined());
      release();
      await vi.waitFor(() => expect(state().stale).toBe(false));
      expect(ctl.find(m.id)).toMatchObject({ text: "meanwhile" });
    });

    it("older history waits for the page, then loads", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 120);
      await visit(room);
      const release = instrument(me.api).hold("page");
      start(room);
      await vi.waitFor(() => expect(state().stale).toBe(true));
      await ctl.loadEdge("top");
      expect(ids()).toHaveLength(50);
      release();
      await vi.waitFor(() => expect(ids()).toHaveLength(100));
      contiguous(all);
    });

    it("another user's room isn't shown", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      cache!.put("someoneelse123", room.id, { items: [await say(me, room)], hasOlder: false });
      const release = instrument(me.api).hold("page");
      start(room);
      await sleep(200);
      expect(state()).toMatchObject({ phase: "loading", stale: false });
      release();
    });

    it("nothing is kept once the user has changed (a logout, another user)", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 5);
      await open(room);
      store.set({ user: null });
      scope.dispose();
      expect(cache!.rooms.size).toBe(0);
    });

    it("a window back in history isn't kept", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 120);
      await open(room);
      await ctl.jump("first");
      scope.dispose();
      expect(cache!.rooms.size).toBe(0);
    });
  });
});
