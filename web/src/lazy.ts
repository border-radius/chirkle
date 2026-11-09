// What the lazy chunks get of app.js. A lazy module imports types only: a value imported from a module app.js has too
// would be split into a chunk of its own that app.js imports eagerly (the build refuses it, DESIGN.md §17.7). So
// app.js hands each one what it uses, as a "kit". The pages among them are views made on first visit (`lazyView`).

import { ApiError, errorMessage, SIGNUP_LOGIN_FAILED } from "./api.ts";
import { clear, h, uniqueId } from "./dom.ts";
import { byLine } from "./header.ts";
import { prepareImage } from "./lib/image.ts";
import { LIMITS, textLength } from "./lib/limits.ts";
import { otherMember, roomTitle } from "./lib/rooms.ts";
import { DEFAULT_SITE } from "./lib/types.ts";
import type { View } from "./router.ts";
import { createScope } from "./scope.ts";
import { savedTheme, setTheme, THEME_KEY, THEMES } from "./theme.ts";
import { avatar } from "./ui/avatar.ts";
import type { SearchKit } from "./ui/user-search.ts";
import type { LoginKit } from "./views/login.ts";
import type { ProfileKit } from "./views/profile.ts";
import type { ForwardKit } from "./views/room/forward.ts";

/** People search (ui/user-search.ts): the sidebar's New message, room access. */
export const SEARCH_KIT: SearchKit = { h, uniqueId, avatar, SEARCH_DEBOUNCE_MS: 200 };

/** The forward dialog (views/room/forward.ts). */
export const FORWARD_KIT: ForwardKit = { ...SEARCH_KIT, otherMember, roomTitle };

/** The login and signup page (views/login.ts). */
export const LOGIN_KIT: LoginKit = {
  h,
  clear,
  uniqueId,
  byLine,
  ApiError,
  errorMessage,
  SIGNUP_LOGIN_FAILED,
  LIMITS,
  textLength,
  DEFAULT_SITE,
};

/** The profile page (views/profile.ts). */
export const PROFILE_KIT: ProfileKit = {
  h,
  clear,
  uniqueId,
  avatar,
  ApiError,
  errorMessage,
  prepareImage,
  LIMITS,
  textLength,
  createScope,
  savedTheme,
  setTheme,
  THEME_KEY,
  THEMES,
};

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
