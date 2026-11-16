// Your data and deleting your account (DESIGN.md §43): the export (POST and GET /api/chat/export, GET
// /api/chat/export/file), POST /api/chat/account/delete, and the worker that does the long part of both
// (pb_hooks/lib/account.js; ACCOUNT_CRON is off here, so POST /api/account/tick runs it).

import { ClientResponseError } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import answers from "../../shared/schema/answers.json" with { type: "json" };
import { check, type Schema } from "../support/schema.ts";
import {
  adminClient,
  client,
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

interface Export {
  format: string;
  version: number;
  account: { id: string; name: string; handle: string; email: string; avatar: string };
  rooms: { id: string; name: string; kind: string; mine: boolean }[];
  messages: { id: string; room: string; text: string; reply_to: string; forward_of: string; files: { name: string; url: string }[] }[];
  collections: { id: string; name: string; items: { id: string; name: string; url: string }[] }[];
  following: { id: string; name: string }[];
  hidden_rooms: string[];
}

interface Status {
  id: string;
  state: "none" | "queued" | "done" | "failed";
  created: string;
  finished: string;
  expires: string;
  size: number;
}

const state = (u: TestUser) => u.pb.send<Status>("/api/chat/export", {});
const start = (u: TestUser) => u.pb.send<Status>("/api/chat/export", { method: "POST" });
const del = (u: TestUser, body: Record<string, unknown>) => u.pb.send("/api/chat/account/delete", { method: "POST", body });

/** Every queued account job done now, as the worker would. */
async function work() {
  await (await adminClient()).send("/api/account/tick", { method: "POST" });
}

/** The made export's file, as its link downloads it. */
async function download(u: TestUser) {
  const res = await fetch(`${inject("pbUrl")}/api/chat/export/file`, { headers: { Authorization: u.pb.authStore.token } });
  expect(res.status).toBe(200);
  return { res, data: (await res.json()) as Export };
}

/** An export asked for, made and downloaded. */
async function exportOf(u: TestUser) {
  await start(u);
  await work();
  return (await download(u)).data;
}

/** The field codes of a rejected SDK call. */
async function codes(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ClientResponseError)) throw e;
    return Object.fromEntries(Object.entries(e.response.data ?? {}).map(([k, v]) => [k, (v as { code: string }).code]));
  }
  throw new Error("expected a rejection");
}

/** The stored user row, as the API won't show it (kind, email of someone else). */
function row(id: string) {
  const db = rawDb();
  try {
    return db.prepare("SELECT name, name_key, handle, email, avatar, kind, no_dms, moderator FROM users WHERE id = ?").get(id) as {
      name: string;
      name_key: string;
      handle: string;
      email: string;
      avatar: string;
      kind: string;
      no_dms: number;
      moderator: number;
    };
  } finally {
    db.close();
  }
}

const count = (sql: string, ...args: string[]) => {
  const db = rawDb();
  try {
    return (db.prepare(sql).get(...args) as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("your data (§43.2)", () => {
  it("needs a session", async () => {
    expect(await status(client().send("/api/chat/export", {}))).toBe(401);
    expect(await status(client().send("/api/chat/export", { method: "POST" }))).toBe(401);
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file`)).status).toBe(401);
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file?token=nonsense`)).status).toBe(401);
  });

  it("is asked for, made by the worker, then downloaded; asked again soon after, it is the same one", async () => {
    const a = await newUser();
    expect(await state(a)).toEqual({ id: "", state: "none", created: "", finished: "", expires: "", size: 0 });
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file`, { headers: { Authorization: a.pb.authStore.token } })).status).toBe(404);
    const queued = await start(a);
    expect(queued).toMatchObject({ state: "queued", finished: "", size: 0 });
    expect((await start(a)).id).toBe(queued.id); // being made: the same
    expect((await state(a)).state).toBe("queued");
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file`, { headers: { Authorization: a.pb.authStore.token } })).status).toBe(404);

    await work();
    const done = await state(a);
    expect(done).toMatchObject({ id: queued.id, state: "done" });
    expect(done.size).toBeGreaterThan(100);
    expect(Date.parse(done.expires.replace(" ", "T")) - Date.parse(done.created.replace(" ", "T"))).toBe(7 * 24 * 3600_000);
    expect((await start(a)).id).toBe(queued.id); // just made: the same

    const { res, data } = await download(a);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="?chirkle-export-\d{4}-\d\d-\d\d\.json"?$/);
    expect(Number(res.headers.get("content-length"))).toBe(done.size);
    expect(check(answers.$defs.exportFile as Schema, data)).toEqual([]);
    expect(data.account.email).toBe(a.email);

    // A plain link with a file token, as the web's link and the app's download manager fetch it; only for its owner.
    const { token } = await a.pb.send<{ token: string }>("/api/files/token", { method: "POST" });
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file?token=${token}`)).status).toBe(200);
    const b = await newUser();
    expect((await fetch(`${inject("pbUrl")}/api/chat/export/file`, { headers: { Authorization: b.pb.authStore.token } })).status).toBe(404);
    // The job's file is no one's through the records or files APIs.
    expect(await status(a.pb.collection("account_jobs").getOne(queued.id))).toBe(403);
  });

  it("has your profile, messages, rooms, collections, follows and hidden rooms, and nothing of anyone else's", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(b);
    const mine = await newRoom(a);
    const hello = await post(a, room.id, "hello from a");
    await post(b, room.id, "b's own words");
    const reply = await post(a, room.id, "a reply", { reply_to: hello.id });
    const gone = await post(a, room.id, "deleted later");
    await a.pb.collection("messages").update(gone.id, { deleted: true });
    const pic = await a.pb.collection("messages").create({ room: mine.id, author: a.user.id, text: "", files: [pngFile("cat.png")] });
    const dm = await openDm(a, b);
    await post(a, dm.id, "psst");
    const coll = await a.pb.collection("collections").create({ owner: a.user.id, name: `c-${uniq()}` });
    const item = await a.pb.send<{ id: string }>("/api/chat/items", {
      method: "POST",
      body: { collection: coll.id, message: pic.id, file: pic.files[0] },
    });
    const theirs = await b.pb.collection("collections").create({ owner: b.user.id, name: `c-${uniq()}`, public: true });
    await a.pb.send("/api/chat/subs", { method: "POST", body: { collection: theirs.id, on: true } });
    await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });

    const out = await exportOf(a);
    expect(out).toMatchObject({ format: "chirkle-export", version: 1 });
    expect(out.account).toMatchObject({ id: a.user.id, name: a.user.name, email: a.email });
    expect(out.messages.map((m) => m.text)).toEqual(["hello from a", "a reply", "", "psst"]);
    expect(out.messages.find((m) => m.id === reply.id)?.reply_to).toBe(hello.id);
    const file = out.messages.find((m) => m.id === pic.id)!.files[0]!;
    expect(file).toEqual({ name: "cat.png", url: `/api/files/messages/${pic.id}/${pic.files[0]}` });
    expect((await fetch(`${inject("pbUrl")}${file.url}`)).status).toBe(200);
    expect(out.rooms).toEqual(
      expect.arrayContaining([
        { id: room.id, name: room.name, kind: "room", mine: false },
        { id: mine.id, name: mine.name, kind: "room", mine: true },
        { id: dm.id, name: b.user.name, kind: "dm", mine: true },
      ]),
    );
    expect(out.rooms).toHaveLength(3);
    expect(out.collections).toEqual([
      expect.objectContaining({ id: coll.id, items: [expect.objectContaining({ id: item.id, name: "cat.png" })] }),
    ]);
    expect(out.following).toEqual([{ id: theirs.id, name: theirs.name }]);
    expect(out.hidden_rooms).toEqual([room.id]);
    // b's words and e-mail aren't in it.
    const raw = JSON.stringify(out);
    expect(raw).not.toContain("b's own words");
    expect(raw).not.toContain(b.email);
  });

  it("pages through an account with more messages than a page, each once, in order", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    for (let i = 0; i < 520; i += 40) {
      await Promise.all(Array.from({ length: Math.min(40, 520 - i) }, (_, j) => post(a, room.id, `m${i + j}`)));
    }
    const out = await exportOf(a);
    expect(out.messages).toHaveLength(520);
    expect(new Set(out.messages.map((m) => m.id)).size).toBe(520);
    expect(new Set(out.messages.map((m) => m.text)).size).toBe(520);
  });

  it("a new one replaces nothing until asked; one 7 days old is deleted with its file", async () => {
    const a = await newUser();
    const first = await start(a);
    await work();
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE account_jobs SET created = ? WHERE id = ?").run("2020-01-01 00:00:00.000Z", first.id);
    } finally {
      db.close();
    }
    await work();
    expect(await state(a)).toMatchObject({ state: "none" });
    expect(count("SELECT COUNT(*) AS n FROM account_jobs WHERE id = ?", first.id)).toBe(0);
  });
});

describe("deleting your account (§43.3)", () => {
  it("needs a session, your password and a choice for your messages", async () => {
    expect(await status(client().send("/api/chat/account/delete", { method: "POST", body: { password: "x", messages: "keep" } }))).toBe(
      401,
    );
    const a = await newUser();
    expect(await codes(del(a, { messages: "keep" }))).toEqual({ password: "validation_required" });
    expect(await codes(del(a, { password: a.password }))).toEqual({ messages: "validation_required" });
    expect(await codes(del(a, { password: a.password, messages: "maybe" }))).toEqual({ messages: "validation_required" });
    expect(await codes(del(a, { password: "wrong-password", messages: "keep" }))).toEqual({ password: "validation_invalid_value" });
    // A body that is JSON null is no body: the same field error, not a generic one.
    const res = await fetch(`${inject("pbUrl")}/api/chat/account/delete`, {
      method: "POST",
      headers: { Authorization: a.pb.authStore.token, "content-type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { data: Record<string, unknown> }).data.password).toBeTruthy();
    // Nothing changed.
    await client().collection("users").authWithPassword(a.email, a.password);
    expect(row(a.user.id).kind).toBe("person");
  });

  it("keeping the messages: they stay under “Deleted account”; the personal data and every session go", async () => {
    const a = await newUser();
    const b = await newUser();
    await a.pb.collection("users").update(a.user.id, { avatar: pngFile("me.png") });
    const room = await newRoom(b);
    const msg = await post(a, room.id, `kept ${uniq()}`);
    const other = client();
    await other.collection("users").authWithPassword(a.email, a.password);
    const coll = await a.pb.collection("collections").create({ owner: a.user.id, name: `c-${uniq()}`, public: true });
    for (let i = 0; i < 3; i++) {
      await a.pb.send("/api/chat/items", { method: "POST", body: { collection: coll.id, file: pngFile(`p${i}.png`) } });
    }
    await a.pb.collection("hidden_rooms").create({ user: a.user.id, room: room.id });
    await a.pb.send("/api/chat/export", { method: "POST" });
    const created = await b.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: b.user.id, visibility: "private" });
    const priv = await b.pb
      .collection("rooms")
      .update(created.id, { members: [b.user.id, a.user.id], posting: "selected", writers: [b.user.id, a.user.id] });
    expect(priv.writers).toEqual([b.user.id, a.user.id]);
    const dm = await openDm(a, b);

    expect(await status(del(a, { password: a.password, messages: "keep" }))).toBe(200);

    const r = row(a.user.id);
    expect(r).toMatchObject({ name: "Deleted account", handle: "", avatar: "", kind: "deleted", no_dms: 1, moderator: 0 });
    expect(r.email).toBe(`${a.user.id}@deleted.invalid`);
    // Signed out everywhere, and no way back in.
    expect(await status(a.pb.collection("users").authRefresh())).toBe(401);
    expect(await status(other.collection("users").authRefresh())).toBe(401);
    await expectRejected(client().collection("users").authWithPassword(a.email, a.password));
    // The message stays, by "Deleted account".
    const seen = await b.pb.collection("messages").getOne(msg.id, { expand: "author" });
    expect(seen.text).toBe(msg.text);
    expect(seen.expand?.author.name).toBe("Deleted account");
    // What only they had and is small is gone at once; their collections are no one's to see, and go with the worker.
    expect(count("SELECT COUNT(*) AS n FROM hidden_rooms WHERE user = ?", a.user.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM account_jobs WHERE user = ? AND kind = 'export'", a.user.id)).toBe(0);
    expect(await status(b.pb.collection("collections").getOne(coll.id))).toBe(404);
    expect(count("SELECT COUNT(*) AS n FROM collection_items WHERE collection = ?", coll.id)).toBe(3);
    await work();
    expect(count("SELECT COUNT(*) AS n FROM collections WHERE id = ?", coll.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM collection_items WHERE collection = ?", coll.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM account_jobs WHERE user = ? AND state = 'done'", a.user.id)).toBe(1);
    // The messages it kept are still there after the worker.
    expect((await b.pb.collection("messages").getOne(msg.id)).text).toBe(msg.text);
    // Out of the private room and its writers; the DM keeps its two.
    const p = await b.pb.collection("rooms").getOne(priv.id);
    expect(p.members).toEqual([b.user.id]);
    expect(p.writers).toEqual([b.user.id]);
    expect((await b.pb.collection("rooms").getOne(dm.id)).members).toEqual([a.user.id, b.user.id].sort());
    // Nobody finds it to message, and its DM takes no more messages.
    expect(await b.pb.send<unknown[]>("/api/chat/users", { query: { q: "Deleted account" } })).toEqual([]);
    await expectRejected(post(b, dm.id, "anyone there?"));
  });

  it("the invite links it made stop working; others' links don't (QA BUG-281)", async () => {
    const a = await newUser();
    const b = await newUser();
    const mine = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id, visibility: "private" });
    await a.pb.collection("rooms").update(mine.id, { members: [a.user.id] });
    const theirs = await b.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: b.user.id, visibility: "private" });
    await b.pb.collection("rooms").update(theirs.id, { members: [b.user.id, a.user.id] });
    const link = (u: TestUser, room: string) =>
      u.pb.send<{ invite: { token: string } }>(`/api/chat/rooms/${room}/invite`, { method: "POST", body: {} });
    const gone = (await link(a, mine.id)).invite.token;
    const kept = (await link(b, theirs.id)).invite.token;
    expect(await status(del(a, { password: a.password, messages: "keep" }))).toBe(200);
    expect(await status(client().send(`/api/chat/invites/${gone}`, {}))).toBe(404);
    expect((await client().send<{ by: string }>(`/api/chat/invites/${kept}`, {})).by).toBe(b.user.name);
  });

  it("deleting the messages too: every one goes, archived rooms included, and their files with them", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(b);
    const texts = Array.from({ length: 3 }, (_, i) => `gone ${i} ${uniq()}`);
    const msgs = [];
    for (const t of texts) msgs.push(await post(a, room.id, t));
    const pic = await a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "", files: [pngFile("cat.png")] });
    const archived = await newRoom(b);
    const old = await post(a, archived.id, "in an archived room");
    await b.pb.collection("rooms").update(archived.id, { archived: true });
    const theirs = await post(b, room.id, "b stays");

    expect(await status(del(a, { password: a.password, messages: "delete" }))).toBe(200);
    // The account at once; its messages by the worker.
    expect(row(a.user.id).kind).toBe("deleted");
    expect((await b.pb.collection("messages").getOne(msgs[0]!.id)).deleted).toBe(false);
    await work();

    for (const m of [...msgs, pic, old]) {
      const got = await b.pb.collection("messages").getOne(m.id);
      expect(got).toMatchObject({ deleted: true, text: "", files: [] });
    }
    expect((await fetch(`${inject("pbUrl")}/api/files/messages/${pic.id}/${pic.files[0]}`)).status).toBe(404);
    expect((await b.pb.collection("messages").getOne(theirs.id)).text).toBe("b stays");
    expect(row(a.user.id).kind).toBe("deleted");
  });

  it("“Deleted account” is no one else's name, and deleted accounts don't clash with each other", async () => {
    const a = await newUser();
    const b = await newUser();
    expect(await codes(a.pb.collection("users").update(a.user.id, { name: "deleted ACCOUNT" }))).toEqual({ name: "validation_not_unique" });
    await expectRejected(
      client()
        .collection("users")
        .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name: "Deleted account" }),
    );
    await del(a, { password: a.password, messages: "keep" });
    await del(b, { password: b.password, messages: "keep" });
    expect(row(a.user.id).name).toBe("Deleted account");
    expect(row(b.user.id).name).toBe("Deleted account");
  });

  it("a superuser still can't delete the row of an account that wrote messages", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await post(a, room.id, "hi");
    await del(a, { password: a.password, messages: "delete" });
    await work();
    const admin = await adminClient();
    expect(await status(admin.collection("users").delete(a.user.id))).toBe(400);
  });
});
