# §32. Jump to

Part of the design document: [index](../DESIGN.md).

**Ctrl+K** or **Ctrl+P** (⌘K, ⌘P on a Mac) anywhere in the app, the composer included, opens a "Jump to" dialog: a
field and the rooms, DMs and collections you can go to. Typing narrows the list; ↑/↓ choose (wrapping), Enter or a
click goes there, Escape, a click outside or the shortcut again closes it. The browser's own meaning of those keys
(the search bar, printing) is prevented; Ctrl+Shift+P (a private window) and anything with Alt are left alone. On a
layout that types no Latin letter there (Cyrillic: Ctrl+Л) the key's place counts (`KeyK`, `KeyP`). Guests jump
between the Open Air rooms. The dialog is a lazy chunk: what is typed while it first loads goes to its field once it
shows, not to the composer behind it (where Enter would send it), and Escape meanwhile gives it up (QA BUG-205).

- **What is listed:** the sidebar's rooms, open DMs (titled after the other member, with their avatar) and your
  collections and those you follow, from the store: no request. Hidden and archived rooms are found when typed for,
  marked "Hidden" / "Archived", after the others that match as well. Unread rooms and collections with new items
  carry the sidebar's badge.
- **With nothing typed:** most recent first, by the later of a DM's latest message (`last_message_at`; rooms have
  none, §16), a collection's latest item or a room's creation, and when it was last open in this tab (`app.ts`
  notes it as you go, forgotten on reload and when the session changes); the page you are on last: Ctrl+K Enter goes
  back to where you were before. A room whose only time is its creation (never opened here, no latest message) comes
  after all the others, so someone's new room doesn't come before the one you left (QA BUG-268); so does a collection
  with nothing in it, never opened. At most 50 shown, where you are still last.
- **Matching** (`matches` in `views/switcher.ts`): names folded (case, accents, width: "ete" finds "Été"), a leading
  `#` or `@` ignored. Best first: the whole name, its start, a word's start (`ops` in `dev-ops`), inside a word, then
  its letters in order (`gnrl`); then not hidden or archived, then most recent.
- **Accessibility:** a modal `<dialog>` named "Jump to"; the field a `combobox` controlling a `listbox` of options,
  the chosen one by `aria-activedescendant`, so focus stays in the field; "Nothing found." in a `role=status` line.
  Closing gives focus back to where it was; going to a room focuses its composer as usual (§22.5).
- **Loading:** `views/switcher.ts` is a lazy chunk like search (§29), imported on the first press and appended to the
  app's root (removed with it). Types only; `app.ts` gives it `h`, the store, `roomSections`, `unreadCount`,
  `otherMember`, the visibility icon, the avatar, `navigate` and when each page was last open. It closes when the
  session changes (logging out, another account), and a held-down shortcut doesn't toggle it on every repeat. Its few styles are the forward dialog's (§21.3) plus
  a chosen option, in `selection.css`.
- **In the sidebar** (2026-11-10, from the "Chirkle sidebar – Jump to redesign" canvas): the first row, over
  Mentions & replies, set like the room rows (a search icon for the `#`, "Jump to…", the shortcut in a `kbd` on the
  right, brighter on hover), not a search field under the site's name. It is kept across redraws, so it keeps focus
  when the Mentions & replies count changes; a guest has it over the Open Air rooms. On a narrow screen it is hidden:
  the app bar's search icon opens Jump to there (and the Android app's search pill, which this didn't change).

## 32.1 Tests

- **Unit** (`views/switcher.test.ts`): folding, ranking, the empty-query order (most recent, current last, no hidden
  or archived), `#`/`@`, notes and badges; the dialog: focus, arrows wrapping, Enter, click, "Nothing found.",
  opening again starts empty. `app.test.ts`: Ctrl+K from the composer (by key place on a Cyrillic layout), ⌘P again
  closes, a repeat ignored, Ctrl+Shift+P and plain K ignored, Enter goes to the room, Ctrl+K Enter back to the room
  before (a newer room never opened notwithstanding), closed on logout, nothing after the app stops.
  `views/rooms.test.ts`: the sidebar row comes first, opens Jump to and keeps focus while the inbox count changes.
