// Retention (REFACTOR item 49, pb_hooks/lib/retention.js): the daily prune keeps a person's newest 500 inbox rows, none
// older than 180 days, and drops the rows deletes that skipped the hooks left behind. A server of its own: the prune
// goes through every table, and other files' rows aren't its test's to judge.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../web/src/lib/id.ts";
import { toPb } from "../../web/src/lib/time.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { runSql, type SqlStatement } from "../support/sql.ts";

let server: PocketBaseServer;
beforeAll(async () => {
  server = await startPocketBase({ fixtureRoute: true, env: { MEDIA_CRON: "off", LINK_PREVIEWS: "off", STATS_CRON: "off" } });
  await disableRateLimits(server.url);
}, 60_000);
afterAll(() => server?.stop());

const admin = async () => {
  const pb = new PocketBase(server.url);
  await pb.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return pb;
};
const signUp = async (name: string) => {
  const pb = new PocketBase(server.url);
  const email = `${name}@test.local`;
  const rec = await pb.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name });
  await pb.collection("users").authWithPassword(email, "password-123");
  return { pb, id: rec.id };
};
const count = (sql: string, params: Record<string, string> = {}) => {
  const db = new DatabaseSync(join(server.dataDir, "data.db"), { readOnly: true });
  try {
    return (db.prepare(sql).get(params) as { n: number }).n;
  } finally {
    db.close();
  }
};
const message = (id: string, room: string, author: string, ts: number, deleted = false): SqlStatement => ({
  sql: `INSERT INTO messages (id, room, author, text, text_key, edited_at, deleted, deleted_at, created, updated)
        VALUES ({:id}, {:room}, {:a}, 'hi', 'hi', '', {:d}, '', {:ts}, {:ts})`,
  params: { id, room, a: author, d: deleted ? 1 : 0, ts: toPb(ts) },
});
const inboxRow = (id: string, user: string, msg: string, room: string, actor: string, ts: number): SqlStatement => ({
  sql: "INSERT INTO inbox (id, user, kind, message, room, actor, emoji, created) VALUES ({:id}, {:u}, 'mention', {:m}, {:r}, {:a}, '', {:ts})",
  params: { id, u: user, m: msg, r: room, a: actor, ts: toPb(ts) },
});
const tick = async () =>
  (await (await admin()).send<{ deleted: Record<string, number> }>("/api/retention/tick", { method: "POST" })).deleted;

describe("the daily prune", () => {
  it("keeps a person's newest 500 inbox rows, none older than 180 days", async () => {
    const a = await signUp("ret-a");
    const b = await signUp("ret-b");
    const room = await b.pb.collection("rooms").create({ name: "ret", created_by: b.id, visibility: "public" });
    const now = Date.now();
    const stmts: SqlStatement[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 510; i++) {
      const m = newId();
      const id = newId();
      ids.push(id);
      stmts.push(message(m, room.id, b.id, now - (600 - i) * 60_000), inboxRow(id, a.id, m, room.id, b.id, now - (600 - i) * 60_000));
    }
    // b: three rows, one of them 181 days old.
    for (let i = 0; i < 3; i++) {
      const m = newId();
      const t = i === 0 ? now - 181 * 24 * 3600_000 : now - i * 60_000;
      stmts.push(message(m, room.id, a.id, t), inboxRow(newId(), b.id, m, room.id, a.id, t));
    }
    await runSql(server.url, stmts);
    const deleted = await tick();
    expect(deleted.inbox_old).toBe(1);
    expect(deleted.inbox_over).toBe(10);
    expect(count("SELECT COUNT(*) AS n FROM inbox WHERE user = :u", { u: a.id })).toBe(500);
    expect(
      count(
        "SELECT COUNT(*) AS n FROM inbox WHERE id IN (" +
          ids
            .slice(0, 10)
            .map((i) => `'${i}'`)
            .join(",") +
          ")",
      ),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM inbox WHERE user = :u", { u: b.id })).toBe(2);
    // The messages stay: history is never pruned.
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE room = :r", { r: room.id })).toBe(513);
    // A second prune has nothing left to do.
    expect(Object.values(await tick()).every((n) => n === 0)).toBe(true);
  });

  it("drops rows left behind by deletes that skipped the hooks, and only those", async () => {
    const a = await signUp("orph-a");
    const b = await signUp("orph-b");
    const room = await b.pb.collection("rooms").create({ name: "orph", created_by: b.id, visibility: "public" });
    const now = Date.now();
    const kept = newId();
    const gone = newId();
    const missing = newId();
    const noRoom = newId();
    const other = newId();
    await runSql(server.url, [
      message(kept, room.id, b.id, now - 3000),
      message(gone, room.id, b.id, now - 2000, true),
      message(other, room.id, b.id, now - 1000),
      inboxRow("inboxkeep000001", a.id, kept, room.id, b.id, now - 3000),
      inboxRow("inboxgone000001", a.id, gone, room.id, b.id, now - 2000),
      inboxRow("inboxmiss000001", a.id, missing, room.id, b.id, now - 1000),
      inboxRow("inboxroom000001", a.id, other, noRoom, b.id, now - 1000),
      {
        sql: "INSERT INTO room_reads (id, user, room, last_read_at) VALUES ('rrkeep00000001', {:u}, {:r}, {:t})",
        params: { u: a.id, r: room.id, t: toPb(now) },
      },
      {
        sql: "INSERT INTO room_reads (id, user, room, last_read_at) VALUES ('rrgone00000001', {:u}, {:r}, {:t})",
        params: { u: a.id, r: noRoom, t: toPb(now) },
      },
      {
        sql: "INSERT INTO hidden_rooms (id, user, room, created) VALUES ('hrgone00000001', 'nobody00000001', {:r}, {:t})",
        params: { r: room.id, t: toPb(now) },
      },
      { sql: "INSERT INTO inbox_reads (id, user, seen_at) VALUES ('irgone00000001', 'nobody00000001', {:t})", params: { t: toPb(now) } },
      {
        sql: "INSERT INTO media (id, room, message, source, file, pos, video, sent) VALUES ('mdkeep00000001', {:r}, {:m}, '', 'a.png', 0, 0, {:t}), ('mdgone00000001', {:r}, {:g}, '', 'b.png', 0, 0, {:t}), ('mdfwd000000001', {:r}, {:m}, {:g}, 'c.png', 0, 0, {:t})",
        params: { r: room.id, m: kept, g: gone, t: toPb(now) },
      },
      { sql: "INSERT INTO link_queue (id, message, created) VALUES ('lqgone00000001', {:g}, {:t})", params: { g: gone, t: toPb(now) } },
    ]);
    const deleted = await tick();
    expect(deleted).toMatchObject({
      inbox_orphans: 3,
      room_reads_orphans: 1,
      inbox_reads_orphans: 1,
      hidden_rooms_orphans: 1,
      media_orphans: 2,
      link_queue_orphans: 1,
    });
    expect(count("SELECT COUNT(*) AS n FROM inbox WHERE user = :u", { u: a.id })).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM room_reads WHERE id = 'rrkeep00000001'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM media WHERE id = 'mdkeep00000001'")).toBe(1);
  });

  it("is for superusers only", async () => {
    const a = await signUp("ret-nosu");
    await expect(a.pb.send("/api/retention/tick", { method: "POST" })).rejects.toMatchObject({ status: 403 });
  });
});

// Operational metrics (REFACTOR item 51, server/metrics.go).
describe("GET /api/chat/metrics", () => {
  it("answers a superuser: queues, workers (a prune is noted), realtime, database, process", async () => {
    await tick();
    const m = await (await admin()).send<{
      version: string;
      queues: Record<string, { rows: number; failing: number; oldest_seconds: number }>;
      workers: Record<string, { last_pass: string; last_error: string; running: boolean }>;
      realtime: { clients: number; senders: number; queued: number; dropped: number };
      db: Record<string, number>;
      process: { goroutines: number; heap_bytes: number };
    }>("/api/chat/metrics", {});
    expect(Object.keys(m.queues).sort()).toEqual(
      ["federation", "link_previews", "media_moves", "media_sizes", "media_thumbs", "storage_cleanup", "telegram"].sort(),
    );
    expect(m.queues.telegram).toEqual({ rows: 0, failing: 0, oldest_seconds: 0 });
    expect(Object.keys(m.workers).sort()).toEqual(["federation", "media", "previews", "retention", "telegram"]);
    expect(Date.now() - Date.parse(m.workers.retention!.last_pass)).toBeLessThan(60_000);
    expect(m.workers.retention!.last_error).toBe("");
    expect(m.realtime).toMatchObject({ clients: expect.any(Number), dropped: 0 });
    expect(m.db["data.db"]).toBeGreaterThan(0);
    expect(m.process.goroutines).toBeGreaterThan(0);
  });

  it("counts a queue's rows, its failing ones and its oldest's age", async () => {
    const old = toPb(Date.now() - 3600_000);
    await runSql(server.url, [
      {
        sql: `INSERT INTO tg_queue (id, op, message, chat_id, album, payload, tries, next_at, locked_until, error, created, updated)
              VALUES ('tgq00000000001', 'send', 'x', '1', '', '{}', 3, {:t}, '', 'boom', {:t}, {:t}),
                     ('tgq00000000002', 'send', 'y', '1', '', '{}', 0, {:t}, '', '', {:n}, {:n})`,
        params: { t: old, n: toPb(Date.now()) },
      },
    ]);
    try {
      const m = await (await admin()).send<{ queues: Record<string, { rows: number; failing: number; oldest_seconds: number }> }>(
        "/api/chat/metrics",
        {},
      );
      expect(m.queues.telegram).toMatchObject({ rows: 2, failing: 1 });
      expect(m.queues.telegram!.oldest_seconds).toBeGreaterThan(3500);
    } finally {
      await runSql(server.url, [{ sql: "DELETE FROM tg_queue WHERE id IN ('tgq00000000001', 'tgq00000000002')" }]);
    }
  });

  it("speaks Prometheus's text format when asked", async () => {
    const pb = await admin();
    for (const init of [
      { query: "?format=prometheus", accept: "*/*" },
      { query: "", accept: "text/plain;version=0.0.4;q=0.9,*/*;q=0.1" },
    ]) {
      const res = await fetch(`${server.url}/api/chat/metrics${init.query}`, {
        headers: { authorization: pb.authStore.token, accept: init.accept },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
      const text = await res.text();
      expect(text).toMatch(/^# HELP chirkle_info /m);
      expect(text).toMatch(/^chirkle_queue_rows\{queue="telegram"\} \d+$/m);
      expect(text).toMatch(/^chirkle_worker_last_pass_timestamp_seconds\{worker="retention"\} \d+$/m);
      expect(text).toMatch(/^chirkle_db_bytes\{file="data.db"\} [1-9]\d*$/m);
    }
  });

  it("is for superusers only", async () => {
    const a = await signUp("metrics-user");
    await expect(a.pb.send("/api/chat/metrics", {})).rejects.toMatchObject({ status: 403 });
    expect((await fetch(`${server.url}/api/chat/metrics`)).status).toBe(401);
  });
});
