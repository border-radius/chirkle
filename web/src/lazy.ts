// A page from a lazy chunk (`lazyView`). Until 2026-11-12 this also held the "kits", what each lazy chunk got of app.js
// as arguments while lazy chunks could share no code with it (REFACTOR item 52): they import what they use now.

import { h } from "./dom.ts";
import type { View } from "./router.ts";

/**
 * A page from a lazy chunk: "Loading…" until `load` gives its view, which is then mounted in its place (if it is still
 * wanted). `failed` is said when the chunk can't be loaded (offline, or a new version deployed).
 */
export function lazyView(load: () => Promise<View>, failed: string): View {
  let inner: View | null = null;
  let gone = false;
  return {
    mount(el, params) {
      gone = false;
      el.replaceChildren(h("p", { class: "empty", role: "status" }, "Loading…"));
      load().then(
        (v) => {
          if (gone) return;
          inner = v;
          v.mount(el, params);
        },
        () => {
          if (!gone) el.replaceChildren(h("p", { class: "empty", role: "alert" }, failed));
        },
      );
    },
    update(params) {
      inner?.update?.(params);
    },
    unmount() {
      gone = true;
      inner?.unmount();
      inner = null;
    },
  };
}
