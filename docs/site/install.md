---
title: Install and run Chirkle
description: Run Chirkle on your own computer with one command, npx chirkle, create the admin account, and change the address, port and data folder.
section: Get started
order: 2
---

Chirkle is an npm package. It brings the web app and a ready-built server with it, so there's nothing to clone, build
or download separately. This page runs it on your own computer. To put it on a server with a domain and HTTPS, see
[Run it on a server](deploy/index.md).

## What you need

- **Node.js 22 or newer and npm 11 or newer.** Check with `node -v` and `npm -v`.
- **Linux or macOS**, on x64 or arm64. On Windows, use WSL or the [Docker image](deploy/docker.md).
- **Optional:** `ffmpeg` and `curl` on the `PATH`. The server uses `ffmpeg` to make video thumbnails and `curl` to fetch
  link previews. Chirkle runs fine without them, and quietly does without those two features.

## Run it

In any folder:

```sh
npx chirkle
```

Then open <http://127.0.0.1:8090> and click **Sign up**. Chirkle keeps all its data (the SQLite database and uploaded
files) in a `pb_data` folder inside the folder you ran it from.

## Create the admin account

The admin account (PocketBase calls it a *superuser*) signs in to the admin UI, where the server's settings live. It is
separate from the account you chat with.

The first run prints a link that creates it. Or, in a second terminal in the same folder:

```sh
npx chirkle superuser upsert you@example.com <password>
```

Then sign in at <http://127.0.0.1:8090/_/>. [Administration](admin/index.md) explains what you can set there.

## Options

| To | Set |
|---|---|
| Keep the data somewhere else | `CHIRKLE_DATA=/path/to/data` (default `./pb_data`) |
| Use another port | `PORT=3000` (default `8090`) |
| Reach it from other devices on your network, for example to try the Android app on your phone | `HOST=0.0.0.0`, then use your computer's local IP address |
| Pass any `pocketbase serve` flag | add it after the command: `npx chirkle --http=0.0.0.0:80` |

For example:

```sh
HOST=0.0.0.0 PORT=3000 CHIRKLE_DATA=~/chirkle-data npx chirkle
```

The [configuration reference](reference/configuration.md) lists every setting.

To start over, stop the server and delete the `pb_data` folder.

## Give it a domain

On a machine that a domain points at, with ports 80 and 443 open, give the domain as the first argument:

```sh
npx chirkle chat.example.com
```

Chirkle then serves HTTPS itself, with a certificate from Let's Encrypt. No nginx or Caddy needed.
[Run it on a server](deploy/index.md) sets this up properly, as a service that starts on boot.

## Other commands

`npx chirkle` passes every other command to the server, which is PocketBase underneath: `npx chirkle superuser …`,
`npx chirkle migrate …` and so on, all on the same data folder.

## From source

To change Chirkle itself, see [Development](reference/development.md): it runs from a clone of the repository, with a
dev server that rebuilds the web app as you edit.
