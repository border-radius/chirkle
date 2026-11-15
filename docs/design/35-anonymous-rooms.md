# §35. Anonymous rooms (2026-11-03)

Part of the design document: [index](../DESIGN.md).

The user asked for "option for anonymous rooms. no ui feature needed, just ability to set room to be anonymous from
admin ui (db). in anonymous rooms all messages are sent by the room name, not users, so nobody knows who posted what".

## 35.1 Data

- `rooms.anonymous` (bool): ticked by a superuser in the admin UI (*Collections → rooms*). The create and update rules
  refuse it from anyone else (`@request.body.anonymous:isset = false`). It never applies to DMs.
- `messages.anonymous` (bool): set by the create hook (`lib/messages.js` `beforeMessageCreate`) from the room as the
  message is posted, whatever the client sent; the rules refuse it in a body. So a message posted while the room was
  anonymous stays anonymous for good, and turning the flag on later hides nothing already seen. Turning it off doesn't
  show who wrote what was posted while it was on. Messages created by the Telegram bridge and by a linked instance go
  through the same hook.
- `messages.forwarded_anonymous` (bool): set the same way on a forward whose original is anonymous.
- `author` and `forwarded_from` still hold the real people. Their authors edit and delete their messages as before,
  and the hooks that check who wrote what (bulk delete, notifications, unread counts) are unchanged.

## 35.2 What is answered

`hide` (`server/anonymous.go`), from the messages enrich hook (`server/enrich.go`) once PocketBase has expanded the record (in
`e.next()`; expansion follows `author` as stored). It covers every answer and live event: the records API, the list
routes (`/api/chat/rooms/{room}/messages`, search, `notifiable`) and realtime. To anyone but the author and superusers:
- `author` is the room's id, and `expand.author` is a users record that is never saved, `{ id: room id, name: room
  name, no_dms: true }`. The clients need no change: the room shows as one author with initials, with no "Message"
  menu, and consecutive messages group under it. The author sees their own messages as theirs.
- A quoted message (`expand.reply_to`) shows the same: its own `reply_to.author` expand was looked up after it hid
  its author, so the replying message's hook fills it in.
- A forward of an anonymous message is "from" the original's room (`forwarded_from` = the room id); a private room's
  name isn't passed on, so a forward of one is "from Anonymous".
- The media grid (`/api/chat/media/{room}`) names the room as an item's author in the same way.
- The room's name is kept in `app.store()` (`anonymous.{room}`), so a page costs one query per room, and forgotten
  when the room is saved or deleted: a rename shows at once.

## 35.3 What can't be asked

Filtering or sorting by `author` or `forwarded_from` would show who wrote what, as would expanding the back-relations
`messages_via_author` and `messages_via_forwarded_from`. Relations reach messages from any collection
(`@collection.messages.author`, `messages_via_room.author`). So `refuseProbes` (the record request hooks: list, view,
create, update and every auth answer; and a middleware on every `/api/chat/*` route, Go or JS) and
`refuseSubscriptionProbes` (realtime subscriptions' options) refuse those with 400. All in Go (`server/anonymous.go`
`bindProbes`), so none of these requests takes a JS runtime (REFACTOR item 61). Quoted values aren't fields. `@collection` filters are PocketBase's
own 403 for anyone but superusers. Two cases are
allowed:
- Superusers.
- An author compared with the caller's own id (`author != {:me}`, `reply_to.author = {:me}`), which says only which
  messages are the caller's. Apps from before 2026-10-29 filter like this (API.md).

The current clients filter on neither field.

## 35.4 Elsewhere

- Telegram (§26.6): a message of an anonymous room goes to linked groups under the room's name in bold, and a forward
  of one says "forwarded from" the room (or "Anonymous"). An anonymous *link* still sends no header at all.
- Linked instances (§33): the room event carries `anonymous`, so the mirror is anonymous when the home is and stamps
  its copies. Only the home changes it. Peers get the real authors in message events, as they must in order to store
  them: an instance is trusted with its people's names. A home from before this sends no flag, so its mirrors aren't
  anonymous.

## 35.5 Tests

`tests/integration/anonymous.test.ts` covers:
- Only superusers set the flag, and clients can't stamp a message.
- Others see the room, the author and superusers see the author, and the author can still edit.
- A rename shows on old messages.
- Messages are stamped when posted.
- List routes, the records API, quotes and the notification check.
- Realtime.
- Refused filters, sorts, expands and subscriptions, while the old app's own-id filter works.
- Forwards out of public and private rooms.
- The media grid.
- DMs never anonymous.

Also `telegram.test.ts` (room name header and forward source) and `federation.test.ts` (the mirror follows the
flag, and only the home changes it).
