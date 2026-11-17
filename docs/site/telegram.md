---
title: Bridge Telegram groups to Chirkle
description: Link Chirkle rooms to Telegram groups and channels through your own bot. Messages, replies, edits, files and reactions go both ways.
section: Linking and bridges
order: 2
---

Your own Telegram bot links a Chirkle room to one or more Telegram groups. Once linked, messages, replies, edits and
files go both ways, and reactions too if the bot is a group admin.

- **In the room,** Telegram users show with their own names and pictures and a (TG) label, like **Lee Li (TG)**.
- **In the group,** the bot posts each Chirkle message with its author's name in bold above it.

It's off by default. A superuser sets it up.

## What you need

- **A Chirkle server on a public domain with HTTPS.** Telegram delivers updates to a webhook on your server, which must
  be reachable over `https://`.
- **A superuser account,** and the admin UI at `/_/`.

## Set it up

1. **Create a bot.** In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot` and keep the token it
   gives you.
2. **Turn privacy mode off.** Still with @BotFather, send `/setprivacy`, choose your bot and pick **Disable**, so the
   bot sees all group messages, not only commands. If the bot is already in a group, remove it and add it again
   afterwards.
3. **Give the token to your server** and restart it, with two environment variables:
   - `TELEGRAM_BOT_TOKEN`: the bot's token. Without it the bridge is off.
   - `TELEGRAM_WEBHOOK_URL`: `https://<your domain>/api/telegram/webhook`. Without it the bridge asks Telegram for
     updates itself instead (polling), which is meant for trying it locally.

   ```sh
   # with npx
   TELEGRAM_BOT_TOKEN='123456:ABC…' \
   TELEGRAM_WEBHOOK_URL='https://chat.example.com/api/telegram/webhook' \
   npx chirkle chat.example.com

   # with Dokku
   dokku config:set chirkle \
     TELEGRAM_BOT_TOKEN='123456:ABC…' \
     TELEGRAM_WEBHOOK_URL='https://chat.example.com/api/telegram/webhook'
   ```

   With [systemd](deploy/index.md#settings), add them with `sudo systemctl edit chirkle`.
4. **Add the bot to a Telegram group.** A row for the group appears in the admin UI under *Collections → tg_links*,
   disabled and without a room.
5. **Link the group to a room.** Edit that row: pick the `room` and tick `enabled`. The room gets a notice that the
   group was connected. Send `/chatid` in the group at any time to see whether it's linked.
6. **Optional: make the bot a group admin.** Telegram tells only admin bots about reactions, so this is what makes
   reactions go both ways.

## Options

- **Several groups per room.** A room can be linked to more than one group. Messages from one group are relayed to the
  others too.
- **Anonymous reposts.** Tick `anonymous` on a *tg_links* row to post the room's messages to that group without their
  authors' names. An [anonymous room](admin/anonymous-rooms.md) also shows the room's name as the author in its linked
  groups.
- **Channels.** A Telegram channel links like a group. The bot must be one of its admins, with permission to post
  messages.
- **Unlinking.** Untick `enabled`, move the row to another room, or delete it. Removing the bot from the group unlinks
  it too. The room gets a notice each time.

## Good to know

- **Deletes go one way.** Telegram doesn't tell bots about deleted messages, so a message deleted in Telegram stays in
  the room. Deletes in Chirkle do reach Telegram.
- **A bot can delete its own messages for 48 hours only.** After that, a message deleted in Chirkle is edited to
  "Message deleted" in the group instead.
- **Files up to 20 MB** are bridged. Bigger files, animated stickers, locations, polls and the like arrive as a line of
  text saying what they were.
- **Albums** arrive as one message with up to 10 files. **Long Telegram messages** are split into several, since a
  Chirkle message holds 2,000 characters.
- **Telegram users can't sign in** to Chirkle as their (TG) profiles, and nobody can DM them from Chirkle.

## More settings

| Variable | What it does |
|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | What Telegram sends with each webhook call, to prove it's Telegram. Made from the token when not set. |

## Remove the feature

The bridge is self-contained: `pb_hooks/telegram.pb.js`, `pb_hooks/telegram/` and its own `tg_*` collections. Delete
the first two to remove it.
