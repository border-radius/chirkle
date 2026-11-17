---
title: Data retention and server metrics
description: What a Chirkle server prunes on its own every day, what it never deletes, and how to monitor it with the metrics endpoint and Prometheus.
section: Administration
order: 9
---

## What is pruned

Once a day, the server cleans up what would otherwise only grow:

- **Mentions & replies:** each person keeps their newest 500 entries, none older than 180 days.
- **Leftovers** of deleted messages, rooms and accounts: read positions, hidden rooms, unfinished jobs and the like.
- **Expired [invite links](../guide/rooms.md#invite-links)**, a day after they expire.
- **[Data exports](../guide/account.md#download-your-data)**, after 7 days.
- **[Usage statistics](moderators-and-statistics.md#usage-statistics):** the counts taken every 5 minutes are kept a
  year, and each person's activity 90 days. Tick `no_stats` on the site record to stop recording them at all.

**Messages and files are never pruned.** Every room keeps its full history.

## Metrics

`GET /api/chat/metrics` reports the server's state for monitoring. Only superusers can read it.

- **Queues:** for each background job (Telegram, linked servers, link previews, thumbnails, file moves, cleanup), how
  many jobs wait, how many failed at least once, and the oldest one's age.
- **Workers:** when each one last ran, and its last error.
- **Realtime:** connections, events waiting, slow clients dropped.
- **The server:** uptime, versions, database size, memory, and how many requests are waiting their turn.

It answers in JSON, or in Prometheus's text format with `?format=prometheus` (or when the request asks for text, as
scrapers do). The [`/stats` page](moderators-and-statistics.md#usage-statistics) shows the same to a superuser.

### Scraping it with Prometheus

A scraper needs a superuser token. Make a long-lived one with PocketBase's impersonate call: signed in as a superuser,
`POST /api/collections/_superusers/impersonate/{id}` with a long `duration` in seconds, where `{id}` is the superuser's
id. Then:

```yaml
scrape_configs:
  - job_name: chirkle
    scheme: https
    metrics_path: /api/chat/metrics
    params:
      format: [prometheus]
    authorization:
      credentials: <the superuser token>
    static_configs:
      - targets: [chat.example.com]
```

### Health

`GET /api/health` answers 200 while the server is up. The [Docker image](../deploy/docker.md#health-check) and
[Dokku](../deploy/dokku.md) use it.
