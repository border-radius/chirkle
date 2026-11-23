# §7. Frontend design

Part of the design document: [index](../DESIGN.md).

## 7.1 Screens and routes (paths)

| Route | View | Notes |
|---|---|---|
| `/login`, `/signup` | login / signup (tabbed form) | guests only (§23.3); `/me` redirects here without a session. Until §23 every route did. |
| `/` | room list + "new room" form, with a greeting where a room would be | on narrow screens only the room list shows |
| `/r/:roomId` | room: message list + composer | on wide screens the room list stays visible as a sidebar |
| `/r/:roomId/m/:msgId` | room, opened at a specific message (window centered on it) | used by "jump to beginning" and shareable later |

**The room list** (the sidebar, 2026-10-31 redesign) has the brand at the top, then a "Jump to…" row (§32) and
Mentions & replies (§41), then Rooms, Direct messages and Collections, then one folded **Hidden & archived** section, and at the foot the user (avatar and
name, linking to the profile) with a Settings button (a guest gets Log in and Sign up there instead):

1. **Rooms:** active rooms that aren't hidden, sorted by name, those with unread messages first.
2. **Hidden & archived:** collapsed by default and shown with how many rooms it holds; not listed at all when it holds
   none (until 2026-11-23 it said "Nothing hidden or archived"). Inside, a **Hidden** part, each row with an "Unhide" button, and an **Archived** part (read-only rooms,
   still browsable; the creator gets "Unarchive"). Until 2026-10-31 these were two sections.

A room hidden by the user that is also archived appears only under Archived, with "Unhide". A hidden or archived
row's button shows while pointing at the row or focusing it. Rows have no menu: Hide, Archive and Close conversation are
in the room's own menu (until 2026-10-31 each row also had a ⋯ menu). The new-room form opens in place under Rooms: a "#" name field,
a segmented Public / Private / Open air choice with a hint, Cancel and Create room.

The Rooms, Direct messages and Collections headings are buttons (`aria-expanded`) that fold their section. A folded section still lists its unread rooms (collections with new items) and the open one, so nothing new is missed. Unfolded, the rooms and DMs with unread messages are listed first (each group in its usual order), so they are at the top either way (2026-10-23). Which sections are folded is kept in this browser (`localStorage`, `chat.folded`).

**The room header** has a back arrow (phones), "#" and the name, a Private or Open Air badge, a private room's members
(up to three faces and how many, opening the access dialog), and icon buttons for search (§29), media (§30) and the
menu (⋯). **The menu** has icons, in groups split by lines:

- **Room access…** (the creator) or **Members (n)** (a member of a private room).
- **Hide room** (or **Unhide**), for everyone.
- **Archive room** (or **Unarchive**), for the creator only, behind an inline confirm.
- **Notify of every message** (§34.5), a switch (`role="switch"`, QA BUG-189) rather than two labels.
- **Jump to beginning**.

An archived room shows a banner, "This room is archived. History is read-only.", and replaces the composer with that banner.

Pages are paths (`/r/abc`), not hashes. PocketBase serves `index.html` for any path that isn't a file (`serve --indexFallback`, on by default), with the same headers as `/` (§5.6), so a page opened directly or reloaded works with no server-side routes. The router (`router.ts`) changes pages with the History API: `navigate()` pushes an entry, `popstate` (Back, Forward) is followed, and a plain left click on a link to one of the routes is taken over (no page load); a click asking for a new tab or window, a link with `target` or `download`, and links elsewhere (files under `/api/`, other sites) are left to the browser. Old-style links (`/#/r/abc`, from when the app used hashes) still work: on start, or when one is opened in a running tab (`hashchange`), the URL is replaced by its path. A trailing slash (`/r/abc/`) is the same page. The app learns where the user went (to return there after logging in) from the router's `onNavigate`, called before any redirect. It matches the path against a small route table, calls the current view's `unmount()`, then calls the next view's `mount(el, params)`. When the next route uses the same view factory and the mounted view has `update(params)`, the router calls that instead. The room page uses this to swap only the room pane, so the sidebar stays mounted while switching rooms.

## 7.2 View contract

```ts
interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void; // remove listeners, unsubscribe realtime, abort fetches
  update?(params: Record<string, string>): void; // optional: take new params without a remount
}
```

Each view owns a `Scope` (`scope.ts`): an `AbortSignal` that every `addEventListener` call receives, plus `defer()`/`sub()` for store listeners and realtime subscriptions, so `unmount()` is `scope.dispose()`. After every `await`, async work checks `scope.active`. Views are single-use: the router and the sidebar layout create a fresh one for every mount. Both room menus (row and header) are `ui/menu.ts`, a `<details>` disclosure with an optional inline confirm step. It owns its focus handling.

Logged-in views receive the part of `Ctx` (`context.ts`) they use (a `Pick`, e.g. `RoomCtx`): `api`, `store`, `sync`, `actions`, `navigate` and the other services. They render from the store and change data through `actions` (`actions.ts`: create, hide, unhide, archive). Only the room view subscribes to anything itself, and only to its own room's messages.

## 7.3 DOM helpers (`dom.ts`)

```ts
h("div", {class: "msg", dataset: {id}}, [h("b", {}, name), text]) // returns HTMLElement
```

- Children that are strings become **text nodes**. There is no `innerHTML` anywhere in the codebase, and a lint check enforces this (§9.5). This is the main defense against XSS.
- No reactivity system. Views update the DOM directly in response to store events.
- Modal dialogs: a click on the backdrop (pressed and released outside the dialog's box) closes any open `<dialog>`,
  as Escape does — through a cancelable `cancel` event, so a dialog that holds off Escape (busy saving or forwarding,
  the access dialog's people search open) holds off the click too. One document listener, `closeDialogsOnBackdrop()`,
  installed by `main.ts`, since the dialogs live in lazy chunks (2026-11-11).

## 7.4 State (`store.ts`)

This is a typed event emitter around a plain object: `{ user, rooms: Map, hidden: Map<roomId, hiddenRowId>, roomsStatus, activeRoomId }`. Updates such as `upsertRoom(r)` and `markHidden(roomId, rowId)` live next to the store and replace maps rather than mutating them. `sync.ts` owns `rooms`, `hidden` and `roomsStatus` while someone is logged in: it loads both lists, holds the only `rooms` and `hidden_rooms` subscriptions, and reloads after each reconnect. A reload's answer is older than whatever changed in the store while it was out (live events, and what this tab did itself: a room created, a DM opened, a room hidden or shown, which may have no event yet), so while a reload is out, `sync.ts` notes every room (and every hidden row) that changes in the store, and its answer takes those from the store as it is then, or leaves them out if gone (QA BUG-69, BUG-107). The selector `roomSections(state)` splits rooms into Rooms, Hidden and Archived. It is a pure function and is unit-tested. Message lists are **not** kept in global state. Each room view owns its own `MessageList` model (§7.5) and throws it away on unmount, which keeps memory bounded. Only each room's latest page outlives it, in IndexedDB (§7.5, room cache).

## 7.5 Message list (hot path)

**Requirement:** a user can scroll back to the first message of any room, however long its history is, and the page must stay fast. Rendering every message would make the DOM grow without bound, so the list is a **sliding window** over the history, with keyset cursors at both ends.

The list logic is written as **pure functions** in `lib/messages.ts` so it can be tested without a DOM:

- `merge(win, incoming[]) → win` keeps the window sorted by `(created, id)` and dedupes by `id`. When the same id arrives twice, the version with the later `updated` wins, which handles edits.
- `remove(win, id)`.
- `trim(win, side, max) → {win, dropped}` drops messages from the far end of the window.
- `group(win)` places consecutive messages by the same author within 5 minutes under one header.

The window model is:

```ts
interface MessageWindow {
  items: Message[];      // sorted (created, id), at most WINDOW_MAX (300)
  hasOlder: boolean;     // false ⇒ items[0] is the room's very first message
  hasNewer: boolean;     // false ⇒ window is at the live edge
}
```

**Scrolling behavior:**

| Event | Behavior |
|---|---|
| Open room | Load the latest page (50 messages). `hasNewer = false`. Scroll to the bottom. |
| Top sentinel visible (`IntersectionObserver`) | Fetch the older page by cursor and prepend it. If the window is now over 300 messages, trim from the **bottom** and set `hasNewer = true`. An older page with fewer than 50 messages sets `hasOlder = false` and shows a "Beginning of #room" marker. |
| Bottom sentinel visible while `hasNewer` | Fetch the newer page by cursor and append it, trimming from the **top** and setting `hasOlder = true`. A newer page with fewer than 50 messages sets `hasNewer = false`, which means the window is back at the live edge. |
| "Jump to beginning" | Reset the window to the first page (`hasOlder = false`, `hasNewer = true`) and scroll to the top. |
| "Jump to latest" pill | Reset the window to the latest page and scroll to the bottom. |
| Realtime `create` at the live edge (`!hasNewer`) | Append the message. Auto-scroll only if the user was within 80 px of the bottom; otherwise show "↓ New messages". |
| Realtime `create` while scrolled into history (`hasNewer`) | **Don't append.** The window doesn't hold the messages in between, so appending would leave a gap. Show "↓ New messages · Jump to latest" instead. |
| Realtime `update` (edit or soft delete) | Apply it only if the id is in the window: replace the text, or swap in the placeholder. Otherwise ignore it, because the next fetch will return the current version. |

Each message the user sees is loaded once per visit. Moving the window costs one indexed query of 50 rows, and the DOM never holds more than about 300 messages.

**Rooms you go back to (2026-11-03, PERF.md §5).** The last 3 rooms you left for another stay mounted, out of the page and still live (`app.ts` `withSidebar`, `View.park`/`resume`). Going back puts the room back as it was: scrolled where it was (or at the bottom, if it was there), with what came meanwhile. When something in it is still unread, it goes to the first unread message under the New line, as opening it does (§18.5). Nothing is fetched or drawn again. A room opened at a message (`/r/:id/m/:msgId`), or the same room again, starts afresh. A room's latest page is asked for as its link is pressed, or once the pointer rests on it for 120 ms (`prefetch.ts` `hint`), and the room takes that request as its first page. A kept page keeps its `ETag` (API.md), so asking for it again answers 304 when nothing changed. What counts as read (§18.3) is what an `IntersectionObserver` on the list reports as whole on screen or scrolled past; the view no longer measures rows itself.

The window state machine above lives in `views/room/controller.ts`, which has no DOM; what it writes (sends, edits, deletes, reactions) is `writes.ts`, which reaches the window only through the controller's `WriteCtx`. It reports each change with a hint (render, keep the anchor, scroll to the bottom/top/target), and `views/room.ts` applies that hint to the list.

**DOM rendering (`views/room.ts`, `views/room/messages.ts`):**

- `Map<id, HTMLElement>` gives O(1) update and removal.
- Pages are prepended or appended inside a `DocumentFragment`, and trimmed nodes are removed in one pass. The list is never fully re-rendered.
- **Scroll anchoring:** before prepending, trimming the top, or trimming the bottom, record an anchor element and its `offsetTop`, then restore the scroll position from it afterwards. The visible content must never jump. Native CSS `overflow-anchor` is also enabled.
- **Concurrency:** at most one fetch runs per direction. A stale response is discarded if the window was reset (by a jump or a room change) while it was in flight, using a generation counter.

**Optimistic send with client ids:**

1. The client generates a PocketBase-valid id (15 chars, `[a-z0-9]`, via `crypto.getRandomValues`).
2. The message is inserted immediately with `pending` state (dimmed).
3. `create()` is called with that id.
4. Whichever arrives first, the `create()` response or the realtime `create` event, **replaces** the pending entry by id. The second one is a no-op because of the dedupe.
5. On error the entry is marked `failed` with a **Retry** button that reuses the same id, so a retry can never create a duplicate.
6. Sends go to the server one at a time, in the order they were made: the server orders messages by when it saves them,
   so a slow one (a large attachment) must not be overtaken by the next (QA BUG-71). A message's edits, deletes and
   reactions go one at a time too (QA BUG-72).
7. A send that fails after its room view has gone (another room was opened meanwhile) is kept, and the room's next view
   shows it as failed, with Retry (QA BUG-76). So is one the view showed as failed when it went (QA BUG-119): in
   memory, for this page load.

**Reconnects:** the client (`pb.ts`) reconnects SSE automatically. On every `PB_CONNECT` after the first, the room view checks where its window is:

- **At the live edge:** it fetches *newer than the newest loaded message* (by cursor, repeating until a short page comes back) and merges the results in. This fills the gap from the disconnect, however long it was.
- **Scrolled into history:** it fetches nothing newer, because the next newer-page fetch picks up the missed messages naturally.

In both cases it also refetches the messages *already in the window* that changed while it was disconnected (`updated` later than the newest `updated` it holds), so edits and deletes missed meanwhile apply: a deleted message must never keep showing its text. Sync refetches the room record, in case the room was archived meanwhile.

If the room's first load fails (other than "room not found"), the list shows an error with **Retry** instead of an empty history, the composer is hidden, and the load is retried by itself on the next reconnect.

**Room cache (`cache.ts`):** switching rooms, and reloading the page, shows the room at once, as it was last time,
while its first page loads.

- **What is kept:** per room, in IndexedDB (database `chat`, store `rooms`, keyed by room id), the latest page
  (at most 50 saved messages, never pending or failed ones), whether there is older history and the room record,
  tagged with the user it was loaded for ("" for a guest). Saved a second after the window last changed, when the view
  goes and when the page is left (`pagehide`: a reload, the tab closed; QA BUG-97; written at once and committed, and also to `localStorage`, which the next page moves to IndexedDB, QA BUG-104), and only while the window is at the
  live edge, fresh (not itself from the cache) and the user is still the one it was loaded for: after a logout or a
  user switch nothing more is written. A room that turns out not to be there (not found, or gone from the loaded room
  list: access lost, §23.4) is saved empty, so it isn't shown again (QA BUG-98); so is any kept room that leaves the
  loaded room list while the app is open, open or not (`forgetGone`, QA BUG-101).
- **Shown:** on opening a room without a message in the route, if the cache answers before the first page. Nothing
  else is waited for, except a file token when the kept messages have attachments (§17.3): the room is in the room
  list, or, before the list is in (a reload), the kept room record stands in for it in the store until the list
  replaces it. A room that a loaded list lacks waits for the server's answer (so access you have lost isn't shown,
  §23.4). What you send, edit or react to while it shows stays when the page comes: the page was asked for before,
  and realtime may not have told the room yet (QA BUG-100); a kept copy no newer than the page's gives way to it, so an author's new name or avatar shows (QA BUG-103). A reconnect meanwhile does nothing: the page is on its way. The window is `stale` until the page is in: the page
  then replaces it (pending sends are kept as usual), staying where you scrolled unless you were at the bottom;
  realtime events received meanwhile are replayed on top of it; and loading older history waits for it. What it shows
  counts as read (§18.3), as far as it is on screen, except while it shows at the bottom before the server has said
  where the unread messages start (after a reload): they may start further up (QA BUG-102); leaving before the page is in, the unread counts are fetched again
  rather than taken as zero, since the server may have had more. A first load that fails still shows the error and **Retry**, not the stale window.
- **Prefetched** (`prefetch.ts`): the unread events of other rooms carry no text (§18.3), so when a room's unread count
  goes up (a live message, or the counts loaded at start), its latest page is fetched in the background and kept, and
  opening it shows the new messages at once. A message deleted in another room refetches it too, so the cache doesn't
  show the deleted text when the room is next opened (QA BUG-95; a delete made while the app was closed still shows
  until the first page is in). The fetches start a second after the first count goes up, and messages meanwhile join
  them: a busy room never puts the others off (QA BUG-92). A room fetched less than 30 s ago waits until then, and is
  fetched then if it is still unread: a busy room that stays unread is fetched every 30 s by each user who has it
  unread, not every second (QA BUG-108). Its first unread message (the count going up from none) and a deleted message
  are fetched at once all the same. A room opened before its kept page caught up opens from the network, as when the
  count it was fetched for no longer holds (§18.5). Rooms are fetched one
  at a time, 250 ms apart, and a refused fetch (the rate limit, offline) ends the run: hundreds of rooms with unread
  messages at login must not use up the per-IP request limit (QA BUG-94). The open room is left alone (it gets every
  message live and keeps its own page). Once the room list is in, the rooms not kept yet (the first 30 it lists: DMs,
  then rooms) are fetched the same way after those, so a room never opened on this device opens at once too. Only
  while someone is logged in; stopped before the cache is cleared when the session ends.
- **In memory** too, what was kept since the page loaded: switching back to a room shows it in the same task as the
  click, without waiting for IndexedDB (and without an empty room for a frame). Without IndexedDB, that is all there is.
- **Cleared** whenever the session ends (logout, another user, a guest logging in), as drafts are (§22.3). A room kept
  for another user is never shown, even if a clear was missed. Without IndexedDB (a private window) nothing is kept.

## 7.6 Composer

- `<textarea>` that grows automatically up to 6 lines. **Enter** sends and **Shift+Enter** inserts a newline.
- The send button is disabled when the trimmed text is empty or over 2000 characters. A counter appears after 1800 characters.
- Input is kept on failure, so nothing the user typed is lost.
- Message text is rendered with `white-space: pre-wrap`. No markdown in the MVP.
- **Up arrow** in an empty composer starts editing the user's most recent message in the current window. Deleted messages are skipped.
- **Ctrl+/** (⌘/ on a Mac) anywhere in the room puts the caret in the composer; by the key's place too (`Slash`), for
  layouts where it types something else. While the textarea isn't focused, a key badge in the composer row ("Ctrl /",
  "⌘/", the Jump to button's style) says so; it hides while the textarea is focused, and on touch screens
  (`hover: none`). The textarea carries `aria-keyshortcuts`. A room kept in the background, a banner instead of the
  composer, or a modal dialog over it (the composer inert) leaves focus where it is. Test: `keyboard.test.ts`.
  Android: Ctrl+/ from a hardware keyboard (ANDROID.md §7.2), no badge.

## 7.6.1 Editing messages

- **Starting an edit:** hovering your own message (or long-pressing it on touch screens) shows **Edit** and **Delete**. The Up-arrow shortcut also starts an edit (§7.6).
- **Edit mode:** the message text is replaced in place by a textarea pre-filled with the current text. **Enter** saves, **Esc** cancels, and Shift+Enter inserts a newline. Saving unchanged text is a no-op and makes no request.
- **Optimistic save:** the new text shows immediately. If the save fails, the old text comes back and an inline error appears with a Retry option.
- **"(edited)" label:** shown after the time when `edited_at` is set. Its tooltip gives the edit time.
- **Edits by others:** these arrive as realtime `update` events and replace the message text in place. The scroll position stays anchored. At the live bottom (no newer page, within 80px of the end) the list stays at the bottom instead: a message changed in place, by anyone (an edit, a reaction, its link previews, §28), may have grown, and anchored it would slide under the composer (QA BUG-109).
- **Archived rooms:** Edit and Delete are hidden, and the server rejects them anyway.
- **No edit time limit** in the MVP. Earlier versions of a message are not stored.

## 7.6.2 Deleting messages

- **Delete** asks for an inline confirm: the row shows "Delete this message? **Delete** / Cancel", since browser `confirm()` isn't used.
- **Optimistic delete:** the message is swapped for the placeholder right away. If the request fails, the original text comes back with an inline error.
- **Placeholder:** the author name and time stay. The body shows *"Message deleted"* in muted italics, with no actions and no "(edited)" label. It takes part in author grouping like any other message.
- **Pending or failed sends** (never stored on the server) are simply removed from the list. They don't leave a placeholder.
- **Deletes by others** arrive as realtime `update` events and swap in the placeholder in place. The scroll position stays anchored.

## 7.6.3 Links in messages

- **What becomes a link:** `http://` and `https://` URLs, and `www.` addresses (opened over https), found in the text by
  `linkify()` (`lib/links.ts`). Nothing else: `javascript:`, `data:` and the like stay text, and each link is checked
  with `new URL`. The link shows the text as written.
- **Where it ends:** at whitespace or `<`, `>`, `"`. Punctuation that ends a sentence (`. , : ; ! ? ' " * _ … 。`) is left
  out, as are typographic quotes (`“ ” ‘ ’ « »`, as phones type them: Unicode Pi/Pf), and so is a closing `)` or `]` the link didn't open: in "(see https://en.wikipedia.org/wiki/Rust_(language))" the link
  keeps its own pair.
- **Opening:** in a new tab (`target="_blank" rel="noopener noreferrer nofollow"`), even a link to a page of the app
  (the router leaves `target` links alone, §7.1). Text still only ever reaches the page as text nodes (§7.3): a link
  is an `<a>` made with `h()` around a text node.
- **Not inside other words:** a `www.` right after `@`, `.` or `-` (`bob@www.example.com`, `my.www.example.com`) isn't
  linked.
- Under the message, a ghost line per link (§28): no box, its favicon (or the domain's first letter on a tile), the
  domain without "www.", a dot, the title; the title gives way first.
- Only message bodies: reply quotes are buttons (a link can't go in one), and the edit box shows the raw text.

## 7.7 Performance budget (enforced in CI, §9.4)

Since 2026-11-12 (REFACTOR item 52) the budget is on what a visit loads, not on each file. `npm run build` prints
every figure and fails over one; how fast it feels is checked by `scripts/profile-web.ts` in CI (PERF.md §4).

| What | Budget (gzipped) |
|---|---|
| **The critical path**: `index.html`, `app.js`, the chunks `app.js` imports (code it shares with lazy features, modulepreloaded beside it) and `app.css` | **≤ 65 KB** (61.44 KB at the change: `app.js` 37.3 KB, six chunks 12.4 KB, `app.css` 11.3 KB, `index.html` 0.6 KB; the sum of the per-file budgets it replaced, `app.js` 49.75, `app.css` 11.30, `index.html` 1.5 KB, was 62.5 KB). Raised to 63.5 KB on 2026-11-16: the critical path had reached 62.53 KB with the QA passes' fixes, and was 62.57 KB with §43 (whose calls and styles load with Settings, not here). Raised to 64 KB on 2026-11-23: it sat at exactly 63.50 KB, and the chipless reactions (§20.3) took it to 63.55 KB. Raised to 65 KB on 2026-11-23: the room view redesign (frosted header and message box, the reply's header and square attachment tiles inside the box, the reply-to-you chip, ghost-line link previews, faces on the scroll button) took it to 64.83 KB |
| **Any lazy feature's first use**: its chunk, the chunks it imports that the critical path hasn't loaded, and the stylesheet it links | **≤ 16 KB** each (the largest, the emoji picker with its names, 13.6 KB). The features: `FEATURES` in `scripts/lib/build-utils.mjs` (viewer, search, access, media grid, collections, notifications, emoji, inbox, "@" suggestions, settings, login, forward, people search, Jump to) |
| **The statistics page** (§40): `stats.html`, its script and stylesheet | ≤ 10 KB |
| Web fonts | **Inter**, self-hosted (`web/fonts/`, OFL): one variable woff2 per script (latin 47 KB, latin-ext, cyrillic, cyrillic-ext, greek), each fetched only when a page uses its characters (`unicode-range`), `font-display: swap`, cached for a year under a hashed name. Until 2026-10-31: none |
| Requests on first load | html, js, its chunks (modulepreloaded with it, so in parallel; six at the change) and css + API, then Inter's latin file (a second only for other scripts), off the critical path (text shows in the system font until it arrives); the manifest, its icons and `sw.js` (§27) come after, off the critical path |

Other rules:

- `<script type="module" defer>` in the `<head>` and `<link rel="stylesheet">`. No render-blocking third-party code.
- An inline app shell in `index.html` paints before the JS runs.
- The latest-messages fetch and the SSE subscribe start in parallel.
- `Intl.DateTimeFormat` instances are created once and cached.
- A feature most visits never use can be a lazy chunk (`import()`, esbuild code splitting), like the image viewer
  (§17.7). It imports what it uses like any module: what it shares with `app.js` goes into chunks `app.js` imports,
  named in `index.html` as `<link rel="modulepreload">` (and so in the server's `Link` header, PERF.md §5, and kept by
  the service worker, §27), and counted in the critical path. Until 2026-11-12 the build refused such chunks: lazy
  modules imported types only and got what they used of `app.js` as arguments (the "kits" of `web/src/lazy.ts`, and
  `h` in their options), and each file had a budget of its own, `app.js`'s raised over 40 times ([`history/BUDGETS.md`](../history/BUDGETS.md)). Measured at
  the change (`profile-web`, 3 runs each, `--cpu=4`): cold load to messages 1398 ms before, 1361 ms after (medians);
  warm loads, switches and scrolling within noise.

## 7.8 Styling

- One plain CSS file with custom properties for theming (`web/styles/app/tokens.css`). The look (2026-10-31, from
  the "Chirkle Sidebar Redesign" design, its boards in `docs/design-frames/`): a dark graphite surface by default, from chirkle.com's dark hero demo (2026-11-07: pane `#1a1b1e`,
  sidebar `#111214`, raised `#232428`), Radix violet (2026-11-22, was lavender `#a58bff` in dark, `#5b3df5` in light): step 9 `#6e56cf` as the fill in both
  themes with white on it (`--on-fill`), step 11 for accent text and links (`#baa7ff` dark, `#6550b9` light), pink `#f9a8d4` for the NEW line; 10 px radius for controls,
  16 px for dialogs over a dimmed page; Inter, self-hosted (§7.7), with the system font stack behind it.
- Icons are one-color SVGs used as CSS masks (`web/styles/app/icons.css`): an element with `ic i-<name>` draws the
  icon as its `::before` in `currentColor`. Icon-only buttons carry an `aria-label`. No emoji in the chrome.
- The room is flat: messages without bubbles (36 px avatar, name and time on one line), no message tinted as mine to
  read: a mention of me is highlighted in the text, a reply to me told by its quote, a violet chip with my face, its
  curve violet too; the message tools
  as a small icon toolbar on hover. Room view redesign (2026-11-23, the "Room view redesign" canvas): the header and
  the composer float over the list as frosted glass (`--glass`, 72 % of the pane with a 10 px backdrop blur), so the
  messages stay faintly visible as they scroll under them; `room.ts` measures both and pads the list (`--head-h`,
  `--foot-h`, also its scroll-padding, so what is scrolled to stays clear of them). The header is borderless, a
  private or Open Air room's lock or globe right after its name (its word said, not shown); 56 px on a phone, with the
  back arrow and no members. The composer is one filled box (`--field`) 16 px in from the sides (8 px on a phone): the
  reply's header as its first row (who and the quote on one line, two on a phone, and ×), the text, emoji · attach ·
  send at its end (send a bare accent arrow, faint while there is nothing to send; at the bottom when the text grows),
  then the attachments as 72 px square tiles with a corner ×, a row that scrolls sideways. On a phone, once the text
  takes more than one line, the buttons go to a row of their own under it (and stay there until the text is shorter
  than when it wrapped, so they don't flip with every letter). The selection bar or a "why you can't post" notice
  replaces the box, solid. The scroll button ("New messages", "Jump to latest", "Back to reply") is the same glass and
  shows who it is about: the newest three authors of the messages that came out of sight (not me), or whose reply
  "Back to reply" returns to; "Jump to latest" keeps its arrow.
- `prefers-color-scheme` light and dark themes. The profile page's Appearance switch (Auto, Light, Dark) overrides it on
  this device: kept in localStorage (`chat.theme`), not the account, and set as `<html data-theme>` by an inline script
  in `index.html` before the first paint (allowed by its CSP hash, §5.6), so a reload never flashes the other theme.
- Text size (2026-11-22): the profile page's Text size switch (Small, Medium, Large) is this device's too, kept as
  `chat.size` and set as `<html data-size>` by the same inline script. Small is the original look; Medium and Large set
  the root font size to 125% and 150%. The stylesheets size everything in rem (16 px = 1 rem: text, spacing, avatars,
  icons, bars, radii), so the whole interface scales, not just the text; only hairlines of 0–2 px (borders, focus
  rings) and the media queries' breakpoints stay in px. New CSS follows that rule. The app scales by the same factors
  (ANDROID.md).
- Mobile-first layout using flexbox and grid. The sidebar collapses below 720 px.
- Accessibility basics:
  - Semantic HTML (`<main>`, `<nav>`, `<form>`, `<ol>` for messages).
  - The message list has `aria-live="polite"`.
  - Visible focus rings and full keyboard operability.
  - Color contrast of at least 4.5:1.

## 7.9 Loading line (2026-11-09)

When the app is slow there is something to see: a thin (2 px) line in the accent, a short gradient moving left to
right, over the top of the room list (under the site's name; on a narrow screen under the app bar) and over the top
of the room (under its header). It takes no room in the layout (`.loadbar`, a 0-height element whose `::before` is
the line) and is hidden from screen readers (`aria-hidden`; the lists keep their `aria-busy`). With reduced motion
it stands still as a faint line across the width.

- It shows once a fetch has been out for `LOADBAR_MS` (400 ms), so a quick one shows nothing, and goes as soon as
  nothing is out (`web/src/ui/loadbar.ts`). The delay is in JS: reduced motion turns off CSS transitions.
- Room list: `AppState.listLoads` counts the requests out now, the room list and hidden rows (`sync.ts`) and the
  unread counts (`unread.ts`). A logout's reset of the store keeps it, so loads still out count back down to 0.
- Room: the controller's `onBusy` says when the first of its reads goes out and when the last is back: the first
  load (and Retry), history at either end, a jump, going to a message, catching up once live, and the refetch and gap
  fill after a reconnect. A room opened from the prefetched page (PERF.md §5) shows none. Writes have their own signs
  (pending messages, the upload bar).
- Android: the same line (ANDROID.md §58).
