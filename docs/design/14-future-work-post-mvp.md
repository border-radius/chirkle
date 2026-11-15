# §14. Future work (post-MVP)

Part of the design document: [index](../DESIGN.md).

Blocking users, link previews, typing and presence (custom realtime channels via `$app.subscriptionsBroker()`), OAuth2 providers, and HttpOnly cookie auth. Message search (§29) could move to SQLite FTS5 (a custom route) if rooms grow past a few hundred thousand messages. (The service worker: §27.)
