---
title: Run Chirkle with Docker
description: Run Chirkle from its Docker image, with the web app, the server, ffmpeg and curl included. Data volume, admin account, updates and HTTPS.
section: Get started
order: 5
---

Chirkle's Docker image has the web app, the server, `ffmpeg` (video thumbnails) and `curl` (link previews). It listens
on port 8090 over plain HTTP, so put a [reverse proxy](reverse-proxy.md) in front of it for HTTPS.

## The image

GitHub builds `ghcr.io/border-radius/chirkle` for every commit on `master` that passes the tests, tagged with the
commit and as `latest`. Or build it yourself from a clone of the
[repository](https://github.com/border-radius/chirkle):

```sh
git clone https://github.com/border-radius/chirkle && cd chirkle
docker build -t chirkle .
```

## Run it

```sh
docker run -d --name chirkle --restart unless-stopped \
  -p 127.0.0.1:8090:8090 -v chirkle-data:/pb_data \
  ghcr.io/border-radius/chirkle:latest
```

All data (the SQLite database and uploaded files) lives in the `/pb_data` volume. Inside the image, the server runs as
user 32767; if you mount a folder from the host instead of a named volume, give that user ownership of it.

Create the admin account:

```sh
docker exec chirkle /app/chirkle-server superuser upsert you@example.com <password> --dir=/pb_data
```

Then sign in to the admin UI at `/_/` and go through [Administration](../admin/index.md).

## Settings

Pass environment variables with `-e`, for example `-e TELEGRAM_BOT_TOKEN=…`. The
[configuration reference](../reference/configuration.md) lists them.

The image sets `TRUSTED_PROXY=X-Forwarded-For`, because it expects a proxy in front. If visitors reach port 8090
directly, add `-e TRUSTED_PROXY=off`: otherwise they could choose the address the [rate limits](../admin/rate-limits.md)
count.

## Health check

The image checks `/api/health` every 30 seconds, so `docker ps` shows whether the server is healthy.

## Update

Take a [backup](../admin/storage-and-backups.md) first. Then pull the new image and start a new container on the same
volume:

```sh
docker pull ghcr.io/border-radius/chirkle:latest
docker stop chirkle && docker rm chirkle
docker run -d --name chirkle --restart unless-stopped \
  -p 127.0.0.1:8090:8090 -v chirkle-data:/pb_data \
  ghcr.io/border-radius/chirkle:latest
```

Database changes run on their own when the server starts.

## Docker Compose

```yaml
services:
  chirkle:
    image: ghcr.io/border-radius/chirkle:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:8090:8090"
    volumes:
      - chirkle-data:/pb_data
    # environment:
    #   TELEGRAM_BOT_TOKEN: "123456:ABC…"

volumes:
  chirkle-data:
```
