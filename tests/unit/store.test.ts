import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SITE, type Room } from "../../web/src/lib/types.ts";
import {
  type AppState,
  bumpUnread,
  clearUnread,
  createStore,
  initialState,
  roomSections,
  unmarkHiddenRoom,
  unreadCount,
} from "../../web/src/store.ts";

const room = (id: string, name: string, p: Partial<Room> = {}): Room => ({ id, name, archived: false, created_by: "u1", ...p });

describe("createStore", () => {
  it("notifies subscribers with the new and previous state", () => {
    const s = createStore({ a: 1, b: "x" });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: "x" });
    expect(fn).toHaveBeenCalledWith({ a: 2, b: "x" }, { a: 1, b: "x" });
  });

  it("accepts an updater function", () => {
    const s = createStore({ n: 1 });
    s.set((st) => ({ n: st.n + 1 }));
    expect(s.get().n).toBe(2);
  });

  it("does not notify when nothing changed", () => {
    const s = createStore({ a: 1 });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    const s = createStore({ a: 1 });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set({ a: 2 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("never mutates the previous state object", () => {
    const s = createStore({ a: 1 });
    const before = s.get();
    s.set({ a: 2 });
    expect(before).toEqual({ a: 1 });
  });
});

describe("initialState", () => {
  it("starts logged out with no rooms", () => {
    expect(initialState()).toEqual({
      user: null,
      rooms: new Map(),
      hidden: new Map(),
      unread: new Map(),
      mentions: new Map(),
      inbox: 0,
      roomsStatus: "idle",
      listLoads: 0,
      activeRoomId: null,
      collections: null,
      activeCollectionId: null,
      away: false,
      site: DEFAULT_SITE,
    });
  });
});

describe("roomSections (§7.1)", () => {
  const state = (rooms: Room[], hidden: string[] = []): AppState => ({
    ...initialState(),
    rooms: new Map(rooms.map((r) => [r.id, r])),
    hidden: new Map(hidden.map((id) => [id, `h-${id}`])),
  });

  it("splits rooms into rooms, hidden and archived, each sorted by name (case-insensitive)", () => {
    const s = state(
      [
        room("1", "zeta"),
        room("2", "Alpha"),
        room("3", "beta"),
        room("4", "old", { archived: true }),
        room("5", "Ancient", { archived: true }),
        room("6", "noisy"),
        room("7", "Memes"),
      ],
      ["6", "7"],
    );
    const { rooms, hidden, archived } = roomSections(s);
    expect(rooms.map((r) => r.name)).toEqual(["Alpha", "beta", "zeta"]);
    expect(hidden.map((r) => r.name)).toEqual(["Memes", "noisy"]);
    expect(archived.map((r) => r.name)).toEqual(["Ancient", "old"]);
  });

  it("an archived room goes to Archived even when hidden", () => {
    const s = state([room("1", "gone", { archived: true })], ["1"]);
    expect(roomSections(s)).toEqual({ rooms: [], dms: [], hidden: [], archived: [s.rooms.get("1")] });
  });

  it("a hide row for an unknown room is ignored", () => {
    const s = state([room("1", "a")], ["missing"]);
    expect(roomSections(s).hidden).toEqual([]);
  });

  it("returns the room records as-is: no unread counts or badge data (silent hide)", () => {
    const r = room("1", "quiet");
    const { hidden } = roomSections(state([r], ["1"]));
    expect(hidden[0]).toBe(r);
  });

  describe("direct messages (§16.5)", () => {
    const dm = (id: string, last: string, created = "2026-01-01 00:00:00.000Z", extra: Partial<Room> = {}): Room =>
      room(id, "", { kind: "dm", members: ["me", `u${id}`], last_message_at: last, created, created_by: "me", ...extra });
    const mine = (s: AppState): AppState => ({ ...s, user: { id: "me", name: "Me" } });

    it("BUG-29: a DM without messages is listed only for the member who opened it", () => {
      const s = mine(
        state([
          dm("theirs", "", undefined, { created_by: "ua" }),
          dm("mine", ""),
          dm("talked", "2026-02-01 00:00:00.000Z", undefined, { created_by: "ub" }),
        ]),
      );
      expect(
        roomSections(s)
          .dms.map((r) => r.id)
          .sort(),
      ).toEqual(["mine", "talked"]);
    });

    it("QA BUG-37: an empty DM the other member started is listed while you have it open", () => {
      const s = mine(state([dm("theirs", "", undefined, { created_by: "ua" })]));
      expect(roomSections(s).dms).toEqual([]);
      expect(roomSections({ ...s, activeRoomId: "theirs" }).dms.map((r) => r.id)).toEqual(["theirs"]);
    });

    it("lists DMs by latest activity (last message, else creation), newest first", () => {
      const s = mine(
        state([
          dm("a", "2026-03-01 00:00:00.000Z"),
          dm("b", "", "2026-04-01 00:00:00.000Z"),
          dm("c", "2026-05-01 00:00:00.000Z"),
          room("p", "public"),
        ]),
      );
      const { rooms, dms } = roomSections(s);
      expect(dms.map((r) => r.id)).toEqual(["c", "b", "a"]);
      expect(rooms.map((r) => r.id)).toEqual(["p"]);
    });

    it("lists rooms and DMs with unread messages first, each group in its usual order", () => {
      const s = mine(
        state([
          dm("a", "2026-03-01 00:00:00.000Z"),
          dm("b", "2026-04-01 00:00:00.000Z"),
          dm("c", "2026-05-01 00:00:00.000Z"),
          room("p", "alpha"),
          room("q", "beta"),
          room("r", "gamma"),
        ]),
      );
      const unread = new Map([
        ["a", 2],
        ["r", 1],
        ["q", 3],
      ]);
      const { rooms, dms } = roomSections({ ...s, unread });
      expect(dms.map((r) => r.id)).toEqual(["a", "c", "b"]);
      expect(rooms.map((r) => r.id)).toEqual(["q", "r", "p"]);
      // The open room keeps its place among the unread while it has unread messages left (2026-11-02).
      expect(roomSections({ ...s, unread, activeRoomId: "q" }).rooms.map((r) => r.id)).toEqual(["q", "r", "p"]);
    });

    it("closed (hidden) DMs are left out entirely; a DM is never in Hidden or Archived", () => {
      const s = mine(state([dm("a", ""), dm("b", "", undefined, { archived: true })], ["a"]));
      const { dms, hidden, archived } = roomSections(s);
      expect(dms.map((r) => r.id)).toEqual(["b"]);
      expect(hidden).toEqual([]);
      expect(archived).toEqual([]);
    });
  });
});

describe("unmarkHiddenRoom", () => {
  it("drops the room's hidden row, and is a no-op when it isn't hidden", () => {
    const s = { ...initialState(), hidden: new Map([["r1", "h1"]]) };
    expect(unmarkHiddenRoom("r1")(s).hidden?.size).toBe(0);
    expect(unmarkHiddenRoom("r2")(s)).toEqual({});
  });
});

describe("unread counts (§18)", () => {
  it("bumpUnread adds one; clearUnread drops the room (and is a no-op when there is nothing to clear)", () => {
    const store = createStore(initialState());
    store.set(bumpUnread("r1"));
    store.set(bumpUnread("r1"));
    store.set(bumpUnread("r2"));
    expect([...store.get().unread]).toEqual([
      ["r1", 2],
      ["r2", 1],
    ]);
    const before = store.get().unread;
    store.set(clearUnread("r1"));
    expect([...store.get().unread]).toEqual([["r2", 1]]);
    expect(before.get("r1")).toBe(2); // replaced, never mutated
    expect(clearUnread("nope")(store.get())).toEqual({});
  });

  it("unreadCount: none for hidden rooms and archived rooms (§13: hidden stays silent); the active room keeps its count", () => {
    const rooms = [room("a", "a"), room("b", "b"), room("h", "h"), room("x", "x", { archived: true }), room("z", "z")];
    const s: AppState = {
      ...initialState(),
      rooms: new Map(rooms.map((r) => [r.id, r])),
      hidden: new Map([["h", "row"]]),
      unread: new Map([
        ["a", 3],
        ["b", 5],
        ["h", 1],
        ["x", 2],
      ]),
      activeRoomId: "b",
    };
    expect(rooms.map((r) => unreadCount(s, r))).toEqual([3, 5, 0, 0, 0]);
  });
});
