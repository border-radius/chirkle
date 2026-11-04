// Several messages at once (§21): POST /api/chat/delete soft-deletes the caller's own messages, POST /api/chat/forward
// forwards messages the caller can see into a room or DM they can write in, pointing at them. All or nothing.

import type { RecordModel } from "pocketbase";
import { describe, expect, it } from "vitest";
import { MSG_FIELDS } from "../../web/src/api.ts";
import { MAX_SELECTED } from "../../web/src/lib/limits.ts";
import {
  adminClient,
  client,
  collect,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  pngFile,
  post,
  rawDb,
  status,
  type TestUser,
  uniq,
} from "./helpers.ts";

const del = (u: TestUser, messages: unknown) => u.pb.send<RecordModel[]>("/api/chat/delete", { method: "POST", body: { messages } });

const fwd = (u: TestUser, messages: unknown, room: unknown, query?: Record<string, string>) =>
  u.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages, room }, ...(query ? { query } : {}) });

const get = (u: TestUser, id: string) => u.pb.collection("messages").getOne(id);

const roomMessages = (u: TestUser, room: string) =>
  u.pb.collection("messages").getFullList({ filter: u.pb.filter("room = {:room}", { room }), sort: "created,id" });

describe("delete several messages (§21.2)", () => {
  it("soft-deletes them all, answering with the deleted messages", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two", { files: [pngFile("p.png")] });
    const keep = await post(a, room.id, "three");
    const res = await del(a, [m2.id, m1.id]);
    expect(res.map((m) => [m.id, m.deleted, m.text, m.files])).toEqual([
      [m1.id, true, "", []],
      [m2.id, true, "", []],
    ]);
    expect(await get(b, m1.id)).toMatchObject({ deleted: true, text: "" });
    expect(await get(b, keep.id)).toMatchObject({ deleted: false, text: "three" });
  });

  it("only your own: one message by someone else refuses the whole request (403)", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const mine = await post(a, room.id, "mine");
    const theirs = await post(b, room.id, "theirs");
    expect(await status(del(a, [mine.id, theirs.id]))).toBe(403);
    expect(await get(a, mine.id)).toMatchObject({ deleted: false, text: "mine" });
    expect(await get(a, theirs.id)).toMatchObject({ deleted: false });
  });

  it("is idempotent: already deleted ones are left as they are", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two");
    await del(a, [m1.id]);
    const res = await del(a, [m1.id, m2.id, m2.id]);
    expect(res.map((m) => [m.id, m.deleted])).toEqual([
      [m1.id, true],
      [m2.id, true],
    ]);
  });

  it("refuses archived rooms, unknown or invisible messages, bad bodies, and anonymous callers", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(del(a, [msg.id]))).toBe(400);
    await a.pb.collection("rooms").update(room.id, { archived: false });

    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    expect(await status(del(c, [secret.id]))).toBe(404);
    expect(await status(del(a, [msg.id, "nosuchmessage00"]))).toBe(404);
    for (const bad of [[], "x", [1], [""], null, Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `m${i}`)]) {
      expect(await status(del(a, bad))).toBe(400);
    }
    expect(await get(a, msg.id)).toMatchObject({ deleted: false });
    a.pb.authStore.clear();
    expect(await status(del(a, [msg.id]))).toBe(401);
  });

  it("everyone in the room sees the deletes live", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const m1 = await post(a, room.id, "one");
    const m2 = await post(a, room.id, "two");
    const sub = await collect(b.pb, "messages", { filter: `room = "${room.id}"` });
    try {
      await del(a, [m1.id, m2.id]);
      await eventually(() =>
        expect(sub.events.filter((e) => e.action === "update" && e.record.deleted).map((e) => e.record.id)).toEqual([m1.id, m2.id]),
      );
    } finally {
      await sub.stop();
    }
  });
});

describe("forward messages (§21.3)", () => {
  /** A private room of `owner`'s with these members. */
  const privateRoom = async (owner: TestUser, members: TestUser[] = []) => {
    const room = await owner.pb.collection("rooms").create({ name: `private-${uniq()}`, created_by: owner.user.id, visibility: "private" });
    return owner.pb.collection("rooms").update(room.id, { members: [owner.user.id, ...members.map((m) => m.user.id)] });
  };
  /** What is stored for a message, not what the API shows. */
  const stored = (id: string) =>
    rawDb().prepare("SELECT text, files, file_names, forward_of FROM messages WHERE id = ?").get(id) as Record<string, string>;

  it("points at them in their order, by the caller, showing their words and saying who first wrote them", async () => {
    const a = await newUser();
    const b = await newUser();
    const from = await newRoom(a);
    const to = await newRoom(b);
    const m1 = await post(a, from.id, "first");
    const m2 = await post(b, from.id, "second");
    const reply = await post(a, from.id, "third", { reply_to: m1.id });
    await b.pb.send("/api/chat/reactions", { method: "POST", body: { message: m1.id, emoji: "👍", on: true } });

    const res = await fwd(b, [reply.id, m1.id, m2.id], to.id);
    expect(res.map((m) => [m.room, m.author, m.text, m.forward_of, m.forwarded_from, m.reply_to, m.reactions, m.edited_at])).toEqual([
      [to.id, b.user.id, "first", m1.id, a.user.id, "", [], ""],
      [to.id, b.user.id, "second", m2.id, b.user.id, "", [], ""],
      [to.id, b.user.id, "third", reply.id, a.user.id, "", [], ""],
    ]);
    expect((await roomMessages(a, to.id)).map((m) => m.text)).toEqual(["first", "second", "third"]);
    // Nothing is copied: the forward stores only where it points.
    expect(stored(res[0]!.id)).toMatchObject({ text: "", forward_of: m1.id });
    expect(await get(a, m1.id)).toMatchObject({ room: from.id, text: "first", forwarded_from: "", forward_of: "" });
  });

  it("a forward of a forward points at the original and still names who first wrote it", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const msg = await post(a, (await newRoom(a)).id, "origin");
    const [once] = await fwd(b, [msg.id], (await newRoom(b)).id);
    const [twice] = await fwd(c, [once!.id], (await newRoom(c)).id);
    expect(twice).toMatchObject({ author: c.user.id, forwarded_from: a.user.id, forward_of: msg.id, text: "origin" });
  });

  it("shows the original as it is now: edits live, and nothing once it is deleted, which can't be forwarded on", async () => {
    const a = await newUser();
    const b = await newUser();
    const msg = await post(a, (await newRoom(a)).id, "draft");
    const to = await privateRoom(b);
    const [copy] = await fwd(b, [msg.id], to.id);
    const sub = await collect(b.pb, "messages", { filter: `room = "${to.id}"`, expand: "reply_to" });
    try {
      await a.pb.collection("messages").update(msg.id, { text: "final" });
      await eventually(() => expect(sub.events.at(-1)?.record).toMatchObject({ id: copy!.id, text: "final" }));
      expect((await get(b, copy!.id)).edited_at).not.toBe("");
      await del(a, [msg.id]);
      await eventually(() => expect(sub.events.at(-1)?.record).toMatchObject({ id: copy!.id, text: "", files: [], deleted: false }));
    } finally {
      await sub.stop();
    }
    expect(await status(fwd(b, [copy!.id], to.id))).toBe(400);
    // The forward itself is still there: its author can delete it.
    expect((await del(b, [copy!.id]))[0]).toMatchObject({ deleted: true });
  });

  it("an original removed for good (by a superuser) leaves its forwards showing nothing", async () => {
    const a = await newUser();
    const msg = await post(a, (await newRoom(a)).id, "soon gone");
    const room = await newRoom(a);
    const [copy] = await fwd(a, [msg.id], room.id);
    await (await adminClient()).collection("messages").delete(msg.id);
    expect(await get(a, copy!.id)).toMatchObject({ text: "", forward_of: "", forwarded_from: a.user.id, deleted: false });
    expect(await status(fwd(a, [copy!.id], room.id))).toBe(400);
    expect((await del(a, [copy!.id]))[0]).toMatchObject({ deleted: true });
  });

  it("copies no files: the attachments are the original's, readable wherever the forward is", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const secret = await privateRoom(a);
    const msg = await post(a, secret.id, "", { files: [pngFile("holiday.png")] });
    const dm = await openDm(a, b);
    const [copy] = await fwd(a, [msg.id], dm.id);
    expect(copy!.files).toEqual(msg.files);
    expect(Object.values(copy!.file_names)).toEqual(["holiday.png"]);
    expect(stored(copy!.id)).toMatchObject({ files: "[]" });
    // By URL (§37.3): the original's, or the forward's own, whoever has it.
    const fileStatus = async (u: TestUser, of = msg) => {
      const res = await fetch(u.pb.files.getURL(of, msg.files[0]));
      return [res.status, res.status === 200 ? res.headers.get("content-type") : null];
    };
    expect(await fileStatus(b)).toEqual([200, "image/png"]);
    expect(await fileStatus(c)).toEqual([200, "image/png"]);
    expect(await fileStatus(b, copy!)).toEqual([200, "image/png"]);

    // In an Open Air room, guests too.
    const open = await a.pb.collection("rooms").create({ name: `open-${uniq()}`, created_by: a.user.id, visibility: "open" });
    const [shown] = await fwd(a, [msg.id], open.id);
    const guest = client();
    expect((await guest.collection("messages").getOne(shown!.id)).files).toEqual(msg.files);
    expect((await fetch(guest.files.getURL(msg, msg.files[0]))).status).toBe(200);
  });

  it("the readers of a forward see only that message of the original's room, and only while the forward is there", async () => {
    const a = await newUser();
    const b = await newUser();
    const secret = await privateRoom(a);
    const msg = await post(a, secret.id, "just this one");
    const other = await post(a, secret.id, "not this one");
    const reply = await post(a, secret.id, "nor this", { reply_to: msg.id });
    const room = await newRoom(b);
    const [copy] = await fwd(a, [msg.id], room.id);

    expect(await get(b, msg.id)).toMatchObject({ text: "just this one" });
    expect(await status(get(b, other.id))).toBe(404);
    expect(await status(get(b, reply.id))).toBe(404);
    expect(await status(get(b, secret.id))).toBe(404);
    expect(await roomMessages(b, secret.id)).toEqual([]);
    expect((await b.pb.collection("rooms").getList(1, 50, { filter: `id = "${secret.id}"` })).items).toEqual([]);
    // Not something to act on in a room they can't see: no reactions, no forwarding it by id, no replies there.
    const react = b.pb.send("/api/chat/reactions", { method: "POST", body: { message: msg.id, emoji: "👍", on: true } });
    expect(await status(react)).toBe(404);
    expect(await status(fwd(b, [msg.id], room.id))).toBe(404);
    await expectRejected(post(b, secret.id, "hi", { reply_to: msg.id }));

    await del(a, [copy!.id]);
    expect(await status(get(b, msg.id))).toBe(404);
  });

  it("the original, read through a forward, doesn't say who is in its room: no reactions, no reply_to", async () => {
    const a = await newUser();
    const c = await newUser();
    const b = await newUser();
    const secret = await privateRoom(a, [c]);
    const parent = await post(c, secret.id, "earlier");
    const msg = await post(a, secret.id, "shared", { reply_to: parent.id });
    await c.pb.send("/api/chat/reactions", { method: "POST", body: { message: msg.id, emoji: "👍", on: true } });
    const room = await newRoom(b);
    await fwd(a, [msg.id], room.id);

    const seen = await b.pb.collection("messages").getOne(msg.id, { expand: "reply_to" });
    expect(seen).toMatchObject({ text: "shared", reactions: [], reply_to: "" });
    expect(seen.expand?.reply_to).toBeUndefined();
    // Its room's members still see them.
    expect(await get(c, msg.id)).toMatchObject({ reactions: [{ emoji: "👍", users: [c.user.id] }], reply_to: parent.id });
  });

  it("a reply to a forward quotes the original's words", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, (await newRoom(a)).id, "quote me");
    const [copy] = await fwd(a, [msg.id], room.id);
    const reply = await post(a, room.id, "replying", { reply_to: copy!.id });
    const read = await a.pb.collection("messages").getOne(reply.id, { expand: "reply_to.author", fields: MSG_FIELDS });
    expect(read.expand?.reply_to).toMatchObject({ id: copy!.id, text: "quote me" });
  });

  it("a forward can be deleted but not edited: its words are someone else's", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(b, room.id, "I said this");
    const [copy] = await fwd(a, [msg.id], room.id);
    expect(await status(a.pb.collection("messages").update(copy!.id, { text: "I never said this" }))).toBe(400);
    expect(await get(b, copy!.id)).toMatchObject({ text: "I said this", edited_at: "" });
    expect((await del(a, [copy!.id]))[0]).toMatchObject({ deleted: true, text: "" });
  });

  it("answers expanded like a read of each message", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const query = { expand: "author,reply_to.author,forwarded_from", fields: MSG_FIELDS };
    const [copy] = await fwd(a, [msg.id], room.id, query);
    expect(copy).toEqual(await a.pb.collection("messages").getOne(copy!.id, query));
    expect(copy).toMatchObject({ text: "hello", forward_of: msg.id });
    expect(copy!.expand?.forwarded_from).toEqual({ id: a.user.id, name: a.user.name });
    expect(copy).not.toHaveProperty("expand.author.email");
  });

  it("into a DM: only its members; the recipient's closed DM reopens", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "look at this");
    const dm = await openDm(a, b);
    expect(await status(fwd(c, [msg.id], dm.id))).toBe(404);
    const hidden = await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: dm.id });
    await fwd(a, [msg.id], dm.id);
    expect(await status(b.pb.collection("hidden_rooms").getOne(hidden.id))).toBe(404);
    expect((await b.pb.collection("rooms").getOne(dm.id)).last_message_at).not.toBe("");
  });

  it("only messages you can see, not deleted; only rooms you can write in; all or nothing", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(c);
    const visible = await post(c, room.id, "public");
    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    // C can't forward A–B's DM message anywhere, not even with a visible one.
    expect(await status(fwd(c, [visible.id, secret.id], room.id))).toBe(404);
    expect(await status(fwd(c, ["nosuchmessage00"], room.id))).toBe(404);
    expect(await status(fwd(c, [visible.id], "nosuchroom0000"))).toBe(404);
    const gone = await post(c, room.id, "gone");
    await del(c, [gone.id]);
    expect(await status(fwd(c, [visible.id, gone.id], room.id))).toBe(400);
    const archived = await newRoom(c);
    await c.pb.collection("rooms").update(archived.id, { archived: true });
    expect(await status(fwd(c, [visible.id], archived.id))).toBe(400);
    for (const bad of [[], "x", [1], null, Array.from({ length: MAX_SELECTED + 1 }, (_, i) => `m${i}`)]) {
      expect(await status(fwd(c, bad, room.id))).toBe(400);
    }
    expect((await roomMessages(c, room.id)).length).toBe(2); // nothing was forwarded
    c.pb.authStore.clear();
    expect(await status(fwd(c, [visible.id], room.id))).toBe(401);
  });

  it("forwarded_from and forward_of can't be set or changed by clients, superusers included", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const theirs = await post(b, room.id, "theirs");
    for (const [field, value] of [
      ["forwarded_from", b.user.id],
      ["forward_of", theirs.id],
    ] as const) {
      await expectRejected(post(a, room.id, "fake", { [field]: value }));
      await expectRejected(post(a, room.id, "fake", { [`${field}+`]: value }));
      const msg = await post(a, room.id, "real");
      await expectRejected(a.pb.collection("messages").update(msg.id, { [field]: value }));
      await expectRejected(a.pb.collection("messages").update(msg.id, { [`${field}+`]: value }));
      const admin = await adminClient();
      await expectRejected(admin.collection("messages").update(msg.id, { [field]: value }));
      const [copy] = await fwd(a, [msg.id], room.id);
      await expectRejected(a.pb.collection("messages").update(copy!.id, { [field]: "" }));
      expect(await get(a, copy!.id)).toMatchObject({ forwarded_from: a.user.id, forward_of: msg.id });
      // Deleting keeps it.
      expect((await del(a, [copy!.id]))[0]).toMatchObject({ deleted: true, forwarded_from: a.user.id, forward_of: msg.id });
    }
  });

  it("are rate limited (20 per minute per IP each)", async () => {
    const admin = await adminClient();
    const { rateLimits } = await admin.settings.getAll();
    for (const label of ["POST /api/chat/forward", "POST /api/chat/delete"]) {
      expect(rateLimits.rules).toContainEqual(expect.objectContaining({ label, duration: 60, maxRequests: 20 }));
    }
  });
});
