# §43. Your data and deleting your account (2026-11-15)

Part of the design document: [index](../DESIGN.md).

REFACTOR P1. Before this, nobody could download what they wrote, and nobody could delete themselves: `users.deleteRule`
is null, and `beforeUserDelete` refuses even a superuser once the account wrote a message (the messages need their
author). Both are on Settings, on the web (`views/profile.ts`) and in the app (`ProfileScreen`), under "Your data" and
"Delete account". Server: `pb_hooks/lib/account.js`; what grows with the account is done by a worker (§43.5), so a
big account or a busy server never holds a request, or the database's write lock, for long. Tests: `tests/integration/account_delete.test.ts`,
`tests/component/views/profile.test.ts`, the app's `ChirkleApiTest` and `UiFeaturesTest`.

## 43.1 What is personal data here

- **The account's own**: name, handle, picture, e-mail, password, sessions, OAuth2 links, one-time codes.
- **What only it has**: its collections and their items (§31), whom and what it follows, the rooms it hid, its read
  positions, its inbox (§41), its online samples (§40).
- **What it wrote**: messages in rooms and DMs, which other people read and answered. Theirs stay readable, so a
  reply's quote or a forward may still show a deleted message's place ("deleted"), as for any delete (§21.2).
- **Traces in other people's things**: reactions on others' messages, being named in a private room's members or
  writers, a mention in someone's text. The reactions and mentions stay, under "Deleted account"; the member lists
  drop it.

## 43.2 The export

Made in the background (§43.5), then downloaded: a big account's export is many pages of reads and a large file, which
no request should wait for on a busy server.

- **`POST /api/chat/export`** (signed in) asks for one: an `export` job, queued, and the worker woken. Asked again while
  it is being made, or within 10 minutes of it being made, it answers the same one (no new job: a person tapping twice,
  or often, costs one).
- **`GET /api/chat/export`** says where the newest is: `{ id, state, created, finished, expires, size }`, `state`
  `none` (never asked, or gone after 7 days), `queued`, `done` (to download until `expires`, `size` bytes) or
  `failed` (5 tries, §43.5). POST answers the same.
- **`GET /api/chat/export/file`** downloads the newest made one (`Content-Disposition: attachment;
  filename="chirkle-export-YYYY-MM-DD.json"`, `Cache-Control: no-store`; 404 when there is none). Signed in, or with a
  file token (`?token=`, `POST /api/files/token`): the web's link and the app's download manager are plain links,
  which send no session, and the browser or the system then fetches the file as it comes instead of the page holding
  it. A file token only ever opens its own account's export. The job's file is `protected`, in a collection without
  API rules: the records and files APIs don't serve it.
- An export is kept 7 days, then the worker deletes it with its file. A deleted account's go at once (§43.3).

The file (schema: `$defs.exportFile` in `shared/schema/answers.json`):

- `format: "chirkle-export"`, `version: 1` (changes when the shape does), `exported` (ISO time).
- `account`: id, name, handle, e-mail, created, the picture's path, `no_dms`.
- `messages`: every message it wrote that isn't deleted, oldest first: id, room, created, edited, text, `reply_to`,
  `forward_of`, and its files with their names and paths (`/api/files/messages/…`; whoever has the path has the file,
  §37.3). A forward's text is someone else's: only `forward_of` says what it showed.
- `rooms`: the rooms it made, then the others its messages are in: id, name (a DM's is the other person's name), `room`
  or `dm`, `mine`.
- `collections` with their items (names and paths), `following` (collections it follows), `hidden_rooms`.

On the web the "Your data" card asks with **Prepare my data**, says "Preparing your data…" and asks again every 3 s while
the page is open (leaving it loses nothing: the job goes on), then shows the size and until when, with **Download** and
**Prepare again**. Pressed within 10 minutes of the last one being made, it gets that one back, and says "It was
prepared less than 10 minutes ago, so this one is still the newest." (QA BUG-283). The app does the same (ANDROID.md §73).

Nothing of it is on the web's critical path (§7.7): its calls are `account-api.ts`, which `Api.account()` loads with
Settings, and the two cards' styles are `styles/account.css`, which the profile chunk links (`ACCOUNT_CSS`). The
download link is relative (the app is served by its server).

## 43.3 Deleting: `POST /api/chat/account/delete { password, messages }`

Signed in; `password` is the account's (a stolen session alone can't delete it), `messages` is `"keep"` or `"delete"`,
the person's choice (neither: `messages` `validation_required`; a wrong password: `password`
`validation_invalid_value`; 400 "Failed to delete the account."). Answers 204. Then:

1. **At once, the account** (`erase()`, one transaction, before the answer): `kind` = `deleted` (migration 52), name "Deleted account", no handle,
   no picture (the file is deleted), e-mail `<id>@deleted.invalid` (not verified, not visible), `no_dms`, not a
   moderator, not banned; a random password and a new token key, so every session ends; its OAuth2 links, MFA, OTP
   and sign-in origin rows deleted. Its `collection_subs`, `hidden_rooms`, `room_reads`, `inbox`, `inbox_reads`,
   `stats_activity` rows and exports are deleted, all small, and the invite links it made (§44, QA BUG-281). Its collections stop being public. It leaves every private
   room's members and every room's writers (not a DM's two members, which name the DM). An `erase` job is queued in
   the same transaction, with `messages` set for "delete".
2. **After, by the worker** (§43.5), what grows with the account, a batch of 200 to a transaction: its collections'
   items, each collection after its last (their files named once less, §37); then for "delete" every message it wrote,
   soft-deleted (§21.2) through the messages hooks, as if deleted one by one: text, files, previews, reactions go, the
   media grid and inbox follow, forwards show it deleted, the bridges are told. Archived rooms too (a custom key,
   `@erasing`, lets `beforeMessageUpdate` skip the archived guard for these saves only). Until the job is through, its
   remaining messages read as before, under "Deleted account".

**The row stays.** Messages (kept or soft-deleted) and rooms name it as their author and creator; deleting it would
take them too (`messages.author` doesn't cascade, `rooms.created_by` is required). So a deleted account is a
tombstone: `kindOf` says `deleted`, `isStandIn` is true (no inbox rows are made for it, no reset mail, no ban), people
search (`GET /api/chat/users`) leaves it out, it has no handle so nobody can mention it, and its DMs take no messages
(`no_dms`). A room it made keeps it as `created_by`: the room goes on, and moderators (§36) can archive it or change
its access. A linked instance that knows it is told its new name and picture, as for any profile change (§33).

**The name.** Every deleted account is called "Deleted account". `name_key` is unique, so each gets
`"\u0001deleted " + id`: no name is cleaned to a control character, so no person's key can ever be one and block the
delete. Nobody else may take the name: a signup or rename to it (in any case) is refused as taken.

A superuser's delete of the row is unchanged: still refused once the account wrote messages.

## 43.4 Not done

- **An e-mail to confirm**, or a grace period to undo. The password is the check; the account goes at once.
- **Telling the person when the export is made** (an e-mail, a notification): the page or screen says so while open.
- **Taking back reactions** given on other people's messages: they stay, under "Deleted account".
- **Rooms it made** aren't handed to anyone: a private room whose only manager was it is left to the moderators.
- **Telegram stand-ins and linked instances' people** (§26, §33) aren't people here and can't use this; their own
  service deletes them.

## 43.5 The account worker (`pb_hooks/lib/account.js`)

A cron worker (`lib/worker.js`, as the media and link-preview ones: a run a minute, one at a time by a lock, woken by
the requests that queue work; `ACCOUNT_CRON=off` leaves it to `POST /api/account/tick`, superusers, which the tests
call). Its queue is `account_jobs` (migration 53; no API rules): `user`, `kind` (`export` or `erase`), `state`
(`queued`, `done`, `failed`), `file` (protected), `size`, `messages`, `tries`, `error`, `finished`.

- **A pass** first deletes exports older than 7 days (50 at a time, with their files), then does one step of the queued
  job touched longest ago: an export written whole, or one batch of an erase. Saving the job touches it, so jobs take
  turns: a large erase doesn't keep anyone's export waiting.
- **An export** is written a record at a time to a temporary file (`$os.openRoot(tmp).create`), then stored as the job's
  file and the temporary one removed. What it holds in memory is the set of room ids, not the messages. Records are read
  500 at a time by `(created, id)` after the last one (not by offset), so each page costs the same however far in; the
  worker's lock is renewed after each page, so a long export isn't taken for a stuck run.
- **A failure** (logged, its error kept on the job) is tried again on a later pass; the fifth makes it `failed` (an
  export then says so, and Prepare asks for a new one).
- `GET /api/chat/metrics` reports it as the worker `account` and the queue `account_jobs` (queued rows; failing: with
  tries); `/stats` calls both "Exports and deleted accounts".

Tests: `tests/integration/account_delete.test.ts` (the states, the link with a file token, 520 messages over two pages,
the 7-day expiry, collections and messages after the delete), `tests/component/views/profile.test.ts`, the app's
`ChirkleApiTest` and `UiFeaturesTest` (§73), `retention.test.ts` (the metrics' names).
