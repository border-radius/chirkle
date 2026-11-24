# §5. Data model

Part of the design document: [index](../DESIGN.md).

All schema is defined in `pb_migrations/` so every environment gets the same schema and API rules. Changes made in the admin UI during development are captured with PocketBase's automigrate and committed.

## 5.1 `users` (built-in auth collection)

| Field | Type | Notes |
|---|---|---|
| `id` | text (15) | PB default |
| `email` | email | unique, required; `emailVisibility = false` |
| `name` | text | required, 1–32 chars, trimmed |
| `kind` | select (public since migration 58, so the apps can tell a stand-in from a person) | `person` (signs in here), `telegram` (a Telegram sender's stand-in, §26.3), `peer` (a linked instance's person, §33.4) or `deleted` (its person deleted it, §43.3; migration 52). Set by hooks only: `person` on any other create (`lib/users.js`), the bridges set their stand-ins'; no client sets it (create/update rules). Hooks ask `isStandIn`/`kindOf` (`lib/users.js`) instead of the made-up e-mail's domain (REFACTOR item 50, migration 51). |
| `created` / `updated` | autodate | |

## 5.2 `rooms`

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

## 5.3 `messages`

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

## 5.4 `hidden_rooms`

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

## 5.5 API rules

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

## 5.6 Server hooks (`pb_hooks/main.pb.js`)

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
- **Security headers**, set by the routes that serve the app (`lib/http.js` `headers`; not by a `routerUse` JS middleware, which would hold a JS runtime for every request, PERF.md §6): pages and the app's files get `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` (PocketBase sends nosniff with every API answer itself), and `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The hash allows index.html's one inline script, which sets the chosen theme before the first paint (§7.8). The CSP is *not* applied to `/api/*` or to the admin UI `/_/`, which sends its own CSP.
- **Cache headers:** `/assets/*` (content-hashed) gets `Cache-Control: public, max-age=31536000, immutable`. Every other static path, including `/` and `index.html`, gets `no-cache`.
- **No `index.html` for a missing asset or API:** PocketBase serves `index.html` for any path that isn't a file (§7.1). Under `/assets/` (a route of ours, `GET /assets/{path...}`) a missing file is a 404 with `Cache-Control: no-store` instead: an old build's lazy chunk, asked for by a tab left open across a deploy, would otherwise get HTML (useless as a script) cached for a year under its hashed name. An unknown `/api/` path is a JSON 404 too, not the app's page.
- **Rate limiting:** PocketBase's built-in limiter, enabled from the init migration. The limits are per client IP:
  - `messages:create`: 10 requests per 5 s.
  - `users:create` (guests): 20 requests per 60 s.
  - `messages:update` (edits and soft deletes): 20 requests per 10 s.
  - `rooms:create`: 5 requests per 60 s (rooms can't be deleted, so a flood would stay in everyone's list).
  - PocketBase's default rules are kept after these.

  Test harnesses turn the limiter off, because every test client shares 127.0.0.1. `http.test.ts` turns it back on to verify the 429.
