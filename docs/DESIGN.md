# Chirkle — MVP Design Document

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-10-10 |
| **Scope** | MVP (§1–§14); post-MVP features: avatars §15, direct messages §16, attachments §17, unread counts §18, replies §19, reactions and emoji §20, selecting, forwarding and deleting several messages §21, accounts and quality of life §22, room access (private rooms, Open Air rooms and guests) §23, site settings §24, measured scale §25, Telegram bridge §26, …, media grid §30, media collections §31, Jump to §32, linked instances §33 |

Code and tests cite this document by section number (e.g. `§7.5`). **Don't renumber sections:** append new ones, and
mark obsolete ones as such instead of deleting them.

---

## 1. Summary

Chirkle (called Chat until 2026-10-27) is a small, fast, real-time group chat web app. Users sign up, see a list of public rooms, join one, and talk. New messages show up live without a page reload.

The whole system is **one PocketBase binary**. It handles auth, data, realtime and serving the static frontend. The frontend is **vanilla TypeScript** with no UI framework, bundled by **esbuild** into one small JS file and one CSS file.

## 2. Goals and non-goals

### Goals

1. **Working real-time chat.** Sign up or log in, list and create rooms, read history, and send and receive messages live.
   - Any user can create a room.
   - Each user can hide rooms they don't want to see.
   - Users can edit and delete their own messages. A deleted message leaves a "Message deleted" placeholder in the history.
   - Removing a room **archives** it. Archived rooms stay readable.
   - History is kept forever. A user can scroll back to the very first message in any room.
2. **Minimal and fast frontend.** No framework and no virtual DOM. Strict size budget (§7.7). The page should be interactive in about 1 second on a mid-range phone.
3. **Simple to run.** `npm run dev` gives a working local setup. Deployment is one binary plus a few folders.
4. **Secure by default.** All access control lives in PocketBase API rules. Untrusted text never reaches the page as HTML.
5. **Tested.** Unit, integration and end-to-end tests run in CI on every push.

### Non-goals (MVP)

These are left out on purpose. The design should not block them later.

- Private rooms, room membership or invitations (direct messages: now designed in §16)
- File and image uploads (avatars and attachments: now designed in §15 and §17), link previews
- Reactions, threads, replies, mentions (replies: now designed in §19; reactions: §20)
- Typing indicators, presence, read receipts
- Push notifications (notifications while a tab is open, without a push service: now §34), email notifications
- Message search (now designed in §29)
- OAuth providers (email and password only)
- Email verification (not required to sign up or post, so no SMTP needed)
- Message retention limits (history is never pruned)
- Native mobile apps (Android: now designed in [`ANDROID.md`](ANDROID.md)), offline support (a service worker for an installable app and an offline shell: now §27)
- End-to-end encryption

## 3. Architecture

```
┌────────────────────────── Browser ───────────────────────────┐
│  index.html + app.[hash].js + app.[hash].css                 │
│                                                              │
│  router ─► views (login / rooms / room) ─► dom helpers       │
│              │                                               │
│              ▼                                               │
│            store  ◄──── api.ts (wraps pb.ts, a PB client)    │
└──────────────────────────────┬───────────────────────────────┘
                REST (JSON)    │    SSE (realtime)
┌──────────────────────────────▼───────────────────────────────┐
│                     PocketBase (single binary)               │
│  /api/*         REST + auth + realtime (SSE)                 │
│  /*             static files from pb_public/                 │
│  pb_migrations/ schema as code (JS migrations)               │
│  pb_hooks/      server-side validation, headers              │
│  pb_data/       SQLite DB + backups                          │
└──────────────────────────────────────────────────────────────┘
```

**Why PocketBase:** auth, a REST API, per-record access rules, realtime over SSE, an admin UI, backups and static file serving all come in one Go binary backed by SQLite. That is all an MVP chat needs. It removes the need for a separate API server, WebSocket server, or reverse proxy (PocketBase can also issue its own TLS certificates).

**Why no framework:** the UI has three screens and one hot path, which is appending messages to a list. Updating the DOM directly with a few small helpers is less code, loads faster, and is easy to reason about.

**Version assumption:** the design targets the PocketBase API from **v0.23 onward** (`@request.body` in rules, `$app` and `routerUse` in JS hooks, autodate fields). The exact release is pinned in `scripts/fetch-pocketbase.sh`, using the latest stable release when implementation starts.

## 4. Repository layout

```
chat/
├── docs/
│   ├── DESIGN.md               # this document (the living spec)
│   ├── QA.md                   # QA findings and their fixes, BUG-24 onward (code and tests cite them)
│   ├── REFACTOR.md
│   ├── API.md                  # what the clients rely on from the server, and how to change it safely
│   └── history/                # finished plans: BUILD_PLAN.md (MVP), NEXT_FEATURES_PLAN.md (§15–§17)
├── shared/                     # contract.json (field lists, limits, file types) and vectors/: every client's and the server's tests run them
├── package.json
├── tsconfig.json, tsconfig.server.json
├── scripts/
│   ├── fetch-pocketbase.sh     # downloads the pinned PB release into ./bin
│   ├── build.mjs               # esbuild production build → pb_public/, size budget (§7.7)
│   ├── dev.mjs                 # esbuild watch + spawns `pocketbase serve`
│   └── pb-types.sh             # PocketBase's generated types for typechecking hooks and migrations
├── pb_migrations/              # schema + API rules (committed; never edited once applied, only added to)
│   ├── 1760000000_init.js
│   ├── 1760000001_qa_fixes.js
│   ├── 1760000002_avatars.js           # §15.1
│   ├── 1760000003_direct_messages.js   # §16.1, §16.3
│   ├── 1760000004_attachments.js       # §17.1
│   ├── 1760000005_file_names.js        # §17.1 (QA BUG-28)
│   ├── 1760000006_room_reads.js        # §18.1
│   ├── 1760000007_replies.js           # §19.1
│   ├── 1760000008_lowercase_emails.js  # QA BUG-47
│   ├── 1760000009_reactions.js         # §20.1
│   ├── 1760000010_fit_thumbs.js        # §17.5
│   ├── 1760000011_forwarding.js        # §21.3
│   ├── 1760000012_accounts.js          # §22.1, §22.2
│   ├── 1760000015_site.js              # §24
│   ├── 1760000017_no_dms.js            # §16.7
│   ├── 1760000018_attachment_limits.js # §17.1
│   ├── 1760000019_telegram.js          # §26 (tg_* collections)
│   ├── 1760000035_telegram_anonymous.js # §26.6 (tg_links.anonymous)
│   ├── 1760000020_service_messages.js  # §5.3 (messages.author optional: service messages)
│   ├── 1760000032_federation.js        # §33 (fed_* collections, the core's federation fields)
│   ├── 1760000033_federation_requests.js # §33.2–3 (site.federation, fed_peers "requested")
│   ├── 1760000037_file_dims.js         # §17.5 (messages.file_dims, media.sized)
│   └── 1760000038_drop_push.js         # push_tokens and push_queue removed (REFACTOR round 4)
├── pb_hooks/                   # server-side JS hooks (committed)
│   ├── main.pb.js              # registrations only; every hook on messages, rooms and users (features' parts in order, §5.6)
│   ├── telegram.pb.js          # the Telegram bridge's routes, worker and tg_* hooks, only with TELEGRAM_BOT_TOKEN (§26)
│   ├── telegram/               # the bridge: api, people, links, inbound, outbound, worker (§26)
│   ├── federation.pb.js        # linked instances' routes, worker and fed_* hooks; on with site.federation (§33)
│   ├── federation/             # config, net (signing, curl), people, rooms (the home's side), mirror (a mirror's side),
│   │                           # messages, peers, inbox, worker (§33)
│   └── lib/
│       ├── messages.js         # messages hooks: text, attachments, replies, forwards, soft delete, edit stamps (§5.6, §17, §19, §21)
│       ├── rooms.js            # rooms hooks: names, DM fields, members, archive stamps (§5.2, §16, §23)
│       ├── access.js           # who can see a room: canSee, SEES_SQL, lost-access events (§23)
│       ├── records.js          # shared record helpers: field errors, name keys, uploaded file names
│       ├── text.js             # pure string cleaning: invisible characters, name keys, file names (§5.2, QA BUG-38)
│       ├── http.js             # security + cache headers, /assets/ (§5.6, §8.2)
│       ├── dms.js              # POST /api/chat/dms (§16.2)
│       ├── lists.js            # GET /api/chat/rooms, rooms/{room}/messages (pages, search), notifiable (§6)
│       ├── reads.js            # GET /api/chat/unread, POST /api/chat/reads (§18.2)
│       ├── reactions.js        # POST /api/chat/reactions (§20.2)
│       ├── bulk.js             # POST /api/chat/delete, POST /api/chat/forward (§21)
│       ├── account.js          # POST /api/chat/password (§22.2)
│       ├── site.js             # invite-only signups (§24), GET /manifest.webmanifest (§27), App Links (ANDROID.md §9.4)
│       ├── features.js         # the optional features' parts of the core hooks: federation, Telegram (§5.6)
│       ├── worker.js           # the cron workers' loop and lock: previews, media, Telegram, federation (§28.1)
│       ├── previews.js         # link previews: the queue, the worker, fetching with curl (§28)
│       ├── outbound.js         # where the server may go: public hosts and addresses (previews, federation; §28, §33.6)
│       ├── pages.js            # reading a fetched page: title, icon link, charset (§28)
│       ├── users.js            # users hooks (§5.1, §22.1), login by email, GET /api/chat/users (§16.5)
│       ├── emoji.js            # the emoji a reaction may be (§20.1)
│       └── images.js           # upload image size limit (§15, QA BUG-24)
├── web/
│   ├── index.html              # template; build injects hashed asset names
│   ├── styles/app.css          # @imports styles/app/*.css (one file per part, in cascade order) into one bundle
│   ├── styles/viewer.css       # the image viewer's, loaded on first use (§17.7)
│   ├── styles/media.css        # the media grid's, loaded on first use (§30)
│   ├── public/icons/           # the installed app's icons, copied to pb_public/icons/ (§27)
│   └── src/
│       ├── main.ts             # boot; registers the service worker
│       ├── sw.ts               # the service worker, built on its own to /sw.js (§27)
│       ├── app.ts              # app shell: session start/end, routes
│       ├── renewal.ts          # session renewal and checks (QA BUG-45, BUG-51, BUG-151)
│       ├── header.ts           # the app bar
│       ├── jump.ts             # Ctrl+K / Ctrl+P opens Jump to (§32)
│       ├── api.ts              # the only module that talks to PocketBase (through pb.ts)
│       ├── pb.ts               # minimal PocketBase client: requests, auth store, realtime (§6)
│       ├── store.ts            # tiny observable state + selectors
│       ├── sync.ts             # keeps rooms + hidden rows live (§7.4)
│       ├── actions.ts          # room commands: create, hide, archive, open DM
│       ├── context.ts, scope.ts, router.ts, dom.ts
│       ├── lib/                # pure logic, unit-tested without a DOM
│       │   ├── id.ts, time.ts, cursor.ts, scroll.ts, limits.ts, types.ts
│       │   ├── messages.ts     # window logic: merge, dedupe, trim, group (§7.5)
│       │   ├── rooms.ts        # DM titles (§16.5)
│       │   ├── avatar.ts       # initials + color (§15.4)
│       │   ├── image.ts        # resize + re-encode before upload (§15.3)
│       │   ├── files.ts        # attachment names and limits (§17)
│       │   ├── emoji.ts        # the picker's emoji, recently used (§20.4)
│       │   ├── reactions.ts    # optimistic reaction changes, who reacted (§20.3)
│       │   └── token.ts        # file token cache (§17.3)
│       ├── ui/                 # small reusable components
│       │   ├── menu.ts, avatar.ts, user-search.ts, emoji-picker.ts
│       └── views/
│           ├── login.ts, rooms.ts, home.ts, profile.ts
│           ├── room.ts         # puts the controller's changes on screen, wires the parts
│           └── room/           # controller.ts (message window, loading, realtime; no DOM), writes.ts (its sends,
│                               # edits, deletes, reactions),
│                               # header.ts, messages.ts (the list), composer.ts, forward.ts (§21.3),
│                               # viewer.ts (image viewer, a lazy chunk: §17.7), search.ts (message search, a lazy chunk: §29),
│                               # media.ts (media grid, a lazy chunk: §30)
├── tests/
│   ├── unit/                   # Vitest + happy-dom, no server: pure logic, DOM helpers, the build
│   ├── component/              # Vitest + happy-dom, views and services against a real throwaway PocketBase
│   ├── integration/            # Vitest against a real PocketBase process
│   ├── e2e/                    # Playwright
│   └── support/                # shared harness and fixtures
├── bin/                        # pocketbase binary (gitignored)
├── pb_public/                  # build output (gitignored)
└── pb_data/                    # local DB (gitignored)
```

## 5. Data model

All schema is defined in `pb_migrations/` so every environment gets the same schema and API rules. Changes made in the admin UI during development are captured with PocketBase's automigrate and committed.

### 5.1 `users` (built-in auth collection)

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | PB default |
| `email` | email | unique, required; `emailVisibility = false` |
| `name` | text | required, 1–32 chars, trimmed |
| `created` / `updated` | autodate | |

### 5.2 `rooms`

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | |
| `name` | text | required, 1–48 chars, **unique** ignoring case in any script (via `name_key`) |
| `name_key` | text, hidden | set by a hook: the name without invisible characters, NFKC-normalized and case-folded; unique index. Never returned by the API. |
| `created_by` | relation → users | required, single |
| `archived` | bool | default `false` |
| `archived_at` | date | set by a hook when `archived` changes; cleared on unarchive |
| `created` / `updated` | autodate | |

Rooms are **never hard-deleted** through the API. "Delete room" in the UI sets `archived = true`. An archived room:

- is **read-only**: no new messages, edits or deletes (enforced by API rules, §5.5);
- keeps its full history, which anyone can still read;
- keeps its name reserved, because the unique index still applies;
- can be unarchived by its creator.

### 5.3 `messages`

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | **may be client-supplied** (see §7.5) |
| `room` | relation → rooms | required, single, cascade delete (applies only to a superuser hard-delete from the admin UI) |
| `author` | relation → users | single; required of every request (the create rule), empty only for a **service message** (below) |
| `text` | text | max 2000 chars. Must be non-empty unless the message is deleted (enforced by a hook, §5.6), so not marked `required` in the schema. |
| `edited_at` | date | empty = never edited; set by a hook when `text` changes on update |
| `deleted` | bool | default `false`; once true it can never be set back to false |
| `deleted_at` | date | set by a hook when `deleted` becomes true |
| `created` / `updated` | autodate | |

**Messages are soft-deleted.** When a user deletes a message, the record stays in place. The server sets `deleted = true`, stamps `deleted_at` and **clears `text`**, so the content really is gone from the database and from every API response.

Clients render a deleted message as a *"Message deleted"* placeholder, with its author and time kept. This keeps conversations readable, so replies still make sense and history doesn't silently shrink. A deleted message can't be edited or undeleted.

The API `DELETE` endpoint is turned off, so records are never removed. The only exception is a superuser using the admin UI.

**Service messages** are the app's own notices in a room, such as "Telegram group "Friends" was disconnected from this room." (§26.5): a message with no author, only text. Only server code makes one (`postService` in `pb_hooks/lib/messages.js`, in a room that isn't archived): the create rule requires `author = @request.auth.id` from a signed-in caller, and no update rule matches an empty author, so nobody can make, edit or delete one through the API (`pb_migrations/1760000020_service_messages.js`). They can't be replied to, reacted to or forwarded (the hooks refuse it), count as unread like anyone else's message, aren't passed on to Telegram, and show as a centered grey line with their time and no buttons. A room opened at its first unread message goes to it when that is a service message, as for any other.

**Indexes:** `CREATE INDEX idx_messages_room_created ON messages (room, created, id)`. This supports history pagination in both directions (§7.5) and the realtime filter. Because `id` is part of the index, the `(created, id)` cursor stays stable even when two messages share the same millisecond.

### 5.4 `hidden_rooms`

This collection records which rooms each user has hidden. There is one row per (user, room) pair. Hiding a room is personal, so other users are unaffected.

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required, cascade delete |
| `room` | relation → rooms | required, cascade delete |
| `created` | autodate | |

**Indexes:** `UNIQUE (user, room)`.

A hidden room:

- disappears from the user's main room list;
- appears under a collapsed **"Hidden rooms"** section, where it can be unhidden;
- stays reachable by direct link `/r/:id`, and posting still works there.

A separate collection was chosen over a multi-relation field on `users` for three reasons. The access rules stay trivial. The `users` record doesn't grow without bound. Hide and unhide are single insert or delete operations, so two tabs can't overwrite each other's changes.

### 5.5 API rules

`@auth` below means `@request.auth.id != ""`.

| Collection | list / view | create | update | delete |
|---|---|---|---|---|
| `users` | `@auth` (other users' email stays hidden) | public (signup, no verification) + `NO_PUBLIC_EMAIL`¹ | `id = @request.auth.id && NO_PUBLIC_EMAIL`¹ | **none** (superuser only)² |
| `rooms` | `@auth` | `@auth && @request.body.created_by = @request.auth.id && (@request.body.archived:isset = false \|\| @request.body.archived = false) && @request.body.archived_at:isset = false` | `created_by = @request.auth.id && @request.body.created_by:isset = false && @request.body.archived_at:isset = false` | **none** (superuser only) |
| `messages` | `@auth` | `@auth && @request.body.author = @request.auth.id && @request.body.room.archived = false && @request.body.deleted:isset = false && @request.body.deleted_at:isset = false && @request.body.edited_at:isset = false` | `author = @request.auth.id && room.archived = false && deleted = false && @request.body.author:isset = false && @request.body.room:isset = false && @request.body.edited_at:isset = false && @request.body.deleted_at:isset = false && (@request.body.deleted:isset = false \|\| @request.body.deleted = true)` | **none** (superuser only) |
| `hidden_rooms` | `user = @request.auth.id` | `@auth && @request.body.user = @request.auth.id` | **none** | `user = @request.auth.id` |

¹ `NO_PUBLIC_EMAIL` = `(@request.body.emailVisibility:isset = false || @request.body.emailVisibility = false)`. Users can't make their email visible to others.

² Users can't delete their own account: their rooms reference them through a required relation, and a hook refuses deleting anyone who wrote a message (`messages.author` isn't required, for service messages, §5.3, so PocketBase would otherwise clear it and their words would read as the app's), so the delete could only fail for anyone who had posted. Removing an account (and deciding what happens to its content) is a superuser task for now.

The source of truth for all rules is `pb_migrations/1760000000_init.js` and the migrations after it. Direct messages (§16.3) change the `rooms` and `messages` rules above; this table is the MVP version.

PocketBase applies the list rule to realtime subscriptions too, so these rules also control who receives SSE events.

In plain terms:

- Any logged-in user can create a room.
- Only the creator can rename, archive or unarchive it.
- Only the author can edit or delete a message, and only while its room is active. "Delete" is an update that sets `deleted: true`. After that the message is frozen.
- `hidden_rooms` rows are visible only to their owner.

### 5.6 Server hooks (`pb_hooks/main.pb.js`)

The hooks are kept small. They only do things the rules can't express. Every hook on the core collections
(`messages`, `rooms`, `users`) is registered in `main.pb.js`, which also calls the optional features' parts
(`lib/features.js`) in one stated order: linked instances (§33) first, then the core, then the Telegram bridge (§26);
after the save the other way round. They used to register their own hooks, and their order was the order PocketBase
loads the files in (by name).

- **Normalize text:** trim `messages.text`, `rooms.name` and `users.name` on create and update, and reject values that are empty after trimming or made only of invisible characters (zero-width spaces, bidi controls, BOM…). Names also lose bidi overrides and zero-width spaces, so they can't be used to spoof another name. Message text keeps tabs and line breaks (stored as `\n`: CR LF, a lone CR and U+2028/2029 become one) and loses every other control character (NUL, bell, escape codes from pasted terminal output; QA BUG-105). The one exception is message text on a delete (next bullet).
- **Unique room names:** on `rooms` create and update, set `name_key` and reject a name whose key another room already has (`validation_not_unique` on `name`, like the index error it replaces).
- **Soft delete:** on a `messages` update where `deleted` becomes true:
  - set `deleted_at = now` and `text = ""`;
  - ignore any other fields in the same request;
  - leave `edited_at` unchanged.
- **Edit stamp:** on a `messages` update where `text` actually changed (and it isn't a delete), set `edited_at = now`. An update that doesn't change the text leaves it untouched.
- **Archive stamp:** on a `rooms` update, set `archived_at = now` when `archived` becomes true, and clear it when `archived` becomes false.
- **Archived-room guard (defense in depth):** reject a message create, update or delete when the target room is archived. This repeats the API rule in case rule traversal through `@request.body.room.archived` behaves differently in the pinned PocketBase version. Integration tests cover both layers.
- **Security headers** via `routerUse`: every response gets `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`. Static app paths also get `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The hash allows index.html's one inline script, which sets the chosen theme before the first paint (§7.8). The CSP is *not* applied to `/api/*` or to the admin UI `/_/`, which sends its own CSP.
- **Cache headers:** `/assets/*` (content-hashed) gets `Cache-Control: public, max-age=31536000, immutable`. Every other static path, including `/` and `index.html`, gets `no-cache`.
- **No `index.html` for a missing asset or API:** PocketBase serves `index.html` for any path that isn't a file (§7.1). Under `/assets/` (a route of ours, `GET /assets/{path...}`) a missing file is a 404 with `Cache-Control: no-store` instead: an old build's lazy chunk, asked for by a tab left open across a deploy, would otherwise get HTML (useless as a script) cached for a year under its hashed name. An unknown `/api/` path is a JSON 404 too, not the app's page.
- **Rate limiting:** PocketBase's built-in limiter, enabled from the init migration. The limits are per client IP:
  - `messages:create`: 10 requests per 5 s.
  - `users:create` (guests): 20 requests per 60 s.
  - `messages:update` (edits and soft deletes): 20 requests per 10 s.
  - `rooms:create`: 5 requests per 60 s (rooms can't be deleted, so a flood would stay in everyone's list).
  - PocketBase's default rules are kept after these.

  Test harnesses turn the limiter off, because every test client shares 127.0.0.1. `http.test.ts` turns it back on to verify the 429.

## 6. API usage (frontend ↔ backend)

The frontend talks to PocketBase through `pb.ts`, a minimal client (about 2 KB gzipped) that replaced the official **PocketBase JS SDK** (about 10 KB, most of it admin services, OAuth2/OTP/MFA flows and cookie helpers the app never used; §13). It keeps the SDK 0.28 wire behavior the app relies on: JSON or multipart requests with the auth header, `pb.filter()` binding, the auth record in `localStorage` under the SDK's key `pocketbase_auth` (shared with other tabs through the `storage` event), and the realtime protocol (one `EventSource`, `PB_CONNECT` client id, subscriptions POSTed to `/api/realtime` and resent after reconnects with the same backoff). Only `api.ts` imports it. A failed request rejects with a `PbError`, status 0 for network trouble, including a success whose body never came (the page navigated away mid-answer; taken as `{}` it saved an empty session, QA BUG-117). The record calls in the table below are named as in the SDK; `api.ts` implements them on top of `pb.send()`. The tests still use the SDK as an admin client.

| Action | Call |
|---|---|
| Sign up | `users.create({email, password, passwordConfirm, name})` then `authWithPassword` |
| Log in | `users.authWithPassword(email, password)` |
| Restore session | `pb.authStore.isValid` → `users.authRefresh()` in the background |
| Log out | `pb.authStore.clear()` + unsubscribe all |
| List rooms | `GET /api/chat/rooms` with `expand` and `fields` (`pb_hooks/lib/lists.js`): the rooms you can see, by name |
| List my hidden rooms | `hidden_rooms.getFullList({fields: "id,room"})` (fetched in parallel with rooms) |
| Create room | `rooms.create({name, created_by: me})` |
| Archive / unarchive room | `rooms.update(id, {archived: true \| false})` |
| Hide room | `hidden_rooms.create({user: me, room})` |
| Unhide room | `hidden_rooms.delete(hiddenRowId)` |
| Latest page | `GET /api/chat/rooms/{r}/messages?kind=latest` with `expand` and `fields: MSG_FIELDS`. The server writes the filter (`lib/lists.js`), newest first |
| Older page (scroll up) | `kind=older&created={c}&id={i}`, the oldest loaded message as the cursor: `room = {:r} && (created < {:c} \|\| (created = {:c} && id < {:i}))` |
| Newer page (scroll down after jumping back) | `kind=newer&created={c}&id={i}`: `(created > {:c} \|\| (created = {:c} && id > {:i}))`, oldest first |
| One message (open `/r/:id/m/:msgId`) | `messages.getOne(id, {expand: "author", fields: MSG_FIELDS})`, then an older and a newer page around it |
| First page ("jump to beginning") | `kind=first`, oldest first. Also `kind=changed` (the edits and deletes missed offline) and `files=1` (the viewer's pages) |
| Send | `messages.create({id, room, author: me, text}, {expand: "author"})` |
| Edit | `messages.update(id, {text}, {expand: "author"})` |
| Delete (soft) | `messages.update(id, {deleted: true})` → the response has `text: ""`, `deleted: true` |
| Live room | `messages.subscribe("*", cb, {filter: pb.filter("room = {:r}", {r}), expand: "author", fields: MSG_FIELDS})` handles `create` and `update` (edits and soft deletes). A `delete` event only happens if a superuser hard-deletes a record, and it is handled by removing the message. |
| Live room list | `rooms.subscribe("*", cb)` (new rooms, renames, archive) + `hidden_rooms.subscribe("*", cb)` (keeps hide state in sync across tabs) |

`MSG_FIELDS = "id,room,text,created,updated,edited_at,deleted,author,expand.author.id,expand.author.name"`. Fetching only these fields keeps payloads small and never pulls user emails.

Pagination always uses **keyset cursors** on `(created, id)`, never page numbers, and passes `skipTotal: true`. Every page is a single index range scan, so it costs the same whether the room has 100 messages or 10 million. New inserts never shift page boundaries.

Filters are always built with `pb.filter()` and never by string concatenation, which prevents filter injection. Since
2026-10-29 the pages, search (§29), the room list and the app's notification check (ANDROID.md §21) are routes, so the
server can change its schema under them (docs/API.md). The clients still write a few filters on fields that won't move:
`id` (users by id), `room` (read positions, the live room), `collection` and `owner` (collections).

## 7. Frontend design

### 7.1 Screens and routes (paths)

| Route | View | Notes |
|---|---|---|
| `/login`, `/signup` | login / signup (tabbed form) | guests only (§23.3); `/me` redirects here without a session. Until §23 every route did. |
| `/` | room list + "new room" form, with a greeting where a room would be | on narrow screens only the room list shows |
| `/r/:roomId` | room: message list + composer | on wide screens the room list stays visible as a sidebar |
| `/r/:roomId/m/:msgId` | room, opened at a specific message (window centered on it) | used by "jump to beginning" and shareable later |

**The room list** (the sidebar, 2026-10-31 redesign) has the brand and a Jump to field (§32) at the top, then Rooms,
Direct messages and Collections, then one folded **Hidden & archived** section, and at the foot the user (avatar and
name, linking to the profile) with a Settings button (a guest gets Log in and Sign up there instead):

1. **Rooms:** active rooms that aren't hidden, sorted by name, those with unread messages first.
2. **Hidden & archived:** collapsed by default and shown with how many rooms it holds (or "Nothing hidden or
   archived"). Inside, a **Hidden** part, each row with an "Unhide" button, and an **Archived** part (read-only rooms,
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

### 7.2 View contract

```ts
interface View {
  mount(root: HTMLElement, params: Record<string, string>): void;
  unmount(): void; // remove listeners, unsubscribe realtime, abort fetches
  update?(params: Record<string, string>): void; // optional: take new params without a remount
}
```

Each view owns a `Scope` (`scope.ts`): an `AbortSignal` that every `addEventListener` call receives, plus `defer()`/`sub()` for store listeners and realtime subscriptions, so `unmount()` is `scope.dispose()`. After every `await`, async work checks `scope.active`. Views are single-use: the router and the sidebar layout create a fresh one for every mount. Both room menus (row and header) are `ui/menu.ts`, a `<details>` disclosure with an optional inline confirm step. It owns its focus handling.

Logged-in views receive the part of `Ctx` (`context.ts`) they use (a `Pick`, e.g. `RoomCtx`): `api`, `store`, `sync`, `actions`, `navigate` and the other services. They render from the store and change data through `actions` (`actions.ts`: create, hide, unhide, archive). Only the room view subscribes to anything itself, and only to its own room's messages.

### 7.3 DOM helpers (`dom.ts`)

```ts
h("div", {class: "msg", dataset: {id}}, [h("b", {}, name), text]) // returns HTMLElement
```

- Children that are strings become **text nodes**. There is no `innerHTML` anywhere in the codebase, and a lint check enforces this (§9.5). This is the main defense against XSS.
- No reactivity system. Views update the DOM directly in response to store events.

### 7.4 State (`store.ts`)

This is a typed event emitter around a plain object: `{ user, rooms: Map, hidden: Map<roomId, hiddenRowId>, roomsStatus, activeRoomId }`. Updates such as `upsertRoom(r)` and `markHidden(roomId, rowId)` live next to the store and replace maps rather than mutating them. `sync.ts` owns `rooms`, `hidden` and `roomsStatus` while someone is logged in: it loads both lists, holds the only `rooms` and `hidden_rooms` subscriptions, and reloads after each reconnect. A reload's answer is older than whatever changed in the store while it was out (live events, and what this tab did itself: a room created, a DM opened, a room hidden or shown, which may have no event yet), so while a reload is out, `sync.ts` notes every room (and every hidden row) that changes in the store, and its answer takes those from the store as it is then, or leaves them out if gone (QA BUG-69, BUG-107). The selector `roomSections(state)` splits rooms into Rooms, Hidden and Archived. It is a pure function and is unit-tested. Message lists are **not** kept in global state. Each room view owns its own `MessageList` model (§7.5) and throws it away on unmount, which keeps memory bounded. Only each room's latest page outlives it, in IndexedDB (§7.5, room cache).

### 7.5 Message list (hot path)

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

### 7.6 Composer

- `<textarea>` that grows automatically up to 6 lines. **Enter** sends and **Shift+Enter** inserts a newline.
- The send button is disabled when the trimmed text is empty or over 2000 characters. A counter appears after 1800 characters.
- Input is kept on failure, so nothing the user typed is lost.
- Message text is rendered with `white-space: pre-wrap`. No markdown in the MVP.
- **Up arrow** in an empty composer starts editing the user's most recent message in the current window. Deleted messages are skipped.

### 7.6.1 Editing messages

- **Starting an edit:** hovering your own message (or long-pressing it on touch screens) shows **Edit** and **Delete**. The Up-arrow shortcut also starts an edit (§7.6).
- **Edit mode:** the message text is replaced in place by a textarea pre-filled with the current text. **Enter** saves, **Esc** cancels, and Shift+Enter inserts a newline. Saving unchanged text is a no-op and makes no request.
- **Optimistic save:** the new text shows immediately. If the save fails, the old text comes back and an inline error appears with a Retry option.
- **"(edited)" label:** shown after the time when `edited_at` is set. Its tooltip gives the edit time.
- **Edits by others:** these arrive as realtime `update` events and replace the message text in place. The scroll position stays anchored. At the live bottom (no newer page, within 80px of the end) the list stays at the bottom instead: a message changed in place, by anyone (an edit, a reaction, its link previews, §28), may have grown, and anchored it would slide under the composer (QA BUG-109).
- **Archived rooms:** Edit and Delete are hidden, and the server rejects them anyway.
- **No edit time limit** in the MVP. Earlier versions of a message are not stored.

### 7.6.2 Deleting messages

- **Delete** asks for an inline confirm: the row shows "Delete this message? **Delete** / Cancel", since browser `confirm()` isn't used.
- **Optimistic delete:** the message is swapped for the placeholder right away. If the request fails, the original text comes back with an inline error.
- **Placeholder:** the author name and time stay. The body shows *"Message deleted"* in muted italics, with no actions and no "(edited)" label. It takes part in author grouping like any other message.
- **Pending or failed sends** (never stored on the server) are simply removed from the list. They don't leave a placeholder.
- **Deletes by others** arrive as realtime `update` events and swap in the placeholder in place. The scroll position stays anchored.

### 7.6.3 Links in messages

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
- Under the message, a line per link with its favicon and title (§28).
- Only message bodies: reply quotes are buttons (a link can't go in one), and the edit box shows the raw text.

### 7.7 Performance budget (enforced in CI, §9.4)

| Asset | Budget (gzipped) |
|---|---|
| `app.js` (including the PocketBase client) | **≤ 49.10 KB** (25 KB for the MVP; raised for §15–§17, §19, §22, §23, §24, video attachments, the QA pass 8 and 9 fixes, bigger attachments, audio attachments, §27, the room cache and its prefetching, opening at the first unread message, the QA pass 11 fixes, service messages, the room cache without waiting for the network, the QA pass 12 fixes, prefetching rooms not yet kept, the QA pass 13 fixes, thumbnail caching, the QA pass 14 fixes, Ctrl+Up/Down to pick the reply, link previews, the room access dialog fix, who can post, message search, message permalinks, the media grid, the QA pass 16 fixes, video posters in the room, the QA pass 17 fixes, media collections, Jump to, Appearance, the room in the tab title, the QA pass 19 fixes, live collection badges, the security audit fixes, the room kept as the page goes, the prefetch herd fix, the QA pass 23 fixes, live replies quoted by the room, the 2026-10-31 redesign, see §13) |
| `app.css` | **≤ 10.60 KB** (5 KB until §21, 5.5 KB until §23, 6 KB until audio attachments, 6.05 KB until §18.5, 6.10 KB until §28, 6.15 KB until the room access dialog fix, 6.20 KB until §29, 6.35 KB until message permalinks, 6.40 KB until §31, 6.85 KB until Jump to and Appearance, 7.10 KB until the QA pass 23 fixes, 7.15 KB until the 2026-10-31 redesign and Inter's `@font-face` rules, see §13) |
| `index.html` | ≤ 1.5 KB |
| Image viewer (§17.7), loaded on first use | ≤ 4 KB script, ≤ 1.5 KB stylesheet |
| Message search (§29), loaded on first use | ≤ 2 KB script (its styles are in `app.css`) |
| Room access dialog (§23.2, §33.10), loaded on first use | ≤ 3 KB script (its styles are in `app.css`); moved out of `app.js` for linked instances |
| Media grid (§30), loaded on first use | ≤ 3 KB script, ≤ 1 KB stylesheet |
| Media collections (§31), loaded on first use | ≤ 6.65 KB script, ≤ 1.5 KB stylesheet |
| Notifications (§34), loaded once turned on, or with the profile page | ≤ 3 KB script (its styles are in `app.css`) |
| Web fonts | **Inter**, self-hosted (`web/fonts/`, OFL): one variable woff2 per script (latin 47 KB, latin-ext, cyrillic, cyrillic-ext, greek), each fetched only when a page uses its characters (`unicode-range`), `font-display: swap`, cached for a year under a hashed name. Until 2026-10-31: none |
| Requests on first load | 3 (html, js, css) + API, then Inter's latin file (a second only for other scripts), off the critical path (text shows in the system font until it arrives); the manifest, its icons and `sw.js` (§27) come after, off the critical path |

Other rules:

- `<script type="module" defer>` in the `<head>` and `<link rel="stylesheet">`. No render-blocking third-party code.
- An inline app shell in `index.html` paints before the JS runs.
- The latest-messages fetch and the SSE subscribe start in parallel.
- `Intl.DateTimeFormat` instances are created once and cached.
- A feature most visits never use can be a lazy chunk (`import()`, esbuild code splitting) with its own budget, like
  the image viewer (§17.7). A lazy module must not import a module `app.js` uses: esbuild would move it into a shared
  chunk that `app.js` loads on every visit (a fourth request). The build fails if `app.js` imports any chunk; such a
  module gets what it needs from `app.js` as arguments.

### 7.8 Styling

- One plain CSS file with custom properties for theming (`web/styles/app/tokens.css`). The look (2026-10-31, from
  the "Chirkle Sidebar Redesign" design, its boards in `docs/design-frames/`): a dark grape surface by default (pane `#1a1724`, sidebar `#15121e`, raised
  `#221e2f`), accent text `#b9a6ff` on a `#6d4aff` fill, pink `#f9a8d4` for the NEW line; 10 px radius for controls,
  16 px for dialogs over a dimmed page; Inter, self-hosted (§7.7), with the system font stack behind it.
- Icons are one-color SVGs used as CSS masks (`web/styles/app/icons.css`): an element with `ic i-<name>` draws the
  icon as its `::before` in `currentColor`. Icon-only buttons carry an `aria-label`. No emoji in the chrome.
- The room is flat: messages without bubbles (36 px avatar, name and time on one line), a message to me as a tinted
  card with an accent edge, the message tools as a small icon toolbar on hover, the composer as a 68 px strip
  (attach menu, field, emoji, send) that a reply strip, the selection bar or a "why you can't post" notice replaces.
- `prefers-color-scheme` light and dark themes. The profile page's Appearance switch (Auto, Light, Dark) overrides it on
  this device: kept in localStorage (`chat.theme`), not the account, and set as `<html data-theme>` by an inline script
  in `index.html` before the first paint (allowed by its CSP hash, §5.6), so a reload never flashes the other theme.
- Mobile-first layout using flexbox and grid. The sidebar collapses below 720 px.
- Accessibility basics:
  - Semantic HTML (`<main>`, `<nav>`, `<form>`, `<ol>` for messages).
  - The message list has `aria-live="polite"`.
  - Visible focus rings and full keyboard operability.
  - Color contrast of at least 4.5:1.

## 8. Build and dev tooling

### 8.1 Dependencies

| Package | Kind | Purpose |
|---|---|---|
| `pocketbase` | dev | JS SDK, only for tests (admin and raw-API clients); the app uses `web/src/pb.ts` |
| `esbuild` | dev | bundling and minification |
| `typescript` | dev | type checking only (`tsc --noEmit`) |
| `vitest`, `happy-dom` | dev | unit, component and integration tests |
| `@playwright/test` | dev | e2e tests |

Nothing else. The PocketBase **binary** is not an npm package. `scripts/fetch-pocketbase.sh` downloads the pinned version for the current OS and architecture into `bin/` and checks its SHA-256.

### 8.2 `scripts/build.mjs`

```js
await esbuild.build({
  entryPoints: { app: "web/src/main.ts", "app.css": "web/styles/app.css" },
  bundle: true, minify: true, sourcemap: "linked",
  format: "esm", target: "es2022",
  entryNames: "assets/[name]-[hash]", outdir: "pb_public",
  metafile: true, legalComments: "none",
});
// (plus code splitting for lazy chunks, and web/styles/viewer.css built first: its hashed name is defined
//  into the app's build as VIEWER_CSS, §17.7 — see scripts/lib/build-utils.mjs)
// then: read metafile → rewrite web/index.html with hashed names → pb_public/index.html
// then: exit 1 if app.js imports a shared chunk (§7.7)
// then: print gzipped sizes; exit 1 if over budget (§7.7)
```

### 8.3 npm scripts

| Script | Does |
|---|---|
| `setup` | `scripts/fetch-pocketbase.sh` |
| `dev` | esbuild in watch mode (unminified, inline sourcemaps) writing to `pb_public/`, plus `bin/pocketbase serve --dev`. Reload the browser by hand (live reload is not part of the MVP). |
| `build` | production build (§8.2) |
| `typecheck` | `tsc --noEmit` (`strict`, `noUncheckedIndexedAccess`) |
| `test` | unit tests |
| `test:int` | integration tests |
| `test:e2e` | build, then run Playwright |
| `check` | typecheck + test + test:int + build (what CI runs before e2e) |

## 9. Testing strategy

| Layer | Tool | What it covers | Speed |
|---|---|---|---|
| Unit | Vitest + happy-dom, no server | pure logic, DOM helpers, shared vectors, the build | ~10 s |
| Component | Vitest + happy-dom + real PocketBase (temp dir) | views, the room controller and the services against the real API | ~80 s |
| Integration | Vitest + real PocketBase (temp dir) | migrations, API rules, hooks, realtime, `createApi` | ~40 s (serial) |
| E2E | Playwright (Chromium; Firefox and WebKit in CI) | golden user flows through the real built app | ~30 s |
| Budget | build script | bundle size limits | in `build` |

### 9.1 Unit and component tests (`tests/unit/`, `tests/component/`)

Unit tests need no server (`npm run test:unit`). Component tests, which do, run against a real, throwaway PocketBase (temp data dir) using the real `createApi`. There is no fake backend to drift from the server. Failures, latency and reconnects are injected with `vi.spyOn` wrappers over the real client (`tests/support/api.ts`). Large histories are seeded straight into the test DB.

**`lib/messages.test.ts`**
- `merge` keeps the list sorted by `(created, id)`, including for out-of-order input and for messages with the same `created` value.
- `merge` dedupes by id, and the incoming (server) version replaces the `pending` one.
- `merge` keeps the newer `updated` version, so an edit wins over a stale copy.
- `merge` of an older page prepends correctly. Merging an empty page is a no-op.
- `trim("bottom", 300)` on 350 items drops the newest 50 and sets `hasNewer`. `trim("top")` mirrors this and sets `hasOlder`.
- `remove` of an unknown id is a no-op.
- `group` splits on author change and on a gap of more than 5 minutes, and does not split at exactly 5:00.
- Cursor builder: produces the correct `(created, id)` filter strings for older and newer pages, built with `pb.filter` parameters.

**`store.test.ts`**
- `roomSections`: hidden rooms go to Hidden, archived rooms go to Archived (even when also hidden), and the rest go to Rooms, sorted by name; rooms and DMs with unread messages come first.

**`lib/id.test.ts`**
- Ids are 15 chars and match `/^[a-z0-9]{15}$/`.
- 10,000 generated ids contain no collisions.

**`lib/time.test.ts`**
- Shows "today" vs. a date label.
- Uses a fixed timezone through `TZ`.

**`dom.test.ts`**
- `h()` sets attributes, dataset and children.
- **A string child containing `<img src=x onerror=…>` becomes a text node and creates no element.**

**`router.test.ts`**
- Matches routes and extracts params.
- Unknown paths redirect to `/`.
- Unauthenticated access redirects to `/login`.
- `unmount` of the previous view is called before the next view's `mount`.
- A trailing slash is the same page.
- An image viewer history entry with no viewer open (§17.7), or a media grid entry with no grid open (§30), is passed over
  with `history.back()`, on start and on `popstate`; not the grid's entry while the grid is open (QA BUG-118).

**`views/room/*.test.ts`** (real PocketBase; one file per feature, sharing `views/room/harness.ts`)
- Initial render shows 50 messages, oldest at the top.
- Optimistic send shows a pending message straight away. The server ack clears the pending state, and a later realtime echo does **not** duplicate it.
- When send fails, the message shows as failed with a Retry button. Retry calls `create` again with the **same id**.
- An incoming realtime message while scrolled up shows the "new messages" pill and does not auto-scroll.
- **Deleting:**
  - Delete → confirm calls `update(id, {deleted: true})`, and the message becomes a placeholder showing the author, the time and "Message deleted".
  - Cancel makes no request.
  - On failure the original text is restored.
  - A realtime `update` with `deleted: true` from another user swaps in the placeholder.
  - Placeholders have no Edit or Delete actions.
  - Deleting a failed or pending send removes it from the list without a request.
- A realtime `delete` event (superuser hard delete) removes the element.
- `unmount()` calls unsubscribe and aborts pending requests, and no listeners remain.
- Composer: Enter sends, Shift+Enter adds a newline, and whitespace-only or over-length text is blocked.
- **Windowing**, with 1,000 seeded messages:
  - Repeatedly triggering the top sentinel eventually reaches message #1 and shows "Beginning of #room".
  - The DOM never holds more than 300 messages.
  - No message is duplicated or skipped across the whole scroll.
- Scrolled into history (`hasNewer`): a realtime `create` is **not** appended, and the "Jump to latest" pill appears. Clicking it resets the window to the latest page.
- "Jump to beginning" loads the first page and hides the top sentinel.
- A stale page response that arrives after a jump is discarded.
- **Editing:**
  - Edit shows a prefilled textarea. Enter calls `update`, and the "(edited)" label appears once the server responds.
  - Esc restores the original text with no request.
  - On a failed save the old text is restored and an error is shown.
  - Up arrow in an empty composer edits the user's last own message.
  - Edit and Delete are not shown on other users' messages.
- **Archived room:** the banner is shown, there is no composer, and there are no Edit or Delete actions.

**`views/rooms.test.ts`** (real PocketBase)
- The three sections render. Hide moves a room to Hidden (calling `hidden_rooms.create`) and Unhide moves it back.
- The Archive action is visible only to the creator and needs a confirm.
- A realtime room `update` with `archived: true` moves the room to Archived.

**`views/login.test.ts`**
- Validation errors from the server are shown.
- Successful login navigates to `/`.

### 9.2 Integration tests (`tests/integration/`)

A Vitest `globalSetup` does the following:

1. Creates a temp dir.
2. Runs `bin/pocketbase superuser upsert` and `bin/pocketbase serve --http 127.0.0.1:<free port> --dir <tmp>/pb_data --migrationsDir pb_migrations --hooksDir pb_hooks`.
3. Waits for `/api/health`.
4. Provides the URL to the tests, and kills the process and removes the dir on teardown.

Each test file creates fresh users through a helper, so tests don't depend on each other's data.

**Schema and migrations**
- All three collections exist with the expected fields and indexes.
- Migrations apply cleanly to an empty DB, and running them a second time is a no-op.

**Auth and rules: `messages`**
- An anonymous user cannot list, view or create messages (403 or an empty list).
- User A can create a message with `author = A`.
- User A **cannot** create a message with `author = B` (400 or 403).
- User B cannot delete or update A's message. User A can edit and delete their own.
- **Soft delete:**
  - `update({deleted: true})` returns `deleted: true`, `text: ""` and `deleted_at` set.
  - The record still appears in list results, so pagination stays continuous.
  - A raw DB read confirms the old text is gone.
  - Sending `{deleted: true, text: "x"}` still results in empty text.
  - A deleted message rejects further edits and `{deleted: false}` (undelete).
  - A client cannot set `deleted_at` directly or create a message already deleted.
  - The `DELETE` endpoint is rejected for every user, including the author.
  - Deleting does not set `edited_at`.
  - A subscriber receives the soft delete as an `update` event.
- Editing text sets `edited_at`. An update with unchanged text leaves `edited_at` empty. A client cannot set `edited_at` directly.
- User A cannot move a message to another room or change its author by update.
- Text over 2000 chars, or whitespace-only text, is rejected (hook plus field rule), both on create and on edit.
- A client-supplied id is accepted. Reusing an existing id is rejected, which is what makes Retry safe.

**Auth and rules: `rooms` and archiving**
- Any authenticated user can create a room. Creating a room with `created_by` set to someone else, or created already archived, is rejected.
- A duplicate room name, including one that differs only in case, is rejected. This includes the name of an archived room.
- Only the creator can rename, archive or unarchive a room. Archiving sets `archived_at`, and unarchiving clears it.
- The `DELETE` endpoint on rooms is rejected for every user, including the creator.
- An archived room cannot be renamed into another room's name, and a new room cannot take an archived room's name. Names are never reused.
- In an archived room, message create, edit and delete are all rejected, including for the room creator. List and view still work. After unarchiving, posting works again.

**Auth and rules: `hidden_rooms` and `users`**
- User A can hide a room for themselves. Hiding a room for user B (`user = B`) is rejected.
- Hiding the same room twice is rejected by the unique index.
- User B listing `hidden_rooms` never sees A's rows.
- A can unhide (delete) their own row, and B cannot delete A's row.
- Signing up works without email verification, and the new user can post immediately.
- Listing users as an authenticated user never returns other users' `email`.

**History and pagination**
- Seed 1,000 messages in one room, including several that share the same `created` value.
- Walking the room with older-page cursors from the latest page returns all 1,000 exactly once, in order, ending at the very first message.
- Walking the room with newer-page cursors from the first page gives the same result.
- `EXPLAIN QUERY PLAN` for the cursor query uses `idx_messages_room_created` and does not scan the whole table.

**Realtime**
- B subscribes to room R1 with a filter. When A posts in R1, B receives a `create` event with `expand.author.name`. When A posts in R2, B receives **nothing** within 500 ms.
- An anonymous subscriber receives no message events.
- A delete produces a `delete` event for subscribers.

**Hooks and headers**
- `GET /` returns the CSP and `nosniff` headers.
- `/assets/app-*.js` returns `immutable` cache headers, and `index.html` returns `no-cache`.
- A missing `/assets/` file is a 404 with `no-store`, an unknown `/api/` path a JSON 404; app pages still get `index.html`.
- Rate limit: the 11th message within 5 seconds returns 429.

### 9.3 End-to-end tests (`tests/e2e/`)

Playwright's `webServer` starts the built app on a fresh PocketBase with a temp data dir (the same helper as §9.2).

1. **Signup to first message:** sign up, see the empty room list, create "general", send "hello", and see it rendered with the user's name.
2. **Realtime between two users:** two browser contexts, A and B, are in the same room. A sends a message and B sees it within 1 second without reloading. B deletes their own message, and A sees it turn into a "Message deleted" placeholder that keeps B's name and the time. After a reload the placeholder is still there.
3. **Full history:**
   - Seed 2,000 messages through the API. The newest 50 are shown.
   - Scrolling up keeps loading without the view jumping, until "Beginning of #room" and message #1 are visible.
   - The DOM stays at or below 300 messages throughout.
   - Scrolling back down reaches the live edge, and a message B sends then appears live.
   - "Jump to beginning" in the menu shows message #1 directly.
4. **Edit message:** A edits their message and B sees the new text plus "(edited)" live. Up arrow in an empty composer opens the last message for editing.
5. **Hide and unhide:** A hides "random". It disappears from A's list and appears under Hidden, while B's list is unaffected. Opening it by URL still works. Unhide restores it.
6. **Archive:**
   - The creator archives the room. Both A and B see it move to Archived, and the composer is replaced with the read-only banner.
   - History can still be scrolled to the beginning.
   - A user who is not the creator sees no Archive action.
   - Unarchive brings the composer back.
7. **Session persistence:** reloading the page keeps the user logged in. Logging out redirects to `/login`, and going back does not show room content.
8. **Reconnect gap fill:** take B offline with `context.setOffline(true)`, have A send 80 messages (more than one page), bring B back online, and all 80 appear in order.
9. **XSS smoke test:** sending `<img src=x onerror=window.__pwned=1>` renders as literal text and `window.__pwned` stays undefined. The same holds after editing.
10. **Mobile viewport (390×844):** the room list collapses, the composer is visible above the keyboard area, and sending works.

### 9.4 Non-functional checks

- **Bundle budget:** the build fails if the limits in §7.7 are exceeded.
- **Accessibility:** run `@axe-core/playwright` on the login, rooms and room screens, with zero serious or critical violations (this adds a dev dependency only).
- **Performance smoke test (optional in CI):** Playwright with 4× CPU throttling. The time from navigating to `/r/:id` until the first message is visible should be under 1.5 s on a local server.

### 9.5 Static checks

- `tsc --noEmit` in strict mode.
- A grep check in CI fails if `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` appear in `web/src`.

### 9.6 CI (GitHub Actions)

The CI job:

1. `npm ci`
2. `npm run setup` (cached by PocketBase version)
3. `npm run check`
4. `npx playwright install --with-deps`
5. `npm run test:e2e`

Playwright traces are uploaded when a test fails. The job runs on every push and pull request.

## 10. Security considerations

| Threat | Mitigation |
|---|---|
| XSS through message, room or user names | Rendered with text nodes only. No `innerHTML` (enforced in CI). Strict CSP with no inline scripts. |
| Impersonation (posting as someone else) | `@request.body.author = @request.auth.id` create rule. Author can't change on update. Covered by integration tests. |
| Deleted content lingering | Soft delete wipes `text` on the server inside the same update. Only the placeholder metadata (author, time) remains, and an integration test checks the DB row directly. |
| Filter injection | `pb.filter()` with bound params everywhere. |
| Email harvesting | `emailVisibility = false`, and `fields` requests never include email. |
| Spam and flooding | PocketBase rate limits, the 2000-char cap, and signup rate limiting. The limits are per client IP: behind a reverse proxy, `TRUSTED_PROXY=X-Forwarded-For` (applied on start by `trustProxy` in `http.js`, set in the Docker image) makes them per client rather than one for everyone; the rightmost address is used, so clients can't choose theirs. |
| Server-side request forgery (link previews) | The previews worker fetches only http(s) on default ports from public hosts (§28.1): no local names, private IPv4, IPv6 literals or userinfo. Names are looked up first and refused when any address is private; curl connects only to the address checked. Redirects are checked the same way, one by one. Only the start of a response is read (256 KB, 16 KB for icons), so a huge one can't fill memory. `LINK_PREVIEWS=off` turns it off. |
| Untrusted video files (video posters) | ffmpeg reads uploads to make posters (§30.1): only the local file, the container's own demuxer (no playlists, no other protocols), one thread, 20 s at most, not as root. `FFMPEG=off` turns it off. |
| Filling the disk | Uploads are capped per file, per message and by the message rate limit; forwards copy nothing (§21.3). |
| Token theft | The token is stored in `localStorage` by the client (`pb.ts`). The CSP greatly lowers XSS risk. Moving to HttpOnly cookies is noted as future work. |
| Admin UI exposure | Strong superuser password. In production, optionally restrict `/_/` by IP using a hook. |

## 11. Deployment

Deployment artifacts are `bin/pocketbase`, `pb_public/`, `pb_migrations/` and `pb_hooks/`.

- Run under systemd with `pocketbase serve chat.example.com`, which issues a Let's Encrypt certificate automatically. Alternatively, run it behind an existing reverse proxy.
- Migrations run automatically on start.
- Use PocketBase's built-in scheduled backups (Settings → Backups), stored locally or in S3-compatible storage.
- Uploaded files (avatars, attachments; §15, §17) live in `pb_data/storage` (or S3-compatible storage set in PocketBase's settings) and are included in backups, so plan disk space for them.
- Scale target for the MVP: a single node. SQLite in WAL mode easily handles thousands of concurrent SSE clients and hundreds of messages per second at this size.

## 12. Milestones

| # | Deliverable | Done when |
|---|---|---|
| M1 | Skeleton: repo layout, fetch script, esbuild build and dev scripts, empty app served by PB | `npm run dev` serves "hello" and `npm run build` passes the budget |
| M2 | Schema, rules and hooks, plus the integration test suite | all §9.2 tests green |
| M3 | Auth screens, router, store, DOM helpers, with unit tests | log in and out works and unit tests are green |
| M4 | Rooms list: create, hide/unhide, archive/unarchive, realtime room list | §9.1 rooms tests green |
| M5 | Room view: windowed history to the beginning, realtime, optimistic send, edit, soft delete with placeholder, archived read-only mode | §9.1 room tests green |
| M6 | Polish: styles, dark mode, mobile, accessibility, CSP and cache headers | axe clean |
| M7 | E2E suite, CI pipeline, deploy notes | CI green on main |

## 13. Decisions and open questions

### Decided (2026-10-10)

| Topic | Decision |
|---|---|
| Room creation | Any logged-in user can create a room. |
| Unwanted rooms | Each user can hide rooms for themselves only (§5.4). |
| Hidden rooms and new activity | A hidden room stays completely silent: no badge, no count, no notification. |
| Email verification | Not required. |
| Message editing | Authors can edit their own messages, with no time limit. Edited messages show "(edited)". |
| Message deletion | Soft delete. The text is wiped on the server, and a "Message deleted" placeholder keeps the author and time. Deletion is final, with no undelete. |
| Room deletion | Rooms are archived, not deleted. Archived rooms are read-only and keep their full history. |
| Who can archive | Only the room creator can archive or unarchive. |
| Archived room names | The name stays reserved forever and is never reused (unique index covers archived rooms). |
| Retention | History is kept forever. Every room can be scrolled back to its first message (§7.5). |

### Decided (2026-10-10, post-MVP features)

| Topic | Decision |
|---|---|
| Build order | Avatars (§15), then direct messages (§16), then attachments (§17). Each ships on its own. Attachments come last because they must respect DM privacy. |
| DM model | A DM is a `rooms` record with `kind = "dm"` and exactly two `members`, so the message list, windowing, realtime, edit and delete code is reused unchanged (§16.1). |
| Creating a DM | Only through the get-or-create route `POST /api/chat/dms`, never through the `rooms` API (§16.2). |
| Who can DM whom | Any logged-in user can DM any other user. No blocking in this round. No DMs with yourself. |
| Closing a DM | Reuses `hidden_rooms`. A new message in the DM reopens it for the recipient (§16.4). |
| Avatar storage | The built-in `users.avatar` file field: public, raster images only (no SVG), always displayed through thumbnails (§15.1). |
| Attachment access | `protected` file field: downloads need a short-lived file token and pass the message's view rule, so DM files stay private (§17.3). |
| Attachment layout | Images render at a fixed height, so loading them never moves the scroll position (§17.5). |
| Attachment aspect ratio | Images keep their aspect ratio, uncropped: fixed height, width from the image, capped (a too-wide image is narrowed and letterboxed in its fixed-height box rather than shortened, §17.5). |
| Metadata stripping | The client re-encodes JPEG/PNG/WebP images (PNG as PNG, the rest as JPEG) before upload, which drops EXIF (including GPS). Best effort, protecting honest users only (§15.3). |
| Bundle budget | `app.js` budget raised from 25 KB to 30 KB gzipped (§7.7): avatars + DMs measured 25.9 KB. One bundle, no lazy chunks. |
| Bundle budget (replies) | `app.js` budget raised from 30 KB to 32 KB gzipped (§7.7): replies (§19) took it to 30.8 KB. |

### Decided (2026-10-11, unread counts)

| Topic | Decision |
|---|---|
| Which rooms | Every room in the Rooms and Direct messages sections. Hidden and archived rooms still show nothing (§13 above), and neither does the room you are in. |
| What the badge shows | A count, shown as `99+` past 99. Your own messages and deleted messages never count. |
| Where read state lives | On the server (`room_reads`, §18.1), so it follows you across tabs and devices. |
| When a room is read | As far as the room view shows it, in a visible tab (§18.3): up to the newest message on screen whole, all of it once scrolled to the bottom. Opening a room with unread messages reads only those on screen; the rest are read as you scroll down to them (2026-10-24, user: "it shouldn't mark all messages as read. only visible"). Scrolled up, new messages stay unread until you scroll down to them. |
| Before you joined | Messages older than your account never count, so a new user doesn't start with 99+ everywhere. |

### Decided (2026-10-11, bundle size)

| Topic | Decision |
|---|---|
| PocketBase SDK | Replaced in the app by `web/src/pb.ts` (§6): the SDK builds every service in its constructor, so none of its unused code could be tree-shaken. `app.js` went from 31.1 KB to 23.1 KB gzipped; the 32 KB budget (§7.7) is unchanged. Same storage key, so existing sessions survive the switch. |

### Decided (2026-10-11, reactions and emoji)

| Topic | Decision |
|---|---|
| How many | Any number of different emoji per person per message; each one once (clicking it again takes it back). |
| Which emoji | Exactly the picker's set (§20.4, about 600, Emoji 12 and older), checked by the server. This bounds what a message can collect without a per-message cap, and every current system font shows them all. |
| Where they live | On the message (`messages.reactions`, §20.1), not in a collection of their own: they travel with the message through pages, realtime, reconnect refetches and the window's merge logic, with nothing new on the client's read path. |
| Who can react | Anyone who can see the message, on any saved message that isn't deleted, in a room that isn't archived. Your own messages too. |
| Picker | Categories and a "Recent" row (per browser, `localStorage`), no search: names for ~600 emoji would cost about as much again as the emoji themselves. |

### Decided (2026-10-11, selecting, forwarding and deleting several messages)

| Topic | Decision |
|---|---|
| What can be selected | Any saved message that isn't deleted, yours or not; at most 50 at a time (`MAX_SELECTED`). Forwarding works on any of them, archived rooms included; deleting only when every selected message is yours and the room isn't archived (§21.1). |
| One request, all or nothing | Deleting or forwarding several messages is one request to a route that runs in one transaction (§21.2, §21.3), not one request per message: the per-message rate limits would refuse a large selection halfway, and a half-done delete or forward is harder to explain than a failed one. |
| What a forward is | A new message by the forwarder that points at the original (`forward_of`) and shows it as it is now, saying who first wrote it (`forwarded_from`, kept through forwards of forwards). Nothing is copied: copies of the attachments let one account fill the disk (50 messages × 32 MB per request, 20 requests a minute). An edit of the original shows in its forwards and a delete empties them; the view rule lets a forward's readers see that one original, nothing else of its room (§21.3). Replies and reactions are not forwarded. Forwards made before this hold copies. |
| Where to | Any room or DM you can write in, or someone you have no DM with yet (found by name, which opens one). Afterwards the view goes to where the messages went. |
| CSS budget | `app.css` raised from 5 KB to 5.5 KB gzipped (§7.7): §21 took it to 5.15 KB. |

### Decided (2026-10-12, accounts and quality of life)

| Topic | Decision |
|---|---|
| Unique display names | Compared like room names (case, width and invisible characters ignored), backed by a unique index. Accounts that already shared a name keep it; nobody else can take it (§22.1). |
| Changing the password | Needs the current one; signs out every other session. The tab that changed it stays logged in (§22.2). |
| Where Log out is | On the profile page, not in the app bar (§22.2). |
| Drafts | Kept in `localStorage` per user and room, as you type; cleared when the session ends (§22.3). |
| Bundle budget (§22) | `app.js` budget raised from 32 KB to 34 KB gzipped (§7.7): §22 took it to 32.9 KB. |

### Decided (2026-10-12, room access)

| Topic | Decision |
|---|---|
| Levels | Private (members only), Public (signed in; the default) and Open Air (anyone can read, signed-in users post) (§23). Only the creator changes them. |
| Field | A new `visibility` next to `kind`, not more `kind` values: `kind` still says room or DM, which half the rules and the UI branch on. DMs are `private`. |
| Members | `rooms.members`, as for DMs, up to 100. Dropped when a room stops being private, so an old list never comes back by surprise, and guests never see who was in it. |
| Guests | Read Open Air rooms that aren't archived, with authors' names and avatars and attachments; nothing else. The app starts on the guest view, not the login screen. |
| Losing access | Pushed as a realtime `delete` by a rooms hook (PocketBase sends changes only to those who can still see them). |
| Private room names | Still unique among all rooms, as before: creating a room under a private room's name says it is taken. Accepted (the name is all it gives away), like most chat apps. |
| Bundle budget (§23) | `app.js` raised from 34 KB to 37 KB and `app.css` from 5.5 KB to 6 KB gzipped (§7.7): §23 took them to 35.7 KB and 5.7 KB. |

### Decided (2026-10-12, image viewer)

| Topic | Decision |
|---|---|
| Viewer loading | A lazy chunk plus its own stylesheet (§17.7), not an iframe: same savings for `app.js`, without a second document, cross-frame focus handling or relaxing `frame-ancestors`. `app.js` stays within its 37 KB budget (+0.2 KB). |
| Which images | Every image in the room's message window, oldest first, taken when the viewer opens. |

### Decided (2026-10-12, URLs)

| Topic | Decision |
|---|---|
| Paths, not hashes | Pages are paths (`/r/abc`) (§7.1). PocketBase already serves `index.html` for any path that isn't a file, so no server change for pages (a missing asset or an unknown `/api/` path gets a 404 instead, §5.6); anything put in front of it (a proxy or CDN serving `pb_public/` itself) must do the same. Old `#/` links are rewritten to their path, so bookmarks and shared links keep working. `app.js` +0.2 KB. |

### Decided (2026-10-12, site settings)

| Topic | Decision |
|---|---|
| Where | A `site` collection with one record, edited in the PocketBase admin UI: no admin pages in the app. A collection, not PocketBase's own settings, because the logo is a file and the invite code must stay hidden (a hidden field). |
| One code | One shared invite code, not one per person: what was asked for, and changing it is how an admin stops it working. Per-person invites (an `invites` collection, used up on signup) can come later without changing the rest. |
| Closed signups | Invite-only with an empty code closes signups altogether, rather than letting anyone in by mistake. |
| Favicon | Stays the app's speech bubble with its unread badge: the logo is any image, which an SVG favicon can't embed. |
| Bundle budget (§24) | `app.js` raised from 37 KB to 38 KB gzipped (§7.7): §24 took it to 37.6 KB. |
| Bundle budget (videos) | `app.js` raised from 38 KB to 39 KB gzipped (§7.7): video attachments (§17.5) and the viewer paging through the whole room (§17.7) took it to 38.1 KB, after merging the image and video tiles. The paging itself lives in the lazy viewer chunk. |
| Bundle budget (QA pass 8) | `app.js` raised from 39 KB to 39.25 KB gzipped (§7.7): the fixes of QA pass 8 (sends and edits in order, failed sends kept after leaving a room, realtime retrying a failed first connect, …) took it to 39.15 KB. |
| Bundle budget (bigger attachments) | `app.js` raised from 39.35 KB to 39.80 KB gzipped (§7.7): uploads through XHR for their progress bar, the "+N" tile and `no_dms` (§16.7, §17) took it to 39.76 KB. |
| Bundle budget (audio attachments) | `app.js` raised from 39.80 KB to 40.05 KB and `app.css` from 6 KB to 6.05 KB gzipped (§7.7): audio players in messages (§17.5) took them to 40.03 KB and 6.01 KB. |
| Bundle budget (§27) | `app.js` raised from 40.05 KB to 40.10 KB gzipped (§7.7): registering the service worker (§27) took it to 40.06 KB. |
| Bundle budget (room cache) | `app.js` raised from 40.10 KB to 40.60 KB gzipped (§7.7): keeping each room's latest messages in IndexedDB (`cache.ts`, §7.5) took it to 40.57 KB. |
| Bundle budget (prefetching) | `app.js` raised from 40.60 KB to 40.85 KB gzipped (§7.7): fetching the latest page of rooms with unread messages into the room cache (`prefetch.ts`, §7.5) took it to 40.80 KB. |
| Bundle budget (first unread) | `app.js` raised from 40.85 KB to 41.15 KB and `app.css` from 6.05 KB to 6.10 KB gzipped (§7.7): opening a room at its first unread message, with the "New" line (§18.5), took them to 41.09 KB and 6.09 KB. |
| Bundle budget (QA pass 11) | `app.js` raised from 41.15 KB to 41.20 KB gzipped (§7.7): the fixes of QA pass 11 (prefetching paced and never put off, deleted messages refetched into the room cache, a room opened before the unread counts are in still opening at its first unread message) took it to 41.17 KB. |
| Bundle budget (service messages) | `app.js` raised from 41.20 KB to 41.30 KB gzipped (§7.7): service messages (§5.3), drawn as a line of their own, took it to 41.25 KB. |
| Bundle budget (cache without waiting) | `app.js` raised from 41.30 KB to 41.50 KB gzipped (§7.7): showing the room cache without waiting for the network (after a reload, with unread messages) and asking for the latest page beside the first unread message (§7.5, §18.5) took it to 41.46 KB. |
| Bundle budget (QA pass 12) | `app.js` raised from 41.50 KB to 41.65 KB gzipped (§7.7): the room cache fixes of QA pass 12 (BUG-97 to BUG-100) took it to 41.58 KB. |
| Bundle budget (room switching) | `app.js` raised from 41.65 KB to 41.75 KB gzipped (§7.7): prefetching the rooms not kept yet and holding the room cache in memory (§7.5) took it to 41.71 KB. |
| Bundle budget (QA pass 13) | `app.js` raised from 41.75 KB to 41.90 KB gzipped (§7.7): the room cache fixes of QA pass 13 (BUG-101 to BUG-104) took it to 41.87 KB. |
| Bundle budget (thumbnail caching) | `app.js` raised from 41.90 KB to 41.95 KB gzipped (§7.7): deleting the service worker's thumbnail cache when a session ends (§27.2) took it to 41.92 KB. |
| Bundle budget (QA pass 14) | `app.js` raised from 41.95 KB to 42.05 KB gzipped (§7.7): the QA pass 14 fixes (BUG-106, then BUG-107) took it to 42.03 KB. |
| Bundle budget (reply stepping) | `app.js` raised from 42.05 KB to 42.25 KB gzipped (§7.7): Ctrl+Up / Ctrl+Down to move the reply between messages (§19.3) took it to 42.21 KB. |
| Bundle budget (link previews) | `app.js` raised from 42.25 KB to 42.40 KB and `app.css` from 6.10 KB to 6.15 KB gzipped (§7.7): link previews (§28) took them to 42.38 KB and 6.13 KB. |
| Bundle budget (room access dialog) | `app.js` raised from 42.40 KB to 42.55 KB and `app.css` from 6.15 KB to 6.20 KB gzipped (§7.7): the access dialog (§23.2) scrolling its body, search results as toggles, and Telegram stand-ins left out took them to 42.52 KB and 6.18 KB. |
| Bundle budget (who can post) | `app.js` raised from 42.55 KB to 43.25 KB gzipped (§7.7): choosing who can post (§23.6), with a second people list in the access dialog, the reader banner and the checks behind replying, editing and forwarding, took it to 43.21 KB. |
| Bundle budget (message search) | `app.js` raised from 43.25 KB to 43.45 KB and `app.css` from 6.20 KB to 6.35 KB gzipped (§7.7): message search (§29), the header button, loading its chunk and going to a result, and its styles took them to 43.40 KB and 6.32 KB. The search itself is a lazy chunk of 1.58 KB. |
| Bundle budget (media grid) | `app.js` raised from 43.50 KB to 43.60 KB gzipped (§7.7): the media grid (§30) is a lazy chunk with its own stylesheet, but its header button, loading the chunk and opening the viewer from it took `app.js` to 43.59 KB. |
| Bundle budget (QA pass 16) | `app.js` raised from 43.60 KB to 43.65 KB gzipped (§7.7): the fixes for QA BUG-117 (a success whose body never came saved an empty session, `pb.ts`) and BUG-118 (the router passes over a media grid entry with no grid) run before any lazy chunk loads, and took `app.js` to 43.64 KB. |
| Bundle budget (video posters) | `app.js` raised from 43.65 KB to 43.77 KB gzipped (§7.7): a video's tile in the room shows the server's poster (§30.1) and falls back to the video's first frame without one (`api.posterUrl`, `attachments.ts`), 43.76 KB. The room's list is in `app.js`, so it can't go in a lazy chunk. |
| Bundle budget (QA pass 17) | `app.js` raised from 43.77 KB to 43.91 KB gzipped (§7.7): the QA pass 17 fixes (failed sends kept after leaving a room, the viewer following deletes, the reaction picker closing on a deleted message, retrying a failed room load when back online, the avatar type message) took it to 43.90 KB. All of it is in the room view, the controller and the profile, which are in `app.js`. |
| Bundle budget (QA pass 9) | `app.js` raised from 39.25 KB to 39.35 KB gzipped (§7.7): the forwarding fixes of QA pass 9 (messages deleted meanwhile left out, the server's reason shown, focus kept while selecting) took it to 39.30 KB. |

### Decided (2026-10-21, media collections)

| Topic | Decision |
|---|---|
| Saving | Copies the file into the collection (§31.1): it outlives the message (deleted by its author, the saved copy stays), and is seen by the collection's rules, not the room's. |
| Private rooms into public collections | Allowed: saving media from a private room or a DM into a public collection makes it public. The save menu marks the public collections. |
| The badge for your own private collection | Its name (with 🔒) and a link, to you; others see "Private collection", not a link. |
| Buttons | The collections icon alone (named for screen readers) on every collection button: Save to collection, Attach from collections. |
| Bundle budget (media collections) | `app.js` raised from 43.91 KB to 46.05 KB and `app.css` from 6.40 KB to 6.85 KB gzipped (§7.7), the user's call: the sidebar section and its live new counts (`collections.ts`), the badge and Save on the room's tiles, the composer's button and the route took them to 45.96 KB and 6.83 KB. The page, the save menu, the picker, the new-collection dialog and their requests are a lazy chunk (5.05 KB, stylesheet 1.09 KB). |
| Bundle budget (Jump to, Appearance, QA pass 19) | `app.js` raised from 46.05 KB to 47.10 KB, `app.css` from 6.85 KB to 7.10 KB and the collections chunk from 6 KB to 6.65 KB (§7.7), the user's call (2026-10-23): Jump to's shortcut and options (§32, the dialog itself a lazy chunk), the Appearance switch (§7.8), the room in the tab title and the QA pass 19 fixes took them to 47.03 KB and 7.06 KB; the collections chunk was at 6.58 KB. |
| Bundle budget (live collection badges) | `app.js` raised from 47.10 KB to 47.15 KB (§7.7), the user's call (2026-10-23): badges following a collection made public or private, renamed or deleted (`chat/badges`) took it to 47.14 KB. |
| Bundle budget (security audit fixes) | `app.js` raised from 47.15 KB to 47.25 KB (§7.7), the user's call (2026-10-24): the tree was already at about 47.17 KB, and clearing an expired session's leftovers at start (QA BUG-145) and the router's slash fix (QA BUG-146) took it to 47.22 KB. |
| Bundle budget (room kept as the page goes) | `app.js` raised from 47.25 KB to 47.35 KB (§7.7), the user's call (2026-10-28): the `localStorage` fallback for the room kept on `pagehide` (QA BUG-104, which still failed about 1 in 10 under load) took it from 47.18 KB to 47.30 KB. |
| Bundle budget (prefetch herd) | `app.js` raised from 47.35 KB to 47.40 KB (§7.7), the user's call (2026-10-29): fetching a busy unread room at most every 30 s (QA BUG-108) took it from 47.27 KB to 47.38 KB. Without the fetch once the 30 s are up it was still 47.36 KB; a lazy `prefetch.ts` was the other option. |
| Bundle budget (QA pass 23) | `app.js` raised from 47.40 KB to 47.55 KB and `app.css` from 7.10 KB to 7.15 KB (§7.7), the user's call (2026-10-30: "raise budget if needed"): the pass's fixes (initials without a label, a closed DM's banner, the clipped italic quote) took them to 47.52 KB and just over 7.10 KB. |
| Bundle budget (live replies) | `app.js` raised from 47.55 KB to 47.70 KB (§7.7), the user's call (2026-10-30: "raise the budget to 47.70"): live events no longer carry a reply's quote, which the room fills in itself (§19.2, docs/PERF.md §2.3), 47.52 → 47.67 KB. |

### Decided (2026-10-24, linked instances)

| Topic | Decision |
|---|---|
| Who links instances | Admins only, by a one-time invite code (§33.3). No open federation. |
| What is shared | Rooms and DMs only (§33.5). Media collections stay local. |
| Which rooms | Admins of both instances choose each room: one offers, the other accepts (§33.5). Any room, public, private or Open Air. Users can't share rooms; they open DMs, where both admins allowed it. |
| Members of a shared private room | Kept on the home. Its creator manages them and may add people from instances the room is shared with by address. Each mirror's superusers add and remove their own instance's people, sent to the home as a request it checks (§33.5). Users on a mirror can't change members. |
| Design | Each shared room has a home that decides its state, and mirrors that follow it (§33.1); not Matrix. Servers sign requests with a secret per pair (HMAC), since the JSVM has no public-key signing (§33.6). |

### Still open

1. ~~**Unread state for DMs.**~~ Done for every room: §18.
2. **Upload quotas.** Rate limits cap the request rate, not stored bytes. A per-user storage cap (a hook summing file sizes) is deferred until real usage shows the need.

## 14. Future work (post-MVP)

Blocking users, link previews, typing and presence (custom realtime channels via `$app.subscriptionsBroker()`), OAuth2 providers, and HttpOnly cookie auth. Message search (§29) could move to SQLite FTS5 (a custom route) if rooms grow past a few hundred thousand messages. (The service worker: §27.)

---

## Post-MVP features

Sections 15–17 extend the MVP. They follow the same principles: access control lives in API rules (with hooks as
defense in depth), no `innerHTML`, no new runtime dependencies, and the size budget (§7.7) still applies. The
implementation plan (finished) is [`history/NEXT_FEATURES_PLAN.md`](history/NEXT_FEATURES_PLAN.md).

**Shared rules for every uploaded file (§15, §17):**

- **No SVG, no HTML from the upload pipeline into the page.** Images are shown only through PocketBase thumbnails
  (`?thumb=`), which PocketBase re-encodes as raster images. Files are never inlined, fetched as text or parsed.
- **Files are served from `/api/files/…` with a sandbox CSP.** PocketBase already sends
  `Content-Security-Policy: default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox` for files.
  The headers hook (§5.6) adds `X-Content-Type-Options: nosniff` (it already does, for every response), and an
  integration test pins both headers, so an uploaded `.html` can never run script on our origin.
- **The app CSP (§5.6) gains `blob:` in `img-src`,** for previews of files that are not uploaded yet
  (`URL.createObjectURL`). Every object URL is revoked when its message is sent, removed or unmounted.
- **Images keep fixed dimensions in the layout** (`width`/`height` attributes plus CSS), with `loading="lazy"` and
  `decoding="async"`. A late-loading image must never change the height of a message, or scroll anchoring (§7.5)
  breaks.
- **Client-side re-encoding (§15.3)** shrinks and strips metadata before upload; the server limits are the real
  enforcement.
- **At most 25 megapixels per image.** PocketBase decodes a whole image to thumbnail it, so a small, highly
  compressed file declaring huge dimensions would exhaust server memory (QA BUG-24: an 875 KB PNG of 30000×30000 took
  4.6 GB). The avatar and message create hooks read the header of every PNG, JPEG, GIF and WebP upload
  (`pb_hooks/lib/images.js`) and reject larger images, or images whose dimensions can't be found in the first
  256 KB, with `validation_image_too_large`.

## 15. Avatars

### 15.1 Data model

PocketBase's built-in `users` collection already has an `avatar` file field. A migration configures it:

| Setting | Value |
|---|---|
| `maxSelect` | 1 |
| `maxSize` | 2 MB |
| `mimeTypes` | `image/jpeg`, `image/png`, `image/webp`, `image/gif` (**not** `image/svg+xml`) |
| `thumbs` | `48x48`, `96x96` (center crop; 2× for high-DPI screens) |
| `protected` | `false`: avatars are public, and the random filename suffix PocketBase adds keeps them unguessable |

The `users` update rule already limits writes to the owner. Uploading a new file replaces the old one, and
PocketBase deletes the old file from storage. Removing the avatar is `update(id, {avatar: null})`.

### 15.2 API usage

| Action | Call |
|---|---|
| Set avatar | `users.update(me, formData{avatar: File})` |
| Remove avatar | `users.update(me, {avatar: null})` |
| Change display name | `users.update(me, {name})` (the hook already cleans names, §5.6) |
| Avatar URL | `pb.files.getURL(user, user.avatar, {thumb: "48x48"})`, built only in `api.ts` and exposed as `avatarUrl(user, size)` |

`MSG_FIELDS` gains `expand.author.avatar`, and `User` gains `avatar: string` (the filename, `""` when unset). The
logged-in user's own record already contains it.

**Staleness:** messages carry the author's avatar from when they were fetched. A user who changes their avatar is
seen with the new one on the next page load, window move or reconnect. This is accepted. Subscribing to `users`
would push every profile change to every client for little benefit.

### 15.3 Client-side image preparation (`lib/image.ts`)

Before upload, `prepareImage(file, maxEdge)` decodes the image with `createImageBitmap`, scales it so the longest
edge is at most `maxEdge` (512 px for avatars, 2048 px for attachments), and re-encodes it, PNG as PNG (keeps
transparency) and everything else as JPEG, through `OffscreenCanvas.convertToBlob`, falling back to a `<canvas>` element where
`OffscreenCanvas` is missing. Re-encoding drops EXIF, so photos never leak GPS location.

- Not WebP: PocketBase can't write WebP, so a WebP's thumbnails would be PNGs, often bigger than the image itself
  (QA BUG-26). PNG and JPEG are thumbnailed in kind.
- GIFs are uploaded as they are (re-encoding would drop the animation).
- If decoding fails, the original file is uploaded unchanged, and the server limits decide.
- The function is pure apart from the browser image APIs, and unit-testable with a stubbed `createImageBitmap`.

### 15.4 Rendering

- **Fallback:** a user without an avatar gets a circle with their initials. The initials are the first letters of
  the first two words of the name, by grapheme (`Intl.Segmenter`, so emoji and combining marks don't break), leaving
  out a word in brackets (a linked instance's or Telegram's label: "Ann (B)" is "A", QA BUG-176) and punctuation
  before a word. The
  background color is one of 8 palette colors picked by a hash of the user **id**, not the name, so it survives
  renames. Both live in `lib/avatar.ts` and are pure. Every palette color passes 4.5:1 contrast with white text in both themes.
- **Message list:** the avatar (32 px, `48x48` thumb, or `96x96` on high-DPI screens via `srcset`) sits next to
  the author header of each group (§7.5 `group`). Continuation messages get none. The image has `alt=""` because the
  author name is right next to it.
- **App bar:** the user's own avatar (24 px) next to their name. Both open `/me`.
- A failing avatar image (`error` event) swaps itself for the initials circle.
- `messageNode`'s signature cache (§7.5 DOM rendering) includes the avatar filename, so a changed avatar re-renders.

### 15.5 Profile view (`/me`)

A new route and view (`views/profile.ts`): the avatar with **Change** (file picker, also accepts drag-and-drop)
and **Remove**, plus the display name with **Save**.

- Picking a file shows a local preview right away (object URL), then uploads the prepared image. On failure the
  previous avatar comes back with the error text inline.
- Client-side checks mirror the server: type in the allowlist, size ≤ 2 MB after preparation. Limits live in
  `lib/limits.ts` with the others, and `schema.test.ts` checks they match the migration.
- On success the store's `user` is replaced with the response, so the app bar updates.

### 15.6 Tests

- **Integration:** the field settings match §15.1; an SVG or a 3 MB file is rejected; user B cannot change A's
  avatar; the thumb URL returns an image; removing the avatar deletes the file (its old URL returns 404); a message
  list includes `expand.author.avatar` and still no email.
- **Unit:** initials (one word, emoji, combining marks, empty name); color is stable for an id and differs across
  ids; `prepareImage` scaling math and GIF passthrough; profile view upload success, failure rollback and remove;
  the message group header shows the image, and initials on `error`.
- **E2E:** A uploads an avatar on `/me`; B sees it next to A's next message. Axe check on `/me`.

## 16. Direct messages

### 16.1 Data model

A DM is a room. This reuses everything the room view already does (windowing, realtime, optimistic send, edit,
soft delete, reconnect gap-fill) without a second code path. New `rooms` fields:

| Field | Type | Notes |
|---|---|---|
| `kind` | select (`public`, `dm`) | required; existing rooms are backfilled to `public` by the migration |
| `members` | relation → users, `maxSelect` 2 | empty for public rooms; exactly the two participants for a DM (sorted by id) |
| `dm_key` | text, hidden | set by the route (§16.2): the two user ids sorted and joined with `:`. Unique index where `dm_key != ''`, so a pair can only ever have one DM. Being hidden, it is also ignored when a regular user sends it to the API. |
| `last_message_at` | date | DMs only: set by a hook on every message create in the room, used to sort the DM list (§16.5) |

`name` stays required for public rooms only. The schema field becomes optional and the rooms hook enforces it
when `kind = "public"`; for DMs it forces `name = ""` and skips the uniqueness check (`name_key` is `""`, which the
partial unique index already ignores). The MVP's `idx_rooms_name` (case-insensitive unique `name`) becomes partial
(`WHERE name != ''`) for the same reason. A DM's title is computed on the client from the other member's name.

DMs are never archived or renamed, and they have no creator-only actions. `created_by` is set to the user who
opened the DM, for consistency only.

**Why not a separate collection:** `messages.room` would have to become a relation to one of two collections, and
every message query, rule, hook and view would grow a branch. With `kind` + `members`, the only real changes are
the access rules and the sidebar. The same two fields later give private group rooms (more than two members).

### 16.2 Opening a DM: `POST /api/chat/dms`

A custom route in `pb_hooks` (`routerAdd`, behind `$apis.requireAuth("users")`). Body: `{ "user": "<id>" }`.

1. Reject a missing, unknown or own user id (400).
2. Compute `dm_key` from the two sorted ids.
3. If a room with that `dm_key` exists, return it (200).
4. Otherwise create it (`kind: "dm"`, `members: [me, other]`, `created_by: me`) with `$app.save` and return it
   (200). If two requests race, the unique index rejects the second insert; the route catches that and returns the
   room the first one created.
5. Delete the caller's `hidden_rooms` row for that room, if any, so reopening a closed DM brings it back.

The route returns the room in the same shape as the `rooms` API (`ROOM_FIELDS` plus the expanded members), so the
client can `upsertRoom` it directly. It is idempotent; the client still calls it only for a DM it doesn't already
have open in its room list (QA BUG-30), since the route is rate limited: `POST /api/chat/dms` 10 per 60 s per IP.

Creating a DM through the `rooms` API is impossible: the create rule (§16.3) only accepts `kind = "public"`.

### 16.3 API rules

`MEMBER` below means `members.id ?= @request.auth.id`.

| Collection | Rule | New value |
|---|---|---|
| `rooms` | list / view | `@auth && (kind = "public" \|\| MEMBER)` |
| `rooms` | create | MVP rule `&& @request.body.kind = "public" && @request.body.members:isset = false && @request.body.dm_key:isset = false && @request.body.last_message_at:isset = false` |
| `rooms` | update | MVP rule `&& kind = "public" && @request.body.kind:isset = false && @request.body.members:isset = false && @request.body.dm_key:isset = false && @request.body.last_message_at:isset = false` |
| `messages` | list / view | `@auth && (room.kind = "public" \|\| room.members.id ?= @request.auth.id)` |
| `messages` | create | MVP rule `&& (@request.body.room.kind = "public" \|\| @request.body.room.members.id ?= @request.auth.id)` |
| `messages` | update | unchanged: only the author can edit, and the author was a member when they posted. Membership never changes for DMs. |
| `hidden_rooms` | create | MVP rule `&& (@request.body.room.kind = "public" \|\| @request.body.room.members.id ?= @request.auth.id)`: nobody can hide (and so probe) a DM they aren't in |

Because PocketBase applies the list rule to realtime subscriptions, a non-member never receives a DM's room or
message events, even with a `"*"` subscription and no filter.

**Defense in depth (hooks):** `beforeMessageCreate` also checks that a DM's author is a member, in case
`@request.body.room.members` traversal behaves differently in the pinned PocketBase version (like the archived
guard, §5.6). Request-only hooks (`onRecordCreateRequest` / `onRecordUpdateRequest` on `rooms`) reject `kind`,
`members` and `last_message_at` in API writes, including field modifiers such as `members+`. PocketBase 0.40.4's
`:isset` sees those too (checked, QA BUG-150), so the hooks only back the rules up, in case a version stops doing so.
They don't fire for the route's and hooks' own `$app.save`.

**Query cost:** the `messages` list rule adds a join to `rooms` and, for DMs, a `json_each` over two members. The
history query still filters by `room` first, so `idx_messages_room_created` keeps serving it. The pagination
`EXPLAIN QUERY PLAN` test (§9.2) is repeated with the new rule in place.

### 16.4 Closing and reopening

**Close conversation** in a DM's menu creates a `hidden_rooms` row, exactly like hiding a room. Unlike hidden
public rooms, closed DMs are not listed under **Hidden rooms**; they simply leave the list.

A DM must not stay silent once the other person writes again. An after-create hook on `messages` in a DM deletes
the **recipient's** `hidden_rooms` row for that room, if there is one. That delete reaches the recipient's
`hidden_rooms` subscription (§6), so the DM reappears live. The same hook sets the room's `last_message_at`, which
reaches both members through their `rooms` subscription.

### 16.5 Frontend

- **Types:** `Room` gains `kind`, `members` and `last_message_at`, plus `expand.members` (`id`, `name`, `avatar`).
  `ROOM_FIELDS` and the rooms subscription request the same fields. Emails are never fetched.
- **`roomTitle(room, me)`** in `lib/rooms.ts`: the room name, or for a DM the other member's name. Used by the
  sidebar, the room header and `document.title`.
- **Sidebar** (`roomSections`, §7.4) gains a **Direct messages** section between Rooms and Hidden: open DMs sorted by
  `last_message_at` (then `created`) descending, each with the other member's avatar (§15.4). Closed DMs are omitted,
  and a DM without messages is listed only for the member who opened it, so opening one doesn't show up for the other
  person until something is sent (QA BUG-29). `%` in the search text is escaped: PocketBase's `~` treats it as a
  wildcard (QA BUG-34).
- **New message:** a **+** button in the DM section header opens a user search (`GET /api/chat/users?q=`,
  `pb_hooks/lib/users.js`: up to 20 other users by name, `id,name,avatar` only; debounced 200 ms, at least 1
  character). It matches the query's name key against `users.name_key` (§22.1), so case is ignored beyond ASCII
  ("иван" finds "Иван"), which SQLite's `LIKE` on `name` didn't do (QA BUG-55).
  Choosing a user calls `actions.openDm(userId)` → `POST /api/chat/dms` → `upsertRoom` → navigate to `/r/:id`.
- **From a message:** clicking an author's name or avatar opens a small menu with **Message** (hidden for yourself),
  which does the same.
- **Room view:** unchanged apart from the header, the composer placeholder ("Message Bob") and the beginning marker
  ("Beginning of your conversation with Bob"). A DM shows the other member's avatar and name, and its menu has
  **Close conversation** (then back to `/`) and **Jump to beginning**, never Archive. A closed DM opened by URL
  offers **Reopen conversation** instead.
- **Not a member:** opening `/r/:id` of someone else's DM gets a 404 from `getRoom`, which already shows "room not
  found".

### 16.6 Tests

- **Integration (rules):** C cannot list, view, subscribe to, or post in A–B's DM, and C's `"*"` subscription gets
  no events from it; nobody can create `kind: "dm"` through the `rooms` API, set `members`/`dm_key`, change `kind`,
  or archive or rename a DM; A and B can post, edit and delete their own messages in it.
- **Integration (route):** creates on first call and returns the same room afterwards, also when called by B for A;
  two concurrent calls create one room; own id, unknown id and an anonymous caller are rejected; it unhides the
  caller's closed DM; the rate limit returns 429.
- **Integration (hooks):** a message in a DM sets `last_message_at` and deletes the recipient's `hidden_rooms` row
  (and only theirs); a public-room message touches neither; `EXPLAIN QUERY PLAN` still uses the index.
- **Unit:** `roomTitle`; `roomSections` with DMs (ordering, closed DMs omitted, a DM is never in Archived); the user
  search debounce and empty results; **Message** from an author menu; the DM header and menu.
- **E2E:** A opens a DM with B from the user search and sends a message; B sees the DM appear in the sidebar live
  and replies; C's sidebar never shows it, and C opening its URL sees "room not found". B closes the DM, A writes
  again, and it reappears for B.

### 16.7 Users who take no direct messages

`users.no_dms` (bool, off by default) marks someone who doesn't take part in DMs: the Telegram bridge's stand-in
users (§26) have it, and a user may set it on their own record (the profile doesn't offer it yet).

- `POST /api/chat/dms` refuses when either person has it ("Ann doesn't take direct messages." / "You've turned off
  direct messages.").
- The messages create hook refuses a message in a DM where a member has it, so turning it on also closes DMs that
  already exist (they stay readable). Such a DM shows "Ann doesn't take direct messages." (or "You've turned off
  direct messages.") where the composer was, and isn't offered to forward to (`dmClosed`, QA BUG-178).
- `GET /api/chat/users` returns `no_dms`, and messages expand `author.no_dms`: the "New message" search and the
  forward dialog leave such users out, and their author name has no **Message** menu. Adding them to a private room
  (§23) still finds them.

## 17. Attachments

### 17.1 Data model

`messages` gains one field:

| Field | Type | Notes |
|---|---|---|
| `files` | file, multiple | `maxSelect` 10, `maxSize` 20 MB each (4 and 8 MB until 1760000018, raised to take a whole Telegram album, §26), **`protected: true`**, `thumbs`: `480x360` (center crop) and `240x180`. No `mimeTypes` allowlist: any file can be attached, because nothing is ever rendered from the file itself (§15 shared rules). |
| `file_names` | json | stored name → original upload name, written only by the create hook from the uploads themselves (bidi and invisible characters removed, 200 characters max); cleared by a soft delete, never changed by an edit (QA BUG-28) |

PocketBase's default request body limit (32 MB) doesn't fit 10 × 20 MB, and the records API is PocketBase's own, so
one route can't get its own limit: `main.pb.js` replaces the default with 201 MB (`$apis.bodyLimit`, same middleware
id), and a middleware (`lib/http.js` `bodyLimit`) holds any other request to 32 MB with PocketBase's own limiter,
which counts what is read: 413 for one declaring more, and for a chunked one (no `Content-Length`) once it goes over
(QA BUG-143; it went through to 201 MB, guests' logins too). Chunked bodies are still taken: the Android app sends
one when it can't tell a file's size. Tests pin all three.

**Text becomes optional when files are attached:** the hook rule "text is non-empty" (§5.6) changes to "text is
non-empty **or** at least one file is attached". A message with neither is still rejected.

**Files are immutable after sending.** Edits change text only: the update rule adds `@request.body.files:isset =
false`, and the update hook rejects any change to `files` (including the `files+` / `files-` modifiers) except the
soft-delete wipe below.

**Soft delete wipes the files.** When `deleted` becomes true, the hook also sets `files = []`. PocketBase deletes
the stored files after the update commits, so the content is really gone (§5.3), and the old URLs return 404.
PocketBase serves files with `Cache-Control: max-age=2592000`, so a browser that already loaded an attachment may
keep it in its own cache after the delete; the server copy is gone.

**Non-image files are downloads.** PocketBase serves types it doesn't consider safe to display (HTML among them)
with `Content-Disposition: attachment`, on top of the sandbox CSP, so opening one never renders it on our origin.

### 17.2 Rate limits and storage

- `messages:create` keeps its 10 per 5 s limit. Uploads are bounded by that, `maxSelect` and `maxSize`.
- Files live in `pb_data/storage` (or the S3-compatible storage configured in PocketBase's settings) and are part of
  backups, so backup sizes grow; §11 notes this.
- No per-user quota in this round (§13, still open).

### 17.3 Access control and file tokens

Because the field is `protected`, `GET /api/files/messages/:id/:file` requires `?token=` with a **file token**
(`pb.files.getToken()`), and PocketBase checks the **message's view rule** for the token's user. Therefore:

- DM attachments are visible only to the two members (§16.3), and public-room attachments only to logged-in users.
- A leaked URL stops working when its token expires (PocketBase's default file token lifetime is 3 minutes;
  Settings → Tokens).

**Token handling (`api.ts`, `lib/token.ts`):** `fileUrl(message, filename, thumb?)` builds URLs from a cached token.
The cache fetches a new token when the current one is older than 2 minutes, shares one in-flight request between
callers, and is dropped when the session changes. The room view waits for a token before its first render and
keeps one fresh (a check every 30 s). Links to full files re-sign their `href` on hover, focus and click, so a
click never uses a stale token. Already-rendered images keep their URLs (the browser has them). An image that is lazy-loaded later with an
expired token fails; its `error` handler asks for a fresh URL **once** and retries, then falls back to a "Couldn't
load image" box with a Retry button.

Tokens change the URL, so the browser cache can't reuse a thumbnail across token refreshes. The service worker
(§27.2) keeps thumbnails under their URL without the token instead, so switching rooms or reloading doesn't download
them again. Full files (the viewer, downloads, video and audio) still go to the server with their token.

### 17.4 Sending (optimistic, retry-safe)

The composer gains an **Attach** button ("+", opening a hidden `multiple` file input), drag-and-drop onto the room and paste
(`clipboardData.files`). Selected files show as a tray above the textarea: image thumbnails from object URLs,
other files as chips with name and size, each with a remove (×) button.

- Client checks before sending: at most 10 files, each ≤ 20 MB after preparation (§15.3, images re-encoded to at most
  2048 px). A rejected file shows why, inline, and is not added.
- Send works as in §7.5, with `FormData` instead of JSON: the client id, room, author, text and the files. The
  pending message shows the local previews dimmed, with a progress bar under them: a send with files goes through
  XHR (`pb.ts` `upload`, used when the request has an `onUpload` callback), since fetch can't report upload
  progress. The controller passes it on (`onUpload`), and the list moves the bar in place (`setUpload`), without
  re-rendering the message. The tray shows about three rows of files, then scrolls.
- **The pending entry keeps its `File` objects,** so **Retry** re-sends the same id with the same files. A duplicate
  id is still rejected by the server, so a retry after a lost response can never post twice.
- Once the server version replaces the pending one (§7.5 step 4), the object URLs are revoked.
- Leaving the room while an upload runs lets it finish (writes are not aborted, §6); a reload loses unsent files,
  like unsent text today.
- Archived rooms have no composer, so no attach button.

### 17.5 Rendering

- **Images** (by file extension: `jpg jpeg png gif webp avif`): a wrapping row under the text, uncropped, in their
  own aspect ratio. One image shows 240px high and at most 400px wide (the `800x480f` thumb); two or more show
  120px high and at most 240px wide (the `480x240f` thumb). At most 4 tiles show: with more images and videos the 4th
  says "+N" over it (N more), and the viewer (§17.7) steps through all of them. The height is fixed, so loading never shifts the list
  vertically: a too-wide image is narrowed and letterboxed rather than shortened, a very narrow one is centred in a
  tile at least half as wide as it is high, and a small one is never enlarged (`object-fit: scale-down`). A GIF's
  tile shows the file itself, not a thumbnail: PocketBase thumbnails a GIF from its first frame only, so it would
  not play (the full GIF is up to the attachment limit, and loads lazily like the thumbnails). While a
  message sends it shows the local previews, at the size its thumbnails will take: the thumbnails get the previews'
  aspect ratio before they load. Only files the server will show as images (by extension) show as previews. Clicking
  opens the image viewer (§17.7); a click asking for a new tab or window (Ctrl/Cmd/Shift/middle click) opens the full
  file there instead (`target="_blank" rel="noopener"`), served under the sandbox CSP.
- **Shapes** (2026-10-28, user: "store media aspect ratio so placeholders will not change size while media is
  loading"): `messages.file_dims` maps each stored image or video name to `[width, height]` as it is shown, and a
  tile takes that aspect ratio before it loads, so it no longer starts narrow and widens (web: `aspect-ratio` on the
  thumbnail; Android: the tile's width, and a single image's whole box). Only the server sets it (create and update
  rules refuse it; an edit keeps the stored value). An image's comes from the header the create hook already reads for
  the pixel limit (`pb_hooks/lib/images.js`), with a JPEG's EXIF orientation 5–8 swapping width and height, as
  browsers and PocketBase's thumbnails show it; every upload path (the composer, collection items, Telegram, linked
  instances) goes through that hook. A video's comes from its poster (§30.1), which is in its shape: the media
  worker reads the poster's header once it is made, then marks the `media` row `sized`; files sent before this
  (`sized` false after migration `1760000037_file_dims.js`) are sized the same way, newest first, after the
  thumbnails. The worker writes the value with SQL, not a save: no hooks, no realtime event, `updated` unchanged,
  so clients see it on their next load, and until then (a video just sent, an AVIF, no ffmpeg) a tile takes its
  width once loaded, as before. A forward shows its original's (`showOriginal`); a delete clears it.
- **Videos** (by extension: `mp4 m4v webm mov ogv`): tiles like images, in the same row and at the same sizes,
  showing the video's first frame with a play badge over it. The tile is the **poster** the server makes of the video
  (§30.1: its first frame, in its own shape, at most 800×480), an `<img loading="lazy">` like an image's thumbnail, so
  the browser fetches nothing of the video until it plays. Without one (just sent, before the worker gets to it; a
  server without ffmpeg) the poster's request fails (404) and the tile becomes a `<video preload="metadata">` of the
  full file with `#t=0.001` (so every browser, Safari too, draws the first frame), fetching only enough of it to draw
  that, at once and without a new token. While sending, the local preview is the file's
  object URL (so the app CSP allows `media-src blob:`), and its aspect ratio carries over like an image's. Clicking
  plays it in the viewer (§17.7); a failed load retries once with a new token, then shows "Couldn't load video" with
  Retry (a format the browser can't play ends up there too; Ctrl/Cmd-click still gets the file).
- **Audio** (by extension: `mp3 m4a aac ogg oga opus wav flac weba`): the download chip with an
  `<audio controls preload="metadata">` of the full file next to it (as high as the chip, at most as wide as the
  message), named after the file, so it plays in the message. Its token expires (§17.3), so playing or seeking long
  after it loaded can fail: the first error after a load gets a new token, reloads the file and carries on from the
  same time (playing again if it was). Players are kept by message and file across renders (a new reaction or an edit
  re-renders the message without stopping one), and stopped once off the page (a deleted message, a message gone from
  the window, unmount): a detached `<audio>` would keep playing. While sending, audio is a plain chip.
- **Other files:** a chip with an icon, the display name and a download link (`download` attribute).
- **Display name:** PocketBase stores `quarterly_report_final_k3j2h1g0f9.pdf` for "Quarterly Report (final).pdf". The
  create hook records each upload's original name in `file_names` (§17.1), and the list shows and downloads files
  under it (`attachmentName()` in `lib/files.ts`). Messages from before that field fall back to `displayName()`,
  which strips the `_` + 10-character suffix (QA BUG-28).
- **Deleted messages** show the placeholder only (the files are gone, §17.1).
- **Edit mode** edits only the text; attachments stay visible below the textarea, without remove buttons. The text
  of a message with attachments may be emptied.
- `MSG_FIELDS` gains `files`, and the `messageNode` signature includes it.

### 17.6 Tests

- **Integration:** files-only message accepted, no text and no files rejected; a 5th file and an over-size file are
  rejected; the file URL without a token is 403/404, with A's token works, and with C's token on an A–B DM file
  is 404; responses carry the sandbox CSP and `nosniff` (an uploaded `.html` and `.svg` included); an edit cannot
  add, remove or replace files; soft delete empties `files` and the old file URL returns 404; the body limit fits
  10 × 20 MB, and other requests still get 413 over 32 MB.
- **Unit:** a video's tile is its poster, and the video's first frame when the poster fails (no new token for that);
  `displayName`; token cache (reuse, refresh after 2 min, one in-flight request); the composer tray (add,
  remove, limits, paste, drop); optimistic send with files, failure, and Retry with the same id and files; object
  URLs revoked on ack, removal and unmount; image grid layout classes for 1–4 images, and "+N" past 4; the upload
  progress bar; expired-token retry happens once.
- **E2E:** A attaches an image and a PDF and sends; B sees the thumbnail and the file chip live and can open both;
  in a DM, C can't load the file URL even when given it; deleting the message removes the attachments for B; the
  XSS smoke test (§9.3) also uploads an `.html` file and checks that opening it runs no script.

### 17.7 Image viewer

Clicking a thumbnail shows the image full size in a full-window viewer, and you can step through every image and
video in the room, oldest first: those of the room's window (§7.5) to start with, and the others fetched from the
server as you get near them.

- **What it shows:** the full file (not a thumbnail; uploads are at most 2048 px, §15.3), fitted to the window; a bar
  with the file name, who sent it and when, "*n* / *total*", **Show in chat**, **Download** (`download` attribute, re-signed before use
  like every file link, §17.3) and **Close**. Images of deleted messages and of messages still sending are left out.
  It starts with the window's images; it doesn't follow new messages. It does follow deletes (the room view passes on
  every update of the room's messages): a deleted message's images leave it, and a forward's once its original is
  deleted; the one shown gives way to the next (else the one before), and with none left the viewer closes (QA BUG-120).
- **Beyond the window:** when the image shown is within 3 of the first or last one it has, and the room has messages
  beyond the window on that side (`hasOlder`/`hasNewer`), it fetches the next page of the room's messages that have
  attachments (`withFiles` in `lib/cursor.ts`: `files:length > 0`, the usual `(created, id)` cursor from its first or
  last image), and the next while a page has none to show (only other files). Stepping past the end waits for it;
  a failed fetch is tried again by the next step. Previous/Next stay while there may be more. The count shows once the
  viewer has the whole room's images (at once in a room that fits the window), since it can't know the total before.
  The paging is in the viewer chunk; the room view passes only the page request and which files are images or videos.
- **Moving:** Previous/Next buttons on the sides (hidden at the first and last image), ←/→, Home/End, or a one-finger
  horizontal swipe (≥ 50 px, mostly horizontal; pinch-zoom still works). The neighbours are preloaded, so stepping is
  instant.
- **Show in chat:** closes the viewer and goes to the message the image or video shown is in, as a search result
  does (§29): centred and highlighted, loading the window around it if it isn't in this one. Focus goes to its tile.
- **Closing:** Close, Escape, a click on the dark space around the image, or the browser's **Back** (Android's back
  gesture too). Focus goes back to the thumbnail, or to the one drawn in its place if its message was redrawn while
  the viewer was open (a reaction, an edit). Leaving the room closes it. Keys pressed before it shows (its stylesheet
  is still loading) are still the page's.
- **Back:** opening the viewer pushes a history entry with the same URL (`history.state.viewer`, a token new on each
  page load, so an entry left from before a reload isn't taken for one). Back leaves it: `popstate` closes the viewer,
  and since the path doesn't change, the router's `popstate` handler finds the page already shown and does nothing. Closing it any other way
  goes back over the entry (`history.back()`), so Back then works as before; a viewer opened again before that Back has
  landed waits for it, or the Back would close it. Leaving the room doesn't go back (it would undo the navigation).
  An entry with no viewer open on it (Forward after Back closed the viewer, a reload while it was open, one left by
  leaving the room) would take a Back that seems to do nothing, so the router passes over it with `history.back()`
  whenever it lands on one, on start or on `popstate`.
- **Videos** step along with the images. One plays in a `<video controls>` (autoplay where the browser allows it, else
  the controls start it); stepping away or closing stops it and drops its download. Neighbouring videos aren't
  preloaded. Swipes don't start on the video (dragging its seek bar isn't a swipe) and the arrow keys are the video's
  own while it has focus. A video whose token expires mid-play (the browser fetches it in ranges) gets a new token and
  carries on from where it was.
- **Failures:** an image that doesn't load gets one retry with a new file token (an expired token is the usual cause),
  then "Couldn't load image" with Retry, like thumbnails (§17.3).
- **Accessibility:** a modal `<dialog>` (focus stays inside, the room behind is inert), named after the image shown;
  the caption is a polite live region, so stepping announces the new image; the image's alt text is its file name.
- **Look:** dark in both themes, so the image stands out.

**Loading (the main bundle stays as it was).** `views/room/viewer.ts` is a lazy chunk: the room view `import()`s it on
the first click (`app.js` grew by 0.2 KB gzipped for the click handler and the import), and it links its own
stylesheet, `viewer.css`, before it shows. Both have hashed names and a budget of their own (§7.7). It imports only
types (§7.7: a lazy module mustn't share modules with `app.js`); the DOM helper, names, dates and signed URLs come
from the room view as options. If the chunk can't be loaded (offline, or a new version was deployed and the old chunk
is gone), the image opens in a new tab as before.

An iframe with the viewer inside was considered and rejected: it is a heavier way to load code lazily (its own HTML
document, and its own copy of the session and file-token code), keyboard focus and Escape don't cross into an iframe
by themselves, and `frame-ancestors 'none'` (§5.6) would have to be relaxed.

**Not done yet:** zooming in beyond fit-to-window is the browser's pinch-zoom only.

**Tests (e2e):** the chunk and stylesheet aren't loaded before the first click; the viewer covers the window, shows the
full image, steps with the keys, the buttons and a swipe (which isn't taken for a click that closes it), the Download
link works, Escape and a click beside the image close it and focus goes back to the thumbnail; Back closes it and
stays in the room, and after Escape its history entry is gone; closing and opening again at once leaves it open;
Forward after Back and a reload while open leave no entry behind; focus finds the thumbnail after its message was
redrawn; keys pressed while its stylesheet is still loading don't step; Ctrl/Cmd-click still opens a tab. **Unit:** the build helpers (no shared chunk, the stylesheet define, budgets).

## 18. Unread counts

Every room and DM in the sidebar shows how many messages you haven't read yet, live. Decisions: §13 (2026-10-11).

### 18.1 Data model: `room_reads`

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required, cascade delete |
| `room` | relation → rooms | required, cascade delete |
| `last_read_at` | date | required: you have read every message created up to and including this time |

Unique index on `(user, room)`. Rules: list and view `user = @request.auth.id` (so each user gets their own rows
live); create, update and delete `null`. Only the route below writes rows, so a client can't move its read position
back, set it in the future or write someone else's.

No row means "read up to your signup" (`users.created`): history from before you joined never counts.

### 18.2 Routes (`pb_hooks/lib/reads.js`)

- **`GET /api/chat/unread`** → `{ at, rooms: { "<roomId>": count }, ids }` for the rooms with anything unread, where `at`
  is the server time the counts were taken (answers older than the counts shown are dropped), and `ids` the other
  people's messages of the last 30 s in rooms you can see, read or not: the ones these counts account for (§18.3,
  QA BUG-106). One SQL statement, so the counts and `ids` come from one snapshot: for each room you can see (public, or a DM
  you are in), count the messages that are not yours, not deleted, and newer than `max(last_read_at, your signup)`,
  **stopping at 100** (the badge shows `99+`; without the cap a 50k backlog took ~200 ms per request). Each count is
  a correlated subquery, so it is a range scan on `idx_messages_room_created` (an integration test pins the query
  plan). Hidden and archived rooms are counted
  too; the client decides what to show (§18.4), and a room you unhide shows its real backlog. Rate limit: 120 per 60 s
  per IP, as for reads (QA BUG-144: the heaviest read, 237 ms with 1 000 rooms, had only the `/api/` limit); the
  client asks at most every 250 ms, and only when something changed.
- **`POST /api/chat/reads`** `{ room, at? }`: you have read `room` up to `at` (a message's `created`; default now).
  The position only moves forward and never past now; `at` must be a date (`""` is a 400, not "now"). A room you can't see (someone else's DM, no such room) is a
  404. Two tabs racing to create the row end up with one (the unique index, then an update). Rate limit: 120 per
  60 s per IP; the client sends at most about one per second per open room.
- **`GET /api/chat/unread/{room}`** → `{ id, created }` of the oldest message in `room` that is unread by the same
  rule (not yours, not deleted, newer than `max(last_read_at, your signup)`), or `{ id: "", created: "" }`. 404 for a
  room you can't see. §18.5 opens the room there.

### 18.3 Client

- **One service, `unread.ts`,** started and stopped with the session next to `sync.ts` (`app.ts`). It owns the counts
  and everything about telling the server what was read. Views only read the store and report what they show.
- **State:** `AppState.unread` (room id → count). Loaded at login and on every reconnect; `refresh()` refetches,
  debounced. A failed count never affects the room list.
- **Live +1:** the service subscribes to **all** message events (`fields: id,room,author,deleted`, never the
  text), which the messages list rule already limits to rooms you can see. A create from someone else in a room
  other than the active one is +1. A soft delete in a room with unread messages refetches the counts (was the
  deleted message unread?). A count request in flight may or may not include a +1 that arrives meanwhile: the +1s
  received during it are kept, and those whose message isn't in the answer's `ids` are added on top. (Refetching
  instead starved the counts in a busy room: QA.) A +1 whose message is in the `ids` of the counts shown is skipped:
  its event came after them (SSE can trail the HTTP answer). Times can't decide this: a message is committed some
  time after its `created`, so one created before `at` may be missing from the counts and one created after it
  included (QA BUG-106). An answer older than the counts in the store is dropped.
- **Other tabs and devices:** `room_reads` events (your own rows only) refetch the counts, debounced (250 ms).
- **Marking read:** the room view opens a `RoomReader` (`unread.open(roomId)`) on mount. After every render, scroll
  (and after the scroll a render asks for, e.g. to the first unread message) and visibility change, in a visible tab,
  it reports how far the list is on screen: `reader.seen(created, caughtUp)`. When the newest messages are on screen
  (the window reaches the live edge, §7.5, and the list is scrolled to the bottom) that is the newest confirmed
  message, `caughtUp`; otherwise the newest confirmed message shown whole (the rows are bisected by their rects), so
  scrolling down through unread messages reads them as they come into view (2026-10-24: opening a room used to be
  all or nothing). Caught up, the reader clears the room's count in the store at once. At most once a second it sends
  the position to `POST /api/chat/reads`. A failed send is sent again by itself after 2 s, doubling up to a minute,
  until it is in or refused (a 4xx other than 429): nothing else may ask, since the room on screen needn't change (QA
  BUG-162). On unmount the view calls `reader.close(caughtUp)`: a pending read goes out immediately, and when not
  caught up the counts are refetched once it is in (fetched before it, the messages just read would count again),
  because what is below the screen is still unread and messages that arrived meanwhile weren't counted (it was the
  active room).
- **Whose read:** the session is shared by every tab, and another tab can switch it to another user. A reader
  remembers who it was opened for and never sends a read as anyone else. Ending the session (`endSession()` in
  `app.ts`) calls `unread.flush()` first, so logging out still sends the pending read while the session exists;
  after a switch from another tab, the same flush sends nothing.

### 18.4 Rendering

- A pill after the room name (`.badge`, the accent gradient, `99+` past 99) and a bold name. The badge holds a
  visually hidden " unread", so a screen reader reads "general, 3 unread".
- **No badge** for the active room, hidden rooms or archived rooms (`unreadCount()` in `store.ts`). The tab's
  count (§22.4) does include the active room while the tab is away.
- Room rows are now flex rows: the name ellipsizes, and the `#`, the avatar and the badge always stay visible.

### 18.5 Opening at the first unread message

- Opening a room that has unread messages in the store (the room list showed a badge; not with `/m/:msgId`, which
  wins) asks `GET /api/chat/unread/{room}` where the first unread message is, beside the latest page. The first window
  is then the latest page if it holds that message, else the page before it plus it and the page after (`windowAt` in
  the controller), scrolled so that it sits a quarter of the way down the list. Without unread messages nothing extra
  is fetched.
  Before the counts are in (the store's `unread` is still `UNCOUNTED`: a reload, a restored tab, a link to the room)
  the server is asked too: the room would otherwise open at the bottom and take every unread message as read
  (QA BUG-93).
- **The "New" line:** a red line with "New" (`li.new-line`) over that message, for `UNREAD_LINE_MS` (5 s); it fades
  out in its last second. It has no height, so nothing moves when it goes.
- **Room cache (§7.5):** the server isn't waited for. With the counts in, the first unread message is worked out from
  the kept window by the server's rule (the room's count of other people's messages that aren't deleted, counted
  back from the newest); the kept window is shown at once scrolled to it if it holds them all and was prefetched with
  that very count (`Kept.unread`; a message that came since, or a prefetch not run yet, would put the line on one
  already read: QA BUG-99), and otherwise the room waits for the server's window. Before the counts are in (a reload) it
  is shown at the bottom, and when the server says where they start it goes there (unless you scrolled away), or, if
  they weren't kept, the first page does. When the page comes, the list otherwise stays where it is, even if you
  scrolled to the bottom meanwhile (QA BUG-96).
- **One round trip:** the latest page is asked for beside the first unread message, not after it. When it holds that
  message (a few unread), it is the first window; only with more does the room fetch the pages around it.
- Reading is unchanged (§18.3): the room is marked read only once its newest messages are on screen.

### 18.6 Tests

- **Integration:** counts (others' messages only; deleted, own and pre-signup ones excluded; DMs only for
  members); the first unread message (same rule, after a read, 404 for invisible rooms, 401 anonymous); reads (clears up to `at`, default now, never back, never past now, one row under concurrent calls; 404
  for invisible rooms, 400 for bad and empty dates, 401 anonymous); `at`; the cap at 100; `room_reads` rules (private,
  no API writes, live only to its owner); the rate limit; the query plan.
- **Unit:** store updates and `unreadCount`; `unread.ts` (initial load, live +1 except own and active room, delete
  refetch, reads from another tab, failed counts, a +1 during a request, a room that never stops, debounced refresh;
  the reader: batching, close, flush, never as another user, retry, nothing after stop); room view (marks on open and
  live, opens at the first unread message with the "New" line, which goes after `UNREAD_LINE_MS`, flushes on leave, not from history, scrolled up or in a hidden tab, retries a failed read); app (logout sends a
  pending read); sidebar badges (count, `99+`, label, none where silent,
  live).
- **E2E:** Ada writes, Bob's badge counts live and survives a reload; opening the room clears it in Bob's other tab;
  new messages count again. Scrolled up, a new message stays unread until Bob scrolls down to it.

## 19. Replies

Any message in a room or DM can be answered with a reply that quotes it. Clicking the quote shows the original,
wherever it is in the history.

### 19.1 Data model

`messages.reply_to`: an optional relation to another message (max 1, no cascade). Messages are only ever
soft-deleted, so the relation never dangles: a reply to a deleted message quotes "Message deleted".

- **Set on create only.** The update rule adds `@request.body.reply_to:isset = false`, and `beforeMessageUpdate`
  refuses any change to it, as to `author` and `room` (backing up the rule, field modifiers included).
- **Same room, not deleted** (`assertReplyTarget` in `pb_hooks/lib/messages.js`). Without the room check, a reply could
  point into a DM you aren't in, and its expanded quote would show you that message.
- **Hard deletes still work.** When a superuser deletes a message (or a room) for good, PocketBase clears
  `reply_to` on its replies once the original is gone. `beforeMessageUpdate` lets that one save through
  (`replyTargetRemoved`); otherwise its guards would refuse it, and the delete with it.

### 19.2 API

Every message read (`page`, `getMessage`, `changes`, `send`) expands `author,reply_to.author` and asks for
only what the quote shows: `reply_to`, and the original's `id, author, text, deleted, files` and author's
`id, name` (`MSG_FIELDS` in `api.ts`). The expand follows the messages view rule, which the same-room check makes
always true for someone who can see the reply. `NewMessage.replyTo` sends `reply_to`. Live events don't expand it
(`LIVE_OPTS`, docs/PERF.md §2.3): it costs the server ~5 ms a client for every reply. The room controller fills the
quote in from the original in its window, or from its own copy of the reply, and fetches the original only when it has
neither.

### 19.3 Frontend

- **Reply** joins Edit and Delete in a message's action pill, on any message that is saved, not deleted, in a room
  that isn't archived (`ctl.repliable`). It shows "Replying to *name* *text*" above the composer (×, or Escape in the
  textarea, cancels) and focuses the textarea. The next send is the reply; the optimistic message quotes the
  original at once (`quoteOf` in `lib/messages.ts`).
- **Ctrl+Up / Ctrl+Down** in the textarea move the reply to the previous / next repliable message in the window and
  scroll it into view; Ctrl+Up while not replying starts a reply to the newest one, and Ctrl+Down past the newest ends
  the reply.
- The reply bar follows the original: edited, it shows the new text; deleted (or the room archived), it closes.
- **The quote** is a one-line button above the reply's text: author name, then the text on one line (or
  "Attachment", "Message deleted"). It uses the window's copy of the original when there is one, so edits and
  deletes show live; otherwise the server's expanded copy. A live reply to a message beyond the window has neither
  until the controller has fetched it: its quote reads "…" meanwhile (QA BUG-180).
- **Replies to you** (someone else's reply to one of your messages) are highlighted (`.to-me`: a rounded card with a faint
  accent tint; until 2026-11-01 also an accent bar on the left), so you can spot them while scrolling.
- **Going to the original** (`ctl.goTo`): if it is in the window, it is highlighted (`.target`) and centred. The
  highlight (here and for `/r/:id/m/:msgId`) holds briefly, fades out, and is dropped after `HIGHLIGHT_MS` (3 s). If not,
  the window is replaced by the history around it (as for `/r/:id/m/:msgId`, §7.5) once that has loaded; the old
  window stays until then. The URL doesn't change, so the composer and anything typed into it stay. Unsent
  (pending or failed) messages the new window drops are kept aside and come back at the live edge. A send
  that completes meanwhile is not added to the history window.
- **The original deleted unseen:** the send fails with a `reply_to` error. The message then says "Not sent: the
  message you replied to was deleted", its quote shows as deleted, and **Send without quote** sends it as a plain
  message.
- The quote's accessible name is "Quoting *name*: *text*", capped at 80 characters, so that it doesn't read a whole
  long message aloud and doesn't start with "Reply" like the Reply button. Escape doesn't cancel a reply while an
  input method is composing.

### 19.4 Tests

- **Integration** (`replies.test.ts`): same-room replies; refused across rooms, into a DM you aren't in, to unknown
  or deleted messages; `reply_to` never changes; a deleted original stays quoted as deleted; the quote comes back
  through send, page, getMessage and realtime with only its fields; field modifiers can't touch `reply_to`; a
  superuser can delete an original or a room holding replies.
- **Unit** (room view): reply bar and send; cancel with × and Escape; stepping with Ctrl+Up/Down; quotes that go to an original on screen and
  one far back in history; a quote and the reply bar following an edit and a delete; no Reply when archived, deleted
  or still sending; archiving ends the reply, and unarchiving doesn't bring it back; Escape while composing; a send
  or a failed message during a quote's history load; a reply to an original deleted unseen; the quote's name; only
  others' replies to your messages are highlighted.
- **E2E** (`replies.spec.ts`, light and dark): Bob replies to Ada and she sees the quote live; Ada replies to a message
  far back in history, and Bob's click on the quote loads that history and highlights it; axe finds no serious
  violations in the reply bar or the quotes.

## 20. Reactions and emoji

Anyone who can read a message can react to it with emoji, as many different ones as they like, and the composer has
an emoji button. Decisions: §13 (2026-10-11, reactions and emoji).

### 20.1 Data model

`messages.reactions`: a JSON list with one entry per emoji, in the order each was first used. Each entry holds the ids
of who reacted with it, in the order they did: `[{ "emoji": "👍", "users": ["<id>", …] }, …]`. An emoji nobody uses
any more is removed; `[]` when there are none.

- **Only the route below writes it.** The create and update rules add `@request.body.reactions:isset = false`. The
  create hook sets `[]` whatever was sent, and a request hook (`beforeMessageUpdateRequest`) refuses an update that
  changes it, superusers included. The route's own saves don't go through request hooks.
- **The emoji are the picker's** (`pb_hooks/lib/emoji.js`, the same list as `web/src/lib/emoji.ts`; a unit test fails
  if they drift apart). Anything else is a 400.
- **A soft delete wipes them** with the text and files (§5.6). Edits keep them, and they never set `edited_at`.
- **An edit keeps the stored reactions**, not the ones loaded with the record. PocketBase writes every field on a save,
  so an edit that read the message before a reaction was added would otherwise erase that reaction.
  `beforeMessageUpdate` re-reads them, and the update request runs in a transaction so that nothing can commit between
  that read and the write.

### 20.2 `POST /api/chat/reactions`

`{ message, emoji, on }` → the message, expanded and filtered like a read of it (`?expand`, `?fields`): the caller's `emoji` reaction on `message` is there
(`on: true`) or not (`on: false`). Setting a state rather than toggling makes it idempotent, so a retry or a double
click can't flip it back. The whole message comes back, not just its reactions. A client that patched only the reactions
and took the newer `updated` would hide an edit it hadn't heard of yet (its realtime connection was down), even from
the reconnect refetch.

1. `emoji` not in the set, or `on` not a boolean: 400.
2. A message the caller can't see (the messages view rule, via `canAccessRecord`) is a 404, like one that doesn't exist.
3. In one transaction: read the message, refuse it if it is deleted or in an archived room (400), change the list,
   save. Because the read and the write share one transaction, two people reacting at the same moment both count.
4. Nothing to change (already there, or not there to remove): no save, the same answer.

Saving the message bumps `updated`. The change therefore reaches every client as a messages `update` event, wins over
older copies in `merge` (§7.5), and is picked up by the reconnect refetch of changed messages. `MSG_FIELDS` gains
`reactions`. Rate limit: 30 per 10 s per IP. The unread counter ignores these updates (only deletes matter to it, §18.3).

### 20.3 Frontend

- **Showing them:** under a message's text and attachments, a chip per emoji with its count; yours are tinted and
  `aria-pressed`. The tooltip says who: "You, Ada and 2 others reacted with 🎉". Names come from the window's
  authors. Anyone else is looked up (`api.usersById`), with one request for all the unknown names a render needs.
- **Changing them:** clicking a chip adds yours or takes it back. **☺+** ("Add reaction") in a message's action pill, and the same
  after the chips, open the picker; picking an emoji you already used takes it back. In archived rooms the chips show
  but are not buttons, and there is no ☺+.
- **Optimistic:** a change shows at once, as an overlay over every copy of the message (the controller's `reactions(m)`)
  until the server answers. A realtime update made before yours therefore doesn't flicker it away. The requests for one
  message go one at a time, in order, and a change superseded before its request went out is skipped. The server ends
  up with the last choice, in the order the changes were made. A failure shows the reaction as it was, with an inline
  error and Retry. A request that fails after a later change to the same reaction isn't reported, since the later one
  decides what shows.
- **Focus** stays on the chip that changed, or moves to the action pill's ☺+ when the chip is gone (a failure, the last one taken
  back). A message is redrawn whenever it changes, for instance when someone else reacts. When that replaces the
  focused button, focus moves to the new one.

### 20.4 Emoji picker (`ui/emoji-picker.ts`)

One popover per room view, used by the composer's emoji button (it inserts at the caret, replacing a selection) and by
reactions. It is a `role="dialog"` named for what it does ("Insert emoji", "Add reaction"). It sits next to its button
(above it when there is room) and spans the screen width on phones.

- Category tabs, then a **Recent** row (the last 24 picked, kept in `localStorage`; nothing breaks without storage),
  then the categories, in an 8-column grid. Built on first open.
- **Keyboard:** the grid is one tab stop (roving `tabindex`). Arrow keys move within and across categories, Home and
  End go to the ends, and Enter or Space picks. **Escape** closes it and gives focus back (to the composer, or to the
  message's ☺+). Clicking or tabbing elsewhere closes it, and so does the message it reacts to being deleted (or
  leaving the list) meanwhile (QA BUG-121). A window resize moves it along rather than closing it. On
  Android the page resizes when the keyboard goes away (`interactive-widget=resizes-content`), and opening the picker
  takes the focus from the composer, which hides the keyboard.
- The emoji are toggle buttons (`aria-pressed`) only for reactions, where picking can take one back. For the composer
  they are plain buttons.
- Each emoji button is named by the emoji itself, which screen readers read out by name.

### 20.5 Tests

- **Integration** (`reactions.test.ts`): adding and removing several emoji per user; idempotent; text and `edited_at`
  untouched, `updated` bumped; concurrent reactions all count, also against concurrent edits; the answer is the whole
  message, expanded; only the set's emoji and a boolean `on`; 404 for
  invisible messages, 401 logged out; refused on deleted messages and in archived rooms; wiped by a soft delete, kept by
  an edit; clients (and superusers) can't write the field; returned in `MSG_FIELDS` and live; the rate limit.
- **Unit:** the client and server emoji sets match, with no duplicates and one grapheme each; recent emoji (order, cap,
  storage failures); `setReaction` and `reactors`; picker arrow-key steps, opening, picking, Escape and outside clicks;
  the controller's overlay over a stale copy, a superseded failure not reported, the answer bringing an edit that
  realtime missed, and where you can't react. The picker stays open on a resize and isn't a toggle when inserting. Room view: React and pick; chips toggling;
  live reactions from others, with their names looked up; taking one back from the picker; failure and Retry; a
  reaction changed again before the answer; focus, also across redraws and failures; archived and deleted messages; the composer inserting at the caret.
- **E2E** (`reactions.spec.ts`, light and dark): Ada inserts an emoji from the composer's picker. Bob reacts twice, once
  by keyboard. Ada sees both live, with Bob's name, and adds hers. Reactions survive a reload, and axe finds no serious
  violations in the open picker or the chips.

## 21. Selecting, forwarding and deleting several messages

Messages can be selected, one or many, then forwarded to another room or DM, or deleted together when they are all
yours. A single message can be forwarded straight from its action pill. Decisions: §13 (2026-10-11, selecting,
forwarding and deleting several messages).

### 21.1 Selecting

- **Select** in a message's action pill starts selecting, with that message selected. While selecting, every
  selectable message (saved, not deleted: `ctl.selectable`) has a checkbox ("Select message from Ada, …"); a click
  anywhere on a message toggles it too, rather than following a link or pressing a button in it. Selected messages are
  tinted. Single-message actions (the pill, the delete confirm, an open edit box) are gone meanwhile.
- **The selection bar** replaces the composer (which keeps what was typed): "*n* selected", **Forward**, **Delete**
  (only when you could delete every selected message, §7.6.1) and **Cancel**. Delete asks first in the bar ("Delete
  these 3 messages?", focus on Cancel).
- **Stopping:** Cancel, Escape, or unselecting the last message; focus goes back to the composer. A selected message
  that leaves the window, or is deleted meanwhile, is unselected.
- **At most 50** (`MAX_SELECTED` in `lib/limits.ts`, `MAX_MESSAGES` in `pb_hooks/lib/bulk.js`). One more is refused
  with a notice above the list (gone when selecting stops), and its checkbox stays unchecked.

### 21.2 Deleting: `POST /api/chat/delete`

`{ messages: [ids] }` → the messages, soft-deleted, expanded and filtered like a read (`?expand`, `?fields`).

1. 1 to 50 distinct ids, else 400. Any message the caller can't see (messages view rule) is a 404 for the whole request.
2. Any message that isn't the caller's is a 403; any in an archived room a 400.
3. In one transaction, each message not yet deleted is saved with `deleted: true`. The save goes through
   `beforeMessageUpdate` (§5.6), which wipes text, files and reactions as for a single delete; already deleted ones
   are left alone, so a retry succeeds.

Every room member gets the usual realtime `update` per message. The client shows the placeholders at once
(`ctl.removeMany`) and puts the messages back, with a notice, if the request fails. Rate limit: 20 per 60 s per IP.

### 21.3 Forwarding: `POST /api/chat/forward`

`{ messages: [ids], room }` → the new messages, oldest first, expanded and filtered like a read.

1. 1 to 50 distinct ids (400). A target room the caller can't see is a 404, an archived one a 400. Any message the
   caller can't see is a 404, and any deleted one a 400: forwarding never reveals a message you couldn't read.
2. In one transaction, a new message per original, in the originals' order (`created`, then id): `author` is the caller,
   `forward_of` the original (for a forward, the message it shows: chains are one step), `forwarded_from` the
   original's `forwarded_from` or else its author, and `text` empty. Nothing is copied, so a forward is one row however
   big the attachments are. The forwards are `created` a millisecond apart so they keep their order. The saves go
   through `beforeMessageCreate` and `afterMessageCreate` like any message: a DM's members are checked, a closed DM
   reopens for the recipient, and unread counts and realtime follow. A message whose original is deleted or gone is a
   400, like a deleted one.

**Forwards show their original** (`messages.forward_of`, a relation to `messages`, max 1, no cascade):
- *What is shown.* `onRecordEnrich` (`showOriginal`) fills in a forward that isn't deleted with its original's
  `text`, `files`, `file_names` and `edited_at` in every answer and realtime event, expanded replies included (a
  reply to a forward quotes the original's words). Once the original is deleted they are empty, and the client shows
  "The original message was deleted" under "Forwarded from *name*"; a superuser removing it for good clears
  `forward_of` (let through by `beforeMessageUpdate`, as for `reply_to`), with the same result. Nothing is saved.
- *Who may see the original.* The messages **view** rule adds: a forward of this message that isn't deleted is in a
  room the caller can see (an aliased `@collection.messages:fwd` join with "any of" operators, so every condition is
  about the same forward). That covers reading it by id, expanding it and its attachments' URLs (the client signs
  `/api/files/messages/<forward_of>/…`). The **list** rule is unchanged: the original's room, its other messages and
  replies stay hidden, and the routes that act on a message (reactions, forward, delete) check the list rule, so a
  forward's reader can't react to the original or forward it by id. Deleting the forward ends the grant. Read that way,
  the original keeps to itself what would say who is in its room: `keepToRoom` (`onRecordEnrich`) empties its
  `reactions` and `reply_to` for anyone who can't see its room (QA BUG-80).
- *Live.* A reader of the forward can't subscribe to the original's room, so after an edit or delete of a message
  (`changesForwards`), `touchForwards` saves its forwards again (nothing changes but `updated`), which sends them out
  with the original as it is now. Forwards in archived rooms can't be saved: they show it when loaded.
- *The viewer* pages through `files:length > 0 || forward_of != ""`: a filter can't see the original's files (relation
  filters apply the original room's rules), so forwards without media are skipped in the client.
- `forward_of` is set only by the route: the create and update rules add `@request.body.forward_of:isset = false`,
  and `beforeMessageCreateRequest` / `beforeMessageUpdate` back that up against field modifiers, superusers included.
  `beforeMessageCreate` checks the original is there, not deleted and not a forward. `MSG_FIELDS` gains `forward_of`.

**`messages.forwarded_from`**: an optional relation to `users` (max 1, no cascade). The create and update rules add
`@request.body.forwarded_from:isset = false`; `beforeMessageCreateRequest` and `beforeMessageUpdate` back that up
against field modifiers (superusers included). As with `reply_to` (§19.1), `beforeMessageUpdate` lets PocketBase
clear it when a superuser deletes the user it names. `MSG_FIELDS` gains `forwarded_from` and its expanded `id` and
`name`; the message shows "Forwarded from *name*" above its text. Rate limit: 20 per 60 s per IP.

**A forward can't be edited**, only deleted: its words are someone else's (they change only when their author edits the
original), and "Forwarded from Bob" must stay true.
`beforeMessageUpdate` refuses a text change on a message with `forwarded_from` (400); the client splits
`ctl.editable` (no Edit button, skipped by Up arrow) from `ctl.deletable` (Delete, the selection bar).

**The forward dialog** (`views/room/forward.ts`) is a modal `<dialog>` named "Forward *n* messages": a search box
that filters your open DMs (most recent first), rooms and hidden rooms by title (a room shows its name after a "#" icon), and also finds people you have no DM
with yet (`api.searchUsers`, debounced); picking one of those opens the DM (`actions.openDm`) first. On success the
dialog closes, selecting stops and the view goes to the target room (or, for the room you are in, says "*n* messages
forwarded"). Messages deleted since the dialog opened, and forwards whose original was, are left out (QA BUG-79); with
none left nothing is sent. A failure, with the server's reason, is shown in the dialog, which stays open to try again.
A forward whose original was deleted has no Forward in its pill. While a forward is on its way the dialog
can't be cancelled (Cancel disabled, Escape refused), and if the browser closes it anyway a failure reopens it: what
happened must be seen. While a people search is pending the status says "Searching…", not "Nothing found."; people
found for an earlier query stay only while they match the new one.

The pill's Forward button has the class `forward` too, so the dialog's styles are scoped to `dialog.forward`.

### 21.4 Tests

- **Integration** (`bulk.test.ts`): a forward can be deleted but not edited; delete several, all or nothing (someone else's message → 403), idempotent, refused
  in archived rooms and for invisible or unknown messages, live for others; forward in order with `forwarded_from`
  and `forward_of` (pointing at the original through a forward of a forward), nothing stored but the pointer, edits and
  deletes of the original showing live, an original removed for good, no files copied and the original's readable
  wherever the forward is (guests in Open Air rooms too, nobody else), the grant limited to that one message and ended by
  deleting the forward, a reply quoting the original's words, the answer expanded like a read, into a DM only for its
  members and reopening it, nothing forwarded from a DM you're not in or of deleted messages, clients (and superusers)
  can't set or change `forwarded_from` or `forward_of`; the rate limits. **E2E** (`attachments.spec.ts`): a forwarded
  image's thumbnail and viewer load from the original.
- **Unit** (room view): selecting by Select, checkbox and click; Cancel, Escape and the last unselect; deleted and unsent
  messages not selectable, one deleted meanwhile unselected; the 50 limit; Delete only for your own, its confirm, one
  request, and a failure putting them back; forwarding a selection in order and going there; forwarding one message to
  someone found by name; a failed forward and forwarding into the same room; archived rooms; forwards have Delete but
  no Edit and Up arrow skips them; the limit notice goes when selecting stops; a forward can't be cancelled halfway and
  a failure is always seen; "Searching…" until the people search answers.
- **E2E** (`forward.spec.ts`, light and dark): Ada selects Bob's message and hers, forwards both to Bob (found by name),
  and Bob sees them live with "Forwarded from"; she then deletes two of her own at once and Bob sees the placeholders.
  axe finds no serious violations while selecting or in the dialog.

## 22. Accounts and quality of life

### 22.1 Unique display names

`users.name_key` (hidden text, unique index where not empty) holds the name's key: `nameKey()` in
`pb_hooks/lib/text.js`, the same NFKC + case folding without invisible characters as room names (§5.2). `beforeUserSave`
sets it after cleaning the name and refuses a key someone else has: 400, `name: validation_not_unique`, "This display
name is taken. Choose another one." (shown next to the field by sign up and the profile). An update that keeps the name
keeps its key without checking it. The migration (`1760000012_accounts.js`) backfills the keys; names that already
clashed get a key made unique with the user id (`key#id`), so those accounts keep their name and can still change
their picture or password, but nobody new can take it. Tests free a fixed name such as "Ada" the same way before
signing it up again (`tests/support/names.ts`), since every test shares one server.

### 22.2 Password and Log out on the profile page

`POST /api/chat/password` (`pb_hooks/lib/account.js`, logged in only) takes `oldPassword` and `password`. It checks
the current password (400 on `oldPassword` if wrong), refuses an unchanged one, sets the new one (the field's own
rules, e.g. at least 8 characters, apply), refreshes the user's token key, so every token issued so far stops working
(other devices are signed out), and answers like a login (`{ token, record }`). `api.changePassword` saves that
answer, so this tab (and the others of this browser, which share the session) stays logged in. Rate limit: 5 per 60 s.
It is the only way to change a password: the users update rule refuses `password` (QA BUG-53).

Who a realtime client is comes from the token its subscriptions were sent with, so whenever the token changes the
client sends them again (`pb.ts`, QA BUG-52). A device that was signed out finds out when the server refuses a change
it sends (`api.onRejected`, checked at most every 30 s: a refusal sooner than that is checked once the 30 s are up, QA
BUG-151) or when its tab comes back after 5 minutes: the session check (`refreshAuth`) then fails and it goes to the
login screen (QA BUG-51).

The profile page has a "Password" form (current, new, confirm; checked in the page first, each error under its field)
and a "Session" section with **Log out**, which moved there from the app bar. The Password form is the last section
before Session (after Appearance; moved 2026-10-23, the app too).

### 22.3 Drafts survive a reload

`web/src/drafts.ts` keeps what is typed in the composer under `chat.draft.<user>.<room>` in `localStorage`, written
on every change (blank text removes it). One key per room, so two tabs writing in different rooms don't overwrite
each other. The room view restores it on mount. Ending the session (logging out, or another tab switching to someone
else) removes that user's drafts. Storage that is full or disabled only means no drafts.

### 22.4 Unread count in the favicon

`web/src/favicon.ts` sums the room list's badges (§18.4: not the open room, hidden or archived ones) and draws an SVG
favicon (a speech bubble in the app's gradient) with a red badge holding the count (`99+` past 99); the title becomes
"(3) Chirkle". In a room, the title also names it as the room list does (`#name`, or the other member's name in a DM):
"(3) #general – Chirkle". `index.html` carries the plain icon, so the tab has one before the script runs.

While the tab is away (`document.visibilityState` is `hidden`, kept as `AppState.away` by `app.ts`), nobody is
reading the open room, so its new messages count too: `unread.ts` counts them live, keeps the server's count for it
on a refetch, and refetches when the tab goes away (after sending what was read) to catch messages that came in
unseen while scrolled up. The room list still shows no badge for it (§18.4). Coming back, the room view reads what is
on screen as usual, which clears it; scrolled up, it stays out of the count, as before.

### 22.5 Focus on entering a room

When the composer is first shown in a room (on entering it or switching from another), the caret goes into it. Not on
touch screens (`(hover:none)`), where it would open the keyboard over the messages.

### 22.6 Confirmations go away

"Message forwarded." / "*n* messages forwarded." clears itself after 4 s (`NOTICE_MS`), unless another notice replaced
it meanwhile. Errors stay until something else is said.

### 22.7 Jump to latest

The pill over the bottom of the list (§7.5) also shows, as a quieter "↓ Jump to latest", whenever the newest messages
aren't on screen with nothing new below: scrolled up by more than 80 px, or the window is back in history (after a
quote or Jump to beginning). Clicking it scrolls to the bottom, or loads the latest page when the window doesn't have
it. "↓ New messages" and "New messages · Jump to latest" take precedence as before.

### 22.8 Tests

- **Integration** (`accounts.test.ts`): names unique across case, invisible characters and whitespace; renaming onto
  someone's name refused, keeping yours fine, a freed name can be taken; the key hidden and not settable; legacy
  shared names still save; the password route needs a session, checks the current and new passwords, changes it,
  answers with a working token, and signs out other sessions.
- **Unit**: `passwordProblem`; the profile's password form (local checks, wrong current password, success) and Log
  out; a taken name on sign up and on the profile; drafts across a reload, per user, cleared; focus on entering a
  room (not on touch screens); Jump to latest scrolled up and back in history; the forward confirmation going away;
  the favicon's label, count and title, with the open room counted while the tab is away (`favicon.test.ts`,
  `unread.test.ts`, `app.test.ts`).
- **E2E** (`accounts.spec.ts`): change the password and log in with it; a taken name at sign up; a draft survives a
  reload and the composer has focus on entering rooms; the title and favicon count unread messages; Jump to latest;
  the forward confirmation going away.

## 23. Room access: private rooms and Open Air

A room's creator chooses who can see it. Three levels, shown everywhere with the same names and icons
(`VISIBILITY` in `web/src/lib/rooms.ts`):

| Visibility | Icon | Who can read | Who can post |
|---|---|---|---|
| **Private** | 🔒 | its members: the creator and the people they added | its members |
| **Public** (the default, and every room from before) | # | everyone with an account | everyone with an account |
| **Open Air** | 🌐 | anyone, even without an account, while the room isn't archived | everyone with an account |

In any of them but a DM, the creator may also narrow who posts to the people they choose (§23.6).

"Open Air" is the name for a room that is readable from the open web: like a talk in the open air, anyone walking by
can listen in, but you need to step up (sign in) to speak.

### 23.1 Data model and rules

`rooms.visibility` (select `public` / `private` / `open`, required) is new; the migration
(`1760000014_room_access.js`) backfills `public`, and `private` for DMs, which are private to their two members.
`rooms.members` (§16.1) now holds up to 100 users (`LIMITS.roomMembers`), and also lists a private room's members.
The rooms hooks keep it consistent on every save (`setMembers` in `pb_hooks/lib/rooms.js`): a private room always lists
its creator first, each member once; any other room lists nobody (switching away from Private drops the list).

With `MEMBER(r)` = `@auth && (r.visibility != "private" || r.members.id ?= @auth || r.created_by = @auth)`:

| Collection | Rule | Value |
|---|---|---|
| `rooms` | list / view | `(visibility = "open" && archived = false) \|\| MEMBER("")` |
| `rooms` | create | as before; `visibility` may be set, `members` may not (a private room starts with its creator) |
| `rooms` | update | as before (creator only, never a DM), but `members` may now be sent; the hooks check it |
| `messages` | list / view | `(room.visibility = "open" && room.archived = false) \|\| MEMBER("room.")` |
| `messages` | create | `MEMBER("@request.body.room.")` instead of §16.3's condition |
| `messages` | update | as before `&& MEMBER("room.")`: someone taken out of a private room can't edit or delete what they wrote there |
| `hidden_rooms` | create | `MEMBER("@request.body.room.")` |
| `users` | view | `""` (anyone): guests see who wrote a message (`expand=author`: name and avatar; never the email). Listing and searching users still needs a session, so nobody can enumerate the accounts. |

Routes and hooks that check a room themselves use `canSee()` in `pb_hooks/lib/access.js`, which mirrors the view rule:
marking a room read, the unread counts' SQL, and the defense-in-depth check in `beforeMessageCreate` (§16.3). The
reaction, delete and forward routes already check the view rules. Attachments are protected (§17.3) and PocketBase
checks the message's view rule for them, so a guest downloads an Open Air room's files without a file token and
nobody else's.

### 23.2 Changing who can see a room

Only the creator, through the rooms API: `api.setAccess(id, visibility, members)` sends both (members only for
Private). In the room header's menu, the creator gets **Room access…**, a modal dialog (`views/room/access.ts`):
three radio cards, **+ Add people** (the user search of §16.5) above a member list with Remove buttons (not for the
creator), a warning that says what the change does ("Everything ever written here … becomes readable by anyone on the
web", "Everyone else loses it from their list", …), and Save/Cancel. The body scrolls between the title and the
buttons, so a long member list or search never pushes them away. Search results are toggles: someone already in shows
"✓ Added", and picking them takes them out again. Telegram stand-ins (§26.3, `no_dms`) are in neither the list nor the
search, since the bridge adds them itself; saving keeps them as members. Escape in the people search closes the search,
not the dialog. In a private room, the other members get **Members (*n*)**: the same dialog, read-only. The new-room
form has a "Who can see it" select, Public by default.

### 23.3 Guests

Without a session the app no longer starts on the login screen. Every route but `/me` is public; `/login` and
`/signup` are only for guests (`guestOnly`). A guest gets:

- the app bar with **Log in** and **Sign up**;
- the room list with only the Open Air rooms (the server lists nothing else to them), without menus, the new-room form,
  DMs, Hidden or Archived;
- rooms read-only: no composer but "You're reading as a guest. Log in or sign up to join the conversation.", no message
  actions, reactions shown but not clickable, no "Message" on authors, and only "Jump to beginning" in the menu;
- a room they can't see says "This room doesn't exist. Log in to see more rooms, …".

Nothing that needs an account is asked for: no unread counts, hidden rows, file tokens or user lookups. Logging in (or
signing up) from a page goes back to that page; logging out goes home as a guest (an expired or revoked session goes
to the login page instead, and back once logged in). Whoever logs in after a logout starts from home (QA BUG-59).
When the session changes to another user or to none, the realtime connection is closed and a new one opened: on the
old one, PocketBase would refuse the new subscriptions and go on sending the previous user's events (QA BUG-66).

### 23.4 Losing (and regaining) access live

PocketBase only sends a record change to the clients that can see the result, so nobody would hear of a room they
can no longer see. After a room is saved, `dropLostAccess()` (`pb_hooks/lib/access.js`) goes through the realtime
clients and sends each one that could see the room before but can't now a `delete` event, with only the id, on its
rooms subscriptions. Saves that don't change access return early (every DM message saves its room). Gaining access
needs nothing new: the update event reaches the new viewer.

On the client, a room that leaves the store while it is open replaces the room view with "You can't see this room any
more." (the messages go too). If it comes back (re-added, unarchived, opened again), or a room shown as "doesn't exist"
becomes visible, the page starts over and shows it (`ctx.reopen`, QA BUG-60). A room that appears (e.g. you were added)
refreshes the unread counts.

### 23.5 Tests

- **Integration** (`room_access.test.ts`): who sees, posts, reacts, forwards, hides and marks read in each kind of room;
  members kept consistent (creator always, deduplicated, cleared off Private, 100 at most, unknown users refused, DMs
  unchanged); only the creator changes access; a removed member can't edit, delete or download; guests read Open Air
  rooms with authors, attachments and live messages, and nothing else; archived Open Air rooms hidden from guests;
  delete events for losing access, update events for gaining it, nothing for anyone else; filters, expands and
  subscriptions by id don't reach into a private room.
- **Unit**: the guest app (Open Air list, header links, no session calls, `/me` asks to log in), a guest reading a
  room, logging in from a room goes back to it; the header's items; the dialog (making a room private, adding and
  removing people, warnings, a failed save, read-only members); losing and regaining access; markers and the visibility
  select in the room list; a guest's room list; QA BUG-61.
- **E2E** (`room_access.spec.ts`): a private room created from the sidebar, a member added in the dialog sees it live,
  others never do, the member sees the read-only list, and is taken out while reading it; a guest reads an Open Air
  room live with its picture, can't write, is told about a room that needs an account, and logs in back into the room;
  an Open Air room leaves and comes back on a guest's screen as it is archived, unarchived and made public. axe checks
  the dialog.

### 23.6 Who can post

Seeing a room and posting in it are two choices. `rooms.posting` (select `everyone` / `selected`, required;
migration `1760000023_room_writers.js` backfills `everyone`) says who posts: everyone who can see the room (as
before; guests never), or only `rooms.writers` (up to 100 users). The hooks (`setWriters` in
`pb_hooks/lib/rooms.js`) keep it consistent on every save: a DM always lets both post; writers are listed only while
posting is `selected`, the creator first, each once, and in a private room only its members (a member taken out stops
being a writer). Writers can't be set when creating a room; only its creator sets them afterwards (the rooms update
rule).

With `WRITER(r)` = `r.posting != "selected" || r.writers.id ?= @auth || r.created_by = @auth`:

| Collection | Rule | Value |
|---|---|---|
| `messages` | create | as in §23.1 `&& WRITER("@request.body.room.")` |
| `messages` | update | as in §23.1 `&& WRITER("room.")`: as in an archived room, someone who may no longer post can't edit or delete what they wrote there (put back, they can) |

Reacting only needs to see the room: readers react. `canWrite()` (`pb_hooks/lib/access.js`) mirrors the rule in
`beforeMessageCreate`, so forwards into the room (`POST /api/chat/forward`) and anything else the app saves are held
to it too, and in `POST /api/chat/delete`. Telegram stand-ins (§26.3) who speak in a linked room are made writers, as
they are made members of a private one: the Telegram group decides who speaks.

On the client, `canPost(room, me)` (`web/src/lib/rooms.ts`) decides. Someone who can see but not post gets "Only some
people can post in this room. You can read along and react." instead of the composer (what they had typed is kept),
no Reply, Edit or Delete, and doesn't get the room as a forward target; Forward and Select stay, to share its messages
elsewhere. A change of writers reaches everyone in the room live (the room's update event), so the composer comes and
goes as it is saved. The access dialog has a second choice under the visibility, **Who can post?**: "Everyone who can
see it" or "Only people you choose", which shows a **Who can post** list like the members list (+ Add people, Remove;
the creator stays). In a private room its search offers only members, and taking someone out of the members takes
them off it too. Members of a private room see the list read-only.

Tests: `room_writers.test.ts` (integration: defaults, who posts, reacts and forwards, a writer taken off, private
rooms, DMs, limits), `api.test.ts` (`setAccess` with writers), `telegram.test.ts` (stand-ins become writers),
`access.test.ts` (unit: the dialog, a reader's room, made a writer live) and `room_access.spec.ts` (e2e, with axe).

## 24. Site settings: branding and invite-only signups

An admin (a PocketBase superuser) sets the site's title and logo, and can make signing up need an invite code. There
is no admin page in the app: it is all in the PocketBase admin UI (`/_/`, *Collections → site*).

### 24.1 Data model and rules

`site` (migration `1760000015_site.js`) holds one record, created by the migration:

| Field | Type | Notes |
|---|---|---|
| `title` | text, required, 1–48 | Shown in the app bar, on the login page and in the tab's title. "Chirkle" at first (a site still titled "Chat", the name before 2026-10-27, takes it: migration `1760000036`). |
| `logo` | file, optional | SVG, PNG, JPEG, WebP or GIF, up to 1 MB, public. Replaces the app bar's speech bubble and sits above the title on the login page. |
| `invite_only` | bool | Signing up needs `invite_code`. |
| `invite_code` | text, **hidden**, ≤ 100 | Only superusers see it. Empty while invite-only: signups are closed. |

List and view rules are `""` (anyone, guests too: the login page needs the branding and whether to ask for a code);
create, update and delete are superusers only. Should a second record be added, the oldest one counts. PocketBase
serves files with a `sandbox` Content-Security-Policy, so an SVG logo can't run scripts even opened on its own.

### 24.2 Invite-only signups

`checkInvite()` (`pb_hooks/lib/site.js`, a users create-request hook) runs before the record is validated. While the
site is invite-only, the request must carry `invite_code` (not a users field, so PocketBase doesn't store it) equal to
the site's, ignoring spaces around it and compared in constant time; otherwise a 400 on `invite_code`:
`validation_required` (none sent), `validation_invalid_invite` (wrong, case-sensitive) or `validation_signups_closed`
(the site has no code). Superusers create accounts as before (the admin UI). Existing accounts log in as before. OAuth2
(off, §14) can't create accounts while invite-only either: `checkOAuth2Signup()` refuses them. The signup rate limit
(§5) also limits guessing.

### 24.3 Frontend

`api.site()` reads the record (`id,title,logo,invite_only`) and `startSite()` (`web/src/site.ts`) puts it in the store
as `site` at startup: the app bar's brand, the login page's heading and the tab's title (§22.4) follow it. It stays when
the session ends. The last one seen is kept in localStorage (`chat.site`), so a reload shows the site's own branding
at once; a failed load keeps what is shown. On the Sign up tab of an invite-only site, an **Invite code** field comes
last, and its errors show next to it. A site made invite-only after the page loaded still refuses the signup, with the
server's message above the button.

### 24.4 Tests

- **Integration** (`site.test.ts`): one public record without its code; only superusers change it; the logo is a public
  image and an SVG one is sandboxed; signups open, needing the code (missing, wrong, wrong case, padded), and closed;
  existing accounts still log in and superusers still create accounts.
- **Unit**: loading, caching and failing to load the site (`site.test.ts`); the app bar, login page and tab title with
  a custom site, kept after logging out; the invite code field, what it sends and its errors (`login.test.ts`).

---

## 25. Measured scale

`tests/perf/scale.ts` seeds a throwaway server and times, through the app's own client, the requests whose cost grows
with the data (`node --experimental-eventsource --no-warnings tests/perf/scale.ts`; sizes from `ROOMS`, `USERS`,
`MESSAGES`, `LISTENERS`). Measured 2026-10-13 on the dev machine (AMD Custom APU 0405: a Steam Deck, 4 cores /
8 threads), 100,000 messages, every room with ≥ 100 unread for the caller (the worst case for §18.2: each count stops
at 100):

| Request | 200 rooms, 50 listeners | 1,000 rooms, 200 listeners |
|---|---|---|
| `GET /api/chat/unread` (§18.2) | 52 ms | 237 ms |
| List rooms | 19 ms | 80 ms |
| Latest page of a room (50 messages) | 10 ms | 10 ms |
| Send a message | 5 ms | 5 ms |
| Send, until every listener has the event (§18.3) | 34 ms | 82 ms |

- **Linear in what grows:** unread counts ≈ 0.24 ms per visible room (worst case), the room list ≈ 0.08 ms per room,
  a message's fan-out ≈ 0.4 ms per connected listener (every open signed-in tab listens to every room it can see).
  Pages and sends don't depend on the size.
- **First to matter:** the unread counts, fetched on load, on every reconnect and after reads elsewhere (debounced).
  Around 4,000 visible rooms one fetch would take about a second of server time; then count only rooms with activity
  since the caller's oldest read, or keep counts per user. Next, the fan-out: at hundreds of open tabs, each message
  costs tens of ms of server time; a thinner event or batching would help (REFACTOR item 26).

## 26. Telegram bridge

A Telegram bot joins Telegram groups, and each group can be linked to a room. What is written on either side shows on
the other, files included, so people in the room and people in the group talk to each other.

### 26.1 A module apart

The bridge is `pb_hooks/telegram.pb.js` (its routes, worker and `tg_*` hooks; its parts of the core's message and user
hooks `main.pb.js` calls through `lib/features.js`, §5.6), `pb_hooks/telegram/` (its code: PocketBase only
runs `*.pb.js` files, so these load only when required) and its own collections, `tg_*`
(`pb_migrations/1760000019_telegram.js`). Nothing in the app refers to it. It reads the app's records, and saves
messages and users through the same hooks as everything else, so trimming, limits, access checks, unread counts and
realtime work for its messages unchanged.

- **On:** `TELEGRAM_BOT_TOKEN` is set. Unset, `telegram.pb.js` registers nothing (the `tg_*` collections stay, empty).
- **Removed:** delete `telegram.pb.js` and `telegram/`. Going down the migration drops `tg_*`. Stand-in users and their
  messages stay, as any user's do.
- **Core changes it needed** were made for themselves: `users.no_dms` (§16.7), and attachments of 10 × 20 MB (§17.1),
  the size of a Telegram album and of the largest file a bot may download.

### 26.2 Settings

All from the environment (`telegram/api.js`):

| Variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot's token from @BotFather |
| `TELEGRAM_WEBHOOK_URL` | this server's public `https://…/api/telegram/webhook`. Unset, the bridge polls (development) |
| `TELEGRAM_WEBHOOK_SECRET` | what Telegram sends with each update; derived from the token when unset |
| `TELEGRAM_API_BASE` | the Bot API server, `https://api.telegram.org` by default (tests point it at a stub) |

On `serve`, the bridge calls `setWebhook` (the URL, the secret, `max_connections: 1` so updates come one at a time
and in order, and only `message`, `edited_message`, `channel_post`, `edited_channel_post` and `my_chat_member`), or, without a URL, `deleteWebhook` (a bot
with a webhook can't poll). The bot needs **privacy mode off** (@BotFather → `/setprivacy` → Disable) or to be a group
admin, or it sees only commands.

A **channel** links like a group. The bot must be one of its admins (with *Post messages*, to send to it). Its posts
and their edits come as `channel_post` / `edited_channel_post` and show under the channel's stand-in.

### 26.3 Telegram people in the chat

Each Telegram sender (or chat posting as itself: an anonymous admin, a channel) gets a **stand-in user** on their
first message (`tg_people` maps the Telegram id to it):

- Named after them with " (TG)": "Ann Lee (TG)", "Ann Lee 2 (TG)" if taken (names are unique, §22.1), within the 32
  characters. A Telegram name change renames it. While the bridge is on, " (TG)" is theirs alone: signing up or renaming
  to a name ending in it ("(tg)", full-width or spaced too) is refused for anyone but a superuser (QA BUG-86).
- Their Telegram profile picture as its avatar, checked again at most once a day.
- `no_dms` set (§16.7): nobody can open a DM with them, and their names have no **Message** menu.
- An address at `telegram.invalid` and a random password: nobody can log in as one.
- They appear in user search like anyone (e.g. to add them to a private room). A stand-in writing in a private room is
  made a member of it, as the messages hook requires (§23).

### 26.4 Telegram → chat

`POST /api/telegram/webhook` (the secret checked, in constant time; any update that fails is logged and answered 200, so Telegram
doesn't hold the next ones back) or polling hands each update to `inbound.js`:

- **A message** in a linked group becomes a message of its sender's stand-in: the text or caption ("↪ Forwarded from
  X" above a forward), and the files, downloaded from Telegram (`getFile`) and saved like uploads: photos (the largest
  size), videos, documents, audio, voice, video notes, GIFs, static stickers. A file over 20 MB, an animated sticker, a
  location, a contact, a poll or a dice becomes a line of text saying what it was.
- **A rich message** (Bot API 10.1, `rich_message`: headings, lists, tables, quotes…) has no text or caption: its
  blocks become plain text (`rich.js`; the room has no markdown, §5): a heading as its line with a blank line above
  it, list items with their labels ("1.", "•", ☑/☐), table rows as cells joined by " | ", quotes as "> " lines, a
  link as its text and address. Its photos, videos, documents, audio and voice notes come over as the message's
  files, their captions in the text where they were. Before this, a rich message was taken for a service message
  and left out without a word.
- **A long message** (Telegram takes 4096 characters, a chat message 2000) comes over as **several messages**, in
  order, instead of cut: each ends at a line break, else a space, in its second half (a text with neither is cut at
  2000). The first has the files and the reply; the rest follow under the same stand-in. `tg_messages.part` (0, 1, 2…;
  `1760000034_telegram_parts.js`) maps them all to the Telegram message, so none goes back to the group, and an edit
  gives each part its new piece: a shorter text deletes the parts left over, a longer one adds parts (after what came
  since). Deleting a later part in the room leaves the Telegram message there; deleting the first deletes it, as for
  any message.
- **A reply** to a message the bridge knows (either way) replies to it in the room.
- **A quote** is part of the text, since the room has no quotes of its own: what a reply quotes comes over its text as
  "> " lines (cut to 500 characters). "↩ In reply to X" goes above it when the room can't show the reply itself (a
  reply to a message the bridge doesn't have), and above any reply to another chat's message (`external_reply`, such
  as a channel's post), quote or not. Edits keep these lines.
- **An album** comes as one update per item. The items wait in `tg_queue` and become **one message** (up to 10 files,
  the caption as its text) when the next update from that group comes, or when the album has been quiet for 1.5 s (the
  worker checks every second).
- **An edit** edits the message's text. Telegram doesn't tell bots about **deletes**, so a message deleted in Telegram
  stays in the room (a known limit).
- The same update delivered twice (a webhook retry) comes over once (`tg_messages` knows it).
- The message and what it maps to are saved in one transaction, so the worker never sees a message from a group
  without knowing it came from there.
- Joins, leaves, pins and title changes are left out, as is any service message with nothing to show (a new group
  photo, a timer, a topic): those make no stand-in (QA BUG-88). In a private chat with the bot, it says it works in groups.

### 26.5 Linking

`tg_links` has a row per group: `chat_id`, `title`, `room`, `enabled`, `anonymous` (§26.6). When the bot is added to a group (or first
hears from it) it makes the row, disabled and without a room, and posts the group's chat id. **A superuser links the
group in the admin UI** (*Collections → tg_links*): pick the room, tick `enabled`. `/chatid` (or `/start`) in the group
says whether it is linked. A DM can't be linked, a link can't be enabled without a room, and a group that removes the
bot is disabled. A room may be linked to several groups: each one's messages go to the others too. A group that
becomes a supergroup (a new chat id) keeps its link and its queue, whichever of Telegram's two notices (in the old
group, in the new) comes first (QA BUG-89). An archived room, or a disabled link, passes nothing either way.

The room says when a group starts or stops passing messages to it, in a service message (§5.3): "Telegram group "Friends" was connected to this room." when a link gets enabled with a room (created so, ticked, or moved to it), "… was disconnected from this room." when it stops (unticked, moved to another room, or deleted), and "… was disconnected from this room: the bot was removed from the group." when the group removes the bot. An archived room is told nothing. A title change or a group becoming a supergroup says nothing. The title is tidied like a name (no bidi overrides or line breaks), and a blank one reads "A Telegram group". The same news delivered twice at once (the bot removed, a link unticked) tells the room once: the link is read again in the save's transaction.

### 26.6 Chirkle → Telegram

The messages hooks only **queue** the work (`tg_queue`, in the same transaction as the save): a new message, an edit
of the text, a delete, for each group the room is linked to. The worker sends it, so nobody's request waits for
Telegram (`outbound.js`):

- **The message** goes as the bot, with the author's name in bold over the text (Telegram HTML, escaped): "**Bob**
  hello". A forward says "*forwarded from Ann*" and shows its original's text and files (§21.3).
- **Anonymous links:** a link with `anonymous` ticked (admin UI, next to `enabled`;
  `1760000035_telegram_anonymous.js`) reposts to its group without the header: no author's name and no "forwarded
  from", only the text and files, so the whole 1024 characters are the caption's. Its edits follow the same way; the
  setting is read at each send and edit, so changing it affects what comes next, not what was sent. A forward with
  nothing left to show (its original deleted) isn't sent. It only changes what goes to that group: other groups of
  the room, and what comes from Telegram, are as before.
- **Files:** photos (jpg, png, webp up to 10 MB, Telegram's photo limit) and videos (mp4, m4v, mov; sent with `supports_streaming`, so they play inline as they load) go together as an album,
  other files as a second album of documents (Telegram doesn't mix them); one file goes alone. The text is the first
  item's caption when it fits (1024 characters), else a message of its own before the files. Files keep their original
  names.
- **A reply** replies to the Telegram message of what it answers, when that is in the group.
- **Edits** edit the Telegram message holding the text (or the caption, its text cut to 1024 characters with "…" when
  the edit made it longer: QA BUG-87). **Deletes** delete the Telegram messages;
  bots can delete their own only for 48 hours, so an older one is edited to "*Message deleted*" instead.
- A message from a group isn't sent back to it.
- Not passed on: reactions, service messages (§5.3), and a forward's later changes when its original is edited.

### 26.7 The worker

A cron job (`* * * * *`) starts `worker.js`, which runs for 57 s, once a second: it brings over albums that are
complete, then sends what is queued, oldest first (polling Telegram first, when there's no webhook). One run at a time
(a lock in the app store, renewed after every item; a run that took over a stale lock is the only one to let it go,
and the slow one stops at its next item). Each queued send is claimed first (`locked_until`, 10 min, in a
transaction): even two passes at once never send one twice (QA BUG-147). An album item delivered twice is brought
over once, not making the album's save fail. A failure that may pass (no answer, 5xx, 429) is retried after `retry_after` or 2, 4, 8…
seconds, up to 8 tries, and holds back that group's later items so they arrive in order; one Telegram refuses for good
(4xx) is dropped and logged. `POST /api/telegram/tick` (superusers) runs one pass at once. A message whose send fails
halfway (some of its files sent) isn't sent again.

### 26.8 Tests

`tests/integration/telegram.test.ts` starts its own PocketBase with the bridge on, against a stub Bot API
(`tests/support/telegram.ts`: records calls, serves files, queues updates, fails on demand). The harness never passes
the developer's own `TELEGRAM_*` variables to a test server. Covered: setWebhook and the secret; a new group's link
and `/chatid`; links only for rooms; a stand-in (name, picture, `no_dms`); files, an album as one message (by the next
update, and once quiet), files too large; replies, edits and a repeated delivery; a stand-in joining a private room; a
message, reply, edit and delete going out; an anonymous link's (no header, a whole caption); service messages for a group connected, disconnected, moved, deleted and removing the bot; files going out as an album with a caption plus documents; a room linked to
two groups; retries in order and dropping; nothing while disabled or archived; polling.

---

## 27. Installable app (PWA)

The app can be installed (Add to Home Screen, the browser's Install button) and opens offline to its shell. No push
notifications and no offline data: what the server says is fetched as before (the room cache, §7.5, only shows
a room's last page while it loads; it isn't used offline).

### 27.1 Manifest and icons

- `GET /manifest.webmanifest` (`manifest()` in `pb_hooks/lib/site.js`) is built per request: `name` and `short_name`
  are the site's title (§24), so the installed app is named like the site. `start_url` and `scope` are `/`,
  `display: standalone`; `theme_color` is the app bar's (`--surface`) and `background_color` the page's (`--bg`),
  light theme (a manifest has one of each). `application/manifest+json`, `no-cache`, like every page (§5.6).
- **Icons** (`web/public/icons/`, copied to `pb_public/icons/` by `build` and `dev`): the speech bubble as `icon.svg`,
  192 and 512 px PNGs, a 512 px maskable one (the bubble inside the safe zone, on `--surface`) and a 180 px
  `apple-touch-icon.png` for iOS (opaque: iOS fills transparency with black). The site's logo isn't used: it may be
  any image, an SVG or a small one, and an installed app needs square PNGs.
- `index.html` links the manifest and the Apple icon, and sets `theme-color` for light and dark.

### 27.2 Service worker

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

### 27.3 Tests

- **Integration:** the manifest is named after the site and lists its icons (`site.test.ts`); `/sw.js` is served
  `no-cache` (`http.test.ts`).
- **E2E** (`pwa.spec.ts`, Chromium): the manifest and every icon load with the right type; once the worker controls
  the page, a page loaded offline still shows the app. A thumbnail is kept once and then served for another token of
  the same user (one the server refuses), not for another user's; logging out deletes the cache. Other specs run with service workers blocked
  (`playwright.config.ts`): the worker fetches hashed assets itself, out of reach of `page.route()`.

---

## 28. Link previews

Under a message, a line for each link in its text: the page's favicon and title, opening the link in a new tab like
the link in the text (§7.6.3).

### 28.1 Data and the worker

- **`messages.previews`**: `[{ url, title, icon }]`, in the order the links come in the text. `icon` is a `data:` URL
  ("" when there is none), so nothing is hotlinked (the CSP allows only `data:` and the app's own images) and nobody's
  browser tells a site who reads the room. Set by the server only: create and update rules refuse it in a body, the
  hooks set `[]` on create, on an edit of the text and on delete, and an edit keeps the stored ones otherwise (as for
  reactions, §20.2). A forward shows its original's (`showOriginal`), and gets saved again when they arrive, like an
  edit of its original (§21.3).
- **Queue:** a new message with links, or an edit of the text, adds a `link_queue` row in the save's transaction.
  A cron job (`* * * * *`) runs `pb_hooks/lib/previews.js` for 57 s, once a second (one run at a time, a lock in the
  app store, renewed after every message: a pass can outlast the minute, QA BUG-111; the loop and lock are
  `lib/worker.js`, shared by every worker: a run whose lock was taken over stops, and leaves the new run's lock alone); `POST /api/previews/tick`
  (superusers) runs it at once. Each message: its links (found as `linkify` finds them, each once, at most 5), fetched
  one at a time, for 12 s at most (the links after that get no line); a host that doesn't answer (a timeout, a refused
  connection) isn't asked again for that message. So a message linking to sites that never answer holds up the queue
  for ~12 s, not minutes. The previews are saved in a transaction unless the text changed meanwhile (the edit queued it
  again). Everyone sees them live, as an update. A link that fails gets no line and isn't tried again.
- **Fetching:** with `curl` (`$os.cmd`, as ffmpeg in §30.1; `$http.send` follows redirects anywhere and reads a whole
  response into memory: a page that ignored `Range` took 1.1 GB). The page with `Range: bytes=0-262143` (4 s timeout,
  redirects included), `text/html` only, its UTF-8 or Latin-1 text. Only the start of a response is read (256 KB of a
  page, 16 KB + 1 byte of an icon), from curl's output, and then curl is stopped, whatever the site sends. The page
  is read in one pass (its `<meta>`/`<link>` tags, attributes and `<title>`), never with a regex that tries again
  from every `<`: a page of unclosed tags kept the worker busy for minutes.
  The title is `og:title`, else `<title>`, entities decoded, cleaned like a name (`tidy`: no control, invisible or
  bidi characters, QA BUG-110), whitespace collapsed, at most 200 characters; no title, no line. The icon is the first `<link rel="… icon …">`, else `/favicon.ico` (3 s), an image of at most 16 KB, its
  type as served or sniffed (PNG, ICO, GIF, JPEG, SVG).
- **Where the server may go** (server-side request forgery): http(s) on the default port, a public IPv4 address or a
  name with a dot whose last label is letters and isn't a local one (`localhost`, `.local`, `.internal`, `.lan`,
  `.home.arpa`…); no userinfo, no IPv6 literals, no single-label names (Docker service names), only ASCII
  names (no IDN: `getent` wouldn't find them). A name is looked up first (`getent ahostsv4`, 3 s) and refused when any of its
  addresses isn't public; curl then connects to the address checked and no other (`--connect-to`), so a name that
  answers differently the second time can't send it inward. No proxy, no `~/.curlrc`, no URL globbing. IPv4 literals
  in plain decimal only (`0177.0.0.1` is 127.0.0.1 to curl). Redirects (at most 3) are followed by the worker, each
  checked like a link. Without `curl`, `getent` or `timeout` (looked up once), links get no previews.
- **Settings:** `LINK_PREVIEWS=off` turns it off (test servers default to off, so tests never fetch what they link
  to). `LINK_PREVIEWS_ALLOW_HOSTS` (comma-separated `host` or `host:port`) lets hosts through the checks: tests.

### 28.2 Frontend

`MSG_FIELDS` asks for `previews`. Under the text and attachments, `ul.previews`: per line an `<a>` (same `target` and
`rel` as text links, the URL as its title) with a 16 px `<img alt="">` and the title, one line cut with an ellipsis.
Only `http(s)` URLs and `data:image/` icons are shown. An edit clears them at once (optimistic), until the new ones
come.

### 28.3 Tests

- **Integration** (`previews.test.ts`, its own PocketBase with previews on, a stub site): titles (og:title first,
  entities, Latin-1) and icons (the page's, `/favicon.ico`, too big); each link once; no line for an untitled page or a
  PDF, none past the 5th link; clients can't set them; an edit replaces them and a delete clears them; a forward shows
  its original's; local and private addresses are never fetched; redirects are followed, never inward and at most 3;
  only the start of a huge page or icon that ignores `Range` is read; a page of tags that never end is quick.
- **Unit** (room view): lines with favicon and title; a `javascript:` URL and a non-`data:` icon left out; titles as
  text.

## 29. Message search

A search button (🔍, "Search messages") in the header of every room and DM opens a bar under it: type, and the
room's messages containing **every word** typed show newest first, 50 at a time ("Show older results"). Picking one
goes to it in the room, highlighted and centred, loading the history around it like a reply's quote (§19.3); the
results make way, and come back when the field gets focus again. Escape or × closes the bar and gives focus back to
the button. Guests can search the Open Air rooms they read.

### 29.1 Data and query

- **`messages.text_key`**: the text folded like names are compared (§22.1: `nameKey`: no invisible characters, NFKC,
  upper then lower case), so "привет" finds "Привет", "strasse" "Straße" and "abc" "ＡＢＣ"; SQLite's `LIKE` alone only
  ignores the case of ASCII letters (QA BUG-55). One step more than names (`searchKey`): "İ" lowercases to "i" and a
  combining dot, which goes, so "istanbul" finds "İstanbul" (QA BUG-113; migration `1760000025_search_dotted_i.js`
  re-keys what was stored before). Set by the hooks after every other change on create and update (`setTextKey`),
  whatever a client sent: empty once deleted. Not hidden, so the list API can filter on it with its
  rules applied (nobody can search a room they can't read); `MSG_FIELDS` never asks for it. Max 40,000 characters (NFKC
  can make a 2,000-character text longer). Migration `1760000024_message_search.js` backfills it with raw SQL.
- **Query** (`searchQuery` in `views/room/search.ts`): a page of the room (§6) with `q`, the words: `kind=latest`, then
  `kind=older` from the last result's `(created, id)` for the next page, as history pages are (§7.5). The server
  (`lib/lists.js`) writes `room = {:room} && text_key ~ {:w0} && …`: up to 5 distinct words, folded as `text_key` is
  (`searchKey`; the client folds them too, `foldKey`, to mark the matches), with `%` and `\` (the escape character)
  escaped (QA BUG-34, BUG-112; `_` already is). Until 2026-10-29 the clients wrote that filter; apps then still do with
  a server from before the route.
- **Not found:** forwards (their text is their original's, shown in the answer only, §21.3), attachment names and
  link titles.
- **Cost:** `LIKE '%…%'` can't use an index, so a search reads the room's messages through
  `idx_messages_room_created` until it has a page: a common word stops early; a word in no message reads them all.
  Measured 2026-10-18: a no-match search of a 20,000-message room takes 12 ms in SQLite itself, 30–150 ms through the
  API on the dev machine; a search with a page of matches costs as much as a history page. Past a few hundred thousand
  messages a room, FTS5 behind a custom route (it would have to apply the list rule itself) is the next step.

### 29.2 Frontend

`views/room/search.ts` is a lazy chunk like the viewer (§17.7): imported on the first click, types only, and given
`h`, `api.page`, the time format and `goTo` by the room view; if it can't load, the notice says so. Typing searches
300 ms after the last key (Enter at once); a new search aborts the one in flight. A result is a button: author, time,
and the text on two lines starting shortly before the first match, matches in `<mark>` (built with `h`, never HTML).
The field is a `role=searchbox` text field (not `type=search`: browsers add their own clear "×" next to Close,
QA BUG-114) in a `role=search` region, the count in a `role=status` line ("3 messages found.",
"50+ messages found.", "No messages found.", "Couldn't search. Check your connection."). Results don't follow live
changes; searching again does.

### 29.3 Tests

- **Integration** (`search.test.ts`): `text_key` follows create, edits and deletes and ignores what a client sends;
  every word in any case, Unicode included, newest first, one room only (each search also through the old filter, which
  must find the same); the server folds and splits what it is sent; paging from a cursor; `%` and `_` literal;
  deleted messages not found; nothing found in a DM or private room you aren't in, guests only in Open Air rooms.
- **Unit** (`views/room/search.test.ts`): folding, words, the query, snippets; in the room view, results, going to
  one far back in history, the empty state, "Show older results", Escape.
- **E2E** (`search.spec.ts`): a Cyrillic search in any case goes to a message 200 back (axe: no serious violations);
  a DM's search finds only its own messages.
- **Perf** (`tests/perf/scale.ts`): a room searched for a word in none of its messages, and for one in all.

## 30. Media grid

A button (🖼️, "Media") in the header of every room and DM, next to search (§29), opens a modal dialog with the
room's images and videos as a grid of square tiles, **newest first** under month headings ("October 2026"), so one
sent long ago is quick to find without scrolling the history. Scrolling to the end fetches older ones (60 tiles a
page). A tile opens the viewer (§17.7) over the grid, stepping through the grid's images and videos (oldest first, as
the viewer always does) and fetching older ones as it nears them; closing the viewer comes back to the grid with focus
on the tile. "Show in chat" in the viewer closes both and goes to the message, as from a thumbnail in the list.
Escape or × closes the grid and gives focus back to the button. Guests can open it in the Open Air rooms they read.

### 30.1 Data

- **Index:** the `media` collection (migration `1760000029_media.js`, no API rules), one row per image or video a
  room shows: `room`, `message` (the one in the room), `source` (whose file it is: the message, or a forward's
  original, §21.3), `file`, `pos` (its place in the source's files), `video`, `sent` (the message's `created`),
  `ready` and `poster` (below). The messages hooks keep it (`pb_hooks/lib/media.js`): a new message adds its rows in the
  save's transaction, a delete takes out its rows and its forwards', and the relations cascade when a message or room
  goes for good. Image and video are by extension, as in `lib/files.ts`. The migration fills it from the messages there
  are. Before it the grid paged through the room's messages (`withFiles`, 50 at a time, with the list rule, expands and
  the enrich hook), for a few tiles a page.
- **Page:** `GET /api/chat/media/{room}?sent=&message=&pos=&limit=` (`api.media`): rows older than the last one shown
  (or the newest), newest first, a message's files last to first, 60 a page (at most 100), with the file's original name
  and the author's id and name, and `more`. The room is checked once (`visibleRoom`, §23: guests in Open Air rooms);
  404 for a room you can't see. One query on the index `(room, sent, message, pos)`.
- **Thumbnails:** a `240x240` thumb (cropped to the square, centred), added to `messages.files` by migration
  `1760000028_media_grid_thumbs.js`; the fitted thumbs of §17.5 would be blurry once cropped. A tile that fails to load
  tries once more with a new file token.
- **The worker** (`lib/media.js`, a cron job like the previews' (§28.1): 57 s a minute, one run at a time;
  `POST /api/media/tick` for superusers runs it at once; `MEDIA_CRON=off` leaves it to that, as tests do): takes the
  rows not `ready`, newest first (so a new upload goes before the migration's backlog), and makes what they need before
  anyone asks. PocketBase makes a thumbnail on its first request, so a grid opened over old images had the server
  decode and resize dozens at once. An image gets the grid's thumb, and for a message from the last 7 days the room's
  too (a GIF only the grid's: the room shows the file, §17.5); avif none (PocketBase serves it as it is). A video gets a
  **poster**: its first frame, fitted in 800×480 in its own shape and never enlarged (the room's large tile, §17.5),
  JPEG, from `ffmpeg` (`FFMPEG`: the command, default `ffmpeg`;
  `off`, or not installed: no posters), stored as `thumbs_{file}/poster.jpg` next to the file, so PocketBase deletes
  it with the file; then the source's rows and its forwards' say `poster`. ffmpeg reads only the local file
  (`-protocol_whitelist file`, the container's own demuxer forced by extension, so a "video" that is a playlist reads
  nothing else), on one thread, stopped after 20 s (`timeout`). A video kept in S3 has no local path: it is copied to the temp folder first (Go copies it,
  never through JS) and the copy removed after, so each video is downloaded once. Each file is tried
  once. After each one the worker rests as long as it worked: at most half of one CPU.
- **Posters:** `GET /api/chat/posters/{message}/{file}?token=`, the URL of the video with its token on another route.
  Checked as PocketBase checks the file (§17.3): the file token's user against the message's view rule; 404 otherwise,
  and until the poster is made. `Cache-Control: private, max-age=2592000`; the service worker keeps them like
  thumbnails (§27.2).
- Not live: what is posted while the grid is open shows the next time it opens.

### 30.2 Frontend

`views/room/media.ts` is a lazy chunk like search: imported on the first click, types only; the room view passes it
`api`, `h`, the file-name helpers and `viewImage` (which takes the grid's list, its "more before" flag and a callback
that closes the grid). It links `styles/media.css` (hashed, its URL in the `MEDIA_CSS` define) and opens once that has
loaded, like the viewer; if the chunk can't load, the notice says "Couldn't open media. Check your connection.". The
dialog follows the theme (unlike the viewer) and fills the window on narrow screens. Like the viewer it adds a history
entry with the same URL: Back closes it (and from the viewer over it, closes just the viewer); closing it from itself
goes Back off its entry, and after "Show in chat" waits for the viewer's own Back first. An entry with no grid open on
it (a reload while it was open, Forward after Back closed it) is passed over by the router, as the viewer's is (QA
BUG-118). The viewer gets messages made from the rows (id, room, author, `created`, the file names, `forward_of` for a
forward's), which is all it and "Show in chat" use. A video's tile is its poster (cropped to the square by
`object-fit: cover`, like the images' `240x240`), or until there is one a plain tile
with ▶ in the middle: never the video, which every browser would start fetching (`preload="metadata"`); a poster that
fails twice leaves the plain tile. A tile is a button named "file name[, video], author, date". The status line says "Loading…", "No photos or
videos here yet." or "Couldn't load media." with Retry; until Retry, the end of the grid doesn't ask again (QA BUG-116).

### 30.3 Tests

- **Integration** (`media.test.ts`): the page (media only, newest first, files last to first, paging by the cursor);
  a forward's tiles, and none once the original is deleted; 404 for outsiders of a private room and for guests outside
  Open Air; the query plan uses the index with no sort; the worker's thumbnails (all for a recent message, the grid's
  for an old one); a poster made with ffmpeg (skipped without it, except in CI, which installs it), served with the
  file token to those who may see the video, a forward's readers too, in the video's shape and not enlarged, and gone
  with the file; no poster for an image
  or another message's file; the migration's backfill (media only, a forward's from its original, none of deleted ones).
  `media.s3.test.ts`, its own PocketBase on an S3 server (versitygw serving a temp folder, `tests/support/s3.ts`;
  skipped without it or ffmpeg, except in CI): the poster and thumbnails land in the bucket, no temp copy is left, the
  poster is served, and it goes with the file.
- **Unit** (`views/room/media.test.ts`): newest first, a message's files in reverse, month headings across pages, the
  next page at the end, no more after the last; a video's poster or plain tile, never a `<video>`; the empty state;
  Retry; Escape and focus; one grid at a time.
- **E2E** (`media.spec.ts`): images 120 messages back, opened in the viewer ("2 / 3"), Escape and Back back to the
  grid, "Show in chat" loads the message and leaves no history entry; Back and Escape close the grid; axe: no serious
  violations; an empty room says so.

## 31. Media collections

A user keeps images and videos in **collections** of their own, public or private. Any image or video of the chat can
be saved to one (the collections icon on a tile, or in the viewer), and anything in a collection can be attached to a
message. Others can **subscribe** to a public collection, use what is in it, and see what has been added since they
last looked. Collections are listed in the sidebar. Decisions: §13 (2026-10-21).

### 31.1 Data (`pb_migrations/1760000030_collections.js`)

- **`collections`:** `owner` (cascade with the user), `name` (1–60 characters, unique among the owner's whatever the
  case: `name_key`, hidden, as `nameKey()` folds it), `public`, `items` and `last_added` (kept by the routes below).
  Rules: list and view `public = true || owner = @request.auth.id` (guests see public ones); create with yourself as
  `owner`, update and delete by the owner, never `owner`, `items`, `last_added` or `name_key` from a request body. The
  hooks (`lib/collections.js`) clean the name and refuse a 51st collection.
- **`collection_items`:** `collection` (cascade), `file` (one, **protected**, 20 MB, the thumbs of `messages.files`),
  `name` (the original file name), `video`, `poster`, `ready` and `origin` (hidden: which message file, `m:<id>/<file>`,
  or item, `i:<id>`, it was copied from), `created`. Unique `(collection, origin)`: a file is in a collection once,
  however it came. Rules: list and view `collection.public = true || collection.owner = @request.auth.id`, which is
  also what a file token is checked against (§17.3); no writes but the routes'. At most 2,000 per collection.
- **`collection_subs`:** `user`, `collection` (both cascade), `seen_at`. Unique `(user, collection)`. Rules: your own
  rows only, written by the routes (as `room_reads`, §18.1). At most 200 per user.
- **`messages.file_sources`:** stored file name → the collection that file was attached from. Set only by the create
  hook (the rules refuse it in a body, `beforeMessageCreateRequest` backs that up); never changed by an edit; emptied
  with the files by a delete; a forward shows its original's (`showOriginal`, §21.3).
- Rate limits: `collections:create` 10 per 60 s, `POST /api/chat/items` 30 per 60 s, `POST /api/chat/subs` 60 per 60 s.

**Saving copies the file** (and attaching copies it again, into the message). A collection item doesn't point at the
message: its file would follow the message's room rules (a subscriber couldn't see a file saved from a DM) and its
lifetime (a delete wipes it, §17.1). So an item outlives the message it came from, and a message outlives the item
and the collection it was attached from: the media grid, the viewer, forwards and the Telegram bridge see an ordinary
file. The copy is Go's. A save copies the stored file straight into the new item's folder (`fs.copy`; in S3 that is
CopyObject, so the bucket copies it and PocketBase neither downloads nor uploads it) and saves the item without
PocketBase's validation, which takes only uploads as a new record's files (every field is the route's own); a save
that loses the race to the unique index removes its copy. An attach adds uploads to the message being created:
PocketBase reads the stored file from its path (`$filesystem.fileFromPath`), or, kept in S3, from a copy in the temp
folder (`media.js` `tempCopy`), removed once the save is done. A video's poster comes along
when the file it was saved from has one; otherwise the media worker (§30.1) makes the item's grid thumbnail or poster.

### 31.2 Routes (`pb_hooks/lib/collections.js`)

- **`GET /api/chat/collections`** → `{ mine, subs }` by name: yours, and the public ones you follow with their owner,
  `seen_at` and `new` (items added after `seen_at`, at most 100, one range scan each on `(collection, created)`).
  One that turned private is left out but its row kept: public again, it is back.
- **`POST /api/chat/items`** `{ collection, message, file }` or `{ collection, item }` → the item. Yours only (403
  for someone else's you can see, 404 for one you can't); a message file you can see by the messages **view** rule (a
  forward's reader saves its original's, §21.3), not deleted, an image or video; or an item you can see. 409 when it
  is in there already. As multipart `{ collection, file }`: an image or video of your own (20 MB at most) uploaded
  straight into a collection of yours, a new item with no `origin` (two uploads of one file are two items); an image
  over 25 megapixels is refused as an attachment is (QA BUG-140), and its name cleaned as one's (QA BUG-149).
  `DELETE /api/chat/items/{id}`: the owner takes one out.
- **`GET /api/chat/saved?message=&file=`** (or `?item=`) → `{ collection: item }`: which of your collections have it.
  `{}` for an item that isn't there or that you can't see (QA BUG-148).
- **Attaching:** a message create may name items (`items`, their ids: a JSON list in a form). They must be yours or in
  a public collection; their files are added after the uploads (10 in all), copied, with their names in `file_names`
  and their collections in `file_sources`.
- **`GET /api/chat/badges?ids=`** → per id `{ name, public, mine }` for a public collection or your own, `{ private:
  true }` for someone else's private one, `null` for one that is gone. Guests too.
- **Realtime topic `chat/badges`:** once a collection is saved public or private, renamed, or deleted, every client
  listening (guests too) gets `{ id }`, after the save is committed (`onRecordAfterUpdateSuccess`/`DeleteSuccess`), so
  asking `/badges` at once reads the new state. Only the id: what each may see, `/badges` says. The collection's own
  record events wouldn't do: PocketBase sends a change only to those who can see the result.
- **`POST /api/chat/subs`** `{ collection, on }`: follow someone else's public collection (seen up to now), or stop.
  **`POST /api/chat/subs/seen`** `{ collection, at? }`: as `/reads` (§18.2), forward only, never past now.
- **`GET /api/chat/posters/items/{item}/{file}`**: an item's video poster, checked like the file (§30.1).
- A collection turning private (or public again) saves its subscribers' rows again, so they hear of it live.

### 31.3 Client

- **The icon:** a picture with another behind it, drawn by CSS (`.ci`, a mask of an inline SVG, so it takes the text
  color; `ui/icon.ts`). Every collection button is the icon alone, named for screen readers: Save to collection (on
  a tile, top right, shown on hover and focus, always on touch screens; in the viewer's bar), Attach from collections
  (in the composer, next to +), and the sidebar rows.
- **State:** `collections.ts`, started with the session like `unread.ts`, keeps `AppState.collections`. It refetches
  (debounced 250 ms) on a change of any of yours or those you follow (one realtime subscription on `collections`,
  filtered to those ids, renewed when they change: a public collection's changes never reach everyone) and of your
  `collection_subs` rows, and on reconnect.
- **Sidebar:** a Collections section after Direct messages: yours (🔒 when private), then those you follow with their
  owner's name and a badge of new items (`99+`, " new" for screen readers). "+" opens the new-collection dialog.
- **The page, `/c/:id`:** in the room pane, the sidebar kept. Its name, whose it is, Public or Private and how many
  items; the owner can upload images and videos into it (Upload, several at once, dropped on the page or pasted: one at a
  time with the percentage sent, what isn't an image or video or is over 20 MB named and left out, a rate limit
  waited out), rename it, make it public or private and delete it (confirmed); others Subscribe or
  Unsubscribe. The items as square tiles, newest first under month headings, 60 at a time (the records API, cursor
  on `(created, id)`). Items added since your `seen_at` have a ring and a dot, and "*n* new since your last visit" says
  how many; once they are on screen in a visible tab the page sends `seen` with the newest item's `created`, and the
  badge goes. A tile opens the viewer (§17.7, without "Show in chat"); the owner can remove one, anyone signed in save
  one to their own collections. The page follows the store for a collection of yours or one you follow: what is added
  meanwhile comes in at the top, marked new and seen at once (no badge for the page you are on); a rename or a change
  of Public shows; made private or deleted, it says it doesn't exist. Narrow screens get "← Rooms" (as a room, §7.8).
- **Saving** opens a menu of your collections, ticked where the file is already (`/saved`): tick to add, untick to
  take out, or make a new (private) one there. Public ones say so: a file saved from a private room or a DM into a
  public collection is then anyone's to see (§13).
- **Attaching:** the picker lists your collections and those you follow; pick up to what the message still takes
  and they join the tray (after the uploads, as the server attaches them), "From a collection". The pending message
  shows their thumbnails; Retry sends the same ids.
- **The badge:** a file with a `file_sources` entry gets a chip over its tile, bottom left: the icon and the
  collection's name, a link to it, if it is public or yours (yours private: 🔒 after the name); "Private collection",
  not a link, if it is someone else's private one; nothing if it is gone. The room view asks `/badges` once for the ids
  a render shows that it hasn't asked about, and draws again when the answer comes (a message's signature includes
  its badges). Made public or private, renamed or deleted meanwhile, a badge follows live: the room listens to
  `chat/badges` once it shows one and asks again about the ids it shows (the old badge stays until the answer), and
  about all of them after a reconnect.
- **Loading:** `views/collection/lazy.ts` (the page, the save menu, the picker and the new-collection dialog:
  `page.ts`, `save.ts`, `picker.ts`, `create.ts`, with their requests in `calls.ts`, through `api.request`) is a lazy chunk with its own stylesheet, `styles/collections.css`
  (`COLLECTIONS_CSS`), imported on first use by `views/collection.ts`. In `app.js`: the service, the sidebar section,
  the badge and Save on tiles, the composer button and the route.
- Guests read public collections and see badges, but can't save, subscribe or attach.

### 31.4 Tests

- **Integration** (`collections.test.ts`): names unique per owner whatever the case; counters, owner and limits kept
  by the server; who sees which collection and item file (owner, others, guests; public and private); saving (a copy
  that outlives the message, the original name, 409 twice, only media, not deleted, only what you can see, a
  forward's original, copying an item, saved at once: one copy kept); uploading (yours only, media only, 20 MB, its
  thumbnail, then saved and attached as any item); `/saved`; removing; attaching (after uploads, names, `file_sources`, the room's
  rules for the copy, JSON and form bodies, forwards, only yours or public, no `file_sources` from a client, 10 at
  most, cleared by a delete); badges, and `chat/badges` (made public or private, renamed, deleted: the id, the new
  state readable at once; nothing for other saves); subscriptions (not your own, not private, new counts, seen, unsubscribe; turned
  private: hidden and told live); the count's query plan; item thumbnails and posters (copied along, or made by
  ffmpeg, served by the item's rules). `media.s3.test.ts`: saving a video and attaching it back with S3, poster
  included, no temp copy left.
- **E2E** (`collections.spec.ts`): make one from the sidebar, save from a tile, its page; another user subscribes,
  sees "1 new" live, opens it with the new item highlighted and the badge gone; attaches it from the picker and the
  message's badge links to it; made private, the badge says "Private collection" (not a link) to others and still
  names it to the owner, live; public again and renamed, both badges follow without a reload; axe on the page. Saving and unsaving from the viewer. Uploading with the button (a PDF
  refused by name) and by dropping; no Upload on someone else's.

## 32. Jump to

**Ctrl+K** or **Ctrl+P** (⌘K, ⌘P on a Mac) anywhere in the app, the composer included, opens a "Jump to" dialog: a
field and the rooms, DMs and collections you can go to. Typing narrows the list; ↑/↓ choose (wrapping), Enter or a
click goes there, Escape, a click outside or the shortcut again closes it. The browser's own meaning of those keys
(the search bar, printing) is prevented; Ctrl+Shift+P (a private window) and anything with Alt are left alone. On a
layout that types no Latin letter there (Cyrillic: Ctrl+Л) the key's place counts (`KeyK`, `KeyP`). Guests jump
between the Open Air rooms.

- **What is listed:** the sidebar's rooms, open DMs (titled after the other member, with their avatar) and your
  collections and those you follow, from the store: no request. Hidden and archived rooms are found when typed for,
  marked "Hidden" / "Archived", after the others that match as well. Unread rooms and collections with new items
  carry the sidebar's badge.
- **With nothing typed:** most recent first, by the later of a DM's latest message (`last_message_at`; rooms have
  none, §16), a collection's latest item or a room's creation, and when it was last open in this tab (`app.ts`
  notes it as you go, forgotten on reload and when the session changes); the page you are on last: Ctrl+K Enter goes
  back to where you were before. At most 50 shown, where you are still last.
- **Matching** (`matches` in `views/switcher.ts`): names folded (case, accents, width: "ete" finds "Été"), a leading
  `#` or `@` ignored. Best first: the whole name, its start, a word's start (`ops` in `dev-ops`), inside a word, then
  its letters in order (`gnrl`); then not hidden or archived, then most recent.
- **Accessibility:** a modal `<dialog>` named "Jump to"; the field a `combobox` controlling a `listbox` of options,
  the chosen one by `aria-activedescendant`, so focus stays in the field; "Nothing found." in a `role=status` line.
  Closing gives focus back to where it was; going to a room focuses its composer as usual (§22.5).
- **Loading:** `views/switcher.ts` is a lazy chunk like search (§29), imported on the first press and appended to the
  app's root (removed with it). Types only; `app.ts` gives it `h`, the store, `roomSections`, `unreadCount`,
  `otherMember`, the visibility icon, the avatar, `navigate` and when each page was last open. It closes when the
  session changes (logging out, another account), and a held-down shortcut doesn't toggle it on every repeat. Its few styles are the forward dialog's (§21.3) plus
  a chosen option, in `selection.css`.

### 32.1 Tests

- **Unit** (`views/switcher.test.ts`): folding, ranking, the empty-query order (most recent, current last, no hidden
  or archived), `#`/`@`, notes and badges; the dialog: focus, arrows wrapping, Enter, click, "Nothing found.",
  opening again starts empty. `app.test.ts`: Ctrl+K from the composer (by key place on a Cyrillic layout), ⌘P again
  closes, a repeat ignored, Ctrl+Shift+P and plain K ignored, Enter goes to the room, Ctrl+K Enter back to the room
  before (a newer room never opened notwithstanding), closed on logout, nothing after the app stops.

---

## 33. Linked instances

Two or more servers running this app, **paired by their admins**, share rooms and let their people write DMs to each
other. Ann on `a.example` and Bob on `b.example` talk in one room, each signed in on their own server, each server
keeping its own copy. Nothing else is shared: media collections (§31), unread state, search, drafts and settings stay
local. Built on 2026-10-24: server, web and Android (§33.13 says where the build settled what the plan left open).

### 33.1 The model: every shared room has a home

- **A shared room lives on one instance, its home** (where it was made). Each instance it is shared with keeps a
  **mirror**: an ordinary `rooms` record with ordinary `messages`, so the room view, realtime, unread counts, search,
  previews, the media grid and notifications (web and Android) work on it unchanged.
- **The home decides the room's state:** who sees it, who posts, its name, archiving, and the outcome of every edit,
  delete and reaction. A change made on a mirror goes to the home first. The home applies it and sends the result to
  every mirror, its sender included. A mirror applies only what its home sends.
- **Order is each instance's arrival order.** A message is shown on its own instance at once (optimistic send as
  now) and goes to the home, which passes it on. Two messages written within the same second can show in a different
  order on different instances; for chat that is fine, and it spares the event graphs and conflict resolution that
  make Matrix heavy.
- **A home that is down** leaves its mirrors readable. Their people's messages show locally and wait in the queue
  (§33.8) until the home answers. Edits and reactions wait too.
- **Why not Matrix:** a Matrix homeserver is far more work than this whole section. A Matrix bridge (like §26) would
  need a Synapse server running next to the app. Matrix is the route only if reaching people outside this app is the goal.

### 33.2 A module apart

Like the Telegram bridge (§26.1): `pb_hooks/federation.pb.js` registers its routes, worker and `fed_*` hooks (its parts of
the core's hooks are called from `main.pb.js`, §5.6), its code is in
`pb_hooks/federation/`, its collections are `fed_*` (`pb_migrations/1760000032_federation.js`), and the core gets only
the fields below. It saves messages, rooms and users through the same hooks as everything else, so text limits,
attachment limits, access checks, unread counts and realtime apply to what comes from a peer.

- **On:** a superuser ticks `federation` on the `site` record (hidden; migration `1760000033_federation_requests.js`).
  This server's origin is PocketBase's own **Application URL** (*Settings → Application*), which admins set anyway for
  email links: no environment variable. Ticking it is refused while that URL isn't a public `https://` address
  (PocketBase's default is `http://localhost:8090`). The URL's host is in every global id the peers keep (§33.6), so
  changing it is refused while any `fed_peers` row exists. Off, the `/api/fed/` routes (and `/api/chat/remote-users`)
  answer 404, the worker doesn't run, and no peer can be added. The record hooks are always registered, but skip at
  once while `fed_peers` is empty (a flag in the app store, asked again after each create and delete).
  `FEDERATION_ALLOW_PRIVATE=1` (http, 127.0.0.1) stays an environment variable: tests and development only. A server
  that ran with the first build's `FEDERATION_ORIGIN` gets it as its Application URL, and `federation` ticked, from that
  migration. An old Application URL that could never be linked with (the default) may be changed while paired.
- **Core fields:** `users.peer` and `rooms.peer` (relation → `fed_peers`, empty = local; hidden), `rooms.remote_id` (the
  room's global id at its home; hidden), `messages.remote_id` (the message's global id; hidden). The last is unique
  per room, which makes every delivery idempotent. Two for the clients: `users.instance` (a stand-in's host, shown on
  their name) and `rooms.shared` (`{ home, with, down }`: who else holds the room, §33.10). Only the module sets
  them: the API rules refuse them in requests.

### 33.3 Pairing (admins only)

`fed_peers`: `origin` (`https://b.example`, unique), `label` (1–8 characters chosen by the admin, e.g. `B`, used in
names, §33.4), `secret` (hidden), `status` (`invited` / `requested` / `active` / `suspended`), `dms` (bool: people may
open DMs across, §33.5), `invite`, `invite_expires`, `name` (the peer's site name), `last_ok`, `last_error`.

No code passes between the admins (changed 2026-10-24; the first build had the admin of A hand B's admin a code). The
code only ever proved that whoever finishes the pairing is the instance A's admin named, and A can deliver it there
itself: it sends it only to the origin typed in, over HTTPS.

1. **Asking:** a superuser on A adds a row for `https://b.example` (and a label). Before it is saved, A makes a
   one-time code (in `invite`, valid 7 days) and sends it with its origin and site name to
   `POST https://b.example/api/fed/request`. If B refuses for good (linking off there: 404; it lists A already: 409),
   the row isn't saved and the admin sees why. If B can't be reached, the row is saved `invited` with `last_error`,
   and the worker sends it again every 30 s of its runs (and on every tick) until it is delivered (`last_ok`).
2. **Checking:** B doesn't take A's word for who it is. Before saving anything it asks back:
   `POST https://a.example/api/fed/verify { origin: B, code }`, answered 200 only if A has an open request to B with
   that code. A request claiming to be someone else's never shows. (A's row isn't saved yet while it waits for B's
   answer, so A also keeps the code in the app store for that time.) B then saves a `requested` row, with a label
   suggested from A's host (`chat.acme.org` → `acme`, made unique) and `dms` off. At most 20 requests wait at once.
3. **Accepting:** B's superuser sets the row's `status` to `active` (choosing the label and `dms`). B calls
   `POST https://a.example/api/fed/pair` with the code and a new random 256-bit secret, over HTTPS. A checks the code
   (constant time, once, not expired), stores the secret and answers with its site name. Both rows become `active`.
   A requested row can only become active; an invited one only by the other side accepting.
4. **Both asking:** if B has an open request to A when A's arrives (checked as in step 2), B answers with its own code,
   and A pairs with it at once, as B's admin accepting would.
5. **Declining and withdrawing:** deleting a pending row tells the other side (`POST /api/fed/cancel`, with the code):
   a withdrawn request's row goes there; a declined one's row says "b.example declined." for its admin to delete.
   Requests nobody answers expire after 7 days: the requested row goes, the invited one says so.
6. **Unpairing:** either admin deletes or suspends the row (§33.7). Pairing again makes a new secret, which is how
   the secret is rotated.

Nobody but a superuser can pair, and an instance answers server requests only from active peers.

### 33.4 People from other instances

Each remote person who shows up in a shared room or a DM gets a **stand-in user**, as Telegram senders do (§26.3).
`fed_people` maps (peer, their id there) to the stand-in (`kind` `standin`). Its `known` rows note which of this
instance's own people (or stand-ins it relays) each peer was told of: they are the ones a `user` event goes to.

- **Named** with the peer's label: "Ann (B)", "Ann 2 (B)" if taken (names are unique, §22.1), within 32 characters.
  Their profile name and avatar follow theirs (a `user` event, §33.6). While a peer is paired, names ending in its
  label are refused to everyone but superusers, as " (TG)" is.
- **They can't log in:** an address at `federation.invalid` and a random password.
- **`users.peer`** marks them. The UI shows their instance (`b.example`) on their profile and in the name menu.
- **DMs:** `no_dms` follows their own setting on their instance (§33.6), so DMs with them work (§33.5).
- **People from a third instance:** with A as the home, a room shared with B and C shows C's people on B too. B may
  not be paired with C. Then A vouches for them: B's stand-in is keyed by (A, `id@c.example`), and the label is
  `c.example` cut to 12 characters. DMs with them are impossible from B (`no_dms`), since B has no pairing with C.

### 33.5 Shared rooms and DMs

**Sharing a room: admins on both sides choose.** Room creators and other users can't share a room. Only the
superusers of both instances can, as with pairing (§33.3) and Telegram links (§26.5). `fed_shares` has a row per (room,
peer) on both instances: `room`, `peer`, `remote_id`, `state` (`offered` / `active` / `ended`).

1. A superuser on A (the home) adds a row in the admin UI (*Collections → fed_shares*): the room and the peer. A
   sends `share` to B.
2. B's row appears as `offered`, with the room's name, kind and visibility, and no mirror yet. A superuser on B
   accepts it by ticking `accepted`. B makes the mirror and answers, and both rows become `active`. Declining deletes
   B's row, and A's row then ends.
3. The mirror is named after the home's room plus the label ("general (A)"), numbered if the name is taken. B's
   admin may rename it. That name is local to B; the home's renames still come through and replace it.

**Any room can be shared**, whatever its visibility (§23):

- **Public:** every signed-in person on B sees the mirror, as on A.
- **Private:** only members see it on any instance. The home keeps the one member list, and **each side's admins
  manage their own people** in it:
  - **On the home (A),** the room's creator manages members as now (§23.2). Once the room is shared with B, the
    creator can also add B's people by full address ("bob@b.example", looked up on B, below). Only peers the room is
    shared with are looked up, so a creator can't take a private room to an instance the admins didn't choose. The
    creator can also remove anyone, B's people included.
  - **On a mirror (B),** B's superusers add or remove **B's own people** by editing the mirror's `members` in the
    admin UI. The rooms hook lets that edit through only for a superuser, only on a mirror, and only for local users:
    stand-ins of other instances can't be added or removed from B. The edit shows on B at once and goes to A as a
    `members` request (§33.6). A applies it unless it breaks a rule (the 100-member limit, a person B doesn't own,
    the room archived or no longer shared). A then sends the room as it now is to every mirror. If A refused, B's
    list goes back to A's, and the reason is logged in `fed_shares.last_error` on B.
  - **Nobody else on B** can change the mirror's members: B's users can't, members of the room included, and B's
    admins can't touch A's people or another peer's.
  - Remote people can be writers (§23.6) like anyone, but writers are only set on the home, by its creator.
  - On every instance, the room's `members` holds that instance's own people from the list plus stand-ins for the rest,
    so the local access rules apply as usual.
- **Open Air:** the mirror is Open Air too, and guests on either instance read it. Guests never post or react
  (§23.3), so nothing of theirs has to be sent. Changing a shared room's visibility on the home changes every mirror's.

**Ending a share:** an admin on either side deletes the row, or the peer is unpaired (§33.7). The mirror is archived:
it keeps its history and becomes read-only. Both sides get a service message (§5.3): "This room is no longer shared
with A." Remote people are taken out of the home room's members and writers. Sharing again starts a new mirror. The
old one stays archived; nothing is merged.

**DMs** are opened by people themselves, between instances whose admins both ticked `dms` on the pairing. In "New
message", typing a full address `bob@b.example` asks B for that one name
(`GET /api/fed/users?name=bob`, signed). Partial names and lists are not answered, so nobody can enumerate another
instance's people. B answers with the user if they exist and take DMs. A makes the stand-in and the DM room (home A)
and sends `room` to B, which makes its mirror DM between Bob and A's person's stand-in. After that, it is a DM like
any other on both sides. `no_dms` on either end closes it as §16.7 does, and so does either admin unticking `dms`:
DMs that already exist stay readable but take no new messages.

**What a mirror shows** of messages:

| Thing | Across instances |
|---|---|
| Text, edits, soft deletes | Yes, the home applying them (§33.1) |
| Replies | Yes; a reply to a message the mirror doesn't have (before it was shared) shows without its quote |
| Reactions | Yes: the mirror sends add/remove, and the home sends back the message's whole reaction list (§20.1), people as their ids on the home |
| Attachments | Copied: the receiving instance fetches each file (§33.6) and saves the message once they are there, as Telegram albums (§26.4). File tokens, thumbs, posters and the media grid then work locally |
| Forwards into a shared room | Sent as a snapshot: "forwarded from Ann", the original's text and files at the time. The original may be in a room the peer can't see, so its later edits don't follow (unlike §21.3) |
| Service messages | Each instance makes its own; none are sent |
| Reads, hidden rooms, drafts, search, link previews, push | Local, nothing sent |

**Moderation.** The home's superusers can delete any message in the room (as they can any message, §5.6), and its
creator can remove a remote member or take away their posting; the mirrors follow. A mirror's superuser can't change
the room's state, apart from its own people in a private room's members (above), nor the home's people's messages, but
can end the share or unpair (§33.7).

### 33.6 Between servers

**One inbox:** `POST /api/fed/inbox` takes a batch of up to 50 events (256 KB of JSON at most). Every server request
carries:

- `X-Fed-Origin`: who is calling, which must be an active peer.
- `X-Fed-Date`: within 5 minutes of now.
- `X-Fed-Signature`: `hs256(secret, method + "\n" + path + "\n" + date + "\n" + sha256(body))`, compared in constant
  time. PocketBase's JSVM has HMAC (`$security.hs256`) but no public-key signing. With pairs set up by admins, a
  shared secret per pair is as good as a key pair.

**Events** (each has an `id` unique on its sender, so repeats are dropped):

| Event | From → to | Body |
|---|---|---|
| `room` | home → mirrors | name, kind, visibility, posting, members and writers (people as global ids), archived |
| `share` / `unshare` | home ↔ peer | the room's id; acceptance or refusal |
| `message` | author's instance → home → mirrors | ids, room, author, text, `reply_to`, files (name, size, type, a signed fetch path), created |
| `edit` / `delete` | author's instance (or the home, moderating) → home → mirrors | message id, the new text |
| `react` | any instance → home | message id, emoji, add or remove |
| `members` | mirror → home | the room; its own people to add and to remove (global ids). Answered by the next `room` |
| `reactions` | home → mirrors | message id, the whole list |
| `user` | own instance → peers sharing a room or DM with them | name, avatar hash, `no_dms` |
| `unpair` | either way | nothing |

A **global id** is `<id>@<host>` with the host of the instance the thing was made on. Each instance maps it to its
own records (`fed_people`, `rooms.remote_id`, `messages.remote_id`).

**A peer can only do what its people may do:** an author must be one of the sender's own people, or vouched for by
the sender when it is the home (§33.4). A room event comes only from that room's home. A `members` request adds or removes only the
sender's own people, in a private room shared with it. A message must be in a room
shared with the sender, by someone the home's rules let post there (the same `canWrite()`). An event that breaks this
is refused with a 403, which is logged on both sides.

**Our own people speak only here** (QA BUG-172…174): a home relaying a room never writes as one of the receiver's own
people (a `message` whose author is the receiver's is refused), nor edits what they wrote there (a `delete` still
comes through: the home's superusers moderate their room). A DM's two members are set when its mirror is made; later
`room` events don't change them.

**The inbox's answer** gives each event a status of its own: `{ results: [{ id, status, error? }] }`. Each event is
applied in a transaction of its own, so one refused event doesn't undo the others. 200: applied, or a repeat (the ids
taken are kept 3 days in `fed_seen`). 4xx: refused, and the sender drops it and notes why in `fed_peers.last_error`.
5xx: failed for now, and the sender tries it again. The request as a whole fails only for what concerns all of it: a
bad signature (401), a peer not paired (403), one suspended here (503, §33.7), too many events (429).

**Files:** `GET /api/fed/files/{message}/{file}`, signed, served only to a peer the message's room is shared with.
Fetched by the worker, at most 10 files of 20 MB each (§17.1). **Avatars** are fetched the same way.

**Outgoing requests** go through the link previews' fetcher (§28.1, curl, `getent`): only the peer's paired origin,
HTTPS, public addresses only, no redirects, size-capped bodies, and timeouts. `FEDERATION_ALLOW_PRIVATE=1` is for
tests and development only.

**Rate limits:** PocketBase rate-limit rules on `/api/fed/` (600 a minute per client IP, which for these routes is the peer), separate from users' own. The inbox also refuses more than 600 events a minute from one peer, counted in the app's memory.

### 33.7 Suspending and unpairing

- **Suspended:** nothing is sent or accepted. The queue is held, and mirrors show "A can't be reached right now" in
  the room header. Turning the peer back on sends what waited. Its requests are answered 503, so it holds its queue
  too. Mirrors also show it when their home stopped answering: after 3 failed tries in a row, until it answers.
- **Unpaired** (deleted, or an `unpair` event): every room shared with that peer is unshared (§33.5), mirrors are
  archived, and stand-ins are taken out of members and writers. DMs with its people become read-only: the messages
  hook refuses posting to a stand-in of a peer that isn't active, as `no_dms` does (§16.7). Stand-ins and their
  messages stay, as Telegram's do.

### 33.8 The worker

As the Telegram bridge's (§26.7): a cron job every minute runs a 57 s pass. One run at a time. Each item in `fed_queue`
is claimed first (`locked_until`), so it is sent only once. Items go in order **per peer**, batched up to 50 per
request. A failure that may pass (no answer, 5xx, 429) is retried after 2, 4, 8… seconds, capped at 10 min. A peer can
be down for a long time, so items are kept for **3 days** and then dropped and logged. A 4xx is dropped at once and
logged. `fed_peers.last_ok` and `last_error` show the state in the admin UI. `POST /api/fed/tick` (superusers) runs a
pass at once. File fetches for messages that arrived are queued the same way.

### 33.9 What it can't protect

- **A room is only as private as every instance it is shared with.** A peer's admin can read every message of rooms and
  DMs shared with that instance, and could keep messages that were later deleted. No protocol fixes this. The UI says so: a
  shared room's header and access dialog show "Shared with b.example", and adding a remote member says the room's
  messages will be stored there. The admins sharing a private room are deciding that for its members.
- **Deletes are a request**, honoured by a well-behaved peer, not guaranteed.
- **A peer vouches for its own people.** A stand-in is whoever that instance says it is.

### 33.10 Clients

- **Web:** a stand-in's instance in their name menu ("On b.example") and on their name in search results; "Shared with
  b.example" under the room header, with "a.example can't be reached right now" when the home is down; in the access
  dialog, where else the room's messages are kept, people there listed with their instance, and `name@host` to add
  them; `name@host` in "New message" (`POST /api/chat/remote-users`). To pay for it, the access dialog became a lazy
  chunk (≤ 3 KB, §7.7): `app.js` went from 47.9 KB with it to 45.97 KB, and no budget was raised.
- **Android:** the same (ANDROID.md §23). Stand-ins and mirrors are ordinary users and rooms to the app.

### 33.11 Milestones

1. Pairing, signed requests, the inbox, the worker, stand-ins (`user`).
2. Rooms shared by admins (public, private and Open Air), text only: `room`, `share`, `message`, `edit`, `delete`,
   accepting, ending a share, unpairing.
3. Replies and reactions.
4. Attachments and avatars copied.
5. DMs across instances (`name@host` lookup).
6. Backfill: when a share is accepted, the home sends the room's latest 200 messages, files included (until then a
   mirror starts empty, from the moment of sharing).

### 33.12 Tests

Integration tests start **two PocketBase servers** (the harness already starts its own, §9.2) and pair them. Checks:
pairing (a forged request, declining, withdrawing, an undelivered request sent later, both admins asking, an expired
or reused code, an instance with linking off, the Application URL kept while paired); signatures (wrong secret, old date, a replayed id); every event both ways
through a home and two mirrors; a peer acting outside its rights gets a 403 (another instance's author, a room not
shared with it, posting where it may not); a home that is down, then back; suspending and unpairing; files fetched
only by a peer that may; the fetcher refusing private addresses; shares offered, accepted, declined and ended by
admins only (a user's request refused); a private room's members on each side: B's admin adding and removing B's people
(applied on A and every mirror), refused for a user, for another instance's people and over the limit, and put back on B
when A refuses; an Open Air mirror read by a guest on
the peer; a DM by `name@host`, `no_dms` and a pairing without `dms`; names with labels
and their reservation.

### 33.13 As built (2026-10-24)

Where the build settled what the plan above left open:

- **The code** is kept in the row until used (§33.3), not only its hash: the asked side needs it to accept.
- **Per-event answers** from the inbox, a transaction each (§33.6): a batch isn't refused as a whole for one event.
  `fed_seen` holds the ids taken; the rate count is kept in memory.
- **Not sent back where it came from:** the home passes a mirror's message, edit or delete to every other mirror, not to
  the one it came from. Room state and reactions go to every mirror, the sender too: the home's word is final there.
  Saves made for a peer's event are marked (by record id, in the app store) so the hooks don't queue them again.
- **Order:** queue rows carry a sequence number (rows queued in one transaction share a millisecond).
- **A DM with a peer's person** is shared with that peer as it is opened: no admin step, as §33.5 says. Whether DMs
  are possible is the stand-in's `no_dms`: their own setting, or this side's `dms` unticked, or the peer not active,
  or a person only vouched for. So the DM route, the messages hook and the clients need nothing new for it.
- **A mirror's admin edits** go through the rooms update request hook (`checkMirrorEdit`): its name, and in a private
  room its own people as members. Anything else is refused: it is changed on the home.
- **Lookups and remote users:** `GET /api/fed/users?name=&for=dm|member` answers one person by exact name; `for=dm` only
  while `dms` is ticked and they take DMs, `for=member` only while a room is shared with the asking peer.
  `POST /api/chat/remote-users` asks it for a person here and makes the stand-in.
- **Avatars** are served (`GET /api/fed/avatars/{user}`) only to a peer that was told of that person.
- **Tests:** `tests/integration/federation.test.ts` (18 cases, three servers and more where a case needs its own pair:
  everything §33.12 lists but the member limit, which a mirror's own 100-member limit reaches first),
  `tests/component/views/room/linked.test.ts` and the "linked instance" case of `rooms.test.ts` (web), `LinkedTest`,
  `ChatApiTest` and `UiLinkedTest` (Android).

## 34. Notifications (2026-10-24)

The user asked for "notifications to web app. push/sound. without google", turned on in the profile, for replies and
DMs. Asked whether that meant Web Push (which, with every tab closed, can only come through the browser's own push
service: Google's for Chrome and Edge, Mozilla's, Apple's), they chose **open tab only**: no third party at all.

### 34.1 What alerts, and when

- **DMs**: every message from someone else in a DM. **Replies to you**: a message in a room that replies to one of
  yours. Each can be chosen on its own, as the Android app's (ANDROID.md §21.1).
- Not: your own messages, service messages, deleted ones, archived rooms, hidden rooms (§13; a closed DM opens again
  with a message, §16.4, so it alerts).
- Only while the app is open in a tab of this browser, in the background or minimised too. The alert comes from the
  tab's realtime connection (§18.3's messages subscription, which now carries `reply_to` too). With every tab closed,
  nothing arrives, and nothing missed meanwhile is told later: the unread counts show it.
- **In front** (a tab of the app focused): no pop-up. The sound only, and nothing at all for the room open there.
- **How**, each chosen on its own: **a pop-up** (a system notification: who wrote, "… replied in #room" for a reply,
  the text on one line, cut at 140 characters, or "Sent an attachment"), and/or **a sound** (a short two-note chime
  made with Web Audio, no sound file; when it plays, the pop-up is silent). Browsers play sound only in a page that has
  been clicked or typed in once since it loaded, so a tab restored and never touched alerts silently.

### 34.2 Settings (profile page)

A **Notifications** group after Appearance: Direct messages, Replies to you, Show a pop-up, Play a sound. Saved on
this device (localStorage `chat.notify`, gone when nothing is ticked), like the theme: the browser's permission is
per device anyway. Ticking DMs or replies with neither way chosen ticks the pop-up. Ticking the pop-up asks the
browser's permission (a click is needed for that). If the browser refused, or can't show notifications (an iPhone
outside an installed app), the group says so. Ticking the sound plays it once.

### 34.3 Code

- `web/src/notify.ts`, a lazy chunk (≤ 3 KB, §7.7): loaded by `app.ts` when a signed-in user has `chat.notify`
  (at start, when the profile page changes it, or another tab does: the `storage` event), and by the profile page
  for its settings. Stopped with the session.
- **One tab alerts**: the one holding the Web Lock `chat.notify`. When it closes, another takes it. It fetches the
  message (one request, only for DMs and replies), checks the quoted message is yours, and asks the other tabs over a
  BroadcastChannel whether one is in front (200 ms). The tab in front plays the sound itself.
- **Alerting** from the moment the server has both its subscriptions and the tab holds the lock: it says so as
  `<html data-notify="on">` (gone once stopped), which the e2e waits on. The realtime POST can't tell: the unread counts
  follow the same topics, so the subscriptions may already be there (2026-10-28; the e2e failed about once in 30 runs).
- Pop-ups go through the service worker's `showNotification` when one is active (Android Chrome allows no other
  way), else `new Notification`. Tag = the room: a newer message replaces the room's pop-up. A read of the room
  (`room_reads`, from any tab or device), or opening it here, closes it.
- **Clicking** one opens its message (`/r/{room}/m/{message}`): `sw.ts`'s `notificationclick` focuses the app's
  tab in front (else a visible one, else any) and tells it where to go, or opens a new tab. Only paths of the app.
- No server change. The Android app is unchanged: it already notifies by its own check (ANDROID.md §21).

### 34.4 Tests

`tests/component/notify.test.ts`: what alerts (DMs, replies, choices, hidden/archived/own/deleted), the text, the
stored choices; live against PocketBase: a DM's pop-up and chime and its click, a reply to you (not a plain message,
not a reply to someone else), in front (silent for the open room, the chime for another), the sound alone, blocked
pop-ups, a read elsewhere closing it, stopped; the settings group. `tests/unit/sw.test.ts`: the click handler.
`tests/e2e/notify.spec.ts`: turned on in the profile page, a reply and a DM pop up in a background tab and a click
opens the DM at its message, off again silent; with the service worker, one pop-up per room that a read elsewhere
takes away. Headless Chromium answers "denied" to every notification, granted or not, so the e2e replaces the
browser's `Notification` and the registration's `showNotification`/`getNotifications` with recorders.

### 34.5 Every message of a room (2026-10-24)

The user asked to "enable notifications for all messages in any specific room. on web and on mobile. no need to sync
it."

- The room's ⋯ menu (not a DM's, whose every message already alerts with Direct messages): **Notify of every
  message**, then **Stop notifying of every message**. Not offered in an archived room unless already on (to turn it
  off). Guests have no such item.
- Kept on this device only, with the other choices: `chat.notify`'s `rooms` (room ids). Not synced to the account or
  other devices; the Android app keeps its own (ANDROID.md §24). Turning it on with neither a pop-up nor the sound
  chosen chooses the pop-up and asks the browser's permission; if the browser refuses, the header says so.
- Every message from someone else in that room alerts as a reply does: `"{author} in #room"` over the text (a reply
  to you still says "replied in"). The same exceptions as §34.1: hidden and archived rooms, your own, service and
  deleted messages, the room open in the tab in front.
- `views/room/header.ts` reads and writes `chat.notify` itself (a few lines), so `app.js` never loads `notify.ts`
  for it; it then calls the app's `notify()` to start following if it wasn't. The profile page's boxes keep
  `rooms` as they are, and its hint mentions the room menus.
- Tests: `notify.test.ts` (what alerts for a room chosen; the stored list; a plain message pops up as "… in #room",
  another room's doesn't; the profile keeps the list), `views/room/header.test.ts` (the menu item on and off, the
  pop-up chosen and permission asked, nothing stored once nothing is chosen).
