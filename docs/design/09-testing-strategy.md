# §9. Testing strategy

Part of the design document: [index](../DESIGN.md).

| Layer | Tool | What it covers | Speed |
|---|---|---|---|
| Unit | Vitest + happy-dom, no server | pure logic, DOM helpers, shared vectors, the build | ~10 s |
| Component | Vitest + happy-dom + real PocketBase (temp dir) | views, the room controller and the services against the real API | ~80 s |
| Integration | Vitest + real PocketBase (temp dir) | migrations, API rules, hooks, realtime, `createApi` | ~40 s (serial) |
| E2E | Playwright (Chromium; Firefox and WebKit in CI) | golden user flows through the real built app | ~30 s |
| Budget | build script | bundle size limits | in `build` |

## 9.1 Unit and component tests (`tests/unit/`, `tests/component/`)

Unit tests need no server (`npm run test:unit`). Component tests, which do, run against a real, throwaway PocketBase (temp data dir) using the real `createApi`. There is no fake backend to drift from the server. Failures, latency and reconnects are injected with `vi.spyOn` wrappers over the real client (`tests/support/api.ts`). Large histories are seeded straight into the test DB.

**`lib/messages.test.ts`**
- `merge` keeps the list sorted by `(created, id)`, including for out-of-order input and for messages with the same `created` value.
- `merge` dedupes by id, and the incoming (server) version replaces the `pending` one.
- `merge` keeps the newer `updated` version, so an edit wins over a stale copy.
- `merge` of an older page prepends correctly. Merging an empty page is a no-op.
- `trim("bottom", 300)` on 350 items drops the newest 50 and sets `hasNewer`. `trim("top")` mirrors this and sets `hasOlder`.
- `remove` of an unknown id is a no-op.
- `group` splits on author change and on a gap of more than 5 minutes, and does not split at exactly 5:00.
- Cursor builder: produces the correct `(created, id)` filter strings for older and newer pages, built with `pb.filter` parameters.

**`store.test.ts`**
- `roomSections`: hidden rooms go to Hidden, archived rooms go to Archived (even when also hidden), and the rest go to Rooms, sorted by name; rooms and DMs with unread messages come first.

**`lib/id.test.ts`**
- Ids are 15 chars and match `/^[a-z0-9]{15}$/`.
- 10,000 generated ids contain no collisions.

**`lib/time.test.ts`**
- Shows "today" vs. a date label.
- Uses a fixed timezone through `TZ`.

**`dom.test.ts`**
- `h()` sets attributes, dataset and children.
- **A string child containing `<img src=x onerror=…>` becomes a text node and creates no element.**

**`router.test.ts`**
- Matches routes and extracts params.
- Unknown paths redirect to `/`.
- Unauthenticated access redirects to `/login`.
- `unmount` of the previous view is called before the next view's `mount`.
- A trailing slash is the same page.
- An image viewer history entry with no viewer open (§17.7), or a media grid entry with no grid open (§30), is passed over
  with `history.back()`, on start and on `popstate`; not the grid's entry while the grid is open (QA BUG-118).

**`views/room/*.test.ts`** (real PocketBase; one file per feature, sharing `views/room/harness.ts`)
- Initial render shows 50 messages, oldest at the top.
- Optimistic send shows a pending message straight away. The server ack clears the pending state, and a later realtime echo does **not** duplicate it.
- When send fails, the message shows as failed with a Retry button. Retry calls `create` again with the **same id**.
- An incoming realtime message while scrolled up shows the "new messages" pill and does not auto-scroll.
- **Deleting:**
  - Delete → confirm calls `update(id, {deleted: true})`, and the message becomes a placeholder showing the author, the time and "Message deleted".
  - Cancel makes no request.
  - On failure the original text is restored.
  - A realtime `update` with `deleted: true` from another user swaps in the placeholder.
  - Placeholders have no Edit or Delete actions.
  - Deleting a failed or pending send removes it from the list without a request.
- A realtime `delete` event (superuser hard delete) removes the element.
- `unmount()` calls unsubscribe and aborts pending requests, and no listeners remain.
- Composer: Enter sends, Shift+Enter adds a newline, and whitespace-only or over-length text is blocked.
- **Windowing**, with 1,000 seeded messages:
  - Repeatedly triggering the top sentinel eventually reaches message #1 and shows "Beginning of #room".
  - The DOM never holds more than 300 messages.
  - No message is duplicated or skipped across the whole scroll.
- Scrolled into history (`hasNewer`): a realtime `create` is **not** appended, and the "Jump to latest" pill appears. Clicking it resets the window to the latest page.
- "Jump to beginning" loads the first page and hides the top sentinel.
- A stale page response that arrives after a jump is discarded.
- **Editing:**
  - Edit shows a prefilled textarea. Enter calls `update`, and the "(edited)" label appears once the server responds.
  - Esc restores the original text with no request.
  - On a failed save the old text is restored and an error is shown.
  - Up arrow in an empty composer edits the user's last own message.
  - Edit and Delete are not shown on other users' messages.
- **Archived room:** the banner is shown, there is no composer, and there are no Edit or Delete actions.

**`views/rooms.test.ts`** (real PocketBase)
- The three sections render. Hide moves a room to Hidden (calling `hidden_rooms.create`) and Unhide moves it back.
- The Archive action is visible only to the creator and needs a confirm.
- A realtime room `update` with `archived: true` moves the room to Archived.

**`views/login.test.ts`**
- Validation errors from the server are shown.
- Successful login navigates to `/`.

## 9.2 Integration tests (`tests/integration/`)

A Vitest `globalSetup` does the following:

1. Creates a temp dir.
2. Runs `bin/chirkle-server superuser upsert` and `bin/chirkle-server serve --http 127.0.0.1:<free port> --dir <tmp>/pb_data --migrationsDir pb_migrations --hooksDir pb_hooks`.
3. Waits for `/api/health`.
4. Provides the URL to the tests, and kills the process and removes the dir on teardown.

Each test file creates fresh users through a helper, so tests don't depend on each other's data.

**Schema and migrations**
- All three collections exist with the expected fields and indexes.
- Migrations apply cleanly to an empty DB, and running them a second time is a no-op.

**Auth and rules: `messages`**
- An anonymous user cannot list, view or create messages (403 or an empty list).
- User A can create a message with `author = A`.
- User A **cannot** create a message with `author = B` (400 or 403).
- User B cannot delete or update A's message. User A can edit and delete their own.
- **Soft delete:**
  - `update({deleted: true})` returns `deleted: true`, `text: ""` and `deleted_at` set.
  - The record still appears in list results, so pagination stays continuous.
  - A raw DB read confirms the old text is gone.
  - Sending `{deleted: true, text: "x"}` still results in empty text.
  - A deleted message rejects further edits and `{deleted: false}` (undelete).
  - A client cannot set `deleted_at` directly or create a message already deleted.
  - The `DELETE` endpoint is rejected for every user, including the author.
  - Deleting does not set `edited_at`.
  - A subscriber receives the soft delete as an `update` event.
- Editing text sets `edited_at`. An update with unchanged text leaves `edited_at` empty. A client cannot set `edited_at` directly.
- User A cannot move a message to another room or change its author by update.
- Text over 2000 chars, or whitespace-only text, is rejected (hook plus field rule), both on create and on edit.
- A client-supplied id is accepted. Reusing an existing id is rejected, which is what makes Retry safe.

**Auth and rules: `rooms` and archiving**
- Any authenticated user can create a room. Creating a room with `created_by` set to someone else, or created already archived, is rejected.
- A duplicate room name, including one that differs only in case, is rejected. This includes the name of an archived room.
- Only the creator can rename, archive or unarchive a room. Archiving sets `archived_at`, and unarchiving clears it.
- The `DELETE` endpoint on rooms is rejected for every user, including the creator.
- An archived room cannot be renamed into another room's name, and a new room cannot take an archived room's name. Names are never reused.
- In an archived room, message create, edit and delete are all rejected, including for the room creator. List and view still work. After unarchiving, posting works again.

**Auth and rules: `hidden_rooms` and `users`**
- User A can hide a room for themselves. Hiding a room for user B (`user = B`) is rejected.
- Hiding the same room twice is rejected by the unique index.
- User B listing `hidden_rooms` never sees A's rows.
- A can unhide (delete) their own row, and B cannot delete A's row.
- Signing up works without email verification, and the new user can post immediately.
- Listing users as an authenticated user never returns other users' `email`.

**History and pagination**
- Seed 1,000 messages in one room, including several that share the same `created` value.
- Walking the room with older-page cursors from the latest page returns all 1,000 exactly once, in order, ending at the very first message.
- Walking the room with newer-page cursors from the first page gives the same result.
- `EXPLAIN QUERY PLAN` for the cursor query uses `idx_messages_room_created` and does not scan the whole table.

**Realtime**
- B subscribes to room R1 with a filter. When A posts in R1, B receives a `create` event with `expand.author.name`. When A posts in R2, B receives **nothing** within 500 ms.
- An anonymous subscriber receives no message events.
- A delete produces a `delete` event for subscribers.

**Hooks and headers**
- `GET /` returns the CSP and `nosniff` headers.
- `/assets/app-*.js` returns `immutable` cache headers, and `index.html` returns `no-cache`.
- A missing `/assets/` file is a 404 with `no-store`, an unknown `/api/` path a JSON 404; app pages still get `index.html`.
- Rate limit: the 11th message within 5 seconds returns 429.

## 9.3 End-to-end tests (`tests/e2e/`)

Playwright's global setup (`tests/e2e/global-setup.ts`) builds the app and serves it from one fresh server per worker, each with its own temp data dir (the same helper as §9.2): worker n uses port `E2E_PORT` (default 8091) + n, and `fixtures.ts` points the worker's `baseURL` and API helpers there (`paths.ts`). So no test sees another worker's rooms, people or live events. Locally the test runs stay out of the way of the desktop (`tests/support/low-priority.ts`): Playwright and Vitest drop to the lowest CPU priority, which every browser, server and worker they start inherits, and use a quarter (Playwright) or half (Vitest) of the cores; `npm run test:go` runs under `nice` with `-p 2`. CI keeps the defaults; `TEST_NICE=0` opts out and `--workers`/`--maxWorkers` still override.

Before building, the setup runs `scripts/doctor.mjs` (`npm run doctor`, REFACTOR item 57) for the run's browsers and ports, and stops with what to fix: a browser that can't start or has no fonts (it then keeps no input values, and every login fails), a full `TMPDIR`, a port held by a stray server. A test that fails now and then for a reason not yet fixed is tagged `@flaky` (`test("…", { tag: "@flaky" }, …)`): the regular runs leave it out (`playwright.config.ts`, `FLAKY=1` runs it), and `.github/workflows/flaky.yml` runs each one 20 times every night and reports its failure rate (`scripts/flaky-report.mjs`). The fix removes the tag (REFACTOR item 58).

1. **Signup to first message:** sign up, see the empty room list, create "general", send "hello", and see it rendered with the user's name.
2. **Realtime between two users:** two browser contexts, A and B, are in the same room. A sends a message and B sees it within 1 second without reloading. B deletes their own message, and A sees it turn into a "Message deleted" placeholder that keeps B's name and the time. After a reload the placeholder is still there.
3. **Full history:**
   - Seed 2,000 messages through the API. The newest 50 are shown.
   - Scrolling up keeps loading without the view jumping, until "Beginning of #room" and message #1 are visible.
   - The DOM stays at or below 300 messages throughout.
   - Scrolling back down reaches the live edge, and a message B sends then appears live.
   - "Jump to beginning" in the menu shows message #1 directly.
4. **Edit message:** A edits their message and B sees the new text plus "(edited)" live. Up arrow in an empty composer opens the last message for editing.
5. **Hide and unhide:** A hides "random". It disappears from A's list and appears under Hidden, while B's list is unaffected. Opening it by URL still works. Unhide restores it.
6. **Archive:**
   - The creator archives the room. Both A and B see it move to Archived, and the composer is replaced with the read-only banner.
   - History can still be scrolled to the beginning.
   - A user who is not the creator sees no Archive action.
   - Unarchive brings the composer back.
7. **Session persistence:** reloading the page keeps the user logged in. Logging out redirects to `/login`, and going back does not show room content.
8. **Reconnect gap fill:** take B offline with `context.setOffline(true)`, have A send 80 messages (more than one page), bring B back online, and all 80 appear in order.
9. **XSS smoke test:** sending `<img src=x onerror=window.__pwned=1>` renders as literal text and `window.__pwned` stays undefined. The same holds after editing.
10. **Mobile viewport (390×844):** the room list collapses, the composer is visible above the keyboard area, and sending works.

## 9.4 Non-functional checks

- **Bundle budget:** the build fails if the limits in §7.7 are exceeded.
- **Accessibility:** run `@axe-core/playwright` on the login, rooms and room screens, with zero serious or critical violations (this adds a dev dependency only).
- **Performance smoke test (optional in CI):** Playwright with 4× CPU throttling. The time from navigating to `/r/:id` until the first message is visible should be under 1.5 s on a local server.

## 9.5 Static checks

- `tsc --noEmit` in strict mode.
- A grep check in CI fails if `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` appear in `web/src`.

## 9.6 CI (GitHub Actions)

The CI job:

1. `npm ci`
2. `npm run setup` (cached by PocketBase version)
3. `npm run check`
4. `npx playwright install --with-deps`
5. `npm run test:e2e`

Playwright traces are uploaded when a test fails. The job runs on every push and pull request.
