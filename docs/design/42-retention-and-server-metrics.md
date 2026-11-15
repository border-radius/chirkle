# §42. Retention and server metrics (2026-11-12)

Part of the design document: [index](../DESIGN.md).

REFACTOR items 49 and 51: tables that only grew, and what an operator used to learn from users.

## 42.1 Retention (`pb_hooks/lib/retention.js`)

A daily prune (cron `retention`, 03:41; `POST /api/retention/tick` for superusers runs it now and answers what each step
deleted), as statistics (§40.2) and the federation queues (§33.8) already had:

- **`inbox`** (§41.4): a person's newest 500 rows, none older than 180 days. The page pages back no further than that;
  the counts stop at 100.
- **Rows left behind by deletes that skipped the hooks** (raw SQL, an old migration, a crash between two saves;
  PocketBase's cascades only run for deletes it makes itself): inbox rows of a deleted or soft-deleted message, or of a
  room, person or actor that is gone; `room_reads`, `inbox_reads` and `hidden_rooms` of a person or room that is gone;
  `media` rows (§30) and `link_queue` jobs (§28) of a soft-deleted or gone message (a forward's media rows go with its
  original, as `lib/media.js drop()` does).
- **Messages are never pruned** (§2). A retention period for them (`site.retention_days`) would be the owner's choice;
  not built.

The inbox counts (`GET /api/chat/unread`, `server/unread.go`) start each room at the read position on an index
`(user, room, created)` (migration `1760000049`): an inbox row is made with or after its message, so read rows are never
visited. Measured with 5,000 inbox rows in 5 rooms: the per-room count went from 13 ms to 1.5 ms; `GET /api/chat/unread`
takes ~8–11 ms against ~3 ms with none (it was ~16–22 ms).

## 42.2 Metrics (`server/metrics.go`)

`GET /api/chat/metrics`, superusers only (a user's session gets 403, none 401), `Cache-Control: no-store`. JSON by
default; Prometheus's text format (`text/plain; version=0.0.4`) with `?format=prometheus`, or when `Accept` asks for
text and not JSON, as scrapers do. A scraper signs in with a superuser token (PocketBase's
`POST /api/collections/_superusers/impersonate/{id}` makes one with a long `duration`).

- `queues`: per queue its `rows`, `failing` (tried at least once) and `oldest_seconds`: `telegram` (`tg_queue`),
  `federation` (`fed_queue`), `link_previews` (`link_queue`), `media_thumbs`, `media_sizes`, `media_moves` (`files`
  the media worker hasn't done), `storage_cleanup`.
- `workers`: per worker (`previews`, `media`, `telegram`, `federation`, and the daily `retention`) its `last_pass`,
  `last_error` and `last_error_at` (since the start; `lib/worker.js` notes them in the app store after each pass), and
  `running` (a run holds its lock, renewed in the last 2 minutes).
- `realtime`: `clients` (SSE connections), `senders` (connections with events waiting to be written; the name is
  from when live messages had a sender per client), `queued` (events waiting, all connections) and `dropped`
  (clients disconnected for falling 512 events behind, since the start; PERF.md §9).
- `admission`: API requests that run JS hooks, `slots` (80% of `--hooksPool`), `running`, `waiting` for a slot,
  and `waits` (requests that found every slot taken, since the start; `server/admission.go`, PERF.md §14).
- `db`: the sizes of `data.db`, `auxiliary.db` and their WAL files; `db_conns`: the read pool's `open` and `in_use`
  connections, and how often (`waits`) and how long (`waited_seconds`) a query waited for one; `process`: goroutines,
  heap, memory from the system, resident memory (`rss_bytes`, Linux), GC runs; `version`, `pocketbase`,
  `uptime_seconds`.
- Not reported: the JS hooks pool itself (the jsvm plugin keeps no count of busy runtimes); `admission.running` is the
  most requests that hold one.

The statistics page shows them to a superuser (§40.1). Tests: `tests/integration/retention.test.ts` (the prune's
steps, what it keeps, superusers only; the metrics' fields, a queue's counts, the Prometheus form, who may ask),
`tests/integration/reads.test.ts` (the per-room plan), `tests/unit/stats.test.ts` (the page's figures).
