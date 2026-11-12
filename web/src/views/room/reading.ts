// What is on screen is read (§18.3): up to the newest saved message shown whole, or everything once the newest
// messages are on screen. Scrolling down through what is unread reads it as it comes into view. Nothing in a hidden
// tab, or while a kept window shows before the server has said where the unread messages start (QA BUG-102).
// (In views/room.ts until REFACTOR item 53.)

import { lastSaved } from "../../lib/messages.ts";
import { isNearBottom } from "../../lib/scroll.ts";
import type { Message } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import type { RoomReader } from "../../unread.ts";
import type { RoomState } from "./controller.ts";

export interface Reading {
  /** Start reporting to `reader` (unread.ts): on mount, and on coming back to a parked room. */
  open(reader: RoomReader): void;
  /** Stop (leaving, or parked). Left before the first page was in, the server may have more than the kept window
   * showed: it says what is unread. */
  leave(): void;
  /** Watch the rows a render added; forget those it took away. */
  watchRows(): void;
  /** Report what is on screen now. */
  markRead(): void;
  /** markRead after the next frame's layout: what a render changed may not cross a row's edge (a first page
   * replacing the kept one). */
  readSoon(): void;
}

export function createReading(list: HTMLElement, state: () => RoomState, scope: Scope): Reading {
  let reader: RoomReader | null = null;
  /**
   * The messages shown whole or scrolled past, as the browser tells it (PERF.md §5): their bottom is above the list's.
   * By id, the element that is. Measuring them ourselves after a render made the browser lay the list out at once,
   * and again for every scroll event.
   */
  const above = new Map<string, Element>();
  const rows = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.id!;
        if (e.intersectionRatio >= 0.999) above.set(id, e.target);
        else if (above.get(id) === e.target) above.delete(id);
      }
      markRead();
    },
    // Everything above the list's bottom counts: whole means the bottom is in.
    { root: list, rootMargin: "1000000px 0px 0px 0px", threshold: 1 },
  );
  scope.defer(() => rows.disconnect());
  const watched = new Set<Element>();
  let reading = false;

  /**
   * The newest messages are on screen: loaded, scrolled to the bottom, in a visible tab. Scrolled up, a new message
   * only shows the pill, and stays unread until you scroll down to it.
   */
  const atLiveEdge = () => {
    const s = state();
    return s.phase === "ready" && !s.win.hasNewer && !s.unsure && isNearBottom(list) && document.visibilityState !== "hidden";
  };

  /** The newest saved message whose bottom is on screen (or scrolled past). */
  function lastShown(): Message | undefined {
    const { items } = state().win;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i]!;
      if (!m.status && above.has(m.id)) return m;
    }
    return undefined;
  }

  function markRead() {
    const s = state();
    if (!reader || s.phase !== "ready" || s.unsure || document.visibilityState === "hidden") return;
    const caughtUp = atLiveEdge();
    const m = caughtUp ? lastSaved(s.win) : lastShown();
    if (m) reader.seen(m.created, caughtUp);
  }

  return {
    open(r) {
      reader = r;
    },
    leave() {
      reader?.close(atLiveEdge() && !state().stale);
      reader = null;
    },
    watchRows() {
      for (const el of watched) {
        if (el.parentNode === list) continue;
        rows.unobserve(el);
        watched.delete(el);
        const id = (el as HTMLElement).dataset.id!;
        if (above.get(id) === el) above.delete(id);
      }
      for (const el of list.children) {
        if (!el.classList.contains("msg") || watched.has(el)) continue;
        rows.observe(el);
        watched.add(el);
      }
    },
    markRead,
    readSoon() {
      if (reading) return;
      reading = true;
      requestAnimationFrame(() =>
        setTimeout(() => {
          reading = false;
          if (scope.active) markRead();
        }),
      );
    },
  };
}
