---
title: Link Chirkle servers together
description: Pair two or more Chirkle servers to share rooms and let their people DM each other. Setup, sharing rooms, private rooms across servers, and unpairing.
section: Linking and bridges
order: 1
---

Two or more Chirkle servers can share rooms and let their people write DMs to each other, once their admins pair them.
Ann on `a.example` and Bob on `b.example` talk in the same room, each signed in on their own server.

It's off by default, and only superusers (admins) set it up, in the admin UI. A room's creator can't share it outside
the server themselves.

## How it works

- **Every shared room has a home:** the server it was created on. The other servers keep a copy.
- **Messages, edits, deletes, replies, reactions and files** sync both ways.
- **People from another server** show with that server's label after their name, like **Ann (B)**.
- **Nothing else is shared:** collections, unread counts, search, drafts and settings stay on each server.
- **If a room's home is down,** its copies stay readable. Messages written meanwhile show where they were written, and
  reach the home once it's back.

## What you need

- **Each server on a public domain with HTTPS,** for example started with `npx chirkle chat.example.com`. Servers reach
  each other over `https://`, on public addresses only.
- **A superuser account** on each, and the admin UI at `/_/`.

## Turn linking on

On each server:

1. **Set the public address.** *Settings → Application → Application URL*: the server's address, for example
   `https://chat.example.com`. The default, `http://localhost:8090`, won't work.

   The address becomes part of the IDs the other servers store, so it can't be changed while any peer is listed.
   Settle on the final domain first.

2. **Tick `federation`** on the record under *Collections → site*. Until it's ticked, the linking routes answer 404 and
   nothing is sent.

## Pair two servers

1. **Send a request from server A.** On A, open *Collections → fed_peers* and add a row: B's address as `origin`
   (`https://b.example`) and a short `label` for B's people, up to 8 characters (for example `B`). Tick `dms` to let
   A's people DM B's.
2. **Accept it on server B.** B first checks with A that the request is genuine, then lists it under *fed_peers* with
   status `requested`. B's admin sets `status` to `active`, picks a label for A's people and, if they like, ticks `dms`.
   Both rows become `active`.

- If B can't be reached, A tries again every minute. A request nobody accepts expires after 7 days.
- To decline a request, or withdraw one you sent, delete its row.
- If both admins add each other, the servers pair at once.

## Share a room

1. **Offer it from the room's home.** On the server where the room lives, open *Collections → fed_shares* and add a row
   with the `room` and the `peer`.
2. **Accept it on the other server.** That server's admin finds the offer under *fed_shares* and ticks `accepted`. The
   room appears there named after the original plus the label, like **general (A)**, with its latest 200 messages.
   That admin may rename the copy.

Any room can be shared, whatever its access:

- **Public rooms** are visible to everyone signed in on either server.
- **Private rooms** stay members-only everywhere. On the home, the room's creator adds people from the other server by
  their full address, like `ann@b.example`, in **Room access…**. On the copy, that server's admins add or remove their
  own people by editing the room's `members` in the admin UI.
- **Open Air rooms** stay readable without an account on every server.

## DMs across servers

With `dms` ticked on both sides, anyone can click **New message** and type the other person's full address, like
`ann@b.example`, where they would normally type a name.

## Moderation

Each server moderates its own people. A moderator on a copy can't delete messages that the home's people wrote: the
home's moderators can, and their deletes reach every copy.

## Pause, unshare or unpair

- **Stop sharing one room:** delete its row under *fed_shares* on either side. The copy is archived: it keeps its
  history and becomes read-only.
- **Pause a peer:** set its `status` to `suspended`.
- **Unpair:** delete the peer's row under *fed_peers*. Shared copies are archived and DMs across become read-only.
  Pairing again starts afresh.

## Remove the feature

Linking is self-contained: `pb_hooks/federation.pb.js`, `pb_hooks/federation/` and the `fed_*` collections. While
`federation` isn't ticked, it does nothing at all.
