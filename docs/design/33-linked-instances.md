# §33. Linked instances

Part of the design document: [index](../DESIGN.md).

Two or more servers running this app, **paired by their admins**, share rooms and let their people write DMs to each
other. Ann on `a.example` and Bob on `b.example` talk in one room, each signed in on their own server, each server
keeping its own copy. Nothing else is shared: media collections (§31), unread state, search, drafts and settings stay
local. Built on 2026-10-24: server, web and Android (§33.13 says where the build settled what the plan left open).

## 33.1 The model: every shared room has a home

- **A shared room lives on one instance, its home** (where it was made). Each instance it is shared with keeps a
  **mirror**: an ordinary `rooms` record with ordinary `messages`, so the room view, realtime, unread counts, search,
  previews, the media grid and notifications (web and Android) work on it unchanged.
- **The home decides the room's state:** who sees it, who posts, its name, archiving, and the outcome of every edit,
  delete and reaction. A change made on a mirror goes to the home first. The home applies it and sends the result to
  every mirror, its sender included. A mirror applies only what its home sends.
- **Order is each instance's arrival order.** A message is shown on its own instance at once (optimistic send as
  now) and goes to the home, which passes it on. Two messages written within the same second can show in a different
  order on different instances; for chat that is fine, and it spares the event graphs and conflict resolution that
  make Matrix heavy.
- **A home that is down** leaves its mirrors readable. Their people's messages show locally and wait in the queue
  (§33.8) until the home answers. Edits and reactions wait too.
- **Why not Matrix:** a Matrix homeserver is far more work than this whole section. A Matrix bridge (like §26) would
  need a Synapse server running next to the app. Matrix is the route only if reaching people outside this app is the goal.

## 33.2 A module apart

Like the Telegram bridge (§26.1): `pb_hooks/federation.pb.js` registers its routes, worker and `fed_*` hooks (its parts of
the core's hooks are called from `main.pb.js`, §5.6), its code is in
`pb_hooks/federation/`, its collections are `fed_*` (`pb_migrations/1760000032_federation.js`), and the core gets only
the fields below. It saves messages, rooms and users through the same hooks as everything else, so text limits,
attachment limits, access checks, unread counts and realtime apply to what comes from a peer.

- **On:** a superuser ticks `federation` on the `site` record (hidden; migration `1760000033_federation_requests.js`).
  This server's origin is PocketBase's own **Application URL** (*Settings → Application*), which admins set anyway for
  email links: no environment variable. Ticking it is refused while that URL isn't a public `https://` address
  (PocketBase's default is `http://localhost:8090`). The URL's host is in every global id the peers keep (§33.6), so
  changing it is refused while any `fed_peers` row exists. Off, the `/api/fed/` routes (and `/api/chat/remote-users`)
  answer 404, the worker doesn't run, and no peer can be added. The record hooks are always registered, but skip at
  once while `fed_peers` is empty (a flag in the app store, asked again after each create and delete).
  `FEDERATION_ALLOW_PRIVATE=1` (http, 127.0.0.1) stays an environment variable: tests and development only. A server
  that ran with the first build's `FEDERATION_ORIGIN` gets it as its Application URL, and `federation` ticked, from that
  migration. An old Application URL that could never be linked with (the default) may be changed while paired.
- **Core fields:** `users.peer` and `rooms.peer` (relation → `fed_peers`, empty = local; hidden), `rooms.remote_id` (the
  room's global id at its home; hidden), `messages.remote_id` (the message's global id; hidden). The last is unique
  per room, which makes every delivery idempotent. Two for the clients: `users.instance` (a stand-in's host, shown on
  their name) and `rooms.shared` (`{ home, with, down }`: who else holds the room, §33.10). Only the module sets
  them: the API rules refuse them in requests.

## 33.3 Pairing (admins only)

`fed_peers`: `origin` (`https://b.example`, unique), `label` (1–8 characters chosen by the admin, e.g. `B`, used in
names, §33.4), `secret` (hidden), `status` (`invited` / `requested` / `active` / `suspended`), `dms` (bool: people may
open DMs across, §33.5), `invite`, `invite_expires`, `name` (the peer's site name), `last_ok`, `last_error`.

No code passes between the admins (changed 2026-10-24; the first build had the admin of A hand B's admin a code). The
code only ever proved that whoever finishes the pairing is the instance A's admin named, and A can deliver it there
itself: it sends it only to the origin typed in, over HTTPS.

1. **Asking:** a superuser on A adds a row for `https://b.example` (and a label). Before it is saved, A makes a
   one-time code (in `invite`, valid 7 days) and sends it with its origin and site name to
   `POST https://b.example/api/fed/request`. If B refuses for good (linking off there: 404; it lists A already: 409),
   the row isn't saved and the admin sees why. If B can't be reached, the row is saved `invited` with `last_error`,
   and the worker sends it again every 30 s of its runs (and on every tick) until it is delivered (`last_ok`).
2. **Checking:** B doesn't take A's word for who it is. Before saving anything it asks back:
   `POST https://a.example/api/fed/verify { origin: B, code }`, answered 200 only if A has an open request to B with
   that code. A request claiming to be someone else's never shows. (A's row isn't saved yet while it waits for B's
   answer, so A also keeps the code in the app store for that time.) B then saves a `requested` row, with a label
   suggested from A's host (`chat.acme.org` → `acme`, made unique) and `dms` off. At most 20 requests wait at once.
3. **Accepting:** B's superuser sets the row's `status` to `active` (choosing the label and `dms`). B calls
   `POST https://a.example/api/fed/pair` with the code and a new random 256-bit secret, over HTTPS. A checks the code
   (constant time, once, not expired), stores the secret and answers with its site name. Both rows become `active`.
   A requested row can only become active; an invited one only by the other side accepting.
4. **Both asking:** if B has an open request to A when A's arrives (checked as in step 2), B answers with its own code,
   and A pairs with it at once, as B's admin accepting would.
5. **Declining and withdrawing:** deleting a pending row tells the other side (`POST /api/fed/cancel`, with the code):
   a withdrawn request's row goes there; a declined one's row says "b.example declined." for its admin to delete.
   Requests nobody answers expire after 7 days: the requested row goes, the invited one says so.
6. **Unpairing:** either admin deletes or suspends the row (§33.7). Pairing again makes a new secret, which is how
   the secret is rotated.

Nobody but a superuser can pair, and an instance answers server requests only from active peers.

## 33.4 People from other instances

Each remote person who shows up in a shared room or a DM gets a **stand-in user**, as Telegram senders do (§26.3).
`fed_people` maps (peer, their id there) to the stand-in (`kind` `standin`). Its `known` rows note which of this
instance's own people (or stand-ins it relays) each peer was told of: they are the ones a `user` event goes to.

- **Named** with the peer's label: "Ann (B)", "Ann 2 (B)" if taken (names are unique, §22.1), within 32 characters.
  Their profile name and avatar follow theirs (a `user` event, §33.6). While a peer is paired, names ending in its
  label are refused to everyone but superusers, as " (TG)" is.
- **They can't log in:** an address at `federation.invalid` and a random password.
- **`users.peer`** marks them. The UI shows their instance (`b.example`) on their profile and in the name menu.
- **DMs:** `no_dms` follows their own setting on their instance (§33.6), so DMs with them work (§33.5).
- **People from a third instance:** with A as the home, a room shared with B and C shows C's people on B too. B may
  not be paired with C. Then A vouches for them: B's stand-in is keyed by (A, `id@c.example`), and the label is
  `c.example` cut to 12 characters. DMs with them are impossible from B (`no_dms`), since B has no pairing with C.

## 33.5 Shared rooms and DMs

**Sharing a room: admins on both sides choose.** Room creators and other users can't share a room. Only the
superusers of both instances can, as with pairing (§33.3) and Telegram links (§26.5). `fed_shares` has a row per (room,
peer) on both instances: `room`, `peer`, `remote_id`, `state` (`offered` / `active` / `ended`).

1. A superuser on A (the home) adds a row in the admin UI (*Collections → fed_shares*): the room and the peer. A
   sends `share` to B.
2. B's row appears as `offered`, with the room's name, kind and visibility, and no mirror yet. A superuser on B
   accepts it by ticking `accepted`. B makes the mirror and answers, and both rows become `active`. Declining deletes
   B's row, and A's row then ends.
3. The mirror is named after the home's room plus the label ("general (A)"), numbered if the name is taken. B's
   admin may rename it. That name is local to B; the home's renames still come through and replace it.

**Any room can be shared**, whatever its visibility (§23):

- **Public:** every signed-in person on B sees the mirror, as on A.
- **Private:** only members see it on any instance. The home keeps the one member list, and **each side's admins
  manage their own people** in it:
  - **On the home (A),** the room's creator manages members as now (§23.2). Once the room is shared with B, the
    creator can also add B's people by full address ("bob@b.example", looked up on B, below). Only peers the room is
    shared with are looked up, so a creator can't take a private room to an instance the admins didn't choose. The
    creator can also remove anyone, B's people included.
  - **On a mirror (B),** B's superusers add or remove **B's own people** by editing the mirror's `members` in the
    admin UI. The rooms hook lets that edit through only for a superuser, only on a mirror, and only for local users:
    stand-ins of other instances can't be added or removed from B. The edit shows on B at once and goes to A as a
    `members` request (§33.6). A applies it unless it breaks a rule (the 100-member limit, a person B doesn't own,
    the room archived or no longer shared). A then sends the room as it now is to every mirror. If A refused, B's
    list goes back to A's, and the reason is logged in `fed_shares.last_error` on B.
  - **Nobody else on B** can change the mirror's members: B's users can't, members of the room included, and B's
    admins can't touch A's people or another peer's.
  - Remote people can be writers (§23.6) like anyone, but writers are only set on the home, by its creator.
  - On every instance, the room's `members` holds that instance's own people from the list plus stand-ins for the rest,
    so the local access rules apply as usual.
- **Open Air:** the mirror is Open Air too, and guests on either instance read it. Guests never post or react
  (§23.3), so nothing of theirs has to be sent. Changing a shared room's visibility on the home changes every mirror's.

**Ending a share:** an admin on either side deletes the row, or the peer is unpaired (§33.7). The mirror is archived:
it keeps its history and becomes read-only. Both sides get a service message (§5.3): "This room is no longer shared
with A." Remote people are taken out of the home room's members and writers. Sharing again starts a new mirror. The
old one stays archived; nothing is merged.

**DMs** are opened by people themselves, between instances whose admins both ticked `dms` on the pairing. In "New
message", typing a full address `bob@b.example` asks B for that one name
(`GET /api/fed/users?name=bob`, signed). Partial names and lists are not answered, so nobody can enumerate another
instance's people. B answers with the user if they exist and take DMs. A makes the stand-in and the DM room (home A)
and sends `room` to B, which makes its mirror DM between Bob and A's person's stand-in. After that, it is a DM like
any other on both sides. `no_dms` on either end closes it as §16.7 does, and so does either admin unticking `dms`:
DMs that already exist stay readable but take no new messages.

**What a mirror shows** of messages:

| Thing | Across instances |
|---|---|
| Text, edits, soft deletes | Yes, the home applying them (§33.1) |
| Replies | Yes; a reply to a message the mirror doesn't have (before it was shared) shows without its quote |
| Reactions | Yes: the mirror sends add/remove, and the home sends back the message's whole reaction list (§20.1), people as their ids on the home |
| Attachments | Copied: the receiving instance fetches each file (§33.6) and saves the message once they are there, as Telegram albums (§26.4). File tokens, thumbs, posters and the media grid then work locally |
| Forwards into a shared room | Sent as a snapshot: "forwarded from Ann", the original's text and files at the time. The original may be in a room the peer can't see, so its later edits don't follow (unlike §21.3) |
| Service messages | Each instance makes its own; none are sent |
| Reads, hidden rooms, drafts, search, link previews, push | Local, nothing sent |

**Moderation.** The home's superusers can delete any message in the room (as they can any message, §5.6), and its
creator can remove a remote member or take away their posting; the mirrors follow. A mirror's superuser can't change
the room's state, apart from its own people in a private room's members (above), nor the home's people's messages, but
can end the share or unpair (§33.7).

## 33.6 Between servers

**One inbox:** `POST /api/fed/inbox` takes a batch of up to 50 events (256 KB of JSON at most). Every server request
carries:

- `X-Fed-Origin`: who is calling, which must be an active peer.
- `X-Fed-Date`: within 5 minutes of now.
- `X-Fed-Signature`: `hs256(secret, method + "\n" + path + "\n" + date + "\n" + sha256(body))`, compared in constant
  time. PocketBase's JSVM has HMAC (`$security.hs256`) but no public-key signing. With pairs set up by admins, a
  shared secret per pair is as good as a key pair.

**Events** (each has an `id` unique on its sender, so repeats are dropped):

| Event | From → to | Body |
|---|---|---|
| `room` | home → mirrors | name, kind, visibility, posting, members and writers (people as global ids), archived |
| `share` / `unshare` | home ↔ peer | the room's id; acceptance or refusal |
| `message` | author's instance → home → mirrors | ids, room, author, text, `reply_to`, files (name, size, type, a signed fetch path), created |
| `edit` / `delete` | author's instance (or the home, moderating) → home → mirrors | message id, the new text |
| `react` | any instance → home | message id, emoji, add or remove |
| `members` | mirror → home | the room; its own people to add and to remove (global ids). Answered by the next `room` |
| `reactions` | home → mirrors | message id, the whole list |
| `user` | own instance → peers sharing a room or DM with them | name, avatar hash, `no_dms` |
| `unpair` | either way | nothing |

A **global id** is `<id>@<host>` with the host of the instance the thing was made on. Each instance maps it to its
own records (`fed_people`, `rooms.remote_id`, `messages.remote_id`).

**A peer can only do what its people may do:** an author must be one of the sender's own people, or vouched for by
the sender when it is the home (§33.4). A room event comes only from that room's home. A `members` request adds or removes only the
sender's own people, in a private room shared with it. A message must be in a room
shared with the sender, by someone the home's rules let post there (the same `canWrite()`). An event that breaks this
is refused with a 403, which is logged on both sides.

**Our own people speak only here** (QA BUG-172…174): a home relaying a room never writes as one of the receiver's own
people (a `message` whose author is the receiver's is refused), nor edits what they wrote there (a `delete` still
comes through: the home's superusers moderate their room). A DM's two members are set when its mirror is made; later
`room` events don't change them.

**The inbox's answer** gives each event a status of its own: `{ results: [{ id, status, error? }] }`. Each event is
applied in a transaction of its own, so one refused event doesn't undo the others. 200: applied, or a repeat (the ids
taken are kept 3 days in `fed_seen`). 4xx: refused, and the sender drops it and notes why in `fed_peers.last_error`.
5xx: failed for now, and the sender tries it again. The request as a whole fails only for what concerns all of it: a
bad signature (401), a peer not paired (403), one suspended here (503, §33.7), too many events (429).

**Files:** `GET /api/fed/files/{message}/{file}`, signed, served only to a peer the message's room is shared with.
Fetched by the worker, at most 10 files of 20 MB each (§17.1). **Avatars** are fetched the same way.

**Outgoing requests** go through the link previews' fetcher (§28.1, curl, `getent`): only the peer's paired origin,
HTTPS, public addresses only, no redirects, size-capped bodies, and timeouts. `FEDERATION_ALLOW_PRIVATE=1` is for
tests and development only.

**Rate limits:** PocketBase rate-limit rules on `/api/fed/` (600 a minute per client IP, which for these routes is the peer), separate from users' own. The inbox also refuses more than 600 events a minute from one peer, counted in the app's memory.

## 33.7 Suspending and unpairing

- **Suspended:** nothing is sent or accepted. The queue is held, and mirrors show "A can't be reached right now" in
  the room header. Turning the peer back on sends what waited. Its requests are answered 503, so it holds its queue
  too. Mirrors also show it when their home stopped answering: after 3 failed tries in a row, until it answers.
- **Unpaired** (deleted, or an `unpair` event): every room shared with that peer is unshared (§33.5), mirrors are
  archived, and stand-ins are taken out of members and writers. DMs with its people become read-only: the messages
  hook refuses posting to a stand-in of a peer that isn't active, as `no_dms` does (§16.7). Stand-ins and their
  messages stay, as Telegram's do.

## 33.8 The worker

As the Telegram bridge's (§26.7): a cron job every minute runs a 57 s pass. One run at a time. Each item in `fed_queue`
is claimed first (`locked_until`), so it is sent only once. Items go in order **per peer**, batched up to 50 per
request. A failure that may pass (no answer, 5xx, 429) is retried after 2, 4, 8… seconds, capped at 10 min. A peer can
be down for a long time, so items are kept for **3 days** and then dropped and logged. A 4xx is dropped at once and
logged. `fed_peers.last_ok` and `last_error` show the state in the admin UI. `POST /api/fed/tick` (superusers) runs a
pass at once. File fetches for messages that arrived are queued the same way.

## 33.9 What it can't protect

- **A room is only as private as every instance it is shared with.** A peer's admin can read every message of rooms and
  DMs shared with that instance, and could keep messages that were later deleted. No protocol fixes this. The UI says so: a
  shared room's header and access dialog show "Shared with b.example", and adding a remote member says the room's
  messages will be stored there. The admins sharing a private room are deciding that for its members.
- **Deletes are a request**, honoured by a well-behaved peer, not guaranteed.
- **A peer vouches for its own people.** A stand-in is whoever that instance says it is.

## 33.10 Clients

- **Web:** a stand-in's instance in their name menu ("On b.example") and on their name in search results; "Shared with
  b.example" under the room header, with "a.example can't be reached right now" when the home is down; in the access
  dialog, where else the room's messages are kept, people there listed with their instance, and `name@host` to add
  them; `name@host` in "New message" (`POST /api/chat/remote-users`). To pay for it, the access dialog became a lazy
  chunk (≤ 3 KB, §7.7): `app.js` went from 47.9 KB with it to 45.97 KB, and no budget was raised.
- **Android:** the same (ANDROID.md §23). Stand-ins and mirrors are ordinary users and rooms to the app.

## 33.11 Milestones

1. Pairing, signed requests, the inbox, the worker, stand-ins (`user`).
2. Rooms shared by admins (public, private and Open Air), text only: `room`, `share`, `message`, `edit`, `delete`,
   accepting, ending a share, unpairing.
3. Replies and reactions.
4. Attachments and avatars copied.
5. DMs across instances (`name@host` lookup).
6. Backfill: when a share is accepted, the home sends the room's latest 200 messages, files included (until then a
   mirror starts empty, from the moment of sharing).

## 33.12 Tests

Integration tests start **two PocketBase servers** (the harness already starts its own, §9.2) and pair them. Checks:
pairing (a forged request, declining, withdrawing, an undelivered request sent later, both admins asking, an expired
or reused code, an instance with linking off, the Application URL kept while paired); signatures (wrong secret, old date, a replayed id); every event both ways
through a home and two mirrors; a peer acting outside its rights gets a 403 (another instance's author, a room not
shared with it, posting where it may not); a home that is down, then back; suspending and unpairing; files fetched
only by a peer that may; the fetcher refusing private addresses; shares offered, accepted, declined and ended by
admins only (a user's request refused); a private room's members on each side: B's admin adding and removing B's people
(applied on A and every mirror), refused for a user, for another instance's people and over the limit, and put back on B
when A refuses; an Open Air mirror read by a guest on
the peer; a DM by `name@host`, `no_dms` and a pairing without `dms`; names with labels
and their reservation.

## 33.13 As built (2026-10-24)

Where the build settled what the plan above left open:

- **The code** is kept in the row until used (§33.3), not only its hash: the asked side needs it to accept.
- **Per-event answers** from the inbox, a transaction each (§33.6): a batch isn't refused as a whole for one event.
  `fed_seen` holds the ids taken; the rate count is kept in memory.
- **Not sent back where it came from:** the home passes a mirror's message, edit or delete to every other mirror, not to
  the one it came from. Room state and reactions go to every mirror, the sender too: the home's word is final there.
  Saves made for a peer's event are marked (by record id, in the app store) so the hooks don't queue them again.
- **Order:** queue rows carry a sequence number (rows queued in one transaction share a millisecond).
- **A DM with a peer's person** is shared with that peer as it is opened: no admin step, as §33.5 says. Whether DMs
  are possible is the stand-in's `no_dms`: their own setting, or this side's `dms` unticked, or the peer not active,
  or a person only vouched for. So the DM route, the messages hook and the clients need nothing new for it.
- **A mirror's admin edits** go through the rooms update request hook (`checkMirrorEdit`): its name, and in a private
  room its own people as members. Anything else is refused: it is changed on the home.
- **Lookups and remote users:** `GET /api/fed/users?name=&for=dm|member` answers one person by exact name; `for=dm` only
  while `dms` is ticked and they take DMs, `for=member` only while a room is shared with the asking peer.
  `POST /api/chat/remote-users` asks it for a person here and makes the stand-in.
- **Avatars** are served (`GET /api/fed/avatars/{user}`) only to a peer that was told of that person.
- **Tests:** `tests/integration/federation.test.ts` (18 cases, three servers and more where a case needs its own pair:
  everything §33.12 lists but the member limit, which a mirror's own 100-member limit reaches first),
  `tests/component/views/room/linked.test.ts` and the "linked instance" case of `rooms.test.ts` (web), `LinkedTest`,
  `ChatApiTest` and `UiLinkedTest` (Android).
