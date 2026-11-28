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
  internal/config/      saved accounts
  internal/ui/          the screens                                          app_test.go: signup → read → send, keys only
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
| Live | `GET /api/chat/live`, then `/api/realtime`: `chat/messages`, `rooms/*`, `room_reads/*`; `chat/keepalive` ignored |

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
| ↑↓ j k | messages | Select a message; at the top, older messages load |
| PgUp PgDn, g G | messages | Scroll; first / latest |
| o, Enter | messages | The selected message's links and files: 1–9 opens one (`xdg-open`/`open`), Alt+1–9 copies it (OSC 52, works over SSH) |
| r | messages | Send a failed message again |
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
- Against a real server, with `CHIRKLE_TEST_SERVER` (and `CHIRKLE_TEST_ADMIN=email:password` to turn PocketBase's
  rate limits off, as `tests/support/pocketbase.ts` does); skipped without it:
  - `internal/api`: signup (and its refusals), login, refresh, a bad token's 401, a room, a send and the same id
    refused, the live event, unread, a read mark, paging order, a guest seeing only Open Air rooms.
  - `internal/ui`: the whole program driven by keys only: sign up on the form, the account saved, Jump to, read,
    send, a live message, the link picker, help.

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
2. Reply, edit, delete and react on the selected message (r, e, d, +); `@` and `:` completion (`mentionable`, emoji names);
   ↑ in an empty composer edits your last message; drafts kept across runs.
3. Invite links (`chirk join <link>`), setting a new password from the emailed link (`chirk reset-password <link>`),
   DMs (also `user@host`), search in a room (`q`, its 429), Mentions & replies, hide and archive; Jump to by
   `shared/vectors/jump.json`, the message window by `window.json`, `room.json` and `unread.json` replayed.
4. File upload by path, terminal notifications (bell, OSC 9/777) of DMs and mentions, moderator actions, export and
   account deletion as commands, switching accounts in the TUI, `chirk update`.

Left out on purpose: collections, the media grid, avatars (names only), `/stats`.
