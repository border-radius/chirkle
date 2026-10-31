# QA pass — avatars, direct messages, attachments

Exploratory QA of the post-MVP features (DESIGN.md §15–§17), 2026-10-10, against a production build on a fresh
PocketBase 0.40.4, in Chromium (desktop 1100×720 and phone 390×844), plus probes of the REST API. Numbering continues
the MVP QA pass (BUG-01 … BUG-23, cited in the tests). Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-24 | **High** (security) | Uploads | A tiny image with huge dimensions exhausts server memory when thumbnailed | Fixed |
| BUG-25 | Medium | Attachments | After a page reload, every attachment image fails once before loading | Fixed |
| BUG-26 | Medium | Uploads | Prepared images are WebP, so every thumbnail is served as a large PNG; transparent PNGs turn black where WebP can't be encoded | Fixed |
| BUG-27 | Medium | Attachments | Dropping a file anywhere but an open room makes the browser open the file and leave the app | Fixed |
| BUG-28 | Medium | Attachments | Original file names are lost ("Quarterly Report (final).pdf" shows and downloads as "quarterly_report_final.pdf") | Fixed |
| BUG-29 | Medium | DMs | Just opening a DM (no message sent) makes it appear in the other person's sidebar | Fixed |
| BUG-30 | Low | DMs | "Message" always calls the server, even for a DM that is already open, and any failure says "Check your connection" (also on rate limiting) | Fixed |
| BUG-31 | Low | Composer | Opening the attachment tray (or the textarea growing) pushes the newest messages out of view | Fixed |
| BUG-32 | Low | Mobile | A long author name pushes the message time off screen | Fixed |
| BUG-33 | Low | Profile | A name or avatar change in one tab isn't shown in the app bar of the user's other tabs | Fixed |
| BUG-34 | Low | DMs | "%" in the user search is a wildcard: searching "%" lists everyone, "100%" finds nothing | Fixed |

---

## BUG-24 — Image "decompression bomb" exhausts server memory (High, security)

**Steps:** as any logged-in user, upload as an avatar (or attachment) an 875 KB PNG declaring 30000×30000 pixels
(a single-colour image compresses to almost nothing), then request its thumbnail (`?thumb=48x48`).

**Expected:** the upload is refused, or thumbnailing is cheap.
**Actual:** the thumbnail request takes 6.3 s and PocketBase's memory peaks at **4.6 GB**. Memory grows with the
declared pixel count, so a ~2 MB avatar (or 8 MB attachment) declaring 50000×50000 or more gets the process killed
for running out of memory. Avatar thumbnails are public, so once uploaded, anyone can re-trigger it, and parallel
requests multiply it.

**Cause:** PocketBase decodes the whole image to make a thumbnail, and nothing limits image dimensions (only file
size, which a compressed bomb easily stays under).

**Fix:** the upload hooks read the header of every uploaded PNG, JPEG, GIF and WebP (the formats PocketBase
thumbnails) and reject images over 25 megapixels (`validation_image_too_large`). The app's own uploads are at most
2048 px on the longest edge (§15.3), about 4 megapixels, so they're never affected.

## BUG-25 — Attachment images fail once after every reload (Medium)

**Steps:** open a room with image attachments, reload the page.
**Expected:** the images load.
**Actual:** each image request first gets 404, then the error handler fetches a new token and the retry loads it:
2 failed requests for 2 images in the probe, a visible flash, and twice the requests.

**Cause:** the file-token cache is cleared on every auth-store change, including the background session refresh
that runs on every page load. The refresh lands while the room's first token request is in flight, so that token is
thrown away and the first render builds URLs without a token.

**Fix:** clear the cache only when the logged-in user actually changes.

## BUG-26 — WebP uploads make PNG thumbnails; transparent PNGs can turn black (Medium)

**Steps:** attach a photo; look at the size and type of the thumbnail Bob's browser loads.
**Actual:** the browser re-encodes every image as WebP (§15.3). PocketBase can't write WebP, so every thumbnail of a
WebP is a PNG: for photo-like content the 480×360 "thumbnail" (35 KB) was bigger than the whole 2000×1500 upload
(25 KB). Separately, where WebP can't be encoded (Safari) the fallback is JPEG, which has no transparency: a
transparent PNG (logo, screenshot with alpha) gets a black background.

**Fix:** keep PNGs as PNG and turn everything else into JPEG. Both are formats PocketBase thumbnails in their own
format, and PNG keeps transparency.

## BUG-27 — A stray file drop navigates away from the app (Medium)

**Steps:** drag a file from the desktop and drop it on the room list, the profile page outside the picture, or an
archived room.
**Expected:** nothing happens (or it attaches, in an open room).
**Actual:** the browser's default action opens the file in the tab, leaving the app (and anything half-typed).
`dragover` was only cancelled over an open room's composer area.

**Fix:** the app cancels the browser's default for file drags and drops on the whole page; the room and the profile
picture still handle their own drops.

## BUG-28 — Original file names are lost (Medium)

**Steps:** attach "Quarterly Report (final).pdf".
**Actual:** it shows, and downloads, as "quarterly_report_final.pdf". PocketBase stores a normalized name plus a
random suffix, and the app could only strip the suffix (§17.5).

**Fix:** a new `messages.file_names` JSON field, set by the create hook from each upload's original name (so the
client can't forge it) and mapping stored name → original name. The list shows and downloads files under their
original name, falling back to the old behaviour for messages sent before the fix. (Prepared images keep their
name; only the extension follows the new format.)

## BUG-29 — An empty DM appears in the other person's sidebar (Medium)

**Steps:** Ada opens a DM with Bob from the user search (or by clicking his name → Message) and sends nothing.
**Actual:** "Ada" appears under Direct messages in Bob's sidebar right away, for a conversation with no messages:
noise, and confusing if Ada clicked the wrong person.

**Fix:** a DM without messages is listed only for the member who opened it. It appears for the other one with its
first message (`last_message_at` is set, and the realtime update brings it in).

## BUG-30 — "Message" always calls the server; misleading error (Low)

**Steps:** click an author's name → Message for someone you already have an open DM with; repeat for a few people.
**Actual:** every click calls `POST /api/chat/dms` (limited to 10 per minute per IP, which a whole office behind one
NAT shares). When it fails for any reason, including 429, the text is "Check your connection".

**Fix:** go straight to an open DM that is already in the room list, without a request. Errors use the shared
`errorMessage()` (which has a rate-limit sentence).

## BUG-31 — The newest messages get hidden when the composer grows (Low)

**Steps:** scroll to the bottom of a busy room, attach a file (or type several lines).
**Actual:** the tray (or the taller textarea) shrinks the list from below, so the newest message slides under the
composer and the list is no longer at the bottom.

**Fix:** when the list's height changes and it was at the bottom, keep it at the bottom.

## BUG-32 — Long author names push the time off screen on phones (Low)

**Steps:** at 390 px width, view a message from "Bob Builderson Longname-Smith".
**Actual:** the time is cut off ("10:55 P"). Another user's name is now an author menu (`<details>`), which doesn't
shrink, so the name no longer truncates with an ellipsis as it did before.

**Fix:** the author menu shrinks, and its name truncates with an ellipsis.

## BUG-33 — Profile changes don't reach the user's other tabs (Low)

**Steps:** open the app in two tabs; change your display name or avatar on `#/me` in one.
**Actual:** the other tab's app bar keeps the old name/avatar until a reload. The shared session does update (tabs
share it), but the app ignored auth changes that keep the same user id.

**Fix:** an auth change for the same user still updates the logged-in user's name and avatar in the store.

## BUG-34 — "%" is a wildcard in the user search (Low)

**Steps:** in "New message", search for "%", then for "100%".
**Actual:** "%" lists every user; "100%" finds nobody, even a user called "Load 100%". PocketBase's `~` treats a `%`
in the value as a wildcard (and then stops adding its own), while `_` is already escaped.

**Fix:** escape `%` in the search text.

---

## Checked and fine

- Non-members can't reach a DM or its files by any API path tried (view, list, realtime, expand, file token, hiding
  it); a new message can't reference another message's stored file by name.
- Uploaded HTML/SVG is a sandboxed download; avatar uploads are checked by content, not by extension.
- Retrying a failed upload re-sends the same id and files and can't post twice.
- WebP and GIF thumbnails work; a 6000×6000 image thumbnails in 0.2 s (BUG-24 is about far larger ones).
- Up arrow edits a files-only message (empty text), and editing keeps its attachments.

Known, not fixed here: an emoji-less system (this test container) shows the file chip's "📄" as a box; a browser that
already loaded an attachment can keep it in its cache after the message is deleted (DESIGN §17.1).

---

# QA pass 3 — whole app

Exploratory QA of the whole app, 2026-10-11, on PocketBase 0.40.4: REST and hook probes (rules, hooks, DMs, unread
counts, uploads) and Chromium at desktop and phone sizes, light and dark. Beforehand, the whole suite passed: typecheck,
lint, html-sink check, 401 unit, 192 integration, build and 23 e2e tests. Each fix comes with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-35 | Medium | Attachments | A file whose non-Latin name is over 255 bytes can never be sent | Fixed |
| BUG-36 | Low | Attachments | Names cut at the 200-character limit lose their extension | Fixed |
| BUG-37 | Low | DMs | An empty DM the other member opened first is missing from your list, even while you are in it | Fixed |
| BUG-38 | Low | Names | Line breaks, tabs, control characters and runs of spaces are kept in room and display names | Fixed |
| BUG-39 | Low | Rooms | Every failed room action says "Check your connection", whatever the reason | Fixed |
| BUG-40 | Low | Login | A wrong password says "Failed to authenticate." | Fixed |
| BUG-41 | Low | Rooms | Rooms whose names clashed before `name_key` existed can't be archived or unarchived | Fixed |
| BUG-42 | Low | Composer | Text made only of zero-width characters enables Send; the server refuses it and Retry never works | Fixed |

## BUG-35 — Long non-Latin file names can't be sent (Medium)

**Steps:** attach "Протокол совещания Протокол совещания … .pdf" (152 characters, 291 bytes) and send it.
**Actual:** "Not sent", and Retry fails every time. The same happens with an emoji or accented name over about 250 bytes,
and with avatars.
**Cause:** PocketBase stores the original name as file metadata, cut at 255 bytes. The cut can split a multi-byte
character, and the storage layer then refuses the invalid UTF-8 (`WriterOptions.Metadata values must be valid UTF-8`).
**Fix:** the create hooks (messages and users) clean each upload's original name and cut it to 200 UTF-8 bytes, on a
character boundary, before PocketBase stores it.

## BUG-36 — Cut names lose their extension (Low)

**Steps:** attach a file named with 70 × "報告書" + ".xlsx".
**Actual:** it shows and downloads as "報告書…報告書報.t". The 200-character cap was a plain `slice`.
**Fix:** the cut keeps the extension (up to 16 characters) and shortens the rest of the name.

## BUG-37 — An empty DM is missing from the second opener's list (Low)

**Steps:** Bob opens a DM with Ada and sends nothing. Later, Ada clicks Bob → Message.
**Actual:** the DM opens for Ada, but it isn't listed under Direct messages, so there's no highlighted row. The BUG-29
fix lists an empty DM only for its creator.
**Fix:** an empty DM is also listed while it is the open room.

## BUG-38 — Control characters and repeated spaces in names (Low)

**Steps:** create a room named "two\nlines" (through the API), then "two lines" and "two  lines".
**Actual:** three separate rooms that look identical on screen, because HTML shows a line break or a run of spaces as one
space. That is the kind of look-alike name the QA fixes in BUG-12 meant to prevent. Display names have the same problem.
**Fix:** names (and attachment names) turn control characters into spaces and every run of whitespace into one space.

## BUG-39 — "Check your connection" for every failed room action (Low)

**Steps:** hide, archive or close rooms quickly until the server rate-limits you (or it refuses for another reason).
**Actual:** the sidebar says "Couldn't hide … Check your connection and try again.", and the room header says "That
didn't work. Check your connection…", even on a 429. BUG-30 fixed this for "Message" only.
**Fix:** both use `errorMessage()`, which explains network trouble, rate limits and the server's reason.

## BUG-40 — "Failed to authenticate." on a wrong password (Low)

**Fix:** a refused login says "Wrong email or password."

## BUG-41 — Legacy look-alike rooms can't be archived (Low)

**Steps:** have two rooms whose names clashed before the `name_key` migration (e.g. "Über" and "über"). The migration
kept both, giving the second a key made unique with its id. As that room's creator, archive it.
**Actual:** "Value must be unique." Every room update re-checked the name, even when it didn't change.
**Fix:** the name is checked only when it changes. Otherwise the stored key is kept, and a client still can't set it.

## BUG-42 — Zero-width-only messages (Low)

**Steps:** paste only a zero-width space into the composer and press Enter.
**Actual:** it sends, the server refuses blank text, and the message shows "Not sent" with a Retry that can never work.
**Fix:** the composer treats such text as empty, as the server does. Joiners inside real text still count as text.

## Checked and fine

- Rules: other users' messages, rooms, hidden rows and read positions can't be read or changed. Nobody can un-delete,
  move or hard-delete a message, or post as someone else. Nobody can create DMs, archived rooms or room_reads rows
  through the API, or set `created`/`file_names`. Changing email or `verified` directly is refused.
- DMs: nothing reaches a non-member: view, list, expand, post, hide, mark read.
- Unread: counts skip your own and deleted messages, and anything from before you signed up. A read can't be moved back
  or into the future, and bad dates are refused.
- User search: `%`, `_`, `\`, quotes and `{:x}` are matched literally.
- Live archive/unarchive while someone is typing keeps the draft. Deep links to a message in another room, or to a
  missing room, fall back cleanly. Offline sends fail and then retry without duplicates.

Known, not fixed here: a renamed user's old name stays in other people's open DMs and already-loaded messages until
they reload (nothing pushes user changes). The per-IP limit of 120 reads a minute may be tight for a large office
behind a single NAT.

---

# QA pass 4 — whole app

Exploratory QA of the whole app, 2026-10-11, on PocketBase 0.40.4. It used scripted multi-user Chromium sessions
(desktop 1100×720 and phone 390×844, light and dark, several tabs per user), axe on states the e2e suite doesn't
cover, and REST, hook and migration probes. Beforehand, the whole suite passed: typecheck, lint, html-sink check,
432 unit and 207 integration tests, and the build. Each fix comes with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-43 | Medium | Editing | An open edit box loses what you typed (and its focus) whenever its message is redrawn | Fixed |
| BUG-45 | Medium | Session | A tab left open longer than the session lasts looks logged in, but nothing can be sent | Fixed |
| BUG-47 | Medium | Accounts | Emails are case-sensitive: "Ada@x.com" can't log in as "ada@x.com", and can sign up twice | Fixed |
| BUG-44 | Low | Rooms | With every room hidden or archived, the list says "No rooms yet. Create the first one." | Fixed |
| BUG-46 | Low | Menus | "⋯" and author menus stay open after a click elsewhere, pile up and cover messages | Fixed |
| BUG-48 | Low | Rooms | A room created as "#random" is shown as "##random", next to a different "random" | Fixed |
| BUG-49 | Low | Signup | Signing up with an email that is taken says "Value must be unique." | Fixed |
| BUG-50 | Low | Composer | A half-typed message is lost when you look at another room and come back | Fixed |

## BUG-43 — The edit box forgets your typing (Medium)

**Steps:** follow a link to one of your messages (or click a reply's quote), click Edit and type for a few seconds.
Or: edit a reply of yours while the author of the message it quotes edits theirs.
**Actual:** after 3 s the highlight fades, the message is redrawn, and the edit box is back to the original text,
without focus. The same happens on any redraw of that message (quoted message edited, midnight).
**Fix:** the list keeps the typed text, and gives the rebuilt box back the focus and caret. Escape (not while composing
with an input method) still discards it.

## BUG-45 — Expired sessions fail silently (Medium)

**Steps:** stay on the app, without reloading, for longer than the users' token lifetime (7 days by default; reproduced
with 20 s).
**Actual:** the app still shows you logged in. Every send ends in "Not sent." and Retry never works. Only the page load
renewed the session.
**Fix:** the app renews the session halfway through its lifetime (at least daily), and again when the tab comes back to
the foreground (timers are late while a computer sleeps). It retries after a network failure. A session that has
already expired goes to the login screen instead of failing quietly.

## BUG-47 — Emails depend on their capitalization (Medium)

**Steps:** sign up as "Mixed@Test.Local", log out, log in as "mixed@test.local". Or sign up again with the lower-case address.
**Actual:** "Wrong email or password." The second signup succeeds, so the same mailbox has two accounts.
**Fix:** new emails are stored in lower case (users create hook). A login whose email matches nobody as typed is
looked up in lower case (`onRecordAuthWithPasswordRequest`). A migration lowers existing emails, except for pairs
that already differ only in case. Those keep their addresses, and each still logs in as typed.

## BUG-44 — "No rooms yet" while rooms exist (Low)

**Steps:** hide (or archive) every room. **Actual:** "No rooms yet. Create the first one." above "Hidden (4)".
**Fix:** "No other rooms. Hidden and archived ones are listed below." whenever those sections aren't empty.

## BUG-46 — Menus never close on their own (Low)

**Steps:** open a room's "⋯", the header's "⋯" and an author's name menu, then click into the messages.
**Actual:** all three stay open. The author menu's "Message" covers the message text.
**Fix:** an open menu closes on a pointer press or focus anywhere outside it.

## BUG-48 — "##random" (Low)

**Steps:** New room → "#random". **Actual:** the room is titled "##random", and "random" can still be created next to
it. **Fix:** leading "#"s (and spaces) are dropped from room names on save. "c#" keeps its inner "#".

## BUG-49 — "Value must be unique." on signup (Low)

**Fix:** "There is already an account with this email. Log in instead."

## BUG-50 — Drafts lost on switching rooms (Low)

**Steps:** type a message, click another room to look something up, come back. **Actual:** the composer is empty.
**Fix:** unsent text is kept per room (in memory, for the session; cleared on logout or a user switch).

## Checked and fine

- Two tabs of one user: sends, reads and unread badges stay in sync. Logging out in one logs out the other.
- DMs: opened from the search, the first message brings it to the other person with a badge. A closed DM comes back on
  the next message.
- History: scrolling back to the first message of a 180-message room, jumping to the beginning, "New messages · Jump
  to latest", sending from the beginning, the pill while scrolled up, and deep links scrolled forward to the live edge.
- Attachments: image thumbnail plus a PDF under its original name, and a 0-byte file. Replying to a files-only
  message, and the reply bar closing when that message is deleted.
- No horizontal overflow from 400-character words or long URLs, at desktop or phone width.
- axe (WCAG 2.1 AA): no violations with the reply bar, delete confirm, header menu or edit box open, at both widths
  and in both themes.
- Limits: 2000 emoji in a message, 32 in a name, 48 in a room name.

Known, not fixed here: the document title never shows unread counts.

---

# QA pass 5 — whole app

Exploratory QA of the whole app, 2026-10-12, on PocketBase 0.40.4: scripted multi-user Chromium sessions (several
devices and tabs per user, desktop 1100×720 and phone 390×844, light and dark), axe on states the e2e suite doesn't
cover (profile errors, emoji picker, selecting, bulk-delete confirm, forward dialog, user search, new room), and REST
probes of the rules and routes. Beforehand, the whole suite passed: typecheck, lint, html-sink check, 505 unit and 248
integration tests, the build, and e2e (except the known local timeouts in `reactions.spec.ts`). Each fix comes with a
test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-51 | Medium | Session | After a password change, other devices still look logged in: nothing arrives, every send is "Not sent" | Fixed |
| BUG-52 | Medium | Realtime | After a password change, the user's other tabs (and the sidebar of the tab that changed it) stop updating live | Fixed |
| BUG-55 | Medium | DMs | The user search ignores case only for ASCII: "иван" doesn't find "Иван" | Fixed |
| BUG-53 | Low (security) | Accounts | A password can be changed through the users API, around the route's rate limit and checks | Fixed |
| BUG-54 | Low | Attachments | A file named `Q&A "v2".txt` shows and downloads as `Q&A %22v2%22.txt` | Fixed |
| BUG-56 | Low | Profile | After "This display name is taken", putting your own name back leaves the error showing | Fixed |
| BUG-57 | Low (a11y) | Theme | Red text on a hovered button (Delete, Log out, confirms) is 4.25:1, under WCAG AA's 4.5:1 | Fixed |
| BUG-58 | Low | Selecting | A failed delete of several messages always says "Check your connection", even when rate limited | Fixed |

## BUG-51 — Signed-out devices don't know it (Medium)

**Steps:** be logged in on two devices. On one, change the password (the page says "You were logged out everywhere
else"). Use the other.
**Actual:** it still shows you logged in. No new messages arrive, and everything you send ends in "Not sent." with a
Retry that never works, until you reload. The token was revoked, but the app only checked its session on load and when
it neared expiry, and a revoked token gets 400/404 on writes (PocketBase treats it as no session), not 401.
**Fix:** when the server refuses a change sent with the session (400, 401, 403, 404), the app checks the session (at
most every 30 s); it also checks when the tab comes back after 5 minutes. A revoked session goes to the login screen.

## BUG-52 — Other tabs go quiet after a password change (Medium)

**Steps:** two tabs of the same browser in a room. Change the password in one; have someone post.
**Actual:** the other tab gets the new token (tabs share the session) but never shows the message, and its badges stop
updating, until you switch rooms or reload. The tab that changed it loses its sidebar's live updates the same way.
**Cause:** PocketBase knows who a realtime client is from the token its subscriptions were sent with. The old one was
revoked, and the subscriptions were only sent again when they changed.
**Fix:** the realtime client sends its subscriptions again whenever the session token changes.

## BUG-55 — User search is case-sensitive outside ASCII (Medium)

**Steps:** New message (or Forward) → search "иван" for a user called "Иван", or "élodie" for "Élodie".
**Actual:** nobody found. The search was `name ~ q`, and SQLite's `LIKE` only ignores the case of ASCII letters.
**Fix:** a `GET /api/chat/users?q=` route matches the query's name key against `users.name_key` (NFKC, case folded,
§22.1), so "иван", "ИВАН" and "Иван" are the same, and "strasse" finds "Straße". It answers only id, name and avatar.

## BUG-53 — Password changes around POST /api/chat/password (Low, security)

**Steps:** `PATCH /api/collections/users/records/<me>` with `oldPassword`, `password`, `passwordConfirm`.
**Actual:** 200: the password changes at the generic limit (300 requests per 10 s), not the route's 5 per minute, so a
stolen session could guess the current password far faster. It also skipped the route's "same password" check.
**Fix:** the users update rule refuses `password` and `passwordConfirm`. The route saves directly, so it still works.

## BUG-54 — `"` in file names becomes `%22` (Low)

**Steps:** attach `Q&A "v2".txt`. **Actual:** shown and downloaded as `Q&A %22v2%22.txt`. Browsers escape `"` (and line
breaks) in multipart file names, per the HTML spec. **Fix:** the upload hooks undo that escaping before keeping the name.

## BUG-56 — A stale "taken" error on the profile (Low)

**Fix:** saving your current name clears the error (there is nothing to save).

## BUG-57 — Low contrast of red text on hover (Low, accessibility)

**Steps:** hover a red button (a message's Delete, the bulk-delete confirm, Log out). **Actual:** `#d1213b` on the hover
background `#e9e4fb` is 4.25:1. **Fix:** the light theme's red is `#c41d36` (4.74:1 hovered, 5.65:1 on the page). A unit
test checks red text against every background token in both themes.

## BUG-58 — "Check your connection" for every failed bulk delete (Low)

**Steps:** delete selected messages more than 20 times in a minute. **Actual:** "Couldn't delete those messages. Check
your connection and try again." on a 429. BUG-39 fixed this elsewhere. **Fix:** it says why, with `errorMessage()`.

## Checked and fine

- Forwarding: to a room, an existing DM and a new DM (found by name), with attachments and from a reply; Bob gets the
  DM live with a badge and can open the copied files. Nothing can be forwarded from or into someone else's DM, into an
  archived room, or more than 50 at once; duplicate ids forward once.
- Selecting and deleting several of your own messages, with the confirm step; others' messages can't be deleted.
- Drafts survive switching rooms and a reload, and are gone once sent. The tab title and favicon follow unread counts,
  DMs included.
- Signup with a taken name (in another case) says so; names are tidied ("  Fresh   Person  " → "Fresh Person").
- Room names made only of "#" are refused; a hidden room can't be hidden twice; replies can't point into another room.
- No horizontal overflow at 390 px; axe found nothing else in the states listed above.

Known, not fixed here: in the forward dialog, the first Escape in a non-empty search field clears it (the browser's
behaviour for search fields) and the second closes the dialog.

---

# QA pass 6 — room access: private rooms, Open Air rooms, guests

Testing of §23 while building it, 2026-10-12, on PocketBase 0.40.4 in Chromium (1100×720 and a 390×844 phone, light
and dark): integration probes of every rule and route as a member, a non-member, a removed member, the creator and a
guest (no session); unit tests of the views; Playwright runs with several users and a guest side by side; axe on the
guest home, guest room, sign up, the room list's new-room form and the access dialog. Numbering continues from BUG-58.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-66 | **High** (privacy) | Realtime | After logging out, the tab goes on receiving the previous user's live events: their DMs and private rooms show up in the guest's room list | Fixed |
| BUG-59 | Medium | Session | After a logout, the next login (anyone's) lands on the page the previous user was on: their profile, or a private room's URL | Fixed |
| BUG-60 | Medium | Room access | A room that went away while open stays "You can't see this room any more" after access comes back, and clicking it in the list does nothing | Fixed |
| BUG-61 | Medium | Rooms | A message sent while a room is opening can be missed until the next reconnect (likelier for a guest following a link) | Fixed |
| BUG-67 | Medium | Realtime | A connection replaced while still connecting (BUG-66's restart, or a reconnect) could fail the new connection's subscriptions | Fixed |
| BUG-62 | Low | Session | Logging out reset the session twice (two `unsubscribeAll` requests) | Fixed |
| BUG-63 | Low | Performance | Every DM message made the server go through every realtime client, looking for someone who lost access | Fixed |
| BUG-64 | Low (a11y) | Room access | Each visibility radio button's name was its whole explanation | Fixed |
| BUG-65 | Low | Mobile | The new-room form's visibility select used 13.6 px text, which makes iOS Safari zoom in on focus | Fixed |

## BUG-66 — A logged-out tab still gets the previous user's events (High, privacy)

**Steps:** Ada logs out (the tab now shows the guest view). Bob then writes to Ada in their DM and adds her to a
private room. **Expected:** the guest view shows neither. **Actual:** both rooms appear in the guest's room list,
live; anyone at the computer sees Ada's DM and private room names (and the DM partner).
**Cause:** the realtime connection outlived the session. Logging out dropped the subscriptions on the client, the guest
view subscribed again on the same connection, and PocketBase refused that request (403: "the current and the previous
request authorization don't match"), leaving the connection subscribed as Ada. The guest's room-list listener has the
same subscription key as Ada's, so it got her events. Before guests existed, nothing subscribed after a logout.
**Fix:** when the session changes to another user, or to none, the client closes the realtime connection and opens a
new one (`restart()` in `pb.ts`); a new token for the same user still just resends the subscriptions (BUG-52). Found
by a `403` in the output of a unit test, then reproduced with a probe.

## BUG-59 — The next login lands on the previous user's page (Medium)

**Steps:** Ada opens her profile (or a private room) and logs out; Bob logs in on the same tab.
**Expected:** Bob lands on the home page. **Actual:** he lands on Ada's last page, `#/me` (or the private room's URL,
which says it doesn't exist).
**Cause:** the page to go back to after logging in (so a guest returns to the room they were reading) was only updated
on `hashchange`; logging out moves home with `history.replaceState`, which fires none.
**Fix:** logging out resets it to home. Found by `session.spec.ts`.

## BUG-60 — A room that comes back stays gone (Medium)

**Steps:** a guest reads an Open Air room; its creator archives it (the guest sees "You can't see this room any
more."), then unarchives it. **Expected:** the room shows again. **Actual:** the message stays, and clicking the room,
which is back in the list, does nothing: it is the URL already open, so nothing remounts. Same for a member taken out
of a private room and added back.
**Fix:** a room view showing "gone" or "doesn't exist" starts the page over once the room is in the list (again).
Found by `room_access.spec.ts`.

## BUG-61 — A message sent while a room opens can be missed (Medium)

**Steps:** open a room (as a guest, from a link) while someone posts in it. **Expected:** the message shows.
**Actual:** sometimes it never does, until a reconnect or a reload.
**Cause:** the first page and the realtime subscription are set up side by side. A message created after the page was
read but before the server had the subscription reaches neither. With a warm connection the window is one request;
a guest's first page load also opens the realtime connection, which makes it several round trips. Found while
investigating a flaky `room_access.spec.ts` run, and shown by a unit test that holds the subscription back (it fails
without the fix). That flaky run itself turned out to be the spec's own race: it typed into the composer while the
modal access dialog was still saving, so the message was never sent; the spec now waits for the dialog to close.
**Fix:** when the subscription is ready only after the page, the room fetches anything newer than its newest message
once (no request otherwise, no scrolling unless at the bottom).

## BUG-67 — A replaced connection fails the new one (Medium)

**Found:** `npm run check` stopped on an unhandled rejection ("Missing or invalid client id", 404) after the BUG-66 fix.
**Cause:** when a connection is closed while its connect handler is still sending the subscriptions (a restart for
another user, or a reconnect), the server forgets that client and answers 404. The handler's error path then ran
against the *new* connection: it rejected the new connection's pending subscribes (the unhandled rejection: the room
list or a room got no live updates) and could close the new connection. Before BUG-66's fix only an ill-timed
reconnect could do this.
**Fix:** each connection's handlers check that it is still the current one before touching any state.

## BUG-62 to BUG-65 (Low)

- **BUG-62:** logging out ended the session, then the auth change ended it again: two `unsubscribeAll` requests. Ending
  a session that isn't running now does nothing.
- **BUG-63:** the hook that tells clients they lost access ran on every room save, and DM messages save their room.
  It returns early when visibility, archived, creator and members are unchanged.
- **BUG-64:** the radio buttons' labels held the explanation too ("Private Only the people you add can read and
  post."). They are labelled by the name and described by the explanation.
- **BUG-65:** the select was 0.85 rem; fields stay at 16 px (§22, QA pass 5).

## Checked and fine

- Non-members of a private room can't list, view, filter, expand into, subscribe to (by `*` or by id), post in, react
  in, forward into, hide or mark read the room, or download its attachments; neither can guests. A member taken out
  loses all of it, including editing and deleting what they wrote there, and gets a realtime delete for the room; the
  others get the update, everyone else nothing.
- Only the creator changes visibility and members; the creator can't be removed; duplicate and unknown members, more
  than 100, and changes to a DM are refused or cleaned up; the members list is dropped when a room stops being private.
- Guests list and read Open Air rooms only, with authors (no emails), reactions, replies and attachments (thumbnails
  and full files, without a token), live; never public, private or archived ones, DMs, user lists, unread counts or
  file tokens. A guest's view drops an Open Air room as soon as it is archived or made public, and gets it back live.
- Logging in or signing up from a room returns to it; `#/me` as a guest asks to log in and returns there; logging out
  goes home as a guest; an expired session goes to the login page.
- axe: no violations in the states above, light and dark. No horizontal overflow at 390 px.

Accepted, not fixed: room names stay unique across all rooms, so trying to create a room under a private room's name
says it is taken (§13, room access).

---

# QA pass 7 — found while refactoring (docs/REFACTOR.md round 3)

Not an exploratory pass: these turned up as flaky tests while the test suites were reorganized, 2026-10-13, and each
was traced to its cause before being fixed (a stack trace per request, the test server's own request log). Each fix
lands with a test that fails without it. Numbering continues from BUG-67.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-68 | Medium | Realtime | A session renewal (or password change) answered after a logout closed the guest's new connection: no live updates, no reconnect | Fixed |
| BUG-69 | Medium | Rooms | A room list reload answered after live events undid them: a room you were taken out of was listed again, an archive undone | Fixed |
| BUG-70 | Low | Attachments | Leaving a room while a message with attachments was sending kept its previews in memory | Fixed |

## BUG-68 — A late resubmit closes the new connection (Medium)

**Found:** unhandled `PbError` rejections from `pb.ts` in full unit runs, after a logout.
**Cause:** BUG-67 made each connection's connect handler check that it is still the current one, but `resubmit()`
(which sends the subscriptions again whenever the token changes: every session renewal, a password change) had no such
check. Answered after its connection was replaced (a logout in between), its failure went to `connectError` while the
new connection had no client id yet: that rejected the new connection's subscribes and closed it, with no reconnect
scheduled. `scope.sub()` also left a failed subscribe unhandled until the scope was disposed.
**Fix:** `resubmit()` ignores a failure once `es` is no longer the connection it was sent for; `scope.sub()` catches at
once (the realtime client keeps the subscription and sends it on the next connection). Tests: `pb.test.ts` (a fake
EventSource and fetch play renew, log out, late 404), `scope.test.ts`.

## BUG-69 — A reload undoes live room events (Medium)

**Found:** `access.test.ts` "taken out of a private room while in it" saw the room come back, now and then.
**Cause:** `sync.ts` reloads the room list on start and on every reconnect, and its answer replaced the list in the
store. Live events that arrived while it was in flight are newer than that answer and were lost: a room you were taken
out of was listed again (and the view, seeing it back, reopened it), an archive was undone. An older reload answering
after a newer one overwrote it too.
**Fix:** events received during a reload are applied again on top of its answer, in the same store update (one by one,
the room would vanish and come back, which the view takes for access regained), and an answer older than the one in
the store is dropped, as `unread.ts` already did for counts. Tests: `sync.test.ts`.

## BUG-70 — Previews kept after leaving a room mid-send (Low)

**Found:** a flaky check in `room/attachments.test.ts` that the preview was released.
**Cause:** a sent message's preview URLs were released when `api.send` answered, after the room view's scope check. The
realtime echo can replace the pending copy before that answer; leaving the room in between skipped the release, and
nothing else held those previews any more.
**Fix:** released as soon as the server has the message, before the scope check (`room/controller.ts`).

## Also found: test fixtures writing to the database

Not an app bug, but it looked like one: message edits and deletes failing with 400 "Failed to update record." under
load, logged by PocketBase as `database is locked (517)`. The test helpers wrote to `data.db` from other processes,
which can commit inside one of the server's transactions; PocketBase itself sends every write through one connection.
Fixture writes now go through the test server (docs/REFACTOR.md item 30).

---

# QA pass 8 — exploratory, whole app

Exploratory testing of the whole app, 2026-10-13, on a production build and a fresh PocketBase, in Chromium (desktop
1100×720 and a 390×844 phone, light and dark), with two or three users side by side, slowed or failing requests
(Playwright routes, CDP network throttling), probes of the REST API and the custom routes, and axe on states earlier
passes didn't list (emoji picker, image viewer, selecting, editing, delete confirm, forward dialog). Numbering
continues from BUG-70. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-74 | Medium | Realtime | If the realtime connection failed as the page loaded, it was never tried again: no live messages, room list or unread counts, and nothing said so | Fixed |
| BUG-71 | Medium | Sending | Messages sent close together could land out of order: a message with an attachment ended up after the text sent just after it, for everyone | Fixed |
| BUG-76 | Medium | Sending | A message whose send failed after you had opened another room vanished: no "Not sent", and it was gone from the composer and the draft | Fixed |
| BUG-72 | Medium | Editing | Two quick edits of a message, the first slow to arrive, saved the older text: the latest edit was lost | Fixed |
| BUG-73 | Medium | Forwarding | People you share a private room with (but have no DM with) couldn't be found in the Forward dialog: "Nothing found." | Fixed |
| BUG-77 | Medium | Composer | In Safari, the Enter that confirms a word typed with an input method (Japanese, Chinese…) sent the message | Fixed |
| BUG-75 | Low | Profile | Renamed in another tab, the profile still showed the old name, and Save quietly undid the rename | Fixed |
| BUG-78 | Low (a11y) | Emoji | The picker's category headings were h3s under the room's h1 (axe: heading-order) | Fixed |

## BUG-74 — No live updates after a failed first connect (Medium)

**Steps:** open the app while the realtime request fails once (a network blip, a proxy dropping the stream), then let
it through. Bob posts in the open room. **Expected:** the message shows. **Actual:** nothing ever arrives; the room list
and unread counts stay frozen too, with no error, until a reload or opening another room.
**Cause:** `pb.ts` reported a failed *first* connect to the subscribers and then stopped, so as not to retry forever.
Nothing else tried again: the subscriptions it kept were only sent by a later `subscribe()`.
**Fix:** it reports the failure and then retries like after a lost connection. That later connect counts as a reconnect
(`realtime.recovered`), so the room list, unread counts and open room fetch what they missed.

## BUG-71 — Messages land out of order (Medium)

**Steps:** attach a 3 MB file and send it, then send a short text right away (any slow network). **Expected:** the
file's message, then the text. **Actual:** the text reached the server first, so it was saved first: the sender saw the
two swap places once sent, and everyone else got them in the wrong order. Two plain texts swapped the same way when the
first request was slow. **Cause:** every send went out at once; the server orders messages by when it saves them.
**Fix:** the room's sends go one at a time, in order (a slow upload makes the next message wait for it).

## BUG-76 — A send failing after you left the room is lost (Medium)

**Steps:** send a message, open another room before it is through, and let the request fail. Go back.
**Expected:** the message shows as not sent, with Retry. **Actual:** it is gone, and so is the text: the composer and
the saved draft were cleared on sending. **Cause:** the failure was ignored once the room's view had gone.
**Fix:** such a message is kept (`strays` in `room/controller.ts`) and the room's next view shows it as not sent, with
Retry and Discard. Its attachments come along (shown by name, as their previews went with the old view). A reload still
loses it, like unsent text before.

## BUG-72 — An older edit overwrites a newer one (Medium)

**Steps:** edit a message and save; edit it again and save before the first save is answered (slow network).
**Expected:** the second text stays. **Actual:** when the first request was the slower one, the server saved it last:
the message (for everyone, and for you once answered) showed the first edit. **Fix:** a message's edits, deletes and
reactions go one at a time (reactions already did, §20.3).

## BUG-73 — Forward can't find people you share a private room with (Medium)

**Steps:** Ada and Bob are in a private room, with no DM between them. Ada forwards a message and searches "Bob".
**Expected:** Bob, to start a DM. **Actual:** "Nothing found." **Cause:** the dialog leaves out people found by name
whom it already offers as a DM, but it took everyone in *any* room you see (private rooms list their members) for a DM
partner. **Fix:** only the other member of each DM counts.

## BUG-77 — Safari sends while you pick a word with an input method (Medium, Safari)

Not reproduced here (no WebKit locally); found by reading the key handling and checked against WebKit's known
behaviour. **Steps:** in Safari, type Japanese with the system input method and press Enter to confirm a word.
**Expected:** the word is confirmed. **Actual:** the half-written message is sent. **Cause:** the composer (and the edit
box) skip Enter while `isComposing`, but Safari ends the composition before that keydown, which then only has
`keyCode` 229. **Fix:** `composing()` checks both.

## BUG-75 and BUG-78 (Low)

- **BUG-75:** with your profile open in two tabs, renaming yourself in one left the old name in the other's field
  (the header did follow, BUG-33); pressing Save there renamed you back, saying "Saved.". The field now follows a
  rename made elsewhere, unless you are typing a new name in it.
- **BUG-78:** the emoji picker's category headings were `h3`s right under the room's `h1`. They are `h2`s.

## Checked and fine

- Sending, editing, replying, deleting, reactions and their live updates between two users; 12 messages typed as fast
  as possible keep their order; an offline send fails, keeps its text and is sent by Retry; edits and deletes made
  while offline show after reconnecting, and so do new messages.
- 420-message room: scrolling down from the first message and back up loads every page, no duplicates, at most 300
  in the DOM; a quote of the very first message jumps there and offers "Jump to latest".
- Image viewer: arrow keys through a message's images and on, stops at the end, Escape gives focus back to the
  thumbnail; attachments that aren't images show as download chips.
- New room form (leading "#"s and spaces tidied, duplicates and over-long names refused), private room with members
  added in the access dialog (live for the new member, read-only member list for them), Open Air room read by a guest,
  log in from there returns to it, signup errors (taken name and email).
- Unread counts and the tab title, rooms and DMs, while away and back; avatars (upload, refused file, remove).
- REST probes: emails can't be filtered or expanded by others; `verified`, `created`, other users' rooms and fields
  the rules guard can't be set; the custom routes refuse malformed bodies, dates and ids with 400/404 (no 500s); user
  search treats `%`, `_` and `\` as text. Odd URLs (`/#//example.com`, malformed escapes, trailing slashes) land home.
- No horizontal overflow at 390 px; axe: nothing else in the states above, light and dark.

---

# QA pass 9 — forwarding, then the rest of the app

Exploratory testing focused on forwarding (§21.3), 2026-10-13, on a production build and a fresh PocketBase, in
Chromium (desktop 1100×720 and a 390×844 phone, light and dark), with two or three users side by side, slowed or failing
forward requests (Playwright routes), and probes of `POST /api/chat/forward` and of what a forward's readers can read.
Numbering continues from BUG-78. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-80 | Medium (privacy) | Forwarding | Whoever could see a forward (a guest in an Open Air room too) could read, on its original, who reacted to it and which message it replies to, in a private room they can't see | Fixed |
| BUG-79 | Medium | Forwarding | A selected message deleted while the Forward dialog was open made the whole forward fail | Fixed |
| BUG-81 | Low | Forwarding | A refused forward or bulk delete said "Failed to forward the messages." instead of why ("A message was deleted.", "This room is archived…") | Fixed |
| BUG-82 | Low | Forwarding | A forward whose original was deleted still had Forward, which always failed | Fixed |
| BUG-83 | Low | Forwarding | The Forward dialog listed rooms as "# #name"; long names ran out of its list (and out of New message's) | Fixed |
| BUG-84 | Low (keyboard) | Selecting | After selecting messages by clicking them, Escape no longer stopped selecting | Fixed |

## BUG-80 — A forward's readers learn who is in the original's room (Medium, privacy)

**Steps:** Ada and Cy are in a private room. Cy reacts to Ada's message, which replies to an earlier one; Ada forwards
it to an Open Air room. Anyone (no account needed) reads `GET /api/collections/messages/records/<original>`, which the
view rule allows readers of the forward (§21.3). **Expected:** that message's words and attachments. **Actual:** also
its `reactions` (Cy's user id, so who is in the private room) and its `reply_to`. **Fix:** `keepToRoom` (an
`onRecordEnrich` hook) empties both in any answer to someone who can't see the message's room. It costs a room lookup
only for messages that have reactions or reply to one.

## BUG-79 — A message deleted meanwhile fails the whole forward (Medium)

**Steps:** select Bob's message and yours, press Forward; Bob deletes his; pick a room. **Expected:** yours is
forwarded. **Actual:** "Couldn't forward. Failed to forward the messages." and nothing is forwarded; the selection had
already dropped Bob's message (§21.1), but the dialog kept the ids it opened with. **Fix:** picking where to forward
leaves out messages deleted since (and forwards whose original was); when none are left, the dialog says "A message was
deleted." and sends nothing.

## BUG-81 to BUG-84 (Low)

- **BUG-81:** the forward and delete routes say what is wrong per field (`messages`, `room`, `user` for a new DM), and the
  client showed only the general message. Both failures now show the server's reason (`reasonOf` in `api.ts`).
- **BUG-82:** "The original message was deleted" forwards had Forward in their pill; the server refuses them (400).
  They keep Reply, reactions and Delete.
- **BUG-83:** rooms' titles start with "#", and the dialog put a "#" icon before them. Rooms now show their name next to
  the icon. A name too long for the list (search results here and in New message) ends in "…".
- **BUG-84:** a click on a message toggles it but left focus on the page itself (a message isn't focusable), outside
  the room, where Escape isn't heard. Focus now goes to that message's checkbox, as with Select.

## Checked and fine

- Forwarding one message from its pill and several from the selection, into another room, the same room ("Message
  forwarded."), a DM, a DM you had closed (it reopens, live for the other person too), someone found by name, and from a
  DM into a room; the selection's order kept; Back afterwards.
- Edits and deletes of the original show live in its forwards and in replies quoting them, also after a reload;
  forwarding a forward points at the original; a forward can't be edited; unread counts and the tab title count a forward
  once and never again for edits of its original.
- Forwarded images: thumbnails, and the viewer paging through them, served from the original; gone when it is deleted.
- The dialog: searching (by name, with "#", spaces only, your own name finds no one), a slow forward that can't be
  cancelled (Cancel disabled, Escape refused), a network failure shown and tried again; 390 px, dark.
- REST: forwarding into or from a room you can't see (404), deleted messages (400), archived targets (400), 51 ids that
  are the same message (one forward), bad bodies (400), anonymous (401); a forward's reader can't forward or react to
  the original by id.
- Unit, integration and Chromium e2e suites, before and after the fixes.

---

# QA pass 10 — the installable app (PWA), then the rest of the app

Exploratory testing of the PWA (§27), 2026-10-14, then of the rest of the app with a focus on what came since pass 9
(audio attachments, bigger attachments, `no_dms`, the Telegram bridge). A production build on fresh PocketBase servers,
in Chromium (desktop 1100×720 and a 390×844 phone, light and dark), with two users side by side, the network taken
offline and slowed, a simulated deploy, Chrome's own installability check, axe on every main screen, and a second server
running the bridge against the stub Bot API (`tests/support/telegram.ts`). Numbering continues from BUG-84. Each fix
lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-86 | Medium (impersonation) | Telegram | Anyone could sign up or rename themselves "Ann Lee (TG)" and pass for a Telegram person, here and in the groups; the real Ann then became "Ann Lee 2 (TG)" | Fixed |
| BUG-85 | Low | Realtime | Opening the app offline (now common: §27) or with the server down threw three unhandled "Something went wrong." errors | Fixed |
| BUG-87 | Low | Telegram | An edit that made a caption longer than Telegram's 1024 characters was refused by Telegram and lost | Fixed |
| BUG-88 | Low | Telegram | A service message (a new group photo, a timer, a topic) made a stand-in for whoever did it, a member of a linked private room | Fixed |
| BUG-89 | Low | Telegram | A group becoming a supergroup lost its room when the new group's notice came before the old one's | Fixed |
| BUG-90 | Low (accessibility) | Rooms | "This room doesn't exist." (and "You can't see this room any more.") had no heading | Fixed |
| BUG-91 | Low (security) | Telegram | The webhook secret was compared with `!==`, not in constant time | Fixed |

## BUG-86 — Anyone could pass for a Telegram person (Medium, impersonation)

**Steps:** with the bridge on, sign up as "Ann Lee (TG)"; Ann Lee writes in a linked Telegram group. **Expected:** only
Telegram people are named "… (TG)". **Actual:** the signup is accepted; Ann's stand-in becomes "Ann Lee 2 (TG)", and
what the impostor writes goes to the group as "**Ann Lee (TG)**". **Fix:** while the bridge is on, a users create or
update request naming someone "… (TG)" (compared as names are: case, full-width forms, spaces) is refused with "Names
ending in (TG) are for people on Telegram." under the name field, on the signup form and the profile alike. Superusers
are not held to it, and a name already taken is kept (only a change is checked).

## BUG-85 — Unhandled errors when the first connect fails (Low)

**Steps:** open the installed app (or a tab) offline, or with the server down. **Expected:** "Couldn't load rooms" with
Retry, and nothing else. **Actual:** that, plus three uncaught `PbError: Something went wrong.` in the console (one
each from the room view, the room list and the unread counts). **Cause:** `api.onConnect()` subscribes to
`PB_CONNECT`, which rejects when the first connect fails (QA BUG-74), and only caught that when unsubscribing.
**Fix:** it catches it at once; the realtime client goes on trying, and the app recovers by itself once online (checked).

## BUG-87 to BUG-91 (Low)

- **BUG-87:** a message with files is sent with its text as their caption when it fits, but an edit could make it longer.
  The edit's caption is now cut to 1024 characters, ending in "…".
- **BUG-88:** `bringOver` made the sender's stand-in (and a member of a private room) before finding there was nothing
  to bring over. It now returns first.
- **BUG-89:** Telegram tells of a migration in both groups. Only the old group's notice moved the link, and not when
  the new group had been heard from first (its own, unused link was in the way). Either notice now moves it, an unused
  link in the way is replaced, and messages queued for the old id follow.
- **BUG-90:** the not-found and gone pages are a heading and a line of links, so a screen reader's heading list finds
  them as it finds a room's name.
- **BUG-91:** `$security.equal`, as for the invite code (§24.2).

## Checked and fine

- **PWA:** Chrome finds no installability errors and parses the manifest; the site title names the app; every icon
  loads with its type. Logged in and offline, a reload keeps the session and shows the shell; back online, rooms,
  the open room and live messages return without Retry. A simulated deploy: the next load takes the new build, the old
  build's assets leave the cache, and the new one opens offline. The API, the admin UI, `/_` (redirected), odd paths
  and the manifest pass through untouched. Every phone screen has its own way back (an installed iOS app has no back
  button).
- **Audio:** plays on through a reaction and an edit of its message, stops once the message is deleted; a file
  request refused mid-play (an expired token) gets a new token and carries on from the same time.
- **Attachments:** 10 files at most (the 11th says so), over 20 MB refused by name, "+6" on the fourth tile, the viewer
  paging through all ten.
- axe (WCAG 2.1 AA) on the guest home, login, signup, home, a room, the emoji picker, the room menu and the profile, light
  and dark, desktop and phone: nothing; no horizontal overflow at 390 px.
- Telegram: a wrong secret (401), text with HTML in it, a stand-in posting in a private room (a member, as designed).
- Unit, integration and Chromium e2e suites, before and after the fixes.

Not verified: on a notched iPhone in landscape, the app bar and room list have no side safe-area padding
(`viewport-fit=cover`), so their edges may sit under the notch. Chromium can't show it.

---

# QA pass 11 — the room cache, prefetching and opening at the first unread message

Exploratory testing of what came since pass 10 (§7.5 room cache, its prefetching, §18.5 opening at the first unread
message), 2026-10-14, then a sweep of the rest. A production build on a fresh PocketBase server, in Chromium (desktop
1100×720 and a 390×844 phone), with two users side by side, several tabs of one browser, held and slowed requests,
rapid room switching, a user switch in another tab, the rate limiter turned on, and up to 320 rooms with unread
messages. Numbering continues from BUG-91. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-93 | Medium | Unread | Loading the app straight into a room (a reload, a restored tab, a link) opened it at the bottom and took every unread message as read | Fixed |
| BUG-94 | Medium | Prefetching | With many rooms unread at login, prefetching used up the per-IP request limit: rooms opened meanwhile said "Couldn't load this room. Check your connection." | Fixed |
| BUG-95 | Medium (privacy) | Room cache | A message deleted while you were in another room showed its full text again when you opened the room, until the first page was in | Fixed |
| BUG-92 | Low | Prefetching | While any room got a message at least once a second, no room was ever prefetched | Fixed |
| BUG-96 | Low | Room cache | Scrolled to the bottom of a kept window that opened at the "New" line, the first page pulled you back up to the line | Fixed |

## BUG-93 — A reload skipped the unread messages (Medium)

**Steps:** Bob reads a room and closes the tab; Ada writes 80 messages; Bob opens the room's address (or reloads it,
or the browser restores the tab). **Expected:** the room opens at the first of the 80, under the "New" line (§18.5).
**Actual:** it opened at the bottom, with no line, and the read went out at once: 60 of the 80 were never on screen and
the room showed nothing unread. **Cause:** the room only asks where its unread messages start when the store has a
count for it, and just after a page load the counts aren't in yet. **Fix:** the store's `unread` starts as
`UNCOUNTED`; while it is, a logged-in room view asks the server. That is one more request before the first page on
such a load (as for any room opened with a badge).

## BUG-94 — Prefetching used up the rate limit (Medium)

**Steps:** with the rate limiter on, log in as someone with 320 rooms with unread messages, and open rooms from the list.
**Expected:** they open. **Actual:** prefetching fetched all 320 back to back; 46 requests were refused with 429, and
9 of 15 rooms opened meanwhile showed "Couldn't load this room. Check your connection." PocketBase's limit for
`/api/` is per IP (300 per 10 s), so it is shared with everyone behind the same address. **Fix:** rooms are fetched 250 ms
apart (at most 40 per 10 s), and a refused fetch ends the run; the rest is fetched when their counts next go up.

## BUG-95 — The cache showed deleted messages (Medium, privacy)

**Steps:** Bob is in another room; Ada writes "my password is hunter2" in a room Bob has kept (or that was prefetched
for him), then deletes it; Bob opens that room on a slow network. **Expected:** "Message deleted" (a deleted message
must never show its text, §7.5). **Actual:** the text, until the first page replaced the window. **Fix:** prefetching
also follows message deletes (the unread service's text-free events, §18.3) and refetches the room, so the cache holds
it deleted. A delete made while the app was closed still shows until the first page is in: nothing could tell it.

## BUG-92 and BUG-96 (Low)

- **BUG-92:** each count going up restarted prefetching's one-second wait, for every room together, so a room with a
  message every 600 ms kept every room from being fetched (none was kept in 8 s). The wait now starts with the first
  count and isn't restarted; messages meanwhile join the run, and a busy room is fetched about once a second.
- **BUG-96:** the first page scrolled a stale window to the first unread message whenever it was at the bottom, which is
  where you were if you had scrolled down to read. It now stays where it is; a kept window shown at the bottom with
  nothing unread still follows to the newest message.

## Checked and fine

- **Opening at the first unread message:** 120 unread under 70 read lands on the first, a quarter of the way down,
  and nothing is read until the bottom is on screen; then older and newer history load with no duplicates. With 1 or 3
  unread (also on a phone) everything is on screen and read at once. 99+ badges.
- **Room cache:** sending, a live message and a delete while the kept window shows; rapid switching through 8 rooms 3
  times (no message of another room shown, every room right afterwards); a guest's cache cleared at login; a user
  switched in another tab (nothing of the previous user kept, the tab follows); a deleted message's text never kept.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not fixed: a room's first load that fails for any reason (also 429 or 500) says "Check your connection", as the room
list does; with BUG-94 fixed it is rare. A message edited while you were away shows its old text until the first page
is in (the cache is "as it was last time"; edits can't be told from reactions in the text-free events).

---

# QA pass 12 — the room cache without waiting, service messages and the Telegram bridge

Exploratory testing of what changed on 2026-10-15 (the room cache shown without waiting for the network, §7.5, §18.5;
service messages, §5.3) and of the Telegram bridge (§26) in a browser, then a sweep. A production build on a fresh
PocketBase server with the bridge on against the stub Bot API (updates delivered to the webhook as Telegram does), in
Chromium (desktop 1100×720 and a 390×844 phone): every API request held or slowed, private rooms losing a member,
archived rooms, Telegram albums, edits, replies, oversize files and HTML in names, and a randomized run of two users
(one on a phone) sending, editing, deleting, reacting, switching rooms and reloading with 0–250 ms on every request,
then each client's view compared with the server. Numbering continues from BUG-96. Each fix lands with a test that fails
without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-100 | Medium | Room cache | A message sent (or edited) while a kept window showed vanished from your screen when the first page came | Fixed |
| BUG-98 | Medium (privacy) | Room cache | A room you lost access to showed its kept messages again on every load, until the server said no | Fixed |
| BUG-99 | Low | Room cache | Opening a room right after its badge went up put the "New" line on a message already read, then jumped | Fixed |
| BUG-97 | Low | Room cache | A room left (reload, tab closed) within a second of its last change wasn't kept, or was kept without that change | Fixed |

## BUG-100 — A message sent while the kept window showed vanished (Medium)

**Steps:** open a room that shows from the cache on a slow network, and send a message before its first page is in.
**Expected:** the message stays. **Actual:** it went from the list when the page came, though the server had it (a
reload showed it); an edit made meanwhile went back to the old text. Found by the randomized run (Ada's own edited
message missing from her view). **Cause:** the first page replaces the window and was asked for before the send; only
pending sends were carried over. The realtime echo puts a message back when it comes, but not when it was created
before the room's subscription was set up, and the catch-up fetch for that runs only when the subscription is set up
after the page. **Fix:** the newer copies of messages in the page's range (and after it, at the live edge) are kept over
the page's.

## BUG-98 — A room you lost access to kept showing from the cache (Medium, privacy)

**Steps:** Bob reads a private room; Ada takes him out of it; Bob reloads the room (or opens it from history).
**Expected:** "You can't see this room any more", and its messages not shown again. **Actual:** its kept messages and
name showed until the server answered, on every load. Came with showing the cache before the room list is in (the room
record is kept with it). **Fix:** a room that turns out not to be there, or that leaves the loaded room list, is saved
empty. What was kept shows at most once, for a moment, after access is lost while the app is closed.

## BUG-97, BUG-99 (Low)

- **BUG-97:** the window is saved a second after it last changed, so reloading, closing the tab or following a link
  sooner lost it (a room seen for the first time wasn't kept at all). It is now also saved on `pagehide`.
- **BUG-99:** with the counts in, the first unread message is worked out from the kept window, which was wrong when it
  hadn't been prefetched with that count (opened within the second before prefetching runs, or prefetching refused):
  the "New" line showed over a message already read until the server's answer moved it. Prefetching now saves the count
  it fetched for, and the kept window opens at the line only when that count is still the room's.

## Checked and fine

- **Service messages:** a centred line with no buttons, not selectable; reply, reaction, forward, delete, edit and a
  made-up one refused by the API; shown live to a private room's members only, and counted unread only for them.
- **Telegram bridge in the app:** an album of 4 photos as one message with its caption, a 47.7 MB file as a line of
  text, an edit and a reply from Telegram, a stand-in joining a private room; out to Telegram: names and text with
  `<b>` and `&amp;` escaped, a reply, an edit, a delete and a forward.
- **Layout:** a 1500-character word, a 520-character link, bidi overrides, 200 emoji and 40 lines on desktop and
  phone: nothing wider than the screen, long names cut short. Drafts survive a reload.
- **Randomized run** (120 steps each): before the fix, seed 3 found BUG-100 (seeds 2 and 4 were clean); after it, seeds 3 and 12 were consistent with the server in every room for both users.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not fixed: just after a reload, a kept room's record stands in until the room list is in, so a room archived meanwhile
shows its composer for that moment, and a message sent then fails with **Retry**. The sidebar lists only the kept room
until the room list is in.

---

# QA pass 13 — the room cache after the room-switching speedups

Exploratory testing of the room cache (§7.5) after 2026-10-15's changes (rooms not yet kept prefetched once the room
list is in, the cache held in memory too, the first page winning ties over kept copies), 2026-10-16. A production
build on a fresh PocketBase server, in Chromium (desktop 1100×720 and a 390×844 phone): two and three users, several
tabs of one browser, logouts and user switches, private rooms losing members, archived rooms, DMs, attachments,
every message request held or slowed (0–400 ms jitter), offline, back/forward cache, the rate limiter on with 80
rooms unread and 110 rooms in all, and a randomized run (Ada by API sending, editing, deleting and reacting in five
rooms; Bob in the browser switching, reloading, going back and sending, 0–250 ms per request), Bob's room compared
with the server after every step. Each scenario records every message text ever drawn, so a flash of the wrong text
counts. Numbering continues from BUG-100. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-101 | Medium (privacy) | Room cache | A private room you lost access to while the app was open, but weren't in, kept its messages: the next load straight into it showed them until the server said no | Fixed |
| BUG-102 | Medium | Unread | Reloading into a room whose kept window held its unread messages (prefetched) marked all of them read, though only the newest were on screen | Fixed |
| BUG-103 | Low | Room cache | After a reload, an author's new avatar or name never showed in a kept room: the kept copies beat the page's (and were kept again) | Fixed |
| BUG-104 | Low | Room cache | Leaving the page (a reload, a link, closing the tab) within a second of a room's last change often didn't keep it: the BUG-97 save on `pagehide` didn't reach IndexedDB | Fixed |

## BUG-101 — A room you lost access to stayed in the cache (Medium, privacy)

**Steps:** Bob is in a private room's member list and has it kept (opened earlier, or prefetched); he is in another
room when Ada takes him out; later he reloads straight into the room (a bookmark, a restored tab). **Expected:**
"You can't see this room any more", and nothing of it. **Actual:** its messages showed until the server answered.
BUG-98 saved a room empty only when it was the open one; with prefetching of rooms not yet kept, most kept rooms are
never opened. **Fix:** any room that leaves the loaded room list while the app is open is saved empty
(`forgetGone`, cache.ts), for guests too.

## BUG-102 — A reload into a prefetched room read what was never on screen (Medium)

**Steps:** Bob is in the lobby; Ada writes 80 messages in a room, which is prefetched for him; Bob reloads straight
into that room. **Expected:** it opens at the first of the 80 under the "New" line, and they stay unread until he
reaches the bottom (§18.5, as BUG-93). **Actual:** the line was right, but all 80 were read: before the counts are
in, the kept window shows at the bottom, and what shows at the bottom counts as read. **Fix:** while a kept window
shows at the bottom before the server has said where the unread messages start (`unsure`), nothing counts as read;
with nothing unread, it is read as soon as the server says so.

## BUG-103 and BUG-104 (Low)

- **BUG-103:** the first page's copy of a message replaced a kept one only when it was newer (`updated`), so a kept
  room never picked up an author's new avatar or name, and kept the old one again. Found by avatar.spec.ts under
  load. Of the same age, the page's copy now wins; copies changed meanwhile (BUG-100) still stay.
- **BUG-104:** the window saved on `pagehide` (BUG-97, which had only a unit test) was put in a transaction made
  after a promise, and left to commit when the page next ran; when it was going, that often never came. Seen 3 times
  in exploratory runs and then not for ~70 tries alone, but a new e2e test failed 10 of 20 times at 4 workers (with
  IndexedDB calls logged: the put was made, and neither completed nor aborted). The transaction is now made at once
  once the database is open, and committed explicitly: 0 of 12 and 2 of 24 lost in the same setup. A write made as
  the page goes can still be lost under load; the room is then kept as it was a second earlier, or not at all.
  **2026-10-28:** still about 1 in 10 at 4 workers (the put made, the database open, the transaction never completed
  as the page went). What is kept after `pagehide` is now also written to `localStorage`, which is synchronous, and
  the next page moves it to IndexedDB (taken once; dropped on `pageshow` and by `clear()`): 60 of 60.

## Checked and fine

- **Sessions:** logging out and another user logging in in the same tab, a user switch or a logout in another tab, a
  guest logging in: nothing of the previous user drawn, ever, and nothing of theirs kept.
- **Cached rooms:** rapid switching through 8 rooms 40 times with jitter (never another room's message); sending,
  replying, editing, deleting, deleting several, reacting, jumping to the beginning, scrolling into history and
  following a quote while the kept window shows; a message deleted while away (prefetched or warm-up kept) never
  shows its text; a deleted message can't be forwarded from a stale window; the "New" line opened before and after
  prefetching; DMs; images of a kept window after a reload; an archived room opened from the cache has no composer;
  two tabs of one user; back/forward cache; rate limiter on with prefetching (no 429, every room opened loads).
- **Randomized run** (seeds 1, 3, 5 on desktop, 2 and 6 on a phone; 40–60 steps each): Bob's room matched the server
  after every step, no page errors.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not changed, by design: a room whose first
load fails (offline) shows the error and **Retry**, not its kept window. A message edited (or reacted to) while you
were away still shows as kept until the first page is in.

# QA pass 14 — thumbnails kept by the service worker, then the rest of the app

Exploratory testing after attachment thumbnails began to be kept by the service worker (§27.2), 2026-10-17. A
production build on a fresh PocketBase server, in Chromium (desktop 1100×720 and a 390×844 phone, light and dark),
**with the service worker on**, as users have it (the e2e suite blocks it outside `pwa.spec.ts`). Server requests
were counted from PocketBase's request log. Covered: room switches, reloads and token rotation (2 min+), logout and
the next user in the same tab, a logout while thumbnails load, offline, the viewer, forwards and their deleted
originals; API edge cases (blank, invisible, over-long and control-character text, duplicate ids, someone else's
edit, parallel reactions, odd file names, 11 files, empty files, room and display names, bulk delete and forward
limits); UI edge cases (a reply whose message is deleted before sending, over-long text, 11 files, a room archived
or access lost while typing); a screenshot sweep of every page; randomized runs (seeds 11, 21 and 23 on desktop, 12
on a phone, with images); and the whole e2e suite run again with the service worker allowed. Numbering continues
from BUG-104. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-106 | Low | Unread | Under load, a room's badge (and the tab's total) could show one unread message more than there was, until the room was opened | Fixed |
| BUG-107 | Low | Room list | A room you had just created, or a DM just opened, vanished from the list for a moment when a room list reload (a page load, a reconnect) answered before its live event came; a room just hidden showed again | Fixed |
| BUG-108 | Medium (performance) | Prefetching | While a public room is busy, every online user who has it unread refetches its latest page about once a second: 20 idle tabs made each fetch take ~2 s | Fixed (2026-10-29) |
| BUG-105 | Low | Messages | Control characters (NUL, bell, terminal escape codes from pasted output) were kept in message text: shown as nothing or boxes, and refused by Telegram | Fixed |

## BUG-106 — One unread message too many (Low)

**Steps:** Bob is in one room; Ada sends 25 messages to another while Bob's counts are being fetched (a page load, a
reconnect, coming back to the tab). **Expected:** "25 unread". **Actual:** "26 unread", 1 in 10 runs of
`unread.spec.ts` at 6 workers. The counts' answer (taken at `at`) and the live events race: a message counted by
the answer could be added again, either because its event came after the answer (SSE behind the HTTP response) or
because it was created just after `at` but committed before the count ran (and `created > at` was the client's test
for "not counted"). Comparing times can't settle it: a message is committed some time after its `created`.
**Fix:** `GET /api/chat/unread` also returns `ids`, the messages of the last 30 s it accounts for, from the same SQL
statement (one snapshot) as the counts; the client adds a live message only when it isn't among them. 0 of 60 at 6
workers after.

## BUG-107 — A room just created or DM just opened vanished for a moment (Low)

**Steps:** open a DM (or create a room, or hide one) while the room list is reloading: right after a page load, or
after a reconnect. **Expected:** it stays listed. **Actual:** when the reload's answer (taken before) came back
before the room's live event, the room left the list until that event came; a room just hidden showed again. Found
by `people.test.ts`, which failed now and then in full unit runs: the DM it had just opened wasn't in the store. The
reload replayed the live events received meanwhile on its answer (BUG-69), but what the tab itself put in the store
(`actions.ts`) isn't an event. **Fix:** while a reload is out, `sync.ts` notes every room, and every hidden row,
that changes in the store, whatever changed it; the answer takes those from the store as it is then, or leaves them
out if gone from it (the list of events is gone). Comparing only the store before and after wasn't enough: a room
added and then taken away meanwhile (§23.4) came back with the answer, which `access.test.ts` caught.

## BUG-108 — Busy rooms are prefetched by everyone, every second (Medium, performance; fixed 2026-10-29)

**Steps:** ~20 users online with a public room unread but not open; someone writes in it every second or so.
**Actual:** each of their tabs fetches the room's latest page (50 messages, authors expanded) once per message
burst (`DELAY_MS`, 1 s): ~20 page requests per second for one room, each taking ~2 s instead of ~10 ms (seen in an
e2e trace, where tabs leaked by earlier tests did exactly this). It grows with users × busy rooms, and every user who
can see a public room is a candidate. **Not changed yet:** the fix trades the room cache's freshness for load, so it
needs a decision. Options: refetch a room at most every 30–60 s while it stays unread (the first unread message is
still fetched at once); or only at its first unread message, and again when the pointer rests on it in the list.
**Fix (2026-10-29, the owner chose the first):** a room fetched less than `REFETCH_MS` (30 s) ago waits until then,
and is fetched then if still unread; the count going up from none, and a deleted message (BUG-95), still fetch it at
once. A room opened before its kept page caught up opens from the network (its kept count no longer holds, §18.5).
Tests: `prefetch.test.ts` "QA BUG-108" (the first fails without the fix). `app.js` budget 47.35 → 47.40 KB.

## BUG-105 — Control characters in messages (Low)

**Steps:** paste text holding control characters (terminal output with colour codes, a stray NUL) and send it.
**Actual:** kept as is: shown as nothing or as boxes, and Telegram refuses such text, so the bridge couldn't pass
the message on. Names were already cleaned (BUG-38). **Fix:** message text keeps tabs and line breaks (CR LF, a lone
CR and U+2028/2029 become `\n`) and loses every other control character, on create and edit.

## Checked and fine

- **Thumbnails (§27.2):** each fetched once; then none from the server on switching back, reloading, or after the
  file token changed (130 s); the next user in the same tab fetches their own, and never gets the previous user's
  (kept per user, and the cache is deleted on logout, also during loading); a forward's images for someone outside
  the original's room, from the cache after a reload, and gone once the original is deleted; the viewer.
- **API edges:** blank, invisible-only and over-long text refused (2000 code points, emoji included); a message id
  can't be reused; someone else's edit is a 404; an edit to the same text isn't an edit; parallel reactions all
  land; only offered emoji react; `../` and bidi overrides leave file names; 10 files at most; names unique across
  case, width (NFKC) and invisible characters; a bulk delete of someone else's message changes nothing.
- **UI edges:** a reply whose message is deleted before sending is sent as a plain message; over-long text shows
  "N over" and can't be sent; the 11th file is refused with a reason; a room archived while typing hides the
  composer and keeps the text for when it's back; losing a private room while typing shows "You can't see this room
  any more" and nothing of it.
- **Randomized runs** (desktop seeds 11, 21, 23; phone seed 12; 60 steps, Ada sending images 30% of the time): the
  room matched the server after every step, every image on screen loaded, no page errors.
- **The e2e suite with the service worker allowed:** all pass but BUG-106 and two specs that `route()` requests the
  worker makes itself (a thumbnail held, the viewer's stylesheet held), which is why the suite blocks it.
- Typecheck, lint, unit (645, twice) and integration (336) suites pass; the Chromium e2e suite passes in full at 1, 2
  (twice) and 4 workers (55/55), in ~2.7 min at 2 workers instead of ~4.4 (see the e2e change below). Before that
  change, 1–2 specs timed out in most full runs at 2 workers, a different one each time.

Not changed, by design: offline, a reload shows the shell and "Couldn't load this room" with Retry (§7.5), not the
kept window. A thumbnail kept by the worker outlives the message's deletion on that device, until the logout or
until 1000 newer ones push it out; nothing asks for it (a deleted message is never drawn).

Test changes:
- `replies.spec.ts` is marked slow. It takes ~9 s alone (two axe scans) and went over 30 s with the rest of the
  suite running, in several local full runs since 2026-10-12.
- The contexts `openRoom()` makes are closed after each test, by an automatic fixture of the `test` that
  `tests/e2e/fixtures.ts` now exports (specs import `test` from there). They lived as long as the worker's browser: by
  the end of a run each worker had ~20 earlier users online, all fetching a busy room's page on each of its messages
  (BUG-108), so later specs timed out. It is the likely cause of the "load flakes" in local full runs since 2026-10-12.
- `prefetch.test.ts` only hears its own rooms' message events. A message deleted by another test file in a public
  room meanwhile fetched that room too, one `page` call more than the tests count (3 of 6 full unit runs).

# QA pass 15 — search, link previews, who can post, then the rest of the app

Exploratory testing after message search (§29), link previews (§28), who can post (§23.6) and the viewer's "Show in
chat", 2026-10-18. A production build on a fresh PocketBase server with link previews **on** (a stub web site let
through `LINK_PREVIEWS_ALLOW_HOSTS`), in Chromium (desktop 1100×720 and a 390×844 phone, with and without the service
worker). Covered: the REST API around the new fields (filters through a forward's original, search escaping and case
folding against the server's, writers' rules, preview SSRF guards and odd pages); the search bar (paging, picking a
result 150 back, guests, archived rooms, room switches, keyboard); previews live, after an edit, on a forward and when
its original changes; a reader made a writer and back while typing, editing and sending; the viewer's "Show in chat"
from images paged in; the preview worker under sites that never answer (5 minutes of cron); and randomized runs
(seeds 31, 32 on desktop, 33 on a phone with the service worker; 50 steps each, now also changing who can post,
sending links and searching). Numbering continues from BUG-108. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-109 | Medium | Messages | At the bottom of a room, the newest message slid under the composer when it grew: a reaction, an edit, and now every link's preview lines | Fixed |
| BUG-111 | Medium (performance) | Link previews | A pass over sites that never answer outlived the worker's lock, so a second worker fetched the same links alongside; and one message's dead links held up everyone's previews for minutes | Fixed |
| BUG-110 | Low | Link previews | A page's title kept control and bidi characters: terminal codes showed as boxes, and "‮" turned the rest of the title around | Fixed |
| BUG-112 | Low | Search | `\` wasn't escaped: `\%` found messages starting with `\`, `\_` found "a_b", `\\` any backslash | Fixed |
| BUG-113 | Low | Search | "istanbul" didn't find "İstanbul" (lowercased, "İ" is "i" and a combining dot) | Fixed |
| BUG-114 | Low | Search | Two "×" side by side in the search field: the browser's own clear button (`type=search`) and Close | Fixed |
| BUG-115 | Low | Search | Search's styles for its results leaked to the people search sharing the class names: the forward dialog's list was cut at 45% of the screen, and the new-DM search got a scroll box of its own | Fixed |

## BUG-109 — The newest message slid under the composer (Medium)

**Steps:** at the bottom of a room, someone reacts to the last message, edits it longer, or sends a link (its preview
lines come a second later). **Expected:** the list stays at the bottom. **Actual:** the message grew below the screen:
31 px for a reaction, 116 for an edit, 21 per preview line, hidden under the composer until you scrolled. Every message
with a link does this since §28. The controller asked for an anchored render for every change in place, which keeps
what is on screen in place, right for someone scrolled up but not at the live end. The view's `ResizeObserver` only
watches the list's own size (the tray opening, BUG-31), not its content. **Fix:** a change in place (realtime update or
delete, the refresh after a reconnect, your own edit, delete or reaction) scrolls to the bottom when the list is near
it and there is no newer page; scrolled up, it stays anchored. New messages keep their own rules (not followed while
the tab is away).

## BUG-111 — Sites that never answer stalled the preview worker (Medium, performance)

**Steps:** send a dozen messages, each linking to five pages of a site that never answers (or any slow one), then one
ordinary link. **Actual:** each link waits out the 4 s timeout, so the worker spent ~20 s a message; the ordinary link
had no preview after 4½ minutes. The lock is renewed only between passes (10 messages) and taken as stale after 120 s,
so from the third minute a second worker ran the same queue alongside (15 duplicate fetches in a minute), and a third
could follow. Anyone can do this with links to sites they control. **Fix:** the lock is renewed after every message; a
host that doesn't answer isn't asked again for that message (one timeout, not five); and a message's links get 12 s at
most. The queue then moves at least every ~20 s whatever is linked.

## BUG-110 — Control and bidi characters in preview titles (Low)

**Steps:** link a page whose `<title>` holds a bell, terminal colour codes, or a right-to-left override (as `&#7;`,
`&#27;`, `&#x202E;`). **Actual:** kept as is: boxes in the line, and "‮desrever" shown as "reversed", so a page could
make its title read as something else. Message text has been cleaned since BUG-105, names since BUG-38; titles are
anyone's text too. **Fix:** titles go through `tidy`, as names do.

## BUG-112 — The search's escape character wasn't escaped (Low)

**Steps:** search `\%` in a room with "a\%b". **Actual:** "No messages found." (it found messages starting with `\`);
`\_` also found "a_b", and `\\` every message with one backslash. PocketBase's `~` treats `\` as the escape character
of `LIKE`, and only `%` was escaped. **Fix:** `\` is escaped too.

## BUG-113 — "istanbul" didn't find "İstanbul" (Low)

Lowercased, "İ" (U+0130) is "i" followed by a combining dot above, so the stored key was "i̇stanbul", which "istanbul"
as typed (on any keyboard) never matched; only "İstanbul" typed with a capital İ found it. **Fix:** the search key drops
that dot, on the client and the server (`searchKey`); migration `1760000025_search_dotted_i.js` re-keys messages already
stored. Names keep `nameKey` as it is.

## BUG-114 and BUG-115 (Low)

- **BUG-114:** the field was `type=search`, so Chromium and Safari drew their own clear "×" right next to Close, one
  clearing the field, the other closing the bar. It is a text field with `role=searchbox` now: the same to a screen
  reader, and the phone keyboard keeps its Search key (`enterkeyhint`).
- **BUG-115:** the search bar's `.search-results` and `.search-status` styles (§29) use the class names of the people
  search (room-list.css) and came later in the stylesheet, so they applied there too: the forward dialog's list was cut
  at 45vh (324 px on a 720 px screen) and the new-DM search had a scroll box of its own. They apply only inside
  `.room-search` now.

## Checked and fine

- **Filters and forwards:** a list filter through a forward's original (`forward_of.reply_to.text`,
  `forward_of.room.members`, `forward_of.reactions`, `forward_of.room.name`) matches nothing for someone outside the
  original's room: PocketBase applies the related collection's list rule inside the filter. Expanding `forward_of.reply_to`
  shows nothing either.
- **Search:** `%` and `_` literal; client and server fold the same way on Greek final sigma, ß, ligatures, full-width
  and half-width forms, Roman numerals and titlecase digraphs (each sample finds itself); the worst NFKC growth is ×18
  (U+FDFA), so `text_key` (40,000) holds any 2,000-character message; 6 words and a 3,000-character word; guests in Open
  Air rooms; archived rooms; a room switch closes the bar; "Show older results" moves focus to the first of them.
- **Who can post:** a reader can't post, reply, edit, delete (also in bulk) or forward in, but reacts; only the creator
  sets writers, never on create, and never in a DM; a non-member writer of a room made private is dropped; the composer
  goes and comes back live with what was typed; an open edit box closes; a send held while posting changed fails with
  Retry; the room isn't offered as a forward target.
- **Previews:** live for everyone; an edit clears them at once and the new ones come; a forward shows its original's and
  follows its edits; each link once, 5 at most; untitled pages and PDFs get no line; `javascript:` icons and icons
  served as HTML are left out (the site's /favicon.ico instead); local, private and link-local addresses are refused;
  an edit box stays open (with what was typed) while previews or reactions arrive.
- **Show in chat:** from an image paged in three back, goes to its message and focuses its tile.
- **Randomized runs** (seeds 31, 32 desktop, 33 phone with the service worker): the room matched the server after every
  step, the composer matched who may post, no page errors.
- Typecheck, lint, unit, integration and Chromium e2e suites, before and after the fixes.

Not changed, by design or for a decision:
- A link that redirects to a private address is still followed (§28.1 says so: the JSVM can't resolve names or stop
  redirects); with a redirect to the chat server itself, the title "Chat" came back.
- Previews' icons are kept in each message as `data:` URLs (up to 16 KB each, 5 a message), so a page of 50 messages
  full of links can be ~1–2 MB of JSON, and as much in the room cache. Serving icons as files would need a decision.
- Search doesn't ignore accents ("cafe" doesn't find "café"); §29 never said it would.
- A send refused because you may no longer post says "Not sent." with Retry, like any refusal; the reader's banner
  above says why.
- BUG-108 (busy rooms prefetched by everyone) is still open.

# QA pass 16 — the media grid, message permalinks, then the rest of the app

Exploratory testing after the media grid (§30) and timestamp permalinks, 2026-10-21. A production build on a fresh
PocketBase server, in Chromium (desktop 1100×720 and a 390×844 phone, light and dark, with and without the service
worker). Covered: the grid with forwards, deleted messages, PDFs, 230 messages over five months (paging, month headings,
order within a message), the viewer over it (stepping, Escape, Back, "Show in chat" 180 messages back), guests in Open
Air rooms, failing pages (offline, 500), losing access or logging out elsewhere while it is open, double clicks and
double Backs; permalinks clicked, pasted (other rooms' ids, deleted, junk, 300 characters), opened by guests and
non-members, while selecting, with Ctrl, with a draft typed, on unread rooms; and randomized runs (seeds 41 desktop, 42
phone, 43 with the service worker; 50 steps each, now also clicking times and opening the grid). Numbering continues
from BUG-115. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-117 | Medium | Sessions | A reload or a click to another page while the session was being renewed (on every page load) could log you out: about 1 page load in 6 in quick succession | Fixed |
| BUG-116 | Medium (performance) | Media grid | A page of the grid that failed was asked for again at once, ~60 times a second, until it loaded or the grid closed | Fixed |
| BUG-118 | Low | Media grid | After a reload with the grid open, or Forward after Back closed it, Back seemed to do nothing once | Fixed |

## BUG-117 — A page change while the session was renewed logged you out (Medium)

**Steps:** logged in, load a page and go to another one (a reload, a link, a typed URL) within a moment. **Actual:**
in 2 of 12 tries the next page came up as a guest: a private room said "This room doesn't exist.", and the session was
gone for good (`pocketbase_auth` held `{}`). The app renews the session on every start (`renew()`, QA BUG-45). When the
page went away while the answer was arriving, its body never came, and `pb.ts` took a body it couldn't read as `{}`,
so the renewal "succeeded" with no token and saved that: `JSON.stringify({ token: undefined, record: undefined })` is
`{}`. A connection dropping mid-answer did the same, and any other request then "succeeded" with nothing in it.
**Fix:** a success (2xx but 204) whose body can't be read fails with status 0, like any network trouble; a 204, or an
error with no explanation, still reads as `{}`. 0 of 24 tries since.

## BUG-116 — A failed page of the grid was asked for again and again (Medium, performance)

**Steps:** open Media while offline, or while the server answers 500 (or 429, when rate limited). **Actual:** 173
requests in 3 s, the status line flickering between "Loading…" and "Couldn't load media. Retry". After each page the
grid observes its end again (a page with few media leaves it in view), and an `IntersectionObserver` reports what it
starts observing at once, so a failure asked again straight away. The unit test's fake observer doesn't report on
`observe()`, so it never saw it. **Fix:** a failure stops observing until Retry.

## BUG-118 — A media grid entry with no grid on it (Low)

Like the viewer (§17.7), the grid adds a history entry with the same URL, so Back closes it. After a reload while it
was open, or Forward after Back closed it, that entry was still there with no grid: one Back did nothing visible. The
router has passed over such viewer entries since §17.7, not the grid's. **Fix:** the router passes over a grid entry
when no grid is open. The grid closing from itself keeps its (closed) dialog in the page until its own Back has landed,
or the router went Back a second time after "Show in chat" and left the room: caught by `media.spec.ts`.

## Checked and fine

- **Media grid:** forwards show their original's images (as the forwarder's, like the viewer); deleted messages and
  PDFs give no tiles; 159 images from 230 messages over five months all come, once each, newest first, a message's
  files last to first, one heading per month across pages; the viewer from the oldest tile counts "1 / 159"; "Show in
  chat" 180 messages back loads and highlights the message and leaves no dialog or history entry; Escape from the
  viewer comes back to the grid with focus on the tile; a double click opens one grid; losing access or logging out in
  another tab closes the grid and the viewer over it; a guest in an Open Air room sees tiles, authors and the viewer;
  dark mode.
- **Permalinks:** clicking a time goes to `/r/:id/m/:msgId` with the message highlighted, the draft kept and new
  messages still live; Back returns to the room; an old message's link loads history around it and scrolling down
  reaches the newest; a deleted message's link opens at its "Message deleted" place; another room's message id, junk
  and 300-character ids show the latest messages and "That message isn't in this room."; a non-member of a private room gets "This room doesn't exist." and
  nothing of it; a guest's link to a members-only room asks to log in and comes back to the message after; while
  selecting, a click on a time selects; Ctrl+click opens a new tab; a sending message's time isn't a link until it is
  sent; a link to an old message leaves the room's unread count alone until you scroll to the end.
- **Randomized runs** (seeds 41, 42 phone, 43 service worker before the fixes; 44, 45 phone, 46 service worker after):
  the room matched the server after every step, no page errors.
- Typecheck, unit and integration suites before the fixes; `npm run check` and the Chromium e2e suite (62/62) after;
  the e2e suite with the service worker allowed (60/62: `attachments.spec.ts:96` and `:177` route() what the service
  worker fetches itself, as in pass 14).

Not changed, by design or for a decision:
- The grid's video tiles load their metadata (`preload=metadata`, first frame) as soon as they are drawn, not lazily
  like images: a page of 50 messages with ten videos each fetches 500 at once. The room's list does the same.
- After losing access to a room with the viewer open over the grid, one Back stays on the "You can't see this room any
  more." page: it is the room's own entry, same URL.
- BUG-108 (busy rooms prefetched by everyone) is still open.

# QA pass 17 — video posters, then the whole app

Exploratory testing after video posters in the room (§17.5, §30.1), 2026-10-21. A production build on a fresh PocketBase
server with ffmpeg, in Chromium (320, 390, 768 and 1100 px wide, light and dark, with and without the service worker),
plus probes of the API. Covered: posters for MP4, WebM, portrait and landscape videos, a "video" that is a playlist, a
private room's video forwarded to a public one, guests in Open Air rooms, the grid and the viewer over them; a layout
sweep of every page and dialog at four widths in both themes (horizontal overflow, screenshots); sign up, log in,
names, passwords and avatars; composing, editing, replying and drafts; dialogs and modes left open while someone else
changes what they show; going offline and back; one user in two tabs; and randomized runs. Numbering continues from
BUG-118. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-119 | Medium | Sending | A message shown as "Not sent." was gone, with what was written in it, after visiting another room and coming back | Fixed |
| BUG-120 | Medium (privacy) | Viewer | The viewer kept showing (and stepping to) the images of a message deleted while it was open | Fixed |
| BUG-121 | Low | Reactions | The reaction picker stayed open on a message deleted meanwhile, and a pick failed without a word | Fixed |
| BUG-122 | Low | Profile | An avatar that only looks like an image (a renamed file) was refused with PocketBase's message and the stored file name | Fixed |
| BUG-123 | Low | Room | A room that failed to load while offline didn't load by itself once back online if realtime had stayed connected | Fixed |

## BUG-119 — A message not sent was lost on leaving the room (Medium)

**Steps:** offline (or with the server unreachable), send a message: it shows "Not sent. Retry Discard". Back online,
open another room, then come back. **Actual:** the message was gone, and with it the text: the composer and its draft
were cleared when it was sent. Only a send that failed *after* the room had been left was kept for the room's next
view (QA BUG-76); one the view showed as failed went with the view. **Fix:** the view's failed sends are kept the same
way when it goes; the next view shows them with Retry (its attachments by name).

## BUG-120 — The viewer kept a deleted message's images (Medium, privacy)

**Steps:** open an image in the viewer; its author deletes the message. **Actual:** the image stayed, "2 / 2" and
all, and the arrows still stepped to it, while the room showed "Message deleted"; Download gave a 404. Losing access
closes the viewer (pass 16), a delete didn't. **Fix:** the room view passes every update of its messages on to the
viewer, which drops the images of a message that no longer has them (deleted, or a forward whose original was). The
one shown gives way to the next, else the one before; none left, the viewer closes and leaves its history entry.

## BUG-121, BUG-122, BUG-123 (Low)

- **BUG-121:** with the reaction picker open on a message that was then deleted, the picker stayed; picking sent a
  reaction the server refused (400), and the error had nowhere to show (a deleted message has no reactions). **Fix:**
  the picker closes when the message it reacts to is deleted or leaves the list; the composer's picker is left alone.
- **BUG-122:** a file named `photo.png` that isn't an image passes the type check (the browser goes by its name) and
  the server refused it with `"photo_ht448j1ab2.png" mime type must be one of: image/jpeg, …`. **Fix:** that refusal
  says "Choose a JPEG, PNG, WebP or GIF image.", like a wrong type picked.
- **BUG-123:** a room opened while offline says "Couldn't load this room." with Retry. It loaded again by itself only
  on a realtime reconnect; with the browser's offline mode (DevTools, Playwright), or a short outage the event stream
  survives, nothing reconnects, and it stayed so. **Fix:** the browser's `online` event also retries a failed load.

## Checked and fine

- **Video posters:** a video's poster 404s until the worker has made it, then is a JPEG for MP4, WebM and portrait
  videos; a "video" that is an M3U playlist gets none and its tile says "Couldn't load video" with Retry; the poster of
  a PNG, of a path with `../`, without a token in a members' room, or for someone outside a private room: 404; a
  forward's readers get the original's poster, and it is gone once the original is deleted; a guest in an Open Air room
  gets posters without a token; the grid shows no `<video>`; the viewer plays the video.
- **Layout:** no horizontal overflow on any page or dialog at 320, 390, 768 and 1100 px in either theme, with a 400
  character URL, a 500 character word, mixed Arabic and Hebrew text, twelve reactions, long names and file names.
- **Accounts:** a blank name is refused; names are trimmed; an email in another case is "already an account"; logging
  in with another case and spaces around it works; a name over 32 code points is refused before asking; bidi controls
  are stripped from names; a wrong, short or unchanged password is said next to its field; a password change logs other
  sessions out and keeps this one; a 3000×3000 PNG avatar is shrunk and saved; room names blank, over 48, duplicate in
  another case or HTML are handled.
- **Composing:** Up edits your last message; an unchanged or whitespace-only edit isn't marked edited; an edit box closes
  when its message is deleted elsewhere; a reply whose original is deleted before sending goes without its quote (§19);
  drafts survive Back and reload and go once sent; invisible-only text isn't sent; 2,000 characters (also emoji) send.
- **Dialogs and modes:** a selection drops a message deleted elsewhere; forwarding to a room archived meanwhile says
  "This room is archived and read-only."; archiving a room while typing keeps the text for when it is unarchived.
- **API:** `/api/chat/media` with negative, huge, non-numeric limits and junk cursors; reads in the future or garbage;
  forwarding into or out of rooms you can't see; bulk-deleting others' messages; reactions outside the picker's set.
- **Two tabs:** a send shows once in the other; reading in one clears the other's badge; logging out in one logs out
  the other; logging in as someone else there follows.
- **Randomized runs** (seeds 51 desktop, 52 phone, 53 with the service worker; 50 steps each): the room matched the
  server after every step, no page errors.

Not changed, by design or for a decision:
- An edit that failed ("Couldn't save your edit. Retry") is forgotten on leaving the room: the message still shows
  what it said, so nothing looks sent that wasn't.
- Messages deleted while the media grid is open keep their tiles until it is opened again (§30.1: not live); opening
  one says "Couldn't load image." with Retry.
- A name change shows in your other tabs at once, on your other devices on their next load.
- `app.js` went from 43.76 KB to 43.90 KB with these fixes; its budget was raised to 43.91 KB (§13).
- BUG-108 (busy rooms prefetched by everyone) is still open.

# QA pass 18 — media collections

Exploratory testing of media collections (§31), 2026-10-21, after they shipped. A production build on a fresh PocketBase
server with ffmpeg, in Chromium (375, 390 touch and 1100 px wide, light and dark), as owners, followers, people with no
collections and guests, plus probes of the API beyond `collections.test.ts`. Covered: making, renaming, making public
or private and deleting collections; saving from tiles, the viewer and another collection's page, and making one from
the save menu; removing items; following, "new" counts, seen; the picker, attaching, a failed send and Retry, badges
(public, yours private, someone else's private, gone, on a forward); 131 items paged; a video item; long names; two
tabs; keyboard and touch. Numbering continues from BUG-123. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-124 | Medium | Collections | The save menu, the picker and the new-collection dialog were unstyled (browser defaults: thick black border, checkboxes stretched across the row), and a page's tile buttons (Save, Remove) never showed, not even focused | Fixed |
| BUG-125 | Medium | Collections | Someone with no collections and following none waited 2 s for a collection's page every time | Fixed |
| BUG-126 | Medium | Collections | A collection's page didn't follow changes: an item added meanwhile didn't show, and the sidebar said "1 new" for the page you were looking at; renamed, made private or deleted, the page stayed as it was (a follower was offered Subscribe, which failed) | Fixed |
| BUG-127 | Low | Collections | Renaming showed the name as typed (spaces and all) rather than as saved; a refused one said "Failed to save record." and closed the form; any change in the store redrew the actions, closing an open rename form or delete confirmation and dropping focus | Fixed |
| BUG-128 | Low | Collections | Removing items left an empty month heading, an empty collection said nothing, focus fell to the page, and the delete confirmation said "its 1 items" or "its 0 items" | Fixed |
| BUG-129 | Low | Collections | Guests didn't see whose a public collection is (the owner was looked up by the users list rule, signed-in only) | Fixed |
| BUG-130 | Medium | Mobile | On a narrow screen a collection's page had no way back to the rooms but the browser's Back | Fixed |
| BUG-131 | Low | Viewer | The viewer over a collection called every item's author "Unknown" | Fixed |
| BUG-132 | Low | Composer | The picker opened for a message that already has 10 files took no picks and said nothing | Fixed |
| BUG-133 | Low | API | `POST /api/chat/subs` took `on: "false"` or `on: 0` for true and subscribed | Fixed |

## BUG-124 — The collection dialogs were unstyled, and a page's tile buttons hidden (Medium)

`web/styles/collections.css` ended its `.coll-cell:hover .att-save, …, .coll-cell:focus-within` selector list straight
into the dialog rule's comment and selector (an edit that lost the `.coll-remove { opacity: 1 }` rule in between). So
`dialog.coll-dialog` got no rule of its own: the dialogs had the browser's look, and app.css's `input { width: 100% }`
stretched their checkboxes. And since nothing set `opacity: 1` on a page's Save and Remove buttons, they stayed
invisible on hover and on keyboard focus (a stray `.coll-remove { opacity: 1 }` above was overridden). **Fix:** the
rules restored; checkboxes and the name field in the dialogs are sized for their row.

## BUG-125 — A 2 s wait on a collection's page (Medium)

The page waits for the store's collections (your `seen_at` decides what is new) when it opens just after a reload. It
took "none of yours, none followed" for "not loaded yet", so for someone without any it always waited the full 2 s.
**Fix:** `chunkContext().list()` is null until loaded, and the page waits only then.

## BUG-126 — A collection's page didn't follow changes (Medium)

The page drew the collection once. **Fix:** it follows the store (§31.3): an item added meanwhile comes in at the top
(`items(…, newer)`, a cursor after the newest shown; more than a page: drawn again), marked new and seen at once (in a
microtask: not while the store is telling its listeners), so the sidebar has no badge for it; a rename or a change of
Public shows; gone from the list, it is asked for again, and a 404 says it doesn't exist.

## BUG-127, BUG-128, BUG-129, BUG-130, BUG-131, BUG-132, BUG-133 (Low, BUG-130 Medium)

- **BUG-127:** the page now shows the name and Public as the server saved them, a refused change gives the server's
  reason ("You already have a collection with this name.") and keeps the form, and the actions are only drawn again
  when what they offer changes, with focus kept on the same one.
- **BUG-128:** a month heading goes with its last item, an empty collection says "Nothing here yet.", focus moves to the
  next item's Remove (or the actions), and the delete confirmation counts items properly ("Delete “Pets”?" for none).
- **BUG-129:** the page reads the owner's name with the collection (`expand=owner`, which the users view rule lets
  anyone read), not with a users list request.
- **BUG-130:** the page has "← Rooms" on narrow screens, as a room has.
- **BUG-131:** the viewer's caption is "Added <date>" for an item (a message with no author), not "Unknown · <date>".
- **BUG-132:** the picker says "The message has all the files it can take." when it can take none.
- **BUG-133:** `on` must be a boolean when given (400 otherwise).

## Checked and fine

- **API:** names blank, spaces, 60 and 61 characters, control and bidi characters, HTML, 60 emoji; the same name in
  another case on rename; `name_key`, `items`, `owner` from a body; saving to someone else's public (403) or private
  (404) collection, an item of someone else's private one, the same file twice whichever way (409); `/saved` with
  nothing or with someone else's private item (`{}`); removing as someone else or a guest; writing items through the
  records API; attaching the same item twice (one file), 10 files and an item, items as a string, into a room you
  can't post in, as a guest; an edit naming items or `file_sources`; seen with junk, zero, past and future dates; 60
  badge ids (50 answered); a deleted collection leaves its followers' lists; a private collection's items listed by a
  guest (none).
- **Browser:** the new-collection dialog's blank and duplicate names and Escape; saving, unticking and making one from
  the save menu (ticked at once); 131 items paged by scrolling, no duplicates, one month heading; the viewer's arrows
  and a video item's poster and playback; badges for a public, your own private, someone else's private and a deleted
  collection, and on a forward; a pending message's item thumbnails and Retry; switching collections and Back; long
  names in the sidebar, badge and heading; two tabs; Save and Remove shown on touch screens; dark theme.
- Typecheck, lint, unit (654) and integration (407) suites and the Chromium e2e suite (67/67) after the fixes. JS
  budgets: `app.js` 45.96 of 46.05 KB (unchanged), the collections chunk 5.71 of 6 KB.

Not changed, by design or for a decision:
- A collection that turned private stays followed (§31.1): its follower can't unsubscribe until it is public again.
- The picker doesn't mark the items already in the tray; picking one again adds nothing.
- An item removed in another tab keeps its tile on an open page until it is opened again; opening it fails to load.

---

# QA pass 19 — Jump to, Appearance, the tab title, then the whole app

Exploratory testing of the features added since pass 18: Jump to (§32), the Appearance switch (§7.8) and the room name
in the tab title (§22.4), 2026-10-23. A production build on a fresh PocketBase server, in Chromium (390 and 1000–1100 px
wide, the system light or dark under each Appearance choice), as members, DM partners and guests, plus four randomized
runs (desktop and phone, with and without the service worker; switching, reloads, Back, permalinks, the media grid,
sends and now Jump to, checked against the server after every step: no mismatch, no page error). Numbering continues
from BUG-133. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-134 | Medium | Jump to | With nothing typed, rooms came newest-created first, whatever you had been doing: only DMs carry a latest-message time. Ctrl+K Enter went to the newest room, not back to where you were | Fixed |
| BUG-135 | Medium | Layout | A page taller than the window (the profile since Appearance, a long collection) scrolled the whole layout: the sidebar slid away with it and left an empty strip | Fixed |
| BUG-136 | Low | Jump to | Left open in another tab, Jump to kept listing the last user's rooms after logging out (or into another account) | Fixed |
| BUG-137 | Low | Jump to | Holding Ctrl+K opened and closed the dialog on every key repeat | Fixed |
| BUG-138 | Low | Jump to | An emoji in what you typed never matched by letters in order ("🍕z" didn't find "🍕 pizza") | Fixed |
| BUG-139 | Low | Jump to | With more than 50 rooms, the room you are in (listed last) was the one cut off; the e2e test failed on a busy server | Fixed |

## BUG-134 — Jump to's "most recent first" wasn't (Medium)

**Steps:** in a few rooms with messages, open one, then another; press Ctrl+K.
**Expected:** the room you came from first (§32: Ctrl+K Enter goes back).
**Actual:** the rooms in the order they were created, newest first; Ctrl+K Enter opened a room you hadn't been in.
**Cause:** the order went by `last_message_at`, which only DMs have (a hook sets it, §16); a room fell back to its
`created`. The unit tests gave every room a `last_message_at`, so they passed.
**Fix:** `app.ts` notes when each room and collection was last open (the page entered and the page left, since the
first may have opened before it listened), and Jump to sorts by the later of that and the room's own time. In memory
only, forgotten when the session changes.

## BUG-135 — The sidebar scrolled away with a tall page (Medium)

**Steps:** at a window under ~930 px high, open your profile (or a collection with many items) and scroll down.
**Expected:** the page scrolls; the sidebar stays.
**Actual:** `.app-main` scrolled, sidebar and all: the room list slid up and its background ended mid-window.
**Fix:** `.pane` scrolls on its own (`overflow-y: auto`). The room view was always the pane's height, so nothing else
changes; a collection's pages still load as you scroll (130 of 130 items, wide and narrow).

## BUG-136, BUG-137, BUG-138, BUG-139 (Low)

- **BUG-136:** the dialog closes when the user changes (by id: a rename keeps it), and the last-open times are
  forgotten.
- **BUG-137:** a repeated keydown is ignored (still prevented, so the browser's search bar doesn't open either).
- **BUG-138:** the letters of a query are split by code point, as the name is read.
- **BUG-139:** with nothing typed, the others are cut to make room for where you are. Found by `switcher.spec.ts` in
  a full e2e run (70 rooms by then), not alone.

## Checked and fine

- **Jump to:** from the composer, a menu, selection mode, the forward and new-room dialogs, the media grid, the viewer
  and message search (each left behind or closed, and Back right after); a DM by the partner's name; hidden and
  archived rooms only when typed, opening into a working room; collections; the room you are in (no new history
  entry); IME composition Enter (doesn't go); a pointer resting where the list opens doesn't choose; Escape, the
  shortcut again, focus back to the composer; a room created while it is open (found when typed); phone width; guests;
  a draft kept across jumps; axe in both themes, empty and with results.
- **Appearance:** each choice under a light and a dark system, across the room, Jump to, the media grid, a collection;
  another tab follows; arrow keys between the choices with a visible focus ring; `theme-color` follows; no CSP report
  for the inline script; axe on the profile in both themes.
- **Tab title:** room, DM, after a rename (live), after losing access to a private room, on the profile and a
  collection (site title), unread count in front.
- Typecheck, lint, unit (674), integration (407) and the Chromium e2e suite (71) after the fixes; in one full run the
  viewer specs at attachments.spec.ts:456 and :493 timed out waiting for an upload under load, and passed 8/8 alone.

Not changed, by design or for a decision:
- A DM partner's rename shows in the DM's name (sidebar, header, tab title, Jump to) only after a reload, as before
  Jump to; user records aren't followed live.
- The tab title on a collection's page is the site's title alone (§22.4 names only rooms).
- `app.js` is 47.03 KB gzipped (+0.08 KB from these fixes); the budgets were then raised (§13): JS 47.10 KB, CSS 7.10 KB, collections chunk 6.65 KB.

---

# Security audit — external report, 2026-10-23

An outside security review of the server (hooks, migrations), the web client and the scripts at the commit "Pasting
into collection", with reproducers against the pinned PocketBase 0.40.4 (report CHAT-01…CHAT-11). Each finding was
checked against the code, then fixed with a test that fails without the fix. Numbering continues from BUG-139.

| # | Report | Severity | Area | Summary | Status |
|---|---|---|---|---|---|
| BUG-140 | CHAT-01 | High | Collections | An image uploaded into a collection skipped the 25-megapixel check (BUG-24): a 65-byte PNG declaring 30 000×30 000 was taken, and its thumbnail would need gigabytes | Fixed |
| BUG-141 | CHAT-02 | Medium | Push | UnifiedPush delivery followed redirects (`$http.send`), so a registered endpoint could send the server's POST to 127.0.0.1, 169.254.169.254 or the intranet | Fixed |
| BUG-142 | CHAT-03 | Medium | Telegram | "Ann (TG)\u0001" passed the "(TG)" name guard (BUG-86) and was stored as "Ann (TG)": the guard checked the name before it was tidied | Fixed |
| BUG-143 | CHAT-04 | Medium | HTTP | The 32 MB body limit went by `Content-Length`: a chunked body (none) was read up to 201 MB on our own routes and logins, guests' too | Fixed |
| BUG-144 | CHAT-05 | Low | Unread | `GET /api/chat/unread`, the heaviest read, had only the `/api/` rate limit | Fixed |
| BUG-145 | CHAT-06 | Low | Session | A session that ran out while the app was closed was never ended: its drafts, kept rooms and thumbnails stayed (web); on Android a guest saw its rooms and DMs until the list loaded | Fixed |
| BUG-146 | CHAT-07 | Low | Router | `/#//host` crashed the app at start: replaceState refused `//host` as another site's URL | Fixed |
| BUG-147 | CHAT-08 | Low | Telegram | Worker races: an album item delivered twice lost the whole album; a pass over 90 s let a second run take the lock and send the same rows again, and the first run's unlock removed the second's lock | Fixed |
| BUG-148 | CHAT-09 | Info | Collections | `GET /api/chat/saved?item=` for an item that isn't there or can't be seen listed every collection holding an upload of yours | Fixed |
| BUG-149 | CHAT-10 | Info | Collections | An uploaded item's name kept bidi overrides and its full length, unlike attachment names | Fixed |
| BUG-150 | — | Info | Messages | Comments said `:isset` misses field modifiers (`author+`); on 0.40.4 it sees them. The update hook didn't back up the rule for `author` and `room` | Fixed |
| — | CHAT-11 | Info | Collections | `/api/chat/badges` tells a private collection from a missing one | Not changed |

## BUG-140 — Image bombs in collections (High)

**Steps:** `POST /api/chat/items` multipart `{ collection, file }` with a PNG whose header declares 30 000×30 000.
**Expected:** 400, as for an attachment or an avatar. **Actual:** 200; the media worker (or any `?thumb=`) decodes it whole.
**Cause:** collections (§31) came after BUG-24's `assertImagesFit`, and only messages and avatars called it.
**Fix:** a `collection_items` create hook calls it for every upload (a saved copy has none: its file was checked where
it came from). Test: `images.limit.test.ts`, PNG/GIF/JPEG/WebP into a collection, and a 25 MP one still taken.

## BUG-141 — UnifiedPush followed redirects (Medium)

**Cause:** the endpoint's host was checked as a string, then `$http.send` connected (resolving again) and followed any
redirect. **Fix:** delivery goes through the link previews' fetcher (`previews.js` `post`): getent, every address
public, curl pinned to the checked one with `--connect-to`, no redirects. A redirect is answered as its status
(logged). Test: `push.test.ts`, an endpoint answering 307 to another path; nothing reaches it.

## BUG-143 — Chunked bodies past the 32 MB limit (Medium)

**Cause:** `lib/http.js` compared `Content-Length` (−1 for chunked); PocketBase's records API counts its own limit, so
only our routes and the auth routes were open. **Fix:** the middleware runs PocketBase's own limiter at 32 MB (it
counts what is read) for everything but a message create. Chunked bodies aren't refused: the Android app sends one
for a collection upload whose size it can't tell. Test: `messages.files.test.ts`, 40 MB chunked to
`/api/chat/reads` and to a login → 413, a small chunked one → 200.

## BUG-145 — An expired session's leftovers (Low)

**Fix:** `api.forgetExpired()` at start: a stored session that ran out is forgotten and the drafts, room cache and
`chat-files` of its user cleared (web, `app.test.ts`). The Android app had it worse — `rooms.loadSaved()` showed the
expired user's rooms to the guest — and gets the same (`ChatApi.forgetExpired`, `ServicesTest`). The report's second
point (drafts not cleared when someone else logs in) is the same bug: the store's user is only null there after such
a start.

## BUG-147 — Telegram worker races (Low)

**Fix:** `bringOver` drops repeated message ids; the lock carries its run's id, is renewed after every album and send,
and is let go only by its run (a run that lost it stops at its next item); each send is claimed in a transaction
(`locked_until`, 10 min) before it goes, so no two passes send one row. Tests: an album item delivered twice; a
claimed row isn't sent until its claim runs out. Not changed: the webhook still brings over a chat's earlier albums
when a later message comes (a single message's files are downloaded there too): that is what keeps a group's
messages in order.

## BUG-142, BUG-144, BUG-146, BUG-148, BUG-149, BUG-150

- **BUG-142:** the guard checks `nameKey(tidy(name))`, the name as stored. Test: C0/C1 controls, ZWSP, RLO after "(TG)".
- **BUG-144:** `GET /api/chat/unread` 120 per 60 s per IP, as reads (migration `1760000031_unread_limit.js`).
- **BUG-146:** `here()` makes any run of leading slashes or backslashes one. Test: `router.test.ts` (it threw
  `SecurityError` before).
- **BUG-148:** `{}` when the item isn't one you may see.
- **BUG-149:** the name is cleaned with `tidy`, `unescapeUploadName` and `clipFileName`, as attachments' are.
- **BUG-150:** comments in `messages.js`, `rooms.js` and DESIGN.md §16/§19 corrected; `beforeMessageUpdate` refuses a
  change of `author` or `room`, superusers included. Test: `messages.edit.test.ts`.

## Not changed

- **CHAT-11:** `/api/chat/badges` answers `{ private: true }` for a private collection and `null` for a missing one.
  That difference is what the room shows ("Private collection", or no badge), and the ids it reveals are in every
  message's `file_sources` already; 15 random characters can't be enumerated.

---

# QA pass 20 — the web app and the Android app, after the audit fixes

Exploratory testing of both clients on 2026-10-24, after room list folding and unread-first (§7.1, ANDROID.md §20),
the Android app's notifications by WorkManager (ANDROID.md §21) and the security audit's fixes. The web: a production
build on a fresh PocketBase, in Chromium (390 and 1100 px wide, light and dark), four randomized runs (desktop and
phone, with and without the service worker), a fuzz of every custom route (odd bodies, types, ids, queries; with and
without a session), races (both sides opening one DM, six people reacting at once, an edit racing a delete), axe on a
folded list. Android: the JVM suites, and by hand on the emulator (Android 9) against a seeded server, notifications
included. Numbering continues from BUG-150. Each fix lands with a test that fails without it.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-151 | Low | Session (web) | Signed out elsewhere (a password change) within 30 s of this tab's last session check, a refused send was never followed by a check: the tab kept looking signed in, every send "Not sent" | Fixed |
| BUG-152 | Low | Jump to (Android) | The rooms "you just had open" were remembered for the whole process: the next person on the phone, or another account on the same server, got them first (the web's BUG-136, not ported) | Fixed |
| BUG-153 | Medium | Notifications (Android) | A check that failed part way (offline) had already saved what it found as seen: those DMs and replies were never notified | Fixed |
| BUG-154 | Low | Notifications (Android) | A notification showed the time of the check, up to 15 minutes after the message | Fixed |
| BUG-155 | Medium | Viewer (Android) | The viewer kept the images of a message deleted while it was open (the web's BUG-120, privacy) | Fixed |
| BUG-156 | Low | Room (Android) | A message's menu or reaction picker stayed open on a message deleted meanwhile; what it offered was then refused (the web's BUG-121) | Fixed |
| BUG-157 | Medium | Unread (Android) | A message that came while the app was in the background stayed unread after coming back to it, on screen, in the room: on the list, the web, every device | Fixed |
| BUG-158 | Medium | Session (Android) | A success that wasn't the server's answer (a captive portal's or a proxy's page) read as `{}`: a renewal then threw outside any handler, which ends the app, and lists came back empty (the web's BUG-117) | Fixed |
| BUG-159 | Low | Jump to (Android) | Holding Ctrl+K on a hardware keyboard opened and closed Jump to on every key repeat (the web's BUG-137) | Fixed |
| BUG-160 | Medium | Cache (Android) | A private room you were taken out of stayed kept on the device, and showed its messages when opened from a link or a notification until the server refused (the web's BUG-101, privacy) | Fixed |

## BUG-151 — A refused send just after a session check (Low)

**Steps:** open a room (the session is checked at start); within 30 s, change the password on another device; send.
**Expected:** the login screen (BUG-51). **Actual:** "Not sent", and the tab stayed so until another refusal came
30 s after the check, or the tab came back after 5 minutes. **Cause:** `onRejected` checks at most every 30 s, and a
refusal sooner than that was dropped, not put off. **Fix:** it is checked once the 30 s are up (`app.test.ts`, fake
timers). A revoked tab's open event stream gets nothing meanwhile (checked: a private room's new message didn't reach
it).

## BUG-153 — A notification check that failed part way (Medium)

**Steps:** a DM comes; the check runs, and the network goes while it fetches the read positions (or a room).
**Expected:** the next check notifies it. **Actual:** never notified: the check had saved the messages it found as
seen before going on. **Fix:** `NotifyCheck` saves its state once it is through. A room that can't be fetched for
being offline fails the check (WorkManager tries again); only one refused (gone, or no longer yours) is skipped.
`NotifyCheckTest` fails the requests in between.

## BUG-155 — The Android viewer kept a deleted message's images (Medium, privacy)

The web's BUG-120, never ported: the room viewer loaded its images once. **Fix:** it follows the room's messages; a
message deleted (or a forward whose original was) takes its images and videos with it, the next shows (or the one
before), none left closes it. Checked live on the emulator too ("3 of 3" became "2 of 2" on the image before).

## BUG-157 — Background messages stayed unread on Android (Medium)

**Steps:** in a room on the phone, go to the home screen; someone writes there; come back within a minute.
**Expected:** the message, read. **Actual:** the message, on screen, and a badge on the room for good (here, on the
web and every device), since the server never got the read. **Cause:** realtime stays up for a while in the background
(ANDROID.md §9.1), so the message came while the app was away and wasn't read; coming back changed neither of the
things the room reported reads on (the list's rows, being at the bottom). **Fix:** coming back reports again
(`UiFeaturesTest`). The web reads such messages on coming back already (checked).

## BUG-158 — Android read a page that wasn't the server's answer as an empty one (Medium)

**Steps:** the server's address answers 200 with a page of its own (a Wi-Fi sign-in page, a misconfigured proxy, a site
serving its index for every path). **Actual:** `PbClient` took a body it couldn't parse as `{}`. A list request then
"succeeded" with nothing in it; the session renewal at start read `record` from it and threw a `NullPointerException`,
which `checkSession` (catching only `ApiError`) let out of a coroutine in the app's scope, where it ends the app.
**Fix:** as the web's BUG-117: a success other than 204 without a JSON body fails with status 0, like network trouble;
`checkSession` ends the session only on a refusal and leaves it as it is on anything else. Test: `ChatApiTest`.

## BUG-160 — Android kept a room you were taken out of (Medium, privacy)

The web's BUG-101, never ported: only the open room was saved empty on losing access (BUG-98's port); a room kept by
prefetching or an earlier visit kept its messages on the device, and showed them when opened from a link or a
notification until the server's answer. **Fix:** a room that leaves the loaded room list while the app runs is kept
empty (`ChatServices`, as `forgetGone`). Test: `ServicesTest`.

## BUG-152, BUG-154, BUG-156, BUG-159 (Low)

- **BUG-152:** one `RecentlyOpened` per account (`ChatServices.opened`), cleared when the session changes.
- **BUG-154:** the notification's message carries its own time (`UiNotifyTest`).
- **BUG-156:** the room closes a message's menu and reaction picker when the message is deleted or leaves the list.
- **BUG-159:** a repeated key press is ignored (`UiPortsTest` presses Ctrl+K with a repeat count).

The Android ports (BUG-152, BUG-155, BUG-156, BUG-158, BUG-159, BUG-160) were found by going through every web fix
since the app was built (BUG-109 on) for the ones it lacked.

## Checked and fine

- **Folding and unread first (web):** a room getting a message moves first; folded, a section lists its unread rooms
  and the open one, a new one appears, a read one leaves; the choice survives a reload; focus stays on the heading
  when folding by keyboard; DMs and collections fold too; phone width; axe in both themes with every section folded.
- **Session (web):** an expired stored session at start is forgotten with its drafts (BUG-145); a garbled stored
  session; `/#//host` (BUG-146); a password change elsewhere logs the other browser out once 30 s have passed.
- **Media grid and viewer history (web):** every sequence of open, a tile, Escape or Back, the arrows, at both widths
  with the service worker: each layer closes in turn (the randomized run's "still open" was the viewer's ArrowLeft
  leaving the viewer open, so Escape closed only it).
- **Routes:** no 5xx and nothing private for odd bodies (empty, `null`, arrays, broken JSON), odd values (huge
  numbers, 5 000 characters, NUL, filter syntax, `%`, ids of rooms one can't see), long and odd queries, with no
  session, a garbled one, or someone else's; `/assets/../` stays in its folder.
- **Races:** both people opening their DM at once (×10) get one DM; six people reacting at once count right; an edit
  and a delete at once end deleted.
- **Android on the emulator:** the notifications of ANDROID.md §22.1; attaching through the system picker; a new
  profile picture through it; a draft across a rotation; the room filled in after the background, and a DM started
  meanwhile listed with its badge.
- **Regressions:** pass 19's Jump to and theme scripts, axe on the profile and Jump to.
- After the fixes: typecheck, lint, unit (678), integration (415) and the Chromium e2e suite (71); Android: 76 JVM tests
  in `:core:data` and 39 in `:app` (twice in a row), lint, the release APK 3.14 MB of 6 MB. `app.js` is 47.24 of 47.25 KB:
  no budget was raised.

Not changed, by design or for a decision:
- Unread first moves a room you open back to its place by name at once, and new messages reorder the list under the
  pointer.
- Folded sections are kept per browser, not per person.
- Under a "Yesterday" divider, message times still carry their date (the web's `formatTime`, matched by the app).

---

# QA pass 21 — the Android app

Exploratory testing of the Android app on 2026-10-25: by hand on the emulator (Android 9, ANDROID.md §18.1) against
the seeded server (rooms, the viewer, downloads, search, the soft keyboard, an audio file that can't play, the network
dropped and back, a cold start after the process was killed), the JVM suites, and a read through the app's code against
the web's. No web fix since the last sweep (BUG-150) was left unported. Numbering continues from BUG-160. Each fix lands
with a test that fails without it, except where noted.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-161 | Medium | Files (Android 8–9) | Download (a file chip, the viewer's button) did nothing: the shared Downloads folder needs the storage permission before Android 10, the download manager refused, and the refusal was swallowed | Fixed (by hand on the emulator) |
| BUG-162 | Medium | Unread | A read that failed on its way (the network back a moment after the message showed) was never sent again while the room on screen didn't change: the room stayed unread on the server, so on every device | Fixed |
| BUG-163 | Medium | Room | Going to a message (a search result, a quote, the first unread one) could leave it off the top of the list when the messages after it were tall; a first unread message off screen was then read unseen. The keyboard also stayed up after picking a search result | Fixed |
| BUG-164 | Medium | Attachments (Android 8) | Photos sent from Android 8 and 8.1 arrived sideways: their EXIF orientation was ignored, then dropped by re-encoding (profile pictures too) | Fixed |
| BUG-165 | Low | Audio | An audio file that failed to play once (offline, an expired file token) could never play in that room again: Play restarted the same broken player | Fixed (by hand on the emulator) |
| BUG-166 | Low | Accounts | A sign-in or renewal answered with JSON that wasn't a session (another site, a proxy) threw outside any handler while the idle accounts were renewed at launch, ending the app | Fixed |
| BUG-167 | Low | Profile | A picture that couldn't be read (gone from its provider, permission taken back) ended the app | Fixed (by reading: the picker can't be driven) |
| BUG-168 | Low | Room | A link or a notification to the room already open left no room active once the old screen closed: messages arriving in the room on screen counted as unread, its notification wasn't taken away | Fixed |
| BUG-169 | Low | Room | The "New" line faded out after leaving the list, drawn across the first unread message's text for 0.7 s | Fixed (seen on the emulator; no test) |
| BUG-170 | Low | Collections | A collection followed (from another device) just after the app read the list, before its live subscription was in, never showed until the next reconnect | Fixed |

## BUG-161 — Downloads did nothing on Android 8 and 9 (Medium)

**Steps:** on Android 9, open an image in the viewer and tap Download (or tap a file in a room). **Expected:** the
file downloads. **Actual:** nothing, not even a message; the log has `SecurityException: No permission to write to
/storage/emulated/0/Download/…: Neither user … nor current process has android.permission.WRITE_EXTERNAL_STORAGE`.
**Fix:** one `download()` for the room and the viewer: before Android 10 the file goes to the app's own Downloads
folder, which needs no permission (the download's notification opens it); a toast says it started, or that it couldn't.

## BUG-162 — A read that failed was never sent again (Medium)

**Steps:** a room open at its bottom; the network drops; a message comes as it returns. **Expected:** read, once on
screen. **Actual:** shown, but unread on the server, the room list, the web and every device; the server's log had no
read at all. **Cause:** the reader's request failed (the network not quite back), and a failed read was only retried
with the next report of what is on screen, which nothing brought since the screen didn't change (the web's `unread.ts`
works the same way, and relies on a reconnect's gap fill re-rendering). **Fix:** the reader sends it again by itself,
after 2 s and then doubling up to a minute, until it is in or refused (`ServicesTest` fails the first request).

## BUG-163 — The message gone to was off screen (Medium)

**Steps:** search a room for a message followed by images (or long messages), pick it. **Expected:** the message, in
view, highlighted. **Actual:** the two messages after it, the message itself above the top. The list put the row two
below the target at its bottom; tall rows (and the keyboard, still up) pushed the target out. The room opens at the
first unread message the same way, and with reading only what is on screen (DESIGN.md §18.3) a first unread message
off the top counted as read. **Fix:** the target's bottom edge goes to the bottom, then the list is raised a quarter of
its height as far as the target stays whole; picking a result also puts the keyboard away (`UiFeaturesTest`).

## BUG-164 — Photos from Android 8 arrived sideways (Medium)

Before Android 9 images are decoded with `BitmapFactory`, which ignores EXIF; re-encoding them (to drop the GPS
location, §15.3) then dropped the orientation too. **Fix:** turned upright from the EXIF orientation before re-encoding,
as `ImageDecoder` does on 9+ (`ImagePrepTest`, all on the old path).

## BUG-165 to BUG-170 (Low)

- **BUG-165:** the second tap logged `start called in state 0` and error -38. A failed player is now released, and the
  next tap prepares a new one with a fresh file token (checked on the emulator: a new prepare, not -38). Not a crash:
  first thought to be one from the code, `start()` in the error state reports an error instead of throwing.
- **BUG-166:** `ChatApi.auth` reads a session or fails with status 0; the idle accounts' renewal ends a session only
  when it is refused (`ChatApiTest`: `{"status":"ok"}`, a list, a token that isn't a string).
- **BUG-167:** "Couldn't read that image." instead.
- **BUG-168:** the new screen of the room opens before the old one goes; the old one's close cleared the active room.
  The services keep the open room screens in order (`ServicesTest`).
- **BUG-169:** the line now fades in its own place in its last 0.7 s, then goes.
- **BUG-170:** found by `CollectionsTest` failing in full runs (the follow came while the subscription was on its
  way). Once subscribed, the list is read once more, as the room catches up after its subscription (QA BUG-61). A new
  `CollectionsTest` holds the subscription back 1.5 s. The web's `collections.ts` had the same gap: fixed the same way
  on 2026-10-28 (`tests/component/collections.test.ts`).

## Checked and fine

- Sending, the soft keyboard's Enter (a new line; only a hardware keyboard's sends), search, the viewer and its
  counter, a message missed while the network was down (shown once it was back), a cold start after the process was
  killed (signed in, the room list, the badges).
- After the fixes: 84 JVM tests in `:core:data` and 46 in `:app`, three full runs in a row; lint without errors; the
  release APK 2.99 MB of 6 MB.
- The UI harness's `openRoom` uses the row's click action: scrolled to from below, a row stops under the top bar,
  where a tap lands on the bar (a full run's failure, not the app's).

Not changed, by design or for a decision:
- Images uploaded straight into a collection keep their EXIF (GPS location included), on the web and on Android:
  neither re-encodes them as attachments are (§15.3). Re-encoding would also scale them down to 2048 px.
- The web had BUG-162's and BUG-170's weaknesses too (`unread.ts`, `collections.ts`): not changed in this pass, which
  was the app's. Ported on 2026-10-28: a failed read is sent again after 2 s, doubling up to a minute, until it is in
  or refused; the collections list is read once more once subscribed (`tests/component/unread.test.ts`, `collections.test.ts`).
- On the emulator (software CPU) Android's 10 s stop timeout passes before the activity has saved its state, so after
  the process is killed it starts at the room list. Settings saves its state there; a phone is fast enough.

---

# QA pass 22 — after refactor round 4

Exploratory testing of both clients on 2026-10-29, after REFACTOR items 33–46: the pages, search, the room list and
the app's notification check as routes (`pb_hooks/lib/lists.js`), the room writes split out of both controllers
(`writes.ts`, `RoomWrites.kt`), `app.ts` and the collection page split, the cache's `localStorage` fallback (BUG-104),
the shared worker lock and the hooks gathered in `main.pb.js`. Against the seeded server: a fuzz of the new routes (odd
kinds, cursors, limits, `q`, room ids, 2,000 rooms, `expand`/`fields` reaching for other people's emails), the room
list and every room's pages compared with the records API for a member, a non-member and a guest; the web in
Chromium (1100 and 390 px); the Android app on the emulator (Android 9). The code that moved in round 4 was compared
line by line with the commit before it ("Store aspect ratio of the media", read out of `.git`). Numbering continues
from BUG-170.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-171 | Low | Server API | A page asked for with a `kind` every JavaScript object has (`toString`, `constructor`, `__proto__`) failed with "Something went wrong while processing your request." instead of "Unknown page kind." (still a 400) | Fixed |

## BUG-171 — Page kinds from the object's prototype (Low)

**Steps:** `GET /api/chat/rooms/{room}/messages?kind=toString`. **Expected:** 400 "Unknown page kind.". **Actual:**
400 "Something went wrong while processing your request.": `KINDS["toString"]` is the object's own method, so the
handler went on and failed on its missing `params`. Nothing was read or leaked. **Fix:** only `KINDS`' own keys count
(`lists.test.ts`).

## Checked and fine

- **The new routes:** no 5xx for any odd value; a page past the end, `limit` 0 or 10^18, `page` 2^53; 5,000 words or
  30,000 characters of `q`; 2,000 room ids to `notifiable` (the first 50 count). No email but the caller's own through
  any `expand`/`fields` of `rooms`, `messages` or `notifiable`. The room list and each room's newest 200 messages are
  the records API's, for Alice, Bob and a guest.
- **Web:** search with `%` (literal), "ISTANBUL" finding "İstanbul" and going to it 117 messages back (on screen at
  both widths); "Show older results" through 50+, 100+ to all 120; the viewer's three images, a forward's among them,
  oldest first; a message sent just before a reload is there after it; a guest searching an Open Air room on a phone,
  and refused a public one.
- **Android on the emulator:** the room list, pages and gap fill through the routes; search "istanbul" (`q`, typed a
  letter at a time) and going to the result at the beginning of the room; a DM and a reply to Alice sent while the app
  was in the background notified by the periodic check through `GET /api/chat/notifiable`.
- **An app from before the routes:** the app as it was before the rename (`org.chat.android`, still installed on the
  emulator from an earlier pass, signed in as Alice) went on checking for notifications every 15 minutes with the old
  records filter, and was answered (200): an installed app keeps working, as docs/API.md promises.
- **Moved code:** `writes.ts` and `RoomWrites.kt` are the old controllers' writes, line for line, apart from reaching
  the window through the controller (`put`, the `Host` object): the same window assignments, the same per-message
  queues (the app's on the main thread), `posting()` still false while the room isn't loaded.
- After the fix: `lists.test.ts` 8/8; the suites as at the end of REFACTOR item 46 (web unit 314, component 423 of 425
  with the two unread-count load flakes passing alone, integration 444, e2e 76; Android 150).

Not changed, by design:
- With the network gone, a room kept on the device isn't shown: the room cache only fills the screen while a room
  loads (DESIGN.md §27), so it says "Couldn't load this room." with Retry.
- A room with unread messages opens at the first of them (§18.5), also after going far back through search and
  reloading: an edit to the newest message, not loaded then, shows once the window reaches it.

# Security audit — internal, 2026-10-29

A deep review of the server (rules, hooks, routes, federation, the Telegram bridge, the outbound fetchers), the web
client and the Android app, with each suspicion tried against throwaway PocketBase 0.40.4 servers; for linked
instances, a fake paired peer sending signed inbox events. Numbering continues from BUG-171. The three federation
findings need a paired instance acting in bad faith (or taken over): pairing needs both admins, but a peer was meant
to speak only for its own people (DESIGN.md §33.6), and these let it speak for ours.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-172 | Medium-High | Federation | A home's later `room` event re-set a DM mirror's members: naming a third person of ours let them read the DM's history | Fixed |
| BUG-173 | Medium | Federation | A home could send a message authored by one of the mirror's own people, shown under their name | Fixed |
| BUG-174 | Medium | Federation | A home could edit what the mirror's own people wrote in its room | Fixed |
| BUG-175 | Low-Medium | Android | A share (`EXTRA_STREAM`) of a `file://` URI was read with the app's own rights: another app could share the app's database for the user to send | Fixed |

## BUG-172 — DM members re-set by the home (Medium-High)

**Steps:** a peer opens a DM with Xavier (B), who replies; it sends the DM's `room` event again with members
`[its person, Xavier, Yvonne]`. **Expected:** the DM stays between the two. **Actual:** Yvonne saw it, with Xavier's
reply. **Cause:** `applyRoom` (federation/mirror.js) checked "one of yours, one of ours" only when it made the mirror,
then set `members` from every event. **Fix:** a DM's members are set only when its mirror is made.

## BUG-173 — Writing as one of ours (Medium)

**Steps:** a `message` event in a shared room with author `<Xavier's id>@<B's host>`. **Actual:** shown on B as
Xavier's. **Cause:** on a mirror `userOf` takes any global id, and one with this instance's host is that local user.
**Fix:** `applyMessage` refuses (403) an author of this instance; the home never sends our people's messages back.

## BUG-174 — Editing what one of ours wrote (Medium)

**Steps:** an `edit` event naming a message Xavier wrote in the mirror. **Actual:** his text changed, marked edited.
**Cause:** the own-people check in `target()` ran on the home only. **Fix:** `applyEdit` refuses (403) an edit of a
message by one of this instance's people. A `delete` still applies: the home's superusers may moderate their room.
Test for 172–174: `federation.test.ts` "a home speaking for our people".

## BUG-175 — Sharing the app's own files into a room (Low-Medium, Android)

**Steps:** another app sends `ACTION_SEND` with `EXTRA_STREAM` = `file:///data/data/com.chirkle.android/databases/…`.
**Actual:** the composer attached the app's cached rooms and messages, ready to send. **Cause:**
`RoomViewModel.copy()` opened any URI. **Fix:** only `content://` URIs of other apps' authorities
(`isForeignContent`, Files.kt); others are skipped as an unreadable file is. Test: `HelpersTest`.

## Checked and fine

- Filters on hidden fields (`tokenKey`, `name_key`, `dm_key`, `remote_id`, `invite_code`, `origin`) are refused;
  `email` filters are masked by `emailVisibility`; `verified` and `email` can't be set by their user; batch is off.
- HTML and SVG attachments are served as attachments with PocketBase's sandbox CSP; SVG avatars are refused.
- Every custom route checks the room (or the list rule) before it reads; collections check their view rules.
- Link previews and federation connect only to the checked public IPv4 address, no redirects by curl, no globbing or
  proxy, bodies capped. Pairing asks back; codes are single-use and compared in constant time; requests are HMAC-signed
  over method, path, date and body.
- Web: no HTML sinks, strict CSP, only http(s) links (`noopener`), preview icons only as `data:image/`.
- Android: https only in release, the session sealed with a Keystore key, backups exclude everything, immutable
  PendingIntents, no WebView.

Not changed (hardening, noted): logins are limited per IP only (`*:auth`, 2 per 3 s); `TRUSTED_PROXY` defaults to
X-Forwarded-For, which without a proxy lets clients choose their IP; `/_/` is public; ffmpeg runs as the server's
user; any app may send the exported activity `Notifications.OPEN` (it only opens a room).

# QA pass 23 — the whole product, linked instances most

Exploratory testing on 2026-10-30 against the seeded server (Chromium at 1100, 390 and 320 px) and two linked
instances made for it (A and B, paired, with a ticker in place of their cron jobs): a room shared from A, messages,
replies, reactions, edits, deletes and images both ways, a DM opened by address, the home renaming the room, A
suspending B and resuming, the share ended, the pair unpaired. Also: messaging edge cases (multiline, RTL, 300-letter
words, 2,001 characters, a blank edit, a reply whose original goes, reactions toggled seven times and by two people at
once), forwarding several, hiding and archiving from the room list, failed edits, deletes and reactions, collections
(the same item twice, a collection turned private, odd `items`), link previews, a fuzz of every custom route (1,422
requests), and a layout sweep of every screen and dialog at 320 px. Numbering continues from BUG-175. The Android
changes were checked with unit and screen tests only: the app wasn't installed on the emulator this time.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-176 | Low | Avatars (web, Android) | A stand-in "Ann (B)" had the initials "A(": the label's bracket counted as a word | Fixed |
| BUG-177 | Low | Replies (web) | The italic "Message deleted" in a reply's quote lost the end of its last letter | Fixed |
| BUG-178 | Medium | DMs (web, Android) | A DM closed because one of the two takes no DMs (turned on later, or a linked instance unpaired) still showed the composer; every message ended "Not sent." with a Retry that could never work, and the DM was offered to forward to | Fixed |
| BUG-179 | Low | Jump to, search (web) | In Safari, the Enter that confirms a Japanese or Chinese word (keyCode 229) went to the room chosen in Jump to, and ran the message search on the unfinished word | Fixed |

## BUG-176 — Initials of a label (Low)

**Steps:** a person of a linked instance writes in a shared room: "Ann (A)". **Expected:** "A". **Actual:** "A(",
in the messages, the DM list and the room header; Telegram's "Ann (TG)" too. **Fix:** `initials()` (web
`lib/avatar.ts`, Android `Avatars.kt`) leaves out a word in brackets and punctuation before a word (`avatar.test.ts`,
`HelpersTest`).

## BUG-177 — The clipped italic (Low)

**Steps:** reply to a message, then its author deletes it. **Actual:** the quote read "Message deletea": the slanted
"d" leans past the end of the box, which clips (it cuts long quotes with an ellipsis). **Fix:** a little padding at the
end of the italic text (`replies.css`).

## BUG-178 — A closed DM looked open (Medium)

**Steps:** Bea (B) and Ann (A) have a DM; A's admin unpairs B (or, on one instance, Ann sets `no_dms`). Bea writes in
the DM. **Expected:** the DM says it takes no messages, as a room you may not post in says so (§23.6). **Actual:** the
composer, and "Not sent." under every message, Retry failing each time; the server's reason ("Ann (A) doesn't take
direct messages.") was never shown, and the forward dialog still offered the DM. **Fix:** `dmClosed()` (web
`lib/rooms.ts`, Android `Rooms.kt`): such a DM shows the reason where the composer was, and isn't a forward target
(web: `rooms.test.ts`, `access.test.ts` "a DM that takes no messages"; Android: `LinkedTest`).

## BUG-179 — Enter confirming an IME word (Low)

**Steps:** Safari, Jump to (Ctrl+K), type Japanese with an input method, press Enter to pick the word. **Actual:** it
went to the first room listed. Safari ends the composition before that keydown, so only `keyCode` 229 tells it apart;
the composer already checks it (QA BUG-77), the switcher checked `isComposing` only, and message search nothing.
**Fix:** both skip that Enter (`switcher.test.ts`).

## Checked and fine

- **Linked instances:** a shared room backfilled; text, a reply (quoted on the other side), reactions (counted once
  when both sides add the same emoji, "Bea (B) reacted" on A), an edit, a delete and an image each way, in 3–4 s with
  the image's shape kept; `bea@host` found in New message whatever its case or a space after it, "There's nobody
  called nobody on …", "This instance isn't linked to …"; a DM both ways; the home's rename reaching the mirror ("lobby
  renamed (A)"), a mirror's user refused a rename; suspended, "… can't be reached right now" on the mirror and a
  message written meanwhile delivered on resuming; the share ended (archived mirror, service messages on both sides,
  the home's remote members gone).
- **Messages:** shift+Enter line breaks, RTL with a link, a 300-letter word wrapped at 320 px, 2,001 characters
  refused before sending, a blank edit refused with its reason, a reply to a deleted message; reactions toggled
  quickly ending as the server has them, on both screens; failed edits, deletes and reactions say so with Retry, and
  nothing changed on the server.
- **Collections:** the same item twice in one message is one file; an item of a collection turned private is
  refused ("no longer available"); `items` not a list of ids refused; images' shapes kept in `file_dims`.
- **Routes:** no 5xx in 1,422 requests with odd bodies and ids (the only "Something went wrong" answers are to bodies
  that aren't JSON, PocketBase's own 400).
- **Layout:** no horizontal overflow at 320 px on any screen, menu or dialog.

Not changed:
- **Someone's new name or picture shows to others only after a reload** (messages, the DM list): users can read only
  their own record, so no realtime event reaches anyone else. Live profile changes would need a topic of their own
  (as `chat/badges`); it is a feature to decide on.
- The same page linked as `https://x.com`, `https://x.com/` and `https://X.com/#a` gets a preview line each: links
  count once by their text (§28.1), not by where they lead.
- A room hidden from the list has no unread badge in Hidden (§18.4), and unarchived it is hidden again, as designed.

`app.js` budget 47.40 → 47.55 KB and `app.css` 7.10 → 7.15 KB (the user: "raise budget if needed").

# QA pass 24 — server, web and Android

Exploratory testing on 2026-10-31 against the seeded server, aimed first at what changed since pass 23 (the perf
pass: live replies without their quote, room pages' checked-rooms mark, workers woken by saves, the keepalive), then
the rest: Chromium at 1100 px, and the Android app installed (debug build, AOT-compiled) on the API 28 emulator as
Alice, with Bob's side scripted. Also: a fuzz of every custom route and the room-page parameters (2,908 requests), a
forward of a private room's reply into a public room read through `expand=forward_of[.reply_to]` (route and records
API), `file_dims` of rotated and big-endian EXIF JPEGs, WebP, GIF and PNG, link previews and media posters after a
save, hiding and unhiding on Android, a password changed elsewhere (web and Android), and every automated suite
(static checks, 748 unit and component tests, 448 integration tests, 76 Chromium e2e specs, the app's unit and
Robolectric tests). Numbering continues from BUG-179.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-180 | Low | Replies (web) | A live reply to a message beyond the window quoted it as "Message deleted" until its quote was fetched, and for good if that failed | Fixed |
| BUG-181 | Medium | Replies (Android) | A reply's quote never followed its original: edited, it kept the old text; deleted, the deleted text stayed in every reply on screen | Fixed |
| BUG-182 | Medium | Replies (Android) | "Replying to" kept the original as it was: edited, the bar showed the old text; deleted, the bar stayed, and the reply then failed ("the message you replied to was deleted"). Archiving left the reply to come back on unarchiving | Fixed |
| BUG-183 | Medium | Session (Android) | A session revoked elsewhere (the password changed on another device) went unnoticed while the app ran: rooms of yours said "This room doesn't exist", and only a write or a restart signed out | Fixed |

## BUG-180 — "Message deleted" for a quote on its way (Low)

**Steps:** a room scrolled to its newest messages; someone replies to a message far back. **Actual:** the quote read
"Message deleted" (in the deleted style) for the time it took to fetch the original (seen with an 800 ms delay), and
stayed so if the fetch failed. Live events come without the quote since 2026-10-30 (PERF.md §2.3), and the quote's
fallback for "nothing known" was a deleted message. **Fix:** "…" meanwhile (`quotedOf` in `views/room/messages.ts`;
`replies.test.ts`). Android shows no quote until it is in.

## BUG-181 — The Android quote stood still (Medium)

**Steps:** Bob replies to his message "msg 128", then edits it to "msg 128 EDITED" (or deletes it), with Alice in the
room on Android. **Actual:** Alice's quote kept "msg 128" (or the deleted text) until the room was loaded again. The
web quotes the window's copy of the original when there is one (DESIGN §19.3); the app only ever showed the copy the
reply came with. **Fix:** the room's rows quote the window's copy (`RoomViewModel.quoting`; `UiFeaturesTest`).

## BUG-182 — The Android reply bar stood still (Medium)

**Steps:** Alice taps Reply on Bob's message; Bob edits it, then deletes it; Alice sends. **Actual:** the bar kept the
old text, stayed open after the delete, and the message failed "Not sent: the message you replied to was deleted"
with "Send without quote". The web's bar follows the original and closes when it goes (`reply.ts`). **Fix:** the reply
(and an edit in progress) follow the window and the room: edited, the new text; deleted, archived or no longer
allowed, they end (`RoomViewModel.follow`; `UiFeaturesTest`).

## BUG-183 — A revoked session on Android (Medium)

**Steps:** Alice signed in on the app; on another device she changes her password (which revokes every other
session). In the app she opens a room from the list. **Actual:** "This room doesn't exist." PocketBase reads a token it
refuses as no token, so reads answer as to a guest; the app checked its session only at start and after a refused
change (the web also checks when a tab comes back after 5 minutes, QA BUG-51, and a refused file token signs it out).
**Fix:** the app checks the session when it comes back after 5 minutes (`ChirkleServices.setVisible`), and when a room
"doesn't exist" while signed in (`ChirkleApi.suspectSession`); revoked, it signs out (`ServicesTest`). Tried on the
emulator: signed out on opening the room. The not-found test also passes without its fix (in the test, the room's
other requests sign out first); the emulator case is the one it fixed.

## Checked and fine

- **Live replies (web):** quotes of replies to old, recent, edited and deleted messages, kept through a reaction and a
  reload. **Pages' checked-rooms mark:** the private original of a forward, read through `expand=forward_of` and
  `forward_of.reply_to` on the room page route and the records API, comes without its reactions and reply; a client
  can't send the mark (it starts with a per-process secret).
- **Workers:** a link's preview in 1 s after a send and 2 s after an edit; a video's poster and size and an image's
  shape within the first poll. `file_dims` right for EXIF orientations 3, 6 and 8 (little- and big-endian, a 70 KB
  segment first), WebP, GIF and PNG.
- **Routes:** no 5xx in 2,908 requests; the only "Something went wrong" answers are PocketBase's own, to bodies that
  aren't JSON and to `fields` it can't parse (as on the records API). Tick routes refuse users.
- **Android:** live replies (quoted from the window or fetched), an edit in progress closing when its message is
  deleted elsewhere, hide and unhide, the Hidden section, signing in again after a revoked session; the keepalive
  event is dropped by `Realtime.dispatch`.
- **Suites:** all green; `attachments.spec.ts` "the image viewer…" timed out once in the full run (its new-tab wait,
  with the emulator running) and passed 3/3 alone.

# QA pass 25 — server, web and Android after the redesign

Exploratory testing on 2026-10-31, aimed first at the "Chirkle Sidebar Redesign" (DESIGN.md §7.1, §7.8; ANDROID.md
§36) that landed the same day: the web at 1280 and 390 px in both themes, signed in and as a guest, with axe on the
room, its menus, Settings, Jump to and Hidden & archived; the app's room list, room and action sheet on Robolectric
screenshots in both themes. Then the rest: live messages, replies, edits and reactions with Bob scripted, hiding and
unhiding, search, Room access, the media grid, collections, the font assets' headers, and a concurrent write test of
the server (120 sends, 15 reactions on one message, 30 edits and 30 deletes at once, read marks: no 5xx, nothing lost).
Every automated suite before and after the fixes (static checks, unit and component, integration, 77 Chromium e2e
specs, the app's unit and Robolectric tests). Numbering continues from BUG-183.

| # | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-184 | Low | Room (web) | "Jump to latest" and "New messages" showed two arrows: the redesign's icon and the "↓" still in the text | Fixed |
| BUG-185 | Low | Settings (web) | The notification card's description stood above its "Notifications" heading | Fixed |
| BUG-186 | Low | Replies (web) | A quote of a short message clipped its author ("Alice M…" for "while offline 1") | Fixed |
| BUG-187 | Low | Editing (web) | Editing the newest message left "Enter to save · Esc to cancel" hidden under the composer | Fixed |
| BUG-188 | Low | Room list (web) | A guest's "Open Air rooms" heading kept the old large heading, not the redesign's section heading | Fixed |
| BUG-189 | Low | Accessibility (web) | "Notify of every message" was a `menuitemcheckbox` outside any menu (axe: aria-required-parent, critical) | Fixed |
| BUG-190 | Low | Accessibility (web) | An item chosen from a "⋯" menu by keyboard (Hide, Unhide, Archive…) dropped the focus to the top of the page | Fixed |
| BUG-191 | Medium | Font (web, Android) | Inter's contextual alternates changed people's text as drawn: "qa23-mvu32x1n" showed as "qa23-mvu32×1n", "a->b" as "a→b" | Fixed |
| BUG-192 | Low | Collections (web) | A private collection was marked with a 🔒 emoji (an empty box without an emoji font) where the rest of the app has the lock icon | Fixed |

## BUG-184 — Two arrows (Low)

**Steps:** scroll up in a room. **Actual:** the button read "↓ ↓ Jump to latest": the redesign gave it an arrow icon
(`ic i-down`) and kept the arrow in its text. **Fix:** the text without it (`renderPill` in `views/room.ts`; the
component tests' expected texts).

## BUG-185 — The hint above its heading (Low)

**Steps:** open Settings. **Actual:** the Notifications card began with "For DMs, replies to you…", then the heading.
The legend is floated (so it lays out with the rest), which makes it a flex item, and the hint's `order: -1` put the
hint before it. **Fix:** the legend `order: -2` (`profile.css`).

## BUG-186 — The clipped author (Low)

**Steps:** Bob replies to Alice's "while offline 1". **Actual:** the quote read "Alice M… while offline 1". The
author's `max-width: 40%` was a percentage of the quote, which is only as wide as its content: with a short text, 40%
of it is less than the name. **Fix:** the author gives way much less than the text (`flex-shrink: 0.15`) and is held
to 20em (`replies.css`). Seen in Chromium: every quote's author whole.

## BUG-187 — The hint under the composer (Low)

**Steps:** at the bottom of a room, press ↑ to edit your last message. **Actual:** the edit box showed, its "Enter to
save · Esc to cancel" line 28 px below the list's bottom: focusing the box scrolls only the box into view. **Fix:** the
whole message is scrolled into view when editing starts (`startEdit`'s focus in `messages.ts`).

## BUG-188 — The guest's heading (Low)

**Steps:** open the app signed out. **Actual:** "Open Air rooms" in a large bold heading out of line with the rows; the
signed-in sections' headings are small, dim fold buttons, and the guest's heading (which doesn't fold) had none of
their style. **Fix:** `.section-title`, set like the others without the chevron (`rooms.ts`, `room-list.css`).

## BUG-189 — A menu item outside a menu (Low)

**Steps:** open a room's "⋯" menu; run axe. **Actual:** aria-required-parent (critical): the redesign made "Notify of
every message" a `menuitemcheckbox`, but the menu is a disclosure of buttons, not a `role=menu`. **Fix:** a
`role="switch"` button with `aria-checked` (`ui/menu.ts`; `menu.test.ts`). axe clean with the menu open.

## BUG-190 — Focus lost after a menu action (Low)

**Steps:** with the keyboard, open a hidden room's "⋯" and choose Unhide (or Hide room in the header menu). **Actual:**
the focus went to the page's start. Closing the menu redraws its items, so the focused button is gone before the
action runs. **Fix:** the focus goes back to the menu's toggle first, and the room list puts it back when the row moves
(`runItem` in `ui/menu.ts`; `menu.test.ts`).

## BUG-191 — Inter's alternates (Medium)

**Steps:** a room named "qa23-mvu32x1n", a user "user-38x0c69", a message "a->b <- 3x". **Actual:** drawn as
"qa23-mvu32×1n", "user-38×0c69", "a→b ← 3x" on the web and in the app: Inter's contextual alternates (`calt`) turn an
"x" between digits into a multiplication sign and "->" into an arrow. People's names and messages must show as typed
(and as they copy). **Fix:** `font-feature-settings: "calt" 0` on `:root` (`tokens.css`; `tests/unit/build/fonts.test.ts`
checks nothing turns it back on), and `fontFeatureSettings = NO_CALT` on every style of the app's typography
(`Theme.kt`; `UiPortsTest`; ANDROID.md §37). Seen on both: "32x1n" with a plain x.

## BUG-192 — The lock emoji (Low)

**Steps:** open a private collection; attach from one. **Actual:** "🔒 Private" in the collection's line, " 🔒" in the
save dialog and on an attachment's badge, an emoji (an empty box where there is no emoji font, as in the screenshots of
this pass) where the room list and everything else since the redesign use the lock icon. **Fix:** "Private" in words
on the collection page and in the save dialog (the collections chunk is at its budget), the lock icon on the badge
(`attachments.ts`, `collections.css`).

## Checked and fine

- **Server:** concurrent sends, reactions (twelve "on" and three "off" at once leave exactly three people), edits,
  deletes and read marks; the self-hosted fonts are served as `font/woff2`, immutable, and a missing one is a 404 with
  `no-store`. The unread route's fields come in any order (a Go map), not a bug.
- **Web:** the redesigned sidebar, Hidden & archived (count, unhide, the row's menu), the room menu, Room access, search,
  the media grid, the attach menu, live edits and reactions, the to-me card (wrapping at 390 px), Settings, sign-up;
  axe clean on Settings, Jump to, the room with Hidden & archived open and a row menu open, and the dark theme.
- **Android:** the room list (pill, sections and their "+", Hidden & archived open with both parts), the room (to-me
  cards, quotes, reactions, the NEW line, the composer) and the action sheet, light and dark. The app's quotes put the
  author on its own line, so BUG-186 isn't there.
- **Suites after the fixes:** 751 unit and component, 448 integration, the app's unit and Robolectric tests, static checks and
  the build all green; e2e 76/77: `attachments.spec.ts` "the image viewer…" timed out on its last step, Ctrl+click opening
  the image in a new tab (as in pass 24), and failed 3 of 9 runs alone, always there: the new tab not reported, or left on
  about:blank. Driving the same Ctrl+click over CDP couldn't tell a missing tab from one reported late, so it stays a
  suspected harness flake, not a product bug; worth a look on a real browser.
- **Not tested this pass:** the emulator (not started; the screens were seen on Robolectric) and linked instances.

# User report 2026-10-31 — Firefox

Reported by the user from Firefox after the redesign. Reproduced in Playwright's Firefox (and the same in Chromium)
except where noted.

| ID | Severity | Area | Summary | Status |
|---|---|---|---|---|
| BUG-193 | Low | Room (web) | The composer's top line sat 1px above the sidebar foot's: 68px row + its 1px border against a 68px foot | Fixed |
| BUG-194 | Low | Replies (web) | A quote over a reply that starts a group began 6px left of the message's text | Fixed |
| BUG-195 | Medium | Jump to (web) | With many rooms and nothing typed, the list squeezed the field to a sliver at the top of the dialog | Fixed |
| BUG-196 | Low | Room list (web) | Each row's ⋯ menu looked out of place; everything in it is in the room's own menu | Removed |

**BUG-193:** `.composer-row` is 67px (padding 13px on top), so with the border it is 68px like `.side-foot`. The user saw
a bigger difference, which didn't happen here with any default font size, minimum font size or device pixel ratio.
Firefox with classic (non-overlay) scrollbars can make a one-row textarea taller to leave room for a horizontal scrollbar,
so the composer's textarea now has `overflow-x: hidden`. Headless Firefox always uses overlay scrollbars, so that part
is untested. **BUG-194:** the curve is 26px wide (20px on phones, with a −26px margin), so the curve plus the gap make
up the quote's offset. **BUG-195:** the field is `flex: none` and the dialog fits under its 140px top margin.
**BUG-196:** rows in Rooms and Direct messages have no menu; hidden and archived rows keep their one button (Unhide,
else Unarchive for the owner). The "two arrows" on "Jump to latest" is BUG-184, already fixed; an older build or the
service worker's cached copy still shows it until the page reloads.
