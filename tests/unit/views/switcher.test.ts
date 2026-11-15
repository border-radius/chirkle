// Jump to (§32): what each target says, and the dialog itself.

import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../web/src/dom.ts";
import { otherMember } from "../../../web/src/lib/rooms.ts";
import type { Room, User } from "../../../web/src/lib/types.ts";
import { type AppState, initialState, roomSections, unreadCount } from "../../../web/src/store.ts";
import { createSwitcher, type SwitcherOptions, targets } from "../../../web/src/views/switcher.ts";

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

// Matching and ordering: shared/vectors/jump.json (tests/unit/vectors.test.ts), which the app runs too.
describe("jump to: targets", () => {
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
