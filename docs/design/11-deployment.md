# §11. Deployment

Part of the design document: [index](../DESIGN.md).

Deployment artifacts are `bin/chirkle-server`, `pb_public/`, `pb_migrations/` and `pb_hooks/`.

- Run under systemd with `chirkle-server serve chat.example.com`, which issues a Let's Encrypt certificate automatically. Alternatively, run it behind an existing reverse proxy. `sudo npx chirkle install-service chat.example.com` sets this up (user, files in /opt/chirkle, the unit) and upgrades it when run again.
- Migrations run automatically on start.
- Use PocketBase's built-in scheduled backups (Settings → Backups), stored locally or in S3-compatible storage.
- Uploaded files (avatars, attachments; §15, §17) live in `pb_data/storage` (or S3-compatible storage set in PocketBase's settings) and are included in backups, so plan disk space for them.
- Scale target for the MVP: a single node. SQLite in WAL mode easily handles thousands of concurrent SSE clients and hundreds of messages per second at this size.
