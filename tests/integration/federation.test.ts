// Linked instances (§33), end to end: three PocketBase servers (A, B, C) with the module on, paired by their admins,
// sharing rooms and DMs. Each worker runs on a cron job and on POST /api/fed/tick; `settle` ticks every server until
// nothing is queued anywhere, and checks wait for what it does.

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import PocketBase, { ClientResponseError, type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { disableRateLimits, enableFederation, freePort, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { runSql } from "../support/sql.ts";
import { byName, sleep, status } from "./helpers.ts";

interface Instance {
  server: PocketBaseServer;
  url: string;
  host: string;
  admin: PocketBase;
}

let A: Instance;
let B: Instance;
let C: Instance;

const ENV = { FEDERATION_ALLOW_PRIVATE: "1" };

async function start(port?: number, on = true): Promise<Instance> {
  port ??= await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = await startPocketBase({ port, fixtureRoute: true, env: ENV });
  await disableRateLimits(server.url);
  if (on) await enableFederation(url);
  const admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return { server, url, host: `127.0.0.1:${port}`, admin };
}

/** The request `x` sent, as it shows on `y`. */
const requestOn = (y: Instance, x: Instance) =>
  y.admin.collection("fed_peers").getFirstListItem(y.admin.filter("origin = {:o}", { o: x.url }));

/** Pair `x` (asking) and `y` (accepting), each labelling the other. Returns their fed_peers rows. */
async function pair(x: Instance, y: Instance, xLabel: string, yLabel: string, dms = true) {
  const asked = await x.admin.collection("fed_peers").create({ origin: y.url, label: yLabel, dms });
  expect(asked.status).toBe("invited");
  expect(asked.last_ok).not.toBe("");
  const request = await requestOn(y, x);
  expect(request.status).toBe("requested");
  const joined = await y.admin.collection("fed_peers").update(request.id, { status: "active", label: xLabel, dms });
  expect(joined.status).toBe("active");
  const back = await x.admin.collection("fed_peers").getOne(asked.id);
  expect(back.status).toBe("active");
  expect(back.invite).toBe("");
  return { xPeer: back, yPeer: joined };
}

const tick = (i: Instance) => i.admin.send("/api/fed/tick", { method: "POST" }).catch(() => {});

/** Run every worker until no events are queued anywhere (or `ms` pass). */
async function settle(ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await Promise.all([A, B, C].map(tick));
    const left = await Promise.all(
      [A, B, C].map((i) => i.admin.collection("fed_queue").getList(1, 1, { filter: "next_at = '' || next_at < @now" })),
    );
    if (left.every((l) => l.totalItems === 0)) return;
    if (Date.now() > deadline) throw new Error(`queues not empty: ${left.map((l) => l.totalItems).join(",")}`);
    await sleep(50);
  }
}

/** Wait (up to `ms`) until `fn` passes, settling the queues meanwhile. */
async function eventually<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await settle().catch(() => {});
      await sleep(100);
    }
  }
}

interface User {
  pb: PocketBase;
  user: RecordModel;
  name: string;
}

async function signUp(i: Instance, name = `u${uniq()}`): Promise<User> {
  const pb = new PocketBase(i.url);
  pb.autoCancellation(false);
  const email = `${uniq()}@test.local`;
  const password = "password-123";
  await pb.collection("users").create({ email, password, passwordConfirm: password, name });
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record, name };
}

/** The mirror of home room `roomId` on `i`, through its share row. */
async function mirrorOf(i: Instance, home: Instance, roomId: string) {
  const share = await i.admin
    .collection("fed_shares")
    .getFirstListItem(i.admin.filter("remote_id = {:g}", { g: `${roomId}@${home.host}` }));
  expect(share.state).toBe("active");
  return i.admin.collection("rooms").getOne(share.room);
}

/** Share a room of A's with `peer` (A's fed_peers row) and have `to` accept it. Returns the mirror. */
async function share(from: Instance, to: Instance, roomId: string, peerId: string) {
  const offer = await from.admin.collection("fed_shares").create({ room: roomId, peer: peerId });
  expect(offer.state).toBe("offered");
  const theirs = await eventually(() =>
    to.admin.collection("fed_shares").getFirstListItem(to.admin.filter("remote_id = {:g}", { g: `${roomId}@${from.host}` })),
  );
  expect(theirs.state).toBe("offered");
  await to.admin.collection("fed_shares").update(theirs.id, { accepted: true });
  return eventually(() => mirrorOf(to, from, roomId));
}

const messagesIn = (i: Instance, roomId: string) =>
  i.admin
    .collection("messages")
    .getFullList({ filter: i.admin.filter("room = {:r}", { r: roomId }), sort: "created,id", expand: "author" });

let ab: { xPeer: RecordModel; yPeer: RecordModel };
let ac: { xPeer: RecordModel; yPeer: RecordModel };

beforeAll(async () => {
  [A, B, C] = await Promise.all([start(), start(), start()]);
  ab = await pair(A, B, "A", "B");
  ac = await pair(A, C, "A", "C");
}, 90_000);

afterAll(async () => {
  await Promise.all([A, B, C].map((i) => i?.server.stop()));
});

describe("pairing (§33.3)", () => {
  it("shows a request on the asked side, checked by asking back; declining and withdrawing tell the other side", async () => {
    const D = await start();
    try {
      // Someone claiming to be A: D asks A, which never sent it, and nothing shows.
      const forged = await fetch(`${D.url}/api/fed/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: A.url, code: "x".repeat(32), name: "Not A" }),
      });
      expect(forged.status).toBe(403);
      expect((await D.admin.collection("fed_peers").getFullList()).length).toBe(0);
      // A real one shows, with a label suggested from the host and A's site name.
      const asked = await A.admin.collection("fed_peers").create({ origin: D.url, label: "D" });
      const request = await requestOn(D, A);
      expect(request).toMatchObject({ status: "requested", label: "127", name: "Chirkle", dms: false });
      // Asking again while it waits is refused here, with what to do.
      await expect(D.admin.collection("fed_peers").create({ origin: A.url, label: "A" })).rejects.toMatchObject({
        response: { data: { origin: { message: expect.stringMatching(/asked to link already/) } } },
      });
      // Only active accepts it.
      await expect(D.admin.collection("fed_peers").update(request.id, { status: "suspended" })).rejects.toMatchObject({ status: 400 });
      // Declined: A's row says so.
      await D.admin.collection("fed_peers").delete(request.id);
      expect((await A.admin.collection("fed_peers").getOne(asked.id)).last_error).toMatch(/declined/);
      await A.admin.collection("fed_peers").delete(asked.id);
      // Withdrawn: D's request goes.
      const again = await A.admin.collection("fed_peers").create({ origin: D.url, label: "D" });
      expect((await requestOn(D, A)).status).toBe("requested");
      await A.admin.collection("fed_peers").delete(again.id);
      expect((await D.admin.collection("fed_peers").getFullList()).length).toBe(0);
    } finally {
      await D.server.stop();
    }
  }, 60_000);

  it("refuses an expired or used code, an instance that doesn't link, and anyone but a superuser", async () => {
    const D = await start();
    const off = await start(undefined, false);
    try {
      const asked = await A.admin.collection("fed_peers").create({ origin: D.url, label: "D" });
      const request = await requestOn(D, A);
      await runSql(A.url, [
        { sql: "UPDATE fed_peers SET invite_expires = '2020-01-01 00:00:00.000Z' WHERE id = {:id}", params: { id: asked.id } },
      ]);
      await expect(D.admin.collection("fed_peers").update(request.id, { status: "active", label: "A" })).rejects.toMatchObject({
        status: 400,
        response: { data: { status: { message: expect.stringMatching(/expired/) } } },
      });
      await runSql(A.url, [
        { sql: "UPDATE fed_peers SET invite_expires = '2999-01-01 00:00:00.000Z' WHERE id = {:id}", params: { id: asked.id } },
      ]);
      const code = (await D.admin.collection("fed_peers").getOne(request.id)).invite as string;
      expect((await D.admin.collection("fed_peers").update(request.id, { status: "active", label: "A" })).status).toBe("active");
      // Used.
      const res = await fetch(`${A.url}/api/fed/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin: D.url, code, secret: "a".repeat(64) }),
      });
      expect(res.status).toBe(403);
      // An instance with linking off answers as if it hadn't the module, and the row isn't kept.
      expect((await fetch(`${off.url}/api/fed/inbox`, { method: "POST" })).status).toBe(404);
      await expect(A.admin.collection("fed_peers").create({ origin: off.url, label: "O" })).rejects.toMatchObject({
        response: { data: { origin: { message: expect.stringMatching(/doesn't take links/) } } },
      });
      // Nor can it ask.
      await expect(off.admin.collection("fed_peers").create({ origin: A.url, label: "A" })).rejects.toMatchObject({
        response: { data: { origin: { message: expect.stringMatching(/Linking is off/) } } },
      });
      // Its address is in every global id the peers keep: it stays while any instance is listed.
      await expect(A.admin.settings.update({ meta: { appURL: "http://127.0.0.1:1" } })).rejects.toMatchObject({ status: 400 });
      // People can't pair (the collections are superusers' only).
      const u = await signUp(A);
      expect(await status(u.pb.collection("fed_peers").create({ origin: "http://127.0.0.1:1", label: "X" }))).toBe(403);
      expect(await status(u.pb.collection("fed_shares").getList())).toBe(403);
      await A.admin.collection("fed_peers").delete(asked.id);
    } finally {
      await Promise.all([D.server.stop(), off.server.stop()]);
    }
  }, 60_000);

  it("keeps a request it can't deliver, sends it once it can, and pairs at once when both asked", async () => {
    const port = await freePort();
    const asked = await A.admin.collection("fed_peers").create({ origin: `http://127.0.0.1:${port}`, label: "D" });
    expect(asked.status).toBe("invited");
    expect(asked.last_error).toMatch(/Can't be reached yet/);
    const D = await start(port);
    try {
      // D's admin asks A meanwhile: A asked first, so they pair at once.
      const theirs = await D.admin.collection("fed_peers").create({ origin: A.url, label: "A" });
      expect(theirs.status).toBe("active");
      expect((await A.admin.collection("fed_peers").getOne(asked.id)).status).toBe("active");
      await A.admin.collection("fed_peers").delete(asked.id);
      expect((await D.admin.collection("fed_peers").getFullList()).length).toBe(0);
      // Undelivered, then delivered by the worker.
      await D.server.stop();
      const later = await A.admin.collection("fed_peers").create({ origin: `http://127.0.0.1:${port}`, label: "D" });
      expect(later.last_error).toMatch(/Can't be reached yet/);
      const D2 = await start(port);
      try {
        await tick(A);
        expect((await A.admin.collection("fed_peers").getOne(later.id)).last_ok).not.toBe("");
        expect((await requestOn(D2, A)).status).toBe("requested");
      } finally {
        await A.admin.collection("fed_peers").delete(later.id);
        await D2.server.stop();
      }
    } finally {
      await D.server.stop().catch(() => {});
    }
  }, 90_000);

  it("refuses unsigned, wrongly signed and old requests", async () => {
    const body = JSON.stringify({ events: [] });
    const post = (headers: Record<string, string>) =>
      fetch(`${B.url}/api/fed/inbox`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    expect((await post({})).status).toBe(401);
    const date = String(Math.floor(Date.now() / 1000));
    expect((await post({ "X-Fed-Origin": A.url, "X-Fed-Date": date, "X-Fed-Signature": "0".repeat(64) })).status).toBe(401);
    expect((await post({ "X-Fed-Origin": "http://127.0.0.1:1", "X-Fed-Date": date, "X-Fed-Signature": "0".repeat(64) })).status).toBe(403);
  });
});

/** A peer row on `i` with a known secret, for signing requests by hand. */
async function fakePeer(i: Instance, origin: string, label: string) {
  const secret = "f".repeat(64);
  const id = uniq().slice(0, 15).padEnd(15, "0");
  await runSql(i.url, [
    {
      sql: "INSERT INTO fed_peers (id, origin, label, secret, status, dms, invite, name, last_error, created, updated) VALUES ({:id}, {:origin}, {:label}, {:secret}, 'active', 1, '', '', '', '2026-01-01 00:00:00.000Z', '2026-01-01 00:00:00.000Z')",
      params: { id, origin, label, secret },
    },
  ]);
  const signed = async (method: string, path: string, json?: unknown, date = Math.floor(Date.now() / 1000)) => {
    const body = json === undefined ? "" : JSON.stringify(json);
    const hash = createHash("sha256").update(body).digest("hex");
    const sig = createHmac("sha256", secret).update(`${method}\n${path}\n${date}\n${hash}`).digest("hex");
    return fetch(`${i.url}${path}`, {
      method,
      headers: { "content-type": "application/json", "X-Fed-Origin": origin, "X-Fed-Date": String(date), "X-Fed-Signature": sig },
      ...(json === undefined ? {} : { body }),
    });
  };
  return { id, signed };
}

describe("signed requests (§33.6)", () => {
  it("takes a signed request once, refuses an old one, and a peer acting outside its rights", async () => {
    const fake = await fakePeer(B, "http://fake.test", "F");
    expect((await fake.signed("POST", "/api/fed/inbox", { events: [] }, Math.floor(Date.now() / 1000) - 600)).status).toBe(401);
    const ok = await fake.signed("POST", "/api/fed/inbox", { events: [] });
    expect(ok.status).toBe(200);
    // A repeated event is dropped: an offer made twice is one row.
    const offer = {
      id: `e${uniq()}`,
      type: "share",
      room: `r${uniq()}@fake.test`,
      name: "fake room",
      kind: "public",
      visibility: "public",
    };
    for (let i = 0; i < 2; i++) {
      const r = await fake.signed("POST", "/api/fed/inbox", { events: [offer] });
      expect(((await r.json()) as { results: { status: number }[] }).results[0]?.status).toBe(200);
    }
    expect((await B.admin.collection("fed_seen").getFullList({ filter: B.admin.filter("event = {:e}", { e: offer.id }) })).length).toBe(1);
    expect(
      (await B.admin.collection("fed_shares").getFullList({ filter: B.admin.filter("remote_id = {:g}", { g: offer.room }) })).length,
    ).toBe(1);
    // A message into a room not shared with it.
    const ann = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `r${uniq()}`, created_by: ann.user.id });
    const ev = {
      id: `e${uniq()}`,
      type: "message",
      room: `${room.id}@${B.host}`,
      message: { id: `m${uniq()}@fake.test`, author: `x${uniq()}@fake.test`, text: "hi" },
      people: {},
    };
    const res = await fake.signed("POST", "/api/fed/inbox", { events: [ev] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: { status: number }[] }).results[0]?.status).toBe(403);
    // A home opens DMs between one of its people and one of ours, never between two of ours.
    const bea = await signUp(B);
    const creator = `x${uniq()}@fake.test`;
    const dm = {
      id: `e${uniq()}`,
      type: "room",
      room: `r${uniq()}@fake.test`,
      kind: "dm",
      created_by: creator,
      members: [`${ann.user.id}@${B.host}`, `${bea.user.id}@${B.host}`],
      people: { [creator]: { name: "Mallory", no_dms: false, avatar: "", path: "" } },
    };
    const refused = await fake.signed("POST", "/api/fed/inbox", { events: [dm] });
    expect(((await refused.json()) as { results: { status: number; error: string }[] }).results[0]).toMatchObject({
      status: 400,
      error: "A DM is between one of your people and one of ours.",
    });
    expect((await bea.pb.collection("rooms").getFullList({ filter: "kind = 'dm'" })).length).toBe(0);
    // Files only to a peer the room is shared with.
    const msg = await ann.pb
      .collection("messages")
      .create({ room: room.id, author: ann.user.id, text: "", files: [new File([PNG], "a.png", { type: "image/png" })] });
    expect((await fake.signed("GET", `/api/fed/files/${msg.id}/${msg.files[0]}`)).status).toBe(404);
    // Lookups: exact names only, for DMs only if they take them.
    expect((await fake.signed("GET", `/api/fed/users?name=${encodeURIComponent(ann.name)}&for=dm`)).status).toBe(200);
    expect((await fake.signed("GET", `/api/fed/users?name=${encodeURIComponent(ann.name.slice(0, 4))}&for=dm`)).status).toBe(404);
    await runSql(B.url, [{ sql: "DELETE FROM fed_peers WHERE id = {:id}", params: { id: fake.id } }]);
  });
});

describe("a home speaking for our people (QA BUG-172..174)", () => {
  it("can't add anyone to a DM, write as one of ours, or edit what they wrote", async () => {
    const fake = await fakePeer(B, "http://fake2.test", "G");
    const inbox = async (ev: Record<string, unknown>) => {
      const res = await fake.signed("POST", "/api/fed/inbox", { events: [{ id: `e${uniq()}`, ...ev }] });
      return ((await res.json()) as { results: { status: number; error?: string }[] }).results[0];
    };
    const xav = await signUp(B);
    const yve = await signUp(B);
    const mal = `x${uniq()}@fake2.test`;
    const people = { [mal]: { name: "Mallory", no_dms: false, avatar: "", path: "" } };

    // BUG-172: a DM keeps its two members, whatever later room events say.
    const dmG = `r${uniq()}@fake2.test`;
    const ours = (u: User) => `${u.user.id}@${B.host}`;
    const dmEvent = (members: string[]) => ({ type: "room", room: dmG, kind: "dm", created_by: mal, members, people });
    expect((await inbox(dmEvent([mal, ours(xav)])))?.status).toBe(200);
    const [dm] = await xav.pb.collection("rooms").getFullList({ filter: "kind = 'dm'" });
    await xav.pb.collection("messages").create({ room: dm?.id, author: xav.user.id, text: "just for Mallory" });
    await inbox(dmEvent([mal, ours(xav), ours(yve)]));
    await inbox(dmEvent([mal, ours(yve)]));
    expect((await yve.pb.collection("rooms").getFullList({ filter: "kind = 'dm'" })).length).toBe(0);
    expect((await yve.pb.collection("messages").getFullList({ filter: `room = '${dm?.id}'` })).length).toBe(0);
    expect((await xav.pb.collection("rooms").getOne(dm?.id ?? "")).members).toHaveLength(2);

    // A shared public room's mirror.
    const roomG = `r${uniq()}@fake2.test`;
    await inbox({ type: "share", room: roomG, name: `lobby${uniq()}`, kind: "public", visibility: "public" });
    const offer = await B.admin.collection("fed_shares").getFirstListItem(B.admin.filter("remote_id = {:g}", { g: roomG }));
    await B.admin.collection("fed_shares").update(offer.id, { accepted: true });
    const roomEv = { type: "room", room: roomG, name: "lobby", kind: "public", visibility: "public", posting: "everyone" };
    expect((await inbox({ ...roomEv, archived: false, created_by: mal, members: [], writers: [], people }))?.status).toBe(200);
    const mirror = await B.admin.collection("rooms").getFirstListItem(B.admin.filter("remote_id = {:g}", { g: roomG }));

    // BUG-173: a message by one of ours, sent by the home.
    const forged = await inbox({
      type: "message",
      room: roomG,
      message: { id: `m${uniq()}@fake2.test`, author: ours(xav), text: "it's me" },
    });
    expect(forged?.status).toBe(403);
    // BUG-174: an edit of what one of ours wrote; a delete still goes through (the home's superusers).
    const own = await xav.pb.collection("messages").create({ room: mirror.id, author: xav.user.id, text: "my words" });
    expect((await inbox({ type: "edit", room: roomG, message: `${own.id}@${B.host}`, text: "not my words" }))?.status).toBe(403);
    expect((await messagesIn(B, mirror.id)).map((m) => m.text)).toContain("my words");
    expect((await inbox({ type: "delete", room: roomG, message: `${own.id}@${B.host}` }))?.status).toBe(200);
    expect((await B.admin.collection("messages").getOne(own.id)).deleted).toBe(true);
    // The home's own people still write and edit.
    const theirs = `m${uniq()}@fake2.test`;
    expect((await inbox({ type: "message", room: roomG, message: { id: theirs, author: mal, text: "hello" }, people }))?.status).toBe(200);
    expect((await inbox({ type: "edit", room: roomG, message: theirs, text: "hello again" }))?.status).toBe(200);
    expect((await messagesIn(B, mirror.id)).map((m) => m.text)).toContain("hello again");
    // What B queued for it (the accepted offer) goes too: a row whose peer is gone would wait forever, and settle() with it.
    await runSql(B.url, [
      { sql: "DELETE FROM fed_queue WHERE peer = {:id}", params: { id: fake.id } },
      { sql: "DELETE FROM fed_peers WHERE id = {:id}", params: { id: fake.id } },
    ]);
  }, 60_000);
});

describe("a shared public room (§33.5)", () => {
  it("shows messages, edits, deletes, replies and reactions both ways", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `pub${uniq()}`, created_by: ann.user.id });
    const before = await ann.pb.collection("messages").create({ room: room.id, author: ann.user.id, text: "from before" });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    expect(mirror.name).toBe(`${room.name} (A)`);
    expect(mirror.shared).toEqual({ home: A.host, with: [A.host] });
    expect((await A.admin.collection("rooms").getOne(room.id)).shared).toEqual({ with: [B.host] });

    // Backfill: what was there before.
    await eventually(async () => expect((await messagesIn(B, mirror.id)).map((m) => m.text)).toContain("from before"));

    // A → B.
    const hello = await ann.pb.collection("messages").create({ room: room.id, author: ann.user.id, text: "hello from A" });
    const copy = await eventually(async () => {
      const found = (await messagesIn(B, mirror.id)).find((m) => m.text === "hello from A");
      expect(found).toBeTruthy();
      return found as RecordModel;
    });
    expect(copy.expand?.author?.name).toBe(`${ann.name} (A)`);
    expect(copy.expand?.author?.instance).toBe(A.host);

    // B → A, as a reply.
    const reply = await bob.pb
      .collection("messages")
      .create({ room: mirror.id, author: bob.user.id, text: "hi from B", reply_to: copy.id });
    const there = await eventually(async () => {
      const found = (await messagesIn(A, room.id)).find((m) => m.text === "hi from B");
      expect(found).toBeTruthy();
      return found as RecordModel;
    });
    expect(there.expand?.author?.name).toBe(`${bob.name} (B)`);
    expect(there.reply_to).toBe(hello.id);

    // Edits and deletes, both ways.
    await bob.pb.collection("messages").update(reply.id, { text: "hi from B, edited" });
    await ann.pb.collection("messages").update(before.id, { deleted: true });
    await eventually(async () => {
      expect((await A.admin.collection("messages").getOne(there.id)).text).toBe("hi from B, edited");
      const old = (await messagesIn(B, mirror.id)).find((m) => m.remote_id === `${before.id}@${A.host}`);
      expect(old?.deleted).toBe(true);
    });

    // Someone on B can't change A's people's messages there.
    expect(await status(B.admin.collection("messages").update(copy.id, { text: "nope" }))).toBe(400);

    // Reactions: from B, the home's list comes back; from A, it goes to B.
    await bob.pb.send("/api/chat/reactions", { method: "POST", body: { message: copy.id, emoji: "👍", on: true } });
    await ann.pb.send("/api/chat/reactions", { method: "POST", body: { message: hello.id, emoji: "❤️", on: true } });
    await eventually(async () => {
      const home = await A.admin.collection("messages").getOne(hello.id);
      const r = Object.fromEntries((home.reactions as { emoji: string; users: string[] }[]).map((x) => [x.emoji, x.users.length]));
      expect(r).toEqual({ "👍": 1, "❤️": 1 });
      const mine = await B.admin.collection("messages").getOne(copy.id);
      const users = (mine.reactions as { emoji: string; users: string[] }[]).find((x) => x.emoji === "👍")?.users;
      expect(users).toEqual([bob.user.id]);
      expect((mine.reactions as unknown[]).length).toBe(2);
    });
  }, 60_000);

  it("is anonymous on the mirror when the home's is (DESIGN.md §35)", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `anon${uniq()}`, created_by: ann.user.id });
    await A.admin.collection("rooms").update(room.id, { anonymous: true });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    expect(mirror.anonymous).toBe(true);
    // Only the home changes it.
    expect(await status(B.admin.collection("rooms").update(mirror.id, { anonymous: false }))).toBe(400);

    await ann.pb.collection("messages").create({ room: room.id, author: ann.user.id, text: "from A, unsigned" });
    const copy = await eventually(async () => {
      const found = (await messagesIn(B, mirror.id)).find((m) => m.text === "from A, unsigned");
      expect(found).toBeTruthy();
      return found as RecordModel;
    });
    expect(copy.anonymous).toBe(true);
    const seen = await bob.pb.collection("messages").getOne(copy.id, { expand: "author" });
    expect(seen.author).toBe(mirror.id);
    expect(seen.expand?.author?.name).toBe(mirror.name);

    await A.admin.collection("rooms").update(room.id, { anonymous: false });
    await eventually(async () => expect((await B.admin.collection("rooms").getOne(mirror.id)).anonymous).toBe(false));
  }, 60_000);

  it("copies attachments", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `files${uniq()}`, created_by: ann.user.id });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    await ann.pb.collection("messages").create({
      room: room.id,
      author: ann.user.id,
      text: "a picture",
      files: [new File([PNG], "dot.png", { type: "image/png" })],
    });
    const copy = await eventually(async () => {
      const found = (await messagesIn(B, mirror.id)).find((m) => m.text === "a picture");
      expect(found?.files).toHaveLength(1);
      return found as RecordModel;
    });
    expect(Object.values(copy.file_names)).toEqual(["dot.png"]);
    const token = await B.admin.files.getToken();
    const res = await fetch(B.admin.files.getURL(byName(copy), copy.files[0], { token }));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG))).toBe(true);
  }, 60_000);

  it("backfills the newest 200 messages, each once", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `long${uniq()}`, created_by: ann.user.id });
    for (let i = 0; i < 250; i += 25) {
      await Promise.all(
        Array.from({ length: 25 }, (_, k) =>
          A.admin.collection("messages").create({ room: room.id, author: ann.user.id, text: `m${i + k}` }),
        ),
      );
    }
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    const want = Array.from({ length: 200 }, (_, k) => `m${50 + k}`).sort();
    await eventually(async () => {
      const texts = (await messagesIn(B, mirror.id)).filter((m) => m.remote_id).map((m) => m.text);
      expect(texts.sort()).toEqual(want);
    }, 30_000);
  }, 90_000);

  it("passes a third instance's people on, vouched for by the home", async () => {
    const ann = await signUp(A);
    const cat = await signUp(C);
    const room = await ann.pb.collection("rooms").create({ name: `three${uniq()}`, created_by: ann.user.id });
    const mb = await share(A, B, room.id, ab.xPeer.id);
    const mc = await share(A, C, room.id, ac.xPeer.id);
    await cat.pb.collection("messages").create({ room: mc.id, author: cat.user.id, text: "from C" });
    const copy = await eventually(async () => {
      const found = (await messagesIn(B, mb.id)).find((m) => m.text === "from C");
      expect(found).toBeTruthy();
      return found as RecordModel;
    });
    expect(copy.expand?.author?.name).toBe(`${cat.name} (${C.host.slice(0, 12)})`);
    expect(copy.expand?.author?.no_dms).toBe(true);
    await eventually(async () =>
      expect(((await B.admin.collection("rooms").getOne(mb.id)).shared as { with: string[] }).with.sort()).toEqual([A.host, C.host].sort()),
    );
  }, 60_000);

  it("ends a share: the mirror is archived, the home says so", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `end${uniq()}`, created_by: ann.user.id });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    const row = await A.admin
      .collection("fed_shares")
      .getFirstListItem(A.admin.filter("room = {:r} && peer = {:p}", { r: room.id, p: ab.xPeer.id }));
    await A.admin.collection("fed_shares").delete(row.id);
    await eventually(async () => expect((await B.admin.collection("rooms").getOne(mirror.id)).archived).toBe(true));
    expect((await B.admin.collection("rooms").getOne(mirror.id)).shared).toEqual({});
    const notes = (await messagesIn(A, room.id)).filter((m) => !m.author).map((m) => m.text);
    expect(notes).toContain(`This room is no longer shared with ${B.host}.`);
    expect((await A.admin.collection("rooms").getOne(room.id)).shared).toEqual({});
  }, 60_000);
});

describe("a shared private room (§33.5)", () => {
  it("each side's admins manage their own people", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const bea = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `priv${uniq()}`, created_by: ann.user.id, visibility: "private" });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    expect(mirror.visibility).toBe("private");
    // Bob can't see it yet; nor change its members.
    expect(await status(bob.pb.collection("rooms").getOne(mirror.id))).toBe(404);

    // B's admin adds Bob.
    await B.admin.collection("rooms").update(mirror.id, { "members+": bob.user.id });
    const standIn = await eventually(async () => {
      const home = await A.admin.collection("rooms").getOne(room.id, { expand: "members" });
      const found = (home.expand?.members as RecordModel[] | undefined)?.find((m) => m.name === `${bob.name} (B)`);
      expect(found).toBeTruthy();
      return found as RecordModel;
    });
    expect((await bob.pb.collection("rooms").getOne(mirror.id)).id).toBe(mirror.id);
    await bob.pb.collection("messages").create({ room: mirror.id, author: bob.user.id, text: "I'm in" });
    await eventually(async () => expect((await messagesIn(A, room.id)).map((m) => m.text)).toContain("I'm in"));

    // Refused: a user (Bob, even as a member), and A's people from B.
    expect(await status(bob.pb.collection("rooms").update(mirror.id, { "members+": bea.user.id }))).toBe(404);
    const annHere = (await B.admin.collection("users").getFirstListItem(B.admin.filter("name = {:n}", { n: `${ann.name} (A)` }))).id;
    expect(await status(B.admin.collection("rooms").update(mirror.id, { "members-": annHere }))).toBe(400);

    // The home's creator removes Bob: gone on B too.
    await ann.pb.collection("rooms").update(room.id, { "members-": standIn.id });
    await eventually(async () => expect(await status(bob.pb.collection("rooms").getOne(mirror.id))).toBe(404));
  }, 60_000);

  it("puts B's list back when A refuses", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `ref${uniq()}`, created_by: ann.user.id, visibility: "private" });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    // Archived on A meanwhile, before B hears of it: B's request is refused.
    await runSql(A.url, [{ sql: "UPDATE rooms SET archived = 1 WHERE id = {:id}", params: { id: room.id } }]);
    await B.admin.collection("rooms").update(mirror.id, { "members+": bob.user.id });
    await eventually(async () => {
      const row = await B.admin.collection("fed_shares").getFirstListItem(B.admin.filter("room = {:r}", { r: mirror.id }));
      expect(row.last_error).toMatch(/archived/);
      expect((await B.admin.collection("rooms").getOne(mirror.id)).members).not.toContain(bob.user.id);
    });
  }, 60_000);
});

describe("offers (§33.5)", () => {
  it("a declined offer ends on the home", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `dec${uniq()}`, created_by: ann.user.id });
    const offer = await A.admin.collection("fed_shares").create({ room: room.id, peer: ab.xPeer.id });
    const theirs = await eventually(() =>
      B.admin.collection("fed_shares").getFirstListItem(B.admin.filter("remote_id = {:g}", { g: `${room.id}@${A.host}` })),
    );
    await B.admin.collection("fed_shares").delete(theirs.id);
    await eventually(async () => {
      const row = await A.admin.collection("fed_shares").getOne(offer.id);
      expect(row.state).toBe("ended");
      expect(row.last_error).toBe("Declined.");
    });
    // A user can't share a room, nor accept one.
    const u = await signUp(A);
    expect(await status(u.pb.collection("fed_shares").create({ room: room.id, peer: ab.xPeer.id }))).toBe(403);
  }, 60_000);
});

describe("Open Air (§33.5)", () => {
  it("a guest on the mirror's instance reads it", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `open${uniq()}`, created_by: ann.user.id, visibility: "open" });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    await ann.pb.collection("messages").create({ room: room.id, author: ann.user.id, text: "open to all" });
    const guest = new PocketBase(B.url);
    await eventually(async () => {
      const list = await guest.collection("messages").getFullList({ filter: guest.filter("room = {:r}", { r: mirror.id }) });
      expect(list.map((m) => m.text)).toContain("open to all");
    });
  }, 60_000);
});

describe("DMs across instances (§33.5)", () => {
  it("finds someone by name@host and talks to them", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const found = (await ann.pb.send("/api/chat/remote-users", {
      method: "POST",
      body: { address: `${bob.name}@${B.host}` },
    })) as RecordModel;
    expect(found.name).toBe(`${bob.name} (B)`);
    expect(found.instance).toBe(B.host);
    const dm = (await ann.pb.send("/api/chat/dms", { method: "POST", body: { user: found.id } })) as RecordModel;
    await ann.pb.collection("messages").create({ room: dm.id, author: ann.user.id, text: "hi Bob" });
    const mirror = await eventually(async () => {
      const rooms = await bob.pb.collection("rooms").getFullList({ filter: "kind = 'dm'" });
      expect(rooms).toHaveLength(1);
      return rooms[0] as RecordModel;
    });
    await eventually(async () => expect((await messagesIn(B, mirror.id)).map((m) => m.text)).toEqual(["hi Bob"]));
    await bob.pb.collection("messages").create({ room: mirror.id, author: bob.user.id, text: "hi Ann" });
    await eventually(async () => expect((await messagesIn(A, dm.id)).map((m) => m.text)).toEqual(["hi Bob", "hi Ann"]));

    // Not partial names, and not people who take no DMs.
    const partial = ann.pb.send("/api/chat/remote-users", { method: "POST", body: { address: `${bob.name.slice(0, 3)}@${B.host}` } });
    await expect(partial).rejects.toBeInstanceOf(ClientResponseError);
    const shy = await signUp(B);
    await shy.pb.collection("users").update(shy.user.id, { no_dms: true });
    await expect(
      ann.pb.send("/api/chat/remote-users", { method: "POST", body: { address: `${shy.name}@${B.host}` } }),
    ).rejects.toMatchObject({ status: 400 });
  }, 60_000);

  it("closes DMs when an admin unticks dms", async () => {
    const ann = await signUp(A);
    const bob = await signUp(B);
    const found = (await ann.pb.send("/api/chat/remote-users", {
      method: "POST",
      body: { address: `${bob.name}@${B.host}` },
    })) as RecordModel;
    const dm = (await ann.pb.send("/api/chat/dms", { method: "POST", body: { user: found.id } })) as RecordModel;
    await A.admin.collection("fed_peers").update(ab.xPeer.id, { dms: false });
    try {
      expect(await status(ann.pb.collection("messages").create({ room: dm.id, author: ann.user.id, text: "still?" }))).toBe(400);
      const other = await signUp(B);
      await expect(
        ann.pb.send("/api/chat/remote-users", { method: "POST", body: { address: `${other.name}@${B.host}` } }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await A.admin.collection("fed_peers").update(ab.xPeer.id, { dms: true });
    }
    await ann.pb.collection("messages").create({ room: dm.id, author: ann.user.id, text: "again" });

    // Bob turning DMs off on B closes it on A too (§16.7), once B tells A.
    await eventually(async () =>
      expect(
        (await messagesIn(B, (await bob.pb.collection("rooms").getFullList({ filter: "kind = 'dm'" }))[0]!.id)).length,
      ).toBeGreaterThan(0),
    );
    await bob.pb.collection("users").update(bob.user.id, { no_dms: true });
    await eventually(async () => expect((await A.admin.collection("users").getOne(found.id)).no_dms).toBe(true));
    expect(await status(ann.pb.collection("messages").create({ room: dm.id, author: ann.user.id, text: "and now?" }))).toBe(400);
  }, 60_000);
});

describe("people (§33.4)", () => {
  it("reserves a peer's label in names, and passes profile changes on", async () => {
    const ann = await signUp(A);
    expect(await status(ann.pb.collection("users").update(ann.user.id, { name: `x${uniq()} (B)` }))).toBe(400);
    const bob = await signUp(B);
    const room = await ann.pb.collection("rooms").create({ name: `ppl${uniq()}`, created_by: ann.user.id });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    await bob.pb.collection("messages").create({ room: mirror.id, author: bob.user.id, text: "it's me" });
    await eventually(async () => expect((await messagesIn(A, room.id)).map((m) => m.text)).toContain("it's me"));
    const renamed = `n${uniq()}`;
    await bob.pb.collection("users").update(bob.user.id, { name: renamed });
    await eventually(async () => {
      const u = await A.admin
        .collection("users")
        .getFirstListItem(`${A.admin.filter("instance = {:h}", { h: B.host })} && name = "${renamed} (B)"`);
      expect(u).toBeTruthy();
    });
  }, 60_000);
});

describe("suspending and unpairing (§33.7)", () => {
  it("holds the queue while suspended, then sends it", async () => {
    const ann = await signUp(A);
    const room = await ann.pb.collection("rooms").create({ name: `sus${uniq()}`, created_by: ann.user.id });
    const mirror = await share(A, B, room.id, ab.xPeer.id);
    await B.admin.collection("fed_peers").update(ab.yPeer.id, { status: "suspended" });
    try {
      expect(((await B.admin.collection("rooms").getOne(mirror.id)).shared as { down?: boolean }).down).toBe(true);
      await ann.pb.collection("messages").create({ room: room.id, author: ann.user.id, text: "while away" });
      await Promise.all([A, B, C].map(tick));
      await sleep(300);
      expect((await messagesIn(B, mirror.id)).map((m) => m.text)).not.toContain("while away");
    } finally {
      await B.admin.collection("fed_peers").update(ab.yPeer.id, { status: "active" });
    }
    // Retried after its backoff (2 s).
    await eventually(async () => expect((await messagesIn(B, mirror.id)).map((m) => m.text)).toContain("while away"), 20_000);
    expect(((await B.admin.collection("rooms").getOne(mirror.id)).shared as { down?: boolean }).down).toBeUndefined();
  }, 60_000);

  it("unpairing archives mirrors and closes DMs", async () => {
    const D = await start();
    const E = await start();
    try {
      const de = await pair(D, E, "D", "E");
      const dan = await signUp(D);
      const eve = await signUp(E);
      const room = await dan.pb.collection("rooms").create({ name: `un${uniq()}`, created_by: dan.user.id });
      const offer = await D.admin.collection("fed_shares").create({ room: room.id, peer: de.xPeer.id });
      const tickDE = () => Promise.all([tick(D), tick(E)]);
      const until = async (fn: () => Promise<void>) => {
        for (let i = 0; ; i++) {
          try {
            return await fn();
          } catch (e) {
            if (i > 100) throw e;
            await tickDE();
            await sleep(100);
          }
        }
      };
      const theirs = await (async () => {
        let row: RecordModel | undefined;
        await until(async () => {
          row = await E.admin.collection("fed_shares").getFirstListItem(E.admin.filter("remote_id = {:g}", { g: `${room.id}@${D.host}` }));
        });
        return row as RecordModel;
      })();
      await E.admin.collection("fed_shares").update(theirs.id, { accepted: true });
      let mirrorId = "";
      await until(async () => {
        const row = await E.admin.collection("fed_shares").getOne(theirs.id);
        expect(row.state).toBe("active");
        mirrorId = row.room;
      });
      expect(offer.id).toBeTruthy();
      const found = (await dan.pb.send("/api/chat/remote-users", {
        method: "POST",
        body: { address: `${eve.name}@${E.host}` },
      })) as RecordModel;
      const dm = (await dan.pb.send("/api/chat/dms", { method: "POST", body: { user: found.id } })) as RecordModel;
      await D.admin.collection("fed_peers").delete(de.xPeer.id);
      // E heard at once: the peer row is gone there too, the mirror archived.
      expect((await E.admin.collection("fed_peers").getFullList()).length).toBe(0);
      expect((await E.admin.collection("rooms").getOne(mirrorId)).archived).toBe(true);
      expect(await status(dan.pb.collection("messages").create({ room: dm.id, author: dan.user.id, text: "hello?" }))).toBe(400);
    } finally {
      await Promise.all([D.server.stop(), E.server.stop()]);
    }
  }, 90_000);
});

describe("a home that is down (§33.1)", () => {
  it("keeps what the mirror's people write until it is back", async () => {
    const dPort = await freePort();
    const dUrl = `http://127.0.0.1:${dPort}`;
    const env = ENV;
    let dServer = await startPocketBase({ port: dPort, fixtureRoute: true, env });
    await enableFederation(dUrl);
    const dataDir = dServer.dataDir;
    const D: Instance = { server: dServer, url: dUrl, host: `127.0.0.1:${dPort}`, admin: new PocketBase(dUrl) };
    D.admin.autoCancellation(false);
    await disableRateLimits(dUrl);
    await D.admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    const E = await start();
    try {
      const de = await pair(D, E, "D", "E");
      const dan = await signUp(D);
      const eve = await signUp(E);
      const room = await dan.pb.collection("rooms").create({ name: `down${uniq()}`, created_by: dan.user.id });
      await D.admin.collection("fed_shares").create({ room: room.id, peer: de.xPeer.id });
      const until = async <T>(fn: () => Promise<T>, tries = 150): Promise<T> => {
        for (let i = 0; ; i++) {
          try {
            return await fn();
          } catch (e) {
            if (i > tries) throw e;
            await Promise.all([tick(D), tick(E)]);
            await sleep(100);
          }
        }
      };
      const theirs = await until(() =>
        E.admin.collection("fed_shares").getFirstListItem(E.admin.filter("remote_id = {:g}", { g: `${room.id}@${D.host}` })),
      );
      await E.admin.collection("fed_shares").update(theirs.id, { accepted: true });
      const mirrorId = await until(async () => {
        const row = await E.admin.collection("fed_shares").getOne(theirs.id);
        expect(row.state).toBe("active");
        return row.room as string;
      });
      // D goes away (its data stays); Eve writes meanwhile, and it shows on E at once.
      const stop = dServer.stop;
      spawnSync("pkill", ["-f", "--", `--http=127.0.0.1:${dPort}`]);
      await eve.pb.collection("messages").create({ room: mirrorId, author: eve.user.id, text: "anyone there?" });
      await tick(E);
      expect((await messagesIn(E, mirrorId)).map((m) => m.text)).toContain("anyone there?");
      // Back, with the same data: the queue goes through.
      dServer = await startPocketBase({ port: dPort, fixtureRoute: true, env, dataDir });
      D.server = dServer;
      // (Its superuser was set again on start: a new token.)
      await D.admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await until(async () => expect((await messagesIn(D, room.id)).map((m) => m.text)).toContain("anyone there?"), 300);
      await stop().catch(() => {});
    } finally {
      await Promise.all([dServer.stop(), E.server.stop()]);
    }
  }, 90_000);
});

describe("the fetcher (§33.6)", () => {
  it("refuses plain http and private addresses without FEDERATION_ALLOW_PRIVATE, and turns on only with a public address", async () => {
    const port = await freePort();
    const server = await startPocketBase({ port, fixtureRoute: true });
    try {
      const admin = new PocketBase(server.url);
      await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const site = await admin.collection("site").getFirstListItem("");
      // The Application URL is still PocketBase's default (http://localhost:8090).
      await expect(admin.collection("site").update(site.id, { federation: true })).rejects.toMatchObject({
        response: { data: { federation: { message: expect.stringMatching(/Application URL/) } } },
      });
      await enableFederation(server.url, "https://chat.example.test");
      await expect(admin.collection("fed_peers").create({ origin: A.url, label: "A" })).rejects.toMatchObject({
        response: { data: { origin: { message: expect.stringMatching(/https/) } } },
      });
      await expect(admin.collection("fed_peers").create({ origin: "https://127.0.0.1:9", label: "A" })).rejects.toMatchObject({
        response: { data: { origin: { message: expect.stringMatching(/can't be linked with/) } } },
      });
    } finally {
      await server.stop();
    }
  }, 60_000);
});
