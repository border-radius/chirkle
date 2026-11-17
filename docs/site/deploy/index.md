---
title: Run Chirkle on a server
description: Put Chirkle on a VPS with your own domain and HTTPS in one command, as a systemd service that survives reboots. Updating, uninstalling and running it by hand.
section: Get started
order: 3
---

Give Chirkle a domain and it serves HTTPS on its own, with a certificate from Let's Encrypt. On a Linux server, one
command installs it as a systemd service that starts on boot and restarts if it stops.

Prefer containers? See [Docker](docker.md) or [Dokku](dokku.md). Already running nginx or Caddy? See
[Behind a reverse proxy](reverse-proxy.md).

## What you need

- **A Linux server.** One CPU and 1 GB of RAM is plenty: that holds about 1,000 people chatting at a normal pace
  ([Performance](../reference/performance.md)).
- **Node.js 22 or newer and npm 11 or newer** on it.
- **A domain** pointing at it: an `A` record (and `AAAA` for IPv6) for, say, `chat.example.com` with the server's IP.
- **Ports 80 and 443** open.
- **Optional:** `ffmpeg` and `curl`, for video thumbnails and link previews. On Debian or Ubuntu:
  `sudo apt install ffmpeg curl`.

## Install it

```sh
sudo npx chirkle install-service chat.example.com
```

This:

- copies the server and the web app to `/opt/chirkle`;
- creates a system user, `chirkle`, which owns the data folder `/opt/chirkle/pb_data` and nothing else;
- writes `/etc/systemd/system/chirkle.service`, sandboxed so the service can't write anywhere but its data;
- enables and starts it.

The first visit to `https://chat.example.com` fetches the certificate. Then create the admin account:

```sh
sudo -u chirkle /opt/chirkle/chirkle-server superuser upsert you@example.com <password> --dir=/opt/chirkle/pb_data
```

Sign in to the admin UI at `https://chat.example.com/_/`, and go through [Administration](../admin/index.md): set the
Application URL, your name and logo, signups, email and backups.

Logs: `journalctl -u chirkle -f`.

### Options

| Flag | What it does |
|---|---|
| `--dry-run` | Prints the unit file and what it would do, and changes nothing. Use it to review the setup, or to write the unit yourself. |
| `--http=127.0.0.1:8090` | No domain: listen on a local address for a reverse proxy on the same machine ([Behind a reverse proxy](reverse-proxy.md)). This is also what happens when you give no domain. |
| `--prefix=<dir>` | Install somewhere other than `/opt/chirkle`. |
| `--data=<dir>` | Keep the data somewhere other than `<prefix>/pb_data`. |
| `--user=<name>` | Run as a user other than `chirkle`. |
| `--name=<unit>` | Name the service something other than `chirkle`, to run several side by side. |

Any other flag goes to the server.

### Settings

Environment variables, such as those for the [Telegram bridge](../telegram.md) or turning off
[link previews](../admin/previews-and-thumbnails.md), go in an override that survives reinstalls:

```sh
sudo systemctl edit chirkle
```

```ini
[Service]
Environment=TELEGRAM_BOT_TOKEN=123456:ABC…
Environment=FFMPEG=off
```

Most other settings live in the admin UI. The [configuration reference](../reference/configuration.md) lists both.

## Update

Take a [backup](../admin/storage-and-backups.md) first, then run the install again with the latest version:

```sh
sudo npx chirkle@latest install-service chat.example.com
```

The files are replaced and the service restarted. Your data stays. Database changes (migrations) run on their own when
the server starts, and it serves nothing until they're done.

Give the same flags you installed with, if any.

## Uninstall

```sh
sudo npx chirkle uninstall-service
```

This stops, disables and removes the service. The files and the data stay in `/opt/chirkle` for you to delete.

## By hand

The server is PocketBase with Chirkle's busiest code built in, so it takes the same commands and flags as the
`pocketbase` binary. To run it under another init system, or on a machine without Node:

1. Build it once, on any machine with Node and Go 1.27+, from a clone of the
   [repository](https://github.com/border-radius/chirkle):

   ```sh
   npm ci && npm run setup && npm run build
   ```

   For another platform, `node scripts/build-server.mjs --all` builds every one into `bin/release/`.

2. Copy the server and its folders:

   ```sh
   rsync -a bin/chirkle-server pb_public pb_migrations pb_hooks server:/opt/chirkle/
   ```

3. Run it, with the capability to bind ports 80 and 443 (`CAP_NET_BIND_SERVICE`):

   ```sh
   /opt/chirkle/chirkle-server serve chat.example.com --hooksPool=100 \
     --dir=/opt/chirkle/pb_data --publicDir=/opt/chirkle/pb_public \
     --migrationsDir=/opt/chirkle/pb_migrations --hooksDir=/opt/chirkle/pb_hooks
   ```

`npx chirkle install-service chat.example.com --dry-run` prints a systemd unit with these settings that you can start
from.
