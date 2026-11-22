// Migration 1760000051_users_kind.js (REFACTOR item 50): every account gets its kind from what told them apart before,
// the made-up e-mail's domain, a tg_people row, or `peer`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase from "pocketbase";
import { describe, expect, it } from "vitest";
import { migrate, migrateDownPast, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

describe("migration 1760000051_users_kind.js", () => {
  it("backfills person, telegram and peer", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "kind-migration-"));
    const server = await startPocketBase({ dataDir });
    const ids: Record<string, string> = {};
    try {
      const su = new PocketBase(server.url);
      su.autoCancellation(false);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const user = (name: string, email: string) =>
        su.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name });
      ids.person = (await user("Person", "person@test.local")).id;
      // Made-up addresses are refused now (QA SEC-3): given below, in the database as it was.
      ids.tgEmail = (await user("Tg email", "tgemail@test.local")).id;
      ids.tgRow = (await user("Tg row", "tgrow@test.local")).id;
      await su.collection("tg_people").create({ user: ids.tgRow, tg_user_id: 4242, name: "x" });
      ids.fedEmail = (await user("Fed email", "fedemail@test.local")).id;
      ids.fedPeer = (await user("Fed peer", "fedpeer@test.local")).id;
    } finally {
      await server.stop();
    }

    migrateDownPast(dataDir, "1760000051_users_kind.js");
    const before = new DatabaseSync(join(dataDir, "data.db"));
    try {
      before.prepare("UPDATE users SET peer = 'somepeer0000001' WHERE id = ?").run(ids.fedPeer!);
      before.prepare("UPDATE users SET email = ? WHERE id = ?").run("tg1.abcdef@telegram.invalid", ids.tgEmail!);
      before.prepare("UPDATE users SET email = ? WHERE id = ?").run("fedabc@federation.invalid", ids.fedEmail!);
    } finally {
      before.close();
    }
    migrate(dataDir, "up");

    const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
    try {
      const kind = (id: string) => (db.prepare("SELECT kind FROM users WHERE id = ?").get(id) as { kind: string }).kind;
      expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, kind(id)]))).toEqual({
        person: "person",
        tgEmail: "telegram",
        tgRow: "telegram",
        fedEmail: "peer",
        fedPeer: "peer",
      });
    } finally {
      db.close();
    }
  });
});
