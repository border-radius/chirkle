// Unread counts (§18): GET /api/chat/unread, POST /api/chat/reads and the room_reads rules.

import type { RecordModel } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import { goConst } from "../support/go-source.ts";
import {
  adminClient,
  client,
  collect,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  post,
  rawDb,
  status,
  type TestUser,
} from "./helpers.ts";

const counts = (u: TestUser) =>
  u.pb.send<{ at: string; rooms: Record<string, number>; ids: string[] }>("/api/chat/unread", { method: "GET" });
const unread = async (u: TestUser) => (await counts(u)).rooms;
const markRead = (u: TestUser, body: Record<string, unknown>) =>
  u.pb.send<{ room: string; last_read_at: string }>("/api/chat/reads", { method: "POST", body });

describe("GET /api/chat/unread (§18.2)", () => {
  it("counts other people's messages since you joined; your own and deleted ones don't count", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await post(a, room.id, "before b signed up");
    const b = await newUser();
    expect((await unread(b))[room.id]).toBeUndefined();

    await post(a, room.id, "one");
    const two = await post(a, room.id, "two");
    await post(b, room.id, "mine");
    expect((await unread(b))[room.id]).toBe(2);

    await a.pb.collection("messages").update(two.id, { deleted: true });
    expect((await unread(b))[room.id]).toBe(1);
    expect((await unread(a))[room.id]).toBe(1); // b's message; a's own never count
  });

  it("lists the recent messages it accounts for: other people's in rooms you see, read or not (QA BUG-106)", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const dm = await openDm(a, c);
    const seen = await post(a, room.id, "read already");
    await markRead(b, { room: room.id });
    const fresh = await post(a, room.id, "unread");
    const mine = await post(b, room.id, "mine");
    const hidden = await post(a, dm.id, "not b's to see");
    const { ids, rooms } = await counts(b);
    expect(rooms[room.id]).toBe(1);
    expect(ids).toEqual(expect.arrayContaining([seen.id, fresh.id]));
    expect(ids).not.toContain(mine.id);
    expect(ids).not.toContain(hidden.id);
  });

  it("counts a DM only for its members", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    await post(a, dm.id, "psst");
    expect((await unread(b))[dm.id]).toBe(1);
    expect((await unread(c))[dm.id]).toBeUndefined();
  });

  it("says when the counts were taken (server time)", async () => {
    const a = await newUser();
    const before = new Date().toISOString().replace("T", " ");
    const { at } = await counts(a);
    expect(at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(at >= before.slice(0, 19)).toBe(true);
  });

  it("stops counting at 100 (the badge shows 99+)", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const db = rawDb({ write: true });
    try {
      const insert = db.prepare(
        "INSERT INTO messages (id, room, author, text, edited_at, deleted, deleted_at, created, updated) VALUES (?, ?, ?, 'x', '', 0, '', ?, ?)",
      );
      db.exec("BEGIN");
      const start = Date.parse(b.user.created.replace(" ", "T")) + 1; // all newer than b's signup
      for (let i = 0; i < 150; i++) {
        const ts = new Date(start + i).toISOString().replace("T", " ");
        insert.run(`${room.id.slice(0, 5)}${String(i).padStart(10, "0")}`, room.id, a.user.id, ts, ts);
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    expect((await unread(b))[room.id]).toBe(100);
  });

  it("rejects anonymous callers", async () => {
    expect(await status(client().send("/api/chat/unread", { method: "GET" }))).toBe(401);
  });

  it("counts each room with a range scan on idx_messages_room_created", () => {
    // As the Go server runs it (server/unread.go).
    const sql = goConst("unreadSQL").replaceAll(/\{:(\w+)\}/g, ":$1");
    const db = rawDb();
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ me: "x", since: "x" }) as { detail: string }[]).map((r) => r.detail);
      expect(plan.join(" | ")).toMatch(/SEARCH m USING INDEX idx_messages_room_created \(room=\? AND created>\?\)/);
      expect(plan.join(" | ")).toContain("idx_room_reads_user_room");
    } finally {
      db.close();
    }
  });

  it("lists the recent messages with range scans too, never a scan of every message (QA BUG-106)", () => {
    const sql = goConst("countsSQL").replaceAll(/\{:(\w+)\}/g, ":$1");
    const db = rawDb();
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ me: "x", since: "x", from: "x" }) as { detail: string }[]).map(
        (r) => r.detail,
      );
      const ids = plan.slice(plan.indexOf("UNION ALL")).join("\n");
      expect(ids).toMatch(/SEARCH m USING INDEX idx_messages_room_created \(room=\? AND created>\?\)/);
      expect(
        plan.some((d) => /^SCAN m\b/.test(d)),
        plan.join("\n"),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("counts each room's mentions from its read position on, not every inbox row (REFACTOR item 49)", () => {
    const sql = goConst("inboxMentionsSQL").replaceAll(/\{:(\w+)\}/g, ":$1");
    const db = rawDb();
    try {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all({ me: "x", since: "x" }) as { detail: string }[]).map((r) => r.detail);
      expect(plan.join("\n")).toMatch(/SEARCH i USING INDEX idx_inbox_user_room_created \(user=\? AND room=\? AND created>\?\)/);
    } finally {
      db.close();
    }
  });
});

describe("rate limits (§18.2)", () => {
  it("hold GET /api/chat/unread to what POST /api/chat/reads gets, 120 a minute per IP (QA BUG-144)", async () => {
    const { rateLimits } = await (await adminClient()).settings.getAll();
    for (const label of ["GET /api/chat/unread", "POST /api/chat/reads"]) {
      expect(rateLimits.rules).toContainEqual(expect.objectContaining({ label, duration: 60, maxRequests: 120 }));
    }
  });
});

describe("GET /api/chat/unread/{room} (§18.2)", () => {
  const firstUnread = (u: TestUser, room: string) =>
    u.pb.send<{ id: string; created: string }>(`/api/chat/unread/${room}`, { method: "GET" });

  it("finds the oldest unread message: other people's, not deleted, after the read position", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await post(a, room.id, "before b signed up");
    const b = await newUser();
    expect(await firstUnread(b, room.id)).toEqual({ id: "", created: "" });

    await post(b, room.id, "mine");
    const one = await post(a, room.id, "one");
    const two = await post(a, room.id, "two");
    const three = await post(a, room.id, "three");
    expect(await firstUnread(b, room.id)).toEqual({ id: one.id, created: one.created });

    await a.pb.collection("messages").update(one.id, { deleted: true });
    expect((await firstUnread(b, room.id)).id).toBe(two.id);
    await markRead(b, { room: room.id, at: two.created });
    expect((await firstUnread(b, room.id)).id).toBe(three.id);
    await markRead(b, { room: room.id });
    expect((await firstUnread(b, room.id)).id).toBe("");
  });

  it("404s for an unknown room and for someone else's DM; 401 when anonymous", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    expect(await status(firstUnread(c, dm.id))).toBe(404);
    expect(await status(firstUnread(c, "nosuchroom12345"))).toBe(404);
    expect(await status(client().send(`/api/chat/unread/${dm.id}`, { method: "GET" }))).toBe(401);
  });
});

describe("POST /api/chat/reads (§18.2)", () => {
  async function busyRoom() {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    return { a, b, room };
  }

  it("clears the count up to `at`; later messages count again", async () => {
    const { a, b, room } = await busyRoom();
    await post(a, room.id, "one");
    const two = await post(a, room.id, "two");
    const res = await markRead(b, { room: room.id, at: two.created });
    expect(res).toEqual({ room: room.id, last_read_at: two.created });
    expect((await unread(b))[room.id]).toBeUndefined();
    await post(a, room.id, "three");
    expect((await unread(b))[room.id]).toBe(1);
  });

  it("without `at`, marks everything up to now as read", async () => {
    const { a, b, room } = await busyRoom();
    await post(a, room.id, "one");
    await markRead(b, { room: room.id });
    expect((await unread(b))[room.id]).toBeUndefined();
  });

  it("never moves back, and never past now", async () => {
    const { a, b, room } = await busyRoom();
    const one = await post(a, room.id, "one");
    const two = await post(a, room.id, "two");
    await markRead(b, { room: room.id, at: two.created });
    expect((await markRead(b, { room: room.id, at: one.created })).last_read_at).toBe(two.created);

    const future = await markRead(b, { room: room.id, at: "2999-01-01 00:00:00.000Z" });
    expect(future.last_read_at < "2999").toBe(true);
    await post(a, room.id, "three");
    expect((await unread(b))[room.id]).toBe(1);
  });

  it("keeps one row per user and room, also under concurrent calls", async () => {
    const { a, b, room } = await busyRoom();
    const m = await post(a, room.id, "one");
    await Promise.all(Array.from({ length: 8 }, () => markRead(b, { room: room.id, at: m.created })));
    const rows = await b.pb.collection("room_reads").getFullList({ filter: `room = "${room.id}"` });
    expect(rows).toHaveLength(1);
  });

  it("404s for an unknown room and for someone else's DM; 400 for a bad date; 401 when anonymous", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    expect(await status(markRead(c, { room: dm.id }))).toBe(404);
    expect(await status(markRead(c, { room: "nosuchroom00000" }))).toBe(404);
    expect(await status(markRead(c, {}))).toBe(404);
    expect(await status(markRead(a, { room: dm.id, at: "yesterday" }))).toBe(400);
    expect(await status(markRead(a, { room: dm.id, at: 5 }))).toBe(400);
    expect(await status(markRead(a, { room: dm.id, at: "" }))).toBe(400);
    expect(await status(client().send("/api/chat/reads", { method: "POST", body: { room: dm.id } }))).toBe(401);
    expect(await c.pb.collection("room_reads").getFullList({ filter: `room = "${dm.id}"` })).toHaveLength(0);
  });

  it("is rate limited (120 per minute)", () => {
    expect(inject("bootRateLimits").rules).toContainEqual(
      expect.objectContaining({ label: "POST /api/chat/reads", maxRequests: 120, duration: 60 }),
    );
  });
});

describe("room_reads rules (§18.1)", () => {
  it("rows are private to their user and can't be written through the API", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    await markRead(a, { room: room.id });
    const [row] = await a.pb.collection("room_reads").getFullList<RecordModel>();
    expect(row).toMatchObject({ user: a.user.id, room: room.id });

    expect(await b.pb.collection("room_reads").getFullList({ filter: `user = "${a.user.id}"` })).toHaveLength(0);
    expect(await status(b.pb.collection("room_reads").getOne(row!.id))).toBe(404);
    await expectRejected(
      a.pb.collection("room_reads").create({ user: a.user.id, room: room.id, last_read_at: "2020-01-01 00:00:00.000Z" }),
    );
    await expectRejected(a.pb.collection("room_reads").update(row!.id, { last_read_at: "2020-01-01 00:00:00.000Z" }));
    await expectRejected(a.pb.collection("room_reads").delete(row!.id));
  });

  it("a read reaches the user's other sessions live, and nobody else's", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const aOther = client();
    await aOther.collection("users").authWithPassword(a.email, a.password);
    const mine = await collect(aOther, "room_reads");
    const theirs = await collect(b.pb, "room_reads");
    await markRead(a, { room: room.id });
    await eventually(() =>
      expect(mine.events).toContainEqual(expect.objectContaining({ record: expect.objectContaining({ room: room.id }) })),
    );
    expect(theirs.events).toHaveLength(0);
    await Promise.all([mine.stop(), theirs.stop()]);
  });

  it("rows go away with their user or room (cascading relations)", () => {
    const db = rawDb();
    try {
      const row = db.prepare("SELECT fields FROM _collections WHERE name = 'room_reads'").get() as { fields: string };
      const fields = JSON.parse(row.fields) as { name: string; cascadeDelete?: boolean }[];
      expect(fields.filter((f) => f.name === "room" || f.name === "user").map((f) => f.cascadeDelete)).toEqual([true, true]);
    } finally {
      db.close();
    }
  });
});
