import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../web/src/api.ts";
import type { Room } from "../../web/src/lib/types.ts";
import { type AppState, createStore, initialState, markHidden, type Store, upsertRoom } from "../../web/src/store.ts";
import { createSync, type Sync } from "../../web/src/sync.ts";
import { instrument, intercept, newApi, type SignedUp, signedUp, subscribed, uniq } from "../support/api.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sync (room list + hidden rows)", () => {
  let me: SignedUp;
  let store: Store<AppState>;
  let sync: Sync | undefined;

  beforeEach(async () => {
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    sync?.stop();
    sync = undefined;
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  const start = () => {
    sync = createSync({ api: me.api, store });
    sync.start();
    return sync;
  };
  const ready = () => vi.waitFor(() => expect(store.get().roomsStatus).toBe("ready"));

  it("loads rooms and hidden rows into the store", async () => {
    const r = await me.api.createRoom(`room-${uniq()}`);
    const row = await me.api.hideRoom(r.id);
    expect(store.get().roomsStatus).toBe("idle");
    start();
    expect(store.get().roomsStatus).toBe("loading");
    await ready();
    expect(store.get().rooms.get(r.id)).toEqual(r);
    expect(store.get().hidden.get(r.id)).toBe(row.id);
  });

  it("counts its load in listLoads while it is out (§7.9)", async () => {
    start();
    expect(store.get().listLoads).toBe(1);
    await ready();
    await vi.waitFor(() => expect(store.get().listLoads).toBe(0));
    const reload = sync!.reload();
    expect(store.get().listLoads).toBe(1);
    await reload;
    expect(store.get().listLoads).toBe(0);
  });

  it("applies live room and hidden-row events", async () => {
    start();
    await ready();
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`elsewhere-${uniq()}`);
    await vi.waitFor(() => expect(store.get().rooms.has(r.id)).toBe(true));

    const otherTab = newApi();
    await otherTab.logIn(me.email, me.password);
    const row = await otherTab.hideRoom(r.id);
    await vi.waitFor(() => expect(store.get().hidden.get(r.id)).toBe(row.id));
    await otherTab.unhideRoom(row.id);
    await vi.waitFor(() => expect(store.get().hidden.has(r.id)).toBe(false));
  });

  it("a failed load sets 'error'; reload() recovers", async () => {
    const ctl = instrument(me.api);
    ctl.failNext("listRooms", new ApiError("Failed to fetch", 0));
    start();
    await vi.waitFor(() => expect(store.get().roomsStatus).toBe("error"));
    await sync!.reload();
    expect(store.get().roomsStatus).toBe("ready");
  });

  it("events during a reload aren't undone by its answer, which is older (QA BUG-69: a lost room stayed listed)", async () => {
    const kept = await me.api.createRoom(`room-${uniq()}`);
    const ctl = instrument(me.api);
    start();
    await ready();
    await subscribed(me.api);
    const release = ctl.hold("listRooms");
    const reloading = sync!.reload(); // the server answers with the list as it is now
    await vi.waitFor(() => expect(ctl.calls("listRooms")).toBe(2));
    await sleep(100); // answered, and held here
    await me.api.setArchived(kept.id, true);
    const added = await me.api.createRoom(`room-${uniq()}`);
    await vi.waitFor(() => expect(store.get().rooms.get(kept.id)?.archived).toBe(true));
    await vi.waitFor(() => expect(store.get().rooms.has(added.id)).toBe(true));
    // Views take a room that comes back as a room you were let in again (§23.4): it must not even flicker.
    let flickered = false;
    const off = store.subscribe((st) => {
      if (!st.rooms.has(added.id)) flickered = true;
    });
    release();
    await reloading;
    off();
    expect(store.get().rooms.get(kept.id)?.archived).toBe(true);
    expect(store.get().rooms.has(added.id)).toBe(true);
    expect(flickered).toBe(false);
  });

  it("what this tab did during a reload stays, its event or not (QA BUG-107: a DM just opened vanished)", async () => {
    const shown = await me.api.createRoom(`room-${uniq()}`);
    const ctl = instrument(me.api);
    start();
    await ready();
    await me.api.unsubscribeAll(); // no events: their part is the test above
    const release = ctl.hold("listRooms");
    const reloading = sync!.reload(); // the server answers with the list as it is now
    await vi.waitFor(() => expect(ctl.calls("listRooms")).toBe(2));
    await sleep(100); // answered, and held here
    // As actions.ts does: the room, the DM and the hidden row go into the store when the server says yes.
    const created = await me.api.createRoom(`room-${uniq()}`);
    store.set(upsertRoom(created));
    const other = await signedUp("Other");
    const dm = await me.api.openDm(other.user.id);
    store.set(upsertRoom(dm));
    const row = await me.api.hideRoom(shown.id);
    store.set(markHidden(shown.id, row.id));
    release();
    await reloading;
    expect(store.get().rooms.get(created.id)).toEqual(created);
    expect(store.get().rooms.get(dm.id)).toEqual(dm);
    expect(store.get().hidden.get(shown.id)).toBe(row.id);
  });

  it("an older reload that answers after a newer one is dropped (QA BUG-69)", async () => {
    const r = await me.api.createRoom(`room-${uniq()}`);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    // The first reload's answer (the second listRooms) is held back until the newer one has been applied.
    intercept(me.api, "listRooms", (original) => async (signal) => {
      const rooms = await original(signal);
      if (++calls === 2) await gate;
      return rooms;
    });
    start();
    await ready();
    await me.api.unsubscribeAll(); // no events: only the newer reload can know of the archive
    const older = sync!.reload(); // sees r unarchived
    await vi.waitFor(() => expect(calls).toBe(2));
    await me.api.setArchived(r.id, true);
    await sync!.reload();
    expect(store.get().rooms.get(r.id)?.archived).toBe(true);
    open();
    await older;
    expect(store.get().rooms.get(r.id)?.archived).toBe(true);
  });

  it("on reconnect both lists are reloaded, without going back to 'loading'", async () => {
    const ctl = instrument(me.api);
    start();
    await ready();
    const statuses: string[] = [];
    store.subscribe((s) => statuses.push(s.roomsStatus));
    ctl.reconnect();
    await vi.waitFor(() => expect(ctl.calls("listRooms")).toBe(2));
    expect(ctl.calls("listHidden")).toBe(2);
    expect(statuses).not.toContain("loading");
  });

  it("subscribes once; stop() unsubscribes and later events change nothing", async () => {
    const ctl = instrument(me.api);
    start();
    await ready();
    expect(ctl.calls("subscribeRooms")).toBe(1);
    expect(ctl.calls("subscribeHidden")).toBe(1);
    sync!.stop();
    const other = await signedUp("Other");
    const r = await other.api.createRoom(`after-${uniq()}`);
    await sleep(300);
    expect(store.get().rooms.has(r.id)).toBe(false);
  });

  it("events still in flight after stop() are ignored (unsubscribe is async)", async () => {
    const handlers: ((action: "create", r: Room) => void)[] = [];
    const original = me.api.subscribeRooms.bind(me.api);
    vi.spyOn(me.api, "subscribeRooms").mockImplementation((fn) => {
      handlers.push(fn);
      return original(fn);
    });
    start();
    await ready();
    sync!.stop();
    handlers[0]!("create", { id: "zzzzzzzzzzzzzzz", name: "late", archived: false, created_by: "x" });
    expect(store.get().rooms.has("zzzzzzzzzzzzzzz")).toBe(false);
  });

  it("stop() cancels a load in flight", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const original = me.api.listRooms.bind(me.api);
    vi.spyOn(me.api, "listRooms").mockImplementation((signal) => {
      signals.push(signal);
      return original(signal);
    });
    start();
    sync!.stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  it("a load that finishes after stop() is discarded", async () => {
    const ctl = instrument(me.api);
    const release = ctl.hold("listRooms");
    start();
    sync!.stop();
    release();
    await sleep(100);
    expect(store.get().roomsStatus).toBe("loading");
    expect(store.get().rooms.size).toBe(0);
  });
});
