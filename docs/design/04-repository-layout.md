# §4. Repository layout

Part of the design document: [index](../DESIGN.md).

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
│   ├── build-server.mjs        # go build of server/ → bin/chirkle-server (--all: every platform, for the npm package)
│   ├── build.mjs               # esbuild production build → pb_public/, size budget (§7.7)
│   ├── dev.mjs                 # esbuild watch + spawns `chirkle-server serve`
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
│   ├── 1760000043_telegram_reactions.js # §26.9 (tg_queue's "react" op)
│   ├── 1760000020_service_messages.js  # §5.3 (messages.author optional: service messages)
│   ├── 1760000032_federation.js        # §33 (fed_* collections, the core's federation fields)
│   ├── 1760000033_federation_requests.js # §33.2–3 (site.federation, fed_peers "requested")
│   ├── 1760000037_file_dims.js         # §17.5 (messages.file_dims, media.sized)
│   ├── 1760000038_drop_push.js         # push_tokens and push_queue removed (REFACTOR round 4)
│   └── 1760000039_anonymous_rooms.js   # §35 (rooms.anonymous, messages.anonymous and forwarded_anonymous)
├── server/                     # the server binary: PocketBase + its JS plugin + the hot paths in Go (§3)
│   ├── main.go                 # PocketBase's main, the Go hooks and routes (registered after the JS hooks' routes)
│   ├── enrich.go               # the messages enrich hook: forwards' originals, keepToRoom, anonymous authors (§21.3, §35)
│   ├── live.go                 # live messages on chat/messages, a queue per client (PERF.md §7, §9)
│   ├── lists.go                # GET /api/chat/rooms, rooms/{room}/messages (pages, search), notifiable (§6)
│   ├── unread.go               # GET /api/chat/unread, unread/{room} (§18.2, §41)
│   ├── reads.go                # POST /api/chat/reads, group-committed (§18.2)
│   ├── metrics.go              # GET /api/chat/metrics, superusers: queues, workers, realtime, DB, memory (§42.2)
│   ├── pprof.go                # CHIRKLE_PPROF=host:port: Go's profiler on a listener of its own, for load tests
│   ├── pick.go                 # ?fields= picked straight from the records, one serialization (PERF.md §13)
│   ├── admission.go            # at most 80% of --hooksPool API requests with JS hooks at once, the rest wait (PERF.md §14)
│   ├── gc.go                   # GOGC 200 and a memory limit of 70% of the machine's, unless the environment sets them
│   ├── files.go                # message and collection item files and video posters, from their `files` rows (§37)
│   ├── stats.go                # a realtime subscription's app and account activity (§40.2)
│   ├── access.go, anonymous.go, text.go  # canSee and seesSQL, hide and the probe checks (§35.3), searchKey: as lib/access.js, anonymous.js, text.js
│   └── *_test.go               # go test: the shared text vectors, probes
├── pb_hooks/                   # server-side JS hooks (committed)
│   ├── main.pb.js              # registrations only; every hook on messages, rooms and users (features' parts in order, §5.6)
│   ├── telegram.pb.js          # the Telegram bridge's routes, worker and tg_* hooks, only with TELEGRAM_BOT_TOKEN (§26)
│   ├── telegram/               # the bridge: api, people, links, inbound, outbound, reactions, worker (§26)
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
│       ├── reactions.js        # POST /api/chat/reactions (§20.2)
│       ├── bulk.js             # POST /api/chat/delete, POST /api/chat/forward (§21)
│       ├── account.js          # POST /api/chat/password (§22.2)
│       ├── site.js             # invite-only signups (§24), GET /manifest.webmanifest (§27), App Links (ANDROID.md §9.4)
│       ├── features.js         # the optional features' parts of the core hooks: federation, Telegram (§5.6)
│       ├── worker.js           # the cron workers' loop and lock: previews, media, Telegram, federation (§28.1)
│       ├── retention.js        # the daily prune: old inbox rows, rows left behind by raw deletes (§42.1)
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
│       │   ├── emoji-names.ts  # their names, finding emoji by name (§20.6)
│       │   ├── reactions.ts    # optimistic reaction changes, who reacted (§20.3)
│       ├── ui/                 # small reusable components
│       │   ├── menu.ts, avatar.ts, user-search.ts, emoji-picker.ts + emoji-suggest.ts (a lazy chunk: §20.4, §20.6)
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
