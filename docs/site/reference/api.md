---
title: Client API
description: The API a Chirkle server offers its clients, for writing your own client, bot or integration. PocketBase's records API, Chirkle's routes and live updates.
section: Reference
order: 5
---

This page is for people writing their own client, a bot or an integration. Chirkle's own web and Android apps use the
same API.

## The basics

A Chirkle server is PocketBase, so the [PocketBase API](https://pocketbase.io/docs/api-records/) applies, and so do its
SDKs:

- **Accounts:** sign up, log in and refresh with PocketBase's auth calls on the `users` collection, then send the token
  as `Authorization: <token>`.
- **Records:** `/api/collections/{collection}/records` lists, reads, creates and updates records. The database's
  access rules decide what each caller can see and change, so a client sees exactly what the apps would show that
  person.
- **Live updates:** `/api/realtime`, server-sent events.

On top of that, Chirkle has routes of its own under `/api/chat/`, for what records alone can't do well.

## What clients use

### Records

| Collection | For |
|---|---|
| `users` | Sign up, log in, your profile (name, avatar, handle). Password resets. |
| `rooms` | Create a room, rename it, change its access. |
| `messages` | Send (multipart, with files), edit. |
| `hidden_rooms` | Hide and unhide rooms. |
| `site` | The server's title, logo, whether signups need a code, and the minimum Android version. Readable by anyone. |
| `collections`, `collection_items` | Collections and their items. |

### Routes

| Route | For |
|---|---|
| `GET /api/chat/rooms` | The room list. |
| `GET /api/chat/rooms/{room}/messages` | A page of a room's messages: `kind=latest`, `first`, `older`, `newer` or `changed`, with a cursor; `q=` searches. |
| `POST /api/chat/dms` | Open a DM with someone (`{ user }`). |
| `GET /api/chat/unread`, `POST /api/chat/reads` | Unread counts, and marking rooms read. |
| `POST /api/chat/reactions` | Add or remove a reaction. |
| `POST /api/chat/delete`, `POST /api/chat/forward` | Delete or forward several messages at once. |
| `GET /api/chat/users`, `GET /api/chat/mentionable` | Find people. |
| `GET /api/chat/inbox` | Mentions & replies. |
| `GET /api/chat/media/{room}` | A room's media grid. |
| `GET`, `POST`, `DELETE /api/chat/rooms/{room}/invite`; `GET`, `POST /api/chat/invites/{token}` | Invite links. |
| `POST /api/chat/password` | Change your password. |
| `POST`, `GET /api/chat/export`; `GET /api/chat/export/file` | Download your data. |
| `POST /api/chat/account/delete` | Delete your account. |
| `GET /api/chat/notifiable` | What would notify you since a time: the Android app's background check. |

Every route and what it answers, with examples, is in
[`shared/schema/answers.json`](https://github.com/border-radius/chirkle/blob/master/shared/schema/answers.json).

### Live updates

Subscribe on `/api/realtime` to `chat/messages`: every message created, updated or deleted, once, in every room you can
see. Other topics carry room changes, hidden rooms, read positions, collections, badges and your Mentions & replies.
The server also sends `chat/keepalive` every 3 minutes, which clients ignore.

## Field lists and limits

Ask for only the fields you need with `fields=`. The lists the apps use, and the limits (2,000 characters a message,
10 files of 20 MB, 100 members a room, and others) are in
[`shared/contract.json`](https://github.com/border-radius/chirkle/blob/master/shared/contract.json).

## Things to know

- **Anonymous rooms:** a message there shows the room as its author, to everyone but the author.
- **Files** are at `/api/files/messages/{message}/{name}`, with `?thumb=480x360` or `240x180` for thumbnails. No token
  is needed.
- **Rate limits** apply per IP address: see [Rate limits](../admin/rate-limits.md).
- **Bots:** there's no separate bot account type. A bot signs up as a user and uses the same API.

## Stability

The Android app is updated by its users on their own schedule, so the API has to keep working for apps already out
there. Adding fields, routes and options is safe; renaming or removing anything is done only once no supported app
uses it. The full contract, and how changes are checked, is
[`docs/API.md`](https://github.com/border-radius/chirkle/blob/master/docs/API.md).
