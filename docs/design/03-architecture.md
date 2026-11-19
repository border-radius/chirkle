# §3. Architecture

Part of the design document: [index](../DESIGN.md).

```
┌────────────────────────── Browser ───────────────────────────┐
│  index.html + app.[hash].js + app.[hash].css                 │
│                                                              │
│  router ─► views (login / rooms / room) ─► dom helpers       │
│              │                                               │
│              ▼                                               │
│            store  ◄──── api.ts (wraps pb.ts, a PB client)    │
└──────────────────────────────┬───────────────────────────────┘
                REST (JSON)    │    SSE (realtime)
┌──────────────────────────────▼───────────────────────────────┐
│     Chirkle server: PocketBase + Go hooks (single binary)    │
│  /api/*         REST + auth + realtime (SSE)                 │
│  /*             static files from pb_public/                 │
│  pb_migrations/ schema as code (JS migrations)               │
│  server/        Go: enrich, live, pages, unread (built in)   │
│  pb_hooks/      server-side validation, headers (JS)         │
│  pb_data/       SQLite DB + backups                          │
└──────────────────────────────────────────────────────────────┘
```

**Why PocketBase:** auth, a REST API, per-record access rules, realtime over SSE, an admin UI, backups and static file serving all come in one Go binary backed by SQLite. That is all an MVP chat needs. It removes the need for a separate API server, WebSocket server, or reverse proxy (PocketBase can also issue its own TLS certificates).

**PocketBase as a Go framework (2026-11-11, REFACTOR item 47):** the binary is built from `server/`, which embeds PocketBase (`pocketbase.New()`) with its JS plugin, so `pb_hooks/` and `pb_migrations/` load as before, and adds the hot, stable paths in Go: the messages enrich hook (`server/enrich.go`), live messages (`server/live.go`), the room list and message pages (`server/lists.go`), the unread counts (`server/unread.go`) and read positions (`server/reads.go`, 2026-11-12). Same flags, commands and routes as the stock `pocketbase` binary. The JS runtime (goja) had been behind most incidents: the hooks pool overflowing on message pages, runtimes held across requests (BUG-250), a Go↔JS call per enriched message, and the 1 vCPU collapse with many live listeners (PERF.md §6, §8, §9). The feature hooks (Telegram, linked instances, collections, the workers) stay in JS. A route the JS hooks define wins over the Go one of the same path (an old release's hooks, tests).

**Why no framework:** the UI has three screens and one hot path, which is appending messages to a list. Updating the DOM directly with a few small helpers is less code, loads faster, and is easy to reason about.

**Version assumption:** the design targets the PocketBase API from **v0.23 onward** (`@request.body` in rules, `$app` and `routerUse` in JS hooks, autodate fields). The exact release is pinned in `server/go.mod` (0.40.6).
