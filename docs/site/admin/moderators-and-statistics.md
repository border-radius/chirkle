---
title: Moderators and statistics
description: Make people moderators of your Chirkle server, ban and unban accounts, and see anonymous usage statistics on the /stats page.
section: Administration
order: 3
---

## Moderators

Moderators help keep the server tidy, from inside the app. To make someone a moderator, open *Collections → users* in
the admin UI, edit their record and tick **`moderator`**.

A moderator can:

- **delete anyone's messages,** one at a time or [several together](../guide/messages.md#select-forward-and-delete-several);
- **change any room's access:** who can see it, a private room's members, who can post;
- **archive and unarchive rooms;**
- **create and revoke a private room's [invite link](../guide/rooms.md#invite-links),** in rooms they're in;
- **ban and unban people.**

Moderators can't edit other people's messages, rename rooms or read anything they couldn't read otherwise: DMs and
private rooms they aren't in stay out of their reach, and anonymous rooms still hide their authors from them. In an
archived room, they unarchive it first.

## Bans

To ban someone, a moderator clicks their name on one of their messages and chooses **Ban…**. A banned account is signed
out everywhere at once and can't sign in again. **Unban**, in the same place, lifts it.

Superusers can also tick or untick **`banned`** on the person's record under *Collections → users*.

## Usage statistics

The `/stats` page shows how the server is used, as counts, never names:

- **Now:** people online, on the web and on Android, guests reading Open Air rooms, and the peak today and this week.
- **Usage:** active people over the last day, week and month, and time spent online.
- **Messages:** per day for 30 days, with the people who posted, the share of DMs, files and reactions.
- **Accounts:** total, new this week, moderators and banned.
- **Server** (superusers only): uptime, versions, connections, database size, memory, and the background workers'
  state. See [Data retention and server metrics](retention-and-metrics.md).

Moderators find it in Settings, under **Moderation** → **Usage statistics**. Superusers sign in to the admin UI, then open
`/stats` on the same server. Anyone else gets "Page not found".

Counts are of your server's own accounts: not people from [linked servers](../linking.md), and not
[Telegram](../telegram.md) users.

### Turn statistics off

Tick **`no_stats`** on the site record (*Collections → site*). The server then stops recording them, so they take no
space over time.
