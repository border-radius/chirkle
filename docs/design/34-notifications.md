# §34. Notifications (2026-10-24)

Part of the design document: [index](../DESIGN.md).

The user asked for "notifications to web app. push/sound. without google", turned on in the profile, for replies and
DMs. Asked whether that meant Web Push (which, with every tab closed, can only come through the browser's own push
service: Google's for Chrome and Edge, Mozilla's, Apple's), they chose **open tab only**: no third party at all.

## 34.1 What alerts, and when

- **DMs**: every message from someone else in a DM. **Replies to you**: a message in a room that replies to one of
  yours. Each can be chosen on its own, as the Android app's (ANDROID.md §21.1).
- Not: your own messages, service messages, deleted ones, archived rooms, hidden rooms (§13; a closed DM opens again
  with a message, §16.4, so it alerts).
- Only while the app is open in a tab of this browser, in the background or minimised too. The alert comes from the
  tab's realtime connection (§18.3's messages subscription, which now carries `reply_to` too). With every tab closed,
  nothing arrives, and nothing missed meanwhile is told later: the unread counts show it.
- **In front** (a tab of the app focused): no pop-up. The sound only, and nothing at all for the room open there.
- **How**, each chosen on its own: **a pop-up** (a system notification: who wrote, "… replied in #room" for a reply,
  the text on one line, cut at 140 characters, or "Sent an attachment"), and/or **a sound** (a short two-note chime
  made with Web Audio, no sound file; when it plays, the pop-up is silent). Browsers play sound only in a page that has
  been clicked or typed in once since it loaded, so a tab restored and never touched alerts silently.

## 34.2 Settings (profile page)

A **Notifications** group after Appearance: Direct messages, Replies to you, Show a pop-up, Play a sound. Saved on
this device (localStorage `chat.notify`, gone when nothing is ticked), like the theme: the browser's permission is
per device anyway. Ticking DMs or replies with neither way chosen ticks the pop-up. Ticking the pop-up asks the
browser's permission (a click is needed for that). If the browser refused, or can't show notifications (an iPhone
outside an installed app), the group says so. Ticking the sound plays it once.

## 34.3 Code

- `web/src/notify.ts`, a lazy chunk (≤ 3 KB, §7.7): loaded by `app.ts` when a signed-in user has `chat.notify`
  (at start, when the profile page changes it, or another tab does: the `storage` event), and by the profile page
  for its settings. Stopped with the session.
- **One tab alerts**: the one holding the Web Lock `chat.notify`. When it closes, another takes it. It fetches the
  message (one request, only for DMs and replies), checks the quoted message is yours, and asks the other tabs over a
  BroadcastChannel whether one is in front (200 ms). The tab in front plays the sound itself.
- **Alerting** from the moment the server has both its subscriptions and the tab holds the lock: it says so as
  `<html data-notify="on">` (gone once stopped), which the e2e waits on. The realtime POST can't tell: the unread counts
  follow the same topics, so the subscriptions may already be there (2026-10-28; the e2e failed about once in 30 runs).
- Pop-ups go through the service worker's `showNotification` when one is active (Android Chrome allows no other
  way), else `new Notification`. Tag = the room: a newer message replaces the room's pop-up. A read of the room
  (`room_reads`, from any tab or device), or opening it here, closes it.
- **Clicking** one opens its message (`/r/{room}/m/{message}`): `sw.ts`'s `notificationclick` focuses the app's
  tab in front (else a visible one, else any) and tells it where to go, or opens a new tab. Only paths of the app.
- No server change. The Android app is unchanged: it already notifies by its own check (ANDROID.md §21).

## 34.4 Tests

`tests/component/notify.test.ts`: what alerts (DMs, replies, choices, hidden/archived/own/deleted), the text, the
stored choices; live against PocketBase: a DM's pop-up and chime and its click, a reply to you (not a plain message,
not a reply to someone else), in front (silent for the open room, the chime for another), the sound alone, blocked
pop-ups, a read elsewhere closing it, stopped; the settings group. `tests/unit/sw.test.ts`: the click handler.
`tests/e2e/notify.spec.ts`: turned on in the profile page, a reply and a DM pop up in a background tab and a click
opens the DM at its message, off again silent; with the service worker, one pop-up per room that a read elsewhere
takes away. Headless Chromium answers "denied" to every notification, granted or not, so the e2e replaces the
browser's `Notification` and the registration's `showNotification`/`getNotifications` with recorders.

## 34.5 Every message of a room (2026-10-24)

The user asked to "enable notifications for all messages in any specific room. on web and on mobile. no need to sync
it."

- The room's ⋯ menu (not a DM's, whose every message already alerts with Direct messages): **Notify of every
  message**, then **Stop notifying of every message**. Not offered in an archived room unless already on (to turn it
  off). Guests have no such item.
- Kept on this device only, with the other choices: `chat.notify`'s `rooms` (room ids). Not synced to the account or
  other devices; the Android app keeps its own (ANDROID.md §24). Turning it on with neither a pop-up nor the sound
  chosen chooses the pop-up and asks the browser's permission; if the browser refuses, the header says so.
- Every message from someone else in that room alerts as a reply does: `"{author} in #room"` over the text (a reply
  to you still says "replied in"). The same exceptions as §34.1: hidden and archived rooms, your own, service and
  deleted messages, the room open in the tab in front.
- `views/room/header.ts` reads and writes `chat.notify` itself (a few lines), so `app.js` never loads `notify.ts`
  for it; it then calls the app's `notify()` to start following if it wasn't. The profile page's boxes keep
  `rooms` as they are, and its hint mentions the room menus.
- Tests: `notify.test.ts` (what alerts for a room chosen; the stored list; a plain message pops up as "… in #room",
  another room's doesn't; the profile keeps the list), `views/room/header.test.ts` (the menu item on and off, the
  pop-up chosen and permission asked, nothing stored once nothing is chosen).
