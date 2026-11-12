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
//   video. PocketBase otherwise makes a thumbnail on its first request: a grid opened over old images made dozens at
//   once. Each file once, as a `files` row (§37), whichever messages and collection items name it. Then it records
//   each video's shape (its poster's) on its row and in the `file_dims` of the messages that show it, and those of
//   files sent before there were any (§17.5): a new image's the upload already has. Between the two, it moves the files
//   the move to shared files (§37.5) left in the messages' and items' old folders to their own, and last, it deletes
//   what is left in the old places (`storage_cleanup`).
// - GET /api/chat/posters/{message}/{file}: a video's poster, for whoever has the video's URL (§37.3).

const { gridAuthor } = require(`${__hooks}/lib/anonymous.js`);
const { visibleRoom } = require(`${__hooks}/lib/access.js`);
const { HEADER_BYTES, shownSize } = require(`${__hooks}/lib/images.js`);
const { cleanupLater, ext, homeKeyOf, isMedia, isVideo, keyOf, posterKeyOf, thumbsDirOf } = require(`${__hooks}/lib/files.js`);

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
/** A file this recent is still being read in the room: all of its thumbnails are made, not just the grid's. */
const RECENT_MS = 7 * 86_400_000;

const LOCK = "media.worker";
const STALE_MS = 120_000;
const BATCH = 10;

/** The grid's page, and the most a request may ask for. */
const PAGE = 60;
const MAX_PAGE = 100;

// ---------------------------------------------------------------- the index

/**
 * A message just saved (created): its rows, in the save's transaction. A forward's are its original's files.
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
        `INSERT INTO media (id, room, message, source, file, pos, video, sent)
         VALUES ({:id}, {:room}, {:message}, {:source}, {:file}, {:pos}, {:video}, {:sent})`,
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
      `SELECT md.message, md.source, md.file, md.pos, md.video, COALESCE(f.poster, FALSE) AS poster, md.sent,
              COALESCE(s.file_names, '') AS names, m.author, COALESCE(u.name, '') AS name, m.anonymous
       FROM media md
       JOIN messages m ON m.id = md.message
       JOIN messages s ON s.id = md.source
       LEFT JOIN files f ON f.file = md.file
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

// GET /api/chat/posters/… (a video's poster, for whoever has the video's URL) is served in Go: server/files.go.

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
 * The thumbnails one file needs: the grid's, and for a recent file the room's too (§17.5); a video, its poster. Made
 * only if missing.
 * @param {core.App} app
 * @param {filesystem.System} fs
 * @param {core.Record} row a `files` row
 */
function thumbs(app, fs, row) {
  const file = row.getString("file");
  const key = keyOf(row);
  if (!fs.exists(key)) return; // deleted meanwhile
  if (isVideo(file)) {
    const target = posterKeyOf(row);
    if (fs.exists(target)) return markPoster(app, row);
    const bytes = posterOf(app, fs, key, file);
    if (!bytes) return;
    fs.uploadFile($filesystem.fileFromBytes(bytes, POSTER), target);
    // Deleted while ffmpeg ran: PocketBase has already removed its folder, and would leave this one behind.
    if (!fs.exists(key)) return fs.delete(target);
    markPoster(app, row);
    return;
  }
  if (!THUMB_EXT.includes(ext(file))) return;
  const all = /** @type {any} */ (row.collection().fields.getByName("file")).thumbs ?? [];
  const recent = Date.now() - new Date(row.getString("created").replace(" ", "T")).getTime() < RECENT_MS;
  // A GIF shows itself in the room (§17.5): only the grid shows its thumbnail.
  const sizes = recent && ext(file) !== "gif" ? all : all.filter((/** @type {string} */ s) => s === GRID_THUMB);
  for (const size of sizes) {
    const thumb = `${row.baseFilesPath()}/thumbs_${file}/${size}_${file}`;
    if (!fs.exists(thumb)) fs.createThumb(key, thumb, size);
  }
}

/**
 * A file's poster is there: its row says so, and the collection items naming it; their collections are saved again
 * (unchanged), so the room lists showing their tiles (GET /api/chat/collections' `preview`) hear of it live and ask
 * again, as they do when an item is added (QA BUG-207).
 * @param {core.App} app
 * @param {core.Record} row
 */
function markPoster(app, row) {
  const file = row.getString("file");
  app.db().newQuery("UPDATE files SET poster = TRUE WHERE id = {:id}").bind({ id: row.id }).execute();
  app.db().newQuery("UPDATE collection_items SET poster = TRUE WHERE file = {:file}").bind({ file }).execute();
  const ids = arrayOf(new DynamicModel({ collection: "" }));
  app.db().newQuery("SELECT DISTINCT collection FROM collection_items WHERE file = {:file}").bind({ file }).all(ids);
  for (const { collection } of ids) {
    try {
      app.save(app.findRecordById("collections", collection));
    } catch (err) {
      app.logger().warn("media: item poster", "collection", collection, "error", String(err));
    }
  }
}

/**
 * One pass: the newest files not done yet (a new upload goes before the old ones). After each file the worker rests
 * as long as it worked, so it never takes more than half of one CPU. `beat`, if given, is called after each one (the
 * worker renews its lock). Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function pass(app, beat, rest = true) {
  // A file not moved yet (src) once it is: its thumbnails are made in its own folder.
  const rows = app.findRecordsByFilter("files", "ready = false && src = ''", "-created", BATCH, 0);
  if (!rows.length) return movePass(app, beat, rest) || sizePass(app, beat, rest) || cleanupPass(app, beat);
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      if (!row) continue;
      const start = Date.now();
      try {
        thumbs(app, fs, row);
      } catch (err) {
        app.logger().warn("media: thumbnails", "file", row.getString("file"), "error", String(err));
      }
      // Tried once: a file that fails now would fail again.
      app.db().newQuery("UPDATE files SET ready = TRUE WHERE id = {:id}").bind({ id: row.id }).execute();
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * As pass, once the thumbnails are done: the shapes (§17.5) of videos, from their posters, and of files sent before
 * messages kept them. Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function sizePass(app, beat, rest = true) {
  const rows = app.findRecordsByFilter("files", "sized = false && src = ''", "-created", BATCH, 0);
  if (!rows.length) return 0;
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      if (!row) continue;
      const start = Date.now();
      const file = row.getString("file");
      try {
        const size = isMedia(file) ? shapeOf(fs, isVideo(file) ? posterKeyOf(row) : keyOf(row)) : null;
        if (size) setDims(app, row, size);
      } catch (err) {
        app.logger().warn("media: shape", "file", file, "error", String(err));
      }
      // Once: without a poster (no ffmpeg) or a readable header, the room shows it as before.
      app.db().newQuery("UPDATE files SET sized = TRUE WHERE id = {:id}").bind({ id: row.id }).execute();
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * Files the move to shared files (§37.5) left where they were (`src`): each copied to its own folder with what is
 * beside it (thumbnails, poster), then its row points there and the old place is left to cleanupPass. Until then it is
 * served from where it is (lib/files.js serve). Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 * @param {boolean} [rest]
 */
function movePass(app, beat, rest = true) {
  const rows = app.findRecordsByFilter("files", "src != ''", "created", BATCH, 0);
  if (!rows.length) return 0;
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      if (!row) continue;
      const start = Date.now();
      try {
        move(app, fs, row);
      } catch (err) {
        app.logger().warn("media: move", "file", row.getString("file"), "from", row.getString("src"), "error", String(err));
      }
      beat?.();
      if (rest) sleep(Math.min(2000, Date.now() - start));
    }
  } finally {
    fs.close();
  }
  return rows.length;
}

/**
 * One file's move (movePass). A file not there any more (gone before the move) is left as it is: its row keeps
 * pointing at nothing, as the message's did. A file renamed by the migration (a name two records had) gets new
 * thumbnails: those beside it carry the old name.
 * @param {core.App} app
 * @param {filesystem.System} fs
 * @param {core.Record} row
 */
function move(app, fs, row) {
  const src = row.getString("src");
  const home = homeKeyOf(row);
  const renamed = src.slice(src.lastIndexOf("/") + 1) !== row.getString("file");
  const there = fs.exists(src);
  if (there) {
    fs.copy(src, home);
    if (!renamed) {
      const from = thumbsDirOf(src);
      const to = thumbsDirOf(home);
      for (const obj of fs.list(from)) {
        if (obj && !obj.key.endsWith(".attrs")) fs.copy(obj.key, to + obj.key.slice(from.length));
      }
    }
  }
  let moved = false;
  app.runInTransaction((tx) => {
    let now;
    try {
      now = tx.findRecordById("files", row.id);
    } catch {
      return; // deleted meanwhile: unlink left its old place to cleanupPass
    }
    if (now.getString("src") !== src) return;
    tx.db()
      .newQuery("UPDATE files SET src = '', ready = ready AND {:keep}, poster = poster AND {:keep} WHERE id = {:id}")
      .bind({ id: row.id, keep: there && !renamed })
      .execute();
    if (there) cleanupLater(tx, src);
    moved = true;
  });
  // Deleted while it was copied: PocketBase removed its folder before the copy was there.
  if (!moved && there) fs.deletePrefix(`${home.slice(0, home.lastIndexOf("/"))}/`);
}

/**
 * What the move to shared files (§37) left in the old places of messages' and collection items' files: deleted a
 * few at a time, once the move is committed. A prefix is a record's folder, or a file (which goes with its
 * thumbnails). Returns how many it looked at.
 * @param {core.App} app
 * @param {() => void} [beat]
 */
function cleanupPass(app, beat) {
  const rows = arrayOf(new DynamicModel({ id: "", prefix: "" }));
  app.db().newQuery("SELECT id, prefix FROM storage_cleanup LIMIT {:n}").bind({ n: BATCH }).all(rows);
  if (!rows.length) return 0;
  const fs = app.newFilesystem();
  try {
    for (const row of rows) {
      // A folder of its own (collection/record), never a shorter one; or one file in one.
      if (/^[a-z0-9_]+\/[a-z0-9]+$/i.test(row.prefix)) {
        const errs = fs.deletePrefix(`${row.prefix}/`);
        for (const err of errs ?? []) if (err) app.logger().warn("media: cleanup", "prefix", row.prefix, "error", String(err));
      } else if (/^[a-z0-9_]+\/[a-z0-9]+\/[^/]+$/i.test(row.prefix)) {
        try {
          if (fs.exists(row.prefix)) fs.delete(row.prefix);
          const errs = fs.deletePrefix(thumbsDirOf(row.prefix));
          for (const err of errs ?? []) if (err) app.logger().warn("media: cleanup", "prefix", row.prefix, "error", String(err));
          // The record's old folder, once its last file has gone (an empty folder stays on a local disk).
          const dir = `${row.prefix.slice(0, row.prefix.lastIndexOf("/"))}/`;
          if (!fs.list(dir).length) fs.deletePrefix(dir);
        } catch (err) {
          app.logger().warn("media: cleanup", "prefix", row.prefix, "error", String(err));
        }
      }
      app.db().newQuery("DELETE FROM storage_cleanup WHERE id = {:id}").bind({ id: row.id }).execute();
      beat?.();
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
 * Record a file's shape on its row, and in the `file_dims` of every message that has it (the media index knows
 * them). Not a save: no hooks, no realtime event, `updated` unchanged (clients have it from the next load; until then
 * the tile takes its width once loaded, as before).
 * @param {core.App} app
 * @param {core.Record} row
 * @param {[number, number]} size
 */
function setDims(app, row, size) {
  const file = row.getString("file");
  app
    .db()
    .newQuery("UPDATE files SET dims = json_array({:w}, {:h}) WHERE id = {:id}")
    .bind({ id: row.id, w: size[0], h: size[1] })
    .execute();
  app
    .db()
    .newQuery(
      `UPDATE messages SET file_dims = json_set(
         CASE WHEN json_valid(file_dims) THEN (CASE WHEN json_type(file_dims) = 'object' THEN file_dims ELSE '{}' END) ELSE '{}' END,
         {:path}, json_array({:w}, {:h}))
       WHERE id IN (SELECT DISTINCT source FROM media WHERE file = {:file})`,
    )
    .bind({ file, path: `$."${file}"`, w: size[0], h: size[1] })
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
 * A message with files, or a collection item, was saved (committed): the worker looks at its files now.
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

module.exports = { add, drop, list, run, wake, tick };
