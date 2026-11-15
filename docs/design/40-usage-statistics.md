# §40. Usage statistics (2026-11-09)

Part of the design document: [index](../DESIGN.md).

The user: "a separate web page accessible only to superadmin or moderators where you can see how much people online
currently (no names, just count), how much they are using app, etc." and "make a switch for superadmin in db to disable
statistic (so it will not take space over time)". No Android screen (the user's choice): the app is counted, nothing
in it changed.

## 40.1 The page (`/stats`)

A page of its own, not one of the app's: `web/stats.html`, `web/src/stats/main.ts` and `web/styles/stats.css`, built
apart from app.js (`STATS_OPTIONS` in `scripts/lib/build-utils.mjs`; its own budget, §7.7), so the app's
bundle doesn't carry it. `GET /stats` (`lib/http.js statsPage`) serves the built `stats.html` to anyone, with the app's
headers but not its preloads; 404 before a build. The service worker leaves it alone (it would keep it as the app's
offline shell).

It asks `GET /api/chat/stats` with the session the browser has: the app's (`pocketbase_auth`, a moderator), else the
admin UI's (`__pb_superusers__/_`, PocketBase 0.40, a superuser signed in at `/_/` on the same server). Anyone else gets
"Page not found". Moderators find it on Settings (a Moderation card); superusers open `/stats` themselves. Refreshed
every 30 s while the tab is visible.

- **Now**: people online (distinct accounts), on the web, on Android (someone on both counts in each), guests (open
  connections without an account), the peak today and in 7 days.
- **Usage**: active in the last 24 hours, 7 and 30 days (and the share of accounts); person-hours online today and in
  7 days, and per active person; a chart of people online over 24 hours or 7 days (a gap of more than two samples breaks
  the line).
- **Messages**: today, 7 and 30 days with the people who posted, the DMs' share, files sent, reactions on the 30 days'
  messages; a column per day for 30 days. Days are the viewer's (`tz`).
- **Accounts**: total, new in 7 days, moderators, banned.
- **Server**, for a superuser only (2026-11-12, §42.2): uptime and versions, realtime connections, live events waiting
  and slow clients dropped, the database's size, memory; each queue's rows, failed ones and oldest; when each worker
  last passed and its last error.

Counts are of this server's own accounts: not a linked server's people (§33), nor the Telegram bridge's stand-ins
(§26). The charts are drawn at their box's width (text stays 11 px on a phone), with a tooltip on hover or focus (← →
step through the samples) and their numbers in a table under each.

## 40.2 What is recorded (`pb_hooks/lib/stats.js`, `pb_migrations/1760000044_stats.js`)

- **Online now** is read from the realtime broker when asked: each client with at least one subscription; its
  account from its `auth`, superusers (the admin UI) left out. A client's app is noted when it subscribes
  (`server/stats.go`, on the subscribe request, in Go: no JS runtime per subscription) from its User-Agent: `okhttp/`
  is the Android app, `Mozilla/` a browser. Not on connecting: a hook on `GET /api/realtime` would run for as long as
  the connection is open (PERF.md §6).
- **`stats_samples`**: every 5 minutes (cron `stats`) the counts, no ids. Kept a year.
- **`stats_activity`**: a row per account and UTC day it was online, with `last_at`; written by the 5-minute run for
  everyone online and by a subscription (at most once an hour per account; `server/stats.go` keeps only the current hour's accounts), so a visit shorter than 5
  minutes counts. "Active in the last 24 hours" is `last_at` within them. Kept 90 days; deleted with its account.
- Neither table has API rules: only `GET /api/chat/stats` reads them, and it answers counts.
- **`site.no_stats`** (hidden, ticked by a superuser in the admin UI): nothing more is recorded. Live numbers and the
  message counts still show, with a note; what was recorded ages out as before (the daily prune, cron `stats-prune`,
  runs either way).
- An index on `messages.created` keeps the 30 days' counts a range scan.
- `STATS_CRON=off` (tests) leaves the run and the prune to `POST /api/stats/tick` (superusers).

Cost: a row every 5 minutes, and per account at most one upsert per hour while connected, plus one per online account
in the 5-minute run (one transaction). Nothing per message.

## 40.3 Tests

`tests/integration/stats.test.ts` (who sees it, no API rules, no names in the answer, the page served; online by app and
guests, superusers left out, gone on disconnect; recording, `no_stats`, the prune and a deleted account; messages,
DMs, files, reactions, accounts; the viewer's days), `tests/unit/stats.test.ts` (person-hours, peaks, runs, the 30 days,
axis tops). Looked at in Chromium (light, dark, 390 px; as a moderator, another account, and a superuser through `/_/`).
