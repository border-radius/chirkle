# §27. Installable app (PWA)

Part of the design document: [index](../DESIGN.md).

The app can be installed (Add to Home Screen, the browser's Install button) and opens offline to its shell. No push
notifications and no offline data: what the server says is fetched as before (the room cache, §7.5, only shows
a room's last page while it loads; it isn't used offline).

## 27.1 Manifest and icons

- `GET /manifest.webmanifest` (`manifest()` in `pb_hooks/lib/site.js`) is built per request: `name` and `short_name`
  are the site's title (§24), so the installed app is named like the site. `start_url` and `scope` are `/`,
  `display: standalone`; `theme_color` is the app bar's (`--surface`) and `background_color` the page's (`--bg`),
  light theme (a manifest has one of each). `application/manifest+json`, `no-cache`, like every page (§5.6).
- **Icons** (`web/public/icons/`, copied to `pb_public/icons/` by `build` and `dev`): the logo as `icon.svg` (the same
  as `logo.svg` at the repo root, traced from `logo.jpeg`, 2026-11-06; the app bar and the login page draw it too),
  192 and 512 px PNGs, a 512 px maskable one (the bubble inside the safe zone, on `--surface`) and a 180 px
  `apple-touch-icon.png` for iOS (opaque: iOS fills transparency with black). The site's logo isn't used: it may be
  any image, an SVG or a small one, and an installed app needs square PNGs.
- `index.html` links the manifest and the Apple icon, and sets `theme-color` for light and dark.

## 27.2 Service worker

`web/src/sw.ts` is built on its own (`SW_OPTIONS`, an unhashed IIFE) to `/sw.js`, which must sit at the root to
control every page; it is served `no-cache`, so a new one is found on the next load. `main.ts` registers it. A new
worker takes over at once (`skipWaiting`, `clients.claim`): it holds nothing an open page relies on.

- **Pages** (navigations): network first, so a deploy shows on the next load. Each HTML page fetched is kept (every
  page of the app is the same `index.html`, §7.1), and offline the last one kept is served.
- **Content-hashed assets** (`/assets/*-HASH.js|css`): cache first; one name never changes. Keeping a new page drops
  the cached assets it doesn't name (older builds; a lazy chunk comes back when used).
- **Attachment thumbnails** (`GET /api/files/messages/{id}/{file}?thumb=…&token=…`) and the media grid's video
  posters (`GET /api/chat/posters/{id}/{file}?token=…`, §30.1): cache first, in their own cache
  (`chat-files`), kept under the URL without the token plus the token's user id (read from the JWT, not verified:
  the server checks a miss). A file name never changes its content, so a kept thumbnail is never stale. Only
  successes are kept, at most 1000 (oldest out first, trimmed every 50th put). A request with no file token (a
  guest) is left to the browser. When the session ends (logout, a user switch, an expired session), `app.ts`
  deletes the cache, like the room cache (§7.5): a shared computer doesn't keep the last user's pictures. Losing
  access to a room doesn't evict its thumbnails, but the app no longer lists its messages, so nothing asks for them.
- **Everything else** is the browser's: `/api/` (records, realtime, full files: nothing stale and nothing else
  private cached), `/_/`, other origins, anything but `GET`, and unhashed dev assets.

Offline the shell boots and behaves as with the server unreachable: failed loads show their errors and **Retry** (§7.5),
and realtime reconnects when the network is back (§6). A room whose first load failed also tries again on the browser's
`online` event, for when realtime stayed connected through it (QA BUG-123).

## 27.3 Tests

- **Integration:** the manifest is named after the site and lists its icons (`site.test.ts`); `/sw.js` is served
  `no-cache` (`http.test.ts`).
- **E2E** (`pwa.spec.ts`, Chromium): the manifest and every icon load with the right type; once the worker controls
  the page, a page loaded offline still shows the app. A thumbnail is kept once and then served for another token of
  the same user (one the server refuses), not for another user's; logging out deletes the cache. Other specs run with service workers blocked
  (`playwright.config.ts`): the worker fetches hashed assets itself, out of reach of `page.route()`.

## 27.4 A new version (2026-11-02)

A tab left open runs the build it was loaded with until it is reloaded. When a deploy changed the app, a line at the
top of the page (`.update-bar`, above the app bar and the sidebar, `role="status"`) says "A new version of the app is
out." and a **Reload** link (`location.reload()`: pages are network first, §27.2, so it loads the new build).

- **How it knows** (`web/src/update.ts`, started by `app.ts` for guests too): the page's script is
  `/assets/app-HASH.js`; `GET /` (`cache: "no-store"`; not a navigation, so the worker leaves it to the network)
  naming another one is a new build. A failed load or a page that names no script (offline, a restart, a proxy's
  error page) says nothing. Dev builds are unhashed and the name never changes: no line.
- **When:** after a realtime reconnect (a deploy restarts the server and drops every tab's connection), at a random
  moment in the next 10 s so open tabs don't all ask at once; when the tab comes back into view (at most once a
  minute); and every 30 minutes. Once shown, it stops checking. No server change: `index.html` is already served
  `no-cache` (§5.6).
- **Tests:** `tests/unit/update.test.ts` (reconnects, the half-hourly check, failed loads, the first connect);
  `update.spec.ts` (Chromium): `/` answered with another script name shows the line, and Reload loads the page.
