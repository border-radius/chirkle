---
title: Rooms
description: Create rooms in Chirkle, choose who can see them (Private, Public or Open Air) and who can post, invite people with a link, and hide or archive rooms.
section: Using Chirkle
order: 1
---

Rooms are where groups talk. Anyone with an account can create one, and its creator decides who can see it and who can
post in it.

## Create a room

Click **New room** in the room list, give it a name (up to 48 characters, unique on the server) and choose
**Who can see it**. You can change everything but the name later.

## Who can see a room

| Access | Icon | Who reads it | Who posts |
|---|---|---|---|
| **Private** | 🔒 | Its members: the creator and the people they add | Its members |
| **Public** (the default) | # | Everyone with an account on the server | Everyone with an account |
| **Open Air** | 🌐 | Anyone, even without an account | Everyone with an account |

**Open Air** rooms are readable from the open web, like a talk in the open air: anyone walking by can listen, but
you sign in to speak. People without an account see the server's Open Air rooms on its home page, can read and search
them, and log in or sign up to join in.

To change it, open the room's menu and choose **Room access…**. Only the room's creator and the server's
[moderators](../admin/moderators-and-statistics.md) can. The dialog says what the change will do before you save:
for example, that a room made Open Air becomes readable by anyone on the web, history included, or that people
outside a room made Private lose it from their list.

## Members of a private room

In **Room access…**, **Add people** finds people by name and adds them. A private room holds up to 100 members.
**Remove** takes someone out: the room disappears from their list, and they can no longer read it or edit what they
wrote there.

### Invite links

Instead of adding people one by one, share a link. In **Room access…**, under **Invite link**, choose how long it
works (1, 7 or 30 days) and click **Create link**, then **Copy link**.

- Anyone who opens the link and has an account on the server joins the room as a member. Someone without one is asked
  to log in or sign up first.
- The dialog shows until when the link works and how many people joined by it.
- A room has one link at a time. **New link** replaces it, and the old one stops working at once. **Revoke** stops it
  without a new one.
- The link stops working when the room is archived, until it's unarchived, and for good when the room stops being
  private.

## Who can post

In **Room access…**, **Who can post** is **Everyone who can see it** or **Only people you choose**. With the second,
pick up to 100 people who can post. Everyone else who can see the room reads along and reacts, and sees a line saying
that only some people can post. People without an account (in an Open Air room) only ever read.

## The room's menu

The menu in the room's header holds:

- **Room access…** for the room's creator: who can see the room and post in it. Everyone else sees
  **Members (*n*)** here, which shows the same settings and, in a private room, its members, without changing them.
- **Notify of every message**: get a [notification](notifications.md) for every new message here, not only mentions
  and replies to you.
- **Jump to beginning**: go to the room's first message.
- **Hide room** / **Unhide room**.
- **Archive room** / **Unarchive room** (the creator and moderators).

Next to the menu, **Search messages** [searches the room](search.md) and **Media** shows its
[images and videos](files.md#a-rooms-media) as a grid.

## Hide a room

**Hide room** takes a room out of your own list, for rooms you don't care about. Nothing changes for anyone else.
Hidden rooms are listed at the bottom of the room list, under **Hidden & archived**, with **Unhide**, and
[Jump to](search.md#jump-to) still finds them.

## Archive a room

**Archive room** makes the room read-only for everyone: its history stays, and nobody can post, edit, react or delete
until it is unarchived. Archived rooms move to **Hidden & archived** in everyone's list. Only the room's creator and
moderators can archive and unarchive.

Rooms can't be deleted from the app. The server's admin can delete one in the admin UI.

## Unread messages

The room list shows how many unread messages each room has, updated live and kept in sync across your tabs and devices.
A room with an unread [mention of you or reply to you](messages.md#mentions) shows an **@** by its count. The total
shows in the browser tab's title and icon.

A room with unread messages opens at the first of them, under a **New** line. While you're scrolled up,
**Jump to latest** takes you to the newest message.
