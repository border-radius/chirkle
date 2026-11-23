// Light, dark or the system's (auto) theme (§7.8): this device's choice, kept in localStorage. index.html's inline
// script sets <html data-theme> before the first paint; this keeps it, and the browser's bar color, up to date.

export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Must match index.html's inline script. */
export const THEME_KEY = "chat.theme";

/** --surface of each theme (tokens.css), for <meta name="theme-color">. */
const BAR = { light: "#ffffff", dark: "#111214" } as const;

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

/** Apply the saved theme and text size and follow another tab's changes. Returns a function that stops following. */
export function startTheme(storage: Storage | null = safeLocalStorage()): () => void {
  applyTheme(savedTheme(storage));
  applySize(savedSize(storage));
  const ac = new AbortController();
  addEventListener(
    "storage",
    (e) => {
      if (e.key === THEME_KEY || e.key === null) applyTheme(savedTheme(storage));
      if (e.key === SIZE_KEY || e.key === null) applySize(savedSize(storage));
    },
    { signal: ac.signal },
  );
  return () => ac.abort();
}

// Text size (§7.8): Small (the default), Medium or Large, this device's choice like the theme. index.html's inline
// script sets <html data-size> before the first paint; the stylesheet scales the root font size by it.

export const SIZES = ["small", "medium", "large"] as const;
export type Size = (typeof SIZES)[number];

/** Must match index.html's inline script. */
export const SIZE_KEY = "chat.size";

export function savedSize(storage: Storage | null = safeLocalStorage()): Size {
  try {
    const v = storage?.getItem(SIZE_KEY);
    return v === "medium" || v === "large" ? v : "small";
  } catch {
    return "small";
  }
}

export function applySize(size: Size, doc: Document = document): void {
  const html = doc.documentElement;
  if (size === "small") delete html.dataset.size;
  else html.dataset.size = size;
}

/** Save and show `size`. Storage can throw: the size still changes for this page. */
export function setSize(size: Size, storage: Storage | null = safeLocalStorage()): void {
  try {
    if (size === "small") storage?.removeItem(SIZE_KEY);
    else storage?.setItem(SIZE_KEY, size);
  } catch {}
  applySize(size);
}
