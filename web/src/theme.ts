// Light, dark or the system's (auto) theme (§7.8): this device's choice, kept in localStorage. index.html's inline
// script sets <html data-theme> before the first paint; this keeps it, and the browser's bar color, up to date.

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Must match index.html's inline script. */
export const THEME_KEY = "chat.theme";

/** --surface of each theme (tokens.css), for <meta name="theme-color">. */
const BAR = { light: "#f1eefc", dark: "#111214" } as const;

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function savedTheme(storage: Storage | null = safeLocalStorage()): Theme {
  try {
    const v = storage?.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

/** Show `theme` here: the stylesheet goes by <html data-theme>, the browser's bar by the theme-color metas. */
export function applyTheme(theme: Theme, doc: Document = document): void {
  const html = doc.documentElement;
  if (theme === "auto") delete html.dataset.theme;
  else html.dataset.theme = theme;
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // Each meta's own media query says which theme it is for; a chosen theme gives both its color.
    const forTheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = BAR[theme === "auto" ? forTheme : theme];
  }
}

/** Save and show `theme`. Storage can throw (private window, quota): the theme still changes for this page. */
export function setTheme(theme: Theme, storage: Storage | null = safeLocalStorage()): void {
  try {
    if (theme === "auto") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
  } catch {}
  applyTheme(theme);
}

/** Apply the saved theme and follow another tab's changes. Returns a function that stops following. */
export function startTheme(storage: Storage | null = safeLocalStorage()): () => void {
  applyTheme(savedTheme(storage));
  const ac = new AbortController();
  addEventListener(
    "storage",
    (e) => {
      if (e.key === THEME_KEY || e.key === null) applyTheme(savedTheme(storage));
    },
    { signal: ac.signal },
  );
  return () => ac.abort();
}
