// The media grid's server side (§30.1): the `media` index kept by the messages hooks, GET /api/chat/media/{room}, the
// worker's thumbnails and video posters (POST /api/media/tick), and GET /api/chat/posters/{message}/{file}.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase, { type RecordModel } from "pocketbase";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { migrate, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { makeMp4 } from "../support/video.ts";
import { adminClient, client, newRoom, newUser, rawDb, type TestUser } from "./helpers.ts";

interface Item {
  message: string;
  source: string;
  file: string;
  pos: number;
  name: string;
  video: boolean;
  poster: boolean;
  sent: string;
  author: { id: string; name: string } | null;
}

const png = (name: string) => new File([new Uint8Array(pngOf(64, 48))], name, { type: "image/png" });
const pdf = (name: string) => new File(["%PDF-1.4"], name, { type: "application/pdf" });

/** A real one-second MP4, made with ffmpeg; null when there is no ffmpeg here (the poster tests are skipped, but not in CI). */
const mp4 = makeMp4();
/** A baseline JPEG's dimensions, from its frame header (SOF0). */
function jpegSize(b: Uint8Array) {
  for (let i = 2; i + 8 < b.length; i += 2 + ((b[i + 2]! << 8) | b[i + 3]!)) {
    if (b[i + 1] === 0xc0) return { width: (b[i + 7]! << 8) | b[i + 8]!, height: (b[i + 5]! << 8) | b[i + 6]! };
  }
  return null;
}
const video = (name: string) => new File([new Uint8Array(mp4 ?? [0])], name, { type: "video/mp4" });

async function send(u: TestUser, room: string, files: File[], text = "") {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, files });
}

async function media(u: TestUser | null, room: string, query: Record<string, string | number> = {}) {
  const pb = u?.pb ?? client();
  return pb.send<{ items: Item[]; more: boolean }>(`/api/chat/media/${room}`, { query });
}

let admin: Awaited<ReturnType<typeof adminClient>>;
let filesId = "";
const tick = () => admin.send("/api/media/tick", { method: "POST" });
/** The `files` row of a stored name (§37), "" when there is none. */
function rowOf(file: string) {
  const db = rawDb();
  try {
    return (db.prepare("SELECT id FROM files WHERE file = ?").get(file) as { id: string } | undefined)?.id ?? "";
  } finally {
    db.close();
  }
}
/** Is `path` stored in the folder of file `file`'s row (false once the row is gone)? */
function stored(file: string, path: string) {
  const id = rowOf(file);
  return !!id && existsSync(join(inject("pbDataDir"), "storage", filesId, id, path));
}

beforeAll(async () => {
  admin = await adminClient();
  filesId = (await admin.collections.getOne("files")).id;
});

describe("GET /api/chat/media/{room} (§30.1)", () => {
  it("lists a room's images and videos newest first, a message's files last to first, a page at a time", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const first = await send(a, room.id, [png("one.png"), pdf("doc.pdf"), video("clip.mp4")]);
    await send(a, room.id, [pdf("only.pdf")], "no media");
    await a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "text only" });
    const last = await send(a, room.id, [png("two.png"), png("three.png")]);

    const { items, more } = await media(a, room.id);
    expect(more).toBe(false);
    expect(items.map((i) => i.name)).toEqual(["three.png", "two.png", "clip.mp4", "one.png"]);
    expect(items[0]).toMatchObject({ message: last.id, source: last.id, file: last.files[1], pos: 1, video: false, poster: false });
    expect(items[0]!.author).toEqual({ id: a.user.id, name: a.user.name });
    expect(items[0]!.sent).toBe(last.created);
    expect(items[2]).toMatchObject({ message: first.id, file: first.files[2], pos: 2, video: true });

    const page1 = await media(a, room.id, { limit: 3 });
    expect(page1.more).toBe(true);
    const end = page1.items.at(-1)!;
    const page2 = await media(a, room.id, { limit: 3, sent: end.sent, message: end.message, pos: end.pos });
    expect(page2).toEqual({ items: [items[3]], more: false });
  });

  it("shows a forward's media in its room, and drops a message's (and its forwards') when it is deleted", async () => {
    const a = await newUser();
    const from = await newRoom(a);
    const to = await newRoom(a);
    const original = await send(a, from.id, [png("pic.png")]);
    const [fwd] = await a.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages: [original.id], room: to.id } });
    const shown = (await media(a, to.id)).items;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ message: fwd!.id, source: original.id, file: original.files[0], name: "pic.png" });

    await a.pb.collection("messages").update(original.id, { deleted: true });
    expect((await media(a, from.id)).items).toEqual([]);
    expect((await media(a, to.id)).items).toEqual([]);
  });

  it("is for whoever can see the room: 404 for a private room's outsiders and for guests outside Open Air", async () => {
    const a = await newUser();
    const b = await newUser();
    const priv = await a.pb.collection("rooms").create({ name: `p-${Date.now()}`, created_by: a.user.id, visibility: "private" });
    await send(a, priv.id, [png("secret.png")]);
    expect((await media(a, priv.id)).items).toHaveLength(1);
    await expect(media(b, priv.id)).rejects.toMatchObject({ status: 404 });
    await expect(media(null, priv.id)).rejects.toMatchObject({ status: 404 });

    const pub = await newRoom(a);
    await send(a, pub.id, [png("pub.png")]);
    await expect(media(null, pub.id)).rejects.toMatchObject({ status: 404 });
    const open = await a.pb.collection("rooms").create({ name: `o-${Date.now()}`, created_by: a.user.id, visibility: "open" });
    await send(a, open.id, [png("open.png")]);
    expect((await media(null, open.id)).items.map((i) => i.name)).toEqual(["open.png"]);
  });

  it("reads the index, not the room's messages (the query plan)", () => {
    const db = rawDb();
    try {
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT md.message FROM media md JOIN messages m ON m.id = md.message JOIN messages s ON s.id = md.source " +
            "WHERE md.room = 'r' AND (md.sent < 'x' OR (md.sent = 'x' AND md.message < 'y')) ORDER BY md.sent DESC, md.message DESC, md.pos DESC LIMIT 61",
        )
        .all()
        .map((r) => (r as { detail: string }).detail);
      expect(plan.join("\n")).toMatch(/SEARCH md USING INDEX idx_media_room/);
      expect(plan.join("\n")).not.toMatch(/TEMP B-TREE/);
    } finally {
      db.close();
    }
  });
});

describe("the media worker (§30.1)", () => {
  it("makes an image's thumbnails before anyone asks: all of a recent message's, the grid's for an older one", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("new.png")]);
    const old = await send(a, room.id, [png("old.png")]);
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE files SET created = '2025-01-01 00:00:00.000Z' WHERE file = ?").run(old.files[0]);
    } finally {
      db.close();
    }
    const f = m.files[0];
    const o = old.files[0];
    expect(stored(f, `thumbs_${f}/240x240_${f}`)).toBe(false);
    await tick();
    for (const size of ["240x240", "800x480f", "480x240f"]) expect(stored(f, `thumbs_${f}/${size}_${f}`)).toBe(true);
    expect(stored(o, `thumbs_${o}/240x240_${o}`)).toBe(true);
    expect(stored(o, `thumbs_${o}/800x480f_${o}`)).toBe(false);
  });

  it.skipIf(!mp4 && !process.env.CI)(
    "makes a video's poster, served by its URL alone (§37.3), under a forward's original's id too",
    async () => {
      const a = await newUser();
      const b = await newUser();
      const room = await newRoom(a);
      const m = await send(a, room.id, [video("clip.mp4")]);
      const file = m.files[0] as string;
      const url = (token = "", id = m.id) => `${inject("pbUrl")}/api/chat/posters/${id}/${file}${token ? `?token=${token}` : ""}`;
      expect((await fetch(url())).status).toBe(404); // not made yet
      expect(m.file_dims).toEqual({}); // nor its shape, which is the poster's

      await tick();
      expect((await a.pb.collection("messages").getOne(m.id)).file_dims).toEqual({ [file]: [64, 48] });
      expect((await media(a, room.id)).items[0]).toMatchObject({ video: true, poster: true });
      const res = await fetch(url());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jpeg");
      expect(res.headers.get("cache-control")).toBe("private, max-age=2592000");
      const jpeg = new Uint8Array(await res.arrayBuffer());
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
      // In the video's own shape, for the room's tiles (§17.5), and never enlarged: the clip is 64×48.
      expect(jpegSize(jpeg)).toEqual({ width: 64, height: 48 });
      // A token is ignored.
      expect((await fetch(url(await b.pb.files.getToken()))).status).toBe(200);

      // A forward shows the poster from the start, and its readers get it under the original's id, as the file (§17.3).
      const dm = await b.pb.send<RecordModel>("/api/chat/dms", { method: "POST", body: { user: a.user.id } });
      await a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: dm.id } });
      expect((await media(b, dm.id)).items[0]).toMatchObject({ source: m.id, poster: true });
      const [fwd] = await b.pb.collection("messages").getFullList({ filter: `room = "${dm.id}"` });
      expect((await fetch(url("", fwd!.id))).status).toBe(200);

      // Deleted: the poster goes with the file.
      expect(stored(file, `thumbs_${file}/poster.jpg`)).toBe(true);
      await a.pb.collection("messages").update(m.id, { deleted: true });
      expect((await fetch(url())).status).toBe(404);
      expect((await fetch(url("", fwd!.id))).status).toBe(404);
      expect(rowOf(file)).toBe("");
    },
  );

  it.skipIf(!mp4 && !process.env.CI)(
    "serves a file the worker hasn't moved yet (§37.5) from where it is, its poster and thumbnails too, then moves it",
    async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const m = await send(a, room.id, [video("old.mp4"), png("old.png")]);
      const gone = await send(a, room.id, [png("lost.png")]);
      await tick();
      const [clip, pic] = m.files as [string, string];
      const lost = gone.files[0] as string;
      const storage = join(inject("pbDataDir"), "storage");
      const messagesId = (await admin.collections.getOne("messages")).id;
      const bytes = readFileSync(join(storage, filesId, rowOf(clip), clip));
      const thumbBytes = readFileSync(join(storage, filesId, rowOf(pic), `thumbs_${pic}`, `240x240_${pic}`)).byteLength;
      expect(thumbBytes).not.toBe(readFileSync(join(storage, filesId, rowOf(pic), pic)).byteLength);
      // As the migration leaves a file from before shared files: in its message's folder, its row saying so.
      const db = rawDb({ write: true });
      try {
        for (const file of [clip, pic]) {
          cpSync(join(storage, filesId, rowOf(file)), join(storage, messagesId, m.id), { recursive: true });
          rmSync(join(storage, filesId, rowOf(file)), { recursive: true });
          db.prepare("UPDATE files SET src = ? WHERE file = ?").run(`${messagesId}/${m.id}/${file}`, file);
        }
        // One that isn't there any more.
        rmSync(join(storage, filesId, rowOf(lost)), { recursive: true });
        db.prepare("UPDATE files SET src = ? WHERE file = ?").run(`${messagesId}/${gone.id}/${lost}`, lost);
      } finally {
        db.close();
      }
      const get = (path: string) => fetch(`${inject("pbUrl")}${path}`);
      const check = async () => {
        const res = await get(`/api/files/messages/${m.id}/${clip}`);
        expect(res.status).toBe(200);
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(bytes));
        const range = await fetch(`${inject("pbUrl")}/api/files/messages/${m.id}/${clip}`, { headers: { Range: "bytes=0-9" } });
        expect(range.status).toBe(206);
        expect((await range.arrayBuffer()).byteLength).toBe(10);
        const poster = await get(`/api/chat/posters/${m.id}/${clip}`);
        expect(poster.status).toBe(200);
        expect(poster.headers.get("content-type")).toBe("image/jpeg");
        const thumb = await get(`/api/files/messages/${m.id}/${pic}?thumb=240x240`);
        expect(thumb.status).toBe(200);
        // The thumbnail, not the image: the 240×240 crop of a 64×48 one is smaller than it.
        expect(thumb.headers.get("content-type")).toBe("image/png");
        expect((await thumb.arrayBuffer()).byteLength).toBe(thumbBytes);
        expect((await get(`/api/files/messages/${gone.id}/${lost}`)).status).toBe(404);
      };
      await check();
      expect(stored(clip, clip)).toBe(false);

      await tick();
      // Moved, with its poster and thumbnail; the message's old folder is gone.
      expect(stored(clip, clip)).toBe(true);
      expect(stored(clip, `thumbs_${clip}/poster.jpg`)).toBe(true);
      expect(stored(pic, `thumbs_${pic}/240x240_${pic}`)).toBe(true);
      expect(existsSync(join(storage, messagesId, m.id))).toBe(false);
      await check();
      const after = rawDb();
      try {
        expect(after.prepare("SELECT file, src, poster FROM files WHERE file IN (?, ?, ?) ORDER BY file").all(clip, pic, lost)).toEqual(
          [
            { file: clip, src: "", poster: 1 },
            { file: pic, src: "", poster: 0 },
            { file: lost, src: "", poster: 0 },
          ].sort((x, y) => (x.file < y.file ? -1 : 1)),
        );
      } finally {
        after.close();
      }
    },
  );

  it("records the shapes of files sent before messages kept them (§17.5), each file once", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("a.png"), pdf("a.pdf"), png("b.png")]);
    const [f0, , f2] = m.files as string[];
    expect(m.file_dims).toEqual({ [f0!]: [64, 48], [f2!]: [64, 48] });
    await tick();
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE messages SET file_dims = 'null' WHERE id = ?").run(m.id);
      db.prepare("UPDATE files SET sized = FALSE, dims = NULL WHERE file IN (?, ?, ?)").run(...(m.files as string[]));
    } finally {
      db.close();
    }
    const before = await a.pb.collection("messages").getOne(m.id);
    expect(before.file_dims).toBeNull();
    await tick();
    const after = await a.pb.collection("messages").getOne(m.id);
    expect(after.file_dims).toEqual({ [f0!]: [64, 48], [f2!]: [64, 48] });
    expect(after.updated).toBe(before.updated); // not a save: nothing else changes
    const check = rawDb();
    try {
      expect(check.prepare("SELECT sized FROM files WHERE file IN (?, ?, ?) ORDER BY file").all(...(m.files as string[]))).toEqual([
        { sized: 1 },
        { sized: 1 },
        { sized: 1 },
      ]);
      expect(check.prepare("SELECT dims FROM files WHERE file = ?").get(f0!)).toEqual({ dims: "[64,48]" });
    } finally {
      check.close();
    }
  });

  it("gives a file that isn't a video, or not the message's, no poster", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await send(a, room.id, [png("p.png")]);
    for (const path of [`${m.id}/${m.files[0]}`, `${m.id}/other_abcdefghij.mp4`, `nope/${m.files[0]}`]) {
      expect((await fetch(`${inject("pbUrl")}/api/chat/posters/${path}`)).status).toBe(404);
    }
  });
});

describe("migrations 1760000029_media.js and 1760000041_shared_files.js", () => {
  it("index the messages there are: media only, a forward's from its original, none of deleted ones", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "media-migration-"));
    let server = await startPocketBase({ dataDir });
    try {
      const pb = new PocketBase(server.url);
      pb.autoCancellation(false);
      const email = "mig@test.local";
      const su = new PocketBase(server.url);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await su.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name: "Mig" });
      const { record: me } = await pb.collection("users").authWithPassword(email, "password-123");
      const room = await pb.collection("rooms").create({ name: "mig-a", created_by: me.id });
      const other = await pb.collection("rooms").create({ name: "mig-b", created_by: me.id });
      const create = (r: string, files: File[]) => pb.collection("messages").create({ room: r, author: me.id, files });
      const a = await create(room.id, [png("a.png"), pdf("a.pdf"), video("a.mp4")]);
      const gone = await create(room.id, [png("gone.png")]);
      await pb.collection("messages").update(gone.id, { deleted: true });
      await pb.send("/api/chat/forward", { method: "POST", body: { messages: [a.id], room: other.id } });
      await server.stop();

      // Down past the media index, and up again: it is filled from the messages.
      migrate(dataDir, "down", "2");
      migrate(dataDir, "up");
      const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT room, message, source, file, pos, video, sent, length(id) AS n FROM media").all();
        const fwd = (db.prepare("SELECT id FROM messages WHERE forward_of = ?").get(a.id) as { id: string }).id;
        const row = (r: string, message: string, pos: number) => ({
          room: r,
          message,
          source: a.id,
          file: a.files[pos],
          pos,
          video: pos === 2 ? 1 : 0,
          n: 15,
        });
        expect(rows.map(({ sent, ...r }) => r)).toEqual(
          expect.arrayContaining([row(room.id, a.id, 0), row(room.id, a.id, 2), row(other.id, fwd, 0), row(other.id, fwd, 2)]),
        );
        expect(rows).toHaveLength(4);
        expect(rows.filter((r) => r.message === a.id).map((r) => r.sent)).toEqual([a.created, a.created]);
      } finally {
        db.close();
      }
      server = await startPocketBase({ dataDir });
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("move every file into `files` once: an item saved from a message file or an item names that file, its copy goes; the worker moves them after", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "files-migration-"));
    let server = await startPocketBase({ dataDir });
    try {
      const pb = new PocketBase(server.url);
      pb.autoCancellation(false);
      const email = "files-mig@test.local";
      const su = new PocketBase(server.url);
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await su.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name: "Mig" });
      const { record: me } = await pb.collection("users").authWithPassword(email, "password-123");
      const room = await pb.collection("rooms").create({ name: "files-mig", created_by: me.id });
      const a = await pb.collection("messages").create({ room: room.id, author: me.id, files: [png("a.png"), pdf("a.pdf")] });
      const c1 = await pb.collection("collections").create({ owner: me.id, name: "One" });
      const c2 = await pb.collection("collections").create({ owner: me.id, name: "Two" });
      const i1 = await pb.send<RecordModel>("/api/chat/items", {
        method: "POST",
        body: { collection: c1.id, message: a.id, file: a.files[0] },
      });
      const form = new FormData();
      form.append("collection", c1.id);
      form.append("file", png("up.png"));
      const i2 = await pb.send<RecordModel>("/api/chat/items", { method: "POST", body: form });
      const i3 = await pb.send<RecordModel>("/api/chat/items", { method: "POST", body: { collection: c2.id, item: i1.id } });
      await su.send("/api/media/tick", { method: "POST" });
      await server.stop();

      // Down: each message and item has its own copy in its own folder again, as before shared files.
      migrate(dataDir, "down", "2");
      const storage = join(dataDir, "storage");
      const ids = (() => {
        const db = new DatabaseSync(join(dataDir, "data.db"));
        try {
          const id = (name: string) => (db.prepare("SELECT id FROM _collections WHERE name = ?").get(name) as { id: string }).id;
          // As the copies were made before: where each came from.
          db.prepare("UPDATE collection_items SET origin = ? WHERE id = ?").run(`m:${a.id}/${a.files[0]}`, i1.id);
          db.prepare("UPDATE collection_items SET origin = '' WHERE id = ?").run(i2.id);
          db.prepare("UPDATE collection_items SET origin = ? WHERE id = ?").run(`i:${i1.id}`, i3.id);
          return { messages: id("messages"), items: id("collection_items") };
        } finally {
          db.close();
        }
      })();
      expect(existsSync(join(storage, ids.messages, a.id, a.files[0]))).toBe(true);
      expect(existsSync(join(storage, ids.items, i1.id, i1.file))).toBe(true);
      expect(existsSync(join(storage, ids.items, i3.id, i3.file))).toBe(true);

      migrate(dataDir, "up");
      const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
      let filesId = "";
      try {
        filesId = (db.prepare("SELECT id FROM _collections WHERE name = 'files'").get() as { id: string }).id;
        const refs = Object.fromEntries(
          (db.prepare("SELECT file, refs FROM files").all() as { file: string; refs: number }[]).map((r) => [r.file, r.refs]),
        );
        expect(refs).toEqual({ [a.files[0]]: 3, [a.files[1]]: 1, [i2.file]: 1 });
        const items = db.prepare("SELECT id, file FROM collection_items ORDER BY created, id").all() as { id: string; file: string }[];
        expect(Object.fromEntries(items.map((i) => [i.id, i.file]))).toEqual({
          [i1.id]: a.files[0],
          [i2.id]: i2.file,
          [i3.id]: a.files[0],
        });
        expect((db.prepare("SELECT files FROM messages WHERE id = ?").get(a.id) as { files: string }).files).toBe(JSON.stringify(a.files));
        // Nothing stored is touched (§37.5): each file is where it was, and the two item copies no longer named go later.
        const src = Object.fromEntries(
          (db.prepare("SELECT file, src FROM files").all() as { file: string; src: string }[]).map((r) => [r.file, r.src]),
        );
        expect(src).toEqual({
          [a.files[0]]: `${ids.messages}/${a.id}/${a.files[0]}`,
          [a.files[1]]: `${ids.messages}/${a.id}/${a.files[1]}`,
          [i2.file]: `${ids.items}/${i2.id}/${i2.file}`,
        });
        expect(
          db
            .prepare("SELECT prefix FROM storage_cleanup ORDER BY prefix")
            .all()
            .map((r) => (r as { prefix: string }).prefix),
        ).toEqual([`${ids.items}/${i1.id}`, `${ids.items}/${i3.id}`].sort());
      } finally {
        db.close();
      }

      server = await startPocketBase({ dataDir });
      pb.baseURL = server.url;
      su.baseURL = server.url;
      // Signed in again: starting it upserts the superuser.
      await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await pb.collection("users").authWithPassword(email, "password-123");
      const at = (path: string) => fetch(`${server.url}${path}`).then((r) => r.status);
      // Served from where they are, before the worker has moved anything: a thumbnail made before, a download.
      expect(existsSync(join(storage, filesId))).toBe(false);
      const thumb = await fetch(`${server.url}/api/files/messages/${a.id}/${a.files[0]}?thumb=240x240`);
      expect(thumb.status).toBe(200);
      expect((await thumb.arrayBuffer()).byteLength).toBe(
        readFileSync(join(storage, ids.messages, a.id, `thumbs_${a.files[0]}`, `240x240_${a.files[0]}`)).byteLength,
      );
      const pdfAt = await fetch(`${server.url}/api/files/messages/${a.id}/${a.files[1]}?download=1`);
      expect(pdfAt.status).toBe(200);
      expect(pdfAt.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(pdfAt.headers.get("content-security-policy")).toContain("sandbox");
      expect(await at(`/api/files/collection_items/${i3.id}/${a.files[0]}`)).toBe(200);
      expect(await at(`/api/files/collection_items/${i2.id}/${i2.file}`)).toBe(200);
      expect(await at(`/api/files/collection_items/${i2.id}/nope.png`)).toBe(404);
      // The message deleted before its files moved: its image stays for the items, its PDF goes from where it was.
      await pb.collection("messages").update(a.id, { deleted: true });
      expect(await at(`/api/files/messages/${a.id}/${a.files[0]}`)).toBe(404);
      expect(await at(`/api/files/collection_items/${i1.id}/${a.files[0]}`)).toBe(200);
      await su.send("/api/media/tick", { method: "POST" });
      // Moved: the old places are gone, the files' folders are there.
      expect(existsSync(join(storage, ids.messages, a.id))).toBe(false);
      expect(existsSync(join(storage, ids.items, i1.id))).toBe(false);
      expect(existsSync(join(storage, ids.items, i2.id))).toBe(false);
      expect(readdirSync(join(storage, filesId))).toHaveLength(2);
      expect(await at(`/api/files/collection_items/${i1.id}/${a.files[0]}?thumb=240x240`)).toBe(200);
      expect(await at(`/api/files/collection_items/${i2.id}/${i2.file}`)).toBe(200);
      const after = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
      try {
        expect(after.prepare("SELECT COUNT(*) AS n FROM files WHERE src != ''").get()).toEqual({ n: 0 });
        expect(after.prepare("SELECT COUNT(*) AS n FROM storage_cleanup").get()).toEqual({ n: 0 });
      } finally {
        after.close();
      }
    } finally {
      await server.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
