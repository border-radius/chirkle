// GET /api/chat/rooms, GET /api/chat/rooms/{room}/messages and GET /api/chat/notifiable (pb_hooks/lib/lists.js,
// docs/API.md): the same answers the records API gives for the filters the clients used to write. Search (`q`) is in
// search.test.ts. Who sees what is checked by access.matrix.test.ts.

import type { RecordModel } from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { client, newRoom, newUser, openDm, pngFile, post, status, type TestUser, uniq } from "./helpers.ts";

type Items = RecordModel[];

describe("the room list and message pages as routes", () => {
  let me: TestUser;
  let room: RecordModel;
  let sent: RecordModel[];

  beforeAll(async () => {
    me = await newUser();
    room = await newRoom(me);
    sent = [];
    for (let i = 1; i <= 7; i++) sent.push(await post(me, room.id, `m${i}`, i === 4 ? { files: [pngFile()] } : {}));
  });

  const route = (q: Record<string, string> = {}, who = me.pb, id = room.id) =>
    who.send<Items>(`/api/chat/rooms/${id}/messages`, { query: q });
  /** The records API's answer for the filter a client used to send. */
  const records = (filter: string, params: Record<string, string>, sort: string, perPage = 3) =>
    me.pb
      .collection("messages")
      .getList(1, perPage, {
        filter: me.pb.filter(`room = {:room}${filter ? ` && ${filter}` : ""}`, { room: room.id, ...params }),
        sort,
        skipTotal: true,
      })
      .then((l) => l.items.map((m) => m.id));
  const ids = (r: Items) => r.map((m) => m.id);

  it("lists the rooms the caller can see, by name, as the records API does", async () => {
    const all = (await me.pb.collection("rooms").getFullList({ sort: "name,id" })).map((r) => r.id);
    expect(ids(await me.pb.send<Items>("/api/chat/rooms", {}))).toEqual(all);
    const guest = client();
    const open = (await guest.collection("rooms").getFullList({ sort: "name,id" })).map((r) => r.id);
    expect(ids(await guest.send<Items>("/api/chat/rooms", {}))).toEqual(open);
  });

  it("gives each kind of page as the cursor filters did", async () => {
    const c = sent[3]!;
    const cur = { created: c.created, id: c.id };
    const cases: [Record<string, string>, string, Record<string, string>, string][] = [
      [{ kind: "latest" }, "", {}, "-created,-id"],
      [{}, "", {}, "-created,-id"],
      [{ kind: "first" }, "", {}, "created,id"],
      [{ kind: "older", ...cur }, "(created < {:created} || (created = {:created} && id < {:id}))", cur, "-created,-id"],
      [{ kind: "newer", ...cur }, "(created > {:created} || (created = {:created} && id > {:id}))", cur, "created,id"],
    ];
    for (const [q, filter, params, sort] of cases) {
      expect(ids(await route({ ...q, limit: "3" })), JSON.stringify(q)).toEqual(await records(filter, params, sort));
    }
    expect(ids(await route({ limit: "2", page: "2" }))).toEqual([sent[4]!.id, sent[3]!.id]);
    expect(await route()).toHaveLength(7);
  });

  it("a page has an ETag: asked again with it, unchanged is 304 with no body; any change is a new one (PERF.md §5)", async () => {
    const own = await me.pb.collection("rooms").update((await newRoom(me)).id, { visibility: "private" });
    const m = await post(me, own.id, "first");
    const pageUrl = (q = "") => `${me.pb.baseURL}/api/chat/rooms/${own.id}/messages?kind=latest&limit=3${q}`;
    const get = (tag = "", token = me.pb.authStore.token, q = "") =>
      fetch(pageUrl(q), { headers: { Authorization: token, ...(tag ? { "If-None-Match": tag } : {}) } });
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store"); // the client keeps it, not the browser's cache
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    const again = await get(tag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect((await get(tag, me.pb.authStore.token, "&fields=id")).status).toBe(200); // other fields: another answer

    await me.pb.collection("messages").update(m.id, { text: "first, edited" });
    const changed = await get(tag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
    // Someone else asking with my tag gets their own answer, never a 304 for what they can't see.
    const other = await newUser();
    expect((await get(changed.headers.get("etag")!, other.pb.authStore.token)).status).not.toBe(304);
  });

  it("only messages that may have attachments, with files=1", async () => {
    expect(ids(await route({ files: "1" }))).toEqual([sent[3]!.id]);
  });

  it("the changes since a time, oldest change first", async () => {
    const since = (await me.pb.collection("messages").getOne(sent[6]!.id)).updated;
    await new Promise((r) => setTimeout(r, 5));
    await me.pb.collection("messages").update(sent[5]!.id, { text: "edited" });
    await me.pb.collection("messages").update(sent[1]!.id, { text: "edited too" });
    const q = { kind: "changed", since, from: sent[0]!.created, to: sent[6]!.created };
    expect(ids(await route(q))).toEqual([sent[5]!.id, sent[1]!.id]);
  });

  it("takes ?expand and ?fields as the records API does", async () => {
    const items = await route({ limit: "1", expand: "author", fields: "id,text,expand.author.name" });
    expect(items).toEqual([{ id: sent[6]!.id, text: "m7", expand: { author: { name: me.user.name } } }]);
  });

  it("nothing from a room you can't see; refuses an unknown kind and a missing cursor", async () => {
    const other = await newUser();
    const priv = await other.pb.collection("rooms").update((await newRoom(other)).id, { visibility: "private" });
    expect(await route({}, me.pb, priv.id)).toEqual([]);
    expect(await route({}, me.pb, "nosuchroom0000")).toEqual([]);
    expect(await status(route({ kind: "sideways" }))).toBe(400);
    // A name every object has is no kind either, and says so (QA BUG-171).
    for (const kind of ["toString", "constructor", "__proto__"]) {
      const e = await route({ kind }).catch((err: { status: number; message: string }) => err);
      expect([kind, "status" in e && e.status, "message" in e && e.message]).toEqual([kind, 400, "Unknown page kind."]);
    }
    expect(await status(route({ kind: "older" }))).toBe(400);
  });

  it("caps limit at 200", async () => {
    const r = await newRoom(me);
    for (let i = 0; i < 201; i += 20) {
      await Promise.all(Array.from({ length: Math.min(20, 201 - i) }, (_, j) => post(me, r.id, `n${i + j}`)));
    }
    expect(await route({ limit: "500" }, me.pb, r.id)).toHaveLength(200);
  });

  // The route shows forwards' originals itself, all in one query (lib/messages.js enrichInRooms, docs/PERF.md).
  const fwd = (u: TestUser, messages: string[], to: string) =>
    u.pb.send<Items>("/api/chat/forward", { method: "POST", body: { messages, room: to } });
  const privateRoom = async (owner: TestUser, members: TestUser[] = []) => {
    const r = await owner.pb.collection("rooms").create({ name: `private-${uniq()}`, created_by: owner.user.id, visibility: "private" });
    return owner.pb.collection("rooms").update(r.id, { members: [owner.user.id, ...members.map((m) => m.user.id)] });
  };

  it("shows each forward's original as it is now, in the page and in an expanded reply", async () => {
    const a = await newUser();
    const b = await newUser();
    const from = await privateRoom(a);
    const to = await newRoom(b);
    const one = await post(a, from.id, "one");
    const two = await post(a, from.id, "two");
    const [f1, f2] = await fwd(a, [one.id, two.id], to.id);
    const reply = await post(b, to.id, "about that", { reply_to: f1!.id });
    await a.pb.collection("messages").update(one.id, { text: "one, edited" });
    await a.pb.send("/api/chat/delete", { method: "POST", body: { messages: [two.id] } });

    const page = await route({ kind: "first", expand: "reply_to" }, b.pb, to.id);
    const byId = new Map(page.map((m) => [m.id, m]));
    expect(byId.get(f1!.id)).toMatchObject({ text: "one, edited", forward_of: one.id });
    expect(byId.get(f1!.id)!.edited_at).not.toBe("");
    expect(byId.get(f2!.id)).toMatchObject({ text: "", files: [], forward_of: two.id });
    expect(byId.get(reply.id)!.expand?.reply_to).toMatchObject({ id: f1!.id, text: "one, edited" });
    // As the records API shows them.
    for (const m of page) expect(m.text, m.id).toBe((await b.pb.collection("messages").getOne(m.id)).text);
  });

  it("an original expanded from a forward still keeps its room to itself", async () => {
    const a = await newUser();
    const c = await newUser();
    const b = await newUser();
    const secret = await privateRoom(a, [c]);
    const parent = await post(c, secret.id, "earlier");
    const msg = await post(a, secret.id, "shared", { reply_to: parent.id });
    await c.pb.send("/api/chat/reactions", { method: "POST", body: { message: msg.id, emoji: "👍", on: true } });
    const to = await newRoom(b);
    await post(b, to.id, "mine", { reply_to: (await post(b, to.id, "first")).id });
    await b.pb.send("/api/chat/reactions", {
      method: "POST",
      body: { message: (await fwd(a, [msg.id], to.id))[0]!.id, emoji: "🎉", on: true },
    });

    const page = await route({ expand: "forward_of,reply_to" }, b.pb, to.id);
    const forward = page.find((m) => m.forward_of === msg.id)!;
    expect(forward.reactions).toEqual([{ emoji: "🎉", users: [b.user.id] }]);
    expect(forward.expand?.forward_of).toMatchObject({ text: "shared", reactions: [], reply_to: "" });
    // The room's own replies and reactions are left as they are.
    expect(page.find((m) => m.text === "mine")!.expand?.reply_to).toMatchObject({ text: "first" });
    // Saying the room was checked, a client is told nothing more.
    const forged = { __chirkle_checked: ` ${secret.id}`, expand: "reply_to" };
    expect(await b.pb.collection("messages").getOne(msg.id, { query: forged })).toMatchObject({ reactions: [], reply_to: "" });
    expect(await route({ ...forged, expand: "forward_of" }, b.pb, to.id)).toContainEqual(
      expect.objectContaining({ expand: { forward_of: expect.objectContaining({ reactions: [], reply_to: "" }) } }),
    );
  });
});

describe("the notification check as a route", () => {
  it("other people's DMs and replies to you since a time, and every message of the rooms asked for, as the old filter", async () => {
    const me = await newUser();
    const bob = await newUser();
    const room = await newRoom(me);
    const loud = await newRoom(me);
    const dm = await openDm(me, bob);
    const priv = await bob.pb.collection("rooms").update((await newRoom(bob)).id, { visibility: "private" });
    const mine = await post(me, room.id, "mine");
    const before = await post(bob, dm.id, "before");
    await new Promise((r) => setTimeout(r, 5));
    const since = before.created;
    const want = [
      await post(bob, dm.id, "dm"),
      await post(bob, room.id, "reply", { reply_to: mine.id }),
      await post(bob, loud.id, "anything, in an every room"),
    ].map((m) => m.id);
    await post(bob, room.id, "not to me");
    await post(me, dm.id, "my own");
    await post(bob, priv.id, "a room I can't see");
    const gone = await post(bob, dm.id, "deleted");
    await bob.pb.collection("messages").update(gone.id, { deleted: true });

    const rooms = [room.id, loud.id, dm.id, priv.id];
    const found = await me.pb.send<Items>("/api/chat/notifiable", {
      query: { rooms: rooms.join(","), since, every: loud.id, fields: "id" },
    });
    expect(found.map((m) => m.id)).toEqual(want.reverse());
    // The filter the app sent before the route (ChirkleApi.notifiable on an old server).
    const params = Object.fromEntries([...rooms.map((r, i) => [`r${i}`, r]), ["me", me.user.id], ["since", since]]);
    const filter = `(${rooms.map((_, i) => `room = {:r${i}}`).join(" || ")}) && created > {:since} && author != {:me} && deleted = false && (room.kind = "dm" || reply_to.author = {:me} || room = {:r1})`;
    const old = await me.pb
      .collection("messages")
      .getList(1, 100, { filter: me.pb.filter(filter, params), sort: "-created,-id", skipTotal: true });
    expect(old.items.map((m) => m.id)).toEqual(found.map((m) => m.id));

    expect(await me.pb.send("/api/chat/notifiable", { query: { rooms: priv.id, since } })).toEqual([]);
    expect(await status(me.pb.send("/api/chat/notifiable", { query: { rooms: room.id } }))).toBe(400);
    expect(await status(client().send("/api/chat/notifiable", { query: { rooms: room.id, since } }))).toBe(401);
  });
});
