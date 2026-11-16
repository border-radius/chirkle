# §44. Room invite links (2026-11-16)

Part of the design document: [index](../DESIGN.md).

REFACTOR P9. Before this, a private room's members were added one by one, by name, in the access dialog (§23.2). Now
whoever manages a private room shares a link, `/invite/<token>`, and whoever opens it, signed in, joins as a member.
Server: `pb_hooks/lib/invites.js`; web: the access dialog's invite section (`views/room/access.ts`), the invite page
(`views/invite.ts`) and their calls (`invite-api.ts`, a lazy chunk); the app: `InviteScreen.kt` (ANDROID.md §74).
Tests: `tests/integration/invites.test.ts`, `tests/component/views/access.test.ts` "invite link",
`tests/component/views/invite.test.ts`, `tests/e2e/invites.spec.ts`, the app's `ChirkleApiTest`, `UiInvitesTest` and
`RoutesTest`.

## 44.1 The link and who makes it

- **One link per room at a time**, in `room_invites` (migration 54, no API rules): `room` (cascade delete), `token`
  (24 random letters and digits, unique), `created_by`, `expires`, `uses` (the people it added), `created`. Making a new
  one replaces the old, which stops working at once; revoking deletes it. One link keeps the dialog to one line and a
  "who is this link for" question out of it; a room that wants a fresh link for each group makes a new one.
- **Who:** whoever may change the room's members: its creator, or a moderator (§36) who sees it (a moderator sees only
  private rooms they are in). Not a DM, not a copy of another instance's room (§33.5: its members are changed at its
  home). Anyone else is refused (403), and someone who can't see the room is told it doesn't exist (404).
- **Only private rooms**, and not archived ones: a public or Open Air room needs no invite. A room made public (or
  Open Air) loses its link (`dropInvites`, after the rooms update); made private again, it needs a new one, so an old
  link never comes back to life. While a private room is archived its link doesn't work; unarchived, it does again
  until it expires.
- **Archived:** the access dialog says the link doesn't work until the room is unarchived, and offers only Revoke: no
  address to copy, no new link (QA BUG-282).
- **Its maker's account deleted** (§43.3): the links it made are deleted with its personal data, so a room it no longer
  manages takes nobody in by its hand (QA BUG-281).
- **It expires** after 1, 7 (the default) or 30 days: a forwarded link can't work for ever. The daily prune (REFACTOR
  item 49, `lib/retention.js`) deletes links a day past their expiry.

Routes (signed in):

- `GET /api/chat/rooms/{room}/invite` → `{ invite: { token, created, expires, uses } | null }`: the room's working
  link, null for none (also once the room isn't private).
- `POST /api/chat/rooms/{room}/invite { days: 1 | 7 | 30 }` → the same, with the new link. Anything else for `days` is
  a 400 on `days`.
- `DELETE /api/chat/rooms/{room}/invite` → 204. Nothing to revoke is fine too.

## 44.2 Opening and joining

- `GET /api/chat/invites/{token}` (anyone, guests too: the link is the secret) → `{ room: { id, name, members },
  by, expires, member }`: the room's name and how many members it has, who made the link, until when it works, and
  whether you are in already. A link that doesn't work, for whatever reason (unknown, expired, revoked, the room archived
  or no longer private), is one 404, "This invite link has expired or was revoked.": the answer never says which.
- `POST /api/chat/invites/{token}` (signed in) → `{ room }`: you are added to its members, through the rooms hooks
  (`setMembers` keeps the list, §23.1), and the link counts a use. Already in (or its creator), nothing changes and no
  use is counted. 404 as above; 400 "This room is full" at 100 members (`LIMITS.roomMembers`). Joining checks and saves
  in one transaction, so two people joining at once can't pass 100 between them.
- **Taken out, kept out:** someone the room's managers take out of its members (an update of the room by a request)
  while the link works is barred from it (`barred`, migration 55): for them it answers the same 404 as a dead link,
  so it can't undo the removal. Added back by hand, they are no longer barred; a new link starts with nobody barred.
  Joins and an account's delete (§43.3) are saved by the server, not by a request, so they bar nobody (QA BUG-280).
- **You become a member, not a writer:** in a room where only some people post (§23.6), the link lets you read and
  react; its managers add you as a writer if they want.
- **Live:** the room's save is an ordinary update, so the new member's rooms subscription gets it (gaining access
  needs nothing new, §23.4), the other members see the member list change, and a home room's peers are told (§33).
- **No rate limit:** 24 letters and digits are about 143 bits, so a token can't be guessed by asking; the routes
  answer the same 404 for every kind of dead link.

## 44.3 Web

- **The access dialog** (§23.2) has an **Invite link** section under the members, for those who manage the room, while
  Private is chosen and the room is saved as private (a public room made private needs Save first; the section says
  nothing until then). It loads the room's link when shown. Without one: **Works for** (1 day, 7 days, 30 days) and
  **Create link**. With one: the full address in a read-only field (selected on focus), **Copy link**
  (`navigator.clipboard`, or "Press Ctrl+C to copy it." where the clipboard is refused), "Works until … · 2 people
  joined by it", **New link** (with the chosen days) and **Revoke**. Each acts at once, not on Save, and says what it
  did in a status line ("A new link is ready. The old one no longer works."). A member who can't manage the room sees
  no invite section in their read-only Members dialog.
- **The invite page**, `/invite/:token` (public, beside the room list): "Join #club", "Ada invited you to this private
  room. 4 members · the link works until …"; signed in, **Join the room** joins, reloads the room list (so the room
  doesn't open as "doesn't exist") and opens the room. A guest gets "To join, log in or sign up first." with both links;
  logging in or signing up comes back to the page (`lastPage`, §23.3). Someone in the room already gets "You're in this
  room already." and a link to it. A dead link: "This invite link doesn't work", also when it stops working between
  opening the page and pressing Join.
- Nothing of it is on the critical path (§7.7): `invite-api.ts` is a lazy chunk, `Api.invites()`, loaded by the
  access dialog and the invite page (`invite`, 1.1 KB, in the size report); the dialog's styles are in `access.css`,
  the page's one rule in `shell.css`.

## 44.4 Not done

- **Several links per room**, or a link for one person (with a name, or that works once).
- **Links to public rooms**, or links that make you a writer.
- **Approval:** a link adds at once; there is no "asks to join" queue for the managers.
- **An Open Air guest's account made from a link:** a guest signs up as on any page, then joins.
