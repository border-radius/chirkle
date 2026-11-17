---
title: Administration
description: Set up a new Chirkle server in the admin UI. The first things to configure, and where each setting lives.
section: Administration
order: 1
---

This section is for whoever runs a Chirkle server. Most settings live in the **admin UI**, at `/_/` on your server
(for example `https://chat.example.com/_/`), which comes with every server. A few are environment variables, which
take effect when the server restarts; the [configuration reference](../reference/configuration.md) lists them all.

## The admin account

The admin UI has its own accounts, called *superusers*, separate from the accounts people chat with. Create the first
one on the server:

```sh
npx chirkle superuser upsert you@example.com <password>
```

([with systemd](../deploy/index.md#install-it), [Docker](../deploy/docker.md#run-it) and
[Dokku](../deploy/dokku.md#create-the-admin-account) differ slightly.) Running it again with the same email changes
that superuser's password.

Use a strong password: a superuser can read and change everything. To chat, sign up in the app like everyone else.

## A checklist for a new server

1. **Set the public address.** *Settings → Application → Application URL*: your server's address, like
   `https://chat.example.com`. Emails and [linked servers](../linking.md) need it.
2. **Name it.** Your title and logo: [Branding and signups](branding-and-signups.md).
3. **Decide who can sign up:** open to anyone, or [invite-only](branding-and-signups.md#invite-only-signups).
4. **Set up email,** so people can reset forgotten passwords: [Email](email.md).
5. **Schedule backups:** [Storage and backups](storage-and-backups.md).
6. **Choose moderators,** if you want help: [Moderators and statistics](moderators-and-statistics.md).

## Where things are in the admin UI

| What | Where |
|---|---|
| Title, logo, invite-only signups, statistics, linking, minimum Android version | *Collections → site* (one record) |
| People: moderators, bans, creating accounts, resetting passwords | *Collections → users* |
| Rooms: anonymous rooms, deleting a room | *Collections → rooms* |
| Telegram groups | *Collections → tg_links* ([Telegram bridge](../telegram.md)) |
| Linked servers and shared rooms | *Collections → fed_peers*, *fed_shares* ([Linked servers](../linking.md)) |
| Public address, trusted proxy | *Settings → Application* |
| Email | *Settings → Mail settings* |
| Files on S3 | *Settings → Files storage* |
| Backups | *Settings → Backups* |
| Rate limits | *Settings → Rate limits* |
| Request log and errors | *Logs* |

Change the other collections only if you know what they do: the app keeps them consistent itself.

## Pages in this section

- [Branding and signups](branding-and-signups.md)
- [Moderators and statistics](moderators-and-statistics.md)
- [Anonymous rooms](anonymous-rooms.md)
- [Email and password resets](email.md)
- [Storage and backups](storage-and-backups.md)
- [Rate limits](rate-limits.md)
- [Link previews and video thumbnails](previews-and-thumbnails.md)
- [Data retention and server metrics](retention-and-metrics.md)
