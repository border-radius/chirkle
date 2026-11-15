# §23. Room access: private rooms and Open Air

Part of the design document: [index](../DESIGN.md).

A room's creator chooses who can see it. Three levels, shown everywhere with the same names and icons
(`VISIBILITY` in `web/src/lib/rooms.ts`):

| Visibility | Icon | Who can read | Who can post |
|---|---|---|---|
| **Private** | 🔒 | its members: the creator and the people they added | its members |
| **Public** (the default, and every room from before) | # | everyone with an account | everyone with an account |
| **Open Air** | 🌐 | anyone, even without an account, while the room isn't archived | everyone with an account |

In any of them but a DM, the creator may also narrow who posts to the people they choose (§23.6).

"Open Air" is the name for a room that is readable from the open web: like a talk in the open air, anyone walking by
can listen in, but you need to step up (sign in) to speak.

## 23.1 Data model and rules

`rooms.visibility` (select `public` / `private` / `open`, required) is new; the migration
(`1760000014_room_access.js`) backfills `public`, and `private` for DMs, which are private to their two members.
`rooms.members` (§16.1) now holds up to 100 users (`LIMITS.roomMembers`), and also lists a private room's members.
The rooms hooks keep it consistent on every save (`setMembers` in `pb_hooks/lib/rooms.js`): a private room always lists
its creator first, each member once; any other room lists nobody (switching away from Private drops the list).

With `MEMBER(r)` = `@auth && (r.visibility != "private" || r.members.id ?= @auth || r.created_by = @auth)`:

| Collection | Rule | Value |
|---|---|---|
| `rooms` | list / view | `(visibility = "open" && archived = false) \|\| MEMBER("")` |
| `rooms` | create | as before; `visibility` may be set, `members` may not (a private room starts with its creator) |
| `rooms` | update | as before (creator only, never a DM), but `members` may now be sent; the hooks check it |
| `messages` | list / view | `(room.visibility = "open" && room.archived = false) \|\| MEMBER("room.")` |
| `messages` | create | `MEMBER("@request.body.room.")` instead of §16.3's condition |
| `messages` | update | as before `&& MEMBER("room.")`: someone taken out of a private room can't edit or delete what they wrote there |
| `hidden_rooms` | create | `MEMBER("@request.body.room.")` |
| `users` | view | `""` (anyone): guests see who wrote a message (`expand=author`: name and avatar; never the email). Listing and searching users still needs a session, so nobody can enumerate the accounts. |

Routes and hooks that check a room themselves use `canSee()` in `pb_hooks/lib/access.js`, which mirrors the view rule:
marking a room read, the unread counts' SQL, and the defense-in-depth check in `beforeMessageCreate` (§16.3). The
reaction, delete and forward routes already check the view rules. Attachments are protected (§17.3) and PocketBase
checks the message's view rule for them, so a guest downloads an Open Air room's files without a file token and
nobody else's.

## 23.2 Changing who can see a room

Only the creator, through the rooms API: `api.setAccess(id, visibility, members)` sends both (members only for
Private). In the room header's menu, the creator gets **Room access…**, a modal dialog (`views/room/access.ts`):
three radio cards, **+ Add people** (the user search of §16.5) above a member list with Remove buttons (not for the
creator), a warning that says what the change does ("Everything ever written here … becomes readable by anyone on the
web", "Everyone else loses it from their list", …), and Save/Cancel. The body scrolls between the title and the
buttons, so a long member list or search never pushes them away. Search results are toggles: someone already in shows
"✓ Added", and picking them takes them out again. Telegram stand-ins (§26.3, `no_dms`) are in neither the list nor the
search, since the bridge adds them itself; saving keeps them as members. Escape in the people search closes the search,
not the dialog. In a private room, the other members get **Members (*n*)**: the same dialog, read-only. The new-room
form has a "Who can see it" select, Public by default.

## 23.3 Guests

Without a session the app no longer starts on the login screen. Every route but `/me` is public; `/login` and
`/signup` are only for guests (`guestOnly`). A guest gets:

- the app bar with **Log in** and **Sign up**;
- the room list with only the Open Air rooms (the server lists nothing else to them), without menus, the new-room form,
  DMs, Hidden or Archived;
- rooms read-only: no composer but "You're reading as a guest. Log in or sign up to join the conversation.", no message
  actions, reactions shown but not clickable, no "Message" on authors, and only "Jump to beginning" in the menu;
- a room they can't see says "This room doesn't exist. Log in to see more rooms, …".

Nothing that needs an account is asked for: no unread counts, hidden rows, file tokens or user lookups. Logging in (or
signing up) from a page goes back to that page; logging out goes home as a guest (an expired or revoked session goes
to the login page instead, and back once logged in). Whoever logs in after a logout starts from home (QA BUG-59).
When the session changes to another user or to none, the realtime connection is closed and a new one opened: on the
old one, PocketBase would refuse the new subscriptions and go on sending the previous user's events (QA BUG-66).

## 23.4 Losing (and regaining) access live

PocketBase only sends a record change to the clients that can see the result, so nobody would hear of a room they
can no longer see. After a room is saved, `dropLostAccess()` (`pb_hooks/lib/access.js`) goes through the realtime
clients and sends each one that could see the room before but can't now a `delete` event, with only the id, on its
rooms subscriptions. Saves that don't change access return early (every DM message saves its room). Gaining access
needs nothing new: the update event reaches the new viewer.

On the client, a room that leaves the store while it is open replaces the room view with "You can't see this room any
more." (the messages go too). If it comes back (re-added, unarchived, opened again), or a room shown as "doesn't exist"
becomes visible, the page starts over and shows it (`ctx.reopen`, QA BUG-60). A room that appears (e.g. you were added)
refreshes the unread counts.

## 23.5 Tests

- **Integration** (`room_access.test.ts`): who sees, posts, reacts, forwards, hides and marks read in each kind of room;
  members kept consistent (creator always, deduplicated, cleared off Private, 100 at most, unknown users refused, DMs
  unchanged); only the creator changes access; a removed member can't edit, delete or download; guests read Open Air
  rooms with authors, attachments and live messages, and nothing else; archived Open Air rooms hidden from guests;
  delete events for losing access, update events for gaining it, nothing for anyone else; filters, expands and
  subscriptions by id don't reach into a private room.
- **Unit**: the guest app (Open Air list, header links, no session calls, `/me` asks to log in), a guest reading a
  room, logging in from a room goes back to it; the header's items; the dialog (making a room private, adding and
  removing people, warnings, a failed save, read-only members); losing and regaining access; markers and the visibility
  select in the room list; a guest's room list; QA BUG-61.
- **E2E** (`room_access.spec.ts`): a private room created from the sidebar, a member added in the dialog sees it live,
  others never do, the member sees the read-only list, and is taken out while reading it; a guest reads an Open Air
  room live with its picture, can't write, is told about a room that needs an account, and logs in back into the room;
  an Open Air room leaves and comes back on a guest's screen as it is archived, unarchived and made public. axe checks
  the dialog.

## 23.6 Who can post

Seeing a room and posting in it are two choices. `rooms.posting` (select `everyone` / `selected`, required;
migration `1760000023_room_writers.js` backfills `everyone`) says who posts: everyone who can see the room (as
before; guests never), or only `rooms.writers` (up to 100 users). The hooks (`setWriters` in
`pb_hooks/lib/rooms.js`) keep it consistent on every save: a DM always lets both post; writers are listed only while
posting is `selected`, the creator first, each once, and in a private room only its members (a member taken out stops
being a writer). Writers can't be set when creating a room; only its creator sets them afterwards (the rooms update
rule).

With `WRITER(r)` = `r.posting != "selected" || r.writers.id ?= @auth || r.created_by = @auth`:

| Collection | Rule | Value |
|---|---|---|
| `messages` | create | as in §23.1 `&& WRITER("@request.body.room.")` |
| `messages` | update | as in §23.1 `&& WRITER("room.")`: as in an archived room, someone who may no longer post can't edit or delete what they wrote there (put back, they can) |

Reacting only needs to see the room: readers react. `canWrite()` (`pb_hooks/lib/access.js`) mirrors the rule in
`beforeMessageCreate`, so forwards into the room (`POST /api/chat/forward`) and anything else the app saves are held
to it too, and in `POST /api/chat/delete`. Telegram stand-ins (§26.3) who speak in a linked room are made writers, as
they are made members of a private one: the Telegram group decides who speaks.

On the client, `canPost(room, me)` (`web/src/lib/rooms.ts`) decides. Someone who can see but not post gets "Only some
people can post in this room. You can read along and react." instead of the composer (what they had typed is kept),
no Reply, Edit or Delete, and doesn't get the room as a forward target; Forward and Select stay, to share its messages
elsewhere. A change of writers reaches everyone in the room live (the room's update event), so the composer comes and
goes as it is saved. The access dialog has a second choice under the visibility, **Who can post?**: "Everyone who can
see it" or "Only people you choose", which shows a **Who can post** list like the members list (+ Add people, Remove;
the creator stays). In a private room its search offers only members, and taking someone out of the members takes
them off it too. Members of a private room see the list read-only.

Tests: `room_writers.test.ts` (integration: defaults, who posts, reacts and forwards, a writer taken off, private
rooms, DMs, limits), `api.test.ts` (`setAccess` with writers), `telegram.test.ts` (stand-ins become writers),
`access.test.ts` (unit: the dialog, a reader's room, made a writer live) and `room_access.spec.ts` (e2e, with axe).
