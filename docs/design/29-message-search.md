# §29. Message search

Part of the design document: [index](../DESIGN.md).

A search button (🔍, "Search messages") in the header of every room and DM opens a bar under it: type, and the
room's messages containing **every word** typed show newest first, 50 at a time ("Show older results"). Picking one
goes to it in the room, highlighted and centred, loading the history around it like a reply's quote (§19.3); the
results make way, and come back when the field gets focus again. Escape or × closes the bar and gives focus back to
the button. Guests can search the Open Air rooms they read.

## 29.1 Data and query

- **`messages.text_key`**: the text folded like names are compared (§22.1: `nameKey`: no invisible characters, NFKC,
  upper then lower case), so "привет" finds "Привет", "strasse" "Straße" and "abc" "ＡＢＣ"; SQLite's `LIKE` alone only
  ignores the case of ASCII letters (QA BUG-55). One step more than names (`searchKey`): "İ" lowercases to "i" and a
  combining dot, which goes, so "istanbul" finds "İstanbul" (QA BUG-113; migration `1760000025_search_dotted_i.js`
  re-keys what was stored before). Set by the hooks after every other change on create and update (`setTextKey`),
  whatever a client sent: empty once deleted. Not hidden, so the list API can filter on it with its
  rules applied (nobody can search a room they can't read); `MSG_FIELDS` never asks for it. Max 40,000 characters (NFKC
  can make a 2,000-character text longer). Migration `1760000024_message_search.js` backfills it with raw SQL.
- **Query** (`searchQuery` in `views/room/search.ts`): a page of the room (§6) with `q`, the words: `kind=latest`, then
  `kind=older` from the last result's `(created, id)` for the next page, as history pages are (§7.5). The server
  (`server/lists.go`) writes `room = {:room} && text_key ~ {:w0} && …`: up to 5 distinct words, folded as `text_key` is
  (`searchKey`; the client folds them too, `foldKey`, to mark the matches), with `%` and `\` (the escape character)
  escaped (QA BUG-34, BUG-112; `_` already is). Until 2026-10-29 the clients wrote that filter; apps then still do with
  a server from before the route.
- **Not found:** forwards (their text is their original's, shown in the answer only, §21.3), attachment names and
  link titles.
- **Cost:** `LIKE '%…%'` can't use an index, so a search reads the room's messages through
  `idx_messages_room_created` until it has a page: a common word stops early; a word in no message reads them all.
  Measured 2026-10-18: a no-match search of a 20,000-message room takes 12 ms in SQLite itself, 30–150 ms through the
  API on the dev machine; a search with a page of matches costs as much as a history page. Past a few hundred thousand
  messages a room, FTS5 behind a custom route (it would have to apply the list rule itself) is the next step.
- **Limit** (QA SEC-4, `server/searchlimit.go`): 20 searches at once per caller (a person by account, a guest by
  IP), refilled one every 2 s; past that the server answers 429 and the clients say "Too many attempts. Wait a few
  seconds and try again." Counted: a page with words in `q`, and a records API list of messages whose filter names
  `text_key` (apps from before the route). Off with the settings' rate limits; superusers aren't counted.

## 29.2 Frontend

`views/room/search.ts` is a lazy chunk like the viewer (§17.7): imported on the first click, types only, and given
`h`, `api.page`, the time format and `goTo` by the room view; if it can't load, the notice says so. Typing searches
300 ms after the last key (Enter at once); a new search aborts the one in flight. A result is a button: author, time,
and the text on two lines starting shortly before the first match, matches in `<mark>` (built with `h`, never HTML).
The field is a `role=searchbox` text field (not `type=search`: browsers add their own clear "×" next to Close,
QA BUG-114) in a `role=search` region, the count in a `role=status` line ("3 messages found.",
"50+ messages found.", "No messages found.", "Couldn't search. Check your connection."). Results don't follow live
changes; searching again does.

## 29.3 Tests

- **Integration** (`search.test.ts`): `text_key` follows create, edits and deletes and ignores what a client sends;
  every word in any case, Unicode included, newest first, one room only (each search also through the old filter, which
  must find the same); the server folds and splits what it is sent; paging from a cursor; `%` and `_` literal;
  deleted messages not found; nothing found in a DM or private room you aren't in, guests only in Open Air rooms.
- **Unit** (`views/room/search.test.ts`): folding, words, the query, snippets; in the room view, results, going to
  one far back in history, the empty state, "Show older results", Escape.
- **E2E** (`search.spec.ts`): a Cyrillic search in any case goes to a message 200 back (axe: no serious violations);
  a DM's search finds only its own messages.
- **Perf** (`tests/perf/scale.ts`): a room searched for a word in none of its messages, and for one in all.
