# §36. Moderators (2026-11-03)

Part of the design document: [index](../DESIGN.md).

The user asked: "admin should be able to mark any user as a moderator (from admin ui). moderator can delete any
messages, change any room access settings, archive rooms, ban/unban users."

## 36.1 Data

Migration `1760000040_moderators.js`:
- `users.moderator` (bool): ticked by a superuser in the admin UI (*Collections → users*). The users create and update
  rules refuse it from anyone else (`@request.body.moderator:isset = false`).
- `users.banned` (bool): set by a moderator (`POST /api/chat/ban`) or a superuser in the admin UI. Clients can't set it
  on a users record either.
- The users `authRule` is `banned = false`: a banned account can't sign in by any method, and refreshing its session
  is refused.
- Both fields can be read like a user's name. The clients read `moderator` only from the signed-in user's own record,
  to show the moderator's actions. They read `banned` only when a moderator opens an author's menu.

`pb_hooks/lib/moderation.js` holds the checks. `isModerator` is true for a users record that has `moderator` and
isn't banned. `canManage(room, user)` is true for the room's creator or a moderator, and never for a DM.
`canModerate(room, user)` is true for a moderator, and never in a DM.

## 36.2 Deleting messages

`POST /api/chat/delete` (§21.2) lets a moderator delete anyone's messages, one or several. This works in any room they
can see except DMs, including rooms where only some people can post (§23.6). Archived rooms stay read-only for
moderators too: they unarchive the room first. The records API's update rule still allows only the author, so the
clients send a moderator's delete of someone else's message to the route. Moderators can't edit others' messages.

A moderator sees only what anyone sees: they can't reach a private room they aren't in, or someone else's DM, and an
anonymous room (§35) still hides its authors from them. In a room shared from another instance (§33.5), the mirror
refuses changes to messages its home's people wrote (`checkMirrorChange`): that home moderates them. On the home, a
moderator's delete goes to the mirrors like any other delete.

## 36.3 Rooms

The rooms update rule now begins `(created_by = @request.auth.id || (@request.auth.moderator = true &&
@request.body.name:isset = false))`. The rest of the rule still applies, so only public-kind rooms qualify (DMs never)
and the DM and server fields stay off-limits. A moderator can:
- change who can see the room, a private room's members, who can post and its writers;
- archive and unarchive it;
- but not rename it.

The creator stays the creator: they are always a member and a writer (§23.2, §23.6). A mirror of a shared room is
changed only by its superusers, as before (`checkMirrorEdit`). Adding someone from a linked instance by address
(`/api/chat/remote-users` with a room) is open to the creator and to moderators.

Clients use `canManage` (web `lib/rooms.ts`, Android `lib/Rooms.kt`). It says the same as the server, and is false
for a copy of another instance's room (`shared.home`). The header menu then offers *Room access…* and *Archive room*,
and the Archived list offers *Unarchive*. In the access dialog, a room made private, or given chosen posters, starts
with the creator and the moderator making the change, so the moderator doesn't lose the room by saving. They can
remove themselves.

## 36.4 Banning

`POST /api/chat/ban { user, banned }` → `{ id, name, avatar, no_dms, instance, banned }`. It is for moderators only
(403 for anyone else, 401 for guests). A moderator can't ban:
- themselves;
- another moderator (a superuser takes the flag away first);
- someone who doesn't sign in here: a linked instance's people (`instance`) or a Telegram stand-in (§26.3). Those
  answer 400.

Banning someone, by this route or in the admin UI (the users update hook, `beforeBan`), does three things:
- It refreshes their token key, so every session they have stops working at once. The clients' revoked-session
  handling (QA BUG-183) logs them out.
- It closes their realtime connections (`afterBan`), which outlive the token.
- From then on, the auth rule refuses their sign-ins.

Their messages stay; moderators delete the ones they want gone. Unbanning lets them sign in again, and nothing else
changes.

Clients: a moderator bans from the DM's menu (the room header's ⋯, since 2026-11-24, when an author's name started
opening the DM instead of a menu, §16.5). Someone who takes no DMs has no DM: on the web their name opens a menu with
*Ban…* alone (QA BUG-230). Android also keeps *Ban* in the message's long-press sheet. The menu shows *Ban…* or
*Unban*; the client asks the server which one applies each time the menu opens. *Ban* asks
for confirmation first: "Ban *name*? They are signed out everywhere and can't sign in until unbanned." The item isn't
shown for:
- yourself;
- people on linked instances;
- an anonymous room's author, which is the room.

Someone who takes no DMs gets the item (QA BUG-230); the server refuses a Telegram stand-in, and says why.

## 36.5 Tests

- `tests/integration/moderators.test.ts` covers:
  - only superusers set either flag;
  - a moderator deletes anyone's message, in rooms where they can't post too, but not in DMs, archived rooms or
    private rooms they aren't in, nor through the records API, and not once the flag is gone;
  - a moderator changes another person's room's access and archives it, but doesn't rename it or touch DMs;
  - a ban ends sessions, refuses sign-ins and closes live connections, until unbanned;
  - a ban set in the admin UI does the same;
  - who may ban whom.
- `tests/component/views/room/moderators.test.ts` covers `canManage`, the header menu in someone else's room,
  deleting but not editing someone else's message, an author's name opening the DM and Ban and Unban in its menu, Ban
  on the name of someone who takes no DMs, and none of these for anyone else.
- Android: `UiModeratorsTest` (ANDROID.md §45).

## 36.6 QA pass 29

The QA pass that followed (QA.md, BUG-210..218) changed:
- **Banned user's open sessions:** the clients check the session again whenever the live connection comes back, so a
  banned user's open tab or app is logged out within seconds.
- **Login message:** a banned login is told "This account is banned." (once the password checks out).
- **Own messages where a moderator can't post:** a moderator deletes these through the delete route.
- **Access dialog:**
  - it names someone else's room's creator;
  - the private-room warning says the creator keeps the room.
- **Unbanning:** anyone banned can be unbanned.
- **Stand-ins:** they are recognised with the Telegram bridge off.
- **Mirrors:** a mirror's remote authors get no *Delete*.
- **Service messages:** they can't be deleted.

The access dialog's budget went to 3.10 KB.
