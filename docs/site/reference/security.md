---
title: Security and privacy
description: How Chirkle protects messages, files and accounts. Access rules, private files, deleted content, rate limits, safe link previews, and what the server stores.
section: Reference
order: 4
---

## Who can see what

Access is decided on the server, by the database's rules, for every request: the apps only show what the server
already allowed.

- **Rooms:** a private room and its messages are visible only to its members; a public room to everyone with an
  account; an Open Air room to anyone. See [Rooms](../guide/rooms.md#who-can-see-a-room).
- **DMs** are visible only to their two people. [Moderators](../admin/moderators-and-statistics.md) can't read other
  people's DMs or private rooms they aren't in.
- **Files** are opened by an address that can't be guessed: it holds the message's ID and a random part of the file's
  name, and only people who can read the message see either. Anyone given the address can open the file, so treat it
  like the file itself. Once the message is deleted, the address stops working.
- **Email addresses** are never shown to anyone else, and no API answer includes them.
- **The server's admin** (a superuser) can read everything in the admin UI, as on any server you don't run yourself.

## Messages and accounts

- **Deleted messages are gone.** Deleting wipes a message's text on the server; only a placeholder (who and when)
  stays. Its files are deleted too, unless someone saved them to a collection.
- **Nobody can post as someone else,** or change who wrote a message.
- **Changing your password** signs out every other device. So does a password reset.
- **Banned accounts** are signed out everywhere and can't sign in.
- **You can download your data, and delete your account,** with or without your messages: see
  [Your account](../guide/account.md#download-your-data).

## In the browser

- **Nothing anyone writes can run as code.** Messages, names and room names are shown as plain text, never as HTML, and
  the build fails if the web app's code could insert HTML. A strict Content Security Policy allows no inline scripts.
- **Logging out clears** what Chirkle keeps in the browser to load faster: cached rooms and thumbnails.

## Against abuse

- **[Rate limits](../admin/rate-limits.md)** per IP address on sending, reacting, signing up and more.
- **Uploads are capped** per file, per message and by the sending rate. Forwards copy no files.
- **[Link previews](../admin/previews-and-thumbnails.md#link-previews)** fetch only public web addresses, so a link
  can't make the server reach inside your network, and read only the start of a page.
- **Video thumbnails** are made by `ffmpeg` reading only the uploaded file, with a time limit, not as root.
- **Invite codes** are compared in constant time, and wrong guesses are slowed by the signup rate limit. Room invite
  links are 24 random letters and digits, and expire after at most 30 days.

## Without third parties

- **No push service.** Notifications on the web and on Android come straight from your server: no Google, Apple or
  Mozilla service sees who writes to whom.
- **No analytics or trackers** in the apps. [Usage statistics](../admin/moderators-and-statistics.md#usage-statistics),
  if on, are counts kept on your own server, without names.
- **Link previews** are fetched by your server, not by people's browsers, so the linked sites don't see who reads the
  message.

## For the admin

- Use a strong password for superusers: they can read and change everything.
- Keep the server and Chirkle up to date. [Updating](../deploy/index.md#update) is one command.
- Behind a reverse proxy, set `TRUSTED_PROXY`, and don't set it without one:
  [Behind a reverse proxy](../deploy/reverse-proxy.md).

## Report a vulnerability

Please report security issues privately to the maintainers rather than in a public issue.
