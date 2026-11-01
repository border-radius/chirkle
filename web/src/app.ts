// App shell and boot (§7.1): restores the session, starts the room sync and unread counts and the tab's unread badge
// (§22.4), wires the router, header and logout (offered on the profile page, §22.2). Without a session the app is open
// to guests, who read the Open Air rooms and can log in or sign up from the header (§23.3).

import { createRoomActions } from "./actions.ts";
import type { Api } from "./api.ts";
import { type Cache, createCache, forgetGone } from "./cache.ts";
import { createCollections } from "./collections.ts";
import type { Ctx } from "./context.ts";
import { clear, h } from "./dom.ts";
import { createDrafts } from "./drafts.ts";
import { startFavicon } from "./favicon.ts";
import { createHeader } from "./header.ts";
import { startJumpTo } from "./jump.ts";
import { roomTitle } from "./lib/rooms.ts";
import type { User } from "./lib/types.ts";
import { createPrefetch } from "./prefetch.ts";
import { createRenewal } from "./renewal.ts";
import { createRouter, here, type Router, type View } from "./router.ts";
import { startSite } from "./site.ts";
import { type AppState, createStore, initialState, type Store } from "./store.ts";
import { createSync } from "./sync.ts";
import { createUnread } from "./unread.ts";
import { startUpdates } from "./update.ts";
import { createCollectionView } from "./views/collection.ts";
import { createHomeView } from "./views/home.ts";
import { createLoginView } from "./views/login.ts";
import { createProfileView } from "./views/profile.ts";
import { createRoomView } from "./views/room.ts";
import { createRoomsView } from "./views/rooms.ts";

export interface App {
  store: Store<AppState>;
  router: Router;
  /** End the session and go home, as a guest (what the profile page's Log out does). */
  logOut(): void;
  stop(): void;
}

/** notify.ts's NOTIFY_KEY (§34): someone here turned notifications on. */
export const NOTIFY_KEY = "chat.notify";

/** The pages for logging in and signing up: only for guests, and never where to go back to after logging in. */
const AUTH_PAGES = new Set(["/login", "/signup"]);

/** Starts the main view of the mounted layout over (a room that came back, §23.4): one per app. */
interface Panes {
  reload: () => void;
}

/**
 * Page layout (§7.1): the room list as a sidebar next to the main view. New params remount only the
 * main view, so switching rooms keeps the sidebar (and anything typed into it).
 */
function withSidebar(panes: Panes, sidebar: () => View, main: () => View, layoutClass = ""): () => View {
  return () => {
    const side = sidebar();
    let pane = main();
    const content = h("div", { class: "pane" });
    let root: HTMLElement;
    let current: Record<string, string> = {};
    // A fresh view rather than a remount: late async work of the old one must not see itself as active.
    const fresh = () => {
      pane.unmount();
      pane = main();
      pane.mount(content, current);
    };
    return {
      mount(el, params) {
        root = el;
        current = params;
        panes.reload = fresh;
        const aside = h("aside", { class: "sidebar" });
        el.replaceChildren(h("div", { class: `layout ${layoutClass}`.trim() }, [aside, content]));
        side.mount(aside, {});
        pane.mount(content, params);
      },
      update(params) {
        current = params;
        fresh();
      },
      unmount() {
        if (panes.reload === fresh) panes.reload = () => {};
        pane.unmount();
        side.unmount();
        clear(root);
      },
    };
  };
}

/** The rooms kept for opening fast (§7.5), and the thumbnails the service worker kept (sw.ts, FILES). */
function forgetCached(cache: Cache) {
  cache.clear();
  void globalThis.caches?.delete("chat-files").catch(() => {});
}

export function startApp(deps: { api: Api; root: HTMLElement }): App {
  const { api, root } = deps;
  // A session that ran out while the app was closed was never ended (endSession): what it left goes now.
  const expired = api.forgetExpired();
  const store = createStore<AppState>({ ...initialState(), user: api.currentUser(), away: document.visibilityState === "hidden" });
  const sync = createSync({ api, store });
  const unread = createUnread({ api, store });
  const collections = createCollections({ api, store });
  const drafts = createDrafts(() => store.get().user?.id ?? "");
  const cache = createCache();
  if (expired) {
    drafts.clear(expired);
    forgetCached(cache);
  }
  const offGone = forgetGone(cache, store);
  const prefetch = createPrefetch({ api, store, cache });
  const panes: Panes = { reload: () => {} };
  /** Notifications (§34), a lazy chunk loaded only once they are on: its stop. */
  let notify: Promise<() => void> | null = null;
  const startNotify = () => {
    try {
      if (notify || !store.get().user || !localStorage.getItem(NOTIFY_KEY)) return;
    } catch {
      return;
    }
    const loading = import("./notify.ts").then(
      (m) => m.startNotify({ api, store, title: roomTitle, navigate: (path) => router.navigate(path) }),
      () => {
        if (notify === loading) notify = null; // tried again next time
        return () => {};
      },
    );
    notify = loading;
  };
  const stopNotify = () => {
    void notify?.then((stop) => stop());
    notify = null;
  };
  /** Start following the rooms (and, signed in, the unread counts and prefetching, §7.5) as whoever is logged in now, or as a guest. */
  let running = false;
  const startSession = () => {
    running = true;
    sync.start();
    if (!store.get().user) return;
    unread.start();
    collections.start();
    prefetch.start();
    startNotify();
  };
  /** The page a guest was on before going to log in or sign up: where logging in takes them back to (§23.3). */
  let lastPage = AUTH_PAGES.has(here()) ? "/" : here();
  const onNavigate = (path: string) => {
    if (!AUTH_PAGES.has(path)) lastPage = path;
    // Who you are, at the sidebar's foot and in the app bar: lit while on your settings.
    for (const a of root.querySelectorAll("a.me-link")) {
      if (path === "/me") a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  };

  const header = createHeader({ api, store });
  const main = h("main", { class: "app-main" });
  clear(root);
  root.append(header.el, main);

  /** Drop everything that belonged to the logged-in user. The session itself is left as it is. */
  function endSession() {
    if (!running) return; // logging out ends it before the auth change would (QA BUG-62)
    running = false;
    // Reads still waiting go out now, while the session is there. After another tab switched it to someone else,
    // this sends nothing: a reader only sends as the user it was opened for.
    unread.flush();
    unread.stop();
    collections.stop();
    prefetch.stop();
    stopNotify();
    sync.stop();
    void api.unsubscribeAll().catch(() => {});
    drafts.clear(store.get().user?.id ?? "");
    forgetCached(cache);
    store.set({ ...initialState(), site: store.get().site });
  }

  /**
   * Someone else is logged in now (or nobody): everything that belonged to the previous one goes, the rooms are
   * followed again as the new one (or as a guest), and the views start over.
   */
  function switchTo(next: User | null, after = "/") {
    const fromAuthPage = AUTH_PAGES.has(here());
    endSession();
    if (next) store.set({ user: next });
    startSession();
    // Logged in from the login page: back to the room you were reading. Logged out: home (or `after`).
    if (next && fromAuthPage) history.replaceState(null, "", lastPage);
    if (!next) {
      history.replaceState(null, "", after);
      // After a logout, whoever logs in next starts from home, not from the page the previous user was on (their
      // profile, a room; QA BUG-59). An expired session is logged back into where it was.
      if (!AUTH_PAGES.has(after)) lastPage = "/";
    }
    router.remount();
  }

  /** `after`: where to go, as a guest. */
  function logOut(after = "/") {
    // End the session before clearing it, so the auth-change listener below sees nothing left to do.
    endSession();
    api.logOut();
    switchTo(null, after);
  }
  /** The session ran out or was revoked: the login page, and back to this page once logged in again. */
  const expire = () => logOut("/login");

  const renewal = createRenewal({ api, store, expire });
  const onVisible = () => {
    // Before the room view's own listener (registered later) reads what is on screen.
    store.set({ away: document.visibilityState === "hidden" });
    if (document.visibilityState === "visible") renewal.visible();
  };

  /**
   * The session is shared by every tab of this browser. When another tab logs out or logs in as someone else,
   * follow it: otherwise this tab would keep showing one user while its requests go out as another (or as nobody).
   */
  function onAuthChange() {
    const next = api.currentUser();
    const cur = store.get().user;
    if (next?.id === cur?.id) {
      // Same user: our own login/refresh, or a profile change (here or in another tab, BUG-33): follow name and avatar.
      if (next && cur && (next.name !== cur.name || (next.avatar ?? "") !== (cur.avatar ?? ""))) store.set({ user: next });
      return;
    }
    // Views mounted for the previous user (or the guest) hold its subscriptions and state: they start over.
    switchTo(next);
  }

  const ctx: Ctx = {
    api,
    store,
    sync,
    unread,
    collections,
    actions: createRoomActions({ api, store }),
    navigate: (hash) => router.navigate(hash),
    reopen: () => panes.reload(),
    drafts,
    cache,
    logOut,
    notify: startNotify,
  };
  const rooms = () => createRoomsView(ctx);
  const roomPage = withSidebar(panes, rooms, () => createRoomView(ctx));

  const authPage = (mode: "login" | "signup") => () =>
    createLoginView({
      api,
      store,
      mode,
      onLogin: (user) => {
        // Usually followed already: logging in changed the session (onAuthChange).
        if (store.get().user?.id !== user.id) switchTo(user);
        router.navigate(lastPage);
      },
    });
  const router = createRouter({
    onNavigate,
    root: main,
    isAuthed: () => store.get().user !== null,
    routes: [
      { pattern: "/login", public: true, guestOnly: true, view: authPage("login") },
      { pattern: "/signup", public: true, guestOnly: true, view: authPage("signup") },
      // Guests see the Open Air rooms (§23.3); a room they can't see says it doesn't exist.
      { pattern: "/", public: true, view: withSidebar(panes, rooms, () => createHomeView(ctx), "home") },
      { pattern: "/r/:id", public: true, view: roomPage },
      { pattern: "/r/:id/m/:msgId", public: true, view: roomPage },
      { pattern: "/c/:id", public: true, view: withSidebar(panes, rooms, () => createCollectionView(ctx)) },
      { pattern: "/me", view: withSidebar(panes, rooms, () => createProfileView(ctx)) },
    ],
  });

  const stopJumpTo = startJumpTo({ api, store, root, navigate: (path) => router.navigate(path) });
  const offAuth = api.onAuthChange(onAuthChange);
  // A file dropped where nothing takes it must not make the browser open it and leave the app (QA BUG-27).
  // The room and the profile picture handle their own drops; this only cancels the browser's default.
  const swallowFileDrag = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", swallowFileDrag);
  window.addEventListener("drop", swallowFileDrag);
  document.addEventListener("visibilitychange", onVisible);
  const onStorage = (e: StorageEvent) => (e.key === NOTIFY_KEY || e.key === null) && startNotify();
  window.addEventListener("storage", onStorage);
  const stopSite = startSite(api, store);
  const stopFavicon = startFavicon(store);
  const stopUpdates = startUpdates(api, root);
  startSession();
  router.start();

  // A restored session is checked (and renewed) right away.
  renewal.renew();

  return {
    store,
    router,
    logOut,
    stop() {
      offAuth();
      renewal.stop();
      window.removeEventListener("dragover", swallowFileDrag);
      window.removeEventListener("drop", swallowFileDrag);
      document.removeEventListener("visibilitychange", onVisible);
      stopJumpTo();
      window.removeEventListener("storage", onStorage);
      stopNotify();
      header.stop();
      stopFavicon();
      stopUpdates();
      stopSite();
      offGone();
      router.stop();
      unread.stop();
      collections.stop();
      prefetch.stop();
      sync.stop();
      clear(root);
    },
  };
}
