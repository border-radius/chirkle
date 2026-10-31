# Chirkle — Android App Design Document

| | |
|---|---|
| **Status** | **Active (frozen 2026-10-21, unfrozen 2026-10-23, §18): web features and fixes are ported, see [`CLAUDE.md`](../CLAUDE.md).** Built (2026-10-18): what changed in implementation is §16. Several servers and accounts: §17 (2026-10-19) |
| **Date** | 2026-10-18 |
| **Scope** | A native Android client with the web app's features (§1–§14); the server additions it needs: push notifications §8, App Links §9.4, minimum app version §12.4 |

Code and tests cite this document by section number, prefixed `A` to tell it from [`DESIGN.md`](DESIGN.md) (e.g.
`A§6.3`); `§n` alone means DESIGN.md. **Don't renumber sections:** append new ones, and mark obsolete ones as such
instead of deleting them.

---

## 1. Summary

The Android app is a native client for any server running the chat (several at once, §17), written in **Kotlin** with
**Jetpack Compose**. It does everything the web app does, with the same rules and limits, and adds notifications of
DMs and replies (which a phone chat app can't do without), found by a periodic background check, without Google
services (§21).

It is built to be **lightweight and fast**: a download under 6 MB, a first frame in under 500 ms, a room that was open
before shown in under 100 ms. Every screen reads a local SQLite database first; the network only writes to it.

An earlier Expo (React Native) app was removed on 2026-10-18. This one replaces it: native code is how we meet the size
and speed goals.

## 2. Goals and non-goals

### Goals

1. **Parity with the web app.** Every feature in the README works the same way (§3 lists them all). Access control stays
   in PocketBase API rules; the app enforces the same limits as `web/src/lib/limits.ts` before the server does.
2. **Lightweight.** ≤ 6 MB download. No heavy DI framework, no RxJava, no Retrofit, no WebView for any screen, no
   Firebase or Google Play services (§21).
3. **Fast.** The budgets of §11, measured in CI and failing the build when missed, like the web's bundle budget (§7.7).
4. **Offline-tolerant.** The room list and each room's latest messages come from the local database, then the network
   fills in. Sends queue and retry safely (§17.4's client IDs).
5. **Small server footprint.** Three additions only: push (§8), the App Links file (§9.4) and a minimum app version
   (§12.4). No route the web app doesn't use is added for the app's convenience.
6. **Tested** against a real, throwaway PocketBase, like the web app (§13).

### Non-goals (v1)

These are left out on purpose. The design should not block them later.

- A tablet two-pane layout beyond what adaptive Compose gives (v1.1)
- Wear OS, Android Auto, home screen widgets
- Features the web app lacks: typing indicators, presence, voice messages, calls, mentions, per-room mute
- iOS (Kotlin Multiplatform could share `:core:data` later; nothing here should depend on Android in that module
  beyond Room and WorkManager)

## 3. Feature parity

Each web feature, the Android screen or mechanism for it, and the API it uses. Only deep links need server work.

| Web feature (DESIGN.md) | Android | API |
|---|---|---|
| Sign up, log in, invite code, session restore (§22, §24.2) | Login / Sign up screen; token in DataStore, encrypted (§10); `authRefresh` after launch, off the critical path | `users` auth, `site.invite_only` |
| Branding: title and logo (§24) | Site record cached; shown in the top bar and on the login screen | `site` |
| Room list: create, hide, archive, unread counts (§5, §18) | Rooms screen; live; hide from the row's menu; badges | `rooms`, `hidden_rooms`, `GET /api/chat/unread` |
| Room access: Private / Public / Open Air, members, who can post (§23, §23.6) | Room access sheet: three radio cards, add/remove people, the same warnings; read-only Members for others | `rooms.update` (visibility, members, writers) |
| Guests read Open Air rooms (§23.3) | Signed-out home lists Open Air rooms; read-only room; "Log in to post" bar | public rules on `rooms`, `messages` |
| Live messages, edits, soft deletes (§7.5, §7.6.1–2) | Realtime into the DB; the UI observes the DB | `/api/realtime`, `messages` |
| Full history, keyset paging (§6, §7.5) | Paging 3, both directions, `(created, id)` cursors | `messages.getList` |
| Open at the first unread, "New" line, Jump to latest (§18.5, §22.7) | Initial window around the first unread; divider item that fades; button when scrolled up | `GET /api/chat/unread/{room}`, `POST /api/chat/reads` |
| Direct messages, close and reopen (§16) | "New message" user search; DM rows in the list | `POST /api/chat/dms`, `GET /api/chat/users` |
| Avatars, profile, unique name, password, log out (§15, §22.1–2) | Profile screen; photo picker, crop and resize on the device to §15.3's sizes | `users.update`, `POST /api/chat/password` |
| Search in a room or DM (§29) | Search bar in the room's top bar, 50 results a page; picking one opens the history around it | `messages` with `text_key` filters |
| Replies, jump to the original (§19) | Swipe right or menu → Reply; tap the quote to load around the original | `reply_to`, `expand` |
| Clickable links (§7.6.3) | Same rules as `lib/links.ts` (http, https, www. only); open in Custom Tabs | client only |
| Link previews (§28) | Favicon (`data:` URL) and title under the message | `messages.previews` |
| Emoji picker and reactions (§20) | `emoji2-emojipicker` in the composer; reaction chips; quick reactions in the long-press menu | `POST /api/chat/reactions` |
| Attachments: 10 files of 20 MB, progress, thumbnails, "+N", audio (§17) | System photo picker and document picker; upload with progress (§8.3); 4-tile grid; inline audio player | `messages.create` multipart, file tokens |
| Image and video viewer, swipe (§17.7) | Full-screen pager, pinch zoom; Media3 for video, in a module loaded on first use | protected files |
| Select up to 50, forward, delete together (§21) | Selection mode from long-press; forward target picker | `POST /api/chat/forward`, `POST /api/chat/delete` |
| Unread counts in sync across devices (§18.3) | `room_reads` events; launcher badge from the total (instead of the favicon, §22.4) | `room_reads`, `/api/chat/unread` |
| Drafts kept per room (§22.3) | Saved to the DB as you type, restored on open | client only |
| Fast room switching, prefetch (§7.5, room cache) | The DB is the cache; unread rooms prefetched (§6.3) | as above |
| Telegram bridge (§26) | Nothing extra: stand-in users and service messages render as on the web | server only |
| Light and dark themes (§7.8) | Material 3 with the web's colours, following the system; dynamic colour off | client only |
| Paths `/r/:id`, `/r/:id/m/:msgId` (§7.1) | Android App Links on the server's domain (§9.4) | `assetlinks.json` |
| Installable PWA (§27) | Not needed: the app is the installed app | — |

**Beyond the web:** push notifications (§8). DESIGN.md §2 lists them as a non-goal for the web app; on a phone they are
what makes a chat app usable. Hidden rooms stay silent, as §13 decided.

## 4. Architecture

```
┌──────────────────────────── Android app ─────────────────────────────┐
│                                                                      │
│  Compose UI (Navigation 3)                                           │
│  login / rooms / room / search / viewer / profile / room access      │
│        │  observes UiState (StateFlow)                               │
│        ▼                                                             │
│  ViewModels  ◄──── Flow ────────────────────┐                        │
│        │                                    │                        │
│        ▼                                    │                        │
│  Repositories (rooms, messages, unread, account, search, site)       │
│        │                  │                 │                        │
│        ▼                  ▼                 │                        │
│  PbClient            WorkManager ──► Room DB (rooms, messages,       │
│  (OkHttp REST + SSE)  (sends, uploads,       reactions, drafts,      │
│        │               notify checks)        send queue)             │
└────────┼─────────────────────▲───────────────────────────────────────┘
         │ REST (JSON)  SSE    │ every ~15 min: DMs and replies (§21)
┌────────▼─────────────────────┴──┐
│  PocketBase (unchanged API)     │
└─────────────────────────────────┘
```

**One rule:** the UI reads only the local database. Network pages, realtime events and pushes all write into Room, and
its Flow queries carry the change to the screen. It is the web's room cache (§7.5) made the default for every screen:
nothing waits for the network to show what is already known.

**Why native Kotlin + Compose:** the smallest download and fastest start Android allows, and the platform's own APIs
for what a chat app needs (notifications with inline reply, the photo picker, background uploads). Rejected:

- **A WebView around the PWA:** not native, slow to start, weak notifications.
- **React Native / Expo, Flutter:** a bigger download and start cost (and we just removed an Expo app).
- **Kotlin Multiplatform shared with the web:** the web app is vanilla TypeScript; there is nothing to share.

## 5. Tech stack

| Concern | Choice | Why |
|---|---|---|
| Language | Kotlin 2.2 (K2), coroutines and Flow | Structured concurrency fits realtime and paging |
| UI | Jetpack Compose (BOM), Material 3, adaptive layouts | Declarative, no XML; one theme for light and dark |
| Navigation | Navigation 3 | The back stack is state we own; simple deep links |
| HTTP | OkHttp 5 + kotlinx.serialization | Small and fast; about 20 calls don't need Retrofit |
| Realtime | `okhttp-sse` | PocketBase realtime is Server-Sent Events, the protocol `pb.ts` speaks |
| Database | Room (SQLite, KSP) | Rooms, messages, drafts and the send queue; Flow queries drive the UI |
| Paging | Paging 3 with a `RemoteMediator` | Keyset pages both ways, the DB as the single source |
| Images | Coil 3 on the same OkHttp | Compose-first, memory and disk caches, small |
| Video and audio | Media3 ExoPlayer, its own module (§4.1) | Kept out of cold start, like the web's lazy viewer chunk |
| Background work | WorkManager | Sends and uploads survive process death; progress notifications |
| Settings and token | DataStore + an Android Keystore key (AES-GCM) | Not the deprecated `security-crypto` |
| DI | A hand-written `AppGraph`, constructor injection | No Hilt/Dagger start-up or size cost for ~15 singletons |
| Emoji | `emoji2`, `emoji2-emojipicker` | Current emoji on old Android, the system's picker UI |
| Notifications | A periodic WorkManager check (§21); no FCM | Works on every phone and every server, de-Googled ones included, with no push credentials |
| Build | Gradle version catalog, AGP 8, R8 full mode, Baseline Profiles | Small download, fast start |
| Lint | ktlint, detekt, Android lint, Compose lint | What Biome is on the web side |

**SDK levels:** minSdk 26 (Android 8.0, ~97% of active devices), targetSdk and compileSdk 36. Exact library versions
are pinned in `android/gradle/libs.versions.toml` when implementation starts, as `scripts/fetch-pocketbase.sh` pins
PocketBase.

### 5.1 Modules

```
android/
  app/              Activity, AppGraph, navigation, theme, push service, deep links
  core/data/        PbClient, Room DB, repositories, sync engine (§6), send queue
  core/ui/          colours and type, avatar, message row, linkified text, emoji
  feature/auth/     login, sign up, guest home
  feature/rooms/    room list, new room, new DM
  feature/room/     messages, composer, search, selection, room access
  feature/profile/  profile, password
  feature/viewer/   image and video viewer, Media3 (loaded on first use)
```

Few modules, for build speed. A feature module never imports another; they meet in `:app`'s navigation.

## 6. Data layer

### 6.1 `PbClient`

A port of `web/src/pb.ts` (§6): JSON or multipart requests with the auth header; a `filter()` that binds parameters as
`pb.filter()` does (never string concatenation, which prevents filter injection); the realtime protocol (one SSE
stream, the `PB_CONNECT` client id, subscriptions POSTed to `/api/realtime` and resent after reconnects with the same
backoff). It asks for the web's `MSG_FIELDS`, so it never pulls anyone's email.

**Text folding** for search (§29.1) and display names (§22.1) is a port of `foldKey` / `nameKey`: no invisible
characters, NFKC (`java.text.Normalizer`), upper then lower case, the dotted İ dropped. The web's unit cases for them
are ported as fixtures, so the two can't drift apart.

### 6.2 Database

| Table | Holds | Kept |
|---|---|---|
| `rooms` | id, name, visibility, archived, created_by, members, writers, hidden, unread, last activity | all the user can see |
| `messages` | `MSG_FIELDS` + reply, forward, files, reactions, previews; `state` (sent / pending / failed) | the latest 200 per room, for the last 30 rooms opened |
| `users` | id, name, avatar | those referenced by kept messages |
| `drafts` | room → text, reply target | until sent or cleared |
| `outbox` | client message id, room, text, files (content URIs), attempts | until the server has it |
| `site` | title, logo, invite-only flag, `min_android_version` | one row |

Messages are keyed by server id; an optimistic send uses the client-made id it will keep on the server (§17.4), so the
row never changes key and the list never jumps. A trim job drops what falls outside "Kept" after each room close.

### 6.3 Sync

1. **Launch:** show the kept room list; fetch rooms, hidden rooms and `/api/chat/unread` in parallel; prefetch the
   latest page of rooms with unread messages, as `prefetch.ts` does. To stay out of the prefetch herd (QA BUG-108;
   the web now fetches such a room at most every 30 s), a message in a room that isn't open only bumps its count; its page is fetched at launch, on a
   push, or when the room opens, never once per message.
2. **Open a room:** show the kept window at once, positioned by §18.5's rule; fetch the first unread anchor and the
   latest page in one round trip; subscribe the room's messages.
3. **Scroll:** the `RemoteMediator` fetches older or newer pages by `(created, id)` cursor with `skipTotal`.
4. **Reconnect:** after `PB_CONNECT`, resubscribe and fetch a newer page from each open room's newest kept message to
   fill the gap (`sync.ts`).
5. **Read:** `POST /api/chat/reads` up to the newest message on screen (§18.3, as far as the list shows: §25),
   debounced to 1 s. `room_reads`
   events from other devices update the counts.

**Lessons from the web, applied from the start:** one request to open a room (room cache latency, 2026-10-15), no
per-record server work on list fetches (the hooks pool, 2026-10-14), filters that use the indexes (the reply cross join,
2026-10-16).

## 7. Screens

Compose screens, one `ViewModel` and one immutable `UiState` each. Routes mirror the web's paths (§7.1), so a deep link
is a route.

| Route | Screen | Notes |
|---|---|---|
| `Login`, `SignUp` | Email and password; invite code when the site asks for one | branding from the site record |
| `Home` (guest) | Open Air rooms | log in or sign up to join in |
| `Rooms` | Rooms and DMs, unread badges, archived section | new room (with "Who can see it"), new DM |
| `Room(id, msgId?)` | Messages, composer, search, selection | `msgId` opens around a message (§6 "One message") |
| `RoomAccess(id)` | Visibility, members, who can post | creator edits; others read |
| `Viewer(roomId, msgId, file)` | Images and videos of the room, swipe between them | `:feature:viewer` |
| `Profile` | Avatar, name, password, log out | |

### 7.1 Message list (hot path)

- A `LazyColumn` with `reverseLayout = true`, so new messages land at the bottom without scroll math; item keys are
  message ids, `contentType` per kind (text, media, service, deleted, "New" line, day header).
- Rows take `@Immutable` models built off the main thread; time strings come from formatters created once (the web's
  `Intl.DateTimeFormat` rule, §7.7).
- Grouping (same author within 5 minutes, no avatar repeat) and day headers are computed in the repository, not in
  composition.
- About 300 messages in memory at once, like the web's DOM window (§7.5).
- Pinning: when you are at the bottom, new messages keep you there; scrolled up, they don't move you and the Jump to
  latest button counts them (§22.7; the scroll pinning fixes of QA pass 15 apply). A message you send is followed once
  the outbox has read it back from the database and the list has composed its row: scrolled before that, the lazy list
  keeps the old bottom row in place and the new message lands under the composer.

### 7.2 Composer

Multi-line field with the 2,000-character limit counted in code points (`textLength`); emoji, attach, send. One rounded
field holds emoji at its start and attach at its end, both kept at the bottom as the text grows to six lines, then the
send circle: the text gets the width. Enter makes
a new line; a hardware keyboard sends with Enter and Ctrl+Up/Down pick the reply as on the web. Replying and editing
show a bar above the field. A room you may only read shows why instead of the composer (archived, Open Air guest, not a
writer: §23.6).

### 7.3 Images and files

Thumbnails use the server's thumb sizes (§17.5), never full images in the list. File URLs carry a short-lived file
token (§17.3) fetched and shared like `lib/token.ts` (renewed after 2 minutes). Coil's cache key is the URL **without**
the token, so a room switch or a new token never downloads a thumbnail again, as the service worker does on the web
(§27.2). Full files (viewer, downloads, video) go to the server with a fresh token.

## 8. Push notifications (server addition)

The web app has none (§2); the app needs them. The server work is a collection, a hook and a worker, built like link
previews (§28.1).

### 8.1 Data model

| Collection | Field | Type |
|---|---|---|
| `push_tokens` | `user` | relation → users, required, cascade delete |
| | `token` | text, required, unique |
| | `provider` | select `fcm` / `unifiedpush` |
| | `updated` | autodate |
| `push_queue` | `message` | relation → messages, cascade delete |

Rules on `push_tokens`: create, delete and view by the owner (`user = @request.auth.id`); no list. The app registers
its token after the first frame of a session and deletes it on log out. FCM `UNREGISTERED` answers delete the row.

### 8.2 Hook and worker

- `onRecordAfterCreateSuccess` on `messages` adds a `push_queue` row in the save's transaction (not for service
  messages, not for Telegram stand-ins' own devices, since they have none).
- A cron job sends the queue, one run at a time (a lock in the app store, as `previews.js` does): for each message,
  every user who can see the room (`canSee()` in `pb_hooks/lib/access.js`), but not its author, not those who hid the
  room, and not those whose `room_reads` is already past it.
- The payload carries **ids only** (room, message). The app fetches the message with its own session, so message text
  never passes through Google. DMs go at high priority, rooms at normal priority.
- Settings: `FCM_SERVICE_ACCOUNT` (JSON) turns FCM on; without it nothing is queued. UnifiedPush tokens are endpoint
  URLs, POSTed to directly, with the same address checks as link previews (§28.1), and with their fetcher (curl, the
  checked address pinned): a redirect isn't followed (QA BUG-141), so an endpoint must answer where it is registered.

**Superseded on 2026-10-24 (§21):** the app no longer uses FCM or any push service; it checks for news itself.
**Removed on 2026-10-28** (docs/REFACTOR.md round 4): `push_tokens`, `push_queue`, `pb_hooks/lib/push.js` and
`lib/google.js` are gone (migration `1760000038_drop_push.js`). This section describes what was built.

### 8.3 On the device

- ~~A `FirebaseMessagingService` (or UnifiedPush receiver) enqueues an expedited job~~ A periodic WorkManager job
  (§21) asks each account's server for new DMs and replies to you, then notifies.
- `MessagingStyle` notifications, one channel per kind (Direct messages, Replies), grouped per room, with **Reply**
  (`RemoteInput`, sent through the outbox) and **Mark as read**.
- Opening a room, or reading it on another device (a `room_reads` event while the app runs, or the next check), clears
  its notification. The launcher badge is the unread total.

## 9. Platform integration

### 9.1 Realtime in the foreground only

One SSE connection while the app is visible, tied to `ProcessLifecycleOwner`; it closes 5 s after the app goes to the
background. No connection, no wake locks, no foreground service in the background: a periodic check covers it (§21).

### 9.2 Sending and uploads

A send writes the message as pending, with its client id, and enqueues a WorkManager job that posts it. A retry reuses
the id, so the server never makes a duplicate (§17.4). Messages with files upload in an expedited job with a progress
notification; the row shows the progress bar. A failed send shows "Couldn't send · Retry".

### 9.3 Sharing into the app

A share target (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`) for text and files opens a room picker, then the composer with
them attached: the Android form of dropping files on the web composer. Only other apps' `content://` files are taken:
a `file://` URI or one of the app's own providers would be read with the app's rights, so another app could have its
database sent to a room (QA BUG-175).

### 9.4 App Links (server addition)

`/.well-known/assetlinks.json`, served by a hook from `ANDROID_APP_ID` (`com.chirkle.android` when unset) and `ANDROID_CERT_SHA256` (unset → 404).
The app declares the server's host for `/r/*`, so a link to a room or a message opens in the app.

## 10. Security considerations

- The auth token is encrypted with a Keystore key and never logged. Backups (`dataExtractionRules`) leave out the
  database and the token.
- HTTPS only (network security config); cleartext is allowed for `127.0.0.1` and `10.0.2.2` in debug builds only.
- Message text is shown as text. Links follow the web's allow-list (§7.6.3) and open in Custom Tabs, never in the app.
- File tokens as in §7.3; a URL with a token is never written to the disk cache key.
- Log out clears the database, Coil's caches, pending work, notifications and the check's state, as the web clears
  IndexedDB and the service worker's cache. So does a session found expired at start (the app not opened before it
  ran out): it is forgotten and its data cleared before anything shows, its rooms and DMs included (QA BUG-145, as
  the web's `forgetExpired`).
- Access control stays on the server: the app hides what you can't do, but never relies on it.
- An opt-in setting sets `FLAG_SECURE` on screens with messages.

## 11. Performance budget (enforced in CI)

The reference device is a Pixel 6a-class phone on Android 14.

| Metric | Budget | Measured by |
|---|---|---|
| Download size, per ABI | **≤ 6 MB** | `bundletool get-size total` |
| Cold start to first frame | **≤ 500 ms** | Macrobenchmark `StartupTimingMetric`, median of 10 |
| Cold start to the kept room list | ≤ 700 ms | `reportFullyDrawn()` |
| Opening a kept room | **≤ 100 ms** to the first message | Macrobenchmark trace section |
| Opening a room not kept | 1 round trip | integration test counting requests |
| Scrolling 300 messages with images | < 1% slow frames | `FrameTimingMetric` |
| Memory (PSS) in a busy room | ≤ 150 MB | `dumpsys meminfo` |
| Network when idle | 1 SSE connection | integration test |

How:

- Baseline and startup profiles for log in, the room list, opening a room and scrolling.
- R8 full mode and resource shrinking; serialization generated at compile time, no reflection.
- Nothing at start but the first screen: `AppGraph` builds singletons on first use, no `ContentProvider` initialisers,
  the notification check scheduled after sign-in.
- Media3 and the viewer in their own module, loaded on first use.
- A new dependency needs its size in the PR description, as a new web dependency does (§8.1).

## 12. Build, release and versions

### 12.1 Repository

The app lives in `android/` in this repo, so a schema change and its client change land in one commit.
`docs/schema.snapshot.json` is the contract: CI runs the app's API tests whenever it changes.

### 12.2 Scripts

| Command | What it does |
|---|---|
| `./gradlew assembleDebug` | Debug build pointed at `http://10.0.2.2:8090` (the dev server from the emulator) |
| `./gradlew check` | ktlint, detekt, lint, unit and Robolectric tests |
| `./gradlew pixel6Api34DebugAndroidTest` | E2E on a Gradle Managed Device against a real PocketBase |
| `./gradlew :benchmark:connectedCheck` | Macrobenchmarks and the budgets of §11 |
| `./gradlew bundleRelease` | Signed AAB, fails over the size budget |

### 12.3 Release

AAB to Google Play (internal, closed, then production with a staged rollout) and a signed APK on GitHub Releases
(the same build: it needs no Google services, §21). F-Droid builds it from source (§28).

### 12.4 Minimum app version (server addition)

`site.min_android_version` (number, default 0), readable like the rest of the site record (§24.1). An older app shows
"Update required" with a link to the store instead of a screen that could break on a changed schema.

## 13. Testing strategy

As on the web (§9): every run starts its own PocketBase on a free port with a temp data dir; no fakes except a stub FCM
endpoint.

| Layer | Tools | Covers |
|---|---|---|
| Unit | JUnit 5, Turbine, kotlinx-coroutines-test | linkify, cursors, unread math, reaction merge, folding, drafts, outbox (cases ported from `tests/unit`) |
| Data integration | JVM tests, real PocketBase started by Gradle from `bin/pocketbase` | PbClient, SSE reconnect and gap-fill, paging both ways, the access rules as the app sees them |
| UI | Compose UI tests on Robolectric | each screen's states: empty, loading, error, guest, archived, read-only |
| End-to-end | Compose tests on a Gradle Managed Device, real PocketBase | the parity scenarios of `tests/e2e`: send, edit, reply, react, forward, attach, search, room access, guests |
| Screenshots | Roborazzi | every screen in light, dark and at 200% font size |
| Performance | Macrobenchmark, Baseline Profile generator | §11 |
| Accessibility | Compose accessibility checks, a TalkBack pass per release | labels, 48 dp touch targets, contrast |
| Server | `tests/integration/push.test.ts` | §8: who gets a push, hidden and read rooms skipped, ids only, tokens owner-only |

**Parity guard:** `android/PARITY.md` maps each web e2e spec to its Android test. A web feature without an Android
entry fails review.

**CI:** an `android` job in `.github/workflows/ci.yml`, beside the web jobs: `./gradlew check`, the managed-device run
and the size check. Macrobenchmarks run nightly on Firebase Test Lab.

## 14. Milestones

Estimates for one Android developer: about 13 weeks to a closed beta with full parity.

| # | Deliverable | Weeks | Done when |
|---|---|---|---|
| A1 | Foundation: `android/`, PbClient and SSE, auth, site record, Room DB, `AppGraph`, CI with the size check | 2 | log in and out against the dev server; CI green |
| A2 | Core chat: room list, unread counts, send/edit/delete, paging both ways, realtime, drafts, prefetch | 4 | **internal alpha:** the team uses it every day |
| A3 | Rich messages: replies, reactions, attachments, viewer, link previews, search | 3 | their parity e2e tests green |
| A4 | Rooms and people: DMs, room access, guests and Open Air, selecting and forwarding, profile and avatar | 2 | their parity e2e tests green |
| A5 | Push and polish: §8 server and app, App Links, share target, budgets, accessibility, screenshots | 2 | **closed beta:** `PARITY.md` at 100%, §11 green |

## 15. Decisions and open questions

### Decided (2026-10-18)

| Topic | Decision |
|---|---|
| Native or cross-platform | Native Kotlin and Compose (§4). |
| Source of truth on the device | The local database; the UI never renders a network response directly (§4). |
| Push content | No push: the app fetches what is new itself, with its own session (§21). |
| Background connection | None; realtime only in the foreground, a check about every 15 minutes otherwise (§9.1, §21). |
| Hidden rooms | Silent on Android too: no badge, no notification (§13 of DESIGN.md). |
| Where the code lives | This repo, `android/` (§12.1). |

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Web features keep landing during the build | parity moves | `PARITY.md` in review; the app's API tests run on every schema snapshot change |
| Mobile networks and Doze drop SSE | missed live updates | gap-fill on every reconnect (§6.3); the periodic check in the background |
| The check is late (15 min at best; Doze and app standby stretch it) | slow notifications | accepted for no Google (§21); open question 8 |
| Hand-written DI grows messy | slower changes | `AppGraph` stays one file; revisit Metro or kotlin-inject past 30 bindings |
| The download creeps past 6 MB | misses the goal | the CI size gate; a size note for every new dependency |

### Still open

1. **Accounts:** who owns the Play Console account? (No Firebase project any more, §21.)
2. ~~**UnifiedPush:** at launch or after the beta?~~ No push at all for now (§21; open question 8).
3. **Package name and default server** (for example `com.<org>.chat`; the default server is also the App Links host, §17.3).
   The package is `com.chirkle.android` since the rename (§27); the default server is still open.
4. **Web Push:** should the web app get notifications too, from the same `push_queue`?
5. **Per-room mute:** the web has hide only. Add mute to both clients, or keep hide as the one control?

## 16. Implementation (2026-10-18)

The app is in `android/`, built to this document. This section records what implementation changed, and why; the
sections above are otherwise as designed.

### 16.1 Versions

Pinned in `android/gradle/libs.versions.toml`. Current AndroidX (Compose BOM 2026.09, OkHttp 5.5) requires AGP 9.1+
and compileSdk 37, so §5's "Kotlin 2.2, AGP 8" became:

| | |
|---|---|
| Build | Gradle 9.8.1, AGP 9.4.1 (Kotlin built in: the `kotlin-android` plugin is only on the classpath, for its version), JDK 17 bytecode, built with JDK 21 |
| Kotlin | 2.4.21; KSP 2.3.12 (Room) |
| SDK | minSdk 26, targetSdk 36, compileSdk 37 |
| Modules | as §5.1, plus `:core:testing` (the throwaway PocketBase and test users, for every module's JVM tests) |

### 16.2 Changes to the design

| Design said | Built | Why |
|---|---|---|
| Paging 3 with a `RemoteMediator`; the UI reads only the database (§4, §6.3, §7.1) | `RoomController` (`core/data/.../repo/RoomController.kt`), a port of the web's `controller.ts`: a window of up to 300 messages in memory; the database keeps each room's latest page (the web's room cache, §7.5) and the screen shows it at once | A window opened around a message far back (a reply's quote, a search result) leaves gaps in what is stored, which a `RemoteMediator` over one table can't represent. The web's controller already handles every case (stale windows, the first unread message, gap fill, QA BUG-61, BUG-96, BUG-100, BUG-102), and porting it keeps the two clients alike. The room list, unread counts, drafts, the outbox and the site still come from the database at launch |
| Tables per record kind (§6.2) | `rooms`, `kept` (a room's latest page), `outbox`, `drafts`, `kv`; records stored as the JSON the server sent | One decoder for network and disk; nothing to migrate when the server adds a field |
| DataStore + Keystore for the token (§5, §10) | The session in a file (`noBackupFilesDir/session.bin`), AES-GCM with an Android Keystore key | DataStore brought a native library and 250 KB for one value |
| `emoji2-emojipicker` (§3, §5) | The web's own picker list (`lib/Emoji.kt`, checked against `pb_hooks/lib/emoji.js`) | The server accepts exactly those emoji as reactions (§20.1): the system picker would offer emoji it refuses |
| JUnit 5 (§13) | JUnit 4 | Robolectric runs on JUnit 4 only |
| Push payload, server worker (§8.2) | As designed; FCM's OAuth token is signed in the hooks (`pb_hooks/lib/google.js`, RS256 with BigInt, about 12 ms an hour) | The JSVM has no RSA, and a sidecar would break goal 5 |
| A WorkManager job for every send (§9.2) | Sends are posted in-process at once, and a WorkManager job (unique, appended) drains the outbox after a process death or offline | The same guarantees without a job's start-up delay on every message. Offline, a message waits (pending); only a server refusal shows "Not sent · Retry" |
| Upload progress notification (§8.3, §9.2) | The row's progress bar; a notification only when Android runs the job as a foreground service (before Android 12) | |
| ktlint, detekt, Compose lint (§5) | Android lint (`./gradlew check`) | Not added yet: see §16.4 |

### 16.3 Server additions

As §8.1, §9.4 and §12.4 describe: migration `1760000026_push.js`, `pb_hooks/lib/push.js`, `pb_hooks/lib/google.js`,
tested by `tests/integration/push.test.ts` against a stub FCM that checks the token's signature with the service
account's public key. The push parts were removed on 2026-10-28 (§8 note): what is left is App Links (`lib/site.js`)
and the minimum version, tested by `tests/integration/android.test.ts`. The FCM, UnifiedPush and `PUSH_*` settings
below no longer exist.

| Setting | Effect |
|---|---|
| `FCM_SERVICE_ACCOUNT` | A Firebase service account's JSON: FCM pushes on |
| `UNIFIEDPUSH=on` | UnifiedPush endpoints (public https addresses only, as link previews, §28.1) |
| `FCM_ENDPOINT`, `PUSH_ALLOW_HOSTS`, `PUSH_CRON=off` | Tests: a stub FCM, stub endpoints on 127.0.0.1, pushes only on `POST /api/push/tick` |
| `ANDROID_APP_ID`, `ANDROID_CERT_SHA256` | `/.well-known/assetlinks.json` (fingerprints comma-separated; the app id is `com.chirkle.android` when unset); 404 without fingerprints |
| `site.min_android_version` | Set by an admin: older apps show "Update required" |

~~The app reads Firebase's settings from Gradle properties (`chat.fcm.*`).~~ Firebase was removed on 2026-10-24
(§21). `chirkle.server` and `chirkle.appId` set the release build's server and package
(open question 3).

### 16.4 Status against the milestones

| | |
|---|---|
| Done | A1–A4 in code: every screen of §7, the parity features of §3, guests, deep links, the share target, push (server and app), FLAG_SECURE, the size gate. Release APK 3.1 MB (universal) |
| Tested | 58 JVM tests in `:core:data` (the web's unit cases for links, folding, search, reactions, files, avatars and emoji; the API, realtime and reconnects, the services and the room controller against PocketBase); 22 in `:app`, 19 of them the screens on Robolectric against PocketBase (log in, sign up, send, reply, edit, delete, react, search, forward, DMs, hide, archive, room access, profile, guests, and §17's accounts: adding one on another server, switching, a bad address, logging out to another account); 12 push integration tests on the server. `android/PARITY.md` maps the web's e2e specs to them. Robolectric's main looper is paused: the UI tests move its clock on as they wait (`UiHarness.pump`), or no delay in the app would ever end |
| Not yet | Managed-device E2E (§12.2: it needs a device or emulator, which the development machine lacked); Macrobenchmarks and Baseline Profiles came later (§33); Roborazzi screenshots; ktlint and detekt; UnifiedPush on the device (the server side is done); a TalkBack pass. §11's budgets other than size are therefore unmeasured |

## 17. Servers and accounts (2026-10-19)

The app was designed for one server, fixed at build time (§1, §12.2). It now works with **any server running the
chat**, and with **several accounts at once**, on one server or many. This section replaces what §1, §6.2, §8.3, §9.4,
§10 and §12.2 say about "the server"; those sections otherwise stand.

### 17.1 Accounts

An **account** is a server address and, once someone logs in or signs up there, a user. Each account has its own:

| | Where |
|---|---|
| Session (token and auth record) | `accounts/<id>.bin` in no-backup storage, encrypted like the one session was (§10) |
| Database (§6.2): rooms, kept pages, outbox, drafts, kv | `account-<id>.db` |
| Outbox files | `files/outbox/<id>/` |
| Notification check (§21) | its state (last check, ids seen) in its own kv |

The list of accounts and which is active are in `accounts.bin` (no-backup, encrypted: it says which servers you use).
Device settings (screenshots, §10) are the device's, in that file too, not an account's.

- **One account is active.** Its services run as before (§6.3, §9.1: realtime in the foreground, sync, prefetch).
  The others are idle: no connection. The periodic check (§21) is how they get news; switching to one starts it.
- **An account without a user** is a guest on that server (Open Air rooms, §23.3, and the Log in screen). There is at
  most one, the active one: switching away from it removes it.
- **The same user on the same server twice** is one account: logging in again replaces the older entry.
- **Logging out** ends that account's session and clears its data (§10), and leaves you on that server's Log in
  screen, which lists your other accounts to switch to.

### 17.2 Choosing a server

- **First launch:** the build's default server (`chirkle.server`, §12.2) when it has one, on the Log in screen; without
  one, the app asks for a server first.
- **Log in and Sign up** show the server they act on, with **Change server**.
- **Accounts** (the brand at the top of the room list; it was in the profile until 2026-10-23) lists your accounts
  (name, server), switches between them, and has **Add account**: choose a server, then log in or sign up there. Backing out of it returns to the account you were on.
- The rooms screen shows the active account's server under its title when you have more than one account.

An address is checked before it is used:

1. `chat.example.org` means `https://chat.example.org`; a pasted room link (`…/r/…`) or admin link (`…/_/`) means its
   server. Query and fragment go.
2. Release builds take **https only**; debug builds take http too (any host: a dev server on the LAN).
3. `GET /api/health` must answer, then the site record (§24.1) must be readable: a server that isn't running the chat
   says so ("That address isn't a chat server.") instead of failing later.

### 17.3 Links

- **App Links** (§9.4) can only be verified for hosts listed in the app's manifest at build time: the default
  server's. Links on other servers open in the browser, as they did before the app was installed.
- A link the app gets (App Link, share, notification) opens in the account on that server (host and path prefix),
  the active one first, switching to it when needed. A link to the default server with no account there opens it as a
  guest.

### 17.4 Push across servers

**Superseded on 2026-10-24 (§21):** no pushes; the check asks every signed-in account's server in turn. Notifications
stay per account and room, as below.

- Each account registers the device's token with its own server. **The payload adds `user`** (the recipient's id):
  the app finds the account by user id (ids are random 15-character strings: unique across servers in practice) and
  fetches the message with that account's session. A payload without `user` (an older server) goes to the active
  account.
- `push_tokens` is unique per **(token, user)**, not per token (migration `1760000027_push_tokens_per_user.js`): two
  accounts on one server share the device's token. Registering again as the same user replaces that user's row.
- Logging out of one account deletes its row; the device's FCM token is only deleted when no account is left.
- Notifications are per account and room, grouped per account; with more than one account they show which one
  (name · server). Reply and Mark as read act as that account.
- **FCM needs the app's Firebase credentials on the server** (`FCM_SERVICE_ACCOUNT`): only servers whoever publishes
  the app gives them to. Other servers can push through **UnifiedPush** (its server side is done, §16.3; the app side
  is not yet, §16.4), or not at all: the app still works, without notifications. A relay for FCM pushes is open
  question 6.

### 17.5 Security

- Each server sees only its own account's credentials and requests. A session is never sent to another server: every
  request is built from its own account's address.
- An account's data is cleared on its log out, as the one session's was (§10); other accounts are untouched.
  Notifications and pending work of one account are cancelled without touching the others'.
- File URLs and image cache keys include the server's address, so two servers' files never share a cache entry.
- Typing a server's address trusts it with what you send there, as a browser does; https is required in release.

### 17.6 Still open

6. ~~**Push for servers without the app's FCM credentials:**~~ (moot since §21: no FCM) ship UnifiedPush on the device, run a push relay that holds
   the credentials (servers would authenticate to it), or both?
7. **Sharing into another account:** shares go to the active account's rooms; should the picker offer every account?

### 17.7 Implementation (2026-10-19)

`core/data` `repo/Accounts.kt` (the accounts, their index and lifecycle), `lib/Servers.kt` (addresses and links);
`app` `AppAccounts.kt` (where they live on the device); `feature/auth` `ServerScreen.kt`; `feature/profile`
`AccountsScreen.kt`; `AppRoot` in `nav/ChirkleNav.kt` (a back stack per account). Tested by `AccountsTest` and `ServersTest`
(`:core:data`) and `UiAccountsTest` (`:app`); the tests use the test server by two addresses (127.0.0.1 and
localhost) as two servers. An idle account's session is renewed each time the app starts (one the server refuses is
removed, as a log out would). Nothing migrates the single session of the 2026-10-18 build: it never shipped.

## 18. Unfrozen: emulator, fixes and polish (2026-10-23)

The app was frozen from 2026-10-21 to 2026-10-23 (web work only). On unfreezing it, it was run on an emulator for the
first time, tested by hand on it, polished, and given the web features added while it was frozen.

### 18.1 The emulator on the development machine

The development container has no `/dev/kvm`, so the emulator runs in software (QEMU TCG, `-accel off`, with
`-qemu -accel tcg,thread=multi` for four guest CPUs). Android 14 and 11 images do not survive it: zygote exits, or
system services time out (ANRs) and system_server restarts in a loop. The Android 9 image (`android-28;default;x86_64`)
boots in about 15 minutes and stays up. Apps run slowly (a frame can take seconds), so after installing a debug build,
`adb shell cmd package compile -m speed -f <package>` compiles it ahead of time first. Input from `adb shell input`
is dropped when it comes faster than the app takes it: text is typed a few characters at a time. With KVM, any
current image works and none of this applies.

### 18.2 Bugs fixed

| Bug | Fix |
|---|---|
| The viewer: swiping to the next image didn't work (the zoom gesture took every drag) | One finger pans only when zoomed in; at an edge the drag goes to the pager; two fingers zoom about their centre; double tap zooms on the tapped point |
| The viewer: videos were stretched to the screen | Media3's `ContentFrame` fits them; play/pause follows the player; a seek bar with times |
| The viewer: dark status bar icons on black | Light icons; the system bars hide with the viewer's own bars |
| Search: picking a result left the results over the messages, hiding the one gone to | They make way; focusing the field shows them again |
| Search: a narrower query that found the same messages kept the old highlight ("gre" of "green") | The highlighted words are Compose state |
| A single image was letterboxed in a fixed 240 dp box | The tile takes the picture's shape (at most 320 × 240 dp), remembered so a row doesn't jump when it comes back |
| A single video was a dark square | Its poster (`/api/chat/posters`, §30.1), in the video's shape |
| Bottom sheets (message actions, emoji, forward): the last row under the navigation bar (Android ≤ 10) | `ChirkleSheet` pads with the navigation bar's height from the screen behind it |
| Bottom sheets: menu rows on another background than the sheet | Transparent rows |
| Back in a room during search, selection or an edit left the room | Back closes search, ends the selection, cancels the edit; only then leaves |
| Bottom sheets opened half way, cutting off their last rows (Delete, the last rooms to forward to) | They open all the way (their content is short or scrolls) |
| The emoji picker showed empty boxes on older Android (emoji newer than the system font) | It leaves out the emoji the device can't draw (`Glyphs`); bundling an emoji font would cost 10 MB |
| With Dark chosen, the app started on a light window (the theme is read after the first frame) | The choice is mirrored in a small preference read in `onCreate`: the window, the system bars and (Android 12+) the splash follow it; `uiMode` changes are handled in place |
| Sharing into the app: after choosing a room, the "Share to" picker came straight back over it | Choosing a room sets the share's target, which re-ran the effect that opens the picker; it now opens only for a share without one (`UiPortsTest`) |
| Adding people to a room: someone just added was still offered as if not added | They are shown with a check; a tap takes them out again |
| The room list was empty while it loaded | A spinner on the first load |
| The themed launcher icon (Android 13+) was a blob: the dots were drawn in colour, not cut out | `ic_launcher_monochrome` with the dots cut out |
| `UiFlowTest` waited without moving the main looper on | It uses the harness's `waitFor` (which pumps, and prints the screen on a timeout) |

### 18.3 Polish

Nunito (the rounded face of the web's font stack, one variable font, 277 KB) for all text; Material's shared X-axis
transitions between screens; the brand mark (the launcher icon's bubble on the accent gradient) on Log in, the server
choice and the room list when the site has no logo; vector room marks (#, lock, globe) instead of emoji; the other
person's avatar or the room's mark in the forward and share pickers; the send button a filled accent circle;
"Logging in…" / "Checking…" on buttons while busy; a password visibility toggle; "(edited)" inline after the text;
an add-reaction chip after a message's reactions; swipe right to reply (with a haptic tick); the message being acted
on shown at the top of its action sheet, Delete in red; the other person's avatar in a DM's header; the room's picture over "Beginning of …"; images about to be sent as thumbnails in the composer; the "New" line fades out; icons in the + menu; New room focuses its name; emoji category tabs; an inline audio player with progress and
times; the viewer's bars fade, with the author, time and file name, and a Download button; notifications tinted with
the accent; the app's version at the end of the profile.

### 18.4 Web features ported

| Web | App |
|---|---|
| Appearance: System, Light, Dark (DESIGN.md §7.8) | Profile → Appearance; kept in the device settings (`DeviceSettings.theme`, the account index's `theme`), the system bars follow it |
| Media grid (§30) | The room's 🖼 button → `MediaScreen`: `GET /api/chat/media/{room}`, month headings, 60 a page, posters, a tile opens the viewer |
| Jump to (§32) | The room list's search button (or Ctrl+K / Ctrl+P): `lib/Jump.kt` ports `matches`/`score`; rooms you just had open come first (`ChirkleServices.opened`, per account, forgotten when the session changes: QA BUG-152) |
| Media collections (§31) | §19 |

### 18.5 Tests

`JumpTest` (`:core:data`): the web's matching cases. `UiPortsTest` (`:app`): Jump to, the media grid and the viewer
from it, an empty grid, Appearance, and sharing into a room. 63 JVM tests in `:core:data` and 27 in `:app` pass; Android
lint adds no warning. The release APK is 3.48 MB (Nunito is most of the 0.24 MB added; budget 6 MB).

On the Android 9 emulator, by hand: log in, sign up (and its validation), the room list (light and dark), rooms and a DM,
sending text, emoji and images, replying (from the sheet and by swiping), starting an edit, reacting, forwarding, search,
the viewer (swiping, a video with its controls), the audio player, the media grid, Jump to, room access
(private, adding a member), creating a room, hiding one, Appearance, guests in an Open Air room, a link to a room,
sharing text in, realtime messages from another user. Not on the device: pinch zoom (adb has no multi-touch), saving
an edit and deleting (both covered by `UiFeaturesTest`), push notifications (no Firebase credentials here).

## 19. Media collections (2026-10-23)

DESIGN.md §31, the last web feature the app lacked, ported from `web/src/collections.ts` and
`web/src/views/collection/lazy.ts`. The server is unchanged.

### 19.1 Data

- Models (`Models.kt`): `MediaCollection` (not `Collection`, which Kotlin already has), `Collections`,
  `CollectionItem`, `CollectionMeta`, `Badge` and `SaveFrom` (a message's file, or an item). `Message.fileSources`
  (`file_sources`, now in `MSG_FIELDS`), and `Message.localItems`, the items a message on its way attaches.
- `ChirkleApi`: `collections`, `markSeen`, `badges`, `collection`, `createCollection`, `updateCollection`,
  `deleteCollection`, `collectionItems` (60 a page, cursor on `(created, id)`, older or newer), `itemIdsSince`,
  `saveItem`, `uploadItem`, `removeItem`, `savedIn`, `follow`, `itemUrl`, `itemPosterUrl`,
  `subscribeCollections` (yours, your subscriptions, and one topic per collection you follow), `subscribeBadges`
  (the `chat/badges` topic: a collection's id once it is made public or private, renamed or deleted). `NewMessage.items`: a
  JSON list in a JSON body, a JSON string in a form.
- `CollectionsSync` (`repo/`) ports `collections.ts`. It is started with the session for a signed-in user, keeps
  `AppState.collections`, refetches 250 ms after a live change and on every reconnect, and `seen()` clears a badge at
  once.
- The outbox keeps a message's items with it (`Outgoing.items`), so Retry sends the same ids.
- `Badges` (`repo/`), one per room screen: it asks `/api/chat/badges` once per collection while the room is open, in
  batches of at most 50. From the first badge on it listens to `chat/badges` and asks again about the ids it shows (the
  old badge stays until the answer), and about all of them after a reconnect, as on the web: made public, private or
  renamed, a badge follows live.

### 19.2 Screens

| Web | App |
|---|---|
| Sidebar section | The room list's Collections section, after Rooms: yours (a lock when private), then those you follow with their owner and a "99+" badge of new items. Its "+" (and the New button's "New collection") opens `NewCollectionDialog` |
| `/c/:id` | `CollectionScreen` (`feature/room`): name, whose it is, Public or Private, count; month headings; new items ringed with a dot and "*n* new since your last visit", sent as seen while the app is in view; follows the store (items added come in at the top; items taken out elsewhere leave; private or deleted: "This collection doesn't exist."). The owner gets Upload in the bar (the photo picker, several at once, one at a time with the percentage, images and videos of 20 MB at most, a 429 waited out) and Rename, Make public/private and Delete in the menu, plus × on each tile. Others get Subscribe / Unsubscribe |
| Save on a tile, in the viewer | A round collections button on every image and video tile of a message, on every tile of a collection page and in the viewer's bar (signed in only) → `SaveToCollectionSheet` (`core/ui`): tick to save, untick to take out, or make a new private one there |
| Attach from collections | The + menu's "From a collection" (a fourth button next to + would leave the phone's text field too narrow) → `CollectionPickerSheet`: a chip per collection, a grid, at most what the message still takes; the items join the tray after the files |
| The badge | Over a tile from a collection: the name with a lock for your private one, which opens the collection; "Private collection" (not tappable) for someone else's private one; nothing for one that is gone |
| Viewer | `CollectionViewerScreen`: the items around the one opened, oldest first, captioned "Added …" |
| Links | `/c/:id` links open the collection page (`routeOf`, the manifest's App Links) |

The web's drag-and-drop and paste upload have no phone equivalent. Guests see public collections and badges, but
can't save, subscribe or attach.

### 19.3 Tests and checks

`CollectionsTest` (`:core:data`): saving and `/saved` (409 twice, taking it out), paging both ways, the store's list
with live new counts, seen, and a collection turning private, and attaching through the outbox with `file_sources` and
badges for the owner, another user, and a deleted collection. `UiCollectionsTest` (`:app`): making a collection
from the room list and saving a room's image to it; a badge leading another user to a public collection, subscribing,
the room list's "1 new" and the page's "1 new since your last visit" until seen; attaching from the picker and the
sent message's badge; saving and unsaving from the viewer opened on a collection page. `RoutesTest`, `ServersTest`:
`/c/` links. Upload isn't covered: Robolectric can't drive the photo picker.

Robolectric found one problem in sheets. A sheet is its own window, and in tests its coroutines finished on a
background thread, so its state sometimes never reached the screen. The save and picker sheets now run on
`services.main`, as the services do.

67 JVM tests in `:core:data` and 32 in `:app` pass; release lint passes. While here, the viewer's seek bar got the
Media3 opt-in that release lint required. The release APK is 3.53 MB (+0.05 MB; budget 6 MB). Not yet tried on the
emulator.

## 20. Room list folding, unread first, accounts screen (2026-10-23)

- **Folding** (the web's, DESIGN.md §7.1): the Direct messages, Rooms and Collections headings fold their section;
  folded, it lists only the rooms with unread messages (collections you follow with new items). Which sections are
  folded is a device setting (`DeviceSettings.folded`, kept in the accounts index like the theme), as the web keeps it
  in the browser.
- **Unread first**, on the web too: `roomSections` takes the unread counts and lists rooms and DMs with a badge first,
  each group in its usual order (by name, by activity). Prefetch warms them first too.
- **Accounts** moved from the profile to their own screen (`AccountsScreen`, route `AccountList`), opened by tapping the
  brand (logo and title) on the room list (§17.2).
- **Profile order**, as on the web: picture, display name, Appearance, This device, Password, Session (Log out).

Tests: `RoomSectionsTest` (`:core:data`); `UiPortsTest` "unread rooms are listed first, and a folded section lists
only them"; `UiAccountsTest` switches through the brand's account list. All 69 JVM tests in `:core:data` and 34 in
`:app` pass.

## 21. Notifications without Google (2026-10-24)

The user asked for notifications of DMs and replies by "periodic polling with WorkManager, don't use google". The app
no longer has Firebase (FCM) in it: no Play services dependency, no push token, no `chat.fcm.*` build properties. It
works the same on de-Googled phones and on any server, with no push credentials anywhere.

### 21.1 What notifies

- **DMs**: every message from someone else in a DM.
- **Replies to you**: a message in a room that replies to one of yours.
- **Every message of a room chosen** in its menu (§24).
- Not: other room messages, your own, deleted ones, anything already read (here or on another device), hidden or
  archived rooms (DESIGN.md §13), the room open on screen, or anything from before you signed in.

### 21.2 The check

- `CheckWorker` (`app/…/notify/`): a unique periodic WorkManager job, every 15 minutes (Android's shortest period;
  Doze and app standby can stretch it), only with a network (`NetworkType.CONNECTED`). Scheduled at sign-in (KEEP:
  one job for all accounts), cancelled by itself when no account is signed in. Offline: `Result.retry()`.
- For each signed-in account, `NotifyCheck` (`core/data/…/repo/`) makes:
  1. `GET /api/chat/unread`: which rooms have unread messages, and the server's time.
  2. Only if some do: `ChirkleApi.notifiable` (`GET /api/chat/notifiable` since §31; a records list before), one
     messages list over those rooms (40 per request: each a range scan on `idx_messages_room_created`): `created > since && author != me && deleted = false && (room.kind = "dm" ||
     reply_to.author = me)`, newest first, at most 100.
  3. Only if something is new: `room_reads` for those rooms (what is past your read position is unread),
     `hidden_rooms`, and each room (title, archived).
  A quiet 15 minutes is one request per account.
- Its state, per account in the kv table (`notify_check`, cleared with the session): the last check's server time, the
  ids it saw, and when the session began. `since` is the last check minus a minute (a message's `created` isn't
  when it was committed, QA BUG-106), never before the session began; ids already seen aren't notified again.
- **On screen** (the account active and the app visible) the check notifies nothing and counts everything as seen:
  the room list shows it. The open room is never notified.
- Notifications are the ones of §8.3 and §17.4 (MessagingStyle, Reply and Mark as read, per account and room); one
  alert per room per check. A room read elsewhere loses its notification at the next check (or live, while the app
  runs). The room is prefetched so it opens at once.
- A Firebase build's `push_tokens` row was unregistered by the first check (or at log out), until the server dropped
  the collection (2026-10-28, §8 note).

### 21.3 Server

Unchanged. The push collections, hook and worker (§8.1, §8.2) stayed, unused by the app, until 2026-10-28 (removed,
§8 note).

The web app got the same notifications on 2026-10-24 (DESIGN.md §34: DMs and replies, chosen on the profile page, live
while a tab is open, a pop-up and/or a sound). No server or API change, so nothing for the app to follow; its
settings already match (one channel per kind).

### 21.4 Tests and checks

`NotifyCheckTest` (`:core:data`): a DM and a reply notify once, a plain room message and messages from before the
session don't, read elsewhere, hidden, on screen and the open room stay silent. `UiNotifyTest` (`:app`):
`CheckWorker.checkAll` posts a DM notification and a reply notification with their texts on their channels, and takes
the DM's away once read on another device. All JVM tests pass (`CollectionsTest`'s "followed" wait flaked once in
the full run, passed alone). The release APK is 2.99 MB (was 3.24 MB with Firebase). Not yet tried on the emulator.

Open question 8: is about 15 minutes late acceptable? Faster would need a push again (UnifiedPush keeps it free of
Google; its server side is done, §8.2) or a foreground service with a connection open, which costs battery and shows
a permanent notification.

## 22. QA pass 20: notifications on a device, ports of web fixes (2026-10-24)

Tested on the emulator (Android 9, §18.1) and with the JVM suites, alongside the web's QA pass 20 (QA.md).

### 22.1 Notifications on the emulator

§21's check, first run on a device: a DM and a reply to Zoe notified on their channels (Direct messages, Replies),
a plain room message didn't; inline **Reply** sent through the outbox and showed as "You" in the notification; **Mark
as read** read the room up to the reply (a later message stayed unread) and took its notification away; tapping a
notification opened its DM, at a cold start too. WorkManager refuses to run a periodic job before its period is up,
even forced (`cmd jobscheduler run -f`), and under TCG the guest clock runs slow: to try a check without waiting, set
the guest clock forward as root (`adb root`, `date @<epoch>`), then force the job.

### 22.2 Bugs fixed

| Bug | Fix |
|---|---|
| QA BUG-152: Jump to's "rooms you just had open first" was one list for the whole process: the next person signed in on the phone (or another account on the same server) got their rooms in the order the last one used them. The web's BUG-136 forgets them | `RecentlyOpened` is per account (`ChirkleServices.opened`) and cleared when its session changes (`ServicesTest`) |
| QA BUG-153: a check that failed part way (offline while it fetched the read positions or a room) had already saved what it found as seen: those DMs and replies were never notified | The check's state is saved once it is through; a room that can't be fetched for being offline fails the check (tried again), only a refused one is skipped (`NotifyCheckTest`) |
| QA BUG-154: a notification showed when the check ran, up to 15 minutes (or a Doze window) after the message | Its message's time (`UiNotifyTest`) |
| QA BUG-155: the viewer kept the images of a message deleted while it was open (the web's BUG-120, Medium, privacy) | The room viewer follows the room's messages: a message deleted, or a forward whose original was, takes its images and videos with it; the next shows (or the one before), none left closes it (`UiPortsTest`) |
| QA BUG-156: a message's menu or reaction picker stayed open when the message was deleted meanwhile; Reply, Edit or a reaction were then refused by the server (the web's BUG-121) | They close when their message is deleted or leaves the list (`UiFeaturesTest`) |
| QA BUG-158: a 200 that wasn't the server's answer (a captive portal's page) read as `{}`: lists came back empty, and the session renewal at start threw outside any handler, ending the app (the web's BUG-117) | A success other than 204 without a JSON body fails with status 0; `checkSession` ends the session only on a refusal (`ChirkleApiTest`) |
| QA BUG-159: holding Ctrl+K toggled Jump to on every key repeat (the web's BUG-137) | A repeated press is ignored (`UiPortsTest`) |
| QA BUG-160: a private room you were taken out of stayed kept on the device, shown when opened from a link or a notification until the server refused (the web's BUG-101, privacy) | A room that leaves the loaded list is kept empty (`ChirkleServices`, as the web's `forgetGone`; `ServicesTest`) |
| QA BUG-157: a message that arrived while the app was in the background (realtime stays up for a while, §9.1) stayed unread after coming back to it on screen: in the room list, on the web, everywhere | The room reports what is on screen again when the app comes back (`UiFeaturesTest`) |

### 22.3 Checked by hand on the emulator

Attaching a picture through the system picker (sent with its own name); changing the profile picture through it; a
draft across a rotation; the room filled in after coming back from the background, and a DM started meanwhile listed
with its badge; unread rooms listed first; the viewer dropping a deleted image live.

### 22.4 Tests

`UiHarness.reveal` scrolls whichever list holds a node to it: the shared server's public rooms push Collections further
down with every test, and `UiCollectionsTest` began to fail in full runs once they were off the composed range. The
hide test clicks the row's menu by its action, not a tap (scrolled to the bottom edge, the row was under the New
button), and reveals Hidden before waiting for it. All JVM tests pass: 76 in `:core:data`, 39 in `:app` (twice in a
row); lint is clean; the release APK is 3.14 MB (budget 6 MB).

## 23. Linked instances (2026-10-24)

The web's DESIGN.md §33.10, ported with it. Shared rooms (mirrors) and people on other instances (stand-ins) are
ordinary rooms and users to the app; it only shows what the server says of them:

- **Models:** `User.instance` (a stand-in's host, "" for this server's people) and `Room.shared` (`Shared(home, with,
  down)`), asked for in `MSG_FIELDS`, `ROOM_FIELDS` and the user fields; cached with the rest of the room's JSON.
- **Room top bar:** under the visibility line, "Shared with b.example", and "· a.example can't be reached right now"
  when the room's home is down (`Room.sharedNote()`, as the web's `sharedNote`).
- **Message sheet:** a stand-in's message says "Ann (B) (on b.example): …".
- **Room access:** where else the room's messages are kept (or, on a copy, that its home decides who is in it); people
  on other instances listed with their instance even though they may take no DMs (Telegram's stand-ins still aren't);
  in a shared room, the people search takes an address, `ann@b.example`, looked up on that instance.
- **New message:** the same search takes an address (`ChirkleApi.remoteUser`, `POST /api/chat/remote-users`); a refusal
  ("This instance isn't linked to b.example.") shows as the search's status. Results from other instances say "On
  b.example".
- **Tests:** `LinkedTest` (addresses, the top bar's line), `ChirkleApiTest` (a shared room and a stand-in decode; an address
  on an instance not linked is refused with its reason), `UiLinkedTest` (the top bar and the access screen of a shared
  room; New message with an address). The test server runs with the module on (since 2026-10-24 its Application URL and the
  site's `federation` are set after it starts, as `TestServer.enableFederation`; there is no environment variable), paired with no
  one: the server's own suite pairs real servers (`tests/integration/federation.test.ts`).

## 24. Notify of every message in a room (2026-10-24)

The user asked for notifications of all messages in a specific room, "on web and on mobile. no need to sync it" (the
web's DESIGN.md §34.5).

- The room's ⋮ menu (not a DM's: Direct messages already notify every message): **Notify of every message** (a bell),
  then **Stop notifying of every message** (a struck-out bell). Not offered in an archived room unless already on.
- Kept per account on this device, in the account's kv table (`notify_rooms`, space-separated ids; a session key, so
  gone at log out). `NotifyRooms` (`core/data/…/repo/Caches.kt`) holds it for the menu; `NotifyCheck` reads the
  table itself, since the check runs for accounts not open in the app.
- The check (§21.2) adds `|| room = {:rN}` for each chosen room of the chunk to `ChirkleApi.notifiable`'s condition:
  still one request, still only over rooms with unread messages. Hidden, archived and the open room stay silent.
- A new channel, **Room messages** (`room_all`, default importance), so they can be silenced apart from Replies.
  A room's notification uses Replies when its newest message is a reply to you, else Room messages.
- No server change. Tests: `NotifyCheckTest` (a chosen room's plain message notifies, another room's doesn't, off
  again silent), `UiNotifyTest` (the menu item turns it on, the worker posts on Room messages). Icons checked on a
  Robolectric screenshot; not yet tried on the emulator.

## 25. Reading only what is on screen (2026-10-24)

The user: "when switching to room with unread messages it shouldn't mark all messages as read. only visible. so when
scrolling in the room messages will be marked as read." Done on the web too (DESIGN.md §18.3).

- **The bug:** a room with unread messages opened at the bottom and was read to its newest message. The controller's
  scroll to the first unread message (`Scroll.Target`) could be emitted before the screen collected `scrolls` (a
  `SharedFlow` without replay drops it), e.g. when the kept window shows at once; the new list then stayed at its
  newest rows, which counted as read. `scrolls` is now a buffered channel (`receiveAsFlow`): kept until collected,
  each delivered once.
- **Reading:** `RoomViewModel.onScrolled(atBottom, shown, placed)` replaces `onAtBottom`. `shown` is the newest saved
  message whose row is on screen whole (the list is laid out from the bottom, so the lowest visible index whose
  offset is inside the viewport); at the bottom of the live edge it is everything, `caughtUp`. `placed`: nothing is
  read until the controller's first scroll has been applied when the room opens at a message (the first unread one, or
  a link's), since a new list shows its newest rows until then.
- **Counts:** `RoomReader.seen(created, caughtUp)` clears the room's count only when caught up; `close(false)`
  refetches the counts after the pending read is in, so the badge shows what is left below.
- Tests: `UiPortsTest` (a room opened with 30 unread reads only what is on screen; scrolled to the bottom, all).

## 26. QA pass 21: downloads, reads that fail, going to a message (2026-10-25)

Tested on the emulator (Android 9, §18.1) against the seeded server, and by reading the code against the web's; the
QA write-up is QA.md "QA pass 21". No web fix since the last sweep (BUG-150) was left unported.

### 26.1 Bugs fixed

| Bug | Fix |
|---|---|
| QA BUG-161: downloading a file (the room's file chips, the viewer's Download) did nothing on Android 8 and 9: the shared Downloads folder needs the storage permission there, the download manager refused, and the refusal was swallowed. The room said nothing either way | `chirkle.android.ui.download` (core:ui), used by the room and the viewer: Android 10+ the shared Downloads folder, before that the app's own (`Android/data/…/files/Download`, no permission; the download's notification opens it). A toast says it started or couldn't |
| QA BUG-162: a read that failed on its way (the network back a moment after the message showed) was tried again only with the next `seen()`, which nothing brought when the room on screen didn't change: the room stayed unread on the server, the list, the web, every device | `Unread`'s reader sends it again by itself, after 2 s, then doubling up to a minute, until it is in or refused (a 4xx other than 429) (`ServicesTest`) |
| QA BUG-163: going to a message (a search result, a quote, the first unread one when a room opens) put the row two below it at the bottom of the list: when those rows were tall (images, long messages, the keyboard up) the message itself was off the top. With reading what is on screen (§25), a first unread message off the top was read unseen. After picking a search result the keyboard also stayed up over half the room | The message's bottom edge goes to the bottom, then the list is raised a quarter of its height, as far as the message stays whole; picking a result clears the focus (`UiFeaturesTest`) |
| QA BUG-164: photos sent from Android 8 and 8.1 lost their orientation: `BitmapFactory` ignores EXIF, and re-encoding (§15.3) dropped it, so a portrait photo arrived sideways (also profile pictures) | `ImagePrep.decodeLegacy` turns the bitmap upright from the EXIF orientation (all eight, read with androidx's `ExifInterface`, now a direct dependency of core:ui), as `ImageDecoder` does on 9+ (`ImagePrepTest`) |
| QA BUG-165: an audio attachment that failed to play once ("Couldn't play …": offline, an expired file token) could never play in that room again: Play restarted the same broken `MediaPlayer`, which failed at once ("start called in state 0", error -38) | A failed player is released and forgotten: the next tap starts afresh, with a fresh file token; `start()`/`pause()` failures are caught too |
| QA BUG-166: a sign-in or renewal that got JSON other than a session (another site's, a proxy's) threw a `ClassCastException`/`NullPointerException`; renewing the idle accounts at launch (`Accounts.renewIdle`, catching only `ApiError`) then ended the app | `ChirkleApi.auth` fails with status 0 ("couldn't be read") unless the answer has a token and a user; `renewIdle` ends a session only on a refusal and leaves anything else for next time (`ChirkleApiTest`) |
| QA BUG-167: a profile picture that couldn't be read (gone from the provider, permission revoked) threw out of the screen's coroutine and ended the app | "Couldn't read that image." |
| QA BUG-168: a link or a notification to the room already open opens a new screen of it, and the old one closing afterwards set "no active room": messages arriving in the room on screen counted as unread, the prefetch fetched it, its notification wasn't taken away | `ChirkleServices` keeps the room screens open in order; the active room is the newest still open (`ServicesTest`) |
| QA BUG-169: the "New" line over the first unread message faded out after leaving the list, so for its 0.7 s it was drawn across that message's text while the list closed the gap | It fades out in its own place in its last 0.7 s, then goes |
| QA BUG-170: a collection followed (another device) just after the list was read, before the live subscription was in, never showed until a reconnect | Once subscribed, `CollectionsSync` reads the list once more, as the room catches up (`CollectionsTest` holds the subscription back) |

### 26.2 Checked on the emulator

Before the fixes: BUG-161 (the `SecurityException` in the log), BUG-162 (no read in the server's log), BUG-163, BUG-165
(`start called in state 0`, error -38) and BUG-169. With them: the viewer's Download finished into the app's Downloads
folder; Play on a broken audio file twice prepared a new player each time; a search result showed whole with the
keyboard put away. Also fine: sending, the soft keyboard's Enter (a new line, as designed), the viewer, the network
dropped and back (the message missed shows), a cold start after the process was killed. Under TCG the activity takes
over 10 s to stop, so Android drops its saved state ("Activity stop timeout"): after a kill it starts at the room list,
not the room. That is the emulator's speed (Settings saves its state there), not the app.

### 26.3 Not changed, for a decision

- Images uploaded straight into a collection (§19) keep their EXIF, GPS included, on the web as on Android: neither
  re-encodes them as attachments are (§15.3). Re-encoding would also scale them to 2048 px.
- The web's `unread.ts` and `collections.ts` had BUG-162's and BUG-170's weaknesses too; both fixed there on 2026-10-28.

### 26.4 Tests

New: `ServicesTest` (a failing read sent again; the active room with two screens of it), `ChirkleApiTest` (JSON that
isn't a session), `CollectionsTest` (a follow during the subscription), `ImagePrepTest`, `UiFeaturesTest` (a message gone
to shows whole). `UiHarness.openRoom` opens a room by its row's click action, tried again until it shows: scrolled to
from below, a row stops under the top bar, where a tap lands on the bar. All JVM tests pass, three full runs in a row
(84 in `:core:data`, 46 in `:app`); lint has no errors; the release APK is 2.99 MB (budget 6 MB).

## 27. Name: Chirkle (2026-10-27)

The user: "let's go with chirkle. change app name everywhere. android app also. reinstalls are not problem". The web
app, the server and the docs were renamed too (DESIGN.md §1, §24).

- **A new app:** the application id is `com.chirkle.android` (was `org.chat.android`). Phones see it as another app:
  it installs beside the old one, which can then be uninstalled. Nothing carries over, so each account logs in again.
  The launcher label is "Chirkle"; inside, the app shows the server's own title, as before.
- **Code:** the Kotlin package is `chirkle.android` (namespaces, the convention plugins `chirkle.android.*`, sources
  under `kotlin/chirkle/android/`). The classes named after the app are `ChirkleApp`, `ChirkleNav`, `ChirkleServices`,
  `ChirkleApi`, `ChirkleDatabase` (schemas under `schemas/chirkle.android.data.db.ChirkleDatabase/`), `ChirkleTheme`,
  `ChirkleColors`, `ChirkleIcons`, `ChirkleSheet` and the `Chirkle.colors` accessor; the style is `Theme.Chirkle`.
- **Build:** the Gradle properties are `chirkle.server`, `chirkle.appId` and `chirkle.devServer`; the tests' system
  property is `chirkle.repoRoot`.
- **Server:** `ANDROID_APP_ID` defaults to the new id (`/.well-known/assetlinks.json`, §9.4); set it only for a build
  with another `chirkle.appId`.
- **Kept:** the server's API (`/api/chat/…`, the `chat/badges` topic), so the app still talks to servers that haven't
  been updated yet.
- **Release build:** it didn't compile, before the rename too: `Downloads.kt` (QA BUG-161) used core-ktx's `toUri`,
  which `:core:ui` has only in debug builds, through Compose's tooling. It uses `Uri.parse`, as `Linked.kt` does;
  lint's `UseKtx` warning on both says otherwise. The release APK is 2.99 MB (budget 6 MB).

All JVM tests pass (84 in `:core:data`, 46 in `:app`); lint has no errors.

## 28. F-Droid (2026-10-27)

The user: "how do we add this app to fdroid", then "go". The app qualifies as it is: GPL-3.0, every dependency free
software from Google's Maven and Maven Central, and no Google services since §21. F-Droid builds from source and signs
with its own key.

### 28.1 Build

- `dependenciesInfo` is off for the APK and the AAB: AGP otherwise puts an encrypted list of dependencies (block
  `0x504b4453`) in the APK signing block, which only Google Play can read and F-Droid's scanner rejects.
- The release build takes no server (`chirkle.server` unset): it asks for one at first launch and claims no App Links
  host (§17.2). That suits a store whose users run their own servers.

### 28.2 Signing

| Gradle properties | Release APK signed with |
|---|---|
| `chirkle.keystore` (path), `chirkle.keystorePassword`, `chirkle.keyAlias`, `chirkle.keyPassword` (defaults to the store's password) | the release key: GitHub Releases, IzzyOnDroid |
| `chirkle.unsigned=true` | nothing: `app-release-unsigned.apk`, for F-Droid to sign |
| none | the debug key, so a local build installs |

### 28.3 Store listing

`fastlane/metadata/android/en-US/` at the repository root, where F-Droid and IzzyOnDroid look: title, short and full
description, `changelogs/<versionCode>.txt`, `images/icon.png` (512 px, the launcher icon's layers) and
`images/phoneScreenshots/` (the room list and a room, taken on Robolectric with seeded users). Each release adds a
changelog named after its `versionCode`.

### 28.4 Releasing

Bump `versionCode` and `versionName` in `app/build.gradle.kts` (F-Droid reads them there), add the changelog, and tag
the commit `android-v<versionName>`. F-Droid's update checker finds new tags (`UpdateCheckMode: Tags ^android-v`)
and builds them on its own.

### 28.5 Submitting

`android/fdroid/com.chirkle.android.yml` is the recipe. To submit: fork
gitlab.com/fdroid/fdroiddata, copy the recipe to `metadata/` (the repository is github.com/border-radius/chirkle),
check it with `fdroid lint` and `fdroid build -v -l com.chirkle.android` (or the merge request's CI), and open the merge
request. The first tag must exist before that. Risk: AGP 9.4, Gradle 9.8 and compileSdk 37 are recent; if F-Droid's
build server lacks them, the recipe needs extra steps.

Verified: the unsigned and the debug-signed release APKs build; the signed one's signing block holds only the v2
signature and padding (no dependency block). Release APK 3.0 MB.

## 29. Attachment shapes before they load (2026-10-28)

The server now keeps each image's and video's shape in `messages.file_dims` (DESIGN.md §17.5). `Message.fileDims`
reads it (the message fields ask for `file_dims`). In `Attachments.kt`, a lone image or video's box takes that shape
at once instead of the 240 × 160 placeholder, and an image tile in a row of several takes its width (80–112 dp)
before it loads. Video tiles in a row keep their fixed size. A file whose shape the server doesn't know yet, and a
message still sending, behave as before. `CollectionsTest` checks that an attached collection item gets its shape.

## 30. Shared contract and push removed (2026-10-28)

This section covers the app's side of the architecture review (docs/REFACTOR.md round 4).

- **Contract:** `ContractTest` checks the app's field lists (`MSG_FIELDS`, `ROOM_FIELDS`, `USER_FIELDS`, `ROW_FIELDS`,
  `ITEM_FIELDS`, `ACTIVITY_FIELDS`; all but the first two are now `internal` rather than `private`), its `Limits` and
  its file types against the repository's `shared/contract.json`. The web and the server are checked against the same
  file. docs/API.md lists what the app relies on from the server, and what a server change has to keep working for
  installed apps.
- **Shared vectors:** `VectorsTest` runs `shared/vectors/` (folding, search queries, highlighting, lengths, blank text,
  Jump to). The web and the server's `lib/text.js` run the same cases. Tests find the files through the build's
  `chirkle.repoRoot`, and the test tasks take `shared/` as an input (a change to it runs them again).
- **Writes split out:** `RoomController`'s sends, edits, deletes and reactions are `RoomWrites.kt` (as the web's
  `room/writes.ts`), reaching the window through a `RoomWrites.Host` the controller passes in. Its public methods are
  unchanged.
- **Window and room vectors:** `WindowVectorsTest` runs `shared/vectors/window.json` against `Window.kt` and
  `Cursors.kt`; `RoomScenariosTest` replays `room.json`, recorded from the web's room controller, against
  `RoomController` and a real server. A change to the web's controller is recorded again (docs/API.md), and the app
  has to pass it.
- **Push removed:** the server no longer has `push_tokens` or `push_queue` (§8 note). Gone from the app:
  `registerPush`, `unregisterPush`, `NotifyCheck.forgetPushToken` (with its calls in `CheckWorker` and at log out),
  `SessionHooks.beforeSignOut` (push was its only use) and `Keys.PUSH_ROW`. A value left under that key by a Firebase
  build is never read.

## 31. Pages and the room list as routes (2026-10-29)

The server now answers the room list and a room's message pages as routes (docs/API.md, DESIGN.md §6): the app
names the page and the server writes the filter.
- `Pages` (`Cursors.kt`) builds `PageQuery(room, kind, args, files)`, as the web's `lib/cursor.ts`;
  `WindowVectorsTest` checks both against `shared/vectors/window.json`.
- `ChirkleApi.listRooms` asks `GET /api/chat/rooms`; `page` and `changes` ask `GET /api/chat/rooms/{room}/messages`.
- **Older servers:** an account may be on a server that isn't updated yet. When a route answers 404 (the server
  has no such route: a room you can't see answers no messages, as before), that `ChirkleApi` (one per account) lists
  through the records API from then on, with `PageQuery.legacy()`: the filters the app sent before
  (`LegacyPagesTest`).
- Later the same day, search and the notification check too: `searchQuery` is a `PageQuery` with `q` (the words),
  asked of `page`; `ChirkleApi.notifiable` asks `GET /api/chat/notifiable`. Both fall back as the pages do; the old
  search filter is `legacy()`'s too (`shared/vectors/text.json` has both forms).
- **Tested against an old server:** `LegacyServerTest` runs one session (the room list, every kind of page, the
  changes, search, the notification check) against the test server and against `TestServer.legacyUrl`: these hooks
  without the routes of `lib/lists.js`, or an old release's with `-Pchirkle.legacyHooks=<its pb_hooks>`. Both see
  the same; the old one answers one 404 and nothing more is asked of the routes. Run 2026-10-29 with the hooks of the
  commit before the routes ("Tech debt, part 4"): passed.

## 32. QA pass 23 ports (2026-10-30)

Two fixes of docs/QA.md "QA pass 23" are the app's too:
- **Initials** leave out a word in brackets, as the web's (`initials()` in `Avatars.kt`): a stand-in "Ann (B)" is "A",
  not "A(" (QA BUG-176).
- **A DM that takes no messages** (one of the two has `no_dms`, as a linked instance's people do once it is unpaired)
  shows why instead of the composer, has no swipe to reply, and isn't a forward target (`Room.dmClosed()` in
  `Rooms.kt`, QA BUG-178). Tests: `HelpersTest`, `LinkedTest`.

## 33. Baseline Profile and Macrobenchmarks (2026-10-30)

docs/PERF.md has the whole product's performance work; this is the app's part.

- **`:baselineprofile`** (`android/baselineprofile`, a `com.android.test` module, minSdk 28) runs against the app's
  new **`benchmark`** build type: the release build (minified, not debuggable), signed with the debug key, talking to
  the dev server (`chirkle.devServer`), profileable from the shell, with http allowed to 10.0.2.2 only
  (`app/src/benchmark`). Release builds are unchanged.
- The journeys (`Journeys.kt`, UiAutomator): start, sign in when asked (alice of `emu-pb.sh`'s seed by default;
  `-Pchirkle.benchUser`, `chirkle.benchPassword`, `chirkle.benchRoom`), the room list, open the busy room (`random`),
  scroll back and down, back to the list.
- `BaselineProfileGenerator` writes the profile on the device; it is kept as `app/src/main/baseline-prof.txt`, which
  AGP compiles into the APK and `profileinstaller` (already a dependency) installs. No Baseline Profile Gradle plugin:
  regenerate by hand after big changes to those screens.
- `StartupBenchmark` (cold start to the room list, `StartupTimingMetric`) and `RoomBenchmark` (opening the room and
  scrolling, `FrameTimingMetric`), each without anything compiled and with the profile.
- New dependency: `androidx.benchmark:benchmark-macro-junit4` 1.5.0 (already in the catalog), in the test module only:
  nothing in the APK.
- The emulator here has no KVM, so its numbers only compare runs with each other, not with §11's budgets (a Pixel
  6a-class phone).

Run (emulator booted, `emu-pb.sh` serving):

```sh
./gradlew --max-workers=1 :baselineprofile:connectedBenchmarkAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=chirkle.android.baselineprofile.BaselineProfileGenerator
```

On the KVM-less emulator Gradle skips the device ("Unknown API Level": it can't read its properties in time), so
build with `:app:assembleBenchmark :baselineprofile:assembleBenchmark`, `adb install -r` both APKs and run
`adb shell am instrument -w -e class chirkle.android.baselineprofile.BaselineProfileGenerator -e user … -e password …
-e room random -e androidx.benchmark.suppressErrors EMULATOR
chirkle.android.baselineprofile/androidx.test.runner.AndroidJUnitRunner`; the profile is
`/storage/emulated/0/Android/data/chirkle.android.baselineprofile/cache/BaselineProfileGenerator_generate-startup-prof.txt`
(this version writes the startup profile only; it serves as `baseline-prof.txt`). The journeys tap "Wait" on the
emulator's "System UI isn't responding" dialogs. The benchmark build keeps its names (`app/benchmark-rules.pro`,
`-dontobfuscate`): a profile from an obfuscated build names classes like `f8`, which the next build renames.

2026-10-30: `app/src/main/baseline-prof.txt` generated (15.5 min on the emulator; 1,072 of the app's own entries
among Compose's, coroutines', OkHttp's…). It ships in the release APK (2.98 MB). Gradle and the emulator don't fit in
the machine's memory together: stop the emulator while Gradle builds.

| On the emulator here (TCG, no KVM) | Nothing compiled | With the profile |
|---|---|---|
| Cold start, first frame (median of 5) | 11.7 s | 11.8 s |
| Cold start, room list shown (`reportFullyDrawn`) | 47.2 s | 37.8 s (−20%) |
| Opening the busy room and scrolling: CPU per frame p50 / p90 | 402 / 1,253 ms | 264 / 771 ms (−34% / −38%) |
| The same, p95 / p99 | 1,792 / 5,347 ms | 1,069 / 3,047 ms (−40% / −43%) |

The emulator is many times slower than a phone, so only the differences mean anything: the profile takes about a
fifth off showing the room list and over a third off the room's frames. The first frame doesn't move (on this
emulator it is mostly the process starting).

## 34. Live replies without their quote (2026-10-30)

The room's live subscription no longer asks the server for the message a reply answers (`LIVE_OPTS` in
`ChirkleApi.kt`, as the web's `api.ts`): that expand cost the server ~5 ms a client for every reply (docs/PERF.md
§2.3). `RoomController.quoted` fills it in from the original in the window, or from the reply's own copy there (an
edit); a reply to a message beyond the window fetches the original (`getMessage`) and the rows that quote it are
patched. Pages, `getMessage` and sends still come with the quote. Tests: `ServicesTest` (a live reply quoted from the
window and kept through an edit; one beyond the window fetched).

Also 2026-10-30, server only: PocketBase closed a realtime connection after 5 quiet minutes, and the app took the
reconnect for a lost one (rooms, unread counts and the open room loaded again). The server now sends every client a
`chat/keepalive` event every 3 minutes (docs/PERF.md §2.4); `Realtime.dispatch` finds no listener for it and drops it,
in every released version.

## 35. QA pass 24 fixes (2026-10-31)

docs/QA.md "QA pass 24" found three gaps where the app didn't do what the web does:
- **Quotes follow the original** (QA BUG-181): a reply quotes the window's copy of the message it answers when the
  window has it (`RoomViewModel.quoting`, the web's `quotedOf`), so an edit or a delete shows in the quote at once.
- **The reply bar follows the original** (QA BUG-182): edited, it shows the new text; deleted, the room archived, or
  posting no longer allowed, the reply ends (an edit in progress too) and doesn't come back (`RoomViewModel.follow`,
  run on every window and store change; the web's `reply.ts`).
- **A revoked session ends** (QA BUG-183): the session is checked when the app comes back after 5 minutes
  (`ChirkleServices.setVisible`, `CHECK_STALE_MS`, the web's `renewal.visible`) and when a room "doesn't exist" while
  signed in (`ChirkleApi.suspectSession`, which runs the `onRejected` check). Reads with a token the server refuses
  answer as to a guest, so without this a password changed on another device left the app showing rooms that "don't
  exist".

Tests: `UiFeaturesTest` (quotes and the reply bar follow an edit and a delete), `ServicesTest` (revoked session).

## 36. The 2026-10-31 redesign

The "Chirkle Sidebar Redesign" design (DESIGN.md §7.1, §7.8; boards in `docs/design-frames/`) restyled the web and the app together. In the app:

- **Theme** (`core/ui/Theme.kt`): the web's new tokens. Dark: background `#1a1724`, the room list on `#15121e`
  (`surfaceVariant`), raised `#221e2f` (`surfaceContainer`), accent text `#b9a6ff` (`primary`), the violet fill
  `#6d4aff` (`primaryContainer`, `ChirkleColors.fill`: unread badges, the send button), pink `#f9a8d4` for the NEW line
  (`ChirkleColors.new`), and a quieter `ChirkleColors.dim` for times, "#" and section headings. Light keeps its palette.
  **Font:** Inter, the web's font (DESIGN.md §7.7), bundled as one variable font (`core/ui/res/font/inter.ttf`, 0.88 MB,
  SIL OFL in `core/ui/OFL-Inter.txt`) in place of Nunito (0.28 MB): about 0.6 MB more in the APK (budget 6 MB). No extra
  letter spacing (Material's default 0.5 sp made it loose), as on the web.
- **Room list** (`RoomsScreen`): a search pill on top (the brand opens Accounts, "Jump to…" opens Jump to, your avatar
  opens the profile, or Log in), then Rooms, Direct messages and Collections, each heading with its own "+" (New room,
  New direct message, New collection) in place of the floating New button, then one folded **Hidden & archived** heading
  with how many (the web merged the two sections too), its Hidden and Archived parts inside. Rows are 56 dp with 16 dp
  corners, a raised "#" tile for rooms, the lock or globe after the name, the open room tinted, unread names bold with a
  badge in the fill.
- **Room** (`RoomScreen`, `Composer`, `MessageRow`): the "#" in the title quieter than the name; day headings as
  chips; the NEW line pink with "NEW" at its end; a reply to one of your messages, by someone else, is a tinted card (the
  web's `.to-me`, not in the app before); the composer a 52 dp pill (emoji, field, attach) and a rounded-square send
  button in the fill, dimmed when there is nothing to send; read-only notices (guest, archived, only some may post, a
  closed DM) a 68 dp strip with an icon.

Not ported from the boards: the collections grid with item counts (the list has no counts or covers to show), the
voice-message waveform (there are no voice messages) and the redesigned sheets, accounts and server screens, which keep
their current look in the new colours.

Tests: `UiFeaturesTest`, `UiLinkedTest`, `UiCollectionsTest` use the headings' "+" buttons and the merged heading.

## 37. QA pass 25 (2026-10-31)

QA pass 25 (docs/QA.md) tested the redesign on the web and in the app. Found in both: **BUG-191**, Inter's contextual
alternates (`calt`) drew people's text as something else, "32x1n" as "32×1n", "->" and "<-" as arrows, in room and
user names, messages and the composer. The app's typography (`core/ui/Theme.kt`) now sets `fontFeatureSettings =
NO_CALT` (`"'calt' 0"`) on every style, as the web's `tokens.css` does (`UiPortsTest`). The other bugs of the pass
were in the web's own CSS and menus; the app's quotes put the author on a line of their own, so a short quote doesn't
clip it (BUG-186).
