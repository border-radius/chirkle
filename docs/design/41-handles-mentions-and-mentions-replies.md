# §41. Handles, mentions and "Mentions & replies" (2026-11-10)

Part of the design document: [index](../DESIGN.md).

The user: "user should have nicknames/handles. and there should be a way to mention them like @nickname (with
auto-complete). mentions should act like replies (notifications and highlight in room). also room in roomlist should
show if room have any mentions/replies. in sidebar right after jump to should be a new section "mentions & replies"
where user can see all mentions and replies for them and jump to chat where they are. info about reactions should also
be there (somebody set reaction to your message)". Web, server and the Android app (ANDROID.md §60).

## 41.1 Handles (`users.handle`, `pb_hooks/lib/handles.js`)

3 to 24 of `a–z`, `0–9`, `_`, unique, stored in lower case; "all", "everyone", "here", "room" and "channel" are
reserved. So are words that would lend a stranger the site's authority in a mention (QA SEC-2, 2026-11-22): "admin",
"admins", "administrator", "chirkle", "help", "mod", "mods", "moderator", "moderators", "official", "root",
"security", "staff", "support", "system". No new handle is one of them, nor can a handle be changed to one; an
account that had one before keeps it (and is mentioned by it). Every account has one: a new account's is made from its name (Latin and Cyrillic letters transliterated,
accents dropped, anything else "_", at most 20, a number added when taken), and migration `1760000045_mentions.js`
gave existing accounts theirs the same way (it repeats the code: migrations can't require hooks). A Telegram stand-in
takes its Telegram username when it is free. You change yours on Settings (web) or Your profile (app); an "@" typed
first is dropped. Refused with the reason on `handle`: "Use 3 to 24 letters a–z, digits or underscores.", "This handle
is taken. Choose another one.". A rename keeps the handle. People search (`/api/chat/users`) finds by handle too.

## 41.2 Mentions (`messages.mentions`)

"@handle" after the start or anything but a letter, digit, "_", "@", "." or "/", and not followed by one of those
(so not an email, `@ann@b.example` or a path), case ignored: `MENTION` in `handles.js`, `web/src/lib/mentions.ts`,
the app's `lib/Mentions.kt`, all run on `shared/vectors/mentions.json`. The server resolves them on create and on an
edit of the text into `mentions` (users, at most 20): people who can see the room, not the author; none for a forward,
a deleted or a service message. Clients can't set it: a create's is replaced, an update changing it is a 400. A linked server's events carry them by global id (§33).

In a room each "@handle" is marked (`.mention`, accent and bold); yours more (`.mention.me`), and a message that
mentions you is highlighted as a reply to you is (`.to-me`).

## 41.3 Suggestions as "@" is typed

`GET /api/chat/mentionable?room=&q=` (signed in; 404 for a room you can't see): up to 8 people who can see the room,
whose handle starts with `q` or whose name holds it, those who wrote there lately first (not in an anonymous room,
§35); never you or a banned account. The web's composer spots "@" and loads `ui/mention-suggest.ts`, which asks
after a 120 ms pause and shows a list over the composer like the ":name" emoji (§20.6): ↑/↓, Enter or Tab put
"@handle ", Escape closes it. The app shows a column of people over its field; a tap puts the handle in.

## 41.4 The inbox (`inbox`, `inbox_reads`, `pb_hooks/lib/inbox.js`)

A row per thing told to you: `mention`, `reply` (to your message) or `reaction` (someone's reactions to your
message: one row for all of theirs, made by their first and gone with their last, 2026-11-11; migration
`1760000048` merged the rows of one per emoji from before); `actor`, `message`, `room`. A reaction row's `emoji` is
"" in the table; the list answers with the actor's emoji on the message now: `emojis` (all of them) and `emoji`
(the first five, then " +n": "👍🎉❤️😂🔥 +3", which the apps show as they are). Another emoji from the same
person changes no row: it is neither told live nor new again. Written in the messages hooks: a mention added or removed by an edit, a reaction taken
back and a deleted message take theirs away; your own doings, stand-ins and the reply's author mentioned too get none.
No API rules: `GET /api/chat/inbox?before=<cursor>&limit=` lists yours, newest first, leaving out rooms you can't see
now; in an anonymous room the room is the actor of a mention or reply. `POST /api/chat/inbox/seen { at }` moves
`inbox_reads.seen_at`. Each row added or taken away is sent to its user's clients on `chat/inbox`
(`{ action, id, kind, room, message, created }`).

`GET /api/chat/unread` adds `inbox` (rows newer than `seen_at`, at most 100, leaving out mentions and replies already
read in their room: no reading one twice; and reactions seen there, below) and `mentions` (per room, the unread
messages that mention or reply to you, at most 100 a room since 2026-11-12: the apps only show whether there are any).
Each room's count is a range scan of `(user, room, created)` from the read position on (§42.1). A person's inbox keeps
their newest 500 rows, none older than 180 days (the daily prune, §42.1). The sidebar's first row, right under Jump to, is **Mentions & replies**
(`/inbox`) with the faces of who the newest unseen rows are from (`inbox_from` of `GET /api/chat/unread`: at most 3
people, newest first, among the newest 100 unseen rows, not a mention or reply's writer in an anonymous room; "N new" for a
screen reader, and shown when the server doesn't say whose; 2026-11-23); a room with unread mentions or replies shows
how many in its pill, instead of the dot other unread rooms get (2026-11-23; an "@" before its count until then); both follow
`chat/inbox` live, and reading a room clears its "@". The page (`views/inbox.ts`, a lazy chunk) says "Ada mentioned you
in #room", "replied to you" (with your message quoted) or "reacted 👍🎉 to your message", newest first, "Show older",
what is new tinted (each item's `read`: a mention or reply read in its room isn't new; a read sent while the inbox
count isn't 0 fetches the counts again); each opens its message in its room. Opening it sees everything listed.

Reactions seen in their room (2026-11-22, user: "when reading room, new reactions should be marked as seen in mentions
& replies"; migration `1760000057`): `POST /api/chat/reads` also sets `room_reads.reactions_seen_at` to now (never
back), and a reaction row is read (not new, not counted) when its message is read there and it came before that. A mark
at the same position still writes when there are reaction rows in the room since the last one (one range scan;
otherwise it is answered without a write, as before). The apps mark again, where they are, when `chat/inbox` tells of a
reaction in a room open and read (not away): `unread.ts` / `Sync.kt` `again()`, the inbox count fetched once that
mark is in rather than on the event (it would blink). A reaction to a message you haven't read yet stays new until you
do; one to a message read long ago counts as seen too, whether it was scrolled into view or not. Tests:
`tests/integration/mentions.test.ts`, `tests/component/unread.test.ts`, the shared scenario in
`shared/vectors/unread.json` (both apps; its `wait` step lets the first read go out before the reaction).

## 41.5 Notifications

A mention of you notifies as a reply does (§34, the "Mentions and replies" choice; "Ada mentioned you in #room"). The
app's check (`GET /api/chat/notifiable`) now includes mentions (`mentions.id ?= {:me}`: PocketBase's `mentions ?=`
on a multi-relation matched nothing), on the channel renamed "Mentions and replies".

## 41.6 Tests

Server `tests/integration/mentions.test.ts`, `lists.test.ts` (notifiable); web `tests/unit/vectors.test.ts`,
`tests/component/views/room/mentions.test.ts`, `views/inbox.test.ts`, `views/rooms.test.ts`, `unread.test.ts`,
`notify.test.ts`, `tests/e2e/mentions.spec.ts`; app `VectorsTest`, `ContractTest`, `UiMentionsTest`.
