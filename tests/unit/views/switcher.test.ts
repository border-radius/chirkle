// Jump to (§32): matching and ordering, and the dialog itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../web/src/dom.ts";
import { otherMember } from "../../../web/src/lib/rooms.ts";
import type { Room, User } from "../../../web/src/lib/types.ts";
import { type AppState, initialState, roomSections, unreadCount } from "../../../web/src/store.ts";
import { createSwitcher, fold, matches, type SwitcherOptions, score, targets } from "../../../web/src/views/switcher.ts";

const me: User = { id: "me", name: "Me" };
const bob: User = { id: "bob", name: "Bob Été" };

const room = (id: string, name: string, at: string, more: Partial<Room> = {}): Room =>
  ({ id, name, kind: "room", created: at, last_message_at: at, members: [], created_by: "x", ...more }) as Room;

function state(): AppState {
  const rooms = [
    room("gen", "general", "2026-10-20"),
    room("dev", "dev-ops", "2026-10-22"),
    room("ran", "random", "2026-10-21"),
    room("old", "old-general", "2026-10-01", { archived: true }),
    room("hid", "gossip", "2026-10-23"),
    room("dm1", "", "2026-10-19", { kind: "dm", members: ["me", "bob"], expand: { members: [me, bob] } } as Partial<Room>),
  ];
  return {
    ...initialState(),
    user: me,
    rooms: new Map(rooms.map((r) => [r.id, r])),
    hidden: new Map([["hid", "row1"]]),
    unread: new Map([["ran", 3]]),
    activeRoomId: "dev",
    collections: { mine: [{ id: "c1", name: "Cats", public: true, items: 1, last_added: "2026-10-18" }], subs: [] },
  };
}

const opts = (s: AppState, navigate = vi.fn(), opened: Record<string, string> = {}): SwitcherOptions => ({
  state: () => s,
  sections: roomSections,
  unread: unreadCount,
  other: otherMember,
  icon: () => "#",
  avatar: (u) => h("span", { class: "avatar" }, u.name[0]),
  navigate,
  opened: (id) => opened[id] ?? "",
});

const names = (s: AppState, q: string) => matches(targets(opts(s), s), q).map((t) => t.name);

describe("jump to: matching", () => {
  it("folds case, accents and width", () => {
    expect(fold("Été ＡＢＣ")).toBe("ete abc");
  });

  it("ranks the whole name, its start, a word's start, inside a word, then letters in order", () => {
    expect(score("general", "general")).toBe(0);
    expect(score("general", "gen")).toBe(1);
    expect(score("old-general", "gen")).toBe(2);
    expect(score("dev-ops", "ops")).toBe(2);
    expect(score("general", "ner")).toBe(3);
    expect(score("general", "gnrl")).toBe(4);
    expect(score("general", "xyz")).toBe(-1);
    expect(score("🍕 pizza", "🍕z")).toBe(4); // QA BUG-138
  });

  it("with nothing typed: rooms, DMs and collections, most recent first, where you are last, no hidden or archived", () => {
    expect(names(state(), "")).toEqual(["random", "general", "Bob Été", "Cats", "dev-ops"]);
  });

  it("without a latest message (public rooms have none), the most recently open first (QA BUG-134)", () => {
    const s = state();
    // As the server sends them: only DMs carry last_message_at.
    for (const [id, r] of s.rooms) if (r.kind !== "dm") s.rooms.set(id, { ...r, last_message_at: "" });
    s.activeRoomId = "ran";
    const opened = { gen: "2026-10-23 09:00:00.000Z", ran: "2026-10-23 10:00:00.000Z", c1: "2026-10-23 08:00:00.000Z" };
    const list = matches(targets(opts(s, vi.fn(), opened), s), "").map((t) => t.name);
    expect(list).toEqual(["general", "Cats", "dev-ops", "Bob Été", "random"]);
    // A room opened long ago doesn't hide a newer message.
    const later = { ...opened, gen: "2026-10-01 09:00:00.000Z" };
    expect(matches(targets(opts(s, vi.fn(), later), s), "")[0]?.name).toBe("Cats");
  });

  it("with more than 50, where you are is still last (QA BUG-139)", () => {
    const s = state();
    for (let i = 0; i < 60; i++) s.rooms.set(`r${i}`, room(`r${i}`, `room ${i}`, "2026-10-22 12:00:00.000Z"));
    const list = names(s, "");
    expect(list).toHaveLength(50);
    expect(list.at(-1)).toBe("dev-ops");
  });

  it("with a query: best matches first, hidden and archived ones after, # and @ ignored", () => {
    expect(names(state(), "gen")).toEqual(["general", "old-general"]);
    expect(names(state(), "#GEN")).toEqual(["general", "old-general"]);
    expect(names(state(), "@bob ete")).toEqual(["Bob Été"]);
    expect(names(state(), "go")).toEqual(["gossip"]);
    expect(names(state(), "zzz")).toEqual([]);
  });

  it("says where each goes, and what is hidden, archived or unread", () => {
    const all = targets(opts(state()), state());
    expect(all.find((t) => t.name === "gossip")).toMatchObject({ path: "/r/hid", note: "Hidden" });
    expect(all.find((t) => t.name === "old-general")).toMatchObject({ note: "Archived" });
    expect(all.find((t) => t.name === "random")).toMatchObject({ unread: 3 });
    expect(all.find((t) => t.name === "Cats")).toMatchObject({ path: "/c/c1", note: "Collection" });
  });
});

describe("jump to: the dialog", () => {
  let el: HTMLElement | undefined;
  afterEach(() => el?.remove());

  const open = (navigate = vi.fn()) => {
    const s = createSwitcher(opts(state(), navigate));
    el = s.el;
    document.body.append(s.el);
    s.toggle();
    const input = s.el.querySelector("input")!;
    const options = () => [...s.el.querySelectorAll('[role="option"]')];
    const selected = () => s.el.querySelector('[aria-selected="true"]')?.querySelector(".name")?.firstChild?.textContent;
    const press = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const type = (q: string) => {
      input.value = q;
      input.dispatchEvent(new Event("input"));
    };
    return { s, input, options, selected, press, type, navigate };
  };

  it("opens focused on the field with the most recent first chosen; arrows choose, wrapping; Enter goes", () => {
    const d = open();
    expect(d.s.el.hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(d.input);
    expect(d.options()).toHaveLength(5);
    expect(d.selected()).toBe("random");
    expect(d.input.getAttribute("aria-activedescendant")).toBe(d.options()[0]!.id);
    d.press("ArrowDown");
    expect(d.selected()).toBe("general");
    d.press("ArrowUp");
    d.press("ArrowUp");
    expect(d.selected()).toBe("dev-ops");
    d.press("Enter");
    expect(d.navigate).toHaveBeenCalledWith("/r/dev");
    expect(d.s.el.hasAttribute("open")).toBe(false);
  });

  it("doesn't go on the Enter that confirms an IME word, Safari's (keyCode 229) included (QA BUG-179)", () => {
    const d = open();
    d.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    d.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
    expect(d.navigate).not.toHaveBeenCalled();
    d.press("Enter");
    expect(d.navigate).toHaveBeenCalledTimes(1);
  });

  it("narrows as you type, says when nothing matches, and goes where clicked", () => {
    const d = open();
    d.type("ca");
    expect(d.options()).toHaveLength(1);
    expect(d.selected()).toBe("Cats");
    d.type("nothing like it");
    expect(d.options()).toHaveLength(0);
    expect(d.s.el.querySelector('[role="status"]')!.textContent).toBe("Nothing found.");
    d.press("Enter"); // nothing to go to
    expect(d.navigate).not.toHaveBeenCalled();
    d.type("bob");
    (d.options()[0] as HTMLElement).click();
    expect(d.navigate).toHaveBeenCalledWith("/r/dm1");
  });

  it("shows unread counts, and starts over empty when opened again; the shortcut again closes it", () => {
    const d = open();
    expect(d.options()[0]!.querySelector(".badge")!.textContent).toBe("3 unread");
    d.type("cats");
    d.s.toggle();
    expect(d.s.el.hasAttribute("open")).toBe(false);
    d.s.toggle();
    expect(d.input.value).toBe("");
    expect(d.options()).toHaveLength(5);
  });
});
