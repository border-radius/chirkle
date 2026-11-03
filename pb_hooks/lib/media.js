/// <reference path="../../types/pocketbase.d.ts" />
// The media grid's server side (DESIGN.md §30.1).
//
// - The index: the `media` collection, one row per image or video a room shows (pb_migrations/1760000029_media.js).
//   A new message adds its rows in the save's transaction (a forward, its original's files); a delete takes them out,
//   with those of the message's forwards. Deleted for good (a room, a superuser): the relations cascade.
// - GET /api/chat/media/{room}: a page of a room's rows, newest first, checked against the room once. The grid used to
//   page through the room's messages with the full list rule, expands and enrich hook, for a few tiles a page.
// - The worker (a cron job, like the previews'): makes each new file's thumbnails before anyone asks for them, and a
//   poster frame for each video with ffmpeg, so the room (§17.5) and the grid show an image instead of loading every
//   video. PocketBase
//   otherwise makes a thumbnail on its first request: a grid opened over old images made dozens at once. Then it
//   records each video's shape (its poster's) in the message's `file_dims`, and those of files sent before there
//   were any (§17.5): a new image's the create hook already set.
// - GET /api/chat/posters/{message}/{file}: a video's poster, checked as PocketBase checks the file itself.

const { gridAuthor } = require(`${__hooks}/lib/anonymous.js`);
const { visibleRoom } = require(`${__hooks}/lib/access.js`);
const { HEADER_BYTES, shownSize } = require(`${__hooks}/lib/images.js`);

/** As web/src/lib/files.ts says. */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv"];
/** The images PocketBase makes thumbnails of (avif it serves as it is). */
const THUMB_EXT = ["jpg", "jpeg", "png", "gif", "webp"];
/** The grid's tiles (§30.1). */
const GRID_THUMB = "240x240";
/** ffmpeg's demuxer for each video type: never left to guess, so a "video" that is a playlist reads no other file. */
/** @type {Record<string, string>} */
const DEMUXER = { mp4: "mov", m4v: "mov", mov: "mov", webm: "matroska", ogv: "ogg" };
/** The poster fits in this (never enlarged), in the video's own shape: the room's large tile (§17.5, as "800x480f"). The grid crops it to its square. */
const POSTER_FIT = { w: 800, h: 480 };
const POSTER = "poster.jpg";
/** ffmpeg is stopped after this long (s): a file that takes longer gets no poster. */
const FFMPEG_SECONDS = 20;
/** A message this recent is still being read in the room: all of its thumbnails are made, not just the grid's. */
const RECENT_MS = 7 * 86_400_000;

const LOCK = "media.worker";
const STALE_MS = 120_000;
const BATCH = 10;

/** The grid's page, and the most a request may ask for. */
const PAGE = 60;
const MAX_PAGE = 100;

/** @param {string} name */
const ext = (name) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
/** @param {string} name */
const isVideo = (name) => VIDEO_EXT.includes(ext(name));
/** @param {string} name */
const isMedia = (name) => IMAGE_EXT.includes(ext(name)) || isVideo(name);

/** The storage folder of a message's files. @param {core.App} app @param {string} id */
const dirOf = (app, id) => `${app.findCollectionByNameOrId("messages").id}/${id}`;
/** Where a video's poster is kept: with its thumbnails, which PocketBase deletes with the file. */
const posterKey = (/** @type {string} */ dir, /** @type {string} */ file) => `${dir}/thumbs_${file}/${POSTER}`;

// ---------------------------------------------------------------- the index

/**
 * A message just saved (created): its rows, in the save's transaction. A forward's are its original's files, already
 * done by the worker (the original's rows), poster and all.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function add(app, rec) {
  if (rec.getBool("deleted")) return;
  const forward = rec.getString("forward_of");
  let source = rec;
  if (forward) {
    try {
      source = app.findRecordById("messages", forward);
    } catch {
      return;
    }
    if (source.getBool("deleted")) return;
  }
  source.getStringSlice("files").forEach((file, pos) => {
    if (!isMedia(file)) return;
    app
      .db()
      .newQuery(
        `INSERT INTO media (id, room, message, source, file, pos, video, sent, ready, sized, poster)
         VALUES ({:id}, {:room}, {:message}, {:source}, {:file}, {:pos}, {:video}, {:sent}, {:ready}, {:sized},
                 COALESCE((SELECT poster FROM media WHERE message = {:source} AND file = {:file}), FALSE))`,
      )
      .bind({
        id: $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"),
        room: rec.getString("room"),
        message: rec.id,
        source: source.id,
        file,
        pos,
        video: isVideo(file),
        sent: rec.getString("created"),
        ready: !!forward,
        sized: !!forward || !isVideo(file), // an image's shape is the create hook's (§17.5)
      })
      .execute();
  });
}

/**
 * A message deleted (soft, §5.3): its rows go, and its forwards' (they show nothing now, §21.3).
 * @param {core.App} app
 * @param {string} id
 */
function drop(app, id) {
  app.db().newQuery("DELETE FROM media WHERE message = {:id} OR source = {:id}").bind({ id }).execute();
}

// ---------------------------------------------------------------- the grid's page

/**
 * GET /api/chat/media/{room}?sent=&message=&pos=&limit=: the room's images and videos older than the one given (or the
 * newest), newest first, a message's files last to first. 404 for a room you can't see.
 * @param {core.RequestEvent} e
 */
function list(e) {
  const room = e.request?.pathValue("room") ?? "";
  if (!visibleRoom(e.app, room, e.auth?.id ?? "")) throw new NotFoundError();
  const q = e.request?.url?.query();
  const sent = q?.get("sent") ?? "";
  const limit = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(q?.get("limit") ?? "", 10) || PAGE));
  const before = sent
    ? "AND (md.sent < {:sent} OR (md.sent = {:sent} AND (md.message < {:message} OR (md.message = {:message} AND md.pos < {:pos}))))"
    : "";
  const rows = arrayOf(
    new DynamicModel({
      message: "",
      source: "",
      file: "",
      pos: 0,
      video: false,
      poster: false,
      sent: "",
      names: "",
      author: "",
      name: "",
      anonymous: false,
    }),
  );
  e.app
    .db()
    .newQuery(
      `SELECT md.message, md.source, md.file, md.pos, md.video, md.poster, md.sent, COALESCE(s.file_names, '') AS names,
              m.author, COALESCE(u.name, '') AS name, m.anonymous
       FROM media md
       JOIN messages m ON m.id = md.message
       JOIN messages s ON s.id = md.source
       LEFT JOIN users u ON u.id = m.author
       WHERE md.room = {:room} ${before} AND m.deleted = FALSE AND s.deleted = FALSE
       ORDER BY md.sent DESC, md.message DESC, md.pos DESC
       LIMIT {:n}`,
    )
    .bind({ room, sent, message: q?.get("message") ?? "", pos: Number.parseInt(q?.get("pos") ?? "", 10) || 0, n: limit + 1 })
    .all(rows);
  const items = rows.slice(0, limit).map((r) => {
    /** @type {Record<string, string>} */
    let names = {};
    try {
      names = JSON.parse(r.names || "{}") ?? {};
    } catch {
      // older messages have none (QA BUG-28)
    }
    return {
      message: r.message,
      source: r.source,
      file: r.file,
      pos: r.pos,
      name: typeof names[r.file] === "string" ? names[r.file] : "",
      video: !!r.video,
      poster: !!r.poster,
      sent: r.sent,
      author: gridAuthor(e, { author: r.author, name: r.name, anonymous: !!r.anonymous, room }),
    };
  });
  return e.json(200, { items, more: rows.length > limit });
}

// ---------------------------------------------------------------- posters

/**
 * GET /api/chat/posters/{message}/{file}?token=: a video's poster frame, for whoever may see the video: the same file
 * token and the message's view rule, as PocketBase checks for the file itself (§17.3). 404 for anything else, and
 * until the worker has made it.
 * @param {core.RequestEvent} e
 */
function poster(e) {
  servePoster(e, "messages", "files", e.request?.pathValue("message") ?? "");
}

/**
 * GET /api/chat/posters/items/{item}/{file}?token=: a collection item's poster (§31), checked the same way against the
 * item's view rule.
 * @param {core.RequestEvent} e
 */
function itemPoster(e) {
  servePoster(e, "collection_items", "file", e.request?.pathValue("item") ?? "");
}

/**
 * The poster of the video `file` of record `id`, served as PocketBase serves the file (its view rule, the file token).
 * @param {core.RequestEvent} e
 * @param {string} collection
 * @param {string} field
 * @param {string} id
 */
function servePoster(e, collection, field, id) {
  const file = e.request?.pathValue("file") ?? "";
  let msg;
  try {
    msg = e.app.findRecordById(collection, id);
  } catch {
    throw new NotFoundError();
  }
  if (!isVideo(file) || !msg.getStringSlice(field).includes(file)) throw new NotFoundError();
  const info = e.requestInfo();
  const token = e.request?.url?.query().get("token") ?? "";
  /** @type {core.Record | null} */
  let auth = null;
  if (token) {
    try {
      auth = e.app.findAuthRecordByToken(token, "file");
    } catch {
      auth = null;
    }
  }
  /** @type {any} */ (info).auth = auth;
  if (!e.app.canAccessRecord(msg, info, msg.collection().viewRule ?? "")) throw new NotFoundError();
  const fs = e.app.newFilesystem();
  try {
    const key = posterKey(`${msg.collection().id}/${id}`, file);
    if (!fs.exists(key)) throw new NotFoundError();
    // Never changes under one name: a new upload gets a new file name.
    e.response.header().set("Cache-Control", "private, max-age=2592000");
    fs.serve(e.response, /** @type {any} */ (e.request), key, POSTER);
  } finally {
    fs.close();
  }
}

// ---------------------------------------------------------------- the worker

/** The ffmpeg command ("ffmpeg", or FFMPEG), "" when there is none (FFMPEG=off, not installed). Looked up once. */
function ffmpeg(/** @type {core.App} */ app) {
  return /** @type {string} */ (
    app.store().getOrSet("media.ffmpeg", () => {
      const bin = $os.getenv("FFMPEG").trim() || "ffmpeg";
      if (bin.toLowerCase() === "off") return "";
      try {
        $os.cmd("timeout", "10", bin, "-hide_banner", "-loglevel", "error", "-version").output();
        return bin;
      } catch {
        app.logger().warn("media: no ffmpeg, videos get no poster", "command", bin);
        return "";
      }
    })
  );
}

/**
 * A copy of a stored file in the temp folder, for ffmpeg: files kept in S3 have no path of their own. Copied by Go
 * (`readFrom`), so the video never passes through JS. Returns its path; the caller removes it.
 * @param {filesystem.System} fs
 * @param {string} key
 * @param {string} file
 */
function tempCopy(fs, key, file) {
  const dir = $os.tempDir();
  const name = `chirkle-poster-${$security.randomString(16)}.${ext(file)}`;
  const root = $os.openRoot(dir);
  try {
    const out = root.create(name);
    try {
      const reader = fs.getReader(key);
      try {
        out.readFrom(reader);
      } finally {
        reader.close();
      }
    } catch (err) {
      out.close();
      root.remove(name);
      throw err;
    }
    out.close();
  } finally {
    root.close();
  }
  return `${dir}/${name}`;
}

/**
 * A poster for a stored video, or null when it can't have one (no ffmpeg, ffmpeg failed). A video kept in S3 is
 * downloaded to the temp folder first, and removed after.
 * @param {core.App} app
 * @param {filesystem.System} fs
 * @param {string} key
 * @param {string} file
 */
function posterOf(app, fs, key, file) {
  const bin = ffmpeg(app);
  if (!bin) return null;
  const s3 = app.settings().s3.enabled;
  const path = s3 ? tempCopy(fs, key, file) : `${app.dataDir()}/storage/${key}`;
  try {
    return frame(bin, path, file);
  } finally {
    if (s3) $os.remove(path);
  }
}

/**
 * The first frame of the video at `path` (a local file), fitted in POSTER_FIT, as JPEG; null if ffmpeg gave nothing.
 * @param {string} bin
 * @param {string} path
 * @param {string} file
 */
function frame(bin, path, file) {
  const { w, h } = POSTER_FIT;
  // Its first frame, fitted, as JPEG on stdout. Only the local file: no protocols but `file`, no
  // external references (the mov demuxer's drefs are off by default), the container's own demuxer, one thread.
  const out = $os
    .cmd(
      "timeout",
      String(FFMPEG_SECONDS),
      bin,
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-threads",
      "1",
      "-protocol_whitelist",
      "file",
      "-f",
      DEMUXER[ext(file)] ?? "mov",
      "-i",
      `file:${path}`,
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-vf",
      `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease`,
      "-q:v",
      "5",
      "-f",
      "image2",
      "-c:v",
      "mjpeg",
      "pipe:1",
    )
    .output();
  return out?.length ? out : null;
}

/**
 * The thumbnails one file needs: the grid's, and for a recent message the room's too (§17.5). Made only if missing.
 * @param {core.App} app
 * @param {filesystem.System} fs
 * @param {{ source: string, file: string, sent: string }} row
 */
function thumbs(app, fs, row) {
  const dir = dirOf(app, row.source);
  const key = `${dir}/${row.file}`;
  if (!fs.exists(key)) return; // deleted meanwhile
  if (isVideo(row.file)) {
    const target = posterKey(dir, row.file);
    if (fs.exists(target)) return markPoster(app, row);
    const bytes = posterOf(app, fs, key, row.file);
    if (!bytes) return;
    fs.uploadFile($filesystem.fileFromBytes(bytes, POSTER), target);
    // Deleted while ffmpeg ran: PocketBase has already removed its folder, and would leave this one behind.
    if (!fs.exists(key)) return fs.delete(target);
    markPoster(app, row);
    return;
  }
  if (!THUMB_EXT.includes(ext(row.file))) return;
  const all = /** @type {any} */ (app.findCollectionByNameOrId("messages").fields.getByName("files")).thumbs ?? [];
  const recent = Date.now() - new Date(row.sent.replace(" ", "T")).getTime() < RECENT_MS;
  // A GIF shows itself in the room (§17.5): only the grid shows its thumbnail.
  const sizes = recent && ext(row.file) !== "gif" ? all : all.filter((/** @type {string} */ s) => s === GRID_THUMB);
  for (const size of sizes) {
    const thumb = `${dir}/thumbs_${row.file}/${size}_${row.file}`;
    if (!fs.exists(thumb)) fs.createThumb(key, thumb, size);
  }
}

/** The file's poster is there: its rows say so, its forwards' too. */
function markPoster(/** @type {core.App} */ app, /** @type {{ source: string, file: string }} */ row) {
  app.db().newQuery("UPDATE media SET poster = TRUE WHERE source = {:source} AND file = {:file}").bind(row).execute();
}

/**
 * One pass: the newest files not done yet (a new upload goes before the old ones the migration found). After each
 * file the worker rests as long as it worked, so it never takes more than half of one CPU. `beat`, if given, is called
 * after each one (the worker renews its lock). Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function pass(app, beat, rest = true) {
  const rows = arrayOf(new DynamicModel({ id: "", source: "", file: "", sent: "" }));
  app
    .db()
    .newQuery("SELECT id, source, file, sent FROM media WHERE ready = FALSE ORDER BY sent DESC LIMIT {:n}")
    .bind({ n: BATCH })
    .all(rows);
  if (!rows.length) return itemPass(app, beat, rest) || sizePass(app, beat, rest);
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      const start = Date.now();
      try {
        thumbs(app, fs, /** @type {any} */ (row));
      } catch (err) {
        app.logger().warn("media: thumbnails", "message", row.source, "file", row.file, "error", String(err));
      }
      // Tried once: a file that fails now would fail again.
      app.db().newQuery("UPDATE media SET ready = TRUE WHERE id = {:id}").bind({ id: row.id }).execute();
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * As pass, for collection items (§31) once the messages are done: the grid's thumbnail, or a video's poster.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function itemPass(app, beat, rest = true) {
  const rows = arrayOf(new DynamicModel({ id: "", file: "" }));
  app
    .db()
    .newQuery("SELECT id, file FROM collection_items WHERE ready = FALSE ORDER BY created DESC LIMIT {:n}")
    .bind({ n: BATCH })
    .all(rows);
  if (!rows.length) return 0;
  const dir = `${app.findCollectionByNameOrId("collection_items").id}`;
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      const start = Date.now();
      try {
        itemThumbs(app, fs, `${dir}/${row.id}`, row.id, row.file);
      } catch (err) {
        app.logger().warn("media: item thumbnails", "item", row.id, "file", row.file, "error", String(err));
      }
      app.db().newQuery("UPDATE collection_items SET ready = TRUE WHERE id = {:id}").bind({ id: row.id }).execute();
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * An item's grid thumbnail, or its video's poster (unless it came along from the file it was saved from).
 * @param {core.App} app
 * @param {filesystem.System} fs
 * @param {string} dir
 * @param {string} id
 * @param {string} file
 */
function itemThumbs(app, fs, dir, id, file) {
  const key = `${dir}/${file}`;
  if (!fs.exists(key)) return;
  const mark = () => {
    app.db().newQuery("UPDATE collection_items SET poster = TRUE WHERE id = {:id}").bind({ id }).execute();
    posterReady(app, id);
  };
  if (isVideo(file)) {
    const target = posterKey(dir, file);
    if (fs.exists(target)) return mark();
    const bytes = posterOf(app, fs, key, file);
    if (!bytes) return;
    fs.uploadFile($filesystem.fileFromBytes(bytes, POSTER), target);
    if (!fs.exists(key)) return fs.delete(target);
    mark();
    return;
  }
  if (!THUMB_EXT.includes(ext(file))) return;
  const thumb = `${dir}/thumbs_${file}/${GRID_THUMB}_${file}`;
  if (!fs.exists(thumb)) fs.createThumb(key, thumb, GRID_THUMB);
}

/**
 * A collection item's poster is ready: its collection is saved again (unchanged), so the room lists showing its tile
 * (GET /api/chat/collections' `preview`) hear of it live and ask again, as they do when an item is added (QA BUG-207).
 * @param {core.App} app
 * @param {string} id the item's
 */
function posterReady(app, id) {
  try {
    const item = app.findRecordById("collection_items", id);
    app.save(app.findRecordById("collections", item.getString("collection")));
  } catch (err) {
    app.logger().warn("media: item poster", "item", id, "error", String(err));
  }
}

/**
 * As pass, once the thumbnails are done: the shapes (§17.5) of videos, from their posters, and of files sent before
 * messages kept them. Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function sizePass(app, beat, rest = true) {
  const rows = arrayOf(new DynamicModel({ source: "", file: "", video: false }));
  app.db().newQuery("SELECT source, file, video FROM media WHERE sized = FALSE ORDER BY sent DESC LIMIT {:n}").bind({ n: BATCH }).all(rows);
  if (!rows.length) return 0;
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      const start = Date.now();
      try {
        const dir = dirOf(app, row.source);
        const size = shapeOf(fs, row.video ? posterKey(dir, row.file) : `${dir}/${row.file}`);
        if (size) setDims(app, row.source, row.file, size);
      } catch (err) {
        app.logger().warn("media: shape", "message", row.source, "file", row.file, "error", String(err));
      }
      // Once: without a poster (no ffmpeg) or a readable header, the room shows it as before.
      app.db().newQuery("UPDATE media SET sized = TRUE WHERE source = {:source} AND file = {:file}").bind(row).execute();
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * The shape the stored image at `key` is shown in, from its header; null if it isn't there or isn't readable.
 * @param {filesystem.System} fs
 * @param {string} key
 */
function shapeOf(fs, key) {
  if (!fs.exists(key)) return null;
  const reader = fs.getReader(key);
  try {
    return shownSize(toBytes(reader, HEADER_BYTES));
  } finally {
    reader.close();
  }
}

/**
 * Record a file's shape in its message's `file_dims`. Not a save: no hooks, no realtime event, `updated` unchanged
 * (clients have it from the next load; until then the tile takes its width once loaded, as before).
 * @param {core.App} app
 * @param {string} id
 * @param {string} file
 * @param {[number, number]} size
 */
function setDims(app, id, file, size) {
  app
    .db()
    .newQuery(
      `UPDATE messages SET file_dims = json_set(
         CASE WHEN json_valid(file_dims) THEN (CASE WHEN json_type(file_dims) = 'object' THEN file_dims ELSE '{}' END) ELSE '{}' END,
         {:path}, json_array({:w}, {:h}))
       WHERE id = {:id}`,
    )
    .bind({ id, path: `$."${file}"`, w: size[0], h: size[1] })
    .execute();
}

/**
 * The cron job: passes until the minute is nearly over; with nothing to do, when a save wakes it (wake). One run at a
 * time.
 * @param {core.App} app
 */
function run(app) {
  require(`${__hooks}/lib/worker.js`).run(app, {
    name: LOCK,
    label: "media",
    staleMs: STALE_MS,
    wakes: true,
    pass: (/** @type {() => void} */ renew) => pass(app, renew),
  });
}

/**
 * A message with files, or a collection item, was saved (committed): the worker looks at it now.
 * @param {core.App} app
 */
function wake(app) {
  require(`${__hooks}/lib/worker.js`).wake(app, LOCK);
}

/**
 * POST /api/media/tick (superusers): every file not done yet, now (tests).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  while (pass(e.app, undefined, false) > 0);
  return e.noContent(204);
}

module.exports = { add, drop, list, poster, itemPoster, run, wake, tick, isMedia, isVideo, tempCopy, posterKey, posterReady };
