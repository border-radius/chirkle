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
  can turn into 103 Early Hints. It is read again when index.html changes, so a new build put in place while the
  server runs is what pages name (QA BUG-206).
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

## 6. 2026-11-09: no JS router middleware

autism.th61.com was slow at low CPU (QA BUG-250). Room pages took seconds, while the routes that run no JS enrich hook
stayed at about 140 ms. A JS handler given to `routerUse` runs in a runtime of the pool (`--hooksPool`) and keeps it
until its `e.next()` returns, which means for the whole request. With four such middlewares, every open realtime
connection held four runtimes for hours, and every file coming from S3 held four for a second or two. Once the pool
was taken, each message of a room page made a new runtime for its enrich hook (§2.1).

| Local, 60 messages, `kind=latest&limit=50&expand=author,reply_to.author,forwarded_from` | Before | After |
|---|---|---|
| a page, no realtime connections | 23 ms | 23 ms |
| a page, 25 realtime connections open | 87 ms | 23 ms |
| a page, 120 realtime connections open | 74 ms | 23 ms |

The rule now (`tests/unit/build/hooks.test.ts` checks it): no `routerUse` with a JS handler, only PocketBase's own
(`$apis.…`). Work for some requests goes in the routes and hooks of those requests:

- **Headers** (CSP, caching, `Link`): `lib/http.js` `headers`, called by the routes that serve the app: `/{path...}`
  (the public directory with index.html for any other path, as PocketBase serves it when no route of ours does),
  `/assets/…`, the manifest, `assetlinks.json`. PocketBase's own middleware sends nosniff with every API answer.
- **The body limit**: PocketBase's. It sizes each collection's create and update by its fields, so a message create
  takes 10 × 20 MB through `messages.files`' `maxSize` (DESIGN.md §17.1), and every other route keeps 32 MB.
- **The anonymous rooms' probe check** (DESIGN.md §35): in the record request hooks (list, view, create, update, every
  auth answer), the realtime subscribe hook, and the routes that enrich records. It uses `e.requestInfo()`, since the
  record request events have no `request` in JS.
- **Messages' and items' files** (DESIGN.md §37.2): routes `/api/files/messages/{recordId}/{filename}` and
  `/api/files/collection_items/…`, more specific than PocketBase's `/api/files/{collection}/…`, so no other request
  runs JS for this. A file download still holds one runtime while it streams from S3 (as posters do), not four.

Still slow on autism.th61.com, and not changed here: a file's first fetch from S3 is about 0.33 s (a thumbnail about
0.7 s: it checks before it reads). Cloudflare keeps them after that.

### 6.1 Stress test (2026-11-09)

`scripts/stress.ts` runs a crowd against a throwaway server. Its files are in S3 (versitygw) behind a proxy that holds
each answer back 150 ms, close to what a hosted instance's S3 adds (about 200 ms an operation on autism.th61.com).
`--hooksPool=100` and the media worker are on, as in production. 100 users sign up into 10 rooms of 150 messages,
every sixth with a 60 KB photo. Each user keeps the web's realtime subscriptions, then loops, with an exponential think
time between actions:

- open a room: its latest page, then up to 8 of its photos' thumbnails;
- scroll back a page;
- send: some replies, 10% with a photo;
- react;
- mark read and count unread;
- list rooms;
- open a photo.

"Before" is today's hooks with the four old JS middlewares put back in front (§6). Everything ran on one 8-core
machine, the clients too. No action failed in any run below.

**Busy** (`--think=5000`: each user acts every 5 s or so, about 3 messages a second in all), 60 s:

| p50 / p95, ms | Before | After |
|---|---|---|
| room page (latest) | 378 / 4484 | 49 / 2653 |
| open a room with its thumbnails | 1386 / 9693 | 707 / 5857 |
| send | 1226 / 2431 | 208 / 395 |
| react | 1119 / 2676 | 215 / 375 |
| mark read + unread | 107 / 332 | 11 / 36 |
| a message reaching all 100 users live | 609 / 1709 | 124 / 322 |
| server CPU, peak memory | 443%, 2.9 GB | 170%, 1.5 GB |

**Overload** (`--think=1000`: about 75 actions a second and 5 messages a second), 90 s:

| p50 / p95, ms | Before | After |
|---|---|---|
| room page | 744 / 4220 | 522 / 2465 |
| send | 7507 / 17857 | 5819 / 12543 |
| live delivery | 5382 / 15979 | 4062 / 10843 |
| server CPU, peak memory | 638%, 2.85 GB | 576%, 1.77 GB |

What is left under overload is the realtime fan-out. Each saved message, and each reaction (an update of the
message), goes to every subscriber. For each one PocketBase checks the view rule and runs the messages enrich hook,
which is JS (§2.1, §2.3). With 100 subscribers, the pool overflows on every event. Two 45 s overload runs (after the
fix) separate the parts:

| p50, ms | Realtime on | Enrich hook removed | Realtime off |
|---|---|---|---|
| send | 4470 | 1340 | 123 |
| react | 4689 | 1219 | 131 |
| room page | 573 | 137 | 252 |
| live delivery | 3258 | 862 | n/a |
| peak memory | 1.6 GB | 0.94 GB | 1.6 GB |

So the enrich hook costs about two thirds of a write's time under load, and PocketBase's own per-subscriber checks
most of the rest. The hook does the work of anonymous rooms, forwards, and replies' and reactions' visibility. Not
changed yet.

In the busy run, a room page's p95 (2.7 s) is the first seconds: 100 users arrive within 5 s and each opens a room,
with 8 thumbnails that are made from S3 on first asking.

The proxy has to pass half-closes through in order. Tearing both sides down at once cut keep-alive connections that
PocketBase had just sent a request on: `EOF` from its S3 client, 400s on files. That was the proxy, not the server.

## 7. 2026-11-09: live messages on one topic

The stress test (§6.1) found the realtime fan-out to be what was left. PocketBase sends a record event to each
`messages/*` subscriber after checking its list rule, and runs the messages enrich hook (JS) for each one. So with
100 listeners, every message, edit and reaction made 100 JS calls, and more than the pool has. Now
`pb_hooks/lib/live.js` (`server/live.go` since §9) sends each message once, from the after-save hooks, on the `chat/messages` topic:

- one hook call per message;
- the message is expanded once (`author`, `forwarded_from`), a forward shows its original once (`showOriginal`),
  and an anonymous room's message is hidden once (`hide`), with its author's own view beside it;
- it is trimmed to the contract's message fields (`shared/contract.json`; `tests/unit/contract.test.ts` checks the
  copy);
- then it goes to each listening client that `canSee` its room. That is the list rule PocketBase checks for
  `messages/*`, and `access.matrix.test.ts` checks live messages against the table like every other way in.
- keepToRoom isn't needed: only those who see the room get its messages.

The web's room subscription and its activity both listen to the topic and keep what they need (`api.ts`). The app
asks `GET /api/chat/live` first and falls back to `messages/*` on a 404 (ANDROID.md §56). Apps from before still
subscribe to `messages/*`, which still works, at the old cost for each of them.

The stress test, 100 users, against §6.1's "after":

| p50 / p95, ms | Overload, §6.1 | Overload, now | Busy, §6.1 | Busy, now |
|---|---|---|---|---|
| send | 5819 / 12543 | 156 / 996 | 208 / 395 | 19 / 120 |
| react | 5733 / 12188 | 133 / 925 | 215 / 375 | 16 / 90 |
| room page (latest) | 522 / 2465 | 192 / 1255 | 49 / 2653 | 42 / 2351 |
| mark read + unread | 1005 / 8918 | 90 / 646 | 11 / 36 | 10 / 73 |
| live delivery to all 100 | 4062 / 10843 | 174 / 977 | 124 / 322 | 16 / 184 |
| actions handled | 74.9/s | 169.9/s | 46.1/s | 49.5/s |
| server CPU | 576% | 479% | 170% | 107% |

Under overload the server now does more than twice the work: 1174 messages sent in 90 s against 424, each reaching
all 100 users. What is left:

- **A room page's p95** comes from the first seconds, with 100 users arriving at once.
- **Thumbnails' p95** (about 1.2–2.2 s) is S3: a file served holds one JS runtime while it streams (§6).
- **The server's peak memory** stays at about 1.5–1.7 GB.

## 8. 2026-11-09: a $5 VPS (one CPU)

What one small VPS (1 vCPU, 1 GB) carries, with `scripts/stress.ts` against §7's server. The server and what it spawns
are pinned to one CPU with `GOMAXPROCS=1` and `GOMEMLIMIT=700MiB` (`--cpu=7 --memlimit=700MiB`), and the clients run on
other CPUs (not the pinned CPU's SMT sibling). The container has no cgroups, so 1 GB isn't enforced: the memory column is the peak
of the server and its children together, which a 1 GB box would have to hold. `--warm` makes the history's thumbnails
first, as a live instance has them; `--files=off` fetches no files, as when Cloudflare or the browser's cache serves
them; `--arrive` is the number of seconds over which the users arrive. Steady state means after the first 30 s.

| Users, think, arrive | Files | Steady p50 / p95, ms: page · send · live | Peak memory | Verdict |
|---|---|---|---|---|
| 100, 5 s, 5 s (cold thumbnails) | on | page 28,000 · open room 53,000 | 1.1 GB | 800 thumbnails made at once |
| 100, 5 s, 5 s | on | 88 / 486 · 37 / 299 · 47 / 381 | 0.78 GB | fine (≈45 actions/s, 3 msgs/s) |
| 200, 5 s, 5 s | on | 4,314 / 16,509 · 6,234 / 33,772 · 6,337 / 33,553 | 2.2 GB | overloaded |
| 500, 30 s, 5 s | on | ~90,000 | 6.5 GB | collapsed (arrival storm) |
| 500, 30 s, 5 s | off | ~75,000 | 6.0 GB | collapsed: not files |
| 500, 30 s, 5 s, `--live=off` | off | ~75,000 | 5.8 GB | collapsed: not realtime |
| 500, 30 s, 60 s | off | 123 / 1,742 · 84 / 1,742 · 99 / 1,274 | 0.67 GB | fine (≈22 actions/s, 2.4 msgs/s) |
| 1000, 60 s, 120 s | off | 2,233 / 164,115 · 136,458 / 221,236 · 69,713 / 212,680 | 6.4 GB | collapsed |

Two limits show up, and both end in the same way. Once more than `--hooksPool` (100) JS calls are in flight, each further
call builds a fresh goja runtime, about 11 MB with the libs loaded again. Memory then climbs to several GB, and the box
falls further behind, never catching up:

- **Many requests at once.** About 500 room opens within 5 s (a restart or a network blip: every client reconnects
  and loads its room) send a single CPU into this spiral. Spread over 60 s, the same 500 users are fine.
- **Fan-out to many listeners.** At 1000 listeners, about 1.3 messages a second is too many. `lib/live.js` (likewise
  keepalive.js, collections.js, access.js) calls `client.send()` inside the saving request, once per listener.
  PocketBase's client channel is unbuffered (`tools/subscriptions/client.go`), so a save waits for every listener's
  SSE writer, and holds its JS runtime the whole time. PocketBase's own broadcasts send from goroutines
  (`routine.FireAndForget`). This is inferred from the code and the numbers; a goroutine dump wasn't taken.

Changed on 2026-11-11: the pages and live messages are Go now, and neither case collapses any more (§9).

## 9. 2026-11-11: the hot paths in Go (REFACTOR item 47)

The server is built from `server/`: PocketBase with its JS plugin, plus the messages enrich hook, live messages, the
list routes and the unread counts in Go (DESIGN.md §3). The JS hooks are what they were for everything else. Same
machine and harness as §8 (`--cpu=7 --memlimit=700MiB`, clients on CPUs 0–5, `--files=off`), with the two cases that
collapsed there:

| Users, think, arrive, run | Steady p50 / p95, ms: page · send · live | Peak memory | §8 (JS) | Verdict |
|---|---|---|---|---|
| 500, 30 s, 5 s, 120 s | 42 / 216 · 28 / 181 · 59 / 1,374 (whole run) | 0.55 GB | ~75,000 ms, 6.0 GB | fine after the storm |
| 1000, 60 s, 120 s, 240 s | 65 / 305 · 50 / 296 · 104 / 427 | 0.37 GB | 2,233 / 164,115 · 136,458 / 221,236 · 69,713 / 212,680, 6.4 GB | fine (23 actions/s, 2.5 msgs/s) |

- **The storm** (500 room opens within 5 s) still queues: in the first 30 s a page took 2.5 s at the median and 14 s at
  p95, and the server caught up within about 30 s. Before, it never did: each request beyond the pool built a fresh JS
  runtime. A page now runs no JS at all (the route, its enrich hook and the realtime events it may cause are Go), so it
  can't overflow the pool. What still runs JS per request: the records API's request hooks (`refuseProbes`), sign-ups and
  logins, the realtime subscribe hook.
- **The fan-out:** each message goes once to every listening client's own queue (`server/live.go`), and a goroutine per
  client writes it out in order. The save no longer waits for 1000 SSE writers: all 600,000 events arrived, p99 0.66 s.
  A client 512 events behind would be disconnected (its app reloads what it missed); none was.
- CPU stayed at about 50% of the one core in both runs.

`--hooksPool=100` is kept: the JS request hooks and routes still use the pool, and a smaller one hasn't been measured.

## 10. 2026-11-12: one size budget, the inbox counts (REFACTOR items 49, 52)

- **Shared chunks** (DESIGN.md §7.7). Letting lazy chunks share code with `app.js` split it: 46.95 KB became 37.3 KB
  plus six modulepreloaded chunks (12.4 KB); the critical path went 58.78 → 61.44 KB gzipped. `scripts/profile-web.ts
  --cpu=4`, 3 runs each, medians, before → after: cold room list 1053 → 986 ms, cold messages 1398 → 1361 ms, warm 464 →
  506 ms, first-visit switch 249 → 256 ms, kept switch 108 → 109 ms, scroll p95 102 → 112 ms. Within run-to-run
  noise (warm ran 452–600 ms on the same build): the extra requests go in parallel and the bytes cost nothing visible.
- **Inbox counts** (DESIGN.md §42.1). With 5,000 inbox rows in 5 rooms the per-room mentions query took 13 ms (a
  GROUP BY over every row of the person's); driven by room from the read position on an index
  `(user, room, created)`, 1.5 ms. `GET /api/chat/unread`: ~16–22 ms → ~8–11 ms; ~3 ms with an empty inbox.

## 11. 2026-11-12: a $5 VPS, measured again

§8's question again, on today's server: the hot paths in Go (§9), shared chunks, and the inbox counts (§10). The harness
is the same as §8 and §9: `--cpu=7 --memlimit=700MiB`, clients on CPUs 0–5, `--files=off`, 10 rooms × 150 messages,
photos in about 1 send in 10. As in §8, "steady" means after the first 30 s, and memory is the peak RSS of the server
and its children. "Busy" users act every 5 s; "calm" ones act every 60 s.

| Users, think, arrive, run | Steady p50 / p95, ms: page · send · live | Actions/s | CPU | Peak memory | Verdict |
|---|---|---|---|---|---|
| 100, 5 s, 5 s, 120 s | 44 / 149 · 18 / 108 · 30 / 209 | 25 | 43% | 0.23 GB | fine |
| 200, 5 s, 5 s, 120 s | 97 / 321 · 95 / 495 · 153 / 820 | 48 | 75% | 0.30 GB | fine |
| 300, 5 s, 5 s, 120 s | 303 / 911 · 3,505 / 13,409 · 3,727 / 13,219 | 50 | 91% | 0.50 GB | overloaded |
| 400, 5 s, 10 s, 120 s | 409 / 1,570 · 10,352 / 37,734 · 11,102 / 37,317 | 44 | 82% | 0.72 GB | overloaded |
| 1000, 60 s, 120 s, 240 s | 64 / 257 · 57 / 263 · 114 / 407 | 23 | 50% | 0.37 GB | fine (as §9) |
| 1500, 60 s, 120 s, 240 s | 252 / 772 · 395 / 2,612 · 528 / 2,812 | 34 | 73% | 0.57 GB | slow sends, usable |
| 2000, 60 s, 120 s, 240 s | 2,784 / 16,612 · 132,583 / 270,712 · 131,314 / 277,120 | 35 | 86% | 1.17 GB | collapsed |
| 1000, 30 s, 5 s, 120 s (storm) | 519 / 3,110 · 5,250 / 20,303 · 5,980 / 24,646 | 45 | 88% | 0.79 GB | behind for the whole run |

- **One core holds about 1,000 people at a normal pace, or 200 chatting nonstop:** roughly 45–50 actions a second
  of this mix (a quarter room opens, a fifth sends, the rest reactions, read marks, older pages and room lists).
  Past that, the CPU is full. At 1,500 calm users sends take 0.4 s at the median and 2.6 s at p95; at 2,000 they fall
  minutes behind, a few fail, and memory goes past 1 GB. 3,000 wasn't measured: signing up 3,000 users took the
  harness 18 minutes, past the run's timeout.
- **Writes show the overload first, but aren't its cause.** Every write (send, reaction, read mark) takes SQLite's one
  write connection, so once the CPU is full they queue behind each other: at 400 busy users ~170 requests waited for
  it (goroutine dump) while pages took 0.4 s. Each write needs ~3 ms of CPU but held the connection ~55 ms, because
  on one core it shares the CPU with every page in flight. A CPU profile of that run (`CHIRKLE_PPROF`,
  server/pprof.go; 30 s, 23.7 s of samples): message pages and their enrich hook ~8 s, GC ~3 s, SQLite ~2.5 s, all JS
  (the writes' hooks, the reactions and reads routes, the records API's request hooks) ~3.8 s, inside write
  transactions ~1.5 s. Letting only 2 pages run at once (an experiment, not kept) moved the queue to the pages: sends
  2.4 s, pages 6 s, CPU 92%. So moving the writes to Go would save at most the JS share (~16%); the pages cost more.
- **The storm:** 1,000 users who arrive within 5 s (§9 measured 500) don't catch up within the 2-minute run (sends
  5 s at the median). Spread over 2 minutes, the same 1,000 users are fine.
- Compared with §8 (JS only): calm users went from about 500 to 1,000–1,500, busy ones from 100 to 200, and memory
  stays under 1 GB up to 1,500.
- A first series on 2026-11-12 put 200 busy users at 6 s sends: its timed-out 3,000-user run had left its server
  running on the pinned CPU. `scripts/stress.ts` now stops its server when it is killed.

## 12. 2026-11-12: shorter writes

§11 found the writes queueing on SQLite's one write connection, each holding it ~55 ms for ~3 ms of CPU. Two changes
shorten what holds it:

- **Read marks group-committed** (`server/reads.go`, DESIGN.md §18.2). `POST /api/chat/reads` is Go. A mark that
  doesn't move the position is answered from a read; the others queue, and one goroutine saves whatever has queued in
  one transaction, answering each request after the commit (so an answer still means the row is stored, and the
  realtime events are PocketBase's own).
- **A message's create checks before its transaction** (`pb_hooks/main.pb.js`, `lib/messages.js` prepareCreate). The
  create request used to run all of it inside one transaction: the JS checks (room, access, reply, forward), the
  mentions lookup, the uploads with their round trips to S3, the save, and the answer's enrich hook. Now the request
  hook does the checks, finds the mentions and stores the uploads (each `files` row saved on its own) first; the save
  opens the transaction itself, around the links of its files, the insert and what it queues (inbox, bridges, previews,
  media). A create refused after its uploads were stored drops them (`files.discard`). The create rule was already
  checked outside any transaction, so nothing that was atomic before isn't now.

Same harness as §11, 300 busy users (5 s think, arriving in 5 s, 120 s), steady p50 / p95 in ms:

| Build | Actions/s | CPU | Send | React | Mark read + unread | Page |
|---|---|---|---|---|---|---|
| §11 | 50 | 91% | 3,505 / 13,409 | 3,130 / 13,130 | 1,844 / 13,095 | 303 / 911 |
| read marks grouped | 57 | 85% | 1,638 / 6,945 | 1,724 / 7,541 | 2,588 / 7,607 | 337 / 913 |
| and checks before the transaction | 62 | 88% | 766 / 3,689 | 663 / 3,206 | 1,067 / 5,692 | 742 / 2,239 |

- 25% more done per second on the same core, and writes 4–5× faster at the median, 3–4× at p95. Pages got slower:
  writes no longer wait while pages run, so the queue they used to make is shared. Sends with a photo: 2.4 s at the
  median, from 3.7 s.
- 400 busy users stay overloaded (51 actions/s, CPU 89%; sends 5.8 s at the median): one core is full, and the next
  step is making pages cheaper (§11's profile: pages and their enrich hook ~35% of the CPU).
- 200 busy users were fine before (§11) and are not rerun.

## 13. 2026-11-12: one serialization per answer, less GC

The profile of §12's build at 400 busy users (30 s, 27.6 s of samples) put PocketBase's `?fields=` picker first: ~6.6 s,
a quarter of the core. To pick fields it serializes the records, parses that back and serializes the picked result;
the page route had also serialized each page once more for its ETag. GC was ~2 s, the expands (`?expand=`, their
queries) ~2.7 s, all JS ~3.9 s.

- **Pages serialized once** (`server/lists.go` tagged): the picked answer is made once, hashed for the ETag and
  written. Found on the way: `encoding/json/v2` doesn't sort map keys unless told to, so a picked page's ETag would
  have changed every time; serialized deterministically, and `lists.test.ts` asks a page as the apps do five times
  for 304s.
- **`?fields=` without the round trip** (`server/pick.go`): the fields are taken from each record's public export
  directly, for the room list, pages, notifiable and live events. Field lists it doesn't handle (modifiers, `*`, a
  path into a JSON value) go to PocketBase's picker; `pick_test.go` checks both give the same answer for the
  contract's fields and those cases.
- **GOGC 200** (`server/gc.go`), unless the environment sets GOGC: the heap grows twice as far between collections.
  Unless GOMEMLIMIT is set, the server holds itself to 70% of the machine's memory (cgroup limit or RAM), so a 1 GB box
  collects harder rather than swapping. Measured with the page fix at 300 busy users, GOGC 100 → 200: sends p50
  180 → 87 ms, pages 211 → 101 ms, CPU 91% → 84%, peak memory 0.38 → 0.56 GB.

Same harness as §11 (`GOMEMLIMIT=700MiB` from `--memlimit`), steady p50 / p95 in ms:

| Users, think, arrive, run | §12 build: page · send | Now: page · send · live | Actions/s | CPU | Peak memory |
|---|---|---|---|---|---|
| 300, 5 s, 5 s, 120 s | 742 / 2,239 · 766 / 3,689 | 24 / 107 · 36 / 184 · 53 / 316 | 73 (62) | 68% | 0.47 GB |
| 400, 5 s, 10 s, 120 s | 1,353 / 6,579 · 5,773 / 17,758 | 287 / 960 · 595 / 1,613 · 821 / 2,424 | 85 (51) | 87% | 0.65 GB |
| 1000, 30 s, 5 s, 120 s (storm) | §11: 519 / 3,110 · 5,250 / 20,303 | 63 / 182 · 90 / 255 · 143 / 759 | 55 | 63% | 0.68 GB |
| 2000, 60 s, 120 s, 240 s | §11: 2,784 / 16,612 · 132,583 / 270,712 | 255 / 3,185 · 1,769 / 8,421 · 2,367 / 10,104 | 46 | 69% | 0.79 GB |

- 300 busy users are now comfortable (sends 36 ms at the median, a third of the core idle), and 400 are usable (sends
  0.6 s). Since §11 the same core does about 70% more (50 → 85 actions/s).
- The storm (1,000 users arriving within 5 s) is caught up within the first 30 s now: steady sends 90 ms.
- 2,000 calm users no longer collapse, but sends take 1.8 s at the median (row above, one harness process).
- **The harness, then, at 2,000+** (`scripts/stress.ts --workers`, users seeded in SQL and signed in by
  impersonation: seeding 2,000 took 16 s instead of 15 minutes). Its one Node process had run at 90% of a core for
  2,000 clients; spread over 6, the same run measured sends 1,024 / 4,540, pages 241 / 1,466, read marks 1,991 /
  11,675 (p50 / p95, ms), 46 actions/s, all 2.4 million live events delivered (p50 1.4 s), peak 0.77 GB. So the
  harness was part of the slowness, not all of it: 2,000 calm users are near what one core does. The server's 69% is
  averaged over the 120 s the users take to arrive; a goroutine dump taken 60 s in, while half had arrived, showed no
  request waiting, and was read too soon as "the server is idle".
- **3,000 calm users collapse** (users arriving over 180 s, 300 s run): sends 70 s at the median, 600 failed
  requests, 92% of live events delivered, and 2.1 GB of memory, far past the 700 MiB GOMEMLIMIT: JS runtimes made for
  one call each (§14). 4,000 weren't measured: the test machine ran short of memory.

## 14. 2026-11-12: memory under overload (admission)

Why 3,000 calm users took 2.1 GB: heap profiles 60 and 120 s after the last arrival put 1.1 GB of a 1.4 GB heap under
the JS hooks pool (`vmsPool.run`). With all `--hooksPool` (100) runtimes busy, PocketBase builds a runtime for that one
call with every hook file loaded: megabytes, and CPU the backlog needed. Once the core fell behind, hundreds of requests
were in flight, each beyond the 100th with its own runtime. What every connected client costs is small by comparison:
at 2,000 clients ~240 MB of heap, of it ~90 MB their two 512-event queues (`realtime.go`, `live.go`), ~45 KB each; the
0.75 GB resident is the GC using what GOMEMLIMIT allows (`gc.go`), not need.

**Admission** (`server/admission.go`): at most 80% of `--hooksPool` API requests run at once; the rest wait in Go, a
goroutine of a few KB each, stop waiting when their client leaves, and run in arrival order. Not counted:
- the routes in Go (`register` unbinds the middleware from them): no JS runs in their request. Counted at first, a
  read mark waiting for its group commit, or a page, held a slot; the slots filled with requests waiting for the one
  write connection, and 2,000 users' sends went from about 1.5 to 17 s;
- the realtime stream, file and poster downloads, health checks, metrics;
- uploads (multipart) and bodies over 64 KB: their hooks run once the body has arrived, and a slow sender must not hold
  a slot. A counted request's body (≤ 64 KB) is read before it waits, for the same reason. It is read through
  PocketBase's body limit, and handed on as a body that can be read again; handed on as a plain reader, the hooks read
  it and the form found nothing, which every JSON login in the integration tests caught.
- `CHIRKLE_ADMISSION=off` turns it off. `GET /api/chat/metrics` reports `admission` (slots, running, waiting, waits),
  resident memory, and the read connection pool.

| Calm users (§13 harness) | Send p50 / p95 | Page p50 / p95 | Live delivered | Failed requests | Peak memory |
|---|---|---|---|---|---|
| 3,000, without | 81.7 / 280.4 s | 9.9 / 82.8 s | 96.4% | ~1,100 | 1.94 GB |
| 3,000, with | 83.3 / 135.5 s | 25.6 / 119.3 s | 100% | 0 | 0.80 GB |
| 2,000, without (A) | 4.3 / 27.1 s | 0.36 / 4.4 s | 100% | 0 | 0.79 GB |
| 2,000, with (B, right after A) | 1.8 / 8.1 s | 0.19 / 2.7 s | 100% | 0 | 0.78 GB |

- 3,000 calm users are still more than one core does, but the server now stays within its memory and loses nothing:
  no failed request, every live event delivered.
- At 2,000 there's no cost to see: runs on the same build swing from 1.4 to 4.3 s at the median without admission and
  1.8 to 9.7 s with it, near the core's limit (§13 measured 1.0 to 1.8 s). The capacity in the README stands.
- When measuring: a goroutine dump (`?debug=1`) cuts deep stacks, so requests in JS don't show their admission frame;
  count `admission.running` in the metrics instead. And check `pgrep -a chirkle-server` first: a test server left
  running by a hung test run answered a sampler for a whole run here.
