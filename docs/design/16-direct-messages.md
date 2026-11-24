# §16. Direct messages

Part of the design document: [index](../DESIGN.md).

## 16.1 Data model

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

## 16.2 Opening a DM: `POST /api/chat/dms`

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

## 16.3 API rules

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

## 16.4 Closing and reopening

**Close conversation** in a DM's menu creates a `hidden_rooms` row, exactly like hiding a room. Unlike hidden
public rooms, closed DMs are not listed under **Hidden rooms**; they simply leave the list.

A DM must not stay silent once the other person writes again. An after-create hook on `messages` in a DM deletes
the **recipient's** `hidden_rooms` row for that room, if there is one. That delete reaches the recipient's
`hidden_rooms` subscription (§6), so the DM reappears live. The same hook sets the room's `last_message_at`, which
reaches both members through their `rooms` subscription.

## 16.5 Frontend

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
- **From a message:** clicking an author's name opens the DM with them, which does the same. (Until 2026-11-24 it
  opened a small menu with **Message**.) Your own name, a guest's view, and anyone who takes no DMs or when you don't
  (§16.7) leave it plain text; a moderator's menu on someone who takes no DMs is §36.4.
- **Room view:** unchanged apart from the header, the composer placeholder ("Message Bob") and the beginning marker
  ("Beginning of your conversation with Bob"). A DM shows the other member's avatar and name, and its menu has
  **Close conversation** (then back to `/`) and **Jump to beginning**, never Archive. A closed DM opened by URL
  offers **Reopen conversation** instead.
- **Not a member:** opening `/r/:id` of someone else's DM gets a 404 from `getRoom`, which already shows "room not
  found".

## 16.6 Tests

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

## 16.7 Users who take no direct messages

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
