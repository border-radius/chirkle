// Jump to (§32): Ctrl+K or Ctrl+P (⌘K, ⌘P) anywhere opens a dialog listing your rooms, DMs and collections. Type part
// of a name to narrow it, ↑/↓ to choose, Enter to go there; Escape (or the shortcut again) closes it. With nothing
// typed, the most recent first, so Ctrl+K Enter goes back to the room you were in before.
//
// A lazy chunk, like search (§29): app.ts import()s it on the first shortcut. It imports types only; what it needs from
// app.js comes in its options.

import type { h } from "../dom.ts";
import type { Collection, Room, User } from "../lib/types.ts";
import type { AppState } from "../store.ts";

export interface SwitcherOptions {
  h: typeof h;
  state: () => AppState;
  sections: (s: AppState) => { rooms: Room[]; dms: Room[]; hidden: Room[]; archived: Room[] };
  unread: (s: AppState, r: Room) => number;
  other: (r: Room, me: User | null) => User | undefined;
  /** A room's visibility icon (§23.1): the lock's or the globe's classes, "" for "#". */
  icon: (r: Room) => string;
  avatar: (u: User) => HTMLElement;
  navigate: (path: string) => void;
  /** When a room or collection was last open here (PocketBase time, "" never): public rooms have no latest message. */
  opened: (id: string) => string;
}

export interface Switcher {
  readonly el: HTMLDialogElement;
  /** Open it, or close it when open. */
  toggle(): void;
}

/** Somewhere to go: a room, a DM or a collection. */
export interface Target {
  path: string;
  name: string;
  /** Said after the name: "Hidden", "Archived", "Collection", whose collection it is. */
  note: string;
  /** Latest activity (PocketBase time): a DM's latest message, a collection's latest item, or when it was last open. */
  at: string;
  /** Hidden or archived: after the others that match as well. */
  away: boolean;
  /** Where you are now: last with nothing typed. */
  current: boolean;
  unread: number;
  room?: Room;
  other?: User | undefined;
}

/** Shown at most. */
const MAX = 50;

/** Case, accents and width folded: "élan" and "ＥＬＡＮ" are found by "elan". */
export const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

const WORD = /[\p{L}\p{N}]/u;

/**
 * How well `name` matches the folded query `q`, best first: 0 the whole name, 1 its start, 2 a word's start, 3 inside
 * a word, 4 its letters in order ("gnrl" finds "general"); -1 not at all.
 */
export function score(name: string, q: string): number {
  const n = fold(name);
  if (n === q) return 0;
  for (let i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + 1)) if (!i || !WORD.test(n[i - 1]!)) return i ? 2 : 1;
  if (n.includes(q)) return 3;
  let j = 0;
  // By code point, as `for of` reads the name: an emoji is one letter (QA BUG-138).
  const letters = [...q.replace(/\s/g, "")];
  for (const c of n) if (c === letters[j]) j++;
  return j === letters.length ? 4 : -1;
}

/** Everything you can jump to. */
export function targets(o: Pick<SwitcherOptions, "sections" | "unread" | "other" | "opened">, s: AppState): Target[] {
  const { rooms, dms, hidden, archived } = o.sections(s);
  const later = (at: string, id: string) => {
    const open = o.opened(id);
    return open > at ? open : at;
  };
  const room = (r: Room, note: string): Target => {
    const other = o.other(r, s.user);
    return {
      path: `/r/${r.id}`,
      name: other?.name ?? r.name,
      note,
      at: later(r.last_message_at || r.created || "", r.id),
      away: !!note,
      current: r.id === s.activeRoomId,
      unread: o.unread(s, r),
      room: r,
      other,
    };
  };
  const coll = (c: Collection): Target => ({
    path: `/c/${c.id}`,
    name: c.name,
    note: c.owner?.name ?? "Collection",
    at: later(c.last_added, c.id),
    away: false,
    current: c.id === s.activeCollectionId,
    unread: c.owner ? (c.new ?? 0) : 0,
  });
  return [
    ...rooms.map((r) => room(r, "")),
    ...dms.map((r) => room(r, "")),
    ...hidden.map((r) => room(r, "Hidden")),
    ...archived.map((r) => room(r, "Archived")),
    ...[...(s.collections?.mine ?? []), ...(s.collections?.subs ?? [])].map(coll),
  ];
}

const recent = (a: Target, b: Target) => +a.current - +b.current || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * What to show for `query`: the best matches first, then those not hidden or archived, then the most recent. With
 * nothing typed, everything but hidden and archived rooms, most recent first, with where you are last. A leading "#"
 * or "@" is ignored: "#general" finds the room "general".
 */
export function matches(all: Target[], query: string): Target[] {
  const q = fold(query.trim().replace(/^[#@]/, "").trim());
  if (!q) {
    // Where you are stays last when the rest is cut short (QA BUG-139).
    const here = all.filter((t) => t.current && !t.away);
    return [
      ...all
        .filter((t) => !t.current && !t.away)
        .sort(recent)
        .slice(0, MAX - here.length),
      ...here,
    ];
  }
  return all
    .map((t) => ({ t, n: score(t.name, q) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => a.n - b.n || +a.t.away - +b.t.away || recent(a.t, b.t))
    .slice(0, MAX)
    .map((x) => x.t);
}

export function createSwitcher(o: SwitcherOptions): Switcher {
  const { h } = o;
  const id = `switcher-${Math.random().toString(36).slice(2)}`;
  const input = h("input", {
    role: "combobox",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Jump to a room or person",
    "aria-label": "Jump to",
    "aria-autocomplete": "list",
    "aria-expanded": "true",
    "aria-controls": `${id}-list`,
  });
  const status = h("p", { class: "search-status", role: "status" });
  const list = h("ul", { id: `${id}-list`, class: "search-results forward-list", role: "listbox", "aria-label": "Rooms" });
  const mac = /Mac|iP/.test(navigator.platform);
  const keys = h("p", { class: "jump-keys", "aria-hidden": "true" }, [
    h("span", {}, "↑ ↓ to choose"),
    h("span", {}, "Enter to go"),
    h("span", {}, `${mac ? "⌘" : "Ctrl+"}K again to close`),
  ]);
  const field = h("label", { class: "jump-field ic i-search" }, [input, h("kbd", { "aria-hidden": "true" }, "Esc")]);
  const el = h("dialog", { class: "forward switcher", "aria-label": "Jump to" }, [field, status, list, keys]);
  let shown: Target[] = [];
  let at = 0;

  function go(t: Target | undefined) {
    if (!t) return;
    el.close();
    o.navigate(t.path);
  }

  function choose(i: number) {
    const opts = list.children;
    opts[at]?.setAttribute("aria-selected", "false");
    at = i;
    const li = opts[at];
    if (!li) return input.removeAttribute("aria-activedescendant");
    li.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", li.id);
    li.scrollIntoView?.({ block: "nearest" });
  }

  function option(t: Target, i: number): HTMLElement {
    const cls = t.room && o.icon(t.room);
    const icon = t.other
      ? o.avatar(t.other)
      : h("span", { class: `tile ${cls || ""}`, "aria-hidden": "true" }, t.room ? (cls ? "" : "#") : h("span", { class: "ci" }));
    return h(
      "li",
      {
        id: `${id}-${i}`,
        role: "option",
        class: t.unread ? "person unread" : "person",
        "aria-selected": "false",
        on: { click: () => go(t), mousemove: () => at !== i && choose(i) },
      },
      [
        icon,
        h("span", { class: "name" }, [t.name, t.note ? h("small", {}, ` ${t.note}`) : null]),
        t.unread
          ? h("span", { class: "badge" }, [t.unread > 99 ? "99+" : t.unread, h("span", { class: "visually-hidden" }, " unread")])
          : null,
      ],
    );
  }

  function show() {
    shown = matches(targets(o, o.state()), input.value);
    list.replaceChildren(...shown.map(option));
    status.textContent = shown.length ? "" : "Nothing found.";
    at = 0;
    choose(0);
  }

  input.addEventListener("input", show);
  input.addEventListener("keydown", (e) => {
    const n = shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) choose((at + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) {
      // 229: Safari's Enter confirming an IME word, after the composition ended (as composer.ts `composing`, QA BUG-179).
      e.preventDefault();
      go(shown[at]);
    }
  });
  // A click on the backdrop (outside the dialog's box) closes it.
  el.addEventListener("click", (e) => {
    const r = el.getBoundingClientRect();
    if (e.target === el && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) el.close();
  });

  return {
    el,
    toggle() {
      if (el.open) return el.close();
      input.value = "";
      show();
      el.showModal();
      input.focus();
    },
  };
}
