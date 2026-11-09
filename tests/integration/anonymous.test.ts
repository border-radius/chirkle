// Anonymous rooms (DESIGN.md §35): a superuser marks a room `anonymous` in the admin UI; its messages then show the
// room, not their authors, to everyone but the author and superusers: in the records API, the list routes, realtime,
// replies' quotes, forwards and the media grid. Nobody else can filter, sort or expand by author to find out.

import type { RecordModel } from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { adminClient, barrier, collect, eventually, expectRejected, newRoom, newUser, post, status, type TestUser } from "./helpers.ts";

const FIELDS =
  "id,room,author,anonymous,forwarded_anonymous,forwarded_from,expand.author.id,expand.author.name,expand.author.no_dms," +
  "expand.forwarded_from.id,expand.forwarded_from.name,expand.reply_to.author,expand.reply_to.expand.author.name";
const EXPAND = "author,forwarded_from,reply_to.author";

let admin: Awaited<ReturnType<typeof adminClient>>;

beforeAll(async () => {
  admin = await adminClient();
});

/** A room of `owner`'s, made anonymous by a superuser. */
async function anonymousRoom(owner: TestUser, extra: Record<string, unknown> = {}) {
  const room = await newRoom(owner);
  return admin.collection("rooms").update(room.id, { anonymous: true, ...extra });
}

const view = (u: TestUser, id: string) => u.pb.collection("messages").getOne(id, { expand: EXPAND, fields: FIELDS });

describe("anonymous rooms (§35)", () => {
  it("only a superuser makes a room anonymous; no client stamps a message", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(a.pb.collection("rooms").update(room.id, { anonymous: true }));
    await expectRejected(a.pb.collection("rooms").create({ name: `r-${room.id}`, created_by: a.user.id, anonymous: true }));
    await expectRejected(post(a, room.id, "x", { anonymous: true }));
    const m = await post(a, room.id, "plain");
    expect(m.anonymous).toBe(false);
    await expectRejected(a.pb.collection("messages").update(m.id, { anonymous: true }));
    expect(await status(admin.collection("rooms").update(room.id, { anonymous: true }))).toBe(200);
  });

  it("shows the room as the author to others, the author to themselves and to superusers", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    const m = await post(a, room.id, "who said this?");
    expect(m.anonymous).toBe(true);

    const seen = await view(b, m.id);
    expect(seen.author).toBe(room.id);
    expect(seen.expand?.author).toEqual({ id: room.id, name: room.name, no_dms: true });
    expect(JSON.stringify(seen)).not.toContain(a.user.id);
    expect(JSON.stringify(seen)).not.toContain(a.user.name);

    expect((await view(a, m.id)).expand?.author).toMatchObject({ id: a.user.id, name: a.user.name });
    expect((await admin.collection("messages").getOne(m.id, { expand: "author" })).author).toBe(a.user.id);

    // The author still edits and deletes it.
    await a.pb.collection("messages").update(m.id, { text: "edited" });
    expect(await status(b.pb.collection("messages").update(m.id, { text: "mine now" }))).toBe(404);
  });

  it("follows a rename of the room", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    const m = await post(a, room.id, "hello");
    expect((await view(b, m.id)).expand?.author.name).toBe(room.name);
    await admin.collection("rooms").update(room.id, { name: `${room.name}-renamed` });
    expect((await view(b, m.id)).expand?.author.name).toBe(`${room.name}-renamed`);
  });

  it("stamps messages when they are posted: turning it on or off later changes none", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const before = await post(a, room.id, "before");
    await admin.collection("rooms").update(room.id, { anonymous: true });
    const during = await post(a, room.id, "during");
    await admin.collection("rooms").update(room.id, { anonymous: false });
    const after = await post(a, room.id, "after");
    expect((await view(b, before.id)).author).toBe(a.user.id);
    expect((await view(b, during.id)).author).toBe(room.id);
    expect((await view(b, after.id)).author).toBe(a.user.id);
  });

  it("hides the author in the list routes, the records API's lists, replies' quotes and the notification check", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    const m = await post(a, room.id, "first");
    const reply = await post(b, room.id, "answer", { reply_to: m.id });

    const page = await b.pb.send<RecordModel[]>(`/api/chat/rooms/${room.id}/messages`, {
      query: { kind: "latest", expand: EXPAND, fields: FIELDS },
    });
    expect(page.map((r) => r.author)).toEqual([b.user.id, room.id]); // newest first; the reply is b's own
    expect(page[0]!.expand?.reply_to.author).toBe(room.id);
    expect(page[0]!.expand?.reply_to.expand?.author.name).toBe(room.name);
    expect(JSON.stringify(page)).not.toContain(a.user.id);

    const list = await b.pb.collection("messages").getFullList({ filter: `room = "${room.id}"`, expand: EXPAND, fields: FIELDS });
    expect(JSON.stringify(list)).not.toContain(a.user.id);

    // a is notified of the reply; c, who wrote nothing, sees both as the room's.
    const c = await newUser();
    const mine = await a.pb.send<RecordModel[]>("/api/chat/notifiable", {
      query: { rooms: room.id, since: "2000-01-01", expand: EXPAND, fields: FIELDS },
    });
    expect(mine.map((r) => r.id)).toEqual([reply.id]);
    expect(mine[0]!.expand?.reply_to.author).toBe(a.user.id);
    const theirs = await c.pb.send<RecordModel[]>("/api/chat/notifiable", {
      query: { rooms: room.id, every: room.id, since: "2000-01-01", expand: EXPAND, fields: FIELDS },
    });
    expect(theirs.map((r) => r.author)).toEqual([room.id, room.id]);
    expect(JSON.stringify(theirs)).not.toContain(a.user.id);
    expect(JSON.stringify(theirs)).not.toContain(b.user.id);
  });

  it("hides the author in realtime events", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    const sub = await collect(b.pb, "messages", { filter: `room = "${room.id}"`, expand: "author", fields: FIELDS });
    try {
      const m = await post(a, room.id, "live");
      await eventually(() => expect(sub.events.map((e) => e.record.id)).toContain(m.id));
      const e = sub.events.find((x) => x.record.id === m.id)!;
      expect(e.record.author).toBe(room.id);
      expect(e.record.expand?.author.name).toBe(room.name);
      expect(JSON.stringify(e.record)).not.toContain(a.user.id);
      await barrier(sub, () => post(b, room.id, "marker"));
    } finally {
      await sub.stop();
    }
  });

  it("refuses filters, sorts and expands that would say who wrote what", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    await post(a, room.id, "secret");
    const refused = [
      () => b.pb.collection("messages").getList(1, 10, { filter: `room = "${room.id}" && author = "${a.user.id}"` }),
      () => b.pb.collection("messages").getList(1, 10, { filter: `author.name = "${a.user.name}"` }),
      () => b.pb.collection("messages").getList(1, 10, { filter: `room = "${room.id}"`, sort: "author" }),
      () => b.pb.collection("messages").getList(1, 10, { filter: `forwarded_from != ""` }),
      () => b.pb.collection("users").getList(1, 10, { filter: `messages_via_author.room ?= "${room.id}"` }),
      () => b.pb.collection("users").getOne(a.user.id, { expand: "messages_via_author" }),
      // Every route that answers with records takes the expand: an auth answer, a save, and our own lists.
      () => b.pb.collection("users").authRefresh({ expand: "messages_via_author" }),
      () => b.pb.collection("users").update(b.user.id, { name: "B" }, { expand: "messages_via_author" }),
      () => b.pb.send("/api/chat/rooms", { query: { expand: "created_by.messages_via_author" } }),
      () => b.pb.send(`/api/chat/rooms/${room.id}/messages`, { query: { expand: "author.messages_via_author" } }),
    ];
    for (const [i, call] of refused.entries()) expect(await status(call()), `refused[${i}]`).toBe(400);
    // PocketBase's own refusal, before any hook of ours: only superusers filter by @collection.
    expect(await status(b.pb.collection("rooms").getList(1, 10, { filter: `@collection.messages.author ?= "${a.user.id}"` }))).toBe(403);
    // Spelled with escapes, it is still the field.
    const escaped = await fetch(`${b.pb.baseURL}/api/collections/messages/records?filter=%61uthor%3D%22${a.user.id}%22`, {
      headers: { Authorization: b.pb.authStore.token },
    });
    expect(escaped.status).toBe(400);
    // Comparing an author with yourself says only which messages are yours: apps from before 2026-10-29 filter so.
    const legacy = b.pb.filter(`room = {:room} && author != {:me} && (room.kind = "dm" || reply_to.author = {:me})`, {
      room: room.id,
      me: b.user.id,
    });
    expect(await status(b.pb.collection("messages").getList(1, 10, { filter: legacy }))).toBe(200);
    expect(await status(b.pb.collection("messages").getList(1, 10, { filter: b.pb.filter("author != {:a}", { a: a.user.id }) }))).toBe(400);
    // A word in a value is not a field.
    expect(await status(b.pb.collection("messages").getList(1, 10, { filter: `room = "${room.id}" && text ~ "author"` }))).toBe(200);
    expect(await status(admin.collection("messages").getList(1, 10, { filter: `author = "${a.user.id}"`, sort: "author" }))).toBe(200);
  });

  it("refuses realtime subscriptions that filter by author", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    await expect(collect(b.pb, "messages", { filter: `room = "${room.id}" && author = "${a.user.id}"` })).rejects.toThrow();
  });

  it("forwards of an anonymous message are from its room, or from no name out of a private one", async () => {
    const a = await newUser();
    const b = await newUser();
    const open = await anonymousRoom(a);
    const closed = await anonymousRoom(a, { visibility: "private", members: [a.user.id, b.user.id] });
    const elsewhere = await newRoom(b);
    const m1 = await post(a, open.id, "out loud");
    const m2 = await post(a, closed.id, "behind doors");
    const fwd = await b.pb.send<RecordModel[]>("/api/chat/forward", {
      method: "POST",
      body: { messages: [m1.id, m2.id], room: elsewhere.id },
    });
    const c = await newUser();
    const [f1, f2] = await Promise.all(fwd.map((f) => view(c, f.id)));
    expect(f1!.forwarded_anonymous).toBe(true);
    expect(f1!.expand?.forwarded_from).toEqual({ id: open.id, name: open.name });
    expect(f2!.expand?.forwarded_from.name).toBe("Anonymous");
    expect(JSON.stringify([f1, f2])).not.toContain(a.user.id);
    expect(f1!.author).toBe(b.user.id); // the forward's own author: elsewhere isn't anonymous
    // Its author sees their own name.
    expect((await view(a, fwd[0]!.id)).expand?.forwarded_from.id).toBe(a.user.id);
  });

  it("hides the author in the media grid", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await anonymousRoom(a);
    const file = new File([new Uint8Array(pngOf(32, 32))], "p.png", { type: "image/png" });
    await a.pb.collection("messages").create({ room: room.id, author: a.user.id, files: [file] });
    const grid = (u: TestUser) => u.pb.send<{ items: { author: { id: string; name: string } }[] }>(`/api/chat/media/${room.id}`, {});
    expect((await grid(b)).items[0]!.author).toEqual({ id: room.id, name: room.name });
    expect((await grid(a)).items[0]!.author).toEqual({ id: a.user.id, name: a.user.name });
  });

  it("never applies to DMs", async () => {
    const a = await newUser();
    const b = await newUser();
    const dm = await a.pb.send<RecordModel>("/api/chat/dms", { method: "POST", body: { user: b.user.id } });
    await admin.collection("rooms").update(dm.id, { anonymous: true });
    const m = await post(a, dm.id, "hi");
    expect(m.anonymous).toBe(false);
    expect((await view(b, m.id)).author).toBe(a.user.id);
  });
});
