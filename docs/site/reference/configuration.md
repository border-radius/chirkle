---
title: Configuration reference
description: Every Chirkle setting in one place. Environment variables, command-line flags, the site record's fields and the admin UI settings.
section: Reference
order: 1
---

Chirkle is configured in three places:

- **Environment variables**, read when the server starts. Change them and restart.
- **The site record**, under *Collections → site* in the admin UI. Changes apply at once.
- **The admin UI's settings**, under *Settings*. Changes apply at once.

How to set environment variables depends on how you run Chirkle: before the command with
[`npx`](../install.md#options), `sudo systemctl edit chirkle` with [systemd](../deploy/index.md#settings), `-e` with
[Docker](../deploy/docker.md#settings), `dokku config:set` with [Dokku](../deploy/dokku.md#settings-and-logs).

## Environment variables

### Running the server

| Variable | Default | What it does |
|---|---|---|
| `HOST` | `127.0.0.1` | The address `npx chirkle` listens on. `0.0.0.0` reaches it from other machines. |
| `PORT` | `8090` | The port `npx chirkle` listens on. |
| `CHIRKLE_DATA` | `./pb_data` | Where `npx chirkle` keeps its data. |
| `TRUSTED_PROXY` | not set (the Docker image: `X-Forwarded-For`) | The header a reverse proxy puts the visitor's address in, usually `X-Forwarded-For`. `off` trusts none. Not set, the admin UI's setting stays. Set it only with a proxy in front: see [Behind a reverse proxy](../deploy/reverse-proxy.md). |

`HOST`, `PORT` and `CHIRKLE_DATA` are read by `npx chirkle`. Running the server binary yourself, use its `--http` and
`--dir` flags instead.

### Features

| Variable | Default | What it does |
|---|---|---|
| `LINK_PREVIEWS` | on | `off` turns [link previews](../admin/previews-and-thumbnails.md#link-previews) off. |
| `FFMPEG` | on | `off` turns [video thumbnails](../admin/previews-and-thumbnails.md#video-thumbnails) off. |
| `TELEGRAM_BOT_TOKEN` | not set | The bot's token. Turns the [Telegram bridge](../telegram.md) on. |
| `TELEGRAM_WEBHOOK_URL` | not set | `https://<your domain>/api/telegram/webhook`. Not set, the bridge polls Telegram, which is meant for local testing. |
| `TELEGRAM_WEBHOOK_SECRET` | made from the token | What Telegram sends with each webhook call. |
| `ANDROID_CERT_SHA256` | not set | The SHA-256 fingerprints (comma-separated) of the keys your build of the Android app is signed with, so your server's links [open in the app](../android/for-admins.md#open-room-links-in-the-app). |
| `ANDROID_APP_ID` | `com.chirkle.android` | Your build's app ID, if you changed it. |

### Performance

| Variable | Default | What it does |
|---|---|---|
| `GOMEMLIMIT` | 70% of the machine's memory | The memory the server aims to stay within, for example `700MiB`. Not set, it uses 70% of the memory limit of its container, or of the machine's RAM. |
| `GOGC` | `200` | How far the memory grows between garbage collections, as Go defines it. |
| `CHIRKLE_COMPRESS` | on | `off` sends every answer uncompressed. Only worth it if a proxy in front compresses anyway. |
| `CHIRKLE_ADMISSION` | on | `off` lets every request run at once, instead of queueing those past what the server can usefully run together. Leave it on: see [Performance](performance.md#under-overload). |

### For development and tests

`STATS_CRON`, `MEDIA_CRON` and `ACCOUNT_CRON` (`off` stops a background job, for tests that run it themselves),
`FEDERATION_ALLOW_PRIVATE`, `LINK_PREVIEWS_ALLOW_HOSTS` and `TELEGRAM_API_BASE` (point the server at local test
servers), `CHIRKLE_LEGACY` (answer as an old server does) and `CHIRKLE_PPROF` (serve Go's profiler on a local address,
for load tests). Don't set them in production.

## Command-line flags

The server is PocketBase underneath, so `chirkle-server serve` takes PocketBase's flags. `npx chirkle` passes any it
doesn't know on to it. The useful ones:

| Flag | What it does |
|---|---|
| `chat.example.com` (a domain, first) | Serve HTTPS on ports 80 and 443, with a certificate from Let's Encrypt. |
| `--http=<address>` | Serve plain HTTP on this address, for example `127.0.0.1:8090`. |
| `--https=<address>` | Serve HTTPS on this address. |
| `--dir=<folder>` | The data folder. |
| `--hooksPool=<n>` | How many requests can run the server's scripts at once. Chirkle's setups use 100. |

For the one-command systemd install's flags (`--dry-run`, `--prefix` and others), see
[Run it on a server](../deploy/index.md#options).

Other commands: `superuser upsert <email> <password>` creates or updates an admin account; `migrate`, `update` and
the others are PocketBase's own (`--help` lists them).

## The site record

*Collections → site* in the admin UI has one record:

| Field | What it does |
|---|---|
| `title` | The server's name, up to 48 characters: in the app bar, on the login page, in the tab's title. [Branding](../admin/branding-and-signups.md) |
| `logo` | An SVG, PNG, JPEG, WebP or GIF of up to 1 MB, replacing Chirkle's logo. |
| `invite_only` | Signing up needs `invite_code`. [Invite-only signups](../admin/branding-and-signups.md#invite-only-signups) |
| `invite_code` | The code. Empty while `invite_only` is ticked: signups are closed. |
| `no_stats` | Stop recording [usage statistics](../admin/moderators-and-statistics.md#usage-statistics). |
| `federation` | Turn [linking with other servers](../linking.md) on. |
| `min_android_version` | Older Android apps ask to be updated. [For admins](../android/for-admins.md#ask-old-versions-to-update) |

## Per record

| Where | Field | What it does |
|---|---|---|
| *Collections → users* | `moderator` | Makes the person a [moderator](../admin/moderators-and-statistics.md). |
| *Collections → users* | `banned` | Bans them: they're signed out and can't sign in. |
| *Collections → rooms* | `anonymous` | Makes the room [anonymous](../admin/anonymous-rooms.md). |

## The admin UI's settings

| Setting | What for |
|---|---|
| *Settings → Application → Application URL* | Your server's public address. Needed for [password reset emails](../admin/email.md) and [linking](../linking.md). |
| *Settings → Application → trusted proxy* | The same as `TRUSTED_PROXY`, when that isn't set. |
| *Settings → Mail settings* | [Email](../admin/email.md). |
| *Settings → Files storage* | Keep uploaded files [on S3](../admin/storage-and-backups.md#store-files-on-s3). |
| *Settings → Backups* | [Backups](../admin/storage-and-backups.md#backups). |
| *Settings → Rate limits* | [Rate limits](../admin/rate-limits.md). |
