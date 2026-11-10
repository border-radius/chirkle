// The site's branding and signup policy (§24): loaded once at startup into the store. The last one seen is kept in
// localStorage, so a reload shows the site's own title and logo right away instead of the defaults first.

import type { Api } from "./api.ts";
import { DEFAULT_SITE, type Site } from "./lib/types.ts";
import type { AppState, Store } from "./store.ts";

const KEY = "chat.site";

/** The cached site, if it looks like one. */
export function cachedSite(storage: Storage | null): Site | null {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? "null") as Partial<Site> | null;
    if (!v || typeof v.title !== "string" || !v.title || typeof v.logo !== "string" || typeof v.inviteOnly !== "boolean") return null;
    return { title: v.title, logo: v.logo, inviteOnly: v.inviteOnly, passwordReset: v.passwordReset === true };
  } catch {
    return null;
  }
}

/** Show the cached site, then the server's. Failing to load keeps what is shown. Returns a function that stops it. */
export function startSite(api: Api, store: Store<AppState>, storage: Storage | null = safeLocalStorage()): () => void {
  const cached = cachedSite(storage);
  if (cached) store.set({ site: cached });
  const ac = new AbortController();
  api.site(ac.signal).then(
    (site) => {
      if (ac.signal.aborted) return;
      const cur = store.get().site;
      const changed =
        site.title !== cur.title ||
        site.logo !== cur.logo ||
        site.inviteOnly !== cur.inviteOnly ||
        site.passwordReset !== cur.passwordReset;
      if (changed) store.set({ site });
      try {
        // Storage can throw (quota, disabled in a private window): the cache is a convenience.
        if (site === DEFAULT_SITE) storage?.removeItem(KEY);
        else storage?.setItem(KEY, JSON.stringify(site));
      } catch {}
    },
    () => {},
  );
  return () => ac.abort();
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
