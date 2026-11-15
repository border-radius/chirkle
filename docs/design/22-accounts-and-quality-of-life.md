# §22. Accounts and quality of life

Part of the design document: [index](../DESIGN.md).

## 22.1 Unique display names

`users.name_key` (hidden text, unique index where not empty) holds the name's key: `nameKey()` in
`pb_hooks/lib/text.js`, the same NFKC + case folding without invisible characters as room names (§5.2). `beforeUserSave`
sets it after cleaning the name and refuses a key someone else has: 400, `name: validation_not_unique`, "This display
name is taken. Choose another one." (shown next to the field by sign up and the profile). An update that keeps the name
keeps its key without checking it. The migration (`1760000012_accounts.js`) backfills the keys; names that already
clashed get a key made unique with the user id (`key#id`), so those accounts keep their name and can still change
their picture or password, but nobody new can take it. Tests free a fixed name such as "Ada" the same way before
signing it up again (`tests/support/names.ts`), since every test shares one server.

## 22.2 Password and Log out on the profile page

`POST /api/chat/password` (`pb_hooks/lib/account.js`, logged in only) takes `oldPassword` and `password`. It checks
the current password (400 on `oldPassword` if wrong), refuses an unchanged one, sets the new one (the field's own
rules, e.g. at least 8 characters, apply), refreshes the user's token key, so every token issued so far stops working
(other devices are signed out), and answers like a login (`{ token, record }`). `api.changePassword` saves that
answer, so this tab (and the others of this browser, which share the session) stays logged in. Rate limit: 5 per 60 s.
It is the only way to change a password: the users update rule refuses `password` (QA BUG-53).

Who a realtime client is comes from the token its subscriptions were sent with, so whenever the token changes the
client sends them again (`pb.ts`, QA BUG-52). A device that was signed out finds out when the server refuses a change
it sends (`api.onRejected`, checked at most every 30 s: a refusal sooner than that is checked once the 30 s are up, QA
BUG-151) or when its tab comes back after 5 minutes: the session check (`refreshAuth`) then fails and it goes to the
login screen (QA BUG-51).

The profile page has a "Password" form (current, new, confirm; checked in the page first, each error under its field)
and a "Session" section with **Log out**, which moved there from the app bar. The Password form is the last section
before Session (after Appearance; moved 2026-10-23, the app too).

## 22.3 Drafts survive a reload

`web/src/drafts.ts` keeps what is typed in the composer under `chat.draft.<user>.<room>` in `localStorage`, written
on every change (blank text removes it). One key per room, so two tabs writing in different rooms don't overwrite
each other. The room view restores it on mount. Ending the session (logging out, or another tab switching to someone
else) removes that user's drafts. Storage that is full or disabled only means no drafts.

## 22.4 Unread count in the favicon

`web/src/favicon.ts` sums the room list's badges (§18.4: not hidden or archived ones) and draws the app icon
(`/icons/icon.svg`, a speech bubble in the app's gradient) on a canvas with a red badge holding the count (`99+` past
99), as a PNG; the icon itself is a file so its markup isn't in `app.js`; the title becomes
"(3) Chirkle". In a room, the title also names it as the room list does (`#name`, or the other member's name in a DM):
"(3) #general – Chirkle". `index.html` carries the plain icon, so the tab has one before the script runs.

While the tab is away (`document.visibilityState` is `hidden`, kept as `AppState.away` by `app.ts`), nobody is
reading the open room, so its new messages count too: `unread.ts` counts them live, keeps the server's count for it
on a refetch, and refetches when the tab goes away (after sending what was read) to catch messages that came in
unseen while scrolled up. Coming back, the room view reads what is on screen as usual, which clears it at the bottom;
scrolled up, what is left counts, as in the room list (§18.3, 2026-11-02).

## 22.5 Focus on entering a room

When the composer is first shown in a room (on entering it or switching from another), the caret goes into it. Not on
touch screens (`(hover:none)`), where it would open the keyboard over the messages.

## 22.6 Confirmations go away

"Message forwarded." / "*n* messages forwarded." clears itself after 4 s (`NOTICE_MS`), unless another notice replaced
it meanwhile. Errors stay until something else is said.

## 22.7 Jump to latest

The pill over the bottom of the list (§7.5) also shows, as a quieter "↓ Jump to latest", whenever the newest messages
aren't on screen with nothing new below: scrolled up by more than 80 px, or the window is back in history (after a
quote or Jump to beginning). Clicking it scrolls to the bottom, or loads the latest page when the window doesn't have
it. "↓ New messages" and "New messages · Jump to latest" take precedence as before; "Back to reply" (§19.5) over
all of them.

## 22.8 Tests

- **Integration** (`accounts.test.ts`): names unique across case, invisible characters and whitespace; renaming onto
  someone's name refused, keeping yours fine, a freed name can be taken; the key hidden and not settable; legacy
  shared names still save; the password route needs a session, checks the current and new passwords, changes it,
  answers with a working token, and signs out other sessions.
- **Unit**: `passwordProblem`; the profile's password form (local checks, wrong current password, success) and Log
  out; a taken name on sign up and on the profile; drafts across a reload, per user, cleared; focus on entering a
  room (not on touch screens); Jump to latest scrolled up and back in history; the forward confirmation going away;
  the favicon's label, count and title, with the open room counted while the tab is away (`favicon.test.ts`,
  `unread.test.ts`, `app.test.ts`).
- **E2E** (`accounts.spec.ts`): change the password and log in with it; a taken name at sign up; a draft survives a
  reload and the composer has focus on entering rooms; the title and favicon count unread messages; Jump to latest;
  the forward confirmation going away.
