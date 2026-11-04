// Room access (§23): private rooms, public rooms and Open Air rooms that guests can read.

import { describe, expect, it } from "vitest";
import {
  barrier,
  client,
  collect,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  pngFile,
  post,
  sleep,
  status,
  type TestUser,
} from "./helpers.ts";

type Visibility = "public" | "private" | "open";

async function roomWith(owner: TestUser, visibility: Visibility, members: TestUser[] = []) {
  const room = await newRoom(owner);
  return owner.pb.collection("rooms").update(room.id, { visibility, members: members.map((m) => m.user.id) });
}

async function trio() {
  const [a, b, c] = await Promise.all([newUser(), newUser(), newUser()]);
  return { a, b, c };
}

describe("visibility (§23.1)", () => {
  it("new rooms are public; the creator may choose another visibility when creating it", async () => {
    const a = await newUser();
    expect((await newRoom(a)).visibility).toBe("public");
    const priv = await a.pb.collection("rooms").create({ name: `p-${Date.now()}`, created_by: a.user.id, visibility: "private" });
    expect(priv.visibility).toBe("private");
    expect(priv.members).toEqual([a.user.id]);
    const open = await a.pb.collection("rooms").create({ name: `o-${Date.now()}`, created_by: a.user.id, visibility: "open" });
    expect(open.visibility).toBe("open");
    await expectRejected(a.pb.collection("rooms").create({ name: `x-${Date.now()}`, created_by: a.user.id, visibility: "secret" }));
  });

  it("DMs are private", async () => {
    const { a, b } = await trio();
    const dm = await openDm(a, b);
    expect(dm.visibility).toBe("private");
    expect((await a.pb.collection("rooms").getOne(dm.id)).visibility).toBe("private");
  });

  it("only members (and the creator) see a private room and its messages", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    expect(room.members).toEqual([a.user.id, b.user.id]);
    const m = await post(a, room.id, "members only");
    expect((await b.pb.collection("rooms").getOne(room.id)).id).toBe(room.id);
    expect((await b.pb.collection("messages").getOne(m.id)).text).toBe("members only");
    expect(await status(c.pb.collection("rooms").getOne(room.id))).toBe(404);
    expect(await c.pb.collection("rooms").getFullList({ filter: `id = "${room.id}"` })).toHaveLength(0);
    expect(await status(c.pb.collection("messages").getOne(m.id))).toBe(404);
    expect(await c.pb.collection("messages").getFullList({ filter: `room = "${room.id}"` })).toHaveLength(0);
    expect(await status(client().collection("rooms").getOne(room.id))).toBe(404);
  });

  it("only members can post, react, forward into, hide or mark read a private room", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    const pub = await newRoom(c);
    const theirs = await post(c, pub.id, "forward me");
    const inside = await post(b, room.id, "hi");
    await expectRejected(post(c, room.id, "let me in"));
    expect(await status(c.pb.send("/api/chat/reactions", { method: "POST", body: { message: inside.id, emoji: "👍", on: true } }))).toBe(
      404,
    );
    expect(await status(c.pb.send("/api/chat/forward", { method: "POST", body: { messages: [theirs.id], room: room.id } }))).toBe(404);
    await expectRejected(c.pb.collection("hidden_rooms").create({ user: c.user.id, room: room.id }));
    expect(await status(c.pb.send("/api/chat/reads", { method: "POST", body: { room: room.id } }))).toBe(404);
    // members can
    expect((await post(b, room.id, "fine")).text).toBe("fine");
    expect((await b.pb.collection("hidden_rooms").create({ user: b.user.id, room: room.id })).room).toBe(room.id);
    expect(await status(b.pb.send("/api/chat/reads", { method: "POST", body: { room: room.id } }))).toBe(200);
  });

  it("public rooms: every signed-in user, no guests", async () => {
    const { a, c } = await trio();
    const room = await newRoom(a);
    const m = await post(a, room.id, "hello all");
    expect((await c.pb.collection("messages").getOne(m.id)).text).toBe("hello all");
    const guest = client();
    expect(await status(guest.collection("rooms").getOne(room.id))).toBe(404);
    expect(await status(guest.collection("messages").getOne(m.id))).toBe(404);
  });

  it("unread counts leave out private rooms you aren't in", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    await post(a, room.id, "one");
    const unread = async (u: TestUser) => (await u.pb.send<{ rooms: Record<string, number> }>("/api/chat/unread", {})).rooms[room.id];
    expect(await unread(b)).toBe(1);
    expect(await unread(c)).toBeUndefined();
  });
});

describe("members (§23.2)", () => {
  it("the creator adds and removes members; the creator always stays one", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    const more = await a.pb.collection("rooms").update(room.id, { "members+": c.user.id });
    expect(more.members).toEqual([a.user.id, b.user.id, c.user.id]);
    const fewer = await a.pb.collection("rooms").update(room.id, { members: [c.user.id] });
    expect(fewer.members).toEqual([a.user.id, c.user.id]);
    const dup = await a.pb.collection("rooms").update(room.id, { members: [c.user.id, c.user.id, a.user.id] });
    expect(dup.members).toEqual([a.user.id, c.user.id]);
  });

  it("nobody else can change members or visibility", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    await expectRejected(b.pb.collection("rooms").update(room.id, { "members+": c.user.id }));
    await expectRejected(b.pb.collection("rooms").update(room.id, { visibility: "public" }));
    await expectRejected(c.pb.collection("rooms").update(room.id, { members: [c.user.id] }));
    const pub = await newRoom(a);
    await expectRejected(c.pb.collection("rooms").update(pub.id, { visibility: "open" }));
    expect((await a.pb.collection("rooms").getOne(room.id)).members).toEqual([a.user.id, b.user.id]);
  });

  it("rejects unknown users and more than 100 members", async () => {
    const a = await newUser();
    const room = await roomWith(a, "private");
    await expectRejected(a.pb.collection("rooms").update(room.id, { members: ["nosuchuser12345"] }));
    const many = Array.from({ length: 100 }, (_, i) => `fake${String(i).padStart(11, "0")}`);
    await expectRejected(a.pb.collection("rooms").update(room.id, { members: many }));
  });

  it("members are only kept while the room is private", async () => {
    const { a, b } = await trio();
    const room = await roomWith(a, "private", [b]);
    expect((await a.pb.collection("rooms").update(room.id, { visibility: "public" })).members).toEqual([]);
    const pub = await newRoom(a);
    expect((await a.pb.collection("rooms").update(pub.id, { members: [b.user.id] })).members).toEqual([]);
  });

  it("DM members still can't be changed", async () => {
    const { a, b, c } = await trio();
    const dm = await openDm(a, b);
    await expectRejected(a.pb.collection("rooms").update(dm.id, { "members+": c.user.id }));
    await expectRejected(a.pb.collection("rooms").update(dm.id, { visibility: "open" }));
  });

  it("someone taken out can't see, edit or delete what they wrote there", async () => {
    const { a, b } = await trio();
    const room = await roomWith(a, "private", [b]);
    const m = await post(b, room.id, "before");
    await a.pb.collection("rooms").update(room.id, { members: [] });
    expect(await status(b.pb.collection("messages").getOne(m.id))).toBe(404);
    await expectRejected(b.pb.collection("messages").update(m.id, { text: "after" }));
    await expectRejected(b.pb.collection("messages").update(m.id, { deleted: true }));
    expect(await status(b.pb.send("/api/chat/delete", { method: "POST", body: { messages: [m.id] } }))).toBe(404);
    expect((await a.pb.collection("messages").getOne(m.id)).text).toBe("before");
  });
});

describe("Open Air rooms and guests (§23.3)", () => {
  it("guests list and read open rooms, with authors' names, but nothing else", async () => {
    const { a } = await trio();
    const open = await roomWith(a, "open");
    const pub = await newRoom(a);
    const priv = await roomWith(a, "private");
    const m = await post(a, open.id, "hello world");
    const guest = client();
    const rooms = await guest.collection("rooms").getFullList({ filter: `id = "${open.id}" || id = "${pub.id}" || id = "${priv.id}"` });
    expect(rooms.map((r) => r.id)).toEqual([open.id]);
    const msgs = await guest.collection("messages").getFullList({ filter: `room = "${open.id}"`, expand: "author" });
    expect(msgs.map((x) => x.text)).toEqual(["hello world"]);
    expect(msgs[0]!.expand?.author?.name).toBe(a.user.name);
    expect(msgs[0]!.expand?.author?.email).toBeUndefined();
    expect((await guest.collection("messages").getOne(m.id)).text).toBe("hello world");
  });

  it("guests can't post, react, list users or get a file token", async () => {
    const { a } = await trio();
    const open = await roomWith(a, "open");
    const m = await post(a, open.id, "read only");
    const guest = client();
    await expectRejected(guest.collection("messages").create({ room: open.id, author: a.user.id, text: "sneaky" }));
    await expectRejected(guest.collection("messages").create({ room: open.id, text: "sneaky" }));
    expect(await status(guest.send("/api/chat/reactions", { method: "POST", body: { message: m.id, emoji: "👍", on: true } }))).toBe(401);
    expect(await guest.collection("users").getFullList()).toEqual([]);
    expect(await status(guest.send("/api/chat/users?q=a", {}))).toBe(401);
    expect(await status(guest.send("/api/files/token", { method: "POST" }))).toBe(401);
  });

  it("guests see a user's public profile by id, never the email", async () => {
    const a = await newUser();
    const u = await client().collection("users").getOne(a.user.id);
    expect(u.name).toBe(a.user.name);
    expect(u.email).toBeUndefined();
  });

  it("signed-in users can post in open rooms", async () => {
    const { a, c } = await trio();
    const open = await roomWith(a, "open");
    expect((await post(c, open.id, "me too")).text).toBe("me too");
  });

  it("an archived open room is hidden from guests (members still read it)", async () => {
    const { a, c } = await trio();
    const open = await roomWith(a, "open");
    const m = await post(a, open.id, "old news");
    await a.pb.collection("rooms").update(open.id, { archived: true });
    const guest = client();
    expect(await status(guest.collection("rooms").getOne(open.id))).toBe(404);
    expect(await status(guest.collection("messages").getOne(m.id))).toBe(404);
    expect((await c.pb.collection("messages").getOne(m.id)).text).toBe("old news");
  });

  it("guests can download attachments of open rooms: no token, by the URL alone (§37.3)", async () => {
    const { a } = await trio();
    const open = await roomWith(a, "open");
    const inOpen = await a.pb.collection("messages").create({ room: open.id, author: a.user.id, text: "", files: [pngFile()] });
    const shown = await client().collection("messages").getOne(inOpen.id);
    expect((await fetch(a.pb.files.getURL(shown, shown.files[0]))).status).toBe(200);
    expect((await fetch(a.pb.files.getURL(shown, shown.files[0], { thumb: "480x240f" }))).status).toBe(200);
  });

  it("guests get open rooms' messages live, and nothing from other rooms", async () => {
    const { a } = await trio();
    const open = await roomWith(a, "open");
    const pub = await newRoom(a);
    const guest = client();
    const sub = await collect(guest, "messages");
    try {
      await post(a, pub.id, "not for guests");
      await barrier(sub, () => post(a, open.id, "marker"));
      expect(sub.events).toEqual([]);
      await post(a, open.id, "for everyone");
      await eventually(() => expect(sub.events.map((e) => e.record.text)).toEqual(["for everyone"]));
    } finally {
      await sub.stop();
    }
  });
});

describe("losing access is pushed (§23.4)", () => {
  it("a member taken out of a private room gets a delete event; the others an update", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b, c]);
    const bSub = await collect(b.pb, "rooms");
    const cSub = await collect(c.pb, "rooms");
    try {
      await a.pb.collection("rooms").update(room.id, { members: [c.user.id] });
      await eventually(() => expect(bSub.events.map((e) => [e.action, e.record.id])).toEqual([["delete", room.id]]));
      await eventually(() => expect(cSub.events.map((e) => e.action)).toEqual(["update"]));
    } finally {
      await Promise.all([bSub.stop(), cSub.stop()]);
    }
  });

  it("someone added to a private room gets it live", async () => {
    const { a, b } = await trio();
    const room = await roomWith(a, "private");
    const bSub = await collect(b.pb, "rooms");
    try {
      await a.pb.collection("rooms").update(room.id, { "members+": b.user.id });
      await eventually(() => expect(bSub.events.map((e) => [e.action, e.record.id])).toEqual([["update", room.id]]));
    } finally {
      await bSub.stop();
    }
  });

  it("guests are told when an open room is archived or closed to them, and get it back when it opens", async () => {
    const { a } = await trio();
    const open = await roomWith(a, "open");
    const guest = client();
    const sub = await collect(guest, "rooms");
    try {
      await a.pb.collection("rooms").update(open.id, { archived: true });
      await eventually(() => expect(sub.events.map((e) => e.action)).toEqual(["delete"]));
      await a.pb.collection("rooms").update(open.id, { archived: false });
      await eventually(() => expect(sub.events.map((e) => e.action)).toEqual(["delete", "update"]));
      await a.pb.collection("rooms").update(open.id, { visibility: "public" });
      await eventually(() => expect(sub.events.map((e) => e.action)).toEqual(["delete", "update", "delete"]));
      expect(sub.events.at(-1)!.record).toEqual({ id: open.id });
    } finally {
      await sub.stop();
    }
  });

  it("nobody else hears of a private room's changes", async () => {
    const { a, b, c } = await trio();
    const room = await roomWith(a, "private", [b]);
    const cSub = await collect(c.pb, "rooms");
    try {
      await a.pb.collection("rooms").update(room.id, { members: [] });
      await a.pb.collection("rooms").update(room.id, { name: `renamed-${Date.now()}` });
      const pub = await newRoom(a);
      await barrier(cSub, async () => pub);
      expect(cSub.events).toEqual([]);
    } finally {
      await cSub.stop();
    }
  });

  it("a removed member's message subscription goes quiet", async () => {
    const { a, b } = await trio();
    const room = await roomWith(a, "private", [b]);
    const sub = await collect(b.pb, "messages", { filter: `room = "${room.id}"` });
    try {
      await a.pb.collection("rooms").update(room.id, { members: [] });
      await post(a, room.id, "after you left");
      await sleep(400);
      expect(sub.events).toEqual([]);
    } finally {
      await sub.stop();
    }
  });
});

describe("probing a private room from outside (§23.1)", () => {
  it("its attachments open only by their URL (§37.3), which outsiders never see, and not once deleted", async () => {
    const { a, c } = await trio();
    const room = await roomWith(a, "private");
    const m = await a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "", files: [pngFile()] });
    expect(await status(c.pb.collection("messages").getOne(m.id))).toBe(404);
    const name = m.files[0] as string;
    expect((await fetch(a.pb.files.getURL(m, name))).status).toBe(200);
    // The stored name's random part is the secret: the original name, or another suffix, finds nothing.
    expect((await fetch(a.pb.files.getURL(m, "image.png"))).status).toBe(404);
    expect((await fetch(a.pb.files.getURL(m, name.replace(/_[a-z0-9]+\./, "_aaaaaaaaaa.")))).status).toBe(404);
    // Nor through another message, nor the files collection itself.
    const other = await post(a, room.id, "no files");
    expect((await fetch(a.pb.files.getURL(other, name))).status).toBe(404);
    await a.pb.collection("messages").update(m.id, { deleted: true });
    expect((await fetch(a.pb.files.getURL(m, name))).status).toBe(404);
  });

  it("subscribing to it by id gets nothing, signed in or not", async () => {
    const { a, c } = await trio();
    const room = await roomWith(a, "private");
    const guest = client();
    const got: unknown[] = [];
    const offs = await Promise.all([
      c.pb.collection("rooms").subscribe(room.id, (e) => got.push(e)),
      guest.collection("rooms").subscribe(room.id, (e) => got.push(e)),
      c.pb.collection("messages").subscribe("*", (e) => got.push(e), { filter: `room = "${room.id}"` }),
    ]);
    try {
      await a.pb.collection("rooms").update(room.id, { name: `still-secret-${Date.now()}` });
      await post(a, room.id, "psst");
      await sleep(400);
      expect(got).toEqual([]);
    } finally {
      for (const off of offs) await off();
      c.pb.realtime.unsubscribe();
      guest.realtime.unsubscribe();
    }
  });

  it("filters and expands don't reach into it", async () => {
    const { a, c } = await trio();
    const room = await roomWith(a, "private");
    await post(a, room.id, "hidden text");
    const byName = await c.pb.collection("messages").getFullList({ filter: `room.name = "${room.name}"` });
    expect(byName).toEqual([]);
    const guest = client();
    expect(await guest.collection("rooms").getFullList({ filter: `visibility = "private" || visibility = "public"` })).toEqual([]);
    const pub = await newRoom(c);
    const mine = await post(c, pub.id, "hi");
    const expanded = await c.pb.collection("messages").getOne(mine.id, { expand: "room" });
    expect(expanded.expand?.room?.id).toBe(pub.id);
  });
});
