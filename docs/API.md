# The client API

What the clients (web/, android/) rely on from the server. The Android app is installed and updated by its users, on
their own schedule (F-Droid), so a release of the server has to keep working with the apps already out there.
Anything listed here is a public interface. A change to it needs the compatibility check below, not just green
tests.

Shared values live in [`shared/contract.json`](../shared/contract.json): the field lists, limits and file types. Each
client keeps its own copy, and tests compare those copies with the contract:
- `tests/unit/contract.test.ts` checks the web's copy and the hooks' copy.
- `android/…/lib/ContractTest.kt` checks the app's.
- `tests/integration/schema.test.ts` checks the limits against the migrations.

Rules that more than one implementation must follow have test vectors in [`shared/vectors/`](../shared/vectors/):
- `text.json`, `jump.json`: text folding, search queries, Jump to's ranking. The web, the hooks and the app run them.
- `window.json`: the message window (merge, trim, pages, groups, page queries; DESIGN.md §7.5). The web
  (`tests/unit/lib/window-vectors.test.ts`) and the app (`WindowVectorsTest.kt`) run it. Messages in it are written out
  or generated as `tests/support/vectors.ts` says.
- `room.json`: the room controller against a real server (open, page, jump, go to, live messages, pill, unread line,
  deletes). Recorded from the web's controller (`RECORD=1 npx vitest run --project component
  tests/component/views/room/scenarios.test.ts`) and replayed by it and by the app's `RoomScenariosTest.kt`. A change to
  what the controller does is recorded again, then the app is made to pass.

## What the clients use

**Record API** (`/api/collections/{name}/records`). PocketBase's API rules decide access:

| Collection | Web | App | How |
|---|---|---|---|
| `users` | ✓ | ✓ | auth (password, refresh), sign-up, profile update (`fields.user`); `request-password-reset` (both, the email in lower case) and `confirm-password-reset` (web) since 2026-11-08 (DESIGN.md §39) |
| `rooms` | ✓ | ✓ | get, create, update (`fields.room`); list: apps before 2026-10-29, and the app with a server from before then |
| `messages` | ✓ | ✓ | get, create (multipart), update (`fields.message`); pages, search (`text_key ~`) and the notification check by filter: apps before 2026-10-29, and the app with a server from before then |
| `hidden_rooms` | ✓ | ✓ | list, create, delete (`fields.roomRow`) |
| `site` | ✓ | ✓ | the site record; the app also reads `min_android_version`; both read `password_reset` (not a field: the server's mail settings, DESIGN.md §39; absent before 2026-11-08) |
| `collections`, `collection_items` | ✓ | ✓ | the collections pages (`fields.collectionItem`) |
| `push_tokens` | | delete only | apps from before ANDROID.md §21 unregister their Firebase token |

Since 2026-11-03 (anonymous rooms, DESIGN.md §35) no one but a superuser may filter or sort by `author` or
`forwarded_from`, or expand `messages_via_author`/`messages_via_forwarded_from`, except to compare an author with
their own id (what older apps do): 400 otherwise. A message of an anonymous room reads, to anyone but its author, with
`author` = the room's id and `expand.author` = `{ id, name: the room's name, no_dms: true }`, a user that doesn't exist.

Since 2026-11-03 (moderators, DESIGN.md §36) `users` has `moderator` and `banned`, which no client sets, and a
banned account can't sign in or refresh its session (401 for its old token). A moderator deletes others' messages
through `POST /api/chat/delete` (the records API still allows only the author) and changes any public room's
access and `archived` through the records API, as its creator does. `POST /api/chat/ban { user, banned }` is theirs
only.

Since 2026-11-10 (mentions, DESIGN.md §41) `users` has `handle` (in `fields.user`; set by its owner, refused with the reason when taken or malformed) and `messages` has `mentions` (in `fields.message`; the server's, what a client sends with a create is replaced, an update changing it is refused). `inbox` and `inbox_reads` have no API rules.

Since 2026-11-09 (usage statistics, DESIGN.md §40) `site` has `no_stats` (hidden), and the realtime subscribe
request's User-Agent says which app a connection is (the app's OkHttp default, `okhttp/…`: keep it, or the app is
counted as neither). `GET /api/chat/stats?tz=<minutes east of UTC>` answers moderators and superusers (403 otherwise)
with counts only; the web's `/stats` page uses it, the app doesn't. `stats_samples` and `stats_activity` have no
API rules.

The clients send filters in PocketBase's filter syntax. Apps from before 2026-10-29 name the fields `room`, `created`,
`id`, `updated`, `files`, `forward_of`, `text_key`, `author`, `deleted`, `room.kind`, `reply_to.author` and
`collection`; apps from then on (with a current server) only `id` (users), `room` (`room_reads`, the live room),
`collection` and `owner` (collections). Renaming a field, changing its type or tightening a rule breaks the apps
already installed.

**Pages and the room list** are routes (`pb_hooks/lib/lists.js`), so a client names the page, not the filter:
`GET /api/chat/rooms` and `GET /api/chat/rooms/{room}/messages?kind=latest|first|older|newer|changed` (cursor
`created`, `id`; for `changed` `since`, `from`, `to`; `files=1`; `q`, search's words, which the server folds and
escapes; `limit` ≤ 200; `page`). The app's notification check is `GET /api/chat/notifiable?rooms=a,b&since=…&every=a`
(signed in; other people's DMs, replies to you and, since 2026-11-10, mentions of you, and every message of the `every` rooms; rooms you can't see left
out). All answer a plain array of
records, with `expand` and `fields` as the records API takes them, and see what its rules let the caller see (a room you can't
see has no messages). A message page also has an `ETag` (of its body, `expand` and `fields`) and `Cache-Control: no-store`: asked again with `If-None-Match`, an unchanged page is `304` with no body, so a client that kept the page shows it as it is (the web, since 2026-11-03, docs/PERF.md §5; the app doesn't ask). The app falls back to the records API when a route answers 404 (a server from before the
routes; it can talk to servers it doesn't control). `tests/integration/lists.test.ts` and `search.test.ts` check each
answer against the records API's answer for the filter it replaces; the app's `LegacyServerTest` runs the same session
against a current server and one without the routes (or an old release's hooks, `-Pchirkle.legacyHooks=…`).

**Custom routes** (`pb_hooks/main.pb.js`, `federation.pb.js`):
`/api/chat/rooms`, `rooms/{room}/messages`, `notifiable`, `dms`, `unread`, `unread/{room}`, `reads`, `reactions`, `delete`, `ban`, `forward`, `media/{room}`,
`posters/{message}/{file}`, `posters/items/{item}/{file}`, `collections`, `badges`, `items`, `items/{id}`, `saved`,
`subs`, `subs/seen`, `users`, `password`, `remote-users`, and since 2026-11-10 (DESIGN.md §41) `mentionable`, `inbox`, `inbox/seen` (`unread` also answers `inbox` and `mentions`). Also `/api/files/*` (messages' and items' files by URL alone since 2026-11-04, DESIGN.md §37.3: a token is ignored; by collection name, `/api/files/messages/…` and `/api/files/collection_items/…`, not by its id, since 2026-11-09; the app sends one only to a server from before, which lists `files` as 404), `/api/health` and
`/.well-known/assetlinks.json`.

**Realtime** (`/api/realtime`): `rooms`, `chat/messages` (since 2026-11-09, PERF.md §7: each message created, updated or
deleted, once, to everyone who can see its room, as `{ action, record }` with `fields.message` and `author`,
`forwarded_from` expanded; the web's room and activity both listen to it; the app asks `GET /api/chat/live` first,
`{ "topic": "chat/messages" }`, and on a 404 subscribes as before), `messages` (still served, for apps from before:
one room's, expanding `author,forwarded_from` but not `reply_to` since 2026-10-30; or every room's with
`fields.activity`; each listener costs the server a JS call per message), `hidden_rooms`, `room_reads`, `collections`, `collection_subs`, `chat/badges`, `chat/inbox` (since 2026-11-10: your inbox rows added and taken away, `{ action, id, kind, room, message, created }`) and `PB_CONNECT`. Every connected client
also gets `chat/keepalive` (`{}`) every 3 minutes, so that PocketBase doesn't close a quiet connection; clients ignore
it.

Routes only the server or tests call: the `*/tick` routes (superusers, `keepalive/tick` among them), `/api/fed/*` (other instances, §33) and
`/api/telegram/webhook`.

## Changing it

- **Adding** a field, a route or an optional parameter is safe. Clients ask for named fields (`fields=`), so they
  never see a new field until they ask for it.
- **Renaming or removing** anything in the tables above: keep the old form working until no supported app version
  uses it. Then raise `site.min_android_version`, which tells older apps to update (ANDROID.md §12.4).
- **Tightening** a rule or a limit: older apps check against the old limit, so the server's own error message is
  what their users will see. It must still read well.
- A field list in `shared/contract.json` changes together with both clients' copies. The contract tests fail until
  all three match.
