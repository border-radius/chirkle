# §19. Replies

Part of the design document: [index](../DESIGN.md).

Any message in a room or DM can be answered with a reply that quotes it. Clicking the quote shows the original,
wherever it is in the history.

## 19.1 Data model

`messages.reply_to`: an optional relation to another message (max 1, no cascade). Messages are only ever
soft-deleted, so the relation never dangles: a reply to a deleted message quotes "Message deleted".

- **Set on create only.** The update rule adds `@request.body.reply_to:isset = false`, and `beforeMessageUpdate`
  refuses any change to it, as to `author` and `room` (backing up the rule, field modifiers included).
- **Same room, not deleted** (`assertReplyTarget` in `pb_hooks/lib/messages.js`). Without the room check, a reply could
  point into a DM you aren't in, and its expanded quote would show you that message.
- **Hard deletes still work.** When a superuser deletes a message (or a room) for good, PocketBase clears
  `reply_to` on its replies once the original is gone. `beforeMessageUpdate` lets that one save through
  (`replyTargetRemoved`); otherwise its guards would refuse it, and the delete with it.

## 19.2 API

Every message read (`page`, `getMessage`, `changes`, `send`) expands `author,reply_to.author` and asks for
only what the quote shows: `reply_to`, and the original's `id, author, text, deleted, files` and author's
`id, name` (`MSG_FIELDS` in `api.ts`). The expand follows the messages view rule, which the same-room check makes
always true for someone who can see the reply. `NewMessage.replyTo` sends `reply_to`. Live events don't expand it
(docs/PERF.md §2.3; since 2026-11-09 they come once per message on `chat/messages`, PERF.md §7). The room controller fills the
quote in from the original in its window, or from its own copy of the reply, and fetches the original only when it has
neither.

## 19.3 Frontend

- **Reply** joins Edit and Delete in a message's action pill, on any message that is saved, not deleted, in a room
  that isn't archived (`ctl.repliable`). It shows "Replying to *name* *text*" above the composer (×, or Escape in the
  textarea, cancels) and focuses the textarea. The next send is the reply; the optimistic message quotes the
  original at once (`quoteOf` in `lib/messages.ts`).
- **Ctrl+Up / Ctrl+Down** in the textarea move the reply to the previous / next repliable message in the window and
  scroll it into view; Ctrl+Up while not replying starts a reply to the newest one, and Ctrl+Down past the newest ends
  the reply.
- The reply bar follows the original: edited, it shows the new text; deleted (or the room archived), it closes.
- **The quote** is a one-line button above the reply's text: author name, then the text on one line (or
  "Attachment", "Message deleted"). It uses the window's copy of the original when there is one, so edits and
  deletes show live; otherwise the server's expanded copy. A live reply to a message beyond the window has neither
  until the controller has fetched it: its quote reads "…" meanwhile (QA BUG-180).
- **Replies to you** (someone else's reply to one of your messages) are highlighted (`.to-me`: a rounded card with a faint
  accent tint; until 2026-11-01 also an accent bar on the left), so you can spot them while scrolling.
- **Going to the original** (`ctl.goTo`): if it is in the window, it is highlighted (`.target`) and centred. The
  highlight (here and for `/r/:id/m/:msgId`) holds briefly, fades out, and is dropped after `HIGHLIGHT_MS` (3 s). If not,
  the window is replaced by the history around it (as for `/r/:id/m/:msgId`, §7.5) once that has loaded; the old
  window stays until then. The URL doesn't change, so the composer and anything typed into it stay. Unsent
  (pending or failed) messages the new window drops are kept aside and come back at the live edge. A send
  that completes meanwhile is not added to the history window.
- **The original deleted unseen:** the send fails with a `reply_to` error. The message then says "Not sent: the
  message you replied to was deleted", its quote shows as deleted, and **Send without quote** sends it as a plain
  message.
- The quote's accessible name is "Quoting *name*: *text*", capped at 80 characters, so that it doesn't read a whole
  long message aloud and doesn't start with "Reply" like the Reply button. Escape doesn't cancel a reply while an
  input method is composing.

## 19.4 Tests

- **Integration** (`replies.test.ts`): same-room replies; refused across rooms, into a DM you aren't in, to unknown
  or deleted messages; `reply_to` never changes; a deleted original stays quoted as deleted; the quote comes back
  through send, page, getMessage and realtime with only its fields; field modifiers can't touch `reply_to`; a
  superuser can delete an original or a room holding replies.
- **Unit** (room view): reply bar and send; cancel with × and Escape; stepping with Ctrl+Up/Down; quotes that go to an original on screen and
  one far back in history; a quote and the reply bar following an edit and a delete; no Reply when archived, deleted
  or still sending; archiving ends the reply, and unarchiving doesn't bring it back; Escape while composing; a send
  or a failed message during a quote's history load; a reply to an original deleted unseen; the quote's name; only
  others' replies to your messages are highlighted.
- **E2E** (`replies.spec.ts`, light and dark): Bob replies to Ada and she sees the quote live; Ada replies to a message
  far back in history, and Bob's click on the quote loads that history and highlights it; axe finds no serious
  violations in the reply bar or the quotes.

## 19.5 Back to the reply (2026-11-11)

Following a quote took you away from where you were reading, with no way back but scrolling. Now the controller
remembers the reply whose quote was clicked (`ctl.goTo(id, from)`), once the original is shown, on a stack: following
the quote of the message gone to, and so on, adds each reply in turn. While the stack holds one, the pill over the
bottom of the list (§7.5, §22.7) reads **"Back to reply"** (in the quiet style, before "New messages"); each click (`ctl.goBack`) goes to the last reply, highlighted as a quote's original is, and drops
it. Once the stack is empty, the pill is "Jump to latest" (or "New messages") again. A reply deleted meanwhile says
"That message isn't available any more." and is dropped. Jump to latest or Jump to beginning forget the stack; so do
scrolling down to the latest messages (the bottom of the live edge, not of a window back in history: 2026-11-13, the
pill used to stay there with nothing to come back from) and leaving the room. Search results, media and links to messages go to a message without adding to it. At most 50 are
kept (the oldest go first); the same reply twice in a row is kept once.

Tests: `replies.test.ts` (component): a chain of two quotes, one far back in history, walked back step by step to
"Jump to latest"; Jump to beginning forgets it; so does scrolling to the latest messages, not to the bottom of
history. Android: `ServicesTest` (ANDROID.md §67).
