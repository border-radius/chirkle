// A thin moving line over the room list or a room while it is being fetched (§7.9): only once a fetch has taken
// LOADBAR_MS, so a quick one shows nothing, and gone as soon as nothing is out.

import { h } from "../dom.ts";

export const LOADBAR_MS = 400;

export interface Loadbar {
  el: HTMLElement;
  /** Something is being fetched (true) or nothing is any more. */
  set(busy: boolean): void;
}

export function createLoadbar(): Loadbar {
  const el = h("div", { class: "loadbar", "aria-hidden": "true" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    el,
    set(busy) {
      if (busy) timer ??= setTimeout(() => el.classList.add("on"), LOADBAR_MS);
      else {
        clearTimeout(timer);
        timer = undefined;
        el.classList.remove("on");
      }
    },
  };
}
