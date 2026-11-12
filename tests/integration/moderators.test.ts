// Moderators (§36): ticked by a superuser; they delete anyone's messages outside DMs, change any public room's access
// and archive it, and ban and unban people. A banned account can't sign in and its sessions end.

import type { RecordModel } from "pocketbase";
import { describe, expect, it } from "vitest";
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
  status,
  type TestUser,
} from "./helpers.ts";

/** A new user a superuser made a moderator, signed in again so the token carries nothing stale. */
async function newModerator(): Promise<TestUser> {
  const m = await newUser();
  const admin = await adminClient();
  await admin.collection("users").update(m.user.id, { moderator: true });
  const { record } = await m.pb.collection("users").authRefresh();
  return { ...m, user: record };
}

const del = (u: TestUser, messages: string[]) => u.pb.send<RecordModel[]>("/api/chat/delete", { method: "POST", body: { messages } });
const ban = (u: TestUser, user: string, banned: unknown = true) =>
  u.pb.send<RecordModel>("/api/chat/ban", { method: "POST", body: { user, banned } });

describe("moderator flag (§36.1)", () => {
  it("only a superuser sets it, or bans", async () => {
    const a = await newUser();
    await expectRejected(a.pb.collection("users").update(a.user.id, { moderator: true }));
    await expectRejected(a.pb.collection("users").update(a.user.id, { banned: true }));
    // (A bool field has no modifiers: "moderator+" is no field, and ignored.)
    await a.pb
      .collection("users")
      .update(a.user.id, { "moderator+": true })
      .catch(() => {});
    expect((await a.pb.collection("users").getOne(a.user.id)).moderator).toBe(false);
    const email = `x-${a.user.id}@test.local`;
    await expectRejected(
      client().collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", moderator: true }),
    );
    const m = await newModerator();
    expect(m.user.moderator).toBe(true);
  });
});

describe("moderators delete messages (§36.2)", () => {
  it("anyone's, in rooms that aren't theirs, even where they can't post", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "spam");
    await a.pb.collection("rooms").update(room.id, { posting: "selected" });
    const [gone] = await del(m, [msg.id]);
    expect(gone).toMatchObject({ id: msg.id, deleted: true, text: "" });
  });

  it("not through the records API, not in DMs, not in archived rooms; others still only their own", async () => {
    const a = await newUser();
    const b = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hi");
    await expectRejected(m.pb.collection("messages").update(msg.id, { deleted: true }));
    expect(await status(del(b, [msg.id]))).toBe(403);

    const dm = await openDm(a, m);
    const inDm = await post(a, dm.id, "private");
    expect(await status(del(m, [inDm.id]))).toBe(403);

    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(del(m, [msg.id]))).toBe(400);
  });

  it("not in private rooms they aren't in", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await a.pb.collection("rooms").create({ name: `p-${a.user.id}`, created_by: a.user.id, visibility: "private" });
    const msg = await post(a, room.id, "ours");
    expect(await status(del(m, [msg.id]))).toBe(404);
  });

  it("not once the flag is taken away", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hi");
    await (await adminClient()).collection("users").update(m.user.id, { moderator: false });
    expect(await status(del(m, [msg.id]))).toBe(403);
  });
});

describe("moderators manage rooms (§36.3)", () => {
  it("change any room's access and archive it, but don't rename it", async () => {
    const a = await newUser();
    const b = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    const open = await m.pb.collection("rooms").update(room.id, { visibility: "open" });
    expect(open.visibility).toBe("open");
    const writers = await m.pb.collection("rooms").update(room.id, { posting: "selected", writers: [b.user.id] });
    expect(writers.writers).toEqual([a.user.id, b.user.id]);
    const priv = await m.pb.collection("rooms").update(room.id, { visibility: "private", members: [b.user.id, m.user.id] });
    expect(priv.members).toEqual([a.user.id, b.user.id, m.user.id]);
    expect(priv.created_by).toBe(a.user.id);
    expect((await m.pb.collection("rooms").update(room.id, { archived: true })).archived).toBe(true);
    expect((await m.pb.collection("rooms").update(room.id, { archived: false })).archived).toBe(false);
    await expectRejected(m.pb.collection("rooms").update(room.id, { name: `ren-${room.id}` }));
    await expectRejected(m.pb.collection("rooms").update(room.id, { created_by: m.user.id }));
    await expectRejected(b.pb.collection("rooms").update(room.id, { archived: true }));
  });

  it("not DMs", async () => {
    const a = await newUser();
    const m = await newModerator();
    const dm = await openDm(a, m);
    await expectRejected(m.pb.collection("rooms").update(dm.id, { archived: true }));
  });
});

describe("banning (§36.4)", () => {
  it("ends their sessions and stops them signing in, until unbanned", async () => {
    const a = await newUser();
    const m = await newModerator();
    const res = await ban(m, a.user.id);
    expect(res).toMatchObject({ id: a.user.id, banned: true });
    expect(res.email).toBeUndefined();
    expect(await status(a.pb.collection("users").authRefresh())).toBe(401);
    expect(await status(client().collection("users").authWithPassword(a.email, a.password))).toBeGreaterThanOrEqual(400);

    expect(await ban(m, a.user.id, false)).toMatchObject({ banned: false });
    const again = client();
    await again.collection("users").authWithPassword(a.email, a.password);
    expect(again.authStore.isValid).toBe(true);
  });

  it("closes their live connection", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await newRoom(m);
    const sub = await collect(a.pb, "messages");
    await post(m, room.id, "before");
    await eventually(() => expect(sub.events).toHaveLength(1));
    await ban(m, a.user.id);
    await post(m, room.id, "after");
    await post(m, room.id, "after 2");
    await new Promise((r) => setTimeout(r, 300));
    expect(sub.events.map((e) => e.record.text)).toEqual(["before"]);
    a.pb.realtime.unsubscribe();
  });

  it("a superuser's ban in the admin UI ends sessions too", async () => {
    const a = await newUser();
    await (await adminClient()).collection("users").update(a.user.id, { banned: true });
    expect(await status(a.pb.collection("users").authRefresh())).toBe(401);
  });

  it("only by moderators, not themselves, other moderators or other instances' people", async () => {
    const a = await newUser();
    const b = await newUser();
    const m = await newModerator();
    const m2 = await newModerator();
    expect(await status(ban(a, b.user.id))).toBe(403);
    expect(await status(ban(m, m.user.id))).toBe(400);
    expect(await status(ban(m, m2.user.id))).toBe(400);
    expect(await status(ban(m, "nobody12345678"))).toBe(404);
    expect(await status(ban(m, b.user.id, "yes"))).toBe(400);
    const remote = await (await adminClient()).collection("users").create({
      email: `r-${b.user.id}@test.local`,
      password: "password-123",
      passwordConfirm: "password-123",
      name: `r-${b.user.id}`,
      instance: "b.example",
      kind: "peer",
    });
    expect(await status(ban(m, remote.id))).toBe(400);
    expect(await status(client().send("/api/chat/ban", { method: "POST", body: { user: b.user.id, banned: true } }))).toBe(401);
  });
});

describe("moderation QA (§36.6)", () => {
  it("a banned account is told so, but only with the right password", async () => {
    const a = await newUser();
    const m = await newModerator();
    await ban(m, a.user.id);
    const err = await client()
      .collection("users")
      .authWithPassword(a.email, a.password)
      .catch((e: { status: number; message: string }) => e);
    expect(err).toMatchObject({ status: 403, message: "This account is banned." });
    const wrong = await client()
      .collection("users")
      .authWithPassword(a.email, "wrong-password")
      .catch((e: { status: number; message: string }) => e);
    expect(wrong).toMatchObject({ status: 400, message: "Failed to authenticate." });
  });

  it("a moderator deletes their own message where they can't post, by the route", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    const mine = await post(m, room.id, "mine");
    await a.pb.collection("rooms").update(room.id, { posting: "selected" });
    expect((await del(m, [mine.id]))[0]).toMatchObject({ deleted: true });
  });

  it("anyone banned can be unbanned: a moderator or a stand-in a superuser banned", async () => {
    const m = await newModerator();
    const m2 = await newModerator();
    const admin = await adminClient();
    await admin.collection("users").update(m2.user.id, { banned: true });
    expect(await ban(m, m2.user.id, false)).toMatchObject({ banned: false });
  });

  it("Telegram stand-ins can't be banned, with the bridge off too", async () => {
    const m = await newModerator();
    const admin = await adminClient();
    const name = `tg-${m.user.id}`;
    const tg = await admin.collection("users").create({
      email: `${name}@t.local`,
      password: "password-123",
      passwordConfirm: "password-123",
      name,
      no_dms: true,
      kind: "telegram",
    });
    expect(await status(ban(m, tg.id))).toBe(400);
  });

  it("a rename through a field modifier is no rename", async () => {
    const a = await newUser();
    const m = await newModerator();
    const room = await newRoom(a);
    await m.pb
      .collection("rooms")
      .update(room.id, { "name+": "x" })
      .catch(() => {});
    expect((await a.pb.collection("rooms").getOne(room.id)).name).toBe(room.name);
  });
});
