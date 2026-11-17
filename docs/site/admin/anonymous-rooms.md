---
title: Anonymous rooms
description: Make a Chirkle room anonymous, so its messages show the room's name instead of their authors.
section: Administration
order: 4
---

In an anonymous room, messages show the room's name instead of their author's, so nobody can tell who posted what.

## Make a room anonymous

In the admin UI, open *Collections → rooms*, edit the room and tick **`anonymous`**. There's no switch for it in the
app: only superusers can set it. DMs can't be anonymous.

## What people see

- Every message posted from then on shows the room's name as its author, to everyone but its author. Authors see
  their own messages as theirs, and can edit and delete them as usual.
- Replies quote the room's name too, and nobody can open a DM from an anonymous message.
- A forward of an anonymous message is "from" its room. If the room is private, its name isn't passed on: the forward
  is "from Anonymous".
- [Telegram groups](../telegram.md) linked to the room get the room's name as the author too.

## Good to know

- **It applies from the moment you tick it.** Messages posted before stay as they were, with their authors. Unticking
  it later doesn't reveal who wrote what while it was on.
- **Moderators don't see the authors either.** Only superusers do, in the admin UI.
- **The server still knows who wrote each message,** so that people can edit and delete their own, and rate limits and
  bans still work. Anonymous means anonymous to other people in the room, not to the server's admin.
