---
title: Chirkle documentation
description: How to install, run and use Chirkle, an open-source, self-hosted messenger with rooms, DMs, files and search that runs on a $5 VPS.
section: Get started
order: 1
---

Chirkle is a small, fast, real-time messenger that you run on your own server. It has rooms, direct messages, files,
replies, mentions, reactions, search and full history, a native Android app, and it can link with other Chirkle
servers and bridge rooms to Telegram groups.

The whole server is one program and one SQLite file. A $5 VPS with one CPU and 1 GB of RAM holds about 1,000 people
chatting at a normal pace ([how it was measured](reference/performance.md)).

## Where to start

- **Try it on your computer:** [Install and run](install.md) takes one command, `npx chirkle`.
- **Put it on a server:** [Run it on a server](deploy/index.md) gets you HTTPS on your own domain, a service that
  survives reboots, and updates. It also covers [Docker](deploy/docker.md), [Dokku](deploy/dokku.md) and running
  [behind a reverse proxy](deploy/reverse-proxy.md).
- **Learn the app:** [Using Chirkle](guide/rooms.md) explains rooms, DMs, messages, files, collections, search and
  notifications, for everyone who chats on a Chirkle server.
- **Get the Android app:** [Android app](android/index.md).
- **Set up your server:** [Administration](admin/index.md) covers branding, invite-only signups, moderators, email,
  backups and more.
- **Connect beyond your server:** [Linked servers](linking.md) and the [Telegram bridge](telegram.md).
- **Look something up:** the [configuration reference](reference/configuration.md) lists every setting in one place.

## What you get

- **Rooms** that anyone can create, with three levels of access: **Private** (only the people you add), **Public**
  (everyone with an account) and **Open Air** (anyone can read, even without an account).
- **Direct messages** between any two people.
- **Messages** that update live everywhere: edits, deletes, replies with a quote, @mentions, emoji reactions, and
  forwarding up to 50 messages at once.
- **Files:** up to 10 per message, 20 MB each, with an image viewer and a media grid for each room.
- **Collections** of saved images and videos, private or public, which you can attach from and share.
- **Full history and search:** scroll back to the very first message of any room, and search any room or DM.
- **Notifications** of DMs, replies and mentions, with no Google, Apple or Mozilla push service involved.
- **An installable web app** (PWA) and a **native Android app**, a 3 MB download.
- **For the server's admin:** your own name and logo, invite-only signups, moderators, anonymous rooms, usage
  statistics, backups, S3 storage and password reset emails.

## Try it first

The demo at [chat.chirkle.com](https://chat.chirkle.com) runs the latest version. Sign up there to look around before
you install anything.

## Get help

Questions, bug reports and ideas go to [GitHub issues](https://github.com/border-radius/chirkle/issues). The
[FAQ](faq.md) answers the common ones.
