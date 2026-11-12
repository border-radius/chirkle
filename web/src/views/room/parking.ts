// A room kept out of the page after you left it (park), until you come back (resume): still live and drawn, never
// measured. A scroll asked for meanwhile waits for the resume. At the live bottom (`pinned`), the list stays there;
// else where it was: the message at the top goes back where it was. (In views/room.ts until REFACTOR item 53.)

import { isNearBottom } from "../../lib/scroll.ts";
import type { Change } from "./controller.ts";

export interface Parking {
  readonly parked: boolean;
  /** The list is at its live bottom (as of its last scroll), and stays there when it gets shorter. */
  readonly pinned: boolean;
  /** Ends when the room is left (parked, or the view's signal): what shows over the page for it (grid, viewer). */
  readonly screen: AbortSignal;
  /** While parked, keep a scroll for the resume (true: kept, don't scroll now). */
  hold(scroll: Change["scroll"]): boolean;
  /** Leave the page: note where the list is. */
  park(): void;
  /** Back on the page: the scroll asked for meanwhile, if any (taken). */
  unpark(): Change["scroll"];
  /** Put the list back where it was, unless something else was brought into view (`moved`). */
  restore(moved: boolean, scroll: Change["scroll"], draw: (scroll: NonNullable<Change["scroll"]>) => void, toBottom: () => void): void;
}

export function createParking(list: HTMLElement, signal: AbortSignal): Parking {
  let parked = false;
  let held: Change["scroll"];
  let at: { id: string; dy: number; top: number } | undefined;
  let pinned = true;
  let screen = new AbortController();
  signal.addEventListener("abort", () => screen.abort(), { once: true });
  // When the list gets shorter while at the live bottom it is kept there (BUG-31, room.ts).
  list.addEventListener("scroll", () => (pinned = isNearBottom(list)), { signal });

  return {
    get parked() {
      return parked;
    },
    get pinned() {
      return pinned;
    },
    get screen() {
      return screen.signal;
    },
    hold(scroll) {
      if (!parked) return false;
      held = scroll ?? held;
      return true;
    },
    park() {
      const top = list.scrollTop;
      const first = [...list.querySelectorAll<HTMLElement>("li.msg")].find((el) => el.offsetTop + el.offsetHeight > top);
      at = { id: first?.dataset.id ?? "", dy: (first?.offsetTop ?? 0) - top, top };
      parked = true;
      screen.abort();
      screen = new AbortController();
    },
    unpark() {
      parked = false;
      const scroll = held;
      held = undefined;
      return scroll;
    },
    restore(moved, scroll, draw, toBottom) {
      // The first message that came meanwhile was brought into view; else a scroll asked for meanwhile, or the bottom.
      if (!moved) {
        if (scroll) draw(scroll);
        else if (pinned) toBottom();
        else if (at) {
          const el = at.id && list.querySelector<HTMLElement>(`li.msg[data-id="${CSS.escape(at.id)}"]`);
          list.scrollTop = el ? el.offsetTop - at.dy : at.top;
        }
      }
      at = undefined;
    },
  };
}
