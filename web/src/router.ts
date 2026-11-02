// Router (§7.1, §7.2): pages are paths (`/r/abc`), changed with the History API; PocketBase serves index.html for any
// path that isn't a file. Old `#/r/abc` links still work. Idempotent: re-resolving to the mounted route does nothing.

export interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void;
  /**
   * Optional: take new params in place. Used instead of a remount when the next route has the same view
   * factory, e.g. switching rooms keeps the sidebar mounted.
   */
  update?(params: Record<string, string>): void;
  /**
   * Optional: kept, hidden, after it was left (app.ts withSidebar keeps the last rooms, PERF.md §5): still live, but not
   * what you are looking at. `resume` shows it again; false if it can't be (it is to be unmounted and made afresh).
   */
  park?(): void;
  resume?(): boolean;
}

export interface Route {
  pattern: string;
  view: () => View;
  /** Reachable without auth (guests read the Open Air rooms, §23.3). */
  public?: boolean;
  /** Only for guests (logging in, signing up): signed in, it goes home. */
  guestOnly?: boolean;
}

export interface Router {
  start(): void;
  stop(): void;
  /** Go to `path` (a new history entry), or re-check it if it is where we are. */
  navigate(path: string): void;
  /** Re-check the current route, e.g. after auth changes. */
  refresh(): void;
  /** Unmount the current view and resolve the route again with a fresh one (e.g. after the user changed). */
  remount(): void;
}

const HOME = "/";
const LOGIN = "/login";

/**
 * The page we are on, as a path (what routes match). An old-style URL (`/#/r/abc`, from before paths) is its hash's.
 * A trailing slash (`/r/abc/`, typed or pasted) is dropped, and leading ones are one: `#//host` as a URL is another
 * site's, which replaceState refuses, and the app never started (QA BUG-146).
 */
export const here = (): string =>
  (location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname).replace(/^[/\\]+/, "/").replace(/(.)\/$/, "$1");

/** An old-style URL: show it as its path (`/r/abc`) instead. True if it was one. */
function fromLegacyHash(): boolean {
  if (!location.hash.startsWith("#/")) return false;
  history.replaceState(history.state, "", here());
  return true;
}

export function matchRoute<R extends { pattern: string }>(
  routes: readonly R[],
  path: string,
): { route: R; params: Record<string, string> } | null {
  const parts = (path || HOME).split("/");
  for (const route of routes) {
    const pp = route.pattern.split("/");
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pp.every((seg, i) => {
      const part = parts[i]!;
      if (!seg.startsWith(":")) return seg === part;
      if (!part) return false;
      try {
        params[seg.slice(1)] = decodeURIComponent(part);
      } catch {
        return false; // malformed escape (e.g. "%E0%A4%A"): no match, so it redirects home
      }
      return true;
    });
    if (ok) return { route, params };
  }
  return null;
}

export function createRouter(opts: {
  root: HTMLElement;
  routes: Route[];
  isAuthed: () => boolean;
  /** The user went somewhere (a link, Back/Forward, `navigate()`), before any redirect. */
  onNavigate?: (path: string) => void;
}): Router {
  const { root, routes, isAuthed } = opts;
  let current: { key: string; factory: () => View; view: View } | null = null;
  let running = false;
  /** Stops the listeners added by start(). */
  let listening: AbortController | null = null;

  function unmountCurrent() {
    current?.view.unmount();
    current = null;
  }

  /** Where `path` must go instead, or null if it may be shown. */
  function redirect(route: Route | undefined): string | null {
    if (!route) return HOME;
    if (!route.public && !isAuthed()) return LOGIN;
    if ((route.guestOnly || route.pattern === LOGIN) && isAuthed()) return HOME;
    return null;
  }

  function resolve() {
    if (!running) return;
    const path = here();
    const m = matchRoute(routes, path);
    const target = redirect(m?.route);
    if (target !== null && target !== path) {
      history.replaceState(null, "", target);
      return resolve();
    }
    if (!m) return; // unreachable: no match always redirects to HOME, which matches

    if (current?.key === path) return;
    if (current?.factory === m.route.view && current.view.update) {
      current.key = path;
      current.view.update(m.params);
      return;
    }
    unmountCurrent();
    const view = m.route.view();
    current = { key: path, factory: m.route.view, view };
    view.mount(root, m.params);
  }

  function go(path: string) {
    if (here() !== path) {
      history.pushState(null, "", path);
      opts.onNavigate?.(path);
    }
    resolve();
  }

  /**
   * An entry the image viewer (§17.7) or the media grid (§30) added with nothing open on it: Forward after Back closed
   * it, or a reload while it was open. It would take an extra Back that seems to do nothing, so it is passed over.
   * (While a viewer is open, a popstate only ever leaves its entry, so this never meets an open viewer; the grid's
   * entry is met with the grid open when Back closes a viewer over it, QA BUG-118.)
   */
  const skipViewerEntry = () => {
    const s = history.state as { viewer?: unknown; media?: unknown } | null;
    if (s?.viewer || (s?.media && !document.querySelector("dialog.media"))) history.back();
  };
  /** Back/Forward. (Also the image viewer's own history entry, §17.7: same path, so nothing to do.) */
  const onPopState = () => {
    skipViewerEntry();
    opts.onNavigate?.(here());
    resolve();
  };
  /** An old-style link (`#/r/abc`) opened in this tab. */
  const onHashChange = () => {
    if (!fromLegacyHash()) return;
    opts.onNavigate?.(here());
    resolve();
  };
  /** A click on a link to one of the app's pages shows it here, without loading the page again. */
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!(a instanceof HTMLAnchorElement) || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
    if (!matchRoute(routes, a.pathname)) return;
    e.preventDefault();
    go(a.pathname);
  };

  return {
    start() {
      running = true;
      fromLegacyHash();
      skipViewerEntry();
      listening = new AbortController();
      const { signal } = listening;
      window.addEventListener("popstate", onPopState, { signal });
      window.addEventListener("hashchange", onHashChange, { signal });
      document.addEventListener("click", onClick, { signal });
      resolve();
    },
    stop() {
      running = false;
      listening?.abort();
      unmountCurrent();
    },
    navigate: go,
    refresh: resolve,
    remount() {
      unmountCurrent();
      resolve();
    },
  };
}
