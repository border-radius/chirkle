# §18. Unread counts

Part of the design document: [index](../DESIGN.md).

Every room and DM in the sidebar shows how many messages you haven't read yet, live. Decisions: §13 (2026-10-11).

## 18.1 Data model: `room_reads`

| Field | Type | Notes |
|---|---|---|
| `user` | relation → users | required, cascade delete |
| `room` | relation → rooms | required, cascade delete |
| `last_read_at` | date | required: you have read every message created up to and including this time |

Unique index on `(user, room)`. Rules: list and view `user = @request.auth.id` (so each user gets their own rows
live); create, update and delete `null`. Only the route below writes rows, so a client can't move its read position
back, set it in the future or write someone else's.

No row means "read up to your signup" (`users.created`): history from before you joined never counts.

## 18.2 Routes (`server/unread.go`, `server/reads.go`)

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
  404. A mark that doesn't move the position is answered without writing; the others are group-committed: one
  goroutine saves whatever has queued in one transaction (one row per user and room, the latest position) and answers
  each request once that has committed, so the answer still means the row is stored (PERF.md §12). Rate limit: 120
  per 60 s per IP; the client sends at most about one per second per open room.
- **`GET /api/chat/unread/{room}`** → `{ id, created }` of the oldest message in `room` that is unread by the same
  rule (not yours, not deleted, newer than `max(last_read_at, your signup)`), or `{ id: "", created: "" }`. 404 for a
  room you can't see. §18.5 opens the room there.

## 18.3 Client

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
  because what is below the screen is still unread.
- **The open room's count** (2026-11-02, user: a selected room lost its badge and its place in the room list while
  it still had unread messages): `unread.ts` keeps the room whose reader last said `caughtUp` (`following`). Only
  that room is left out of fetched counts and of live +1s (and `room_reads` events for it don't refetch). Opened at
  its first unread message, or scrolled up, the open room keeps the server's count, and every read that goes in while
  not caught up refetches the counts, so its badge comes down to what is left as you scroll; new messages that arrive
  while scrolled up count live. Reaching the bottom clears it as before.
- **Whose read:** the session is shared by every tab, and another tab can switch it to another user. A reader
  remembers who it was opened for and never sends a read as anyone else. Ending the session (`endSession()` in
  `app.ts`) calls `unread.flush()` first, so logging out still sends the pending read while the session exists;
  after a switch from another tab, the same flush sends nothing.

## 18.4 Rendering

- A bold name and, after it, a small accent dot (`.dot`) holding a visually hidden "3 unread", so a screen reader reads
  "general, 3 unread". Numbers only for what is addressed to you (2026-11-23, the sidebar improvements): a DM's pill
  (`.badge`, `99+` past 99) counts its unread messages, a room's its unread mentions and replies (§41). Until then every
  row had the pill with its count.
- **No badge** for hidden rooms or archived rooms (`unreadCount()` in `store.ts`). The open room has one, and stays
  among the unread rooms at the top, while it has unread messages left below the screen (§18.3; it had none before
  2026-11-02, which hid what was still unread).
- Room rows are now flex rows: the name ellipsizes, and the `#`, the avatar and the badge always stay visible.

## 18.5 Opening at the first unread message

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

## 18.6 Tests

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
