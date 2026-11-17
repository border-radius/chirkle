---
title: FAQ and troubleshooting
description: Answers to common questions about running and using Chirkle, and fixes for the problems people run into most.
section: Help
order: 1
---

## About Chirkle

### Is Chirkle free?

Yes. It's open source, under the [GNU General Public License v3.0](https://github.com/border-radius/chirkle/blob/master/LICENSE)
or later. You run it on your own server, so the only cost is the server.

### How big a server do I need?

One CPU and 1 GB of RAM holds about 1,000 people chatting at a normal pace. See [Performance](reference/performance.md).

### Is there a hosted version?

There's a public demo at [chat.chirkle.com](https://chat.chirkle.com) to try it. Chirkle is made to run on your own
server.

### Is it end-to-end encrypted?

No. Messages travel over HTTPS, and the server stores them in its database, where its admin can read them. That's what
makes full history, search and new devices work without keys to manage. Run your own server to be the one who holds
the data. See [Security and privacy](reference/security.md).

### Does it work on iPhone?

There's no iOS app. The web app works in Safari and can be [installed to the home screen](guide/app.md), which is also
what makes notifications work on an iPhone.

### Can I import history from Slack, Discord or Telegram?

There's no importer. To carry a Telegram group's conversation on in Chirkle from now on, link it with the
[Telegram bridge](telegram.md).

## Running it

### `npx chirkle` says my Node is too old

Chirkle needs Node.js 22 or newer and npm 11 or newer. Check with `node -v` and `npm -v`, and update both.

### Does it run on Windows?

Use WSL or the [Docker image](deploy/docker.md). The server is built for Linux and macOS.

### The HTTPS certificate doesn't arrive

- Check that the domain's `A` (and `AAAA`) record points at the server: `dig chat.example.com`.
- Ports 80 and 443 must be open in the firewall, and free: stop any other web server.
- Chirkle must be allowed to bind them: run it as root, or with `CAP_NET_BIND_SERVICE`, as the
  [systemd install](deploy/index.md) does.
- The certificate is fetched on the first visit to the HTTPS address. Look at the server's output for errors.

### Uploads fail behind nginx (or another proxy)

The proxy limits request bodies. Allow 210 MB: a message can carry 10 files of 20 MB. See
[Behind a reverse proxy](deploy/reverse-proxy.md).

### Messages arrive late, or in bursts, behind a proxy

The proxy is buffering `/api/realtime`. Turn buffering off for it: [Behind a reverse proxy](deploy/reverse-proxy.md).

### Everyone hits the rate limit at once

Behind a proxy, Chirkle sees every request coming from the proxy. Start it with `TRUSTED_PROXY=X-Forwarded-For`:
[Behind a reverse proxy](deploy/reverse-proxy.md).

### Videos have no thumbnails, links have no previews

The server needs `ffmpeg` and `curl` on its `PATH`. Install them and restart: see
[Link previews and video thumbnails](admin/previews-and-thumbnails.md).

### "Forgot password?" isn't on the login page

It shows once email is set up and turned on: see [Email and password resets](admin/email.md).

### How do I update?

Take a [backup](admin/storage-and-backups.md), then see [Update](deploy/index.md#update) for systemd,
[Docker](deploy/docker.md#update) or [Dokku](deploy/dokku.md#follow-master-automatically).

### How do I move to another server?

Copy the data folder (`pb_data`) to the new server with Chirkle stopped, or restore a backup there. See
[Storage and backups](admin/storage-and-backups.md#restore-a-backup).

### I forgot the admin password

On the server, run `superuser upsert` again with the same email and a new password: see
[The admin account](admin/index.md#the-admin-account).

## Using it

### How do I make a room only some people can see?

Make it **Private** in **Room access…**, then add people or share an [invite link](guide/rooms.md#invite-links).

### Can I delete a room?

Not from the app: archive it instead, which makes it read-only. The server's admin can delete one in the admin UI.

### I don't get notifications

On the web, notifications arrive only while Chirkle is open in a tab or as an installed app, and the browser must allow
them. On Android, they come every 15 minutes or so. See [Notifications](guide/notifications.md).

### Can someone see my email?

No. Your email is never shown to other people, and the server never includes it in what it sends about you. Only
the server's admin can see it, in the admin UI.

## Still stuck?

Ask in [GitHub issues](https://github.com/border-radius/chirkle/issues).
