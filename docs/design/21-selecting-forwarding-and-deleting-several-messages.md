# §21. Selecting, forwarding and deleting several messages

Part of the design document: [index](../DESIGN.md).

Messages can be selected, one or many, then forwarded to another room or DM, or deleted together when they are all
yours. A single message can be forwarded straight from its action pill. Decisions: §13 (2026-10-11, selecting,
forwarding and deleting several messages).

## 21.1 Selecting

- **Select** in a message's action pill starts selecting, with that message selected. While selecting, every
  selectable message (saved, not deleted: `ctl.selectable`) has a checkbox ("Select message from Ada, …"); a click
  anywhere on a message toggles it too, rather than following a link or pressing a button in it. Selected messages are
  tinted. Single-message actions (the pill, the delete confirm, an open edit box) are gone meanwhile.
- **The selection bar** replaces the composer (which keeps what was typed): "*n* selected", **Forward**, **Delete**
  (only when you could delete every selected message, §7.6.1) and **Cancel**. Delete asks first in the bar ("Delete
  these 3 messages?", focus on Cancel).
- **Stopping:** Cancel, Escape, or unselecting the last message; focus goes back to the composer. A selected message
  that leaves the window, or is deleted meanwhile, is unselected.
- **At most 50** (`MAX_SELECTED` in `lib/limits.ts`, `MAX_MESSAGES` in `pb_hooks/lib/bulk.js`). One more is refused
  with a notice above the list (gone when selecting stops), and its checkbox stays unchecked.

## 21.2 Deleting: `POST /api/chat/delete`

`{ messages: [ids] }` → the messages, soft-deleted, expanded and filtered like a read (`?expand`, `?fields`).

1. 1 to 50 distinct ids, else 400. Any message the caller can't see (messages view rule) is a 404 for the whole request.
2. Any message that isn't the caller's is a 403; any in an archived room a 400.
3. In one transaction, each message not yet deleted is saved with `deleted: true`. The save goes through
   `beforeMessageUpdate` (§5.6), which wipes text, files and reactions as for a single delete; already deleted ones
   are left alone, so a retry succeeds.

Every room member gets the usual realtime `update` per message. The client shows the placeholders at once
(`ctl.removeMany`) and puts the messages back, with a notice, if the request fails. Rate limit: 20 per 60 s per IP.

## 21.3 Forwarding: `POST /api/chat/forward`

`{ messages: [ids], room }` → the new messages, oldest first, expanded and filtered like a read.

1. 1 to 50 distinct ids (400). A target room the caller can't see is a 404, an archived one a 400. Any message the
   caller can't see is a 404, and any deleted one a 400: forwarding never reveals a message you couldn't read.
2. In one transaction, a new message per original, in the originals' order (`created`, then id): `author` is the caller,
   `forward_of` the original (for a forward, the message it shows: chains are one step), `forwarded_from` the
   original's `forwarded_from` or else its author, and `text` empty. Nothing is copied, so a forward is one row however
   big the attachments are. The forwards are `created` a millisecond apart so they keep their order. The saves go
   through `beforeMessageCreate` and `afterMessageCreate` like any message: a DM's members are checked, a closed DM
   reopens for the recipient, and unread counts and realtime follow. A message whose original is deleted or gone is a
   400, like a deleted one.

**Forwards show their original** (`messages.forward_of`, a relation to `messages`, max 1, no cascade):
- *What is shown.* `onRecordEnrich` (`showOriginal`) fills in a forward that isn't deleted with its original's
  `text`, `files`, `file_names` and `edited_at` in every answer and realtime event, expanded replies included (a
  reply to a forward quotes the original's words). Once the original is deleted they are empty, and the client shows
  "The original message was deleted" under "Forwarded from *name*"; a superuser removing it for good clears
  `forward_of` (let through by `beforeMessageUpdate`, as for `reply_to`), with the same result. Nothing is saved.
- *Who may see the original.* The messages **view** rule adds: a forward of this message that isn't deleted is in a
  room the caller can see (an aliased `@collection.messages:fwd` join with "any of" operators, so every condition is
  about the same forward). That covers reading it by id, expanding it and its attachments' URLs (the client signs
  `/api/files/messages/<forward_of>/…`). The **list** rule is unchanged: the original's room, its other messages and
  replies stay hidden, and the routes that act on a message (reactions, forward, delete) check the list rule, so a
  forward's reader can't react to the original or forward it by id. Deleting the forward ends the grant. Read that way,
  the original keeps to itself what would say who is in its room: `keepToRoom` (`onRecordEnrich`) empties its
  `reactions` and `reply_to` for anyone who can't see its room (QA BUG-80).
- *Live.* A reader of the forward can't subscribe to the original's room, so after an edit or delete of a message
  (`changesForwards`), `touchForwards` saves its forwards again (nothing changes but `updated`), which sends them out
  with the original as it is now. Forwards in archived rooms can't be saved: they show it when loaded.
- *The viewer* pages through `files != "[]" || forward_of != ""` (`files:length > 0` before §37: JSON has no length in filters, QA BUG-222): a filter can't see the original's files (relation
  filters apply the original room's rules), so forwards without media are skipped in the client.
- `forward_of` is set only by the route: the create and update rules add `@request.body.forward_of:isset = false`,
  and `beforeMessageCreateRequest` / `beforeMessageUpdate` back that up against field modifiers, superusers included.
  `beforeMessageCreate` checks the original is there, not deleted and not a forward. `MSG_FIELDS` gains `forward_of`.

**`messages.forwarded_from`**: an optional relation to `users` (max 1, no cascade). The create and update rules add
`@request.body.forwarded_from:isset = false`; `beforeMessageCreateRequest` and `beforeMessageUpdate` back that up
against field modifiers (superusers included). As with `reply_to` (§19.1), `beforeMessageUpdate` lets PocketBase
clear it when a superuser deletes the user it names. `MSG_FIELDS` gains `forwarded_from` and its expanded `id` and
`name`; the message shows "Forwarded from *name*" above its text. Rate limit: 20 per 60 s per IP.

**A forward can't be edited**, only deleted: its words are someone else's (they change only when their author edits the
original), and "Forwarded from Bob" must stay true.
`beforeMessageUpdate` refuses a text change on a message with `forwarded_from` (400); the client splits
`ctl.editable` (no Edit button, skipped by Up arrow) from `ctl.deletable` (Delete, the selection bar).

**The forward dialog** (`views/room/forward.ts`) is a modal `<dialog>` named "Forward *n* messages": a search box
that filters your open DMs (most recent first), rooms and hidden rooms by title (a room shows its name after a "#" icon), and also finds people you have no DM
with yet (`api.searchUsers`, debounced); picking one of those opens the DM (`actions.openDm`) first. On success the
dialog closes, selecting stops and the view goes to the target room (or, for the room you are in, says "*n* messages
forwarded"). Messages deleted since the dialog opened, and forwards whose original was, are left out (QA BUG-79); with
none left nothing is sent. A failure, with the server's reason, is shown in the dialog, which stays open to try again.
A forward whose original was deleted has no Forward in its pill. While a forward is on its way the dialog
can't be cancelled (Cancel disabled, Escape refused), and if the browser closes it anyway a failure reopens it: what
happened must be seen. While a people search is pending the status says "Searching…", not "Nothing found."; people
found for an earlier query stay only while they match the new one.

The pill's Forward button has the class `forward` too, so the dialog's styles are scoped to `dialog.forward`.

## 21.4 Tests

- **Integration** (`bulk.test.ts`): a forward can be deleted but not edited; delete several, all or nothing (someone else's message → 403), idempotent, refused
  in archived rooms and for invisible or unknown messages, live for others; forward in order with `forwarded_from`
  and `forward_of` (pointing at the original through a forward of a forward), nothing stored but the pointer, edits and
  deletes of the original showing live, an original removed for good, no files copied and the original's readable
  wherever the forward is (guests in Open Air rooms too, nobody else), the grant limited to that one message and ended by
  deleting the forward, a reply quoting the original's words, the answer expanded like a read, into a DM only for its
  members and reopening it, nothing forwarded from a DM you're not in or of deleted messages, clients (and superusers)
  can't set or change `forwarded_from` or `forward_of`; the rate limits. **E2E** (`attachments.spec.ts`): a forwarded
  image's thumbnail and viewer load from the original.
- **Unit** (room view): selecting by Select, checkbox and click; Cancel, Escape and the last unselect; deleted and unsent
  messages not selectable, one deleted meanwhile unselected; the 50 limit; Delete only for your own, its confirm, one
  request, and a failure putting them back; forwarding a selection in order and going there; forwarding one message to
  someone found by name; a failed forward and forwarding into the same room; archived rooms; forwards have Delete but
  no Edit and Up arrow skips them; the limit notice goes when selecting stops; a forward can't be cancelled halfway and
  a failure is always seen; "Searching…" until the people search answers.
- **E2E** (`forward.spec.ts`, light and dark): Ada selects Bob's message and hers, forwards both to Bob (found by name),
  and Bob sees them live with "Forwarded from"; she then deletes two of her own at once and Bob sees the placeholders.
  axe finds no serious violations while selecting or in the dialog.
