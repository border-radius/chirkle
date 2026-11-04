// The service worker (DESIGN.md §27): the app opens offline and can be installed. Built on its own to /sw.js (it must
// sit at the root to control every page); app.js imports nothing from it.
//
// - Pages: network first, so a deploy shows on the next load; offline, the last page loaded (index.html: every page
//   of the app is the same shell, §7.1).
// - Content-hashed assets (/assets/*-HASH.js|css|woff2): cache first; they never change under one name.
// - Attachment thumbnails and video posters (§30.1): cache first. They never change under one name, and are kept here
//   so a room opens with them offline too.
// - Everything else, the API and realtime included, is left to the browser: no stale data, no other cached files.
// - Notifications (§34) are made by the pages (notify.ts) through this worker; a click opens the message in a tab of
//   the app (the one in front, else any), or in a new one. No push: nothing wakes this worker but the pages.

// Only what this file uses: the "dom" lib has no service worker types, and "webworker" conflicts with it.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Promise<Response>): void;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification;
}
interface WindowClient {
  readonly url: string;
  readonly focused: boolean;
  readonly visibilityState: DocumentVisibilityState;
  focus(): Promise<WindowClient>;
  postMessage(data: unknown): void;
}
interface Scope {
  addEventListener(type: "install" | "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "notificationclick", fn: (e: NotificationEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
}

export {}; // a module: these types stay out of the global scope

const sw = self as unknown as Scope;

const CACHE = "chat-shell";
/** The key the last page is kept under. */
const SHELL = "/";
/** esbuild's "[name]-[hash]" names; the server caches these for a year too (§5.6). Dev builds are unhashed. */
const HASHED = /^\/assets\/.+-[A-Z0-9]{8}\.(js|css|woff2)$/;

/** Thumbnails; app.ts deletes this cache when a session ends. */
const FILES = "chat-files";
/** An attachment: /api/files/messages/{message}/{file}. */
const ATTACHMENT = /^\/api\/files\/messages\/[a-z0-9]+\/[^/]+$/;
/** A video's poster: /api/chat/posters/{message}/{file}. Like a thumbnail, it never changes under one name. */
const POSTER = /^\/api\/chat\/posters\/[a-z0-9]+\/[^/]+$/;
/** At most this many thumbnails are kept (~20–40 KB each); the oldest go first. */
const MAX_FILES = 1000;
/** Thumbnails kept by this worker: every TRIM_EVERY-th (the first included) trims the cache to MAX_FILES. */
let puts = 0;
const TRIM_EVERY = 50;

// A new worker takes over at once: it holds no state an old page depends on.
sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));
sw.addEventListener("activate", (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data as { url?: unknown } | null)?.url;
  if (typeof url === "string" && /^\/(?![/\\])/.test(url)) e.waitUntil(openPage(url)); // a path here, not "//elsewhere"
});

/** Show `url` in the app's tab in front (else a visible one, else any), or in a new tab; that page navigates (notify.ts). */
async function openPage(url: string) {
  const tabs = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  const tab = tabs.find((c) => c.focused) ?? tabs.find((c) => c.visibilityState === "visible") ?? tabs[0];
  if (!tab) return sw.clients.openWindow(url);
  await tab.focus().catch(() => {});
  tab.postMessage({ open: url });
}

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  const thumb = ATTACHMENT.test(url.pathname) && url.searchParams.get("thumb");
  if (thumb || POSTER.test(url.pathname)) {
    // Kept under the URL with nothing but the thumbnail size: an older page may still add a file token (§37.3).
    e.respondWith(thumbnail(e, `${url.origin}${url.pathname}${thumb ? `?thumb=${encodeURIComponent(thumb)}` : ""}`));
    return;
  }
  // Files (opened in a tab) and the admin UI are not the app's pages.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_/")) return;
  if (req.mode === "navigate") e.respondWith(page(e));
  else if (HASHED.test(url.pathname)) e.respondWith(asset(req));
});

/** @returns the page from the network, kept for offline; offline, the last one kept */
async function page(e: FetchEvent): Promise<Response> {
  try {
    const res = await fetch(e.request);
    if (res.ok && res.headers.get("content-type")?.startsWith("text/html")) e.waitUntil(keep(res.clone()));
    return res;
  } catch (err) {
    const kept = await caches.match(SHELL, { cacheName: CACHE });
    if (kept) return kept;
    throw err;
  }
}

/** Keep the page, and drop the assets of older builds: those it doesn't name (a lazy chunk comes back when used). */
async function keep(res: Response) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  await cache.put(SHELL, res);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path !== SHELL && !html.includes(path)) await cache.delete(req);
  }
}

/** @returns the cached asset, else the network's (kept when it is a success) */
async function asset(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

/**
 * A thumbnail never changes under one name (a new upload gets a new file name), so a kept one is served without asking
 * the server. A success is kept under `key`.
 */
async function thumbnail(e: FetchEvent, key: string): Promise<Response> {
  const cache = await caches.open(FILES);
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await fetch(e.request);
  if (res.ok) e.waitUntil(keepThumbnail(cache, key, res.clone()));
  return res;
}

async function keepThumbnail(cache: Cache, key: string, res: Response) {
  await cache.put(key, res);
  if (puts++ % TRIM_EVERY) return;
  // Keys come back in the order they were put.
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) await cache.delete(k);
}
