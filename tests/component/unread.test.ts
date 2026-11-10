import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import { type AppState, createStore, initialState, type Store } from "../../web/src/store.ts";
import { createUnread, type Unread } from "../../web/src/unread.ts";
import {
  instrument,
  intercept,
  newApi,
  READ_WINDOW_MS,
  type SignedUp,
  seedMessages,
  signedUp,
  subscribed,
  TEST_TIMING,
  uniq,
} from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("unread counts (§18.3)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let unread: Unread | undefined;

  beforeEach(async () => {
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    unread?.stop();
    unread = undefined;
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  const start = () => {
    unread = createUnread({ api: me.api, store, timing: TEST_TIMING });
    unread.start();
    return unread;
  };
  const say = (who: SignedUp, room: string, text = "hi") => who.api.send({ id: newId(), room, text });
  const count = (room: string) => store.get().unread.get(room);
  /**
   * Only message events of these rooms reach the service from now on. Public rooms are everyone's, so other test files'
   * traffic arrives too, and a message deleted there rightly refreshes the counts: noise for a test counting requests.
   */
  const onlyRooms = (...rooms: string[]) =>
    intercept(me.api, "subscribeAllMessages", (original) => (fn) => original((action, m) => rooms.includes(m.room) && fn(action, m)));
  /** A room with `n` messages from someone else, all newer than my signup. */
  async function unreadRoom(n: number) {
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`room-${uniq()}`);
    for (let i = 0; i < n; i++) await say(other, r.id);
    return { other, r };
  }

  describe("mentions and the inbox (§41)", () => {
    it("loads each room's unread mentions and replies and the inbox's unseen count, and follows them live", async () => {
      const { other, r } = await unreadRoom(1);
      await say(other, r.id, `@${me.user.handle} look`);
      start();
      await vi.waitFor(() => expect(store.get().mentions.get(r.id)).toBe(1));
      expect(store.get().inbox).toBe(1);
      await subscribed(me.api);
      const mine = await say(me, r.id, "mine");
      await other.api.send({ id: newId(), room: r.id, text: "re", replyTo: mine.id });
      await vi.waitFor(() => expect(store.get().mentions.get(r.id)).toBe(2));
      expect(store.get().inbox).toBe(2);
      // Read: the room's mentions go with its count, and once the read is in, the inbox's count too (seen in the room).
      const last = await say(other, r.id, "after");
      unread!.open(r.id).seen(last.created, true);
      expect(store.get().mentions.has(r.id)).toBe(false);
      expect(count(r.id)).toBeUndefined();
      await vi.waitFor(() => expect(store.get().inbox).toBe(0), { timeout: 5000 });
    });
  });

  describe("counts", () => {
    it("loads the counts", async () => {
      const { r } = await unreadRoom(2);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
    });

    it("leaves the room you are caught up in out of fetched counts (the room view clears it before the server knows)", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const active = await other.api.createRoom(`active-${uniq()}`);
      await say(other, r.id);
      const m = await say(other, active.id);
      store.set({ activeRoomId: active.id });
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(count(active.id)).toBe(1)); // open, but nothing on screen yet: still unread
      unread!.open(active.id).seen(m.created, true);
      expect(count(active.id)).toBeUndefined();
      unread!.refresh(); // before the read is sent
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
      await sleep(50);
      expect(count(r.id)).toBe(1);
      expect(count(active.id)).toBeUndefined();
    });

    it("live: others' messages count, yours and those of the room you are caught up in don't", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const active = await other.api.createRoom(`active-${uniq()}`);
      store.set({ activeRoomId: active.id });
      start();
      const reader = unread!.open(active.id);
      reader.seen("", true);
      await subscribed(me.api);
      await say(other, r.id);
      await say(me, r.id);
      await say(other, active.id);
      // A marker after them: events arrive in order, so once it has counted, the two above have been handled.
      await say(other, r.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      expect(count(active.id)).toBeUndefined();
      // Scrolled up: what arrives stays unread, badge and all (2026-11-02).
      reader.seen("", false);
      await say(other, active.id);
      await vi.waitFor(() => expect(count(active.id)).toBe(1));
    });

    it("the tab away (§22.4): the active room's messages count, live and in fetched counts", async () => {
      const other = await signedUp("Other");
      const active = await other.api.createRoom(`active-${uniq()}`);
      await say(other, active.id);
      store.set({ activeRoomId: active.id, away: true });
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(count(active.id)).toBe(1));
      await subscribed(me.api);
      await say(other, active.id);
      await vi.waitFor(() => expect(count(active.id)).toBe(2));
      // Back, then away again: the counts are refetched, the server having been told what was read meanwhile.
      store.set({ away: false });
      const calls = ctl.calls("unreadCounts");
      store.set({ away: true });
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(calls + 1));
      expect(count(active.id)).toBe(2);
    });

    it("deleting an unread message brings the count down", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      await other.api.softDelete(m.id);
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
    });

    it("reading a room in another tab clears it here", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const m = await say(other, r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
      await subscribed(me.api);
      const otherTab = newApi();
      await otherTab.logIn(me.email, me.password);
      await otherTab.markRead(r.id, m.created);
      await vi.waitFor(() => expect(count(r.id)).toBeUndefined());
    });

    it("a failed load is retried on reconnect", async () => {
      const { r } = await unreadRoom(1);
      const ctl = instrument(me.api);
      ctl.failNext("unreadCounts", new ApiError("Failed to fetch", 0));
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      expect(count(r.id)).toBeUndefined();
      ctl.reconnect();
      await vi.waitFor(() => expect(count(r.id)).toBe(1));
    });

    it("refresh() debounces: several calls in a row make one request", async () => {
      const ctl = instrument(me.api);
      onlyRooms();
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      for (let i = 0; i < 5; i++) unread!.refresh();
      await sleep(TEST_TIMING.refreshMs * 4);
      expect(ctl.calls("unreadCounts")).toBe(2);
    });

    it("a +1 that arrives while counts are being fetched is added on top of the answer, without a refetch", async () => {
      const { other, r } = await unreadRoom(2);
      const ctl = instrument(me.api);
      onlyRooms(r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      const release = ctl.hold("unreadCounts");
      unread!.refresh();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
      await sleep(100); // the held request has been answered by the server
      await say(other, r.id); // so it isn't in that answer
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      release();
      await sleep(TEST_TIMING.refreshMs * 4); // a refetch would have gone out by now
      expect(count(r.id)).toBe(3);
      expect(ctl.calls("unreadCounts")).toBe(2);
    });

    it("QA BUG-106: a message the counts include isn't counted again when its live event comes after them", async () => {
      const { other, r } = await unreadRoom(2);
      // Every event of the room reaches the service 400 ms late, as SSE can under load.
      intercept(
        me.api,
        "subscribeAllMessages",
        (original) => (fn) => original((action, m) => m.room === r.id && void setTimeout(() => fn(action, m), 400)),
      );
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      await say(other, r.id);
      unread!.refresh(); // answered (with 3) before the event arrives
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      await sleep(600);
      expect(count(r.id)).toBe(3);
    });

    it("QA BUG-106: a +1 during the request that the answer accounts for isn't added on top, whatever its time", async () => {
      const { other, r } = await unreadRoom(2);
      onlyRooms(r.id);
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(2));
      await subscribed(me.api);
      // The answer counts the new message, whose event arrives while the answer is on its way. Its `at` says nothing
      // reliable about it (a message is committed some time after its `created`): only `ids` does.
      intercept(me.api, "unreadCounts", (original) => async (signal) => {
        const m = await say(other, r.id);
        const res = await original(signal);
        await vi.waitFor(() => expect(count(r.id)).toBe(3));
        return { ...res, at: m.created.replace(/Z$/, "") }; // just before it, after the previous answer
      });
      unread!.refresh();
      await sleep(TEST_TIMING.refreshMs * 4 + 300);
      expect(count(r.id)).toBe(3);
    });

    it("QA: counts still load in a room that never stops (a message during every count request)", async () => {
      const { other, r } = await unreadRoom(3);
      const real = me.api.unreadCounts.bind(me.api);
      intercept(me.api, "unreadCounts", (original) => async (signal) => {
        const res = await original(signal);
        await say(other, r.id, "tick"); // lands while the answer is on its way
        await sleep(150);
        return res;
      });
      start();
      await vi.waitFor(async () => expect(count(r.id)).toBe((await real()).rooms[r.id]), { timeout: 5000 });
      expect(count(r.id)).toBeGreaterThanOrEqual(4);
    });

    it("stop() ignores a load still in flight", async () => {
      const { r } = await unreadRoom(1);
      const ctl = instrument(me.api);
      const release = ctl.hold("unreadCounts");
      start();
      unread!.stop();
      release();
      await sleep(200);
      expect(count(r.id)).toBeUndefined();
    });
  });

  describe("reading a room (RoomReader)", () => {
    /** Calls to api.markRead, as [room, at]. Their promises go to `sent`, if given, to wait for the answers. */
    function reads(sent: Promise<unknown>[] = []) {
      const calls: [string, string][] = [];
      intercept(me.api, "markRead", (original) => (room, at) => {
        calls.push([room, at]);
        const p = original(room, at);
        sent.push(p.catch(() => {}));
        return p;
      });
      return calls;
    }
    /** A room whose messages (from someone else) are newer than my signup and older than now. */
    async function freshRoom(n: number) {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      await sleep(20);
      const msgs = await seedMessages(r.id, other.user.id, n, { stepMs: 1, startAt: Date.now() - 10 });
      return { r, msgs };
    }

    it("seen() clears the count at once and tells the server after the batching delay, with the newest position", async () => {
      const { r, msgs } = await freshRoom(3);
      const calls = reads();
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, true);
      expect(count(r.id)).toBeUndefined();
      reader.seen(msgs[2]!.created, true);
      reader.seen(msgs[1]!.created, true); // older: ignored
      expect(calls).toEqual([]);
      await vi.waitFor(() => expect(calls).toEqual([[r.id, msgs[2]!.created]]), { timeout: 3000 });
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[r.id]).toBeUndefined());
    });

    it("seen() clears the count even with nothing new (fetched while the tab was away, after the last read)", async () => {
      const { r, msgs } = await freshRoom(1);
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, true);
      store.set({ unread: new Map([[r.id, 1]]) });
      reader.seen(msgs[0]!.created, true);
      expect(count(r.id)).toBeUndefined();
    });

    it("close() sends a pending read right away; caught up, the count stays clear", async () => {
      const { r, msgs } = await freshRoom(1);
      const calls = reads();
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, true);
      reader.close(true);
      expect(calls).toEqual([[r.id, msgs[0]!.created]]);
      expect(count(r.id)).toBeUndefined();
      reader.seen("9999", true); // closed: nothing happens
      await sleep(READ_WINDOW_MS);
      expect(calls).toHaveLength(1);
    });

    it("seen() short of the newest message reads that far: the count stays, and after close() it is what is left", async () => {
      const { r, msgs } = await freshRoom(3);
      const calls = reads();
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, false);
      expect(count(r.id)).toBe(3);
      reader.close(false);
      expect(calls).toEqual([[r.id, msgs[0]!.created]]);
      // Refetched after the read is in, not before it.
      await vi.waitFor(() => expect(count(r.id)).toBe(2), { timeout: 3000 });
    });

    it("2026-11-02: an open room not read to the end keeps its count, brought down to what is left as reads go in", async () => {
      const { r, msgs } = await freshRoom(3);
      store.set({ activeRoomId: r.id });
      start();
      await vi.waitFor(() => expect(count(r.id)).toBe(3));
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, false);
      await vi.waitFor(() => expect(count(r.id)).toBe(2), { timeout: 3000 });
      reader.seen(msgs[1]!.created, false);
      await vi.waitFor(() => expect(count(r.id)).toBe(1), { timeout: 3000 });
      reader.seen(msgs[2]!.created, true);
      expect(count(r.id)).toBeUndefined();
    });

    it("close() when not caught up refetches the counts", async () => {
      const { r } = await freshRoom(1);
      const ctl = instrument(me.api);
      start();
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(1));
      unread!.open(r.id).close(false);
      await vi.waitFor(() => expect(ctl.calls("unreadCounts")).toBe(2));
    });

    it("flush() sends every pending read now (logout)", async () => {
      const a = await freshRoom(1);
      const b = await freshRoom(1);
      const calls = reads();
      start();
      unread!.open(a.r.id).seen(a.msgs[0]!.created, true);
      unread!.open(b.r.id).seen(b.msgs[0]!.created, true);
      unread!.flush();
      expect(calls).toEqual([
        [a.r.id, a.msgs[0]!.created],
        [b.r.id, b.msgs[0]!.created],
      ]);
      unread!.flush();
      expect(calls).toHaveLength(2);
    });

    it("never sends as another user (another tab switched the shared session)", async () => {
      const { r, msgs } = await freshRoom(1);
      const third = await signedUp("Third");
      const calls = reads();
      start();
      const reader = unread!.open(r.id); // for Me
      await me.api.logIn(third.email, third.password); // another tab: the shared session is now Third's
      reader.seen(msgs[0]!.created, true);
      unread!.flush();
      reader.seen("9999-12-31 23:59:59.999Z", true); // a later position: batched, not flushed
      await sleep(READ_WINDOW_MS); // the batched send, too
      reader.close(true);
      expect(calls).toEqual([]);
    });

    it("QA BUG-162: a failed read is sent again by itself, with nothing new on screen", async () => {
      const { r, msgs } = await freshRoom(1);
      const ctl = instrument(me.api);
      ctl.failNext("markRead", new ApiError("Failed to fetch", 0));
      const calls = reads(); // outside the failure, so the failed call is recorded too
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, true);
      unread!.flush();
      expect(calls).toHaveLength(1);
      // No more seen(): the room on screen doesn't change. The retry comes after TEST_TIMING.retryMs.
      await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 3000 });
      expect(calls[1]).toEqual(calls[0]);
      await vi.waitFor(async () => expect((await me.api.unreadCounts()).rooms[r.id]).toBeUndefined());
    });

    it("a refused read (4xx) isn't sent again", async () => {
      const { r, msgs } = await freshRoom(1);
      const ctl = instrument(me.api);
      ctl.failNext("markRead", new ApiError("Forbidden", 403));
      const sent: Promise<unknown>[] = [];
      const calls = reads(sent);
      start();
      unread!.open(r.id).seen(msgs[0]!.created, true);
      unread!.flush();
      await Promise.all(sent);
      await sleep(TEST_TIMING.retryMs * 4);
      expect(calls).toHaveLength(1);
    });

    it("after stop(), readers do nothing (the session is over)", async () => {
      const { r, msgs } = await freshRoom(1);
      const calls = reads();
      start();
      const reader = unread!.open(r.id);
      reader.seen(msgs[0]!.created, true);
      unread!.stop();
      unread!.flush();
      reader.close(true);
      await sleep(READ_WINDOW_MS);
      expect(calls).toEqual([]);
    });
  });
});
