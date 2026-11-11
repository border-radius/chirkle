// Migration 1760000047_telegram_supergroup_ids.js (QA BUG-257): the tg_messages that a supergroup migration moved to
// the new chat id are dropped, but only for a chat whose sends failed on the unique index (the logs say so).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase from "pocketbase";
import { describe, expect, it } from "vitest";
import { migrate, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

describe("migration 1760000047_telegram_supergroup_ids.js", () => {
  it("drops a migrated group's mappings from before the move, where the logs show the collisions; leaves the rest", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tg-migration-"));
    const server = await startPocketBase({ dataDir });
    const moved = "-1009000000001";
    const healthy = "-1009000000002";
    try {
      const su = new PocketBase(server.url);
      su.autoCancellation(false);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const me = await su
        .collection("users")
        .create({ email: "tgmig@test.local", password: "password-123", passwordConfirm: "password-123", name: "Mig" });
      const room = await su.collection("rooms").create({ name: "tg-mig", created_by: me.id });
      const msg = await su.collection("messages").create({ room: room.id, author: me.id, text: "hi" });
      for (const chat_id of [moved, healthy]) {
        await su.collection("tg_links").create({ chat_id, title: "G", room: room.id, enabled: true });
        for (const tg_message_id of [1, 2, 3])
          await su.collection("tg_messages").create({ message: msg.id, chat_id, tg_message_id, direction: "out", kind: "text" });
      }
    } finally {
      await server.stop();
    }

    // Rows 1 and 2 are from before the move (the link saved then), 3 from after; the first collision came later still.
    const data = new DatabaseSync(join(dataDir, "data.db"));
    try {
      data.prepare("UPDATE tg_messages SET created = '2026-11-01 10:00:00.000Z' WHERE tg_message_id IN (1, 2)").run();
      data.prepare("UPDATE tg_messages SET created = '2026-11-05 10:00:00.000Z' WHERE tg_message_id = 3").run();
      data.prepare("UPDATE tg_links SET updated = '2026-11-03 10:00:00.000Z'").run();
    } finally {
      data.close();
    }
    const aux = new DatabaseSync(join(dataDir, "auxiliary.db"));
    try {
      const error = "GoError: chat_id: Value must be unique; part: Value must be unique; tg_message_id: Value must be unique.";
      aux
        .prepare("INSERT INTO _logs (id, level, message, data, created) VALUES (?, 4, 'telegram: send', ?, ?)")
        .run("tgmiglog0000001", JSON.stringify({ message: "x", chat: moved, try: 1, error }), "2026-11-06 10:00:00.000Z");
    } finally {
      aux.close();
    }

    // Back to before 1760000047 (1760000048 came after it), then up again.
    migrate(dataDir, "down", "2");
    migrate(dataDir, "up");
    const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
    try {
      const left = db.prepare("SELECT chat_id, tg_message_id FROM tg_messages ORDER BY chat_id, tg_message_id").all();
      expect(left.map((r) => `${r.chat_id} ${r.tg_message_id}`)).toEqual([`${moved} 3`, `${healthy} 1`, `${healthy} 2`, `${healthy} 3`]);
    } finally {
      db.close();
    }
  });
});
