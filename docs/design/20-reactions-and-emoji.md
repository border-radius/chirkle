# §20. Reactions and emoji

Part of the design document: [index](../DESIGN.md).

Anyone who can read a message can react to it with emoji, as many as they like up to 20 different ones on a message
(QA BUG-258: before, one person could put all ~1,800 on one message). However many one person adds, they are one row
in the author's Mentions & replies (§41.4, 2026-11-11), and the composer has an emoji button. Decisions: §13 (2026-10-11, reactions and emoji).

## 20.1 Data model

`messages.reactions`: a JSON list with one entry per emoji, in the order each was first used. Each entry holds the ids
of who reacted with it, in the order they did: `[{ "emoji": "👍", "users": ["<id>", …] }, …]`. An emoji nobody uses
any more is removed; `[]` when there are none.

- **Only the route below writes it.** The create and update rules add `@request.body.reactions:isset = false`. The
  create hook sets `[]` whatever was sent, and a request hook (`beforeMessageUpdateRequest`) refuses an update that
  changes it, superusers included. The route's own saves don't go through request hooks.
- **The emoji are the picker's** (`pb_hooks/lib/emoji.js`, the same list as `web/src/lib/emoji.ts`; a unit test fails
  if they drift apart). Anything else is a 400.
- **A soft delete wipes them** with the text and files (§5.6). Edits keep them, and they never set `edited_at`.
- **An edit keeps the stored reactions**, not the ones loaded with the record. PocketBase writes every field on a save,
  so an edit that read the message before a reaction was added would otherwise erase that reaction.
  `beforeMessageUpdate` re-reads them, and the update request runs in a transaction so that nothing can commit between
  that read and the write.

## 20.2 `POST /api/chat/reactions`

`{ message, emoji, on }` → the message, expanded and filtered like a read of it (`?expand`, `?fields`): the caller's `emoji` reaction on `message` is there
(`on: true`) or not (`on: false`). Setting a state rather than toggling makes it idempotent, so a retry or a double
click can't flip it back. The whole message comes back, not just its reactions. A client that patched only the reactions
and took the newer `updated` would hide an edit it hadn't heard of yet (its realtime connection was down), even from
the reconnect refetch.

1. `emoji` not in the set, or `on` not a boolean: 400.
2. A message the caller can't see (the messages view rule, via `canAccessRecord`) is a 404, like one that doesn't exist.
3. In one transaction: read the message, refuse it if it is deleted or in an archived room (400), or if the
   reaction would be its 21st different emoji ("A message can have at most 20 different reactions."; 400 on
   `emoji`, which the web shows under
   the message without Retry and the app as a toast), change the list, save. Because the read and the write share one transaction, two people reacting at the same moment both count.
4. Nothing to change (already there, or not there to remove): no save, the same answer.

Saving the message bumps `updated`. The change therefore reaches every client as a messages `update` event, wins over
older copies in `merge` (§7.5), and is picked up by the reconnect refetch of changed messages. `MSG_FIELDS` gains
`reactions`. Rate limit: 30 per 10 s per IP. The unread counter ignores these updates (only deletes matter to it, §18.3).

## 20.3 Frontend

- **Showing them:** under a message's text and attachments, an emoji and its count per reaction, with no chip around it (2026-11-23: no border or fill, a light
  background on hover only; the first emoji lines up with the text); yours have the count in the accent, bold, and are
  `aria-pressed`, others muted. A smiley-plus (☺+, `.i-react`: a thin face whose circle is open
  where the plus sits) follows them. The tooltip says who: "You, Ada and 2 others reacted with 🎉". Names come from the window's
  authors. Anyone else is looked up (`api.usersById`), with one request for all the unknown names a render needs.
- **Changing them:** clicking a chip adds yours or takes it back. **☺+** ("Add reaction") in a message's action pill, and the same
  after the chips, open the picker; picking an emoji you already used takes it back. In archived rooms the chips show
  but are not buttons, and there is no ☺+.
- **Optimistic:** a change shows at once, as an overlay over every copy of the message (the controller's `reactions(m)`)
  until the server answers. A realtime update made before yours therefore doesn't flicker it away. The requests for one
  message go one at a time, in order, and a change superseded before its request went out is skipped. The server ends
  up with the last choice, in the order the changes were made. A failure shows the reaction as it was, with an inline
  error and Retry. A request that fails after a later change to the same reaction isn't reported, since the later one
  decides what shows.
- **Focus** stays on the chip that changed, or moves to the action pill's ☺+ when the chip is gone (a failure, the last one taken
  back). A message is redrawn whenever it changes, for instance when someone else reacts. When that replaces the
  focused button, focus moves to the new one.

## 20.4 Emoji picker (`ui/emoji-picker.ts`)

One popover per room view, used by the composer's emoji button (it inserts at the caret, replacing a selection) and by
reactions. For the composer it stays open after a pick, with the focus where it was, so several emoji can be put in at
once; Escape, the button again, or clicking elsewhere closes it. A reaction's closes on the pick. A search box at its top finds emoji by name (§20.6). It is a `role="dialog"` named for what it does ("Insert emoji", "Add reaction"). It sits next to its button
(above it when there is room) and spans the screen width on phones.

It is a lazy chunk with the emoji list (§7.7), loaded the first time a room view opens it and given `h` by the room
view, with its stylesheet (`web/styles/emoji.css`), which it links before showing. If it can't be loaded (offline, or a
new version was deployed), the room's notice says "Couldn't open the emoji. Check your connection."

- Category tabs, then a **Recent** row (the last 24 picked, kept in `localStorage`; nothing breaks without storage),
  then the categories, in an 8-column grid. Built on first open.
- **Keyboard:** the grid is one tab stop (roving `tabindex`). Arrow keys move within and across categories, Home and
  End go to the ends, and Enter or Space picks. **Escape** closes it and gives focus back (to the composer, or to the
  message's ☺+). Clicking or tabbing elsewhere closes it, and so does the message it reacts to being deleted (or
  leaving the list) meanwhile (QA BUG-121). A window resize moves it along rather than closing it. On
  Android the page resizes when the keyboard goes away (`interactive-widget=resizes-content`), and opening the picker
  takes the focus from the composer, which hides the keyboard.
- The emoji are toggle buttons (`aria-pressed`) only for reactions, where picking can take one back. For the composer
  they are plain buttons.
- Each emoji button is named by the emoji itself, which screen readers read out by name. Its tooltip is its short
  name (":thumbsup:"), so the names to search or type by can be learnt.
- **Search box** (§20.6): what it finds replaces the categories ("Found", or "No emoji found"), until it is emptied or a
  category tab is clicked. ↓ goes to the first emoji found and ↑ from the top row comes back; Enter picks the first
  found. Escape empties it first, then closes the picker. Empty on every open. With a mouse (`pointer: fine`) the
  picker opens in the search box; on touch screens on the first emoji, as before, so the keyboard doesn't cover it.

## 20.5 Tests

- **Integration** (`reactions.test.ts`): adding and removing several emoji per user; idempotent; text and `edited_at`
  untouched, `updated` bumped; concurrent reactions all count, also against concurrent edits; the answer is the whole
  message, expanded; only the set's emoji and a boolean `on`; 404 for
  invisible messages, 401 logged out; refused on deleted messages and in archived rooms; wiped by a soft delete, kept by
  an edit; clients (and superusers) can't write the field; returned in `MSG_FIELDS` and live; the rate limit.
- **Unit:** the client and server emoji sets match, with no duplicates and one grapheme each; recent emoji (order, cap,
  storage failures); `setReaction` and `reactors`; picker arrow-key steps, opening, picking, Escape and outside clicks;
  the controller's overlay over a stale copy, a superseded failure not reported, the answer bringing an edit that
  realtime missed, and where you can't react. The picker stays open on a resize and isn't a toggle when inserting. Room view: React and pick; chips toggling;
  live reactions from others, with their names looked up; taking one back from the picker; failure and Retry; a
  reaction changed again before the answer; focus, also across redraws and failures; archived and deleted messages; the composer inserting at the caret.
- **E2E** (`reactions.spec.ts`, light and dark): Ada inserts an emoji from the composer's picker, found with its search
  box, then types ":tad" and puts 🎉 in with Enter (§20.6). Bob reacts twice, once
  by keyboard. Ada sees both live, with Bob's name, and adds hers. Reactions survive a reload, and axe finds no serious
  violations in the open picker or the chips.

## 20.6 Emoji by name (`lib/emoji-names.ts`, `ui/emoji-suggest.ts`)

Every picker emoji has a short name, mostly the common shortcodes (`thumbsup`, `heart_eyes`, `tada`), and a few more
words it is found by (`+1`, `like`, `yes` for 👍). The list is one line per emoji in the picker's order, checked
against `lib/emoji.ts` by the unit tests; the Android app has the same lines (`EmojiNames.kt`, ANDROID §53).

- **Finding:** each word of what is typed must begin one of an emoji's words (a short name counts whole and split at
  `_`, so "eyes" finds 😍). Exact names come first, then names that begin with it (shorter first: ":fir" is 🔥, then
  🎆), then the rest in the picker's order. Case doesn't matter; ":fire:" with its colons is found too.
- **In the composer:** ":" and at least two name characters (letters, digits, `_ + -`) just before the caret, at the
  start or after a space or "(", open a list of up to 8 over the composer's row ("12:30", "http://", ":)" and ":D"
  don't). The first is chosen; ↑/↓ choose another (round the list), Enter or Tab puts it in place of ":name" (with a
  space after when it ends the text), a click too. Escape closes it until another ":name" is typed, and so does the
  textarea losing focus. A complete ":name:" that names an emoji becomes it as the second colon is typed. Picked emoji
  join the picker's Recent row.
- **Loading:** `app.js` only spots ":na" before the caret; the room view then loads the picker's chunk (quietly
  nothing when it can't be), whose suggestions follow the textarea from then on. Their keys are caught on the form in
  the capture phase, so the composer's Enter (send), ↑ (edit the last message) and Escape (cancel the reply) don't see
  them. While an input method is composing, the list leaves every key alone.
- **Accessibility:** the list is a `listbox` of `option`s ("🔥 fire"); while it shows, the textarea has
  `aria-autocomplete="list"`, `aria-controls` and `aria-activedescendant` for the chosen option. The focus stays in
  the textarea (pressing an option doesn't take it).
- **Tests** (unit): the names match the picker's emoji, unique and typeable; finding and its order; the token rule; the
  list's keys, picks, the whole ":name:", Escape, blur and IME; the picker's search box (results, keys, Escape, tabs,
  tooltips, chosen marks, focus by pointer). Room view: ":tad" offers 🎉, Enter inserts it rather than sending, then
  sends. E2E: in `reactions.spec.ts` (§20.5), with axe on the open list.
