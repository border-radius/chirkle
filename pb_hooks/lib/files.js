/// <reference path="../../types/pocketbase.d.ts" />
// Shared files (DESIGN.md §37): every attachment and collection item's file is stored once, as a row of `files`
// (pb_migrations/1760000041_shared_files.js), and messages and collection items name it. Saving to a collection or
// attaching from one adds a name, never a copy.
//
// - A message's `files` and an item's `file` hold stored names, as they did when they were file fields, so clients
//   build the same URLs: /api/files/messages/{message}/{name} and /api/files/collection_items/{item}/{name}. serve()
//   (routes of their own, by collection name) answers those with the shared file, as PocketBase's handler would,
//   checking only that the message or item still has it. No file token: whoever has the URL has the file (§37.3).
// - `refs` counts the messages and items that name a file. link() and unlink() keep it in the same save; a file named
//   by nothing is deleted, and PocketBase deletes what is stored once that is committed.
// - The media worker (lib/media.js) makes each file's thumbnails and video poster once, whoever names it.
// - A file from before shared files may not be in its row's folder yet: `src` is where it still is (a message's or an
//   item's old folder), the migration having left the moves to the worker (DESIGN.md §37.5). keyOf and posterKeyOf say
//   where a file is now, and serve() serves such a file from there.

const { fieldError } = require(`${__hooks}/lib/records.js`);
const { clipFileName, tidy, unescapeUploadName } = require(`${__hooks}/lib/text.js`);

/** As messages' limits (§17.1): files a message, and bytes a file. */
const MAX_FILES = 10;
const MAX_SIZE = 20 * 1024 * 1024;

/** As web/src/lib/files.ts says. */
const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif"];
const VIDEO_EXT = ["mp4", "m4v", "webm", "mov", "ogv"];

/** @param {string} name */
const ext = (name) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
/** @param {string} name */
const isVideo = (name) => VIDEO_EXT.includes(ext(name));
/** @param {string} name */
const isImage = (name) => IMAGE_EXT.includes(ext(name));
/** @param {string} name */
const isMedia = (name) => isImage(name) || isVideo(name);

/** A file's own folder in storage, and where its file, thumbnails and video poster go there. @param {core.Record} row */
const dirOf = (row) => row.baseFilesPath();
/** @param {core.Record} row */
const homeKeyOf = (row) => `${dirOf(row)}/${row.getString("file")}`;
/** Where a file is now: its old place until the worker has moved it (`src`), then its own folder. @param {core.Record} row */
const keyOf = (row) => row.getString("src") || homeKeyOf(row);
/** The folder beside a stored file that has its thumbnails and poster. @param {string} key */
const thumbsDirOf = (key) => {
  const slash = key.lastIndexOf("/");
  return `${key.slice(0, slash)}/thumbs_${key.slice(slash + 1)}/`;
};
/** Where a stored file's thumbnail `size` (or "poster.jpg") is. @param {string} key @param {string} size */
const thumbKeyOf = (key, size) => `${thumbsDirOf(key)}${size === "poster.jpg" ? size : `${size}_${key.slice(key.lastIndexOf("/") + 1)}`}`;
/** @param {core.Record} row */
const posterKeyOf = (row) => thumbKeyOf(keyOf(row), "poster.jpg");

/**
 * The `files` row of a stored name, or null.
 * @param {core.App} app
 * @param {string} name
 */
function byName(app, name) {
  if (!name) return null;
  try {
    return app.findFirstRecordByFilter("files", "file = {:name}", { name });
  } catch {
    return null;
  }
}

/**
 * The `files` rows of these stored names, by name (those that exist).
 * @param {core.App} app
 * @param {string[]} names
 * @returns {Map<string, core.Record>}
 */
function byNames(app, names) {
  /** @type {Map<string, core.Record>} */
  const out = new Map();
  if (!names.length) return out;
  const rows = app.findAllRecords("files", $dbx.in("file", ...names));
  for (const row of rows) if (row) out.set(row.getString("file"), row);
  return out;
}

/**
 * New `files` rows for uploads, named by nothing yet (link them in the same transaction). Each upload's original name
 * is cleaned like a display name (QA BUG-28, BUG-35), its size held to the field's limit, and an image's to what its
 * thumbnails can decode (QA BUG-24, BUG-140), with its shape kept (§17.5). Errors name `field`, as the clients know.
 * @param {core.App} app
 * @param {filesystem.File[]} uploads
 * @param {string} [field]
 * @returns {core.Record[]}
 */
function fromUploads(app, uploads, field = "files") {
  const { assertImagesFit } = require(`${__hooks}/lib/images.js`);
  const collection = app.findCollectionByNameOrId("files");
  /** @type {core.Record[]} */
  const saved = [];
  try {
    for (const upload of uploads) saved.push(fromUpload(app, collection, upload, field, assertImagesFit));
  } catch (err) {
    // Outside a transaction (a message's create request, lib/messages.js prepareCreate): the ones already stored go.
    discard(app, saved);
    throw err;
  }
  return saved;
}

/**
 * fromUploads' one row.
 * @param {core.App} app
 * @param {core.Collection} collection
 * @param {filesystem.File} upload
 * @param {string} field
 * @param {(row: core.Record, key: string, field: string) => Record<string, unknown>} assertImagesFit
 */
function fromUpload(app, collection, upload, field, assertImagesFit) {
  const original = clipFileName(tidy(unescapeUploadName(upload.originalName)));
  upload.originalName = original || upload.name;
  const row = new Record(collection);
  row.set("file", upload);
  const name = upload.name;
  row.set("name", (original || name).slice(0, 200));
  row.set("video", isVideo(name));
  row.set("refs", 0);
  if (upload.size > MAX_SIZE) {
    throw fieldError(field, `Files can be at most ${MAX_SIZE / 1024 / 1024} MB.`, "validation_file_size_limit");
  }
  const dims = assertImagesFit(row, "file", field);
  if (dims[name]) row.set("dims", dims[name]);
  // The worker makes thumbnails of images and a video's poster; its shape it reads once the poster is there.
  row.set("ready", !isMedia(name));
  row.set("sized", !isVideo(name) && (!isImage(name) || !!dims[name]));
  app.save(row);
  return row;
}

/**
 * Drop new `files` rows nothing came to name (a message's create that failed after its uploads were stored), with
 * what is stored. Best effort: a row left behind is named by nothing, as rows of failed uploads were before.
 * @param {core.App} app
 * @param {core.Record[]} rows
 */
function discard(app, rows) {
  for (const row of rows) {
    try {
      app.delete(row);
    } catch (err) {
      app.logger().warn("files: an unused upload wasn't deleted", "id", row.id, "error", String(err));
    }
  }
}

/**
 * These rows are named once more (a message or item saved with them, in the same transaction).
 * @param {core.App} app
 * @param {string[]} ids
 */
function link(app, ids) {
  if (!ids.length) return;
  const res = app
    .db()
    .newQuery("UPDATE files SET refs = refs + 1 WHERE id IN (SELECT value FROM json_each({:ids}))")
    .bind({ ids: JSON.stringify(ids) })
    .execute();
  // Looked up before the transaction (a create request's collection items, lib/messages.js prepareCreate): one may
  // have gone since.
  if (Number(res.rowsAffected()) !== ids.length) throw fieldError("items", "A collection item is no longer available.");
}

/**
 * These stored names are named once less (a message deleted, an item taken out); a file nothing names any more is
 * deleted, and PocketBase deletes what is stored once the transaction is committed. A name twice counts twice.
 * @param {core.App} app
 * @param {string[]} names
 */
function unlink(app, names) {
  const list = names.filter(Boolean);
  if (!list.length) return;
  for (const name of list) {
    app.db().newQuery("UPDATE files SET refs = refs - 1 WHERE file = {:name}").bind({ name }).execute();
  }
  for (const row of app.findAllRecords("files", $dbx.in("file", ...list), $dbx.exp("refs <= 0"))) {
    if (!row) continue;
    // Not moved yet: what is in its old place goes too, once this is committed (lib/media.js cleanupPass).
    const src = row.getString("src");
    if (src) cleanupLater(app, src);
    app.delete(row);
  }
}

/**
 * Delete what is stored under `prefix` (a record's folder, or a file and its thumbnails), after the transaction this
 * is in commits: the media worker does it (cleanupPass).
 * @param {core.App} app
 * @param {string} prefix
 */
function cleanupLater(app, prefix) {
  app
    .db()
    .newQuery("INSERT INTO storage_cleanup (id, prefix) VALUES ({:id}, {:prefix})")
    .bind({ id: $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"), prefix })
    .execute();
}

/**
 * The stored names a message or item names as committed (read in the save's transaction, so after any save before it):
 * [] when it is gone, or a message is deleted already. Two deletes of one record at once both load it named; only the
 * first may unlink (QA BUG-223).
 * @param {core.App} app
 * @param {"messages" | "collection_items"} collection
 * @param {string} id
 * @returns {string[]}
 */
function namedBy(app, collection, id) {
  let rec;
  try {
    rec = app.findRecordById(collection, id);
  } catch {
    return [];
  }
  if (collection === "collection_items") return [rec.getString("file")].filter(Boolean);
  return rec.getBool("deleted") ? [] : rec.getStringSlice("files");
}

/**
 * What a message's attachments are, set on `rec` (about to be created) from `rows` in order (a name once): its
 * `files`, their original names, shapes and, for those attached from collections, which collection (`sources`). The
 * rows are linked. At most MAX_FILES.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record[]} rows
 * @param {Record<string, string>} [sources] stored name → collection id
 * @param {boolean} [later] link them in the message's save (linkPending), not now: a create request sets them
 *   before the save's transaction (lib/messages.js setRequestFiles)
 */
function setMessageFiles(app, rec, rows, sources = {}, later = false) {
  /** @type {core.Record[]} */
  const list = [];
  const seen = new Set();
  for (const row of rows) {
    const name = row.getString("file");
    if (seen.has(name)) continue;
    seen.add(name);
    list.push(row);
  }
  if (list.length > MAX_FILES) throw fieldError("files", `At most ${MAX_FILES} files.`, "validation_too_many_values");
  /** @type {Record<string, string>} */
  const names = {};
  /** @type {Record<string, unknown>} */
  const dims = {};
  /** @type {Record<string, string>} */
  const from = {};
  for (const row of list) {
    const name = row.getString("file");
    names[name] = row.getString("name");
    const shape = parse(row.getString("dims"));
    if (Array.isArray(shape) && shape.length === 2) dims[name] = shape;
    if (sources[name]) from[name] = sources[name];
  }
  rec.set(
    "files",
    list.map((r) => r.getString("file")),
  );
  rec.set("file_names", names);
  rec.set("file_dims", dims);
  rec.set("file_sources", from);
  const ids = list.map((r) => r.id);
  if (later) rec.set(PENDING, ids);
  else link(app, ids);
}

/** A custom key (neither stored nor sent): the `files` rows a message's save is to link (setMessageFiles `later`). */
const PENDING = "@link";

/**
 * Link what setMessageFiles left to the save of `rec` (main.pb.js, in the save's transaction).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function linkPending(app, rec) {
  const ids = rec.get(PENDING);
  if (!Array.isArray(ids) || !ids.length) return;
  rec.set(PENDING, null);
  link(app, /** @type {string[]} */ (ids));
}

/** @param {string} s */
function parse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * A message about to be created from uploads (the Telegram bridge, a peer's files): their rows, set on it.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {filesystem.File[]} uploads
 */
function attachUploads(app, rec, uploads) {
  setMessageFiles(app, rec, fromUploads(app, uploads));
}

// Serving a message's or collection item's file (only while it shows it) is in Go: server/files.go (§37).

module.exports = {
  discard,
  linkPending,
  MAX_FILES,
  isImage,
  isVideo,
  isMedia,
  ext,
  dirOf,
  homeKeyOf,
  keyOf,
  thumbsDirOf,
  thumbKeyOf,
  posterKeyOf,
  cleanupLater,
  byName,
  byNames,
  fromUploads,
  link,
  unlink,
  namedBy,
  setMessageFiles,
  attachUploads,
};
