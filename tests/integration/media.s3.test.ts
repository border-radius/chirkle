// The media worker with files kept in S3 (§30.1): a video is copied to the temp folder for ffmpeg, its poster stored
// in the bucket next to it, and the copy removed. Collections (§31) name the same stored file (§37): nothing is copied.
// Its own PocketBase, on an S3 server (versitygw, tests/support/s3.ts).
// Skipped without versitygw or ffmpeg, except in CI, which installs both.

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pngOf } from "../support/images.ts";
import { disableRateLimits, migrate, migrateDownPast, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { hasS3Server, type S3Server, startS3 } from "../support/s3.ts";
import { makeMp4 } from "../support/video.ts";

const mp4 = makeMp4();
const run = !!process.env.CI || (!!mp4 && hasS3Server());

describe.skipIf(!run)("media worker, files in S3 (§30.1)", () => {
  let s3: S3Server;
  let server: PocketBaseServer;
  let su: PocketBase;
  let pb: PocketBase;
  let me = "";
  let messagesId = "";
  let filesId = "";
  /** The PocketBase process's temp folder (TMPDIR), where the video copies go. */
  const temp = mkdtempSync(join(tmpdir(), "chirkle-pb-tmp-"));

  beforeAll(async () => {
    s3 = await startS3();
    server = await startPocketBase({ env: { TMPDIR: temp } });
    await disableRateLimits(server.url);
    su = new PocketBase(server.url);
    su.autoCancellation(false);
    await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    await su.settings.update({
      s3: {
        enabled: true,
        bucket: s3.bucket,
        region: "us-east-1",
        endpoint: s3.endpoint,
        accessKey: s3.accessKey,
        secret: s3.secret,
        forcePathStyle: true,
      },
    });
    messagesId = (await su.collections.getOne("messages")).id;
    filesId = (await su.collections.getOne("files")).id;
    await su.collection("users").create({ email: "s3@test.local", password: "password-123", passwordConfirm: "password-123", name: "S3" });
    pb = new PocketBase(server.url);
    pb.autoCancellation(false);
    me = (await pb.collection("users").authWithPassword("s3@test.local", "password-123")).record.id;
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await s3?.stop();
    rmSync(temp, { recursive: true, force: true });
  });

  /** The `files` row (§37) a stored name is kept under. */
  const rowOf = async (name: string) => (await su.collection("files").getFirstListItem(su.filter("file = {:name}", { name }))).id;
  /** Is this path in the bucket, in the folder of stored name `name`'s row? */
  const inBucket = async (name: string, path = name) => existsSync(join(s3.dir, filesId, await rowOf(name), path));

  it("makes a video's poster from a temp copy, keeps it in the bucket, and leaves no copy behind", async () => {
    const room = await pb.collection("rooms").create({ name: "s3-room", created_by: me });
    const m = await pb.collection("messages").create({
      room: room.id,
      author: me,
      files: [
        new File([new Uint8Array(mp4 ?? [0])], "clip.mp4", { type: "video/mp4" }),
        new File([new Uint8Array(pngOf(64, 48))], "pic.png"),
      ],
    });
    const [clip, pic] = m.files as [string, string];
    const clipRow = await rowOf(clip);
    expect(await inBucket(clip)).toBe(true); // really in S3, not in pb_data/storage
    expect(existsSync(join(server.dataDir, "storage", filesId, clipRow))).toBe(false);
    expect(existsSync(join(s3.dir, messagesId, m.id))).toBe(false);

    await su.send("/api/media/tick", { method: "POST" });
    expect(await inBucket(clip, `thumbs_${clip}/poster.jpg`)).toBe(true);
    expect(await inBucket(pic, `thumbs_${pic}/240x240_${pic}`)).toBe(true);
    expect(readdirSync(temp).filter((f) => f.startsWith("chirkle-poster-"))).toEqual([]);
    // The video's shape is read from its poster in the bucket (§17.5).
    expect((await pb.collection("messages").getOne(m.id)).file_dims).toEqual({ [clip]: [64, 48], [pic]: [64, 48] });

    const { items } = await pb.send<{ items: { file: string; poster: boolean }[] }>(`/api/chat/media/${room.id}`, {});
    expect(items.find((i) => i.file === clip)?.poster).toBe(true);
    const res = await fetch(`${server.url}/api/chat/posters/${m.id}/${clip}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const jpeg = new Uint8Array(await res.arrayBuffer());
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);

    // Deleted: named by nothing, the file goes, and PocketBase removes its folder from the bucket, the poster with it
    // (in the background, once the delete is committed).
    await pb.collection("messages").update(m.id, { deleted: true });
    await expect(su.collection("files").getOne(clipRow)).rejects.toMatchObject({ status: 404 });
    const left = () => {
      const dir = join(s3.dir, filesId, clipRow);
      return existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((p) => String(p).includes(".")) : [];
    };
    await expect.poll(left, { timeout: 10_000 }).toEqual([]);
  });

  it("saves a video to a collection, poster and all, attaches it back, and leaves no copy behind (§31)", async () => {
    const room = await pb.collection("rooms").create({ name: "s3-collections", created_by: me });
    const m = await pb.collection("messages").create({
      room: room.id,
      author: me,
      files: [new File([new Uint8Array(mp4 ?? [0])], "clip.mp4", { type: "video/mp4" })],
    });
    await su.send("/api/media/tick", { method: "POST" });
    const coll = await pb.collection("collections").create({ owner: me, name: "s3" });
    const item = await pb.send<{ id: string; file: string; poster: boolean }>("/api/chat/items", {
      method: "POST",
      body: { collection: coll.id, message: m.id, file: m.files[0] },
    });
    expect(item.poster).toBe(true);
    // The message's own file, not a copy.
    expect(item.file).toBe(m.files[0]);
    const itemsId = (await su.collections.getOne("collection_items")).id;
    expect(existsSync(join(s3.dir, itemsId))).toBe(false);

    const sent = await pb.collection("messages").create({ room: room.id, author: me, items: JSON.stringify([item.id]) });
    expect(sent.files[0]).toBe(m.files[0]);
    expect(await inBucket(sent.files[0])).toBe(true);
    const poster = await fetch(`${server.url}/api/chat/posters/${sent.id}/${sent.files[0]}`);
    expect(poster.status).toBe(200);
    expect(sent.file_names[sent.files[0]]).toBe("clip.mp4");
    expect(readdirSync(temp).filter((f) => f.startsWith("chirkle-poster-"))).toEqual([]);
  });

  it("the shared files migration (§37) touches nothing in the bucket; the worker moves the files and cleans up after (§37.5)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "files-migration-s3-"));
    let own = await startPocketBase({ dataDir, env: { TMPDIR: temp } });
    try {
      await disableRateLimits(own.url);
      const admin = new PocketBase(own.url);
      admin.autoCancellation(false);
      await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      await admin.settings.update({
        s3: {
          enabled: true,
          bucket: s3.bucket,
          region: "us-east-1",
          endpoint: s3.endpoint,
          accessKey: s3.accessKey,
          secret: s3.secret,
          forcePathStyle: true,
        },
      });
      const email = "s3-mig@test.local";
      await admin.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name: "Mig" });
      const user = new PocketBase(own.url);
      user.autoCancellation(false);
      const { record: u } = await user.collection("users").authWithPassword(email, "password-123");
      const room = await user.collection("rooms").create({ name: "s3-mig", created_by: u.id });
      const m = await user
        .collection("messages")
        .create({ room: room.id, author: u.id, files: [new File([new Uint8Array(pngOf(32, 24))], "pic.png")] });
      const coll = await user.collection("collections").create({ owner: u.id, name: "mig" });
      const item = await user.send<RecordModel>("/api/chat/items", {
        method: "POST",
        body: { collection: coll.id, message: m.id, file: m.files[0] },
      });
      await admin.send("/api/media/tick", { method: "POST" });
      await own.stop();

      migrateDownPast(dataDir, "1760000041_shared_files.js");
      const ids = (() => {
        const db = new DatabaseSync(join(dataDir, "data.db"));
        try {
          const id = (name: string) => (db.prepare("SELECT id FROM _collections WHERE name = ?").get(name) as { id: string }).id;
          db.prepare("UPDATE collection_items SET origin = ? WHERE id = ?").run(`m:${m.id}/${m.files[0]}`, item.id);
          return { messages: id("messages"), items: id("collection_items") };
        } finally {
          db.close();
        }
      })();
      // Before shared files: the message's own copy and the item's, both in the bucket.
      expect(existsSync(join(s3.dir, ids.messages, m.id, m.files[0]))).toBe(true);
      expect(existsSync(join(s3.dir, ids.items, item.id, item.file))).toBe(true);

      migrate(dataDir, "up");
      const db = new DatabaseSync(join(dataDir, "data.db"), { readOnly: true });
      let row: { id: string; refs: number; collectionId: string };
      try {
        const filesId = (db.prepare("SELECT id FROM _collections WHERE name = 'files'").get() as { id: string }).id;
        const r = db.prepare("SELECT id, refs FROM files WHERE file = ?").get(m.files[0]) as { id: string; refs: number };
        row = { ...r, collectionId: filesId };
      } finally {
        db.close();
      }
      expect(row.refs).toBe(2);
      expect(existsSync(join(s3.dir, row.collectionId, row.id))).toBe(false);
      expect(existsSync(join(s3.dir, ids.items, item.id, item.file))).toBe(true);

      own = await startPocketBase({ dataDir, env: { TMPDIR: temp } });
      admin.baseURL = own.url;
      await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const at = (path: string) => fetch(`${own.url}${path}`).then((r) => r.status);
      // Served from the message's old folder until it is moved.
      expect(await at(`/api/files/messages/${m.id}/${m.files[0]}?thumb=240x240`)).toBe(200);
      expect(await at(`/api/files/collection_items/${item.id}/${m.files[0]}`)).toBe(200);
      await admin.send("/api/media/tick", { method: "POST" });
      // Moved, with its thumbnails; the old folders are gone from the bucket.
      expect(existsSync(join(s3.dir, row.collectionId, row.id, m.files[0]))).toBe(true);
      expect(existsSync(join(s3.dir, row.collectionId, row.id, `thumbs_${m.files[0]}/240x240_${m.files[0]}`))).toBe(true);
      expect(existsSync(join(s3.dir, ids.messages, m.id))).toBe(false);
      expect(existsSync(join(s3.dir, ids.items, item.id))).toBe(false);
      expect(await at(`/api/files/messages/${m.id}/${m.files[0]}?thumb=240x240`)).toBe(200);
      expect(await at(`/api/files/collection_items/${item.id}/${m.files[0]}`)).toBe(200);
    } finally {
      await own.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
