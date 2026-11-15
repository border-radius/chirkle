# §13. Decisions and open questions

Part of the design document: [index](../DESIGN.md).

## Decided (2026-10-10)

| Topic | Decision |
|---|---|
| Room creation | Any logged-in user can create a room. |
| Unwanted rooms | Each user can hide rooms for themselves only (§5.4). |
| Hidden rooms and new activity | A hidden room stays completely silent: no badge, no count, no notification. |
| Email verification | Not required. |
| Message editing | Authors can edit their own messages, with no time limit. Edited messages show "(edited)". |
| Message deletion | Soft delete. The text is wiped on the server, and a "Message deleted" placeholder keeps the author and time. Deletion is final, with no undelete. |
| Room deletion | Rooms are archived, not deleted. Archived rooms are read-only and keep their full history. |
| Who can archive | Only the room creator can archive or unarchive. |
| Archived room names | The name stays reserved forever and is never reused (unique index covers archived rooms). |
| Retention | History is kept forever. Every room can be scrolled back to its first message (§7.5). |

## Decided (2026-10-10, post-MVP features)

| Topic | Decision |
|---|---|
| Build order | Avatars (§15), then direct messages (§16), then attachments (§17). Each ships on its own. Attachments come last because they must respect DM privacy. |
| DM model | A DM is a `rooms` record with `kind = "dm"` and exactly two `members`, so the message list, windowing, realtime, edit and delete code is reused unchanged (§16.1). |
| Creating a DM | Only through the get-or-create route `POST /api/chat/dms`, never through the `rooms` API (§16.2). |
| Who can DM whom | Any logged-in user can DM any other user. No blocking in this round. No DMs with yourself. |
| Closing a DM | Reuses `hidden_rooms`. A new message in the DM reopens it for the recipient (§16.4). |
| Avatar storage | The built-in `users.avatar` file field: public, raster images only (no SVG), always displayed through thumbnails (§15.1). |
| Attachment access | By URL alone since §37.3 (2026-11-04): the URL holds the message id and the stored name's random part, which only readers see; 404 once deleted. Before: a `protected` field and a short-lived file token (§17.3). |
| Attachment layout | Images render at a fixed height, so loading them never moves the scroll position (§17.5). |
| Attachment aspect ratio | Images keep their aspect ratio, uncropped: fixed height, width from the image, capped (a too-wide image is narrowed and letterboxed in its fixed-height box rather than shortened, §17.5). |
| Metadata stripping | The client re-encodes JPEG/PNG/WebP images (PNG as PNG, the rest as JPEG) before upload, which drops EXIF (including GPS). Best effort, protecting honest users only (§15.3). |
| Bundle and CSS budgets | Raised 46 times, each by the feature that needed it, with the figures: [`history/BUDGETS.md`](../history/BUDGETS.md). Since 2026-11-12 one budget for what a visit loads (§7.7). |

## Decided (2026-10-11, unread counts)

| Topic | Decision |
|---|---|
| Which rooms | Every room in the Rooms and Direct messages sections. Hidden and archived rooms still show nothing (§13 above), and neither does the room you are in. |
| What the badge shows | A count, shown as `99+` past 99. Your own messages and deleted messages never count. |
| Where read state lives | On the server (`room_reads`, §18.1), so it follows you across tabs and devices. |
| When a room is read | As far as the room view shows it, in a visible tab (§18.3): up to the newest message on screen whole, all of it once scrolled to the bottom. Opening a room with unread messages reads only those on screen; the rest are read as you scroll down to them (2026-10-24, user: "it shouldn't mark all messages as read. only visible"). Scrolled up, new messages stay unread until you scroll down to them. |
| Before you joined | Messages older than your account never count, so a new user doesn't start with 99+ everywhere. |

## Decided (2026-10-11, bundle size)

| Topic | Decision |
|---|---|
| PocketBase SDK | Replaced in the app by `web/src/pb.ts` (§6): the SDK builds every service in its constructor, so none of its unused code could be tree-shaken. `app.js` went from 31.1 KB to 23.1 KB gzipped; the 32 KB budget (§7.7) is unchanged. Same storage key, so existing sessions survive the switch. |

## Decided (2026-10-11, reactions and emoji)

| Topic | Decision |
|---|---|
| How many | Any number of different emoji per person per message; each one once (clicking it again takes it back). |
| Which emoji | Exactly the picker's set (§20.4, about 600, Emoji 12 and older), checked by the server. This bounds what a message can collect without a per-message cap, and every current system font shows them all. |
| Where they live | On the message (`messages.reactions`, §20.1), not in a collection of their own: they travel with the message through pages, realtime, reconnect refetches and the window's merge logic, with nothing new on the client's read path. |
| Who can react | Anyone who can see the message, on any saved message that isn't deleted, in a room that isn't archived. Your own messages too. |
| Picker | Categories and a "Recent" row (per browser, `localStorage`), no search: names for ~600 emoji would cost about as much again as the emoji themselves. |

## Decided (2026-10-11, selecting, forwarding and deleting several messages)

| Topic | Decision |
|---|---|
| What can be selected | Any saved message that isn't deleted, yours or not; at most 50 at a time (`MAX_SELECTED`). Forwarding works on any of them, archived rooms included; deleting only when every selected message is yours and the room isn't archived (§21.1). |
| One request, all or nothing | Deleting or forwarding several messages is one request to a route that runs in one transaction (§21.2, §21.3), not one request per message: the per-message rate limits would refuse a large selection halfway, and a half-done delete or forward is harder to explain than a failed one. |
| What a forward is | A new message by the forwarder that points at the original (`forward_of`) and shows it as it is now, saying who first wrote it (`forwarded_from`, kept through forwards of forwards). Nothing is copied: copies of the attachments let one account fill the disk (50 messages × 32 MB per request, 20 requests a minute). An edit of the original shows in its forwards and a delete empties them; the view rule lets a forward's readers see that one original, nothing else of its room (§21.3). Replies and reactions are not forwarded. Forwards made before this hold copies. |
| Where to | Any room or DM you can write in, or someone you have no DM with yet (found by name, which opens one). Afterwards the view goes to where the messages went. |

## Decided (2026-10-12, accounts and quality of life)

| Topic | Decision |
|---|---|
| Unique display names | Compared like room names (case, width and invisible characters ignored), backed by a unique index. Accounts that already shared a name keep it; nobody else can take it (§22.1). |
| Changing the password | Needs the current one; signs out every other session. The tab that changed it stays logged in (§22.2). |
| Where Log out is | On the profile page, not in the app bar (§22.2). |
| Drafts | Kept in `localStorage` per user and room, as you type; cleared when the session ends (§22.3). |

## Decided (2026-10-12, room access)

| Topic | Decision |
|---|---|
| Levels | Private (members only), Public (signed in; the default) and Open Air (anyone can read, signed-in users post) (§23). Only the creator changes them. |
| Field | A new `visibility` next to `kind`, not more `kind` values: `kind` still says room or DM, which half the rules and the UI branch on. DMs are `private`. |
| Members | `rooms.members`, as for DMs, up to 100. Dropped when a room stops being private, so an old list never comes back by surprise, and guests never see who was in it. |
| Guests | Read Open Air rooms that aren't archived, with authors' names and avatars and attachments; nothing else. The app starts on the guest view, not the login screen. |
| Losing access | Pushed as a realtime `delete` by a rooms hook (PocketBase sends changes only to those who can still see them). |
| Private room names | Still unique among all rooms, as before: creating a room under a private room's name says it is taken. Accepted (the name is all it gives away), like most chat apps. |

## Decided (2026-10-12, image viewer)

| Topic | Decision |
|---|---|
| Viewer loading | A lazy chunk plus its own stylesheet (§17.7), not an iframe: same savings for `app.js`, without a second document, cross-frame focus handling or relaxing `frame-ancestors`. `app.js` stays within its 37 KB budget (+0.2 KB). |
| Which images | Every image in the room's message window, oldest first, taken when the viewer opens. |

## Decided (2026-10-12, URLs)

| Topic | Decision |
|---|---|
| Paths, not hashes | Pages are paths (`/r/abc`) (§7.1). PocketBase already serves `index.html` for any path that isn't a file, so no server change for pages (a missing asset or an unknown `/api/` path gets a 404 instead, §5.6); anything put in front of it (a proxy or CDN serving `pb_public/` itself) must do the same. Old `#/` links are rewritten to their path, so bookmarks and shared links keep working. `app.js` +0.2 KB. |

## Decided (2026-10-12, site settings)

| Topic | Decision |
|---|---|
| Where | A `site` collection with one record, edited in the PocketBase admin UI: no admin pages in the app. A collection, not PocketBase's own settings, because the logo is a file and the invite code must stay hidden (a hidden field). |
| One code | One shared invite code, not one per person: what was asked for, and changing it is how an admin stops it working. Per-person invites (an `invites` collection, used up on signup) can come later without changing the rest. |
| Closed signups | Invite-only with an empty code closes signups altogether, rather than letting anyone in by mistake. |
| Favicon | Stays the app's speech bubble with its unread badge: the logo is any image, which an SVG favicon can't embed. |

## Decided (2026-10-21, media collections)

| Topic | Decision |
|---|---|
| Saving | Copies the file into the collection (§31.1): it outlives the message (deleted by its author, the saved copy stays), and is seen by the collection's rules, not the room's. |
| Private rooms into public collections | Allowed: saving media from a private room or a DM into a public collection makes it public. The save menu marks the public collections. |
| The badge for your own private collection | Its name (with 🔒) and a link, to you; others see "Private collection", not a link. |
| Buttons | The collections icon alone (named for screen readers) on every collection button: Save to collection, Attach from collections. |
| Bundle size (pages out of app.js) | 2026-11-10, the user's call ("move profile/settings, login/sign-up, forward picker, dm people search to separate bundles"): mentions (§41) had taken `app.js` to 50.54 KB, over its 49.75 KB. Settings, log in and sign up, the forward dialog and the people search became lazy chunks with budgets of their own (§7.7): `app.js` 46.36 KB, its budget unchanged. Each opens after its chunk loads the first time (log in's is started at once for someone not signed in). Measured but not done: re-minifying with terser, −2.8 KB (2026-11-02). |

## Decided (2026-10-24, linked instances)

| Topic | Decision |
|---|---|
| Who links instances | Admins only, by a one-time invite code (§33.3). No open federation. |
| What is shared | Rooms and DMs only (§33.5). Media collections stay local. |
| Which rooms | Admins of both instances choose each room: one offers, the other accepts (§33.5). Any room, public, private or Open Air. Users can't share rooms; they open DMs, where both admins allowed it. |
| Members of a shared private room | Kept on the home. Its creator manages them and may add people from instances the room is shared with by address. Each mirror's superusers add and remove their own instance's people, sent to the home as a request it checks (§33.5). Users on a mirror can't change members. |
| Design | Each shared room has a home that decides its state, and mirrors that follow it (§33.1); not Matrix. Servers sign requests with a secret per pair (HMAC), since the JSVM has no public-key signing (§33.6). |

## Decided (2026-11-12, size budget)

| Topic | Decision |
|---|---|
| Size budget | One budget for the critical path (html, `app.js` and the chunks it imports, `app.css`), one any lazy feature's first use stays under, one for the statistics page (§7.7, REFACTOR item 52), instead of 24 per-file budgets. Lazy chunks may share code with `app.js` (modulepreloaded chunks); the kits are gone. |

## Still open

1. ~~**Unread state for DMs.**~~ Done for every room: §18.
2. **Upload quotas.** Rate limits cap the request rate, not stored bytes. A per-user storage cap (a hook summing file sizes) is deferred until real usage shows the need.
