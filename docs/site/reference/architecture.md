---
title: Architecture
description: How Chirkle is built. One PocketBase binary with Go, SQLite, a framework-free TypeScript web app, a native Android app, and live updates over SSE.
section: Reference
order: 3
---

Chirkle is small on purpose: one server program, one database file, and clients that load almost nothing.

```
┌────────────────────────── Browser ───────────────────────────┐
│  index.html + app.[hash].js + app.[hash].css                 │
│  router ─► views ─► DOM helpers                              │
│              ▲                                               │
│            store ◄──── api.ts (a small PocketBase client)    │
└──────────────────────────────┬───────────────────────────────┘
                REST (JSON)    │    server-sent events (live)
┌──────────────────────────────▼───────────────────────────────┐
│     Chirkle server: PocketBase + Go (one binary)             │
│  /api/*          REST, accounts, live updates                │
│  /*              the web app's files                         │
│  pb_migrations/  the schema and access rules, as code        │
│  pb_hooks/       server-side logic, in JavaScript            │
│  server/         the busiest paths, in Go                    │
│  pb_data/        the SQLite database and uploaded files      │
└──────────────────────────────────────────────────────────────┘
```

## The server

The server is [PocketBase](https://pocketbase.io), used as a Go framework. PocketBase brings accounts, a REST API,
per-record access rules, live updates over server-sent events, an admin UI, backups, file storage and HTTPS with
Let's Encrypt, in one program backed by SQLite. Chirkle adds:

- **Access rules and the schema as migrations** (`pb_migrations/`): who can read and write what is decided by the
  database's rules, in one place, and checked by tests.
- **Hooks in JavaScript** (`pb_hooks/`): validation, unread counts, DMs, invite links, collections, the
  [Telegram bridge](../telegram.md), [linked servers](../linking.md), and the background workers.
- **The busiest paths in Go** (`server/`): message pages, the room list, live messages, unread counts and read
  positions. They used to be JavaScript; compiled, the same CPU serves several times the people
  ([Performance](performance.md)).

The binary takes the same commands and flags as `pocketbase`, so PocketBase's documentation applies.

### Background workers

Work that can wait runs in the background, one minute's run at a time, so no request waits for it: link previews,
thumbnails and video posters, data exports, deleting accounts, the Telegram bridge's and linked servers' deliveries,
and the daily prune. Each is a queue in the database; the [metrics](../admin/retention-and-metrics.md#metrics) show
them.

## The web app

Vanilla TypeScript, no UI framework, bundled by esbuild into about 50 KB of JavaScript and 11 KB of CSS. The UI's hot
path is adding messages to a list, which a few small DOM helpers do with less code and less loading than a framework.

- **Screens used less often** (the image viewer, search, collections, the emoji picker) load the first time they're
  opened.
- **A room cache** in the browser shows a room's latest messages at once while the server answers.
- **A service worker** keeps thumbnails, so going back to a room downloads nothing again, and makes the app
  installable.
- **Every message on screen is a window** of at most 300, however far back you scroll.

## The Android app

Native: Kotlin and Jetpack Compose, a 3 MB download, with no Google services. It shares the server's contract with
the web app: the field lists, limits and test cases in `shared/` are checked against both clients, so they can't drift
apart. See the [client API](api.md).

## Live updates

Each client keeps one server-sent events connection. A new, edited or deleted message is sent once, to everyone who
can see its room. Clients reconnect on their own, and fill in what they missed while away.

## Read more

The design notes in the repository explain each feature's how and why, section by section:
[`docs/DESIGN.md`](https://github.com/border-radius/chirkle/blob/master/docs/DESIGN.md). Code and tests refer to
them by section number.
