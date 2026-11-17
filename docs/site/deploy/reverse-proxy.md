---
title: Run Chirkle behind a reverse proxy
description: Put Chirkle behind nginx, Caddy or another reverse proxy. The three settings it needs, with example configs.
section: Get started
order: 4
---

If nginx, Caddy or another proxy already owns ports 80 and 443 on your server, run Chirkle on a local port and proxy
to it. Otherwise you don't need a proxy: Chirkle serves HTTPS itself ([Run it on a server](index.md)).

## Run Chirkle on a local port

With the one-command install, give no domain:

```sh
sudo npx chirkle install-service
```

It then listens on `127.0.0.1:8090` and sets `TRUSTED_PROXY=X-Forwarded-For` for you. `--http=<address>` picks another
address.

Or, run by hand:

```sh
TRUSTED_PROXY=X-Forwarded-For npx chirkle    # listens on 127.0.0.1:8090
```

## What the proxy needs

1. **Don't buffer `/api/realtime`.** It is a server-sent events stream that carries live messages. Buffered, messages
   arrive late or in bursts.
2. **Allow request bodies up to 210 MB.** A message can carry 10 files of 20 MB each. Most proxies allow far less by
   default (nginx: 1 MB).
3. **Pass the visitor's address** in `X-Forwarded-For`, and start Chirkle with `TRUSTED_PROXY=X-Forwarded-For`.
   Chirkle's [rate limits](../admin/rate-limits.md) count per visitor's IP address. Without this setting, every request
   seems to come from the proxy, and one visitor tripping a limit trips it for everyone. Chirkle uses the rightmost
   address in the header, the one your proxy added, so visitors can't choose their own.

## nginx

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate … ; ssl_certificate_key … ;

    client_max_body_size 210m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/realtime {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

## Caddy

Caddy streams server-sent events without buffering and adds `X-Forwarded-For` on its own:

```caddy
chat.example.com {
    request_body {
        max_size 210MB
    }
    reverse_proxy 127.0.0.1:8090
}
```

## When nothing is in front

The [Docker image](docker.md) sets `TRUSTED_PROXY=X-Forwarded-For`, since it expects a proxy. If visitors reach its
port directly instead, start it with `TRUSTED_PROXY=off`: otherwise they could send their own `X-Forwarded-For` and
choose the address the rate limits count.

When `TRUSTED_PROXY` isn't set at all, Chirkle keeps whatever is configured in the admin UI under
*Settings → Application*.
