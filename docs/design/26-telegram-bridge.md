# §26. Telegram bridge

Part of the design document: [index](../DESIGN.md).

A Telegram bot joins Telegram groups, and each group can be linked to a room. What is written on either side shows on
the other, files included, so people in the room and people in the group talk to each other.

## 26.1 A module apart

The bridge is `pb_hooks/telegram.pb.js` (its routes, worker and `tg_*` hooks; its parts of the core's message and user
hooks `main.pb.js` calls through `lib/features.js`, §5.6), `pb_hooks/telegram/` (its code: PocketBase only
runs `*.pb.js` files, so these load only when required) and its own collections, `tg_*`
(`pb_migrations/1760000019_telegram.js`). Nothing in the app refers to it. It reads the app's records, and saves
messages and users through the same hooks as everything else, so trimming, limits, access checks, unread counts and
realtime work for its messages unchanged.

- **On:** `TELEGRAM_BOT_TOKEN` is set. Unset, `telegram.pb.js` registers nothing (the `tg_*` collections stay, empty).
- **Removed:** delete `telegram.pb.js` and `telegram/`. Going down the migration drops `tg_*`. Stand-in users and their
  messages stay, as any user's do.
- **Core changes it needed** were made for themselves: `users.no_dms` (§16.7), and attachments of 10 × 20 MB (§17.1),
  the size of a Telegram album and of the largest file a bot may download.

## 26.2 Settings

All from the environment (`telegram/api.js`):

| Variable | |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot's token from @BotFather |
| `TELEGRAM_WEBHOOK_URL` | this server's public `https://…/api/telegram/webhook`. Unset, the bridge polls (development) |
| `TELEGRAM_WEBHOOK_SECRET` | what Telegram sends with each update; derived from the token when unset |
| `TELEGRAM_API_BASE` | the Bot API server, `https://api.telegram.org` by default (tests point it at a stub) |

On `serve`, the bridge calls `setWebhook` (the URL, the secret, `max_connections: 1` so updates come one at a time
and in order, and only `message`, `edited_message`, `channel_post`, `edited_channel_post`, `my_chat_member` and `message_reaction`, §26.9), or, without a URL, `deleteWebhook` (a bot
with a webhook can't poll). The bot needs **privacy mode off** (@BotFather → `/setprivacy` → Disable) or to be a group
admin, or it sees only commands.

A **channel** links like a group. The bot must be one of its admins (with *Post messages*, to send to it). Its posts
and their edits come as `channel_post` / `edited_channel_post` and show under the channel's stand-in.

## 26.3 Telegram people in the chat

Each Telegram sender (or chat posting as itself: an anonymous admin, a channel) gets a **stand-in user** on their
first message (`tg_people` maps the Telegram id to it):

- Named after them with " (TG)": "Ann Lee (TG)", "Ann Lee 2 (TG)" if taken (names are unique, §22.1), within the 32
  characters. A Telegram name change renames it. While the bridge is on, " (TG)" is theirs alone: signing up or renaming
  to a name ending in it ("(tg)", full-width or spaced too) is refused for anyone but a superuser (QA BUG-86).
- Their Telegram profile picture as its avatar, checked again at most once a day.
- `no_dms` set (§16.7): nobody can open a DM with them, and their names have no **Message** menu.
- An address at `telegram.invalid` and a random password: nobody can log in as one.
- They appear in user search like anyone (e.g. to add them to a private room). A stand-in writing in a private room is
  made a member of it, as the messages hook requires (§23).

## 26.4 Telegram → chat

`POST /api/telegram/webhook` (the secret checked, in constant time; any update that fails is logged and answered 200, so Telegram
doesn't hold the next ones back) or polling hands each update to `inbound.js`:

- **A message** in a linked group becomes a message of its sender's stand-in: the text or caption ("↪ Forwarded from
  X" above a forward), and the files, downloaded from Telegram (`getFile`) and saved like uploads: photos (the largest
  size), videos, documents, audio, voice, video notes, GIFs, static stickers. A file over 20 MB, an animated sticker, a
  location, a contact, a poll or a dice becomes a line of text saying what it was.
- **A download that fails for now** (no answer from Telegram: a network that drops a connection now and then) is
  tried again at once (`getFile` within 10 s, the file within its transfer time, `api.js` `transferTimeout`). Failing
  twice, the message isn't brought over without the file: its Telegram messages wait in `tg_queue` (a `fetch`,
  `1760000056_telegram_fetch.js`) and the worker tries again, as it does sends (§26.7), and brings it over with its
  files, so it shows after what came meanwhile. An edit while it waits edits what it brings over, and Telegram
  delivering it again doesn't queue it twice. Only on its last try, or when Telegram refuses the file (4xx), does a
  file become "[photo_1.jpg: couldn't be brought over from Telegram]". Before, any failure did at once.
- **A rich message** (Bot API 10.1, `rich_message`: headings, lists, tables, quotes…) has no text or caption: its
  blocks become plain text (`rich.js`; the room has no markdown, §5): a heading as its line with a blank line above
  it, list items with their labels ("1.", "•", ☑/☐), table rows as cells joined by " | ", quotes as "> " lines, a
  link as its text and address. Its photos, videos, documents, audio and voice notes come over as the message's
  files, their captions in the text where they were. Before this, a rich message was taken for a service message
  and left out without a word.
- **A long message** (Telegram takes 4096 characters, a chat message 2000) comes over as **several messages**, in
  order, instead of cut: each ends at a line break, else a space, in its second half (a text with neither is cut at
  2000). The first has the files and the reply; the rest follow under the same stand-in. `tg_messages.part` (0, 1, 2…;
  `1760000034_telegram_parts.js`) maps them all to the Telegram message, so none goes back to the group, and an edit
  gives each part its new piece: a shorter text deletes the parts left over, a longer one adds parts (after what came
  since). Deleting a later part in the room leaves the Telegram message there; deleting the first deletes it, as for
  any message.
- **A reply** to a message the bridge knows (either way) replies to it in the room.
- **A quote** is part of the text, since the room has no quotes of its own: what a reply quotes comes over its text as
  "> " lines (cut to 500 characters). "↩ In reply to X" goes above it when the room can't show the reply itself (a
  reply to a message the bridge doesn't have), and above any reply to another chat's message (`external_reply`, such
  as a channel's post), quote or not. Edits keep these lines.
- **An album** comes as one update per item. The items wait in `tg_queue` and become **one message** (up to 10 files,
  the caption as its text) when the next update from that group comes, or when the album has been quiet for 1.5 s (the
  worker checks every second).
- **An edit** edits the message's text. Telegram doesn't tell bots about **deletes**, so a message deleted in Telegram
  stays in the room (a known limit).
- The same update delivered twice (a webhook retry) comes over once (`tg_messages` knows it).
- The message and what it maps to are saved in one transaction, so the worker never sees a message from a group
  without knowing it came from there.
- Joins, leaves, pins and title changes are left out, as is any service message with nothing to show (a new group
  photo, a timer, a topic): those make no stand-in (QA BUG-88). In a private chat with the bot, it says it works in groups.

## 26.5 Linking

`tg_links` has a row per group: `chat_id`, `title`, `room`, `enabled`, `anonymous` (§26.6). When the bot is added to a group (or first
hears from it) it makes the row, disabled and without a room, and posts the group's chat id. **A superuser links the
group in the admin UI** (*Collections → tg_links*): pick the room, tick `enabled`. `/chatid` (or `/start`) in the group
says whether it is linked. A DM can't be linked, a link can't be enabled without a room, and a group that removes the
bot is disabled. A room may be linked to several groups: each one's messages go to the others too. A group that
becomes a supergroup (a new chat id) keeps its link and its queue, whichever of Telegram's two notices (in the old
group, in the new) comes first (QA BUG-89). Its `tg_messages` stay with the old id: the supergroup numbers its messages afresh, so the old ids would stand for its new ones (QA BUG-257). A mapping is checked against the Telegram message's date too (one made over 5 minutes before it was sent is stale and gives way), and a send's mapping replaces any row with the id Telegram just gave; a failure to record it is logged, never retried (that resent the message). An archived room, or a disabled link, passes nothing either way.

The room says when a group starts or stops passing messages to it, in a service message (§5.3): "Telegram group "Friends" was connected to this room." when a link gets enabled with a room (created so, ticked, or moved to it), "… was disconnected from this room." when it stops (unticked, moved to another room, or deleted), and "… was disconnected from this room: the bot was removed from the group." when the group removes the bot. An archived room is told nothing. A title change or a group becoming a supergroup says nothing. The title is tidied like a name (no bidi overrides or line breaks), and a blank one reads "A Telegram group". The same news delivered twice at once (the bot removed, a link unticked) tells the room once: the link is read again in the save's transaction.

## 26.6 Chirkle → Telegram

The messages hooks only **queue** the work (`tg_queue`, in the same transaction as the save): a new message, an edit
of the text, a delete, for each group the room is linked to. The worker sends it, so nobody's request waits for
Telegram (`outbound.js`):

- **The message** goes as the bot, with the author's name in bold over the text (Telegram HTML, escaped): "**Bob**
  hello". A forward says "*forwarded from Ann*" and shows its original's text and files (§21.3).
- **Anonymous links:** a link with `anonymous` ticked (admin UI, next to `enabled`;
  `1760000035_telegram_anonymous.js`) reposts to its group without the header: no author's name and no "forwarded
  from", only the text and files, so the whole 1024 characters are the caption's. Its edits follow the same way; the
  setting is read at each send and edit, so changing it affects what comes next, not what was sent. A forward with
  nothing left to show (its original deleted) isn't sent. It only changes what goes to that group: other groups of
  the room, and what comes from Telegram, are as before.
- **Files:** photos (jpg, png, webp up to 10 MB, Telegram's photo limit) and videos (mp4, m4v, mov; sent with `supports_streaming`, so they play inline as they load) go together as an album,
  other files as a second album of documents (Telegram doesn't mix them); one file goes alone. The text is the first
  item's caption when it fits (1024 characters), else a message of its own before the files. Files keep their original
  names. A message whose only file is a WebP of at most 512 px a side (a sticker, from Telegram or a collection) sends
  it as a sticker: Telegram makes photos JPEGs, which would lose its transparency. A sticker takes no caption, so the
  text goes before it.
- **A reply** replies to the Telegram message of what it answers, when that is in the group.
- **Edits** edit the Telegram message holding the text (or the caption, its text cut to 1024 characters with "…" when
  the edit made it longer: QA BUG-87). **Deletes** delete the Telegram messages;
  bots can delete their own only for 48 hours, so an older one is edited to "*Message deleted*" instead.
- A message from a group isn't sent back to it.
- Not passed on: service messages (§5.3), and a forward's later changes when its original is edited. Reactions: §26.9.

## 26.7 The worker

A cron job (`* * * * *`) starts `worker.js`, which runs for 57 s, once a second: it brings over albums that are
complete, then sends what is queued, oldest first (polling Telegram first, when there's no webhook). One run at a time
(a lock in the app store, renewed after every item; a run that took over a stale lock is the only one to let it go,
and the slow one stops at its next item). Each queued send is claimed first (`locked_until`, 10 min, in a
transaction): even two passes at once never send one twice (QA BUG-147). An album item delivered twice is brought
over once, not making the album's save fail. A failure that may pass (no answer, 5xx, 429) is retried after `retry_after` or 2, 4, 8…
seconds, up to 8 tries, and holds back that group's later items so they arrive in order (a `fetch` from a group
holds back only the group's other fetches, not what goes to it); one Telegram refuses for good (4xx) is dropped and
logged. `POST /api/telegram/tick` (superusers) runs one pass at once.

A send is in **steps**: the text alone (when it isn't a caption), then each album. The queue row keeps how many were
sent (`payload.done`), so a send that fails halfway sends the rest when tried again, neither the steps already in the
group nor nothing more (before, it was left there, its other files never sent). A failure that **may have sent** what
it asked (no answer once the request may have reached Telegram: a timeout, a connection lost or reset; `api.js`
`maybeDone`, unlike no connection made at all) is tried again **once**, then dropped and logged ("may have been sent"):
each such try may post it twice, and 8 of them did, on a network that drops connections. An upload may take its
transfer time (30 s, plus 1 s per 200 KB, up to 5 min), not a fixed 5 min, which held the worker past its lock ("worker
took too long, another run took over") and the group's later messages with it.

The server (`server/outgoing.go`) closes idle outgoing connections after 30 s and pings an HTTP/2 one that has
received nothing for 15 s, closing it when no answer comes in 10 s: Go's default client kept idle ones for 90 s and
never checked them, so a connection a network path dropped silently was reused and its request waited out its whole
timeout ("context deadline exceeded").

## 26.8 Tests

`tests/integration/telegram.test.ts` starts its own PocketBase with the bridge on, against a stub Bot API
(`tests/support/telegram.ts`: records calls, serves files, queues updates, fails on demand). The harness never passes
the developer's own `TELEGRAM_*` variables to a test server. Covered: setWebhook and the secret; a new group's link
and `/chatid`; links only for rooms; a stand-in (name, picture, `no_dms`); files, an album as one message (by the next
update, and once quiet), files too large; replies, edits and a repeated delivery; a stand-in joining a private room; a
message, reply, edit and delete going out; an anonymous link's (no header, a whole caption); service messages for a group connected, disconnected, moved, deleted and removing the bot; files going out as an album with a caption plus documents; a room linked to
two groups; retries in order and dropping; downloads that fail for now (brought over later, edited meanwhile, or saying
so on the last try); a send failed halfway sending the rest; a send whose answer was lost (`drop` in the stub) tried
once more, not 8 times; nothing while disabled or archived; polling; reactions both ways (§26.9).

## 26.9 Reactions

`telegram/reactions.js`, on both sides. Telegram tells a bot about reactions only in groups where it is an
**admin** (`message_reaction`, asked for in `allowed_updates`); elsewhere nothing comes and nothing changes. Neither
side's reactions copy the other's exactly: a Telegram reaction is one person's, and the bot can show only one of its
own on a message.

- **Telegram → chat:** each update says what one person's reactions on a message were and are now. The ones added
  are added to the message under their stand-in (§26.3; made on their first reaction if they never wrote), the ones
  taken back are taken back, read and saved in one transaction like the reactions route (§20.2). Each comes over as
  one of the picker's emoji (§20.1), none left out: Telegram's "❤" is "❤️" (no variation selectors there), a shrug of
  either gender is "🤷"; those the picker hasn't got are the nearest it has (`SIMILAR`: "🕊" is "🐦", "🫡" is "🙇",
  "❤‍🔥" is "❤️"…); an emoji Telegram may add later is itself without its skin tone, or the first part of a sequence
  the picker has ("👩‍🚀" is "👩"); a custom emoji is the emoji it stands for (`getCustomEmojiStickers`), a paid star
  is "⭐", and whatever still has no match is "❤️", Telegram's default reaction. Two that come out the same are one
  reaction. A reaction on any of a message's Telegram messages
  (an album's items, a sent text and its files) is on that message; on a long message that came as several (§26.4), on
  its first part. A reaction by an anonymous admin or a channel is the chat's stand-in's. A channel's reactions are
  anonymous counts (`message_reaction_count`), which name nobody: they are not asked for.
- **Chat → Telegram:** the bot sets its own reaction (`setMessageReaction`) on a message's first Telegram message
  in each group it went to or came from: the emoji most of the room's own people reacted with, the first used of
  those as many, among Telegram's reaction emoji ("❤️" sent as "❤"); none (an empty list) when nobody's is left.
  Stand-ins' reactions (Telegram people's, from this or another group of the room) don't count: they are in their
  group already. A `react` op is queued (`1760000043_telegram_reactions.js`) only when that pick changes, and not
  again while one for the same message and group waits: it sends what the reactions are when it goes. A group that
  doesn't allow that emoji refuses it (4xx), dropped and logged as any send (§26.7).
- Telegram doesn't send a bot its own reactions, so nothing comes back.
