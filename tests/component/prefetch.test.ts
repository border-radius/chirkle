import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Room } from "../../web/src/lib/types.ts";
import { createPrefetch, type Prefetch } from "../../web/src/prefetch.ts";
import { type AppState, bumpUnread, clearUnread, createStore, initialState, type Store } from "../../web/src/store.ts";
import { type Controls, instrument, intercept, memoryCache, type SignedUp, seedMessages, signedUp, uniq } from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("prefetching rooms with unread messages (§7.5)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let cache: ReturnType<typeof memoryCache>;
  let net: Controls;
  let prefetch: Prefetch;
  let room: Room;
  /**
   * The rooms whose message events reach prefetching: this test's. Public rooms are everyone's, so a message deleted by
   * another test file meanwhile would fetch its room too, one more `page` call than a test counts (QA pass 14).
   */
  let ours: Set<string>;

  beforeEach(async () => {
    me = await signedUp("Me");
    ours = new Set();
    intercept(me.api, "createRoom", (original) => async (...args) => {
      const r = await original(...args);
      ours.add(r.id);
      return r;
    });
    intercept(me.api, "subscribeAllMessages", (original) => (fn) => original((action, m) => ours.has(m.room) && fn(action, m)));
    room = await me.api.createRoom(`room-${uniq()}`);
    store = createStore<AppState>({ ...initialState(), user: me.user });
    cache = memoryCache();
    net = instrument(me.api);
    prefetch = createPrefetch({ api: me.api, store, cache, delayMs: 20, gapMs: 0 });
    prefetch.start();
  });
  afterEach(() => prefetch.stop());

  it("keeps the latest page of a room whose unread count went up", async () => {
    const all = await seedMessages(room.id, me.user.id, 60);
    store.set(bumpUnread(room.id));
    await vi.waitFor(() => expect(cache.rooms.get(room.id)).toBeDefined());
    const kept = cache.rooms.get(room.id)!;
    // With the count it was fetched for: the room view works out the first unread message from it only while it holds.
    expect(kept).toMatchObject({ user: me.user.id, hasOlder: true, unread: 1 });
    expect(new Set(kept.items.map((m) => m.id))).toEqual(new Set(all.slice(10).map((m) => m.id)));
  });

  describe("a room's link pressed or pointed at (PERF.md §5)", () => {
    it("asks for the latest page once, for the room to take once, and keeps it", async () => {
      const all = await seedMessages(room.id, me.user.id, 3);
      prefetch.hint(room.id);
      prefetch.hint(room.id); // pressed after pointed at: the same request
      expect(net.calls("page")).toBe(1);
      const page = await prefetch.take(room.id)!;
      expect(page.items.map((m) => m.id).sort()).toEqual(all.map((m) => m.id).sort());
      expect(page.tag).toMatch(/^"\w+"$/);
      expect(prefetch.take(room.id)).toBeUndefined();
      expect(cache.rooms.get(room.id)).toMatchObject({ tag: page.tag });
    });

    it("an unchanged room answers 304: the kept page, nothing kept again", async () => {
      await seedMessages(room.id, me.user.id, 3);
      prefetch.hint(room.id);
      const first = await prefetch.take(room.id)!;
      const kept = cache.rooms.get(room.id);
      await sleep(5100); // EARLY_MS: asked again
      prefetch.hint(room.id);
      const again = await prefetch.take(room.id)!;
      expect(again.tag).toBe(first.tag);
      expect(again.items.map((m) => m.id)).toEqual(first.items.map((m) => m.id));
      expect(cache.rooms.get(room.id)).toBe(kept);
    }, 15_000);

    it("not for the open room, nor signed out", async () => {
      store.set({ activeRoomId: room.id });
      prefetch.hint(room.id);
      store.set({ activeRoomId: null, user: null });
      prefetch.hint(room.id);
      expect(net.calls("page")).toBe(0);
      expect(prefetch.take(room.id)).toBeUndefined();
    });
  });

  it("a burst of messages in a room is one fetch", async () => {
    await seedMessages(room.id, me.user.id, 3);
    for (let i = 0; i < 5; i++) store.set(bumpUnread(room.id));
    await vi.waitFor(() => expect(cache.rooms.get(room.id)).toBeDefined());
    await sleep(100);
    expect(net.calls("page")).toBe(1);
  });

  it("leaves the open room alone, and a count going down", async () => {
    store.set({ activeRoomId: room.id });
    store.set(bumpUnread(room.id));
    await sleep(100);
    expect(net.calls("page")).toBe(0);
    store.set({ activeRoomId: null, unread: new Map([[room.id, 3]]) });
    await vi.waitFor(() => expect(net.calls("page")).toBe(1));
    store.set({ unread: new Map([[room.id, 2]]) });
    store.set(clearUnread(room.id));
    await sleep(100);
    expect(net.calls("page")).toBe(1);
  });

  it("keeps nothing once stopped (the session ended), even what was on its way", async () => {
    await seedMessages(room.id, me.user.id, 3);
    const release = net.hold("page");
    store.set(bumpUnread(room.id));
    await vi.waitFor(() => expect(net.calls("page")).toBe(1));
    prefetch.stop();
    release();
    await sleep(100);
    expect(cache.rooms.size).toBe(0);
  });

  it("QA BUG-92: a room that keeps getting messages doesn't put the fetch off (nor the other rooms')", async () => {
    const quiet = await me.api.createRoom(`room-${uniq()}`);
    store.set(bumpUnread(quiet.id));
    // A message every 10 ms (half of DELAY_MS), for ten times DELAY_MS: fetching starts meanwhile.
    for (let i = 0; i < 20; i++) {
      store.set(bumpUnread(room.id));
      await sleep(10);
    }
    expect(net.calls("page")).toBeGreaterThan(0);
    await vi.waitFor(() => expect([...cache.rooms.keys()].sort()).toEqual([quiet.id, room.id].sort()));
    // ...but not once per message.
    expect(net.calls("page")).toBeLessThan(10);
  });

  it("QA BUG-108: a room fetched less than REFETCH_MS ago is fetched again only then, while still unread", async () => {
    prefetch.stop();
    prefetch = createPrefetch({ api: me.api, store, cache, delayMs: 20, gapMs: 0, refetchMs: 400 });
    prefetch.start();
    const read = await me.api.createRoom(`room-${uniq()}`);
    for (const id of [room.id, read.id]) store.set(bumpUnread(id));
    await vi.waitFor(() => expect(net.calls("page")).toBe(2));
    // More messages in both, one at a time: none of them fetches a room at once...
    for (let i = 0; i < 5; i++) {
      for (const id of [room.id, read.id]) store.set(bumpUnread(id));
      await sleep(40);
    }
    expect(net.calls("page")).toBe(2);
    // ...and one of them is read meanwhile: only the other is fetched, once, REFETCH_MS after the first fetch.
    store.set(clearUnread(read.id));
    await vi.waitFor(() => expect(net.calls("page")).toBe(3));
    expect(cache.rooms.get(room.id)?.unread).toBe(6);
    await sleep(600);
    expect(net.calls("page")).toBe(3);
  });

  it("QA BUG-108: a room's first unread message is fetched at once, even if the room just was", async () => {
    prefetch.stop();
    prefetch = createPrefetch({ api: me.api, store, cache, delayMs: 20, gapMs: 0, refetchMs: 60_000 });
    prefetch.start();
    store.set(bumpUnread(room.id));
    await vi.waitFor(() => expect(net.calls("page")).toBe(1));
    store.set(clearUnread(room.id));
    store.set(bumpUnread(room.id));
    await vi.waitFor(() => expect(net.calls("page")).toBe(2));
  });

  it("QA BUG-94: rooms are fetched GAP_MS apart, and a refused fetch leaves the rest", async () => {
    prefetch.stop();
    prefetch = createPrefetch({ api: me.api, store, cache, delayMs: 20, gapMs: 200 });
    prefetch.start();
    const rooms = [room.id, ...(await Promise.all([1, 2, 3].map(() => me.api.createRoom(`room-${uniq()}`)))).map((r) => r.id)];
    store.set({ unread: new Map(rooms.map((id) => [id, 1])) });
    await vi.waitFor(() => expect(net.calls("page")).toBe(1));
    await sleep(100);
    expect(net.calls("page")).toBe(1);
    await vi.waitFor(() => expect(net.calls("page")).toBe(2));
    // The server refuses one (429): the run stops there.
    net.failNext("page", new ApiError("Too many requests.", 429));
    await vi.waitFor(() => expect(net.calls("page")).toBe(3));
    await sleep(500);
    expect(net.calls("page")).toBe(3);
    expect(cache.rooms.size).toBe(2);
  });

  it("QA BUG-95: a message deleted in a room fetches it again, so the cache doesn't show its text", async () => {
    const other = await signedUp("Other");
    const theirs = await other.api.createRoom(`room-${uniq()}`);
    ours.add(theirs.id);
    const m = await other.api.send({ id: newId(), room: theirs.id, text: "my password is hunter2" });
    await vi.waitFor(() => expect(net.calls("subscribeAllMessages")).toBe(1));
    await sleep(200); // the server has the subscription
    await other.api.softDelete(m.id);
    await vi.waitFor(() => expect(cache.rooms.get(theirs.id)?.items).toEqual([expect.objectContaining({ id: m.id, deleted: true })]));
    expect(JSON.stringify(cache.rooms.get(theirs.id))).not.toContain("hunter2");
  });

  it("once the room list is in, fetches the rooms not kept yet: not the kept ones, nor the open one", async () => {
    const kept = await me.api.createRoom(`room-${uniq()}`);
    const open = await me.api.createRoom(`room-${uniq()}`);
    await seedMessages(room.id, me.user.id, 3);
    cache.put(me.user.id, kept.id, { items: [], hasOlder: false });
    store.set({ activeRoomId: open.id, rooms: new Map([room, kept, open].map((r) => [r.id, r])), roomsStatus: "ready" });
    await vi.waitFor(() => expect(cache.rooms.get(room.id)?.items).toHaveLength(3));
    await sleep(100);
    expect(net.calls("page")).toBe(1);
    expect(cache.rooms.has(open.id)).toBe(false);
    // Once per start: the list loading again fetches nothing more.
    store.set({ roomsStatus: "loading" });
    store.set({ roomsStatus: "ready" });
    await sleep(100);
    expect(net.calls("page")).toBe(1);
  });

  it("a room whose count goes up meanwhile is fetched before the rest of the rooms not kept yet", async () => {
    prefetch.stop();
    prefetch = createPrefetch({ api: me.api, store, cache, delayMs: 20, gapMs: 100 });
    prefetch.start();
    const cold = await Promise.all([1, 2, 3, 4, 5].map(() => me.api.createRoom(`room-${uniq()}`)));
    store.set({ rooms: new Map(cold.map((r) => [r.id, r])), roomsStatus: "ready" });
    await vi.waitFor(() => expect(cache.rooms.size).toBe(1));
    store.set(bumpUnread(room.id));
    // Next after the one on its way (and DELAY_MS), not after all five.
    await vi.waitFor(() => expect(cache.rooms.has(room.id)).toBe(true));
    expect(cache.rooms.size).toBeLessThan(4);
    await vi.waitFor(() => expect(cache.rooms.size).toBe(6));
  });

  it("doesn't run without a user", async () => {
    prefetch.stop();
    store.set({ user: null });
    prefetch.start();
    store.set(bumpUnread(room.id));
    await sleep(100);
    expect(net.calls("page")).toBe(0);
  });
});
