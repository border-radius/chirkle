# Refactoring TODO

Architecture review of the MVP, 2026-10-10. The foundations are good: one SDK seam (`api.ts`), pure logic in
`lib/`, a real-backend test harness, an XSS sink guard and a size budget. Most items below are about **where
state and lifecycle live**. Today every view repeats its own copy of them.

Ordered by value ÷ effort. Each item should keep `npm run check` and e2e green, and should land on its own.

**Progress:** all done. New modules: `sync.ts`, `actions.ts`, `context.ts`, `scope.ts`, `ui/menu.ts`, `views/room/{controller,header,messages,composer}.ts`,
`lib/limits.ts`. Writes stay unabortable on purpose (a send in flight should still land after navigating away).

---

## P1 — Structural

### 1. Stop remounting the sidebar on every room switch ✅
- [x] The router keys views by the full hash, so going from `#/r/a` to `#/r/b` unmounts the whole `withSidebar`
      layout (`app.ts:21`). The rooms view then refetches `listRooms` + `listHidden`, re-subscribes to realtime
      and rebuilds the "New room" form, which loses any half-typed name.
- [x] Fix: add an optional `update(params)` to `View`. The router calls it when the next route has the same *view factory* and
      only the params change. `withSidebar` forwards it to the pane only, and the sidebar stays mounted.
- [x] Have `matchRoute` return the `Route` itself instead of a pattern string that is then looked up again
      (`router.ts:59-60`). That also removes the `route!` / `m!` assertions.

### 2. Move room/hidden data sync out of views and into an app-level service ✅
- [x] `rooms.ts` and `room.ts` both subscribe to `rooms`, so the room page holds **two** identical realtime
      subscriptions. Both also implement "reload on reconnect".
- [x] Add `web/src/sync.ts`: on login it loads rooms and hidden rows, subscribes once, and refetches on reconnect.
      On logout it tears everything down. Views only read `store` and call commands.
- [x] This also gives a single place to show a "reconnecting…" status later.

### 3. One home for room commands and store mutations ✅
- [x] `setRoom` exists in both views. Hide, unhide, archive and unarchive are implemented twice, with slightly
      different store updates: `room.ts:322` filters by roomId, `rooms.ts:63` filters by rowId.
- [x] Add `web/src/actions.ts`: `createRoomActions({ api, store })` returning `hide(room)`, `unhide(room)`,
      `setArchived(room, bool)`, `createRoom(name)`. Each one makes the API call and the store update. The views
      keep only the UI around them (menus, error text).
- [x] Put store mutators next to the store, for example `upsertRoom`, `removeRoom`, `setHidden` and
      `clearHidden` in `store.ts`, so the immutable `new Map(...)` copying lives in one place.

### 4. Split `views/room.ts` (804 lines) ✅
It currently holds the window state machine, loading, realtime, the composer, edit/delete, the header menu and
rendering. Suggested split:
- [x] `room/controller.ts`: window, `gen`, buffer, `open` / `jump` / `loadEdge` / `gapFill` / `onMessage` / send /
      edit / delete. No DOM. It emits "changed" with a hint (`anchor`, `scrollToBottom`, `pill`). Most of
      `tests/unit/views/room.test.ts` (867 lines) can then become fast controller tests.
      Done (2026-10-11): the controller owns the window, the phase (`loading` / `ready` / `failed` / `not-found`) and the pill,
      and asks the view only `nearBottom()`. `tests/component/views/room-controller.test.ts` has the window, race, reconnect,
      send and edit tests with no DOM or fake layout. The 10 view tests that only checked window logic moved there.
- [x] `room/messages.ts`: the list element, sentinels, `messageNode` + signature cache, day dividers, and the
      edit/delete-confirm/error UI state, plus its focus handling.
- [x] `room/composer.ts`: textarea, counter, Enter/Up-arrow handling, `validText` (shared with edit).
- [x] `room/header.ts`: title + actions menu, built on the shared menu component (item 5).
- [x] `views/room.ts`: puts controller changes on screen; scroll, pill, read state, drag and drop, and wiring.

### 5. Extract the "actions menu with confirm step" component ✅
- [x] `rooms.ts:116-194` and `room.ts:278-379` both build a `<details>` menu with Escape-to-close, an inline
      "Archive …? / Archive / Cancel" confirm, and focus restore through `focusAfter` selectors.
- [x] Add `web/src/ui/menu.ts`: `actionMenu({ label, items, signal })`, where an item can be
      `{ label, run }` or `{ label, confirm: { text, action, run } }`. The component owns open/confirm state and
      focus restore, so callers stop passing selector strings around.

### 6. Fix the loading race in the room view ✅
- [x] `open()` / `loadAround()` assign `win` **before** checking `gen` (`room.ts:464, 474`). If "Jump to
      beginning" runs while the first load is still in flight (the menu is rendered at mount, before `ready`),
      the late `open()` result overwrites the window that `jump` loaded.
- [x] Make every loader return a `MessageWindow` and commit it in exactly one place, behind the `gen` / `active`
      check. Add a unit test: jump("first") during a slow initial load.

---

## P2 — Consistency and duplication

### 7. A view lifecycle helper ✅
Every view has the same fields: `ac`, `active`, `subs: Promise<Unsubscribe>[]`, `offStore`, `offConnect`, and an
`unmount` that walks through them.
- [x] Add `web/src/scope.ts`: `const scope = createScope()` with `scope.signal`, `scope.active`,
      `scope.defer(fn)` and `scope.sub(promise)` (awaits and unsubscribes when disposed), plus `scope.dispose()`.
      `unmount` then becomes `scope.dispose(); clear(root)`.
- [x] Remove `dom.ts`'s `on()` and its test. Nothing in `web/src` uses it, and `h(..., { on, signal })` covers it.

### 8. Actually abort in-flight requests on unmount ✅
- [x] DESIGN §7.2 says unmount aborts fetches. In practice `autoCancellation(false)` is set, only `api.page`
      accepts a signal, and `room.ts` never passes one. Results are dropped by the `active`/`gen` guards, but the
      requests still run.
- [x] Give every read method in `Api` an optional `signal`, and pass `scope.signal` (item 7).

### 9. Shared limits and error text ✅
- [x] Limits live in several places: message max 2000 (`room.ts:24`, migration), name max 32 (`login.ts:25`,
      migration), room name max 48 (`rooms.ts:236`, migration), password min 8 (`login.ts:27`). Move them to
      `web/src/lib/limits.ts`, and add an integration test asserting the live schema matches them (field
      `max`/`min` from `/api/collections`).
- [x] "Can't reach the server…" / "Something went wrong…" are written out separately in `login.ts` and
      `rooms.ts`, and differently again in `room.ts`. Add `describeError(err, overrides?)` next to `ApiError`.
- [x] `rooms.ts:22` matches the server's English string `"Value must be unique."`. Match the validation **code**
      instead (`validation_not_unique`): keep `code` on `ApiError.fields` in `toApiError`.

### 10. Keep SDK details in `api.ts` ✅
- [x] `lib/cursor.ts` exports `MSG_FIELDS` and `listOptions()` with `expand: "author"`. That is SDK knowledge
      leaking into a pure module, and it duplicates `msgOpts` in `api.ts`. Keep `cursor.ts` as filter + params +
      sort only, and build list options inside `api.ts`.
- [x] ~~Have `applyPage` take `pageSize` explicitly~~: not needed. `PAGE_SIZE` stays in `lib/cursor.ts`, shared by the
      queries and the "page is full" checks, and the tests build full pages from it.

### 11. Small cleanups in `room.ts` / `messages.ts` ✅
- [x] `loadOlder` / `loadNewer` are near-identical. Use one `loadEdge("top" | "bottom")`.
- [x] `applyLoaded` is `async` but never awaits. Make it sync.
- [x] ~~`[...win.items].reverse().find(...)` → `findLast`~~: needs `lib: es2023`. Replaced by `lastSaved(win)` in
      `lib/messages.ts` instead, shared by gap fill and read state.
- [x] Selectors are built with raw ids (`msgSel`, `room.ts:267, 497`) while `scroll.ts` uses `CSS.escape`. Pick
      one helper (`byDataId(id)`).
- [x] `editable()` is computed twice per message per render (signature + actions). Compute it once in
      `messageNode`.
- [x] Module-level `let uid = 0` counters in three views → one `uniqueId(prefix)` in `dom.ts`.

### 12. Typed errors at boundaries ✅
- [x] `app.ts:110` types the refresh error as `{ status?: number }`. `refreshAuth` already throws `ApiError`, so
      use `instanceof ApiError`.
- [x] `e.action as Action` appears three times in `api.ts`. Add one `subscribe<T>(collection, opts, fn)` helper.

---

## P3 — Tooling

### 13. Share the esbuild config between build and dev ✅
- [x] `scripts/build.mjs` and `scripts/dev.mjs` both list the entry points, `format`, `target` and `bundle`.
      Export `baseOptions` from `scripts/lib/build-utils.mjs`. `ENTRIES` is already there in spirit.

### 14. Typecheck the server code ✅
- [x] Done: `scripts/pb-types.sh` runs `pocketbase migrate up` against a throwaway dir, which writes `types.d.ts`, and
      keeps it as `types/pocketbase.d.ts` (git-ignored; regenerated when the binary changes). `npm run typecheck` runs it,
      then checks `tsconfig.server.json` (strict, no DOM). The generated types model Go structs, so the migration casts
      its plain-object `new Collection({...})` input once (`collection()` helper), and hooks guard the optional `e.record`.
- [x] `pb_hooks/` and `pb_migrations/` aren't in `tsconfig.include`, and their `types.d.ts` reference points into
      the git-ignored `pb_data/`. Generate the types into a tracked or cached path (`types/pocketbase.d.ts`) in
      `npm run setup`, and add a second tsconfig project for the JSVM files (`checkJs`, no DOM lib).

### 15. A real linter/formatter ✅
- [x] Done: Biome 2.5.14 (pinned), `biome.json` matches the existing style (2 spaces, double quotes, 140 columns).
      `npm run lint` is part of `check`, and `npm run format` applies fixes. `noNonNullAssertion` is off because
      `noUncheckedIndexedAccess` makes `xs[i]!` the deliberate idiom. The grep-based HTML-sink check stays: Biome has
      no rule for DOM sinks outside React.
- [x] There is no formatter or linter beyond the grep-based sink check. Add Biome (one dev dependency, fast,
      format + lint). Express the HTML-sink ban as a lint rule if practical, otherwise keep the script.

### 16. Test helper duplication ✅
- [x] `uniq()` and the "fresh client with in-memory auth" helper exist in both `tests/support/api.ts` and
      `tests/integration/helpers.ts`. Move them to `tests/support/`.
- [x] CI builds twice: `npm run check` builds, then Playwright's `webServer` runs `npm run build` again. Use
      `E2E_SKIP_BUILD=1` or split the webServer command.

### 17. Docs ↔ code coupling ✅
- [x] Code comments cite `§7.5` and `TODO 3.5`. Done: the `TODO x.y` references are gone and the plan is archived.
      The 89 `§` references stay: DESIGN.md now says sections are never renumbered, only appended, which keeps them
      valid without rewriting every comment. Those section numbers break when the docs are edited, and
      `docs/TODO.md` is a finished build plan (148 items checked). Archive it as `docs/history/BUILD_PLAN.md`,
      keep DESIGN.md as the living spec, and refer to sections by name rather than by number.
- [x] Update DESIGN §7.2 and §7.4 after items 1–3 and 7 (`update(params)`, `sync.ts`, `actions.ts`, scopes).

---

## Not recommended

- **Adding a UI framework.** The `h()` + `reconcile()` approach fits the JS budget (§7.7) and the strict no-HTML-sink
  rule. The friction comes from duplicated lifecycle and menu code (items 5 and 7), not from missing reactivity.
- **Merging the API rules and the hooks.** The overlap, such as the archived checks in both, is deliberate
  defense in depth for superuser writes.

---

## Round 2 (2026-10-11), after unread counts (§18)

### 18. Unread counts in one service ✅
- [x] Unread logic was spread over `sync.ts` (counts, live +1s), `views/room.ts` (batching, retries, whose session a
      read belongs to) and a store-listener trick for logout that depended on listener order.
- [x] Now `web/src/unread.ts`: counts + `open(roomId) → RoomReader { seen, close }` + `flush()`. `sync.ts` is back to
      rooms and hidden rows. The room view only reports what is on screen. `app.ts` `endSession()` flushes pending
      reads explicitly before the session ends. Tests: `tests/component/unread.test.ts` (service and reader, no DOM).

### 19. Deterministic realtime tests ✅
- [x] 36 `sleep()`s in unit and integration tests, many "let the subscriptions settle": a test that acted before its
      subscription was registered lost the event and failed under load. The SDK's `subscribe()` resolves only once
      the server has the subscription, so tests now wait for that instead.
- [x] `tests/support/api.ts`: every test client records its subscriptions; `subscribed(api)` resolves when all are
      registered. The view tests' `mount()` helpers call it, so every live-update test is covered, not only those that
      had a sleep. No app code changed for this: the app never needs to know.
- [x] Waiting *for* an event: `eventually` / `vi.waitFor` on the event, or on what the view received (`deliveries()`).
      Simulated outages (`gateRealtime`) count dropped events and wait for them: before, a late event could arrive
      after the gate reopened and pass the test without exercising gap fill (BUG-01 tests).
- [x] Proving an event did *not* arrive: `barrier()` (integration) causes a later event the same connection must
      receive; events on one connection are ordered, so the earlier one would have arrived first. Kept as sleeps:
      anonymous subscribers (nothing at all can be delivered to them), and negative checks after `stop()`.
- [x] Unread timing is injectable (`createUnread({ timing })`): tests batch reads for 100 ms, not 1 s, and wait
      `READ_WINDOW_MS` (300 ms) to check that nothing was sent.

---

## Round 3 (2026-10-13), after room access (§23), forwarding (§21) and QA passes 3–5

Rounds 1–2 are done. This round is about the code that grew since: the same access rule in four places, a 600-line
hooks module, and tests grouped by when a bug was found rather than what they protect. Same rules as before: each item
keeps `npm run check` and e2e green and lands on its own.

**Progress (2026-10-13):** done: 20–25, 28–31, and 26's measurement and 27's healthcheck and CI. Found on the way and
fixed with tests: three app bugs (QA BUG-68, 69, 70 in QA.md) and a test-harness one (item 30). **Waiting on the
owner:** client error reporting (27), when to optimize unread counts and fan-out (26, measured), and the JS budget (32).

### 20. One definition of "who can see a room" ✅
The rule exists in four forms that must agree: the PocketBase filter `CAN_SEE` (`pb_migrations/1760000014_room_access.js`),
`canSee` / `visibleRoom` (`pb_hooks/lib/access.js`), the raw SQL in `UNREAD_SQL` (`pb_hooks/lib/reads.js`, worded
differently), and what the views assume.
- [x] An integration test that sweeps guest / member / non-member / creator × open / public / private / DM × archived,
      and checks every way in: list/view rules, messages, `GET /api/chat/unread`, `POST /api/chat/reads`, message create,
      file access. A disagreement fails one test instead of becoming a QA bug.
      Done: `tests/integration/access.matrix.test.ts` (7 rooms × 4 viewers × 11 ways in: view, list, messages view/list,
      attachment, unread, post, react, forward into, mark read, hide). It lists every disagreement at once. Checked by
      breaking the member clause in `canSee` and in the SQL: each was caught and named. Not covered here: realtime, which
      `room_access.test.ts` tests on its own.
- [x] Build the unread SQL's room filter from constants in `access.js`, next to `canSee`. Done: `SEES_SQL`. The
      migration keeps its own `CAN_SEE`: a migration must not change when a hook does.

### 21. Split `pb_hooks/lib/chat.js` (595 lines) by concern ✅
- [x] `lib/text.js` (`tidy`, `nameKey`, `clipFileName`, `isBlank`, `fieldError`), `lib/messages.js`, `lib/rooms.js`,
      `lib/users.js` (user hooks next to search), `lib/http.js` (`headers`, `asset`). Mechanical: `main.pb.js` only
      changes its `require` paths.
      Done: cut by script into its 44 top-level declarations, each moved whole with its doc comment, no code retyped.
      `text.js` is pure strings only; the record helpers (`fieldError`, `recordOf`, `cleanName`, `setNameKey`,
      `originalNames`) went to `lib/records.js`, shared by users, rooms and messages. The other modules keep their own
      error helpers: their top-level messages differ on purpose.

### 22. Make the effective schema and API rules reviewable ✅
Rules are built across 16 migrations by string concatenation (e.g. `qa_pass5` appends `&& NO_PASSWORD`), so the live
rule is nowhere to read.
- [x] A snapshot test that dumps every collection's rules, fields and indexes into a checked-in
      `docs/schema.snapshot.json`: rule changes become readable diffs in review.
      Done: `tests/integration/schema.snapshot.test.ts`, refreshed with `npm run schema:snapshot`. Each rule is listed as
      its top-level `&&` conditions, so a diff names the condition that changed. Ids are left out, relations name their
      collection, PocketBase's own collections are skipped, and rate limits are the ones the migrations set (the harness
      turns them off after boot). Checked by dropping one condition from a migration: the test failed with a one-line diff.
      Seen in it: the messages `createRule` checks `@request.auth.id != ""` twice (on its own and inside the access
      condition). Harmless; leave it, since changing a rule means a new migration.
- ~~Squash the migrations into one baseline~~: dropped (owner's decision, 2026-10-13). Migrations stay as they are.

### 23. Finish splitting the room view ✅
- [x] `views/room.ts` (726 lines) still holds selection, the bulk-delete bar, forwarding, replies, the reaction picker,
      flash messages and the not-found/gone screens. Extract `room/selection.ts` and `room/reply.ts`.
      Done (726 → 591 lines): `room/selection.ts` (selected set, bar, delete confirm, Escape), `room/reply.ts`, and two
      more that fell out: `room/notice.ts` (the status line and its timed confirmations; `NOTICE_MS` moved there) and
      `room/names.ts` (batched lookup of who reacted). Forwarding, the reaction picker and the not-found/gone screens
      stay: they are wiring between parts, which is what the view is for.
- [x] `room/messages.ts` (757 lines): move reaction chips and attachment rendering into their own modules.
      Done (757 → 585 lines): `room/reactions.ts` (chips, "Add reaction" buttons, `reactionFocus`) and
      `room/attachments.ts` (thumbnails, file chips, local previews, token retry).
- Code moved by script (cut whole, not retyped). 559 unit tests and all 45 Chromium e2e specs pass. Bundle: +131 bytes
  gzipped (the factories). Note the JS budget is nearly used up: 38.25 of 39 KB. The next feature will need room, so
  either raise the budget on purpose or find savings first.

### 24. Test files by feature ✅
- [x] `tests/unit/views/room.test.ts` (2,255 lines): after item 23, move logic-only tests to DOM-free tests, as was
      done for the controller.
      Done differently: split into `tests/unit/views/room/*.test.ts` (load, compose, header, keyboard, read-state,
      attachments, replies, reactions, selection, people), sharing `room/harness.ts` (setup via `useRoomView()`,
      the helpers, and `setView`/`setLayout` for the tests that mount or unmount themselves). Its "QA fixes" block is
      gone: each BUG test is in its feature's block. Split by script, all 129 tests kept. The full unit run is faster
      (~75 s, was ~110 s). DOM-free tests for the new `room/selection.ts`, `reply.ts` and `names.ts`: not yet.
- [x] `tests/integration/qa_fixes`, `qa_pass3/4/5.test.ts`: move each test into the file of the feature it protects,
      keeping the BUG id in the test name.
      Done: new `names.test.ts` (cleaning and uniqueness of display and room names), and `accounts`, `http` (rate
      limits), `messages.files`, `avatars`, `users`. 28 tests moved, 293 in all, 4 files fewer.

### 25. Split `web/styles/app.css` (2,052 lines) ✅
- [x] One file per existing section (rooms, room, replies, attachments, reactions, emoji, tray, selection, access),
      bundled by esbuild into the same single output, so the size budget and the one request stay.
      Done: `web/styles/app.css` is now only `@import`s, in cascade order, of 20 files in `web/styles/app/` (tokens,
      base, shell, avatars, profile, login, room-list, menus, room, replies, attachments, messages, reactions, composer,
      emoji-picker, tray, selection, access, motion, narrow). Two sections held rules that weren't theirs: message states
      and the Edit/Delete toolbar were under "Attachments" (now `messages.css`), the composer, hints and notices under
      "Reactions" (now `composer.css`); each new file is imported where its rules were, so the order is unchanged.
      Checked: the minified bundle is byte-identical to before (24,653 bytes). Only the asset hash changed: it covers
      the linked source map, whose source list did. `contrast.test.ts` reads `app/tokens.css`.
- ~~Tokens for repeated raw values (spacing, radii, z-index)~~: not done, on purpose. Radii already are tokens
  (`--radius`, `--pill`: 24 of 31 uses); z-index is used twice; spacing isn't a scale (0.4rem and 0.5rem, 0.25rem and
  0.3rem side by side), so tokens would either just rename numbers or change the look, a design decision rather than a
  refactor. And `var()` costs bytes with the CSS at 5.86 of its 6 KB budget.

### 26. Plan for scale ✅ (2026-11-13)
Fine at today's size; the first things to break as usage grows.
- [x] Load-test once with a seeded database (200 rooms, 100k messages); record the numbers in DESIGN.md. Done:
      `tests/perf/scale.ts` (sizes from env vars) and DESIGN §25. 200 rooms / 50 listeners: unread 52 ms, room list
      19 ms, fan-out to every listener 34 ms; 1,000 rooms / 200 listeners: 237, 80 and 82 ms. Pages and sends: 5–10 ms
      at any size. All linear in rooms or listeners.
- [x] `UNREAD_SQL` runs correlated subqueries over every visible room per fetch. Measured: ≈ 0.24 ms per visible room in
      the worst case (every room at the 100 cap), so about a second at ~4,000 rooms. Not needed yet; when it is, count
      only rooms with activity since the caller's oldest read, or keep counts per user. The owner's call when to.
      **Done (2026-11-13):** measured again on the Go server, 280 ms at 1,000 rooms. The plan showed each room's count
      made twice (for `n > 0` and for the value), each reading up to 100 messages. `server/unread.go unreadSQL` now
      materializes the read positions, then the counts, and counts on a new partial covering index
      (`idx_messages_unread`: room, created, author, not deleted; migration 50): 56 ms, ≈ 0.05 ms a room, so ~4,000
      rooms ≈ 0.2 s. Rooms without new messages already cost one index seek, so "only rooms with activity" would have
      saved nothing; per-user counts weren't needed. `reads.test.ts` pins the plan (one covering scan).
      `tests/perf/scale.ts` keeps its database with `DATA_DIR`.
- [x] `subscribeAllMessages` sends every message event in every visible room to every client (N×M fan-out). Measured:
      ≈ 0.4 ms of server time per listener per message. Not needed yet; a thinner event or batching when open tabs
      reach the hundreds.
      **Done:** mostly by PERF.md §7 and item 47 (one topic, the event serialized once per way of seeing it, not per
      listener): 200 listeners get a message in 26 ms end to end, most of it the test's own Node clients. Left was
      live.go's second queue and sender goroutine per client (item 61); removed 2026-11-13, events go straight into
      the connection's buffer (`server/realtime.go`). `/api/chat/metrics` `senders`/`queued` now count every
      connection's waiting events.

### 27. Operations
- [x] `HEALTHCHECK` in the Dockerfile against `/api/health` (busybox `wget`), for plain Docker / Compose; Dokku already
      runs its startup check from `app.json`. Not built here (no Docker in the dev container): check on the next deploy.
- [x] PocketBase's built-in backups (cron + S3) enabled or documented: already documented (README, "Backups").
      Turning them on needs the deployment's S3 bucket and keys: the owner's to do in the admin UI.
- [ ] Client error reporting: a rate-limited `POST /api/chat/log`, so production failures (e.g. reconnect loops in
      `pb.ts`) are visible. **Waiting on the owner:** it adds client code, and the JS budget has 0.66 KB left
      (38.34 of 39 KB); also what may be logged about users is a decision.
- [x] CI: typecheck/lint, unit and integration as parallel jobs; e2e as a per-browser matrix. Done: a `static` job
      (typecheck, lint, sinks, build), then `unit`, `integration` and `e2e` (chromium / firefox / webkit,
      `fail-fast: false`, a report per browser) side by side; shared setup in `.github/actions/setup`. YAML checked with
      a parser; not run on GitHub yet: watch the first run.

### 28. Docs ✅
- [x] DESIGN.md (1,872 lines) describes current behavior only; move "why BUG-xx was fixed" stories to QA.md. Section
      numbers stay (never renumbered).
      Checked, and the premise was overstated: DESIGN.md cites 20 bugs, each a short "why this rule exists" next to the
      rule (design rationale, which belongs there); the stories are already in QA.md. What was missing: this round's
      bugs. QA.md now has "QA pass 7" (BUG-68 resubmit, BUG-69 sync reload, BUG-70 previews, and the test-database
      finding), the code and tests cite them as the earlier ones do, DESIGN §25 has the measured scale, and the file
      tree lists `app/*.css`, the hooks modules and QA.md's scope.

### 29. Realtime errors after a logout under load ✅ (QA BUG-68)
Found while doing items 20–21: unhandled `PbError` rejections from `pb.ts` `resubmit()` → `connectError()` in full unit runs.
- [x] **A real bug, fixed in `pb.ts`:** `resubmit()` (on every token change: session renewal, password change) failing
      after its connection had been replaced (a logout or another user in between) called `connectError` on the new
      connection: that rejected the new connection's subscribes and closed it, with nothing to reconnect it. A guest
      tab could be left without live updates. Now a late failure is ignored when `es` is no longer the connection it
      was sent for, as `initConnect` already did with `current()`. Test: `tests/unit/pb.test.ts` "realtime" (fake
      EventSource and fetch: renew, log out, then the old answer arrives as a 404).
- [x] `scope.sub()` attached its handler only at dispose, so a subscribe that failed before was an unhandled
      rejection. It now catches at once (the realtime client keeps the subscription and sends it on the next
      connection). Test: `tests/unit/scope.test.ts`.
- Noted, not changed: if the very first connection fails (page opened offline), nothing reconnects until something
  subscribes again. That is the SDK's own behavior, kept on purpose when `pb.ts` replaced it.

### 30. Message edits and deletes failed under load in tests ("database is locked (517)") ✅
Found while doing item 24: with the room tests split, 1–4 unit tests failed per run, a different one each time (each
passed alone). A log dump of the test server showed a message `PATCH` answered **400 "Failed to update record."**
with `details: "database is locked (517)"` after 7.4 s. 517 is SQLITE_BUSY_SNAPSHOT: a transaction read, another
connection committed, and the read could not become a write.
- **Not a production bug.** PocketBase sends every write and transaction through one connection (`nonconcurrentDB`),
  so nothing of its own can commit inside the message-update transaction. The second writer was the test harness:
  `releaseName` (on every sign-up of a name already taken: every room test is "Me") and `seedMessages` wrote to
  `data.db` from other processes. Shown by a burst of updates: no errors alone; with a Node process committing small
  writes alongside, the same 400 (and every update stalled while it ran). Production would only see it if something
  else wrote to `data.db` (a sqlite3 shell, some replication tools).
- [x] Fixture writes go through the server: `startPocketBase({ fixtureRoute: true })` serves a copy of `pb_hooks` with a
      test-only, superuser-only `POST /api/test/sql` (never in the repo's hooks, never deployed), and
      `tests/support/sql.ts` `runSql()` calls it (fetch only, so the unit project can use it). `withName` /
      `releaseName` (unit, integration, e2e) and the unit `seedMessages` use it. Still direct: the e2e `seed`
      (reconnect.spec.ts seeds while its server is stopped) and one-off fixture writes inside single integration tests
      (files run one at a time).
- [x] Also fixed, found on the way (QA BUG-70): a sent message's preview URLs were released only after `api.send` answered, and
      not at all if the room was left in between (its realtime echo had already replaced the pending copy).
      `controller.ts` now releases them as soon as the server has the message.
- Result: no lock errors in the server log over several full runs (checked with a temporary log dump); 4 of 6 full unit
  runs clean, against 1 of 5 before. All 293 integration and 45 Chromium e2e tests pass.

### 31. Flakes left in the unit suite ✅
Each looked like timing; the causes were four different things. 12 full runs since: 11 clean, 1 failure (fixed below).
- [x] `unread.test.ts` (one more `unreadCounts` call than expected): not timing. Public rooms are everyone's, so
      other test files' traffic reached the service, and a message deleted there rightly refreshes the counts (traced
      with a stack per request). The two request-counting tests now filter the service's message events to their own
      rooms (`onlyRooms()`).
- [x] `views/access.test.ts` (a lost room "came back"): **a real bug in `sync.ts` (QA BUG-69).** A reload's answer is older than
      the events that arrive while it is in flight, and replaced them: a room you were just taken out of was listed
      again, an archive undone; and an older reload answering after a newer one overwrote it. Now events during a
      reload are applied again on top of its answer, in the same store update (applied one by one, the room vanished
      and came back, which the view took for a room let in again), and older answers are dropped. Tests:
      `tests/component/sync.test.ts` (both orders, and no flicker).
- [x] `room/load.test.ts` "away from the live edge…": a test bug since §22.7: in history the button already shows
      "Jump to latest", so waiting for it to show passed before the new message arrived. It waits for the text now.
- [x] `room/header.test.ts` (Hide/Unhide, Archive) timing out at 5 s: gone with item 30's fix (the 517 retries made the
      server slow for everyone; a full unit run went from ~75 s to ~52 s).
- [x] `room-controller.test.ts` "runs one request per end at a time": a reconnect under load can refetch a page before
      the test's own requests; it counts from just before them now.

### 32. The JS budget is nearly used up
`app.js` is 38.34 of 39 KB gzipped, so the next feature won't fit. Biggest parts of the bundle (minified):
`views/room.ts` 9.2 KB, `room/messages.ts` 8.6, `room/controller.ts` 7.9, `api.ts` 7.1, `lib/emoji.ts` 7.0, `views/rooms.ts`
6.2. The emoji picker and its data (`ui/emoji-picker.ts` + `lib/emoji.ts`, ~4.1 KB gzipped) are only needed once the picker
opens.
- [ ] **Owner's call:** load the picker as a lazy chunk on first open, as the image viewer already is (§17.7): frees
      about a tenth of the budget, but the first open needs the network (offline, the picker wouldn't open; the viewer
      falls back to a new tab, the picker has no such fallback). Or raise the budget on purpose, as §21 and §23 did.

---

## Round 4 (2026-10-28), architecture review

The review's findings and what came of them, in the order they were done. `npm run check` stays green throughout,
and so do the Chromium e2e suite and the app's tests.

### 33. One worker loop and lock (`pb_hooks/lib/worker.js`) ✅
- [x] Five copies of the cron worker's loop and lock (previews, media, push, Telegram, federation) are now `run(app,
      worker)` and `once(app, worker)` for the tick routes. The workers keep their own passes and stale times.
- [x] **A real bug, fixed on the way:** the previews', media and push locks had no owner. A run that took over a
      stale lock was left without one when the old run's `finally` removed it, so a third run could start alongside
      (the Telegram and federation locks already had owners, QA BUG-147). Every worker now stops at its next renew once
      its lock is another run's. Test: `tests/integration/worker.test.ts`, through a test-only route that drives the
      lock step by step.

### 34. The core hooks in one place, in a stated order ✅
- [x] `federation.pb.js` wrapped the core hooks only because PocketBase loads files by name, and "federation" sorts
      before "main". Every hook on `messages`, `rooms` and `users` is now in `main.pb.js`, and it calls the features'
      parts (`lib/features.js`) in the same order as before: federation, core, Telegram; after the save, the reverse.
      The feature files keep their routes, workers and the hooks of their own collections.
- [x] A new message's follow-ups (Telegram queue, previews, media index, federation) are listed in one place.

### 35. A written client contract, shared values and shared test vectors ✅
- [x] `docs/API.md`: what the web and the app rely on (collections, filters, routes, realtime topics), and how to
      change any of it without breaking installed apps.
- [x] `shared/contract.json`: field lists, limits and file types. `tests/unit/contract.test.ts` checks the web's and
      the hooks' copies against it; `ContractTest.kt` checks the app's.
- [x] `shared/vectors/`: text folding, search queries, highlighting, lengths, blank text, Jump to's fold and score.
      They are run by the web (`tests/unit/vectors.test.ts`), the server's `lib/text.js` (same test) and the app
      (`VectorsTest.kt`).
- [x] Moving message pages and the room list behind `/api/chat/*` routes, so that the clients stop writing
      filters: done in item 45 (search and the app's notification check still send filters).

### 36. Push removed ✅ (owner's decision)
- [x] Since ANDROID.md §21 nothing registered push tokens. Removed `lib/push.js`, `lib/google.js`, the push cron and
      tick route, `push_tokens` and `push_queue` (migration `1760000038_drop_push.js`), and the app's
      `registerPush` / `unregisterPush` / `forgetPushToken`. App Links moved to `lib/site.js`; its tests, and the
      minimum version's, are now `tests/integration/android.test.ts`. Link previews lost `post()`, which only push
      used.

### 37. App shell and view contexts ✅
- [x] `app.ts` (458 → ~320 lines): session renewal and checks are `renewal.ts`, the app bar is `header.ts`, the
      Ctrl+K shortcut is `jump.ts`. The module-level `panes` singleton is now per app.
- [x] Views take the part of `Ctx` they use (`RoomCtx`, `RoomsCtx`, `Pick<Ctx, …>`).

### 38. The collections chunk split ✅ (owner's decision: no shared chunk)
- [x] `views/collection/lazy.ts` (1,052 lines) is now the chunk's entry, re-exporting `page.ts`, `save.ts`, `picker.ts`
      and `create.ts`, with `calls.ts` (its typed requests and `ITEM_FIELDS`) and `shared.ts`. The no-shared-chunk
      rule stays. collJs went from 6.66 KB (with the contract's export) to 6.64 KB.

### 39. The notifications e2e waits on a readiness signal ✅
- [x] `notify.ts` sets `<html data-notify="on">` once the server has both subscriptions and the tab leads (Web
      Locks), and removes it when stopped. `notify.spec.ts` waits on that rather than on the realtime POST, which the
      unread counter also sends. Before: about 1 failure in 20–44 runs; after: 50 of 50 (DESIGN.md §34.3).

### 40. Shared vectors for the message window and the room controller ✅
- [x] `shared/vectors/window.json`: merge, trim, the four page kinds, `startsGroup`, `lastSaved`, `lastOwnEditable`,
      `quoteText`, `emptyForward` and the page queries, run by `tests/unit/lib/window-vectors.test.ts` and the app's
      `WindowVectorsTest.kt` (the app had no tests of its `Window.kt` before).
- [x] `shared/vectors/room.json`: 7 scenarios against a real server (paging up and down, Jump to, a link far back,
      live messages and the pill, the unread line, deletes), recorded from the web's controller and replayed by
      `tests/component/views/room/scenarios.test.ts` and `RoomScenariosTest.kt`. The app passed all of them as they were.
- [x] The app's test tasks take `shared/` as an input, so a change to the vectors runs them again.

### 41. The web's unread and collections gaps (QA BUG-162, BUG-170), and the room controllers split ✅
- [x] `unread.ts`: a failed read is sent again after 2 s, doubling up to a minute, until it is in or refused (a 4xx
      other than 429), as the app's `Unread` does. Before, it waited for the next `seen()`, which nothing brought when
      the room on screen didn't change.
- [x] `collections.ts`: once subscribed, the list is read once more (a follow made between the read and the
      subscription was missed until a reconnect); a failed subscription is made again by the next load.
      `tests/component/collections.test.ts` is new.
- [x] The room controllers' writes moved out: `views/room/writes.ts` (836 → 620 + 288 lines) and Android's
      `RoomWrites.kt` (748 → 657 + 195), each behind a narrow host interface. The shared room scenarios (item 40) and
      the controller tests pass unchanged on both.

### 42. The room kept as the page goes (QA BUG-104, again) ✅
- [x] Under load Chromium tore the page down before IndexedDB committed the `pagehide` write (logged: the put made with
      the database open, the transaction never completing), about 1 run in 10 at 4 workers. `cache.ts` now also writes
      what it keeps after `pagehide` to `localStorage`, synchronously; the next page moves it to IndexedDB (taken once,
      dropped on `pageshow` and by `clear()`). 60 of 60. `app.js` budget 47.25 → 47.35 KB (the owner's call).

### 43. Unit tests without a server ✅
- [x] The 29 files of `tests/unit/` that talk to PocketBase (views, the room controller and its harness, the services)
      moved to `tests/component/` (a new Vitest project with the old setup; same depth, so no import changed). What
      is left in `tests/unit/` (39 files, 317 tests: pure logic, DOM helpers, shared vectors, the build) needs no
      server and runs in ~10 s (`npm run test:unit`). `npm test` runs both, as CI does.

### 44. The large server files split ✅ (and two left whole, on purpose)
- [x] `lib/previews.js` (610 → 336 lines): where the server may go is `lib/outbound.js` (which `federation/net.js` now
      requires, rather than the previews module), and reading a page is `lib/pages.js` (pure).
- [x] `federation/rooms.js` (783 → 551): a mirror's side (the share, unshare and room events from the home, and a
      mirror's superusers' edits) is `federation/mirror.js` (263), which requires `rooms.js` (no cycle).
      `features.federation()` gives it as `mirror`.
- Not split: `views/room.ts` (892). Its collections part as a module cost app.js 0.10 KB gzipped (over the budget) for no
  change in behaviour; the rest is wiring the room's parts together. `ChirkleApi.kt` (648): one call per endpoint, in
  sections, like the web's `api.ts`; a split would make its request helpers internal and add imports to every caller.

### 45. Pages and the room list as routes ✅
- [x] `GET /api/chat/rooms` and `GET /api/chat/rooms/{room}/messages` (`pb_hooks/lib/lists.js`): the client names the
      page (`kind`, its cursor, `files`), the server writes the filter. Same records, `expand` and `fields` as the
      records API; the access matrix checks both routes for every room × viewer.
- [x] Web: `lib/cursor.ts` builds `{ room, kind, args, files }`; `api.page`, `api.changes` and `api.listRooms` use
      the routes. Search keeps its filter (`api.search`, `SearchQuery`).
- [x] App: `Cursors.kt` the same, plus `PageQuery.legacy()`, the old filter, for servers without the routes (any route's
      404 says so). `api.search` for search.
- [x] `shared/vectors/window.json`'s page queries are now the routes' form.
- The old record-API filters keep working, for installed apps (docs/API.md).

### 46. Search and the notification check as routes; the app tested against an old server ✅
- [x] Search is a page with `q` (the words): `lib/lists.js` folds, splits and escapes them as the clients did (QA
      BUG-34, BUG-112). The web's `searchQuery` builds a `PageQuery`; `api.search` and `listOptions` are gone (`app.js`
      47.31 → 47.27 KB). `shared/vectors/text.json`'s `searchQuery` cases have the route's form and the old filter.
      `search.test.ts` runs each search through both and expects the same messages.
- [x] `GET /api/chat/notifiable`: the app's notification check (ANDROID.md §21, §24), the rooms it can't see left out.
      `lists.test.ts` compares it with the old filter; the access matrix checks it for every room × viewer.
- [x] App: `searchQuery` is a `PageQuery` (its `legacy()` is the old filter); `notifiable` asks the route. Both fall back
      on a 404 as the pages do.
- [x] `LegacyServerTest` (item 45 left this open): one session through `ChirkleApi` against the test server and
      `TestServer.legacyUrl`, a second PocketBase with these hooks minus `lib/lists.js`'s routes, or an old release's
      (`-Pchirkle.legacyHooks=…`). Both give the same; the old one answers a single 404. Passed with the hooks of the
      commit before the routes, read out of `.git` (no git binary here).
- Filters the clients still write: `id` (users), `room` (read positions, the live room), `collection`/`owner`
  (collections). Fields that won't move; not worth routes.

### Left open from the review
- Scale (§26 above): `UNREAD_SQL` and realtime fan-out done 2026-11-13; queue polling not needed at the measured sizes.
- ~~`cache.spec.ts` QA BUG-104 flake~~: a real loss of the write made as the page goes; fixed (item 42).
- `keepToRoom` (enrich hook) looks up the room per message with reactions or a reply. Measured 2026-10-28: a page of 50
  messages with reactions takes ~15 ms against ~7.5 ms without (the lookup is all of the difference, ~0.15 ms a message).
  The same check as one SQL query only got it to ~13 ms: the cost is the hook's call into Go, not the record. Checking
  each room once per request needs request-scoped state the JSVM hooks don't have; a cross-request cache would have to
  be invalidated on every membership change of a privacy check. Left as it is.

## Round 5 (2026-11-11), architecture and product audit

A review of the whole codebase (server hooks, web, Android, tests, tooling, docs) and of the product, after §35–§41. The
foundations hold: one contract (`docs/API.md`, `shared/`), shared vectors run by all three implementations, a real-server
test harness on every layer, the access matrix, size and speed checks in CI. What follows is where the next costs and
risks are, ordered by value ÷ effort within each part. None of it is started; each item should land on its own with
`npm run check`, the Chromium e2e suite and the app's tests green.

### Codebase

#### 47. Move the hot paths out of the JSVM (server) — high value, large ✅ (2026-11-11)
- Most production incidents and perf work since 2026-10-14 trace back to the JS hook runtime, not to SQLite or to
  PocketBase: the hooks pool overflowing on message pages (`--hooksPool=100`, PERF.md §6), `routerUse` holding runtimes
  across `e.next()` (BUG-250), ~0.15 ms of Go↔JS calls per enriched message (item 46's `keepToRoom` note), the 1 vCPU
  collapse at ~1000 live listeners (PERF.md §8: `live.js` sends inline), goja regexes taking minutes on bad input
  (link previews), no request-scoped state.
- Suggestion: build PocketBase as a Go framework (a `server/` Go module embedding `pocketbase.New()`, cross-built in
  the release like the old bridge binaries were) and move only the hot, stable paths to Go: `lib/enrich.js`,
  `lib/live.js` fan-out, `lib/lists.js` pages, the unread counts. The feature hooks (Telegram, federation, collections)
  stay in JS. Same routes, same contract: the integration suite and `scripts/stress.ts` are the acceptance test (target:
  PERF §8's storm and fan-out cases no longer collapse).
- Cost: a Go build in CI and the npm tarball (one binary per platform instead of a fetched PocketBase); hooks and Go
  code must agree on hook order (`lib/features.js`).
- Done as suggested. `server/` (Go 1.27, PocketBase 0.40.4 from `go.sum`) is PocketBase's own `main` with its JS
  plugin, so `pb_hooks/` and `pb_migrations/` load as before, plus, in Go: the messages enrich hook (`enrich.go`:
  showOriginal, keepToRoom, hide), live messages (`live.go`), `GET /api/chat/rooms`, `rooms/{room}/messages` and
  `notifiable` (`lists.go`), and `GET /api/chat/unread` and `unread/{room}` (`unread.go`, with the inbox counts).
  `lib/enrich.js`, `lib/live.js` and `lib/lists.js` are gone, and so are the moved parts of `messages.js`,
  `anonymous.js`, `reads.js` and `inbox.js`. POST /api/chat/reads and every feature hook stay JS.
  - 2026-11-12: POST /api/chat/reads moved to Go too (`reads.go`, group-committed, PERF.md §12); `lib/reads.js` is
    gone.
  - Same routes and answers: the integration suite (533 tests), Chromium e2e and the app's tests pass unchanged. The
    unread-plan tests and the contract test read the Go source (`tests/support/go-source.ts`); `seesSQL` and the
    inbox SQL are checked equal to `lib/access.js` and `lib/inbox.js` (both still use them), `liveFields` to the
    contract. `go test` runs the shared text vectors (`searchKey`, a port of `lib/text.js`: x/text NFKC and full case
    mapping) and the author-probe cases.
  - A request's "checked rooms" mark (list routes leave their rooms' messages to one query) is a Go map keyed by
    the request's info, which PocketBase keeps once per request: no secret query parameter any more.
  - Live messages no longer wait on clients: each client has a queue of its own (512 events) sent in order by a
    goroutine; one that falls that far behind is disconnected and loads what it missed on reconnecting, as after any
    drop. PocketBase's channel is unbuffered, so the JS version waited for every listener's SSE writer in the save.
  - Hook order: Go binds before the JS plugin loads, so on the same event Go runs first and its `e.Next()` runs the JS
    hooks (live messages send after them all, as before). Routes: Go adds its own after the JS hooks' (priority
    900), and skips a path they define, so an old release's hooks keep theirs; `CHIRKLE_LEGACY=1` leaves out the list
    routes and `/api/chat/live` (Android `TestServer.legacyUrl`).
  - Build: `npm run setup` (`scripts/build-server.mjs`) builds `bin/chirkle-server` (needs Go; no-op while newer
    than `server/`), `typecheck` runs it first. `prepack` builds linux/darwin × amd64/arm64 into `bin/release/`
    for the npm tarball (CGO off). Docker builds it in a `golang:1.27-alpine` stage; `/app/pocketbase` is a symlink
    to it for old commands. CI sets up Go and runs `go vet`, `gofmt` and `go test` in the static job.
    `scripts/fetch-pocketbase.sh` is gone.
  - The cost, as expected: the npm tarball is 50 MB (131 MB unpacked: four ~32 MB binaries) where PocketBase used to be
    fetched on the first run, and building from a checkout needs Go. If the size matters, the usual way out is one
    optional npm package per platform (as esbuild does); not done. `chirkle-server --version` says both versions
    ("0.40.4 (Chirkle 0.3.0)").
  - Measured: PERF.md §9.

#### 48. Migrations: unique names, and a baseline for new installs
- Two migrations share a timestamp (`1760000045_mentions.js`, `1760000045_password_reset.js`); PocketBase orders them by
  file name, which works only because they don't touch the same collection. Add a unit test that every
  `pb_migrations/*.js` has a distinct numeric prefix (cheap, catches merges of two branches).
- 48 migrations run on every fresh install and every test server start. Once 1.0 is cut, add a squashed baseline for
  new databases (PocketBase's collections snapshot), keeping the chain for upgrades; `schema.snapshot.json` already pins
  the result.

#### 49. Retention for tables that only grow ✅ (2026-11-12)
- `inbox` rows (one per mention, reply and reaction) are never pruned, nor `room_reads` of deleted rooms' users, nor the
  soft-deleted messages' rows. Stats and federation queues already prune (`stats-prune`, `federation/worker.js`).
- Measured in QA pass 35 (local, one person, 5 rooms): `GET /api/chat/unread` takes ~7 ms with no inbox rows,
  ~40 ms with 5,000 rows all read, and ~100 ms with 5,000 unread. `counts()` (`lib/inbox.js`) scans every row of the
  person's for the per-room mentions, read or not (index `(user, created)`, the bound is per room); the apps call it
  after every read and inbox event.
- Suggestion: a daily prune (the `lib/worker.js` loop): inbox rows past the newest 500 per person or older than 180
  days; and an index `(user, room, created)` with `counts()` driven per room from `room_reads`, so read rows are skipped; an optional `site.retention_days` for messages (a product decision, DESIGN.md §2 says history is never pruned
  today).
- Done (DESIGN.md §42.1), except messages' retention (the owner's call; not built):
  - `pb_hooks/lib/retention.js`, cron `retention` daily at 03:41 (a cron job, not the worker loop: one statement per
    step, once a day). The inbox keeps a person's newest 500 rows, none older than 180 days. Orphans that skipped the
    hooks go too: inbox rows of a deleted (or soft-deleted) message, or of a gone room, person or actor; `room_reads`,
    `inbox_reads`, `hidden_rooms` of a gone person or room; `media` rows and `link_queue` jobs of a soft-deleted or gone
    message. `POST /api/retention/tick` (superusers) runs it and answers each step's count.
  - The counts are Go now (item 47): `server/unread.go inboxMentionsSQL` is driven by the rooms the caller has inbox
    rows in (a materialized CTE with each one's read position), each a range scan of the new index
    `idx_inbox_user_room_created` (migration `1760000049`) from that position on. `SELECT DISTINCT` made SQLite walk
    `idx_inbox_one` in message order, so it counts `COUNT(DISTINCT)` over the capped rows; capped at 100 a room (the
    apps only test > 0). A plan test pins the index (`reads.test.ts`).
  - Measured (5,000 inbox rows, 5 rooms): the per-room count 13 ms → 1.5 ms; `GET /api/chat/unread` ~16–22 ms →
    ~8–11 ms (~3 ms with none). The Go move had already taken QA pass 35's 40–100 ms down to the former.
  - `tests/integration/retention.test.ts` runs a server of its own (the prune goes through every table). Two migration
    tests reverted "the last N" migrations; they name theirs now (`migrateDownPast`), so a new one can't shift them.

#### 50. Say what kind of account a user is ✅ (2026-11-13)
- Telegram senders and linked instances' people are told apart by their e-mail domain (`@telegram.invalid`,
  `@federation.invalid`) in `lib/inbox.js`, `lib/users.js`, `telegram/people.js` and `federation/people.js`.
- Suggestion: a `users.kind` select (`person`, `telegram`, `peer`), set by the bridges, backfilled by a migration from
  the same patterns; hooks and rules test the field. The e-mails stay as they are (PocketBase needs one).
- **Done (2026-11-13):** `users.kind` (hidden select, migration 51, backfilled from the e-mail domains, `tg_people` and
  `peer`). `lib/users.js beforeUserSave` makes every other new account a `person`; `telegram/people.js` and
  `federation/people.js` set theirs. `kindOf`/`isStandIn` (`lib/users.js`) replaced four different tests: the
  inbox's e-mail regex, the reset's `.invalid`, the ban check (`instance` or a `tg_people` row), the Telegram
  bridge's own `tg_people` lookup, and `/stats`' `peer = '' AND NOT IN tg_people`. Rules refuse `kind` in a client's
  body (PocketBase also ignores a hidden field there). The federation's `standInRow` stays where the `fed_people` row
  itself is needed. Tests: `users.test.ts` (signup is a person, can't change it), the bridges' stand-ins,
  `users_kind.migration.test.ts`.

#### 51. Operational visibility ✅ (2026-11-12)
- Today there is `/api/health` and the moderators' `/stats` page. Workers stalling (the fed_queue rows left by a raw
  SQL delete, security audit 2026-10-29), the hooks pool filling and queues backing up are found by users.
- Suggestion: a superuser-only `GET /api/chat/metrics` (queue depths of `tg_queue`, `fed_queue`, `link_queue`, media
  backlog, `storage_cleanup`; each worker's last run and lock; realtime clients; DB size), shown on `/stats` for
  superusers, and in Prometheus text form for those who scrape it.
- Done as suggested (DESIGN.md §42.2), in Go (`server/metrics.go`): it reads live messages' own counters (senders,
  events queued, clients dropped for falling behind, new in `live.go`) and the process's memory, which the JS hooks
  can't. Queues: rows, failing and the oldest's age. Workers: `lib/worker.js` notes each pass's time and a failed one's
  error in the app store (`<lock>.last`, `<lock>.error`); the metrics read those and the lock's last renew; the
  daily prune is noted the same way. JSON, or Prometheus text with `?format=prometheus` / a text `Accept`. The
  `/stats` page has a "Server" card for superusers (tiles, a queues table, a workers table).
  - Not covered: the JS hooks pool's use (the jsvm plugin has no counter for it). Alerting is left to whoever scrapes.

#### 52. A size budget for what a visit loads, not for each file (web) ✅ (2026-11-12)
- `app.js`'s budget has been raised about 40 times (DESIGN.md §7.7 lists them). Its consequences shape the code more
  than any other rule: lazy chunks may not share modules, so they get "kits" through `web/src/lazy.ts`; `room.ts` could
  not be split (item 44) because a module boundary cost 0.10 KB; fixes are weighed in tenths of a kilobyte.
- Suggestion: keep `profile-web` (time to load, switch, scroll: what people feel) as the hard check, and replace the
  per-file caps by one budget for the critical path (html + app.js + app.css + what the first room needs), allowing
  shared chunks loaded with `<link rel="modulepreload">` (HTTP/2 makes a fourth request nearly free, and they are
  immutable-cached). Then drop the kit indirection where it only served the rule.
- Done (DESIGN.md §7.7). `scripts/lib/build-utils.mjs` has three budgets instead of 24: the critical path (index.html,
  app.js, the chunks app.js imports, app.css) ≤ 62.5 KB, the sum of the per-file budgets it replaced; any lazy feature's
  first use (its chunk, the chunks it imports beyond the critical path, its stylesheet; `FEATURES`) ≤ 16 KB; the stats
  page ≤ 10 KB. The build lists every file and feature. `app.js`'s shared chunks are `<link rel="modulepreload">` in
  index.html (`eagerChunks`, `injectAssets`), which the server's Link header and the service worker already read.
  - The kits are gone: `web/src/lazy.ts` keeps only `lazyView`; login, settings, forward, the people search and the
    access dialog import what they use, and so do the viewer, search, media grid, Jump to, inbox, "@" and emoji
    suggestions, the emoji picker, notifications and collections, which took `h` in their options. The access dialog
    imports the people search instead of the room view loading both and handing one to the other.
  - Cost: 58.78 KB → 61.44 KB on the critical path (app.js 46.95 KB became 37.3 KB plus six chunks, 12.4 KB; the
    split's gzip and export overhead), and the access and forward dialogs ~1 KB more each (the people search comes
    with them). `profile-web` (`--cpu=4`, 3 runs each): cold load to messages 1398 → 1361 ms (medians), warm loads,
    switches and scrolling within noise: no measurable change.
  - Done on the way: the stats page's "Server" card (item 51) took `statsJs` over its old 5.5 KB; the page is 9.31 of
    10 KB now.

#### 53. Split `views/room.ts` again (web), after 52 (unblocked: modules may share code now) ✅ (2026-11-13)
- 1,155 lines (892 at round 4): the collections' badges, parking/resuming, the viewer and grid wiring and the composer
  wiring all live in one closure. Each is a module with a narrow host, as `writes.ts` was (item 41).
- **Done (2026-11-13):** 1,133 → 763 lines. Out of the closure, each with its host as an interface: `room/badges.ts`
  (badges, save menu, picker of items), `room/gallery.ts` (viewer and media grid, and telling them of live changes),
  `room/parking.ts` (park/resume, the "pinned" bottom, the signal that ends when the room is left),
  `room/reading.ts` (read state: the rows observer, markRead, the reader), `room/pickers.ts` (the emoji picker,
  emoji and people suggestions) and `room/footer.ts` (composer or banner, the ways to the composer: focus on entering
  and on window focus, Ctrl+/, dropped files). `room.ts` keeps the controller wiring, drawing (apply/flush/draw, the
  pill), the header, list, composer and selection set-up, the dialogs, search, not-found/gone and the lifecycle.
  No behaviour change (unit, component and Chromium e2e suites). Cost: the critical path 61.53 → 62.08 KB of 62.50
  (property names across module boundaries aren't minified).

#### 54. One schema for the `/api/chat/*` answers
- `shared/contract.json` covers fields and limits, `docs/API.md` describes routes in prose. The routes' JSON shapes are
  written three times (hooks, `web/src/lib/types.ts`, Android's `Models.kt`) and checked only by the tests each side
  happens to have.
- Suggestion: JSON Schemas in `shared/schema/` for each route's answer; the integration tests validate every answer
  they get against them (one helper in `tests/integration/helpers.ts`), and `ContractTest.kt` decodes the schemas'
  examples with the app's models. Generated types are optional; validation alone catches the drift.

#### 55. Parity by construction (Android)
- QA pass 20 found six app bugs that were unported web fixes; PARITY.md tracks specs, not fixes.
- Suggestion: every row of a QA table states where the fix went (`web`, `app`, `server`, or `n/a` with a reason), and a
  unit test fails on a row without it. Extend `shared/vectors/` to the unread counts and the inbox, as `room.json` did
  for the room controller.

#### 56. Strings in one place (web and Android)
- Every user-facing string is inline (web views; Android composables: `strings.xml` has 3 lines). That blocks
  translations (see P8) and makes copy changes a code search.
- Suggestion: a `strings.ts` for the web (lazy chunks get theirs through their kit) and `strings.xml` resources for the
  app, moved screen by screen; no i18n framework until a second language exists.

#### 57. A doctor for the dev environment
- Many "flakes" in the QA notes were the environment: no fonts (FONTCONFIG_FILE), a full `/tmp`, stale PocketBase
  children holding a port, missing ffmpeg/versitygw silently skipping tests.
- Suggestion: `npm run doctor` (`scripts/doctor.mjs`): checks `bin/pocketbase`'s version, ffmpeg, versitygw, the
  Playwright browsers and their libraries (launch one page with an `<input>`), free space in `TMPDIR`, ports in use by
  stray `pocketbase serve`; prints what is missing and how to fix it. `playwright.config.ts`'s global setup runs it.

#### 58. Quarantine known flakes and measure them
- Known flakes (`attachments.spec.ts:184` Ctrl-click tab, `cache.spec.ts:135` at 4 workers) are remembered, not
  recorded. Tag them `@flaky`, run them in a nightly job with `--repeat-each=20`, and record the failure rate; a fix
  removes the tag.

#### 59. Docs that can be read
- `DESIGN.md` is 3,839 lines, `QA.md` 2,801, `ANDROID.md` 1,670. Suggestion: `docs/design/NN-topic.md` per section
  with `DESIGN.md` as the index; QA passes older than a month move to `docs/history/QA-<month>.md` (bug numbers stay
  greppable). Long "raised for …" lists (§7.7) become one line plus the history file.

### Product

- **P1. Delete my account, export my data.** Users can't delete themselves (`users.deleteRule` is null), and
  `beforeUserDelete` refuses even a superuser once the account wrote a message. Nobody can download what they wrote.
  A profile action that exports (messages, files list, collections as JSON) and deletes: the account's personal data
  goes (name → "Deleted account", avatar, e-mail, sessions, collections), its messages stay under that name, or are
  deleted too (the person's choice). Expected by users and by GDPR.
- **P2. Notifications that reach a closed app.** The web notifies only while a tab is open (§34); Android polls every
  15 minutes or more (WorkManager). For a chat this is the largest gap. Without Google: UnifiedPush on Android (ntfy or
  any distributor, F-Droid-friendly) and standard Web Push (VAPID) on the web, both opt-in, the server sending only
  "something new in room X" (no message text through third parties).
- **P3. Report a message.** Moderators exist (§36) but nobody can flag anything to them. A "Report" action, a queue on
  the moderators' side (in Mentions & replies or `/stats`), resolved by delete or ban.
- **P4. Mute and notification levels per room.** Today: notify for DMs, replies and mentions, or "every message" per
  room (§34.5). Add "nothing" (mute, also hides the unread badge's prominence) and a mute-until time.
- **P5. Typing indicator and presence in DMs.** A non-goal at the MVP (§2) and listed in §14. Cheap now: a custom
  realtime topic (as `chat/messages`, PERF §7), DMs and small rooms only, no stored state.
- **P6. Pinned messages.** One or a few per room, shown under the header; room owners and moderators pin.
- **P7. Two-factor sign-in.** PocketBase has OTP and MFA built in; turn it on per account from the profile, with
  recovery codes. Moderators and superusers first.
- **P8. Translations.** After item 56: Russian first (the Telegram and cyrillic users), via Weblate for the app's
  F-Droid listing.
- **P9. Room invite links.** A private room's owner shares a link that adds whoever opens it (expiring, revocable),
  instead of adding each member by name.
- **P10. Storage quotas.** DESIGN.md §13 "Still open" #2: per-user stored bytes, now easy with the refcounted `files`
  table (§37): a sum per owner, checked on upload, shown on the profile.
- **P11. First-run setup.** A fresh server asks its first visitor (with a one-time code printed in the log) for the
  site name, signups mode and SMTP, instead of sending them to PocketBase's admin UI.

## Round 6 (2026-11-12), after the flaky-test hunt

A review made while tracing this round's flaky tests (unit, component and Chromium e2e suites run 5–11 times each,
docs/QA.md "QA pass 36"). Three of the five flakes were real races, one a real app bug (BUG-268), one a real client
bug that loses live events (BUG-269). The items below are where the same kind of trouble is likely next. Ordered by
value ÷ effort; items 48, 50 and 53–59 from round 5 stay open as written (50 and 53 done 2026-11-13).

#### 60. Realtime listeners: dispatch from the map, don't bind them (web) — high value, small ✅ (2026-11-12)
- `web/src/pb.ts createRealtime` keeps listeners per subscription key in `subs` *and* binds each one to the
  `EventSource` with `addEventListener`, at three moments (`subscribe` when connected, `sendSubs`, and now the end of
  the connect, BUG-269). A listener added at any other moment is in `subs` but hears nothing; BUG-269 was exactly that
  (a second listener on `chat/messages` added while the connection's POST was in flight, so the notifications chunk
  stayed silent until the next reconnect).
- Suggestion: as Android's `Realtime.kt` does, bind one dispatcher per key when the key is first sent (or a single
  `onmessage`-style handler per event name), and have it call `subs.get(key)` at event time. `bindAll` and the
  binding rules go; a listener exists exactly while it is in `subs`. The unit tests in `tests/unit/pb.test.ts` (fake
  `EventSource`) cover the cases.
- **Done (2026-11-12):** `bind(key)` adds one dispatcher per key to the current `EventSource` (when it opens, for
  every key; on `subscribe`, for a new one), which calls `subs.get(key)` when the event comes and drops a replaced
  connection's late events. `bindAll`, `removeEventListener` and the BUG-269 rebind are gone. PB_CONNECT keeps being
  called by the connect itself, once subscribed. New unit test: listeners added while connected, removed, the last one
  replaced before the unsubscribe was sent, and one added while reconnecting.

#### 61. The JS runtime pool still sits in front of every records request and every file (server) — high value, medium ✅ (2026-11-12)
- Item 47 moved the message pages, enrich, live fan-out and unread counts to Go, but each of these still takes a JS
  runtime from `--hooksPool` (PERF.md §6, §8):
  - `refuseProbes` on every records list, view, create, update and auth request (`main.pb.js`, five identical
    bindings), and `refuseSubscriptionProbes` + `stats.subscribed` on every realtime subscribe. The probe test is
    already in Go too (`server/anonymous.go probes`), a second copy of `lib/anonymous.js`'s regexes that the two
    must keep in step by hand.
  - Every attachment, collection file and video poster download (`lib/files.js serve`, `lib/media.js servePoster`):
    `fs.serve` streams the whole file inside the JS handler, so a 20 MB file to a slow phone holds a runtime for
    minutes. That is BUG-250's mechanism (a runtime held across a long response) on a route instead of a middleware;
    many concurrent downloads (a room of videos on a slow network) overflow the pool, and each call beyond it builds a
    fresh runtime.
- Suggestion: move `refuseProbes`/`refuseSubscriptionProbes` (drop the JS copy; the Go one is tested against the same
  cases), `stats.subscribed` (a Go counter; it only notes an hour per user) and file serving (`shownBy` is two finds;
  `fs.Serve` is the same call in Go) to `server/`. The JS hooks then run only for writes and feature routes.
  `scripts/stress.ts` with many concurrent slow downloads is the before/after check.
- Related, fixed in this round: the JS hooks' inline realtime sends (inbox, badges, lost access, keepalive) could block
  for ever on a client that stopped reading (QA BUG-270); every client now has a buffered, never-blocking `Send`
  (`server/realtime.go`). `live.go`'s own per-client queues are now a second buffer and could go.
- **Done (2026-11-12):**
  - Probes: `server/anonymous.go bindProbes`: the records API's list, view, create, update and auth request hooks, the
    realtime subscribe hook, and a middleware on every `/api/chat/*` route (so the JS routes `/api/chat/reactions` and
    `/forward` and the Go lists, which each called it themselves, are covered by one check). The JS copy
    (`lib/anonymous.js` probes, refuseProbes, refuseSubscriptionProbes) is gone; `anonymous.test.ts` gained the two
    JS routes. A batch request's own requests go through the record hooks (each has its own URL); not tested, as the
    batch API is off on the test server.
  - Stats: `server/stats.go` notes the connection's app (the same client key lib/stats.js reads) and marks the
    account active once an hour.
  - Files: `server/files.go` serves `/api/files/messages/…`, `/api/files/collection_items/…` and both poster routes
    (`shownBy`, thumbnails, `download`, the poster's Cache-Control as before), and refuses PocketBase's own route for
    `files`; the JS routes, `files.serve`, `shownBy` and `media.poster`/`itemPoster` are gone. The federation's
    file routes (`federation/inbox.js`, peers only) still serve in JS.
  - No JS hook runs for a records read, a subscription or a download any more. `main.pb.js` has no `onRealtimeSubscribeRequest`.
  - Left: the stress run with many slow downloads (before/after) wasn't made. (`live.go`'s second queue: gone with
    item 26, 2026-11-13.)

#### 62. e2e tests share one server and see each other's public rooms (tests) — high value, medium ✅ (2026-11-13)
- Every e2e user can see every public room that any parallel test made, and gets each one's live events: one notify
  trace had 50 `GET /api/chat/unread` and a prefetch of a dozen strangers' rooms in five seconds (a new room in the
  list refreshes the counts, `unread.ts`; new rooms are prefetched, `prefetch.ts`). That load and coupling is behind
  this round's switcher flake (another test's new room outranked the room "you came from", which also exposed
  BUG-268) and much of the "load flake" history in the QA notes.
- Suggestion: one server per Playwright worker (`tests/e2e/server.ts` already starts one; key it by
  `workerIndex` in a worker-scoped fixture and `E2E_PORT + workerIndex`), or a test-only site switch that lists
  public rooms only to their creators and members. Specs that need two users share a worker anyway.
- Done, one server per worker, started up front: `tests/e2e/global-setup.ts` (replaces `server.ts` and the
  `webServer`) builds unless `E2E_SKIP_BUILD`, then starts `config.workers` servers on `E2E_PORT` + slot.
  `paths.ts` picks the worker's from `TEST_PARALLEL_INDEX` (stable 0 … workers − 1, also for a worker that replaces
  a failed one, which keeps that server's data); `fixtures.ts` overrides `baseURL`, which every context gets,
  `browser.newContext()`'s too. A worker-scoped fixture starting its server lazily was the other way; the global
  setup keeps server start-up out of the tests' timeouts. Two full Chromium runs after it (4 workers): 89 + 2 failed,
  90 + 1 failed; the failures (collections focus at :185, history.spec.ts twice, once at its 2-minute timeout)
  pass alone (3/3 each). history.spec.ts takes ~1.3 min alone, so CPU load on this 8-core box still reaches it; that
  is item 58's to measure. The a11y contrast flake of the run before did not come back.

#### 63. "Called" isn't "answered" in the component tests (tests) — medium value, small ✅ (2026-11-13)
- `instrument().calls(op)` counts calls; 37 waits in the component tests are on a count, and then assert state the answer sets
  (`vi.waitFor(() => expect(ctl.calls("x")).toBe(n))`). Two of this round's flakes were that: a session refresh
  counted but still in flight overwrote what the test changed next (BUG-33's test) or swapped the token under a
  refused request (BUG-51's).
- Done for those: `instrument()` has `settled(op)` (every call so far answered, and its handlers run). Suggestion:
  sweep the other waits; where the next assertion depends on the answer, wait on `settled`.
- **Done (2026-11-13):** every `calls()` in `tests/component` read. Eleven now wait on `settled` too: counts or
  state read after an answer (`unread.test.ts` ×3, one of them a `sleep(50)`; `prefetch.test.ts` the cached count
  after a refetch, and the live subscription, a `sleep(200)`), checks that nothing more happens which passed
  vacuously before the answer (`room-controller.test.ts` no page after `changes`, `sync.test.ts` no "loading"
  after a reconnect's reload), the placeholder after a delete (`compose.test.ts`), and the session refreshes still
  in flight in `app.test.ts` (×3). Left on counts, on purpose: waits followed only by other counts, waits on a
  `hold()`-ed call (it can't settle before `release()`: `sync.test.ts` ×2, `unread.test.ts` ×1 keep their
  "answered by the server, held here" sleeps), and `toBe(0)` checks.

#### 64. Jump to's ordering in shared vectors (web, Android) — medium value, small
- `web/src/views/switcher.ts` and Android's `Jump.kt` are ports of each other, with hand-copied cases
  (`switcher.test.ts`, `JumpTest.kt`). BUG-268 had to be fixed and tested twice.
- Suggestion: `shared/vectors/jump.json` (targets with `at`/`made`/`current`/`away`, queries, expected order), run by
  both, as `room.json` is for the room controller (item 40).

#### 65. One meaning of "superuser" for room access (server) — low value, small
- `server/access.go callerID` returns "" for superusers ("whom no room is hidden from"), but `canSee(a, "")` treats ""
  as a guest; every Go route then special-cases `e.HasSuperuserAuth()` itself (rooms, messages), and `lib/media.js list` passes `e.auth?.id` (a superuser sees no private room's
  media grid while seeing its messages). Suggestion: `access.canSee(viewer)` with a viewer type (`guest`, `user id`,
  `superuser`), used the same way by every route; the access matrix test gains a superuser column.

#### 66. Small ones ✅ (2026-11-12)
- `server/enrich.go enrichInRooms`: the `checked` mark is deleted after `EnrichRecords` returns, not deferred; a panic
  in an enrich hook leaves the entry (keyed by a request's info, so only a leak). `defer checked.Delete(info)`. Done.
- `lib/stats.js subscribed` keeps `stats.touched.<user>` in the app store forever (one per account ever seen since
  the start); the key could be the hour's set, replaced when the hour changes. Done with item 61 (`server/stats.go`
  `touchedThisHour`).
- `pb_hooks/main.pb.js`: the five `refuseProbes` bindings are one loop (or item 61). Gone with item 61.
