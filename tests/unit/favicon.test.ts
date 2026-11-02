import { afterEach, describe, expect, it } from "vitest";
import { badgeLabel, faviconSvg, faviconUrl, startFavicon, totalUnread } from "../../web/src/favicon.ts";
import type { Room } from "../../web/src/lib/types.ts";
import { type AppState, bumpUnread, clearUnread, createStore, initialState, markHidden } from "../../web/src/store.ts";

const room = (id: string, extra: Partial<Room> = {}): Room => ({ id, name: id, archived: false, created_by: "u", ...extra });

describe("favicon unread badge (§22.4)", () => {
  afterEach(() => {
    document.head.querySelector('link[rel="icon"]')?.remove();
    document.title = "";
  });

  it("labels: nothing for 0, the number up to 99, then 99+", () => {
    expect([0, 1, 42, 99, 100, 5000].map(badgeLabel)).toEqual(["", "1", "42", "99", "99+", "99+"]);
  });

  it("the icon has a badge only when there is something unread", () => {
    expect(faviconSvg("")).not.toContain("<text");
    expect(faviconSvg("7")).toContain(">7</text>");
    expect(faviconUrl("7")).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(faviconUrl("99+"))).toContain(">99+</text>");
  });

  it("counts the rooms that show a badge: not the open one, hidden or archived ones", () => {
    let s: AppState = {
      ...initialState(),
      rooms: new Map([
        ["a", room("a")],
        ["b", room("b")],
        ["c", room("c", { archived: true })],
        ["d", room("d")],
      ]),
      unread: new Map([
        ["a", 2],
        ["b", 3],
        ["c", 4],
        ["d", 5],
        ["gone", 6], // a room that isn't listed (any more)
      ]),
      activeRoomId: "b",
    };
    s = { ...s, ...markHidden("d", "row")(s) };
    expect(totalUnread(s)).toBe(5); // the open room's count is what is left unread in it (2026-11-02)
    expect(totalUnread({ ...s, away: true })).toBe(5);
    expect(totalUnread({ ...s, away: true, activeRoomId: "d" })).toBe(5); // hidden stays silent, open or not
  });

  it("follows the store: favicon and title, back to plain when everything is read or it stops", () => {
    document.title = "Chirkle";
    const store = createStore<AppState>({
      ...initialState(),
      rooms: new Map([
        ["a", room("a")],
        ["b", room("b")],
      ]),
    });
    const stop = startFavicon(store);
    const icon = () => document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    expect(icon().href).toBe(faviconUrl(""));
    expect(document.title).toBe("Chirkle");
    store.set(bumpUnread("a"));
    store.set(bumpUnread("b"));
    store.set(bumpUnread("b"));
    expect(icon().href).toBe(faviconUrl("3"));
    expect(document.title).toBe("(3) Chirkle");
    // A fresh <link> each time, not a new href on the old one, which Firefox doesn't pick up.
    const before = icon();
    store.set(bumpUnread("a"));
    expect(icon()).not.toBe(before);
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    store.set(clearUnread("a"));
    store.set(bumpUnread("a"));
    store.set({ activeRoomId: "b" }); // opening a room: its name is in the title; its count goes as it is read
    expect(document.title).toBe("(3) #b – Chirkle");
    store.set(bumpUnread("b"));
    expect(document.title).toBe("(4) #b – Chirkle");
    store.set(clearUnread("b"));
    store.set(clearUnread("a"));
    expect(icon().href).toBe(faviconUrl(""));
    expect(document.title).toBe("#b – Chirkle");
    // A DM is called after the other member; leaving the room leaves the site's title.
    store.set({
      user: { id: "me", name: "Me" } as AppState["user"],
      rooms: new Map([
        ...store.get().rooms,
        ["dm", room("dm", { kind: "dm", members: ["me", "x"], expand: { members: [{ id: "x", name: "Xia" }] } } as Partial<Room>)],
      ]),
      activeRoomId: "dm",
    });
    expect(document.title).toBe("Xia – Chirkle");
    store.set({ activeRoomId: null });
    expect(document.title).toBe("Chirkle");
    store.set(bumpUnread("a"));
    stop();
    expect(document.title).toBe("Chirkle");
    expect(icon().href).toBe(faviconUrl(""));
  });
});
