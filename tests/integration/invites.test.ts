// Room invite links (DESIGN.md §44): GET, POST and DELETE /api/chat/rooms/{room}/invite for the room's managers, GET
// /api/chat/invites/{token} for anyone and POST /api/chat/invites/{token} to join (pb_hooks/lib/invites.js).

import { describe, expect, it } from "vitest";
import { adminClient, client, collect, eventually, newRoom, newUser, openDm, post, rawDb, status, type TestUser } from "./helpers.ts";

interface Invite {
  token: string;
  created: string;
  expires: string;
  uses: number;
}
interface Preview {
  room: { id: string; name: string; members: number };
  by: string;
  expires: string;
  member: boolean;
}

const path = (room: string) => `/api/chat/rooms/${room}/invite`;
const getInvite = (u: TestUser, room: string) => u.pb.send<{ invite: Invite | null }>(path(room), {});
const makeInvite = (u: TestUser, room: string, body: Record<string, unknown> = {}) =>
  u.pb.send<{ invite: Invite }>(path(room), { method: "POST", body });
const revoke = (u: TestUser, room: string) => u.pb.send(path(room), { method: "DELETE" });
const preview = (pb: TestUser["pb"], token: string) => pb.send<Preview>(`/api/chat/invites/${token}`, {});
const join = (u: TestUser, token: string) => u.pb.send<{ room: string }>(`/api/chat/invites/${token}`, { method: "POST" });

/** A private room of `u`'s (with these members). */
async function privateRoom(u: TestUser, members: string[] = []) {
  const room = await newRoom(u);
  return u.pb.collection("rooms").update(room.id, { visibility: "private", members: [u.user.id, ...members] });
}

const membersOf = async (u: TestUser, room: string) => (await u.pb.collection("rooms").getOne(room)).members as string[];

describe("making and revoking a link (§44.1)", () => {
  it("the creator makes one, reads it back, and a new one replaces it", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    expect((await getInvite(a, room.id)).invite).toBeNull();
    const { invite } = await makeInvite(a, room.id);
    expect(invite.token).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(invite.uses).toBe(0);
    // Seven days by default.
    const days = (Date.parse(invite.expires.replace(" ", "T")) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect((await getInvite(a, room.id)).invite).toEqual(invite);

    const again = (await makeInvite(a, room.id, { days: 1 })).invite;
    expect(again.token).not.toBe(invite.token);
    expect(await status(preview(client(), invite.token))).toBe(404);
    expect((await preview(client(), again.token)).room.id).toBe(room.id);
  });

  it("takes 1, 7 or 30 days, nothing else", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id, { days: 30 });
    expect((Date.parse(invite.expires.replace(" ", "T")) - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
    for (const days of [0, 2, -1, "7", 365]) expect(await status(makeInvite(a, room.id, { days }))).toBe(400);
  });

  it("revoked, it stops working; revoking nothing is fine", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    await revoke(a, room.id);
    expect((await getInvite(a, room.id)).invite).toBeNull();
    expect(await status(preview(client(), invite.token))).toBe(404);
    await revoke(a, room.id);
  });

  it("only private rooms, not archived ones, not DMs", async () => {
    const a = await newUser();
    const b = await newUser();
    const pub = await newRoom(a);
    expect(await status(makeInvite(a, pub.id))).toBe(400);
    expect((await getInvite(a, pub.id)).invite).toBeNull();
    const archived = await privateRoom(a);
    await a.pb.collection("rooms").update(archived.id, { archived: true });
    expect(await status(makeInvite(a, archived.id))).toBe(400);
    const dm = await openDm(a, b);
    expect(await status(makeInvite(a, dm.id))).toBe(403);
  });

  it("only the creator, or a moderator who is in the room", async () => {
    const a = await newUser();
    const b = await newUser();
    const m = await newUser();
    const outsider = await newUser();
    const admin = await adminClient();
    await admin.collection("users").update(m.user.id, { moderator: true });
    await admin.collection("users").update(outsider.user.id, { moderator: true });
    await m.pb.collection("users").authRefresh();
    await outsider.pb.collection("users").authRefresh();
    const room = await privateRoom(a, [b.user.id, m.user.id]);
    expect(await status(getInvite(b, room.id))).toBe(403);
    expect(await status(makeInvite(b, room.id))).toBe(403);
    expect(await status(revoke(b, room.id))).toBe(403);
    // A moderator sees only what anyone sees (§36): not a private room they aren't in.
    expect(await status(makeInvite(outsider, room.id))).toBe(404);
    const { invite } = await makeInvite(m, room.id);
    expect((await getInvite(a, room.id)).invite?.token).toBe(invite.token);
    expect((await preview(client(), invite.token)).by).toBe(m.user.name);
    expect(await status(client().send(path(room.id), {}))).toBe(401);
  });
});

describe("opening and joining (§44.2)", () => {
  it("anyone with the link reads where it goes; a member is told they are in", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await privateRoom(a, [b.user.id]);
    const { invite } = await makeInvite(a, room.id);
    const guest = await preview(client(), invite.token);
    expect(guest).toEqual({ room: { id: room.id, name: room.name, members: 2 }, by: a.user.name, expires: invite.expires, member: false });
    expect((await preview(b.pb, invite.token)).member).toBe(true);
    expect((await preview(a.pb, invite.token)).member).toBe(true);
    const c = await newUser();
    expect((await preview(c.pb, invite.token)).member).toBe(false);
    // Unknown, one letter off, or in another case: no such link.
    const swapped = [...invite.token].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
    const off = invite.token.slice(0, 23) + (invite.token.endsWith("a") ? "b" : "a");
    for (const bad of ["nope", off, swapped]) expect(await status(preview(client(), bad))).toBe(404);
  });

  it("joining adds you to the members, counts a use, and lets you read and post", async () => {
    const a = await newUser();
    const c = await newUser();
    const room = await privateRoom(a);
    await post(a, room.id, "before you came");
    const { invite } = await makeInvite(a, room.id);
    expect(await status(c.pb.collection("rooms").getOne(room.id))).toBe(404);
    expect(await join(c, invite.token)).toEqual({ room: room.id });
    expect(await membersOf(a, room.id)).toEqual([a.user.id, c.user.id]);
    expect((await getInvite(a, room.id)).invite?.uses).toBe(1);
    expect((await c.pb.collection("rooms").getOne(room.id)).id).toBe(room.id);
    await post(c, room.id, "hello");
    // Again: nothing changes.
    expect(await join(c, invite.token)).toEqual({ room: room.id });
    expect(await join(a, invite.token)).toEqual({ room: room.id });
    expect((await getInvite(a, room.id)).invite?.uses).toBe(1);
    expect(await membersOf(a, room.id)).toEqual([a.user.id, c.user.id]);
  });

  it("someone taken out of the members can't come back with the link; added back, or a new link, they can (QA BUG-280)", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    await join(b, invite.token);
    await join(c, invite.token);
    await a.pb.collection("rooms").update(room.id, { members: [a.user.id, c.user.id] });
    // For them the link is dead, as any dead link; for everyone else it still works.
    expect(await status(join(b, invite.token))).toBe(404);
    expect(await status(preview(b.pb, invite.token))).toBe(404);
    expect((await preview(client(), invite.token)).room.id).toBe(room.id);
    expect(await membersOf(a, room.id)).toEqual([a.user.id, c.user.id]);
    const d = await newUser();
    expect(await join(d, invite.token)).toEqual({ room: room.id });
    // Added back by hand, then taken out by nobody: the link knows them again.
    await a.pb.collection("rooms").update(room.id, { members: [a.user.id, c.user.id, d.user.id, b.user.id] });
    expect((await preview(b.pb, invite.token)).member).toBe(true);
    // Taken out again, then a new link: it lets them in.
    await a.pb.collection("rooms").update(room.id, { members: [a.user.id, c.user.id, d.user.id] });
    expect(await status(join(b, invite.token))).toBe(404);
    const fresh = (await makeInvite(a, room.id)).invite;
    expect(await join(b, fresh.token)).toEqual({ room: room.id });
  });

  it("a guest can't join", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    expect(await status(client().send(`/api/chat/invites/${invite.token}`, { method: "POST" }))).toBe(401);
  });

  it("joining doesn't make you a writer of a room where only some post", async () => {
    const a = await newUser();
    const c = await newUser();
    const room = await privateRoom(a);
    await a.pb.collection("rooms").update(room.id, { posting: "selected", writers: [a.user.id] });
    const { invite } = await makeInvite(a, room.id);
    await join(c, invite.token);
    expect(await status(post(c, room.id, "may I?"))).toBe(400);
  });

  it("the new member gets the room live", async () => {
    const a = await newUser();
    const c = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    const sub = await collect(c.pb, "rooms");
    try {
      await join(c, invite.token);
      await eventually(() => expect(sub.events.some((e) => e.record.id === room.id && e.action === "update")).toBe(true));
    } finally {
      await sub.stop();
    }
  });

  it("an expired link, an archived room, a full room", async () => {
    const a = await newUser();
    const c = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);

    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(preview(client(), invite.token))).toBe(404);
    expect(await status(join(c, invite.token))).toBe(404);
    await a.pb.collection("rooms").update(room.id, { archived: false });
    expect((await preview(client(), invite.token)).room.id).toBe(room.id);

    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE room_invites SET expires = '2020-01-01 00:00:00.000Z' WHERE token = ?").run(invite.token);
    } finally {
      db.close();
    }
    expect(await status(preview(client(), invite.token))).toBe(404);
    expect(await status(join(c, invite.token))).toBe(404);
    expect((await getInvite(a, room.id)).invite).toBeNull();
    expect(await membersOf(a, room.id)).toEqual([a.user.id]);
  });

  it("a room with 100 members is full", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    // 99 others, written directly: making 99 accounts takes too long, and the check comes before the save.
    const others = Array.from({ length: 99 }, (_, i) => `fake${String(i).padStart(11, "0")}`);
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE rooms SET members = ? WHERE id = ?").run(JSON.stringify([a.user.id, ...others]), room.id);
    } finally {
      db.close();
    }
    const c = await newUser();
    const err = await join(c, invite.token).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/full/);
  });

  it("made public, the link goes, and making it private again doesn't bring it back", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    const { invite } = await makeInvite(a, room.id);
    await a.pb.collection("rooms").update(room.id, { visibility: "public" });
    expect(await status(preview(client(), invite.token))).toBe(404);
    await a.pb.collection("rooms").update(room.id, { visibility: "private", members: [a.user.id] });
    expect(await status(preview(client(), invite.token))).toBe(404);
    expect((await getInvite(a, room.id)).invite).toBeNull();
  });

  it("deleted with its room", async () => {
    const a = await newUser();
    const room = await privateRoom(a);
    await makeInvite(a, room.id);
    await (await adminClient()).collection("rooms").delete(room.id);
    const db = rawDb();
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM room_invites WHERE room = ?").get(room.id)).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
