# The console client (`cli/`)

`chirk` connects to a Chirkle server from a terminal: read rooms and take part, everything from the keyboard, and
make an account there too, with no browser. One static Go binary per platform on the Release page: no Node, no
package. Images and videos are shown as links.

It is the third client of the API (docs/API.md), after the web and the Android app: a server change must keep it
working too.

## 1. Shape

A Go module of its own, `cli/` (`github.com/border-radius/chirkle/cli`), in this repo, so its tests read `shared/`.
No PocketBase dependency: its own small REST and realtime client keeps the binary at about 9.5 MB, built with
`CGO_ENABLED=0`. The UI is Bubble Tea v2, Bubbles and Lip Gloss (`charm.land/*/v2`).

```
cli/
  main.go               subcommands: (default) the TUI, login, signup, logout, version
  internal/api/         REST client, sessions, SSE realtime, models          server_test.go: against a real server
  internal/contract/    copy of shared/contract.json's fields and limits     contract_test.go: compared with it
  internal/render/      messages → terminal lines; Clean (§5); links
  internal/config/      saved accounts, drafts
  internal/text/        "@handle" rules                                      mentions_test.go: shared/vectors/mentions.json
  internal/emoji/       emoji by name (names.txt: the web's list)           emoji_test.go: the same as web/src/lib/emoji-names.ts
  internal/jump/        Jump to's ranking and order                       jump_test.go: shared/vectors/jump.json
  internal/ui/          the screens                                          app_test.go: signup → read → send → reply, edit, react, delete, keys only
```

## 2. The API it uses

Nothing the other clients don't use (docs/API.md):

| Need | Call |
|---|---|
| Site, signup policy | `GET /api/collections/site/records` (`title`, `invite_only`, `password_reset`) |
| Sign up | `POST /api/collections/users/records` `{ name, email, password, passwordConfirm, invite_code? }`, then log in |
| Log in, renew | `users/auth-with-password`, `users/auth-refresh` (a 401: the session is over) |
| Forgot password | `users/request-password-reset` (the address in lower case) |
| Rooms, unread | `GET /api/chat/rooms` (`fields.room`), `GET /api/chat/unread` |
| Messages | `GET /api/chat/rooms/{id}/messages?kind=latest\|older\|newer\|changed` (`fields.message`) |
| Send | `POST /api/collections/messages/records` with a client-made `id`, so a retry can't post twice |
| Read marks | `POST /api/chat/reads { room, at }`, only once the newest message is on screen |
| Edit | `PATCH /api/collections/messages/records/{id}` `{ text }` (the author only) |
| Delete | `POST /api/chat/delete { messages }` (yours; anyone's for a moderator, `moderator` read at login) |
| React | `POST /api/chat/reactions { message, emoji, on }` |
| "@" | `GET /api/chat/mentionable?room=&q=` |
| Live | `GET /api/chat/live`, then `/api/realtime`: `chat/messages`, `rooms/*`, `room_reads/*`; `chat/keepalive` ignored |
| Invite links | `GET /api/chat/invites/{token}` (where it goes; 404 for any link that doesn't work), `POST` to it joins |
| New password | `users/confirm-password-reset { token, password, passwordConfirm }` (the emailed `/reset-password/<token>`) |
| DMs | `GET /api/chat/users?q=`, `POST /api/chat/remote-users { address }` (`user@host`), `POST /api/chat/dms { user }` |
| Search | `rooms/{id}/messages?kind=latest&q=` (a 429 says to wait) |
| Mentions & replies | `GET /api/chat/inbox?before=<cursor>`, `POST /api/chat/inbox/seen` |
| Hide, archive | `hidden_rooms` list / create / delete; `PATCH rooms/{id} { archived }` (its creator; a moderator for a public room) |
| Go to a message | `messages/{id}`, then `older` and `newer` pages from it: a window that doesn't reach the latest |

The User-Agent is `chirkle-cli/<version> (<os>/<arch>)`. `/stats` counts these connections as neither web nor
Android until the server learns the name (optional).

Realtime: on `PB_CONNECT` the client posts its subscriptions with its token. A dropped stream (or 5 minutes without
a keepalive) reconnects with jittered backoff, 1 s up to 30 s. After a reconnect it reads the rooms and the counts
again, and for each room loaded the messages after its last (`newer`) and the edits and deletes since the drop
(`changed`).

## 3. Accounts without a browser

- `chirk` with no saved account asks for the server, then shows Log in / Sign up / Forgot password (Ctrl+→ switches).
  Sign up asks for name, email, password twice and, while the site is invite-only, the invite code. The limits
  (name ≤ 32, password 8 characters to 71 bytes) are checked before sending; the server's refusals show under their
  fields. An account made whose login then fails says to log in (not to sign up again).
- Esc on the form reads as a guest: the Open Air rooms; L and S open the form later.
- Scriptable: `chirk signup --server S --name N --email E [--invite CODE] [--password-stdin]`, `chirk login …`.
- `chirk join <link>` joins a private room by its invite link (`https://host/invite/<token>`, or the token alone for the
  saved server), with the account saved for that server. `chirk reset-password [--password-stdin] <link>` sets a new
  password from the emailed link (asked twice); then `chirk login`.
- Sessions: `$XDG_CONFIG_HOME/chirkle/accounts.json` (`CHIRKLE_CONFIG` overrides), mode 0600, written atomically.
  Several servers and accounts can be kept; the TUI uses the current one, or the one for `chirk <server>`. The token
  is renewed at start; a refused one removes the account and brings the form up.

## 4. Keys

Rooms on the left at 90 columns and more; below, one pane at a time. `?` lists the keys.

| Key | Where | Does |
|---|---|---|
| Ctrl+K | anywhere | Jump to a room or DM |
| Tab, Shift+Tab | anywhere | Rooms → messages → composer |
| Ctrl+/, i | | Write (as the web's Ctrl+/) |
| ↑↓ j k, g G | rooms | Move; Enter opens (into the composer when you can post) |
| n | | Next unread room |
| D | | Direct message: a name or @handle (as you type), or `user@server` then Enter |
| I | | Mentions & replies (and reactions to yours), new ones marked ●; Enter goes to the message, ↓ at the end loads more |
| / | messages | Search in the room (Enter searches; the newest 50 hits); Enter on one goes there |
| H, A | rooms (the highlighted) or messages (the open) | Hide / show for you; archive / restore for everyone (asks y/n) |
| ↑↓ j k | messages | Select a message; at the top, older messages load |
| PgUp PgDn, g G | messages | Scroll; first / latest |
| o | messages | The selected message's links and files: 1–9 opens one (`xdg-open`/`open`), Alt+1–9 copies it (OSC 52, works over SSH) |
| r | messages | Reply (a failed message: send it again) |
| e, d, + | messages | Edit yours; delete (asks y/n); react: a name or 1–8 of the quick ones, again takes it back |
| Enter, Backspace | messages | On a reply, go to the original (loaded around it if further back); back to the reply |
| ↓, G | messages, gone further back | At the end, the next messages; the latest (also on sending) |
| ↑ | empty composer | Edit your last message (Esc cancels; saving it empty asks to delete) |
| @, : | composer | People who can see the room / emoji by name, at the end of the text; Tab or Enter picks. A whole `:fire:` becomes 🔥 |
| Enter / Alt+Enter, Ctrl+J | composer | Send / new line |
| Esc | | Back |
| q, Ctrl+C | | Quit |

## 5. Drawing messages

```
Ada · 14:02 (edited)
↳ Bob: the quoted text…
The text, wrapped, links underlined (OSC 8, clickable where the terminal can)
[image] cat.png 640×480  https://host/api/files/messages/<id>/cat_x.png
  ◦ example.org · Link preview title
👍 3  🎉 1
```

Files are links by URL alone (DESIGN.md §37.3), a forward's from its source message (`file_sources`). Also: day
lines, the "New" line over the first unread message, "Message deleted", "↪ Forwarded from", "sending…" and
"⚠ not sent".

**Nothing from the server reaches the terminal raw.** `render.Clean` drops C0/C1 controls (ESC, CSI, OSC, BEL, CR,
backspace), DEL and the bidi controls, from texts, names, room names, previews and file names, before anything is
styled: otherwise anyone who can post could retitle the window, rewrite the screen or set the clipboard. This is the
console's `xss` spec, `render/sanitize_test.go`. (The server already strips ESC from message text; names and other
fields are cleaned here all the same.)

## 6. Tests

- `internal/contract`: the copy equals `shared/contract.json`.
- `internal/render`: Clean, files as links, wrapping within the width, links found in text.
- `internal/text`, `internal/emoji`: the shared mention vectors; the web's emoji list, and finding by name as it does.
- Against a real server, with `CHIRKLE_TEST_SERVER` (and `CHIRKLE_TEST_ADMIN=email:password` to turn PocketBase's
  rate limits off, as `tests/support/pocketbase.ts` does); skipped without it:
  - `internal/api`: signup (and its refusals), login, refresh, a bad token's 401, a room, a send and the same id
    refused, the live event, unread, a read mark, paging order, a guest seeing only Open Air rooms.
  - `internal/ui`: the whole program driven by keys only: sign up on the form, the account saved, Jump to, read,
    send, a live message, the link picker, help; then "@" and ":" completion, a mention, a reply, ↑ to edit, a
    reaction by name, a delete after its question, and a draft still there after a restart; then search and going to
    a message further back, a reply in Mentions & replies, a DM by name, hide and show, archive.

CI's `cli` job builds the server, starts it on an empty data directory, runs all of them, checks gofmt and
cross-builds. By hand:

```sh
bin/chirkle-server superuser upsert admin@example.com adminpassword1 --dir=/tmp/cli-test --migrationsDir=pb_migrations
bin/chirkle-server serve --http=127.0.0.1:8099 --dir=/tmp/cli-test --migrationsDir=pb_migrations --hooksDir=pb_hooks --publicDir=pb_public &
cd cli && CHIRKLE_TEST_SERVER=http://127.0.0.1:8099 CHIRKLE_TEST_ADMIN=admin@example.com:adminpassword1 go test ./...
go run . 127.0.0.1:8099
```

## 7. Release

`release.yml`'s `cli` job, on the same `v<version>` Release as the APK and the npm package: linux, darwin, windows
and freebsd, amd64 and arm64, `-trimpath -ldflags "-s -w -X main.version=<version>"`, as
`chirk_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows) with `chirk_<version>_checksums.txt` and build provenance
(`gh attestation verify <file> --repo border-radius/chirkle`). The version comes from the tag: `npm run release`
has nothing more to set.

## 8. Milestones

1. **Done (2026-11-28):** the client, sessions, sign up / log in / forgot password in the TUI and as commands, guest
   reading, the room list with unread counts and mentions, reading with paging, live messages and reconnect with
   gap-fill, sending with retry, read marks, Jump to (by substring), links and files as links, the release and CI
   jobs.
2. **Done (2026-11-28):** reply, edit, delete and react on the selected message (r, e, d, +), going to a reply's original
   and back; `@` and `:` completion (`mentionable`, the web's emoji names), `:name:` turned into its emoji; ↑ in an
   empty composer edits your last message; drafts kept across runs (`drafts.json` beside the accounts, 0600); "(edited)"
   also on a message under another's header. Left for later: the lists follow the end of the text only, and a quote of a
   message further back than the window says so instead of going there (milestone 3's room controller).
3. **Done (2026-11-28):** `chirk join <link>`, `chirk reset-password <link>`; DMs by name, handle or `user@host` (D);
   search in a room (`/`, not `q`, which quits; its 429 says to wait); Mentions & replies (I); hide and archive (H, A),
   with a Hidden section in the list; going to any message (a search hit, an inbox row, a quote further back) loads a
   window around it, which ↓ extends and G (or sending) leaves for the latest; Jump to ranked and ordered as the web
   (`internal/jump`, `shared/vectors/jump.json`; "opened" kept for the run only). Left for later: replaying
   `window.json`, `room.json` and `unread.json` (the window has no 300-message cap and no "New" line after going to a
   message; the counts are the server's plus live increments), the live `hidden_rooms` topic (read again on reconnect),
   and a successful reset in the tests (it needs the email's token; the refusal is checked by hand).
4. File upload by path, terminal notifications (bell, OSC 9/777) of DMs and mentions, moderator actions, export and
   account deletion as commands, switching accounts in the TUI, `chirk update`.

Left out on purpose: collections, the media grid, avatars (names only), `/stats`.
