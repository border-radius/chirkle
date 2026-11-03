// Media collections (§31): the collections rules and hooks, saving copies (POST /api/chat/items), attaching items to
// messages, badges, subscriptions and their new counts, and the worker's thumbnails and posters for items.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RecordModel } from "pocketbase";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { makeMp4 } from "../support/video.ts";
import {
  adminClient,
  client,
  collect,
  eventually,
  newRoom,
  newUser,
  openDm,
  rawDb,
  sleep,
  status,
  type TestUser,
  uniq,
} from "./helpers.ts";

interface Item {
  id: string;
  collectionId: string;
  collectionName: string;
  collection: string;
  file: string;
  name: string;
  video: boolean;
  poster: boolean;
  created: string;
}

type Preview = { id: string; file: string; video: boolean; poster: boolean }[];
interface Listed {
  mine: { id: string; name: string; public: boolean; items: number; last_added: string; preview: Preview }[];
  subs: { id: string; name: string; items: number; owner: { id: string; name: string }; seen_at: string; new: number; preview: Preview }[];
}

const png = (name: string, w = 64, h = 48) => new File([new Uint8Array(pngOf(w, h))], name, { type: "image/png" });
const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });
const mp4 = makeMp4();
const video = (name: string) => new File([new Uint8Array(mp4 ?? [0])], name, { type: "video/mp4" });

let admin: Awaited<ReturnType<typeof adminClient>>;
let itemsId = "";
const tick = () => admin.send("/api/media/tick", { method: "POST" });
const stored = (id: string, path: string) => existsSync(join(inject("pbDataDir"), "storage", itemsId, id, path));

beforeAll(async () => {
  admin = await adminClient();
  itemsId = (await admin.collections.getOne("collection_items")).id;
});

const newCollection = (u: TestUser, extra: Record<string, unknown> = {}) =>
  u.pb.collection("collections").create({ owner: u.user.id, name: `c-${uniq()}`, ...extra });
const send = (u: TestUser, room: string, body: Record<string, unknown>) =>
  u.pb.collection("messages").create({ room, author: u.user.id, text: "", ...body });
const save = (u: TestUser, body: Record<string, unknown>) => u.pb.send<Item>("/api/chat/items", { method: "POST", body });
const listed = (u: TestUser) => u.pb.send<Listed>("/api/chat/collections", {});
const sub = (u: TestUser, collection: string, on = true) =>
  u.pb.send<{ on: boolean; seen_at: string }>("/api/chat/subs", { method: "POST", body: { collection, on } });
const fileUrl = (rec: { collectionId: string; id: string }, file: string, token = "") =>
  `${inject("pbUrl")}/api/files/${rec.collectionId}/${rec.id}/${file}${token ? `?token=${token}` : ""}`;

/** A message with an image in a new room of `u`'s, and an item saved from it into a new collection of theirs. */
async function savedItem(u: TestUser, extra: Record<string, unknown> = {}) {
  const room = await newRoom(u);
  const msg = await send(u, room.id, { files: [png("cat.png")] });
  const coll = await newCollection(u, extra);
  const item = await save(u, { collection: coll.id, message: msg.id, file: msg.files[0] });
  return { room, msg, coll, item };
}

describe("collections (§31)", () => {
  it("are their owner's: names unique per owner whatever the case, counters kept by the server", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await a.pb.collection("collections").create({ owner: a.user.id, name: "  Cats  " });
    expect(c).toMatchObject({ name: "Cats", public: false, items: 0 });
    expect(c.name_key).toBeUndefined();
    expect(await status(a.pb.collection("collections").create({ owner: a.user.id, name: "CATS" }))).toBe(400);
    expect(await status(b.pb.collection("collections").create({ owner: b.user.id, name: "Cats" }))).toBe(200);
    expect(await status(b.pb.collection("collections").create({ owner: a.user.id, name: "Mine" }))).toBe(400);
    expect(await status(a.pb.collection("collections").create({ owner: a.user.id, name: "x", items: 5 }))).toBe(400);
    expect(await status(a.pb.collection("collections").update(c.id, { last_added: "2030-01-01 00:00:00.000Z" }))).toBe(404);
    expect(await status(a.pb.collection("collections").update(c.id, { owner: b.user.id }))).toBe(404);
    expect(await status(a.pb.collection("collections").create({ owner: a.user.id, name: "​" }))).toBe(400);
  });

  it("can be seen by anyone when public, by their owner only when private; only the owner changes them", async () => {
    const a = await newUser();
    const b = await newUser();
    const priv = await newCollection(a);
    const pub = await newCollection(a, { public: true });
    expect(await status(b.pb.collection("collections").getOne(priv.id))).toBe(404);
    expect(await status(b.pb.collection("collections").getOne(pub.id))).toBe(200);
    expect(await status(client().collection("collections").getOne(pub.id))).toBe(200);
    expect(await status(client().collection("collections").getOne(priv.id))).toBe(404);
    expect(await status(b.pb.collection("collections").update(pub.id, { name: "taken" }))).toBe(404);
    expect(await status(b.pb.collection("collections").delete(pub.id))).toBe(404);
    expect(await status(a.pb.collection("collections").update(priv.id, { name: "Renamed", public: true }))).toBe(200);
    expect(await status(b.pb.collection("collections").getOne(priv.id))).toBe(200);
  });

  it("are listed with their newest four items for their tiles, followed ones too", async () => {
    const a = await newUser();
    const b = await newUser();
    const coll = await newCollection(a, { public: true });
    const empty = await newCollection(a);
    const items: Item[] = [];
    for (let i = 0; i < 5; i++) {
      items.push(await a.pb.send<Item>("/api/chat/items", { method: "POST", body: { collection: coll.id, file: png(`p${i}.png`) } }));
    }
    const ids = items.map((i) => i.id);
    const mine = (await listed(a)).mine;
    const row = mine.find((c) => c.id === coll.id)!;
    expect(row.preview.map((p) => p.id)).toEqual(ids.slice(1).reverse());
    expect(row.preview[0]).toEqual({ id: items[4]!.id, file: items[4]!.file, video: false, poster: false });
    expect(mine.find((c) => c.id === empty.id)!.preview).toEqual([]);
    await sub(b, coll.id);
    expect((await listed(b)).subs.find((c) => c.id === coll.id)!.preview.map((p) => p.id)).toEqual(ids.slice(1).reverse());
    await a.pb.send(`/api/chat/items/${ids[4]}`, { method: "DELETE" });
    expect((await listed(a)).mine.find((c) => c.id === coll.id)!.preview.map((p) => p.id)).toEqual(ids.slice(0, 4).reverse());
  });

  it("are at most 50 per user", async () => {
    const a = await newUser();
    for (let i = 0; i < 50; i++) await a.pb.collection("collections").create({ owner: a.user.id, name: `n${i}` });
    expect(await status(a.pb.collection("collections").create({ owner: a.user.id, name: "one more" }))).toBe(400);
  });
});

describe("POST /api/chat/items (§31)", () => {
  it("saves a copy of a message's image under its original name, which outlives the message", async () => {
    const a = await newUser();
    const { msg, coll, item } = await savedItem(a);
    expect(item).toMatchObject({ collection: coll.id, name: "cat.png", video: false, poster: false });
    expect(item.file).not.toBe(msg.files[0]);
    expect((item as unknown as Record<string, unknown>).origin).toBeUndefined();
    expect((await a.pb.collection("collections").getOne(coll.id)).items).toBe(1);

    await a.pb.collection("messages").update(msg.id, { deleted: true });
    const res = await fetch(fileUrl(item, item.file, await a.pb.files.getToken()));
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(pngOf(64, 48)));
  });

  it("uploads an image or video straight into a collection of yours, which can then be saved and attached", async () => {
    const a = await newUser();
    const b = await newUser();
    const coll = await newCollection(a);
    const up = (u: TestUser, body: Record<string, unknown>) => u.pb.send<Item>("/api/chat/items", { method: "POST", body });
    const item = await up(a, { collection: coll.id, file: png("dog.png") });
    expect(item).toMatchObject({ collection: coll.id, name: "dog.png", video: false });
    const res = await fetch(fileUrl(item, item.file, await a.pb.files.getToken()));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(pngOf(64, 48)));
    const after = await a.pb.collection("collections").getOne(coll.id);
    expect(after.items).toBe(1);
    expect(after.last_added).not.toBe("");
    // Twice is two items: an upload is never taken for a copy of another.
    expect(await status(up(a, { collection: coll.id, file: png("dog.png") }))).toBe(200);
    expect(await status(up(a, { collection: coll.id, file: pdf("doc.pdf") }))).toBe(400);
    expect(await status(up(a, { collection: coll.id, file: new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.png") }))).toBe(400);
    expect(await status(up(b, { collection: coll.id, file: png("x.png") }))).toBe(404);
    await a.pb.collection("collections").update(coll.id, { public: true });
    expect(await status(up(b, { collection: coll.id, file: png("x.png") }))).toBe(403);
    expect((await a.pb.collection("collections").getOne(coll.id)).items).toBe(2);
    // As any item: saved into another collection, and attached to a message.
    const copy = await save(a, { collection: (await newCollection(a)).id, item: item.id });
    expect(copy.name).toBe("dog.png");
    const msg = await send(a, (await newRoom(a)).id, { items: [item.id] });
    expect(msg.file_names[msg.files[0]]).toBe("dog.png");
    await tick();
    expect(stored(item.id, `thumbs_${item.file}/240x240_${item.file}`)).toBe(true);
  });

  it("keeps a private collection's files to its owner, a public one's to anyone (guests too)", async () => {
    const a = await newUser();
    const b = await newUser();
    const { coll, item } = await savedItem(a);
    expect((await fetch(fileUrl(item, item.file, await a.pb.files.getToken()))).status).toBe(200);
    expect((await fetch(fileUrl(item, item.file, await b.pb.files.getToken()))).status).toBe(404);
    expect((await fetch(fileUrl(item, item.file))).status).toBe(404);
    await a.pb.collection("collections").update(coll.id, { public: true });
    expect((await fetch(fileUrl(item, item.file, await b.pb.files.getToken()))).status).toBe(200);
    expect((await fetch(fileUrl(item, item.file))).status).toBe(200);
    expect((await b.pb.collection("collection_items").getFullList({ filter: `collection = "${coll.id}"` })).map((i) => i.id)).toEqual([
      item.id,
    ]);
  });

  it("refuses the same file twice, files that aren't media, deleted messages and other people's collections", async () => {
    const a = await newUser();
    const b = await newUser();
    const { room, msg, coll } = await savedItem(a);
    expect(await status(save(a, { collection: coll.id, message: msg.id, file: msg.files[0] }))).toBe(409);
    const doc = await send(a, room.id, { files: [pdf("doc.pdf")] });
    expect(await status(save(a, { collection: coll.id, message: doc.id, file: doc.files[0] }))).toBe(400);
    expect(await status(save(a, { collection: coll.id, message: msg.id, file: "nope.png" }))).toBe(400);
    const gone = await send(a, room.id, { files: [png("gone.png")] });
    await a.pb.collection("messages").update(gone.id, { deleted: true });
    expect(await status(save(a, { collection: coll.id, message: gone.id, file: gone.files[0] }))).toBe(400);
    // B's own collection, A's file in a public room: fine. Into A's: no.
    const theirs = await newCollection(b);
    expect(await status(save(b, { collection: theirs.id, message: msg.id, file: msg.files[0] }))).toBe(200);
    expect(await status(save(b, { collection: coll.id, message: msg.id, file: msg.files[0] }))).toBe(404);
    await a.pb.collection("collections").update(coll.id, { public: true });
    expect(await status(save(b, { collection: coll.id, message: msg.id, file: msg.files[0] }))).toBe(403);
  });

  it("keeps one copy when the same file is saved at once: the others' copies are removed", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await send(a, room.id, { files: [png("race.png")] });
    const coll = await newCollection(a);
    const dir = join(inject("pbDataDir"), "storage", itemsId);
    const before = new Set(existsSync(dir) ? readdirSync(dir) : []);
    const codes = await Promise.all(
      Array.from({ length: 20 }, () => status(save(a, { collection: coll.id, message: msg.id, file: msg.files[0] }))),
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 409)).toBe(true);
    const [item] = await a.pb.collection("collection_items").getFullList({ filter: `collection = "${coll.id}"` });
    // Of the new folders (other tests add theirs), only the saved item's has a copy of race.png.
    const copies = readdirSync(dir).filter((id) => !before.has(id) && readdirSync(join(dir, id)).some((f) => f.startsWith("race_")));
    expect(copies).toEqual([item?.id]);
  });

  it("saves only what you can see: not a private room's file, but a forward's original you read", async () => {
    const a = await newUser();
    const b = await newUser();
    const priv = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id, visibility: "private" });
    const secret = await send(a, priv.id, { files: [png("secret.png")] });
    const mine = await newCollection(b);
    expect(await status(save(b, { collection: mine.id, message: secret.id, file: secret.files[0] }))).toBe(404);
    const dm = await openDm(a, b);
    await a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [secret.id], room: dm.id } });
    const item = await save(b, { collection: mine.id, message: secret.id, file: secret.files[0] });
    expect(item.name).toBe("secret.png");
  });

  it("copies another collection's item, once, whichever way it came", async () => {
    const a = await newUser();
    const b = await newUser();
    const { msg, item } = await savedItem(a, { public: true });
    const mine = await newCollection(b);
    const copy = await save(b, { collection: mine.id, item: item.id });
    expect(copy).toMatchObject({ collection: mine.id, name: "cat.png" });
    expect(await status(save(b, { collection: mine.id, item: item.id }))).toBe(409);
    expect(await status(save(b, { collection: mine.id, message: msg.id, file: msg.files[0] }))).toBe(409);
    const hidden = await savedItem(a);
    expect(await status(save(b, { collection: mine.id, item: hidden.item.id }))).toBe(404);
  });

  it("GET /api/chat/saved: which of your collections have the file", async () => {
    const a = await newUser();
    const b = await newUser();
    const { msg, coll, item } = await savedItem(a, { public: true });
    const other = await newCollection(a);
    const q = { message: msg.id, file: msg.files[0] };
    expect(await a.pb.send("/api/chat/saved", { query: q })).toEqual({ [coll.id]: item.id });
    const copy = await save(a, { collection: other.id, item: item.id });
    expect(await a.pb.send("/api/chat/saved", { query: { item: item.id } })).toEqual({ [coll.id]: item.id, [other.id]: copy.id });
    expect(await b.pb.send("/api/chat/saved", { query: q })).toEqual({});
    // An item that isn't there, or that you may not see, is in none of yours, though your uploads have no origin
    // (QA BUG-148).
    const up = await save(a, { collection: other.id, file: png("own.png") });
    expect(up.id).toBeTruthy();
    expect(await a.pb.send("/api/chat/saved", { query: { item: "nosuchitem0000a" } })).toEqual({});
    const hidden = await savedItem(b);
    expect(await a.pb.send("/api/chat/saved", { query: { item: hidden.item.id } })).toEqual({});
  });

  it("cleans an uploaded item's name as an attachment's: no bidi overrides, capped with its extension (QA BUG-149)", async () => {
    const a = await newUser();
    const coll = await newCollection(a);
    const item = await save(a, { collection: coll.id, file: png("cat\u202Egpj.exe.png") });
    expect(item.name).toBe("catgpj.exe.png");
    const long = await save(a, { collection: coll.id, file: png(`${"é".repeat(150)}.png`) });
    expect(new TextEncoder().encode(long.name).length).toBeLessThanOrEqual(200);
    expect(long.name).toMatch(/\.png$/);
  });

  it("DELETE /api/chat/items/{id}: the owner removes one, and the count follows", async () => {
    const a = await newUser();
    const b = await newUser();
    const { coll, item } = await savedItem(a, { public: true });
    expect(await status(b.pb.send(`/api/chat/items/${item.id}`, { method: "DELETE" }))).toBe(403);
    await a.pb.send(`/api/chat/items/${item.id}`, { method: "DELETE" });
    expect((await a.pb.collection("collections").getOne(coll.id)).items).toBe(0);
    expect(await status(a.pb.collection("collection_items").getOne(item.id))).toBe(404);
  });
});

describe("attaching items to a message (§31)", () => {
  it("copies the items' files after the uploads, with their names and where they came from", async () => {
    const a = await newUser();
    const b = await newUser();
    const { coll, item } = await savedItem(a);
    const room = await newRoom(b);
    const m = await send(a, room.id, { files: [png("up.png")], items: JSON.stringify([item.id]), text: "look" });
    expect(m.files).toHaveLength(2);
    expect(m.file_names[m.files[0]]).toBe("up.png");
    expect(m.file_names[m.files[1]]).toBe("cat.png");
    expect(m.file_sources).toEqual({ [m.files[1]]: coll.id });
    // The room's readers see it with the room's rules, though the collection is private.
    const res = await fetch(fileUrl(m as unknown as { collectionId: string; id: string }, m.files[1], await b.pb.files.getToken()));
    expect(res.status).toBe(200);
    // JSON bodies too, items alone.
    const only = await a.pb.send<RecordModel>("/api/collections/messages/records", {
      method: "POST",
      body: { room: room.id, author: a.user.id, text: "", items: [item.id] },
    });
    expect(only.files).toHaveLength(1);
    // A forward shows where they came from too.
    const [fwd] = await a.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: room.id } });
    expect(fwd!.file_sources).toEqual(m.file_sources);
  });

  it("takes items of your own or public collections only, and no file_sources from the client", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(b);
    const priv = await savedItem(a);
    const pub = await savedItem(a, { public: true });
    expect(await status(send(b, room.id, { items: JSON.stringify([priv.item.id]) }))).toBe(400);
    expect(await status(send(b, room.id, { items: JSON.stringify(["nope"]) }))).toBe(400);
    expect(await status(send(b, room.id, { items: "not json" }))).toBe(400);
    const m = await send(b, room.id, { items: JSON.stringify([pub.item.id]) });
    expect(m.file_sources).toEqual({ [m.files[0]]: pub.coll.id });
    expect(await status(send(b, room.id, { text: "x", file_sources: { "a.png": pub.coll.id } }))).toBe(400);
    expect(await status(b.pb.collection("messages").update(m.id, { file_sources: {} }))).toBe(404); // the update rule
    const files = Array.from({ length: 10 }, (_, i) => png(`f${i}.png`));
    expect(await status(send(b, room.id, { files, items: JSON.stringify([pub.item.id]) }))).toBe(400);
  });

  it("clears file_sources with the files when the message is deleted", async () => {
    const a = await newUser();
    const { room, item } = await savedItem(a);
    const m = await send(a, room.id, { items: JSON.stringify([item.id]) });
    const deleted = await a.pb.collection("messages").update(m.id, { deleted: true });
    expect(deleted.file_sources).toEqual({});
  });
});

describe("GET /api/chat/badges (§31)", () => {
  it("names a public collection to anyone, a private one to its owner only, and nothing for one that is gone", async () => {
    const a = await newUser();
    const b = await newUser();
    const pub = await newCollection(a, { public: true, name: "Public one" });
    const priv = await newCollection(a, { name: "Secret one" });
    const gone = await newCollection(a);
    await a.pb.collection("collections").delete(gone.id);
    const query = { ids: [pub.id, priv.id, gone.id, "bad id"].join(",") };
    expect(await b.pb.send("/api/chat/badges", { query })).toEqual({
      [pub.id]: { name: "Public one", public: true, mine: false },
      [priv.id]: { private: true },
      [gone.id]: null,
    });
    expect((await a.pb.send<Record<string, unknown>>("/api/chat/badges", { query }))[priv.id]).toEqual({
      name: "Secret one",
      public: false,
      mine: true,
    });
    expect((await client().send<Record<string, unknown>>("/api/chat/badges", { query }))[pub.id]).toMatchObject({ name: "Public one" });
  });

  it("tells chat/badges listeners a collection's id once it is made public or private, renamed or deleted", async () => {
    const a = await newUser();
    const b = await newUser();
    const guest = client();
    const coll = await newCollection(a, { name: "Was secret" });
    const query = { ids: coll.id };
    /** What b's badge said when each id came in: asked at once, it is the saved state already. */
    const seen: unknown[] = [];
    const heard: string[] = [];
    const offB = await b.pb.realtime.subscribe("chat/badges", (d: { id: string }) => {
      if (d.id !== coll.id) return; // other tests' collections
      void b.pb.send<Record<string, unknown>>("/api/chat/badges", { query }).then((got) => seen.push(got[d.id]));
    });
    const offGuest = await guest.realtime.subscribe("chat/badges", (d: { id: string }) => heard.push(d.id));
    try {
      await a.pb.collection("collections").update(coll.id, { public: true });
      await eventually(() => expect(seen).toEqual([{ name: "Was secret", public: true, mine: false }]));
      await a.pb.collection("collections").update(coll.id, { name: "Now public" });
      await eventually(() => expect(seen).toHaveLength(2));
      expect(seen[1]).toMatchObject({ name: "Now public" });
      await a.pb.collection("collections").update(coll.id, { public: false });
      await eventually(() => expect(seen[2]).toEqual({ private: true }));
      await a.pb.collection("collections").delete(coll.id);
      await eventually(() => expect(seen[3]).toBeNull());
      await eventually(() => expect(heard.filter((id) => id === coll.id)).toHaveLength(4));
      // Nothing for what the badge doesn't show: a new collection, the same name again, a new item.
      const other = await newCollection(a, { public: true });
      await a.pb.collection("collections").update(other.id, { name: other.name });
      const { coll: saved } = await savedItem(a, { public: true });
      await sleep(300);
      expect(heard.filter((id) => id === other.id || id === saved.id)).toEqual([]);
    } finally {
      await offB();
      await offGuest();
    }
  });
});

describe("subscriptions (§31)", () => {
  it("follow others' public collections and count what was added since they were seen", async () => {
    const a = await newUser();
    const b = await newUser();
    const { room, coll } = await savedItem(a, { public: true, name: `Art ${uniq()}` });
    expect(await status(sub(a, coll.id))).toBe(400); // your own
    expect(await status(sub(b, (await newCollection(a)).id))).toBe(404); // private
    expect((await sub(b, coll.id)).on).toBe(true);
    expect((await sub(b, coll.id)).on).toBe(true); // idempotent
    // Not taken for true (QA BUG-133).
    for (const on of ["false", 0]) {
      expect(await status(b.pb.send("/api/chat/subs", { method: "POST", body: { collection: coll.id, on } }))).toBe(400);
    }
    let row = (await listed(b)).subs.find((s) => s.id === coll.id)!;
    expect(row).toMatchObject({ name: coll.name, items: 1, owner: { id: a.user.id, name: a.user.name }, new: 0 });

    for (const n of ["one.png", "two.png"]) {
      const m = await send(a, room.id, { files: [png(n)] });
      await save(a, { collection: coll.id, message: m.id, file: m.files[0] });
    }
    row = (await listed(b)).subs.find((s) => s.id === coll.id)!;
    expect(row).toMatchObject({ items: 3, new: 2 });
    expect((await listed(a)).mine.find((c) => c.id === coll.id)).toMatchObject({ items: 3, public: true });

    await b.pb.send("/api/chat/subs/seen", { method: "POST", body: { collection: coll.id } });
    expect((await listed(b)).subs.find((s) => s.id === coll.id)!.new).toBe(0);
    expect(await status(b.pb.send("/api/chat/subs/seen", { method: "POST", body: { collection: coll.id, at: "" } }))).toBe(400);
    expect(await status(a.pb.send("/api/chat/subs/seen", { method: "POST", body: { collection: coll.id } }))).toBe(404);

    await sub(b, coll.id, false);
    expect((await listed(b)).subs.find((s) => s.id === coll.id)).toBeUndefined();
  });

  it("hides a collection that turned private, and tells its subscribers live", async () => {
    const a = await newUser();
    const b = await newUser();
    const coll = await newCollection(a, { public: true });
    await sub(b, coll.id);
    const events = await collect(b.pb, "collection_subs");
    try {
      await a.pb.collection("collections").update(coll.id, { public: false });
      expect((await listed(b)).subs.find((s) => s.id === coll.id)).toBeUndefined();
      await eventually(() => expect(events.events.some((e) => e.action === "update" && e.record.collection === coll.id)).toBe(true));
      await a.pb.collection("collections").update(coll.id, { public: true });
      expect((await listed(b)).subs.find((s) => s.id === coll.id)).toBeDefined();
    } finally {
      await events.stop();
    }
  });

  it("lists the tiles' previews from the (collection, created) index, never scanning every item", () => {
    const db = rawDb();
    try {
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT i.id FROM json_each('["a","b"]') c CROSS JOIN collection_items i ON i.id IN (
             SELECT j.id FROM collection_items j WHERE j.collection = c.value ORDER BY j.created DESC, j.id DESC LIMIT 4
           )`,
        )
        .all()
        .map((r) => (r as { detail: string }).detail)
        .join("\n");
      expect(plan).toMatch(/SEARCH i USING (COVERING )?INDEX/);
      expect(plan).toMatch(/SEARCH j USING (COVERING )?INDEX idx_collection_items_collection/);
      expect(plan).not.toMatch(/SCAN i\b/);
    } finally {
      db.close();
    }
  });

  it("counts with the (collection, created) index", () => {
    const db = rawDb();
    try {
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM (SELECT 1 FROM collection_items i WHERE i.collection = 'c' AND i.created > 'x' LIMIT 100)",
        )
        .all()
        .map((r) => (r as { detail: string }).detail)
        .join("\n");
      expect(plan).toMatch(/USING COVERING INDEX idx_collection_items_collection|USING INDEX idx_collection_items_collection/);
    } finally {
      db.close();
    }
  });
});

describe("the media worker and items (§31)", () => {
  it("makes an item's grid thumbnail", async () => {
    const a = await newUser();
    const { item } = await savedItem(a);
    await tick();
    expect(stored(item.id, `thumbs_${item.file}/240x240_${item.file}`)).toBe(true);
  });

  it.skipIf(!mp4 && !process.env.CI)(
    "gives a video its poster, from the message's when it has one, served by the item's rules",
    async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      const coll = await newCollection(a);
      const m = await send(a, room.id, { files: [video("clip.mp4")] });
      const fresh = await save(a, { collection: coll.id, message: m.id, file: m.files[0] });
      expect(fresh).toMatchObject({ video: true, poster: false });
      const events = await collect(a.pb, "collections");
      try {
        await tick();
        expect((await a.pb.collection("collection_items").getOne(fresh.id)).poster).toBe(true);
        // The room list's tile hears of it and shows the poster (QA BUG-207).
        await eventually(() => expect(events.events.some((e) => e.action === "update" && e.record.id === coll.id)).toBe(true));
        expect((await listed(a)).mine.find((c) => c.id === coll.id)!.preview[0]).toMatchObject({ id: fresh.id, poster: true });
      } finally {
        await events.stop();
      }
      const later = await save(a, { collection: (await newCollection(a)).id, message: m.id, file: m.files[0] });
      expect(later.poster).toBe(true); // copied along: the message has its poster now
      const url = async (u: TestUser) =>
        `${inject("pbUrl")}/api/chat/posters/items/${fresh.id}/${fresh.file}?token=${await u.pb.files.getToken()}`;
      const res = await fetch(await url(a));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect((await fetch(await url(b))).status).toBe(404);
    },
  );
});
