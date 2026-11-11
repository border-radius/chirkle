// Migration 1760000048_inbox_reactions_merged.js: one inbox row for all of someone's reactions to a message (before,
// one per emoji). The newest is kept, with `emoji` "" (GET /api/chat/inbox names the emoji from the message).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase from "pocketbase";
import { describe, expect, it } from "vitest";
import { migrate, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

describe("migration 1760000048_inbox_reactions_merged.js", () => {
  it("merges each person's reaction rows on a message into their newest; leaves mentions, replies and others' rows", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "inbox-migration-"));
    const server = await startPocketBase({ dataDir });
    const ids: Record<string, string> = {};
    try {
      const su = new PocketBase(server.url);
      su.autoCancellation(false);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const user = (n: string) =>
        su.collection("users").create({ email: `${n}@test.local`, password: "password-123", passwordConfirm: "password-123", name: n });
      const [a, b, c] = [await user("Ann"), await user("Bob"), await user("Cat")];
      const room = await su.collection("rooms").create({ name: "inbox-mig", created_by: a.id });
      const msg = await su.collection("messages").create({ room: room.id, author: a.id, text: "hi" });
      const row = (actor: string, kind: string, emoji: string) =>
        su.collection("inbox").create({ user: a.id, kind, message: msg.id, room: room.id, actor, emoji });
      ids.b1 = (await row(b.id, "reaction", "👍")).id;
      ids.b2 = (await row(b.id, "reaction", "🎉")).id;
      ids.b3 = (await row(b.id, "reaction", "❤️")).id;
      ids.c1 = (await row(c.id, "reaction", "👍")).id;
      ids.reply = (await row(b.id, "reply", "")).id;
    } finally {
      await server.stop();
    }
    const data = new DatabaseSync(join(dataDir, "data.db"));
    try {
      // b's 🎉 is the newest of theirs.
      const at = (id: string, t: string) => data.prepare("UPDATE inbox SET created = ? WHERE id = ?").run(t, id);
      at(ids.b1!, "2026-11-01 10:00:00.000Z");
      at(ids.b2!, "2026-11-03 10:00:00.000Z");
      at(ids.b3!, "2026-11-02 10:00:00.000Z");
    } finally {
      data.close();
    }

    migrate(dataDir, "down", "1");
    migrate(dataDir, "up");
    const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
    try {
      const left = db.prepare("SELECT id, kind, emoji FROM inbox ORDER BY id").all() as { id: string; kind: string; emoji: string }[];
      expect(new Set(left.map((r) => r.id))).toEqual(new Set([ids.b2, ids.c1, ids.reply]));
      expect(left.filter((r) => r.kind === "reaction").map((r) => r.emoji)).toEqual(["", ""]);
    } finally {
      db.close();
    }
  });
});
