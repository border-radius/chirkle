// Emoji picker (§20.4): one popover per room view, opened by the composer's emoji button and by a message's React
// button. Category tabs, a "Recent" row (per browser), and a grid of 8 columns.
// Keyboard: the grid is one tab stop; arrow keys, Home and End move in it, Enter picks, Escape closes and gives
// focus back to the button that opened it. Clicking or tabbing anywhere else closes it. A resize moves it along (on
// Android the keyboard going away resizes the page, and opening the picker takes the focus from the composer).
//
// A lazy chunk, like search (§29): the room view import()s it when the picker is first opened, with the emoji list
// (lib/emoji.ts) in it. It imports types only from app.js; `h` comes in its options.

import type { h } from "../dom.ts";
import { CATEGORIES, type EmojiCategory, recentEmoji, rememberEmoji } from "../lib/emoji.ts";

/** Columns of the grid; styles/app/emoji-picker.css sizes the picker for exactly this many. */
export const COLS = 8;

export interface PickerRequest {
  /** The dialog's accessible name, e.g. "Add reaction". */
  label: string;
  onPick: (emoji: string) => void;
  /** Emoji to show as chosen (your reactions): picking one again takes it back. */
  chosen?: ReadonlySet<string>;
  /** Where focus goes once the picker closes without a pick; the opener by default (if it is still there). */
  restoreFocus?: () => void;
}

export interface EmojiPicker {
  readonly el: HTMLElement;
  /** Open next to `opener`; opening it again from the same opener closes it. */
  open(opener: HTMLElement, req: PickerRequest): void;
  close(): void;
  readonly isOpen: boolean;
}

/** Index of the emoji one step away in `dir`, moving through categories' grids as they are laid out. */
export function step(
  sizes: readonly number[],
  at: { cat: number; i: number },
  dir: "left" | "right" | "up" | "down",
): { cat: number; i: number } {
  const { cat, i } = at;
  const len = sizes[cat]!;
  const col = i % COLS;
  const prevCat = (c: number) => {
    for (let k = c - 1; k >= 0; k--) if (sizes[k]) return k;
    return -1;
  };
  const nextCat = (c: number) => {
    for (let k = c + 1; k < sizes.length; k++) if (sizes[k]) return k;
    return -1;
  };
  switch (dir) {
    case "left": {
      if (i > 0) return { cat, i: i - 1 };
      const p = prevCat(cat);
      return p < 0 ? at : { cat: p, i: sizes[p]! - 1 };
    }
    case "right": {
      if (i < len - 1) return { cat, i: i + 1 };
      const n = nextCat(cat);
      return n < 0 ? at : { cat: n, i: 0 };
    }
    case "up": {
      if (i >= COLS) return { cat, i: i - COLS };
      const p = prevCat(cat);
      if (p < 0) return at;
      const lastRow = Math.floor((sizes[p]! - 1) / COLS) * COLS;
      return { cat: p, i: Math.min(lastRow + col, sizes[p]! - 1) };
    }
    case "down": {
      if (i + COLS < len) return { cat, i: i + COLS };
      // A shorter last row below: go to its end.
      if (Math.floor(i / COLS) < Math.floor((len - 1) / COLS)) return { cat, i: len - 1 };
      const n = nextCat(cat);
      return n < 0 ? at : { cat: n, i: Math.min(col, sizes[n]! - 1) };
    }
  }
}

const KEYS: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export function createEmojiPicker(opts: { h: typeof h; signal: AbortSignal }): EmojiPicker {
  const { h, signal } = opts;
  const el = h("div", { class: "emoji-picker", role: "dialog", hidden: true });
  const tabs = h("div", { class: "emoji-tabs" });
  const scroller = h("div", { class: "emoji-scroll" });
  el.append(tabs, scroller);

  let built = false;
  let opener: HTMLElement | null = null;
  let req: PickerRequest | null = null;
  /** The grids as shown: "Recent" (when there is any) first. */
  let grids: HTMLButtonElement[][] = [];
  /** The one emoji in the tab order (roving tabindex). */
  let active: HTMLButtonElement | null = null;
  let outside: AbortController | null = null;

  const sectionId = (i: number) => `emoji-cat-${i}`;

  function setActive(b: HTMLButtonElement | null) {
    if (active) active.tabIndex = -1;
    active = b;
    if (b) b.tabIndex = 0;
  }

  function emojiButton(emoji: string): HTMLButtonElement {
    return h("button", { type: "button", class: "emoji", tabindex: -1, dataset: { emoji } }, emoji);
  }

  /** (Re)build the sections; the categories are built once, "Recent" on every open. */
  function render() {
    const cats: EmojiCategory[] = [];
    const recent = recentEmoji();
    if (recent.length) cats.push({ name: "Recent", icon: "🕘", emoji: recent });
    cats.push(...CATEGORIES);
    if (!built || tabs.childElementCount !== cats.length) {
      tabs.replaceChildren(
        ...cats.map((c, i) =>
          h(
            "button",
            {
              type: "button",
              class: "emoji-tab",
              title: c.name,
              "aria-label": c.name,
              on: { click: () => showCategory(i) },
              signal,
            },
            c.icon,
          ),
        ),
      );
    }
    if (!built) {
      built = true;
      scroller.replaceChildren(...CATEGORIES.map((c, i) => section(c, i + 1)));
    }
    const recentSection = scroller.querySelector(".emoji-section.recent");
    if (recent.length) {
      const s = section(cats[0]!, 0);
      s.classList.add("recent");
      if (recentSection) recentSection.replaceWith(s);
      else scroller.prepend(s);
    } else recentSection?.remove();
    grids = [...scroller.querySelectorAll(".emoji-grid")].map((g) => [...g.querySelectorAll<HTMLButtonElement>("button.emoji")]);
    // Toggles only when picking takes something back (reactions); for the composer they just insert.
    const chosen = req?.chosen;
    for (const b of scroller.querySelectorAll<HTMLButtonElement>("button.emoji")) {
      const on = !!chosen?.has(b.dataset.emoji!);
      b.classList.toggle("on", on);
      if (chosen) b.setAttribute("aria-pressed", String(on));
      else b.removeAttribute("aria-pressed");
      b.tabIndex = -1;
    }
    active = null;
    setActive(grids[0]?.[0] ?? null);
  }

  function section(c: EmojiCategory, i: number): HTMLElement {
    // Ids by position: "Recent" is 0, the categories 1…; one picker per page at a time (a room view).
    return h("section", { class: "emoji-section", id: sectionId(i) }, [
      h("h2", { class: "emoji-heading", id: `${sectionId(i)}-h` }, c.name),
      h("div", { class: "emoji-grid", role: "group", "aria-labelledby": `${sectionId(i)}-h` }, c.emoji.map(emojiButton)),
    ]);
  }

  function showCategory(i: number) {
    const first = grids[i]?.[0];
    if (!first) return;
    scroller.querySelectorAll(".emoji-section")[i]?.scrollIntoView?.({ block: "start" });
    setActive(first);
    first.focus({ preventScroll: true });
  }

  function where(b: HTMLButtonElement): { cat: number; i: number } | null {
    for (let cat = 0; cat < grids.length; cat++) {
      const i = grids[cat]!.indexOf(b);
      if (i >= 0) return { cat, i };
    }
    return null;
  }

  function pick(emoji: string) {
    const r = req;
    close(false);
    rememberEmoji(emoji);
    r?.onPick(emoji);
  }

  scroller.addEventListener(
    "click",
    (e) => {
      const b = (e.target as Element).closest?.("button.emoji");
      if (b instanceof HTMLButtonElement) pick(b.dataset.emoji!);
    },
    { signal },
  );
  scroller.addEventListener(
    "keydown",
    (e) => {
      const b = e.target;
      if (!(b instanceof HTMLButtonElement) || !b.matches("button.emoji")) return;
      const at = where(b);
      if (!at) return;
      let next: { cat: number; i: number } | null = null;
      const dir = KEYS[e.key];
      if (dir)
        next = step(
          grids.map((g) => g.length),
          at,
          dir,
        );
      else if (e.key === "Home") next = { cat: 0, i: 0 };
      else if (e.key === "End") next = { cat: grids.length - 1, i: grids.at(-1)!.length - 1 };
      const target = next && grids[next.cat]?.[next.i];
      if (!target) return;
      e.preventDefault();
      setActive(target);
      target.focus();
    },
    { signal },
  );
  el.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    },
    { signal },
  );

  /** Next to the opener: above it when there is room, else below; right edges aligned, kept on screen. */
  function place(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const ht = el.offsetHeight;
    const gap = 6;
    const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
    const top = r.top - gap - ht >= 8 ? r.top - gap - ht : Math.min(r.bottom + gap, innerHeight - ht - 8);
    el.style.setProperty("--x", `${Math.round(left)}px`);
    el.style.setProperty("--y", `${Math.round(Math.max(8, top))}px`);
  }

  function watchOutside() {
    outside = new AbortController();
    const o = { capture: true, signal: outside.signal };
    const away = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target) && !opener?.contains(e.target)) close(false);
    };
    document.addEventListener("pointerdown", away, o);
    document.addEventListener("focusin", away, o);
    addEventListener("resize", () => opener?.isConnected && place(opener), o);
  }

  function open(from: HTMLElement, request: PickerRequest) {
    if (signal.aborted) return;
    if (!el.hidden && opener === from) return close(true);
    if (!el.hidden) close(false);
    opener = from;
    req = request;
    el.setAttribute("aria-label", request.label);
    render();
    el.hidden = false;
    from.setAttribute("aria-expanded", "true");
    place(from);
    scroller.scrollTop = 0;
    watchOutside();
    active?.focus({ preventScroll: true });
  }

  /** `refocus`: give focus back (Escape, or the opener toggled it), as opposed to focus having moved elsewhere. */
  function close(refocus: boolean) {
    if (el.hidden) return;
    el.hidden = true;
    outside?.abort();
    outside = null;
    opener?.setAttribute("aria-expanded", "false");
    const r = req;
    const o = opener;
    opener = null;
    req = null;
    if (!refocus) return;
    if (r?.restoreFocus) r.restoreFocus();
    else if (o?.isConnected) o.focus();
  }

  signal.addEventListener("abort", () => outside?.abort(), { once: true });

  return {
    el,
    open,
    close: () => close(false),
    get isOpen() {
      return !el.hidden;
    },
  };
}
