# Performance

How fast the product is and what it costs to run, measured, and what was changed for it. The web client's own
budgets (bundle size, room switching) are in DESIGN.md and checked by the build; the Android app's are in ANDROID.md
§11.

## 1. The server load test

`scripts/bench.ts` starts a throwaway server (as the tests do, with the background workers on), fills a room the way
busy rooms are (300 messages from 20 people: every fifth a reply, every tenth a forward, three in five with
reactions) and measures what clients do most, with the CPU time each costs the server process (not the client):

```sh
node --no-warnings scripts/bench.ts [--out=run.json] [--clients=20] [--idle=60] [--workers=off] [--subs=both|room|activity]
```

| Number | What |
|---|---|
| `pageMs…`, `pageCpuMs` | A room page (50 messages, the web's `expand` and `fields`), one after another: latest and three pages back |
| `pages8…` | The same, 8 clients at once (a room opening on many devices, prefetching), and pages a second |
| `fanout…` | A message sent until all 20 clients, each subscribed as the web is (the room, and all activity), have it |
| `--subs` | Which of the two subscriptions each client makes in the `fanout` phase (to tell their costs apart) |
| `idleCpuMsPerMin` | Nothing asked for `--idle` seconds: the workers, and PocketBase itself |
| `rss…Mb` | The server's memory after seeding and at the end |

Numbers vary by about ±10% between runs; compare runs on the same machine, at the same time (the development machine
is shared: its numbers move by a third from one hour to the next). `--idle=1` skips most of the idle phase. At least 9
clients (the 8 at once, and the reader).

## 2. 2026-10-30: room pages and idle workers

On the development machine (8 threads):

| | Before | After |
|---|---|---|
| Room page, p50 / p95 | 36 / 57 ms | 20 / 29 ms |
| Server CPU per page | 51 ms | 33 ms |
| 8 clients at once: pages a second | 32 | 61–65 |
| 8 clients at once: p50 / p95 | 249 / 331 ms | 122 / 176 ms |
| 8 clients at once: server CPU per page | 165 ms | 101 ms |
| A message to 20 clients, p50 / p95 | 87 / 123 ms | 69 / 97 ms |
| Idle, CPU a minute (PocketBase alone: 45) | 120 ms | 65 ms |

### 2.1 The messages enrich hook

Every message the API answers with goes through a JS hook (`onRecordEnrich`, main.pb.js). Taken apart:

| 8 clients at once | Pages a second | CPU per page |
|---|---|---|
| The hook as it was | 32 | 165 ms |
| The hook doing nothing | 62 | 86 ms |
| No hook at all | 121 | 40 ms |

The hook's work was a query per message: `keepToRoom` read the message's room for every reply or message with
reactions (the same room each time, which the route had already checked), `showOriginal` the original of every
forward. And under load PocketBase runs a hook call beyond `--hooksPool` in a JS runtime made for that one call, which
loads `lib/messages.js` and everything it requires from scratch.

- The list routes (`lib/lists.js`: room pages, the notification check) mark the rooms they checked while they enrich
  (`lib/enrich.js markChecked`); the hook leaves those rooms' messages alone, and the route shows the forwards'
  originals itself in one query (`lib/messages.js showOriginals`), for expanded replies too. The hooks see a copy of
  the request's info, but its query map is shared, so the mark is a query parameter whose value starts with a secret
  of the process (a client can't forge it). Messages from other rooms (`?expand=forward_of`) still go through the
  hook. The records API and realtime are as before.
- The hook asks `lib/enrich.js` (no requires) whether a message needs anything before it loads `lib/messages.js`:
  most need nothing.

What is left is the cost of having a JS hook at all (62 vs 121 pages a second). A larger pool buys some of it back
with memory: `--hooksPool=500` gave 68 pages a second for 250 MB more, so it stays at 100.

### 2.2 The workers

The media and link previews workers (`lib/worker.js`) looked for work every second all day: a few indexed queries
each, about 75 ms of CPU a minute together. They now say `wakes`: idle, a run looks only when a save wakes it
(`wake`, from after-commit hooks: a message with files, a collection item, a link queued) and every 30 s for work
queued some other way. A new upload's thumbnails and a link's preview still start within a second. The federation
worker (off unless linked) and the Telegram bridge (it long-polls Telegram) are as they were.

### 2.3 Live messages (2026-10-30, later)

A message sent costs the server work for every client in the room. Taken apart (CPU per message, 20 clients, half the
messages replies; all measured side by side in one session, when the machine was busier than in the table above):

| What each client subscribes to | CPU per message |
|---|---|
| The room and all activity (the web, the app) | 144 ms |
| The room only | 127 ms |
| All activity only (`fields`, no `expand`) | 42 ms |
| The room only, the enrich hook not registered | 92 ms |
| The same, without `reply_to` in the expand | 43 ms |

- **The quote of a reply** (`expand=reply_to.author`) cost the server about 5 ms a client for every reply: PocketBase
  checks the messages view rule and expands it per client, and its SQL is only 0.5 ms of that. Live events now come
  without it (`LIVE_OPTS` in `api.ts` and `ChirkleApi.kt`): the room takes the quote from the message in its window,
  or from its own copy of the reply (an edit); a reply to a message beyond the window fetches that one message. Pages,
  `getMessage` and `send` still expand it.
- **The JS enrich hook** costs ~35 ms a message even when it does nothing (~0.6 ms a call). It stays: it keeps
  another room's replies and reactions out of a forward's original, which a `messages/{id}` subscription could
  otherwise read.
- **Merging the two subscriptions** would save only ~17 ms: not done.

| A message to 20 clients (same session) | Before | After |
|---|---|---|
| p50 / p95 | 101–108 / 160–179 ms | 61–63 / 79–91 ms |
| Server CPU | 144–147 ms | 87–88 ms (−39%) |

Apps from before this still ask for the quote, and cost what they did.

### 2.4 Quiet connections (2026-10-30, later)

An open web tab left alone, measured for 5–7 minutes (headless Chromium, a room open): nothing but a file token
every 2 minutes (attachment URLs, §17.3), and then, 5 minutes after it connected, a realtime reconnect followed by the
room list, hidden rooms, unread counts, collections and the open room's pages again. PocketBase closes a realtime
connection that has sent nothing for 5 minutes, and both clients take every reconnect for one that may have missed
events. Every quiet client did this every 5 minutes, the app in the foreground too.

`lib/keepalive.js` sends every connected client a `chat/keepalive` event every 3 minutes (cron). Clients have no
listener for it and drop it, old apps included. Over 7 minutes the tab then made only its three file token requests.
`POST /api/keepalive/tick` (superusers) runs it at once, for tests.

## 3. The Android app

The release build is what to judge: debug builds of Compose are many times slower. On the KVM-less emulator here
everything is slow; numbers from it only compare runs with each other.

`android/baselineprofile` (ANDROID.md §33) generates the Baseline Profile (start, the room list, opening a room,
scrolling) and benchmarks start and scrolling with and without it. The profile is in the app since 2026-10-30:

| On the emulator here (TCG, no KVM) | Nothing compiled | With the profile |
|---|---|---|
| Cold start, first frame (median of 5) | 11.7 s | 11.8 s |
| Cold start, room list shown (`reportFullyDrawn`) | 47.2 s | 37.8 s (−20%) |
| Opening the busy room and scrolling: CPU per frame p50 / p90 | 402 / 1,253 ms | 264 / 771 ms (−34% / −38%) |
| The same, p95 / p99 | 1,792 / 5,347 ms | 1,069 / 3,047 ms (−40% / −43%) |

The emulator is many times slower than a phone, so only the differences mean anything: the profile takes about a
fifth off showing the room list and over a third off the room's frames. The first frame doesn't move (on this
emulator it is mostly the process starting).

## 4. The web client profile

`scripts/profile-web.ts` starts a throwaway server with 150 rooms (one with 3,000 messages, the rest with 20) and 25
people, logs in in Chromium, then times the built client (`npm run build` first) with the CPU slowed down (`--cpu`,
default 4×, a mid-range phone) and 80 ms added to every request:

```sh
npm run profile:web -- [--cpu=4] [--latency=80] [--out=run.json] [--check]
```

| Number | What |
|---|---|
| `cold…Ms`, `warm…Ms` | A load straight into the busy room, then a reload (HTTP cache, service worker, kept rooms): when the room list and the messages are in the page |
| `switchFirstP50Ms` | Clicking rooms not visited yet, until the frame after their messages show (median of 15) |
| `switchKeptP50Ms` | Back and forth between the last three rooms (median of 10) |
| `switchHoveredP50Ms` | First visits with the pointer resting on the link for 250 ms first (median of 10) |
| `scrollFrame…Ms` | 8 s of scrolling up through the busy room's history, 120 px a frame: frame times |
| `burstLongTasksMs` | 60 messages coming in 30 ms apart at the bottom of the busy room: long tasks meanwhile |

CI runs it (`speed` job) with `--check`, which fails when a number is over its loose limit in the script's `CHECKS`
(several times the numbers here: CI runners vary). The numbers are kept as the job's `profile-web` artifact. For where
time goes, Chrome's own profiler on the same page; the 2026-11-03 profile (§5) mapped CPU samples to source files
through `pb_public/assets/*.map`.

## 5. 2026-11-03: the web client

A profile (§4's scenarios, Chrome's profiler) found the time in measuring the list on every scroll event and after
every render, in each message's own toolbar and author menu built and listened to, in the composer's focus laying out
the page in the middle of loading, and in work that waited for the script or the room list without needing to. What
was changed:

- **Read state by `IntersectionObserver`** (`views/room.ts`): what is whole on screen or scrolled past, as the
  browser reports it, instead of measuring rows after each render and on each scroll event.
- **One listener per event on the message list** (`views/room/messages.ts`): buttons say what they do (`data-act`);
  toolbars are cloned from one built per kind; an author's menu is made when first opened.
- **Rooms kept** (`app.ts` `withSidebar`, DESIGN.md §7.5): the last 3 rooms you left stay mounted out of the page, live;
  going back to one shows it as it was, nothing fetched or drawn again.
- **A room's page asked for early** (`prefetch.ts` `hint`): on pressing its link, or after the pointer rests on it for
  120 ms; the room starts from that request.
- **Conditional pages** (`pb_hooks/lib/lists.js`, API.md): a page has an `ETag`; the client keeps it with the kept
  page and asks with `If-None-Match`, so an unchanged room is a `304` with no body.
- **What a page loads first, early**: index.html preloads the Latin Inter (asked for otherwise only once the
  stylesheet is in), and pages send a `Link` header with the stylesheet, script and font (`lib/http.js`), which a proxy
  can turn into 103 Early Hints.
- **The session check waits** (`renewal.ts` `renewSoon`): until the room list is in (at most 3 s), not alongside it.
- **The composer's focus on entering a room** is in the next frame, whose layout it uses (`renderFooter`).
- **The media viewer's image** is fetched at high priority (`fetchpriority`), ahead of thumbnails.

Tried and left out, by measurement:

- **An SVG sprite (`<use>`) for the message toolbars' icons**, instead of CSS masks: for a room's 300 icons at 4×,
  cloning took 25–34 ms against ~1 ms, and the next frame 80–120 ms against ~13 ms (each `<use>` builds a shadow tree).
  Room switches got a quarter slower. Masks stay.
- **`content-visibility` on the room list's rows**: at 150 rooms the layout it saves comes back in the next frame
  (53 against 51 ms at 4×); it pays from about 600 rooms (−90 ms), and the CSS budget had no room for it.
- **A worker for pages (parsing, keeping)**: a 50-message page parses in 0.8 ms at 4×; the copy back from a worker
  costs about as much. Nothing to win.
- **HTTP/3** on chat.chirkle.com is a change to the Dokku host's nginx (a build with QUIC, UDP 443 open, `listen 443
  quic` and `Alt-Svc`), not to the app; not done. nginx answers HTTP/2 there now.

Numbers (§4's scenarios, this machine, the client before and after run back to back; ms, medians where several):

| | 4× CPU before | after | 1× before | after |
|---|---|---|---|---|
| Cold load: messages shown | 1,622 | 1,543 | 737 | 740 |
| Cold load: LCP | 1,788 | 1,676 | 776 | 796 |
| Cold load: long tasks, total / longest | 1,023 / 406 | 860 / 356 | 180 / 95 | 153 / 79 |
| Reload: messages shown | 658 | 595 | 258 | 229 |
| Switch to a room not visited yet | 315 | 304 | 138 | 143 |
| Switch back to one of the last 3 rooms | 187 | 105 | 40 | 23 |
| Switch after resting on the link 250 ms | 270 | 181 | 143 | 33 |
| History scroll frames p50 / p95 / max | 46 / 103 / 346 | 48 / 118 / 281 | 17 / 29 / 95 | 17 / 28 / 69 |
| Typing: long tasks | 63 | 0 | 0 | 0 |

The machine is shared and numbers move by 10–30% between runs: only the differences within a column pair count. The
cold load and first visits to a room are about even; kept rooms, rooms pointed at first, reloads and long tasks are
where it shows. The 1× "before" is from an earlier run of the same day.
