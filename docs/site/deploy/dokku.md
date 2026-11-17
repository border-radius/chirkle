---
title: Run Chirkle on Dokku
description: Deploy Chirkle to Dokku from the prebuilt image or from git, with persistent storage, HTTPS, and automatic updates that follow master.
section: Get started
order: 6
---

Dokku runs the same image as [Docker](docker.md), with its own proxy and Let's Encrypt in front.

## Set up the app

On the Dokku host:

```sh
dokku apps:create chirkle
dokku storage:ensure-directory chirkle
dokku storage:mount chirkle /var/lib/dokku/data/storage/chirkle:/pb_data
dokku domains:set chirkle chat.example.com
dokku nginx:set chirkle client-max-body-size 210m
dokku letsencrypt:enable chirkle   # needs the dokku-letsencrypt plugin
```

- **The storage mount** keeps all data (the SQLite database and uploaded files) on the host, outside the container.
  `storage:ensure-directory` gives it to the image's user (32767).
- **`client-max-body-size`:** Dokku's nginx allows 1 MB request bodies by default, and a message can carry 10 files of
  20 MB.

## Deploy

### From the prebuilt image

GitHub builds `ghcr.io/border-radius/chirkle:<commit>` for every commit on `master` that passes the tests, so the server
only pulls and restarts, however many apps run it. Each deploy needs a new tag, so use the commit:

```sh
dokku git:from-image chirkle ghcr.io/border-radius/chirkle:<commit>
```

### From git

Build on the server, from a clone of the repository with the Dokku app as a remote:

```sh
git remote add dokku dokku@server:chirkle
git push dokku master
```

or straight from GitHub:

```sh
dokku git:sync --build chirkle https://github.com/border-radius/chirkle.git master
```

Building needs more memory and time than pulling the image.

## Create the admin account

```sh
dokku run chirkle /app/chirkle-server superuser upsert you@example.com <password> --dir=/pb_data
```

Then sign in at `https://chat.example.com/_/` and go through [Administration](../admin/index.md).

## Settings and logs

- **Settings:** `dokku config:set chirkle KEY=value`, which restarts the app. The
  [configuration reference](../reference/configuration.md) lists them. The image already sets `TRUSTED_PROXY` for
  Dokku's proxy.
- **Server output:** `dokku logs chirkle -t`.
- **Request log and errors:** in the admin UI, under *Logs*.

## Follow master automatically

To keep the app on the latest commit that passed the tests, run a script like this from cron, every few minutes:

```sh
#!/bin/sh
# Deploy the image of master's latest commit, once GitHub has built it.
APP=chirkle
IMAGE=ghcr.io/border-radius/chirkle
STATE=/var/lib/chirkle-autoupdate/$APP

sha=$(git ls-remote https://github.com/border-radius/chirkle.git refs/heads/master | cut -f1)
[ -n "$sha" ] || exit 0                                # GitHub unreachable: try next time
[ "$sha" = "$(cat "$STATE" 2>/dev/null)" ] && exit 0   # already running it
docker pull -q "$IMAGE:$sha" >/dev/null 2>&1 || exit 0 # no image yet: tests or the build are still running
mkdir -p "$(dirname "$STATE")"
dokku git:from-image "$APP" "$IMAGE:$sha" && echo "$sha" > "$STATE"
```

A commit that fails the tests gets no image, so the app keeps running what it has. The image takes a few minutes to
appear after a push.

Old images pile up over time; `docker image prune -af --filter "until=24h"` in the same cron job clears those no app
uses.
