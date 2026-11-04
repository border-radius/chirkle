/// <reference path="../../types/pocketbase.d.ts" />
// Media collections (DESIGN.md §31): pb_migrations/1760000030_collections.js has the data.
//
// - collections hooks: a clean name, unique among the owner's (case folded), at most MAX_COLLECTIONS each; when one
//   turns private or public, its subscribers hear of it (their own collection_subs rows are saved again). When one
//   turns private or public, is renamed or is deleted, every client listening to BADGES_TOPIC hears its id.
// - POST /api/chat/items: a message's image or video (or another collection's item) in a collection of yours, or
//   (multipart { collection, file }) an image or video uploaded straight into one. DELETE
//   /api/chat/items/{id}: the owner takes one out. GET /api/chat/saved?message=&file= (or ?item=): which of your
//   collections have that file already.
// - Messages: a create may name collection items (`items`) whose files it attaches (itemsToAttach), and file_sources
//   says which collection each came from.
// - GET /api/chat/collections: yours and the public ones you follow, with how many items are new in those.
// - GET /api/chat/badges?ids=: what a message's "from collection" badge may say about each collection.
// - POST /api/chat/subs { collection, on }: follow or stop following; POST /api/chat/subs/seen { collection, at? }:
//   seen up to `at`, as POST /api/chat/reads does for a room (§18.2).
//
// Nothing is copied (§37): an item names the same `files` row as the message it was saved from, and a message the
// same as the item it attached (lib/files.js). An item's `origin` is its file's row: a file is in a collection once.

const { cleanName, fieldError, recordOf } = require(`${__hooks}/lib/records.js`);
const { clipFileName, nameKey, tidy, unescapeUploadName } = require(`${__hooks}/lib/text.js`);
const files = require(`${__hooks}/lib/files.js`);

const MAX_COLLECTIONS = 50;
const MAX_ITEMS = 2000;
const MAX_SUBS = 200;
/** As UNREAD_CAP (§18.2): the badge shows "99+" past 99. */
const NEW_CAP = 100;
/** How many of its newest items a collection's tile in the room list shows. */
const PREVIEW_ITEMS = 4;
/** The realtime topic that hears a collection's id when what its badge says may have changed (§31). */
const BADGES_TOPIC = "chat/badges";
const MAX_BADGES = 50;

/** @param {core.RequestEvent} e */
function me(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  return e.auth;
}

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [what]
 */
const badRequest = (field, message, what = "Failed to save to the collection.") =>
  new BadRequestError(what, { [field]: new ValidationError("validation_invalid_value", message) });

/** @param {core.App} app @param {string} collection @param {string} id */
function find(app, collection, id) {
  if (!id) return null;
  try {
    return app.findRecordById(collection, id);
  } catch {
    return null;
  }
}

/**
 * Can the request's user see `rec` by its collection's view rule? (A guest too: the rules decide.)
 * @param {core.RequestEvent} e
 * @param {core.Record} rec
 */
function canView(e, rec) {
  const rule = rec.collection().viewRule;
  return rule !== null && rule !== undefined && e.app.canAccessRecord(rec, e.requestInfo(), rule);
}

// ---------------------------------------------------------------- collections

/**
 * collections create and update: a clean name, unique among the owner's; at most MAX_COLLECTIONS each.
 * @param {core.RecordEvent} e
 */
function beforeCollectionSave(e) {
  const rec = recordOf(e);
  cleanName(rec);
  const key = nameKey(rec.getString("name"));
  rec.set("name_key", key);
  const owner = rec.getString("owner");
  if (rec.isNew()) {
    rec.set("items", 0);
    rec.set("last_added", "");
    const n = e.app.countRecords("collections", $dbx.hashExp({ owner }));
    if (n >= MAX_COLLECTIONS) throw fieldError("name", `You can have at most ${MAX_COLLECTIONS} collections.`);
  } else if (owner !== rec.original().getString("owner")) {
    throw fieldError("owner", "This field can't be changed.");
  }
  if (!key) return; // `required` reports it
  let clash = null;
  try {
    clash = e.app.findFirstRecordByFilter("collections", "owner = {:owner} && name_key = {:key} && id != {:id}", {
      owner,
      key,
      id: rec.id,
    });
  } catch {
    clash = null;
  }
  if (clash) throw fieldError("name", "You already have a collection with this name.", "validation_not_unique");
}

/**
 * A collection saved: if it turned private (or public again), its subscribers' rows are saved again, so their clients
 * hear of it live (they can't hear of the collection itself once it is private).
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {boolean} wasPublic
 */
function afterCollectionUpdate(app, rec, wasPublic) {
  if (rec.getBool("public") === wasPublic) return;
  for (const sub of app.findRecordsByFilter("collection_subs", "collection = {:id}", "", 0, 0, { id: rec.id })) {
    if (sub) app.save(sub);
  }
}

/**
 * A collection's save is done: made public or private, or renamed, the badges of its files are told.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function afterCollectionSaved(app, rec) {
  const was = rec.original();
  if (rec.getBool("public") !== was.getBool("public") || rec.getString("name") !== was.getString("name")) {
    tellBadges(app, rec.id);
  }
}

/**
 * What a collection's badge says may have changed (made public or private, renamed, deleted): every client listening
 * to BADGES_TOPIC gets its id and asks /badges again if it shows one. A guest too: a public collection's badge is
 * theirs as well. Only the id goes out; what each may see of the collection, /badges says. The collection's own record
 * events wouldn't do: PocketBase sends a change only to those who can see the result, so no one but the owner would
 * hear of one made private, and a client can't subscribe to a private one it may see once it is public.
 * @param {core.App} app
 * @param {string} id
 */
function tellBadges(app, id) {
  const data = JSON.stringify({ id });
  const clients = app.subscriptionsBroker().clients();
  for (const key of Object.keys(clients)) {
    const client = clients[key];
    if (!client || client.isDiscarded()) continue;
    for (const name of Object.keys(client.subscriptions(BADGES_TOPIC))) {
      client.send(new SubscriptionMessage({ name, data }));
    }
  }
}

/**
 * GET /api/chat/collections → { mine: [...], subs: [...] }, each by name. A subscription's `new` is how many items
 * were added after its `seen_at` (at most NEW_CAP). Subscriptions to collections that are private now are left out
 * (kept: they come back if it is public again).
 * @param {core.RequestEvent} e
 */
function list(e) {
  const user = me(e);
  const mine = arrayOf(new DynamicModel({ id: "", name: "", public: false, items: 0, last_added: "" }));
  e.app
    .db()
    .newQuery("SELECT id, name, public, items, last_added FROM collections WHERE owner = {:me} ORDER BY name_key, id")
    .bind({ me: user.id })
    .all(mine);
  const subs = arrayOf(new DynamicModel({ id: "", name: "", items: 0, last_added: "", owner: "", owner_name: "", seen_at: "", n: 0 }));
  e.app
    .db()
    .newQuery(
      `SELECT c.id, c.name, c.items, c.last_added, c.owner, COALESCE(u.name, '') AS owner_name, s.seen_at, (
         SELECT COUNT(*) FROM (
           SELECT 1 FROM collection_items i WHERE i.collection = c.id AND i.created > s.seen_at LIMIT ${NEW_CAP}
         )
       ) AS n
       FROM collection_subs s
       JOIN collections c ON c.id = s.collection
       LEFT JOIN users u ON u.id = c.owner
       WHERE s.user = {:me} AND c.public = TRUE
       ORDER BY c.name_key, c.id`,
    )
    .bind({ me: user.id })
    .all(subs);
  const previews = previewsOf(e.app, [...mine.map((c) => c.id), ...subs.map((c) => c.id)]);
  return e.json(200, {
    mine: mine.map((c) => ({
      id: c.id,
      name: c.name,
      public: !!c.public,
      items: c.items,
      last_added: c.last_added,
      preview: previews[c.id] ?? [],
    })),
    subs: subs.map((c) => ({
      id: c.id,
      name: c.name,
      public: true,
      items: c.items,
      last_added: c.last_added,
      owner: { id: c.owner, name: c.owner_name },
      seen_at: c.seen_at,
      new: c.n,
      preview: previews[c.id] ?? [],
    })),
  });
}

/**
 * The newest PREVIEW_ITEMS items of each of these collections, newest first, for their tiles in the room list: one index
 * range of (collection, created) each. CROSS JOIN keeps SQLite from scanning every item and running the subquery for
 * each one (which it otherwise plans).
 * @param {core.App} app
 * @param {string[]} ids
 * @returns {Record<string, { id: string, file: string, video: boolean, poster: boolean }[]>}
 */
function previewsOf(app, ids) {
  /** @type {Record<string, { id: string, file: string, video: boolean, poster: boolean }[]>} */
  const out = {};
  if (ids.length === 0) return out;
  const rows = arrayOf(new DynamicModel({ id: "", collection: "", file: "", video: false, poster: false }));
  app
    .db()
    .newQuery(
      `SELECT i.id, i.collection, i.file, i.video, i.poster
       FROM json_each({:ids}) c
       CROSS JOIN collection_items i ON i.id IN (
         SELECT j.id FROM collection_items j WHERE j.collection = c.value ORDER BY j.created DESC, j.id DESC LIMIT ${PREVIEW_ITEMS}
       )
       ORDER BY i.created DESC, i.id DESC`,
    )
    .bind({ ids: JSON.stringify(ids) })
    .all(rows);
  for (const r of rows) {
    if (!out[r.collection]) out[r.collection] = [];
    out[r.collection].push({ id: r.id, file: r.file, video: !!r.video, poster: !!r.poster });
  }
  return out;
}

/**
 * GET /api/chat/badges?ids=a,b → { a: { name, public, mine } | { private: true } | null }: what the badge of a file
 * attached from collection `a` may say (§31). The name only for a public collection or your own; null for one that
 * is gone.
 * @param {core.RequestEvent} e
 */
function badges(e) {
  const raw = e.request?.url?.query().get("ids") ?? "";
  const ids = [...new Set(raw.split(",").filter((id) => /^[a-z0-9]{15}$/.test(id)))].slice(0, MAX_BADGES);
  const user = e.auth?.id ?? "";
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const id of ids) {
    const c = find(e.app, "collections", id);
    if (!c) out[id] = null;
    else if (c.getBool("public") || (user && c.getString("owner") === user)) {
      out[id] = { name: c.getString("name"), public: c.getBool("public"), mine: !!user && c.getString("owner") === user };
    } else out[id] = { private: true };
  }
  return e.json(200, out);
}

// ---------------------------------------------------------------- items

/** What an item looks like to the client. @param {core.Record} item */
const itemOut = (item) => ({
  id: item.id,
  collectionId: item.collection().id,
  collectionName: item.collection().name,
  collection: item.getString("collection"),
  file: item.getString("file"),
  name: item.getString("name"),
  video: item.getBool("video"),
  poster: item.getBool("poster"),
  created: item.getString("created"),
});

/**
 * POST /api/chat/items { collection, message, file } or { collection, item } → the new item: a message's image or
 * video (one you can see: a forward's original too, §21.3) or an item you can see, in a collection of yours, naming
 * the same file (§37). 409 when that file is in it already. Multipart { collection, file }: the upload itself
 * (addUpload).
 * @param {core.RequestEvent} e
 */
function saveItem(e) {
  const user = me(e);
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const str = (/** @type {string} */ k) => (typeof body[k] === "string" ? /** @type {string} */ (body[k]) : "");
  const coll = find(e.app, "collections", str("collection"));
  if (!coll || !canView(e, coll)) throw new NotFoundError("The collection doesn't exist.");
  if (coll.getString("owner") !== user.id) throw new ForbiddenError("You can only add to your own collections.");
  if (coll.getInt("items") >= MAX_ITEMS) throw badRequest("collection", `A collection holds at most ${MAX_ITEMS} items.`);
  const upload = uploaded(e);
  if (upload) return e.json(200, itemOut(addUpload(e.app, coll, upload)));

  /** @type {string} */
  let name;
  if (str("item")) {
    const item = find(e.app, "collection_items", str("item"));
    if (!item || !canView(e, item)) throw new NotFoundError("The item doesn't exist.");
    name = item.getString("file");
  } else {
    const msg = find(e.app, "messages", str("message"));
    if (!msg || !canView(e, msg)) throw new NotFoundError("The message doesn't exist.");
    if (msg.getBool("deleted")) throw badRequest("message", "That message was deleted.");
    name = str("file");
    if (!msg.getStringSlice("files").includes(name) || !files.isMedia(name))
      throw badRequest("file", "Only images and videos can be saved.");
  }
  const row = files.byName(e.app, name);
  if (!row) throw new NotFoundError("The file doesn't exist.");
  const taken = () => new ApiError(409, "This is in the collection already.", {});
  if (e.app.countRecords("collection_items", $dbx.hashExp({ collection: coll.id, origin: row.id }))) throw taken();
  const item = new Record(e.app.findCollectionByNameOrId("collection_items"));
  try {
    e.app.runInTransaction((tx) => addItem(tx, coll.id, item, row));
  } catch (err) {
    // Lost a race with another save of the same file: the unique (collection, origin) index kept it to one.
    if (e.app.countRecords("collection_items", $dbx.hashExp({ collection: coll.id, origin: row.id }))) throw taken();
    throw err;
  }
  return e.json(200, itemOut(item));
}

/**
 * Save `item`, new, in collection `collection` naming file `row` (linked), and count it in the collection.
 * @param {core.App} tx
 * @param {string} collection
 * @param {core.Record} item
 * @param {core.Record} row
 */
function addItem(tx, collection, item, row) {
  // Found before the transaction: the message may have been deleted since, and the file with it.
  if (!files.byName(tx, row.getString("file"))) throw new NotFoundError("The file doesn't exist.");
  item.set("collection", collection);
  item.set("file", row.getString("file"));
  item.set("name", row.getString("name") || row.getString("file"));
  item.set("video", row.getBool("video"));
  // A video whose poster is made already (saved from a message that has one) shows it at once.
  item.set("poster", row.getBool("poster"));
  item.set("origin", row.id);
  tx.save(item);
  files.link(tx, [row.id]);
  const c = tx.findRecordById("collections", collection);
  c.set("items", c.getInt("items") + 1);
  c.set("last_added", new DateTime());
  tx.save(c);
}

/**
 * The file of a multipart POST /api/chat/items (`file`), or null for a JSON one (a save).
 * @param {core.RequestEvent} e
 * @returns {filesystem.File | null}
 */
function uploaded(e) {
  if (!(e.request?.header.get("Content-Type") ?? "").startsWith("multipart/")) return null;
  /** @type {(filesystem.File | undefined)[]} */
  let list = [];
  try {
    list = e.findUploadedFiles("file");
  } catch {
    list = [];
  }
  if (list.length !== 1 || !list[0]) throw badRequest("file", "Upload one image or video.");
  return list[0];
}

/**
 * An image or video uploaded straight into a collection (§31.2): a new file (§37) and an item naming it. Its name is
 * cleaned as an attachment's is (no bidi overrides, "cat‮gpj.exe"; capped in length with the extension kept, QA
 * BUG-149): subscribers of a public collection see it. Held to an attachment's limits (20 MB; an image's size, QA
 * BUG-140); the media worker makes its grid thumbnail or poster, as for any file.
 * @param {core.App} app
 * @param {core.Record} coll
 * @param {filesystem.File} upload
 */
function addUpload(app, coll, upload) {
  const name = clipFileName(tidy(unescapeUploadName(upload.originalName))) || upload.name;
  if (!files.isMedia(name) || !files.isMedia(upload.name)) throw badRequest("file", "Only images and videos can be added.");
  const item = new Record(app.findCollectionByNameOrId("collection_items"));
  app.runInTransaction((tx) => {
    const [row] = files.fromUploads(tx, [upload], "file");
    addItem(tx, coll.id, item, row);
  });
  return item;
}

/**
 * GET /api/chat/saved?message=/**
 * GET /api/chat/saved?message=&file= (or ?item=) → { "<collection id>": "<item id>" }: your collections that have the
 * file (a message's, or an item's) already. The save menu ticks them.
 * @param {core.RequestEvent} e
 */
function saved(e) {
  const user = me(e);
  const q = e.request?.url?.query();
  let origin = "";
  const itemId = q?.get("item") ?? "";
  if (itemId) {
    const item = find(e.app, "collection_items", itemId);
    if (item && canView(e, item)) origin = item.getString("origin");
  } else {
    // The message's file, which you can see (a forward's original's too, §21.3).
    const msg = find(e.app, "messages", q?.get("message") ?? "");
    const name = q?.get("file") ?? "";
    if (msg && canView(e, msg) && !msg.getBool("deleted") && msg.getStringSlice("files").includes(name)) {
      origin = files.byName(e.app, name)?.id ?? "";
    }
  }
  // Not one you may see: in none of yours. An empty origin would match nothing anyway (QA BUG-148).
  if (!origin) return e.json(200, {});
  const rows = arrayOf(new DynamicModel({ collection: "", id: "" }));
  e.app
    .db()
    .newQuery(
      `SELECT i.collection, i.id FROM collections c JOIN collection_items i ON i.collection = c.id AND i.origin = {:origin}
       WHERE c.owner = {:me}`,
    )
    .bind({ me: user.id, origin })
    .all(rows);
  return e.json(200, Object.fromEntries(rows.map((r) => [r.collection, r.id])));
}

/**
 * DELETE /api/chat/items/{id}: the owner takes an item out of their collection (its file goes with it, unless a
 * message or another item still names it: the item's delete hook unlinks it, §37).
 * @param {core.RequestEvent} e
 */
function removeItem(e) {
  const user = me(e);
  const item = find(e.app, "collection_items", e.request?.pathValue("id") ?? "");
  if (!item || !canView(e, item)) throw new NotFoundError("The item doesn't exist.");
  const coll = e.app.findRecordById("collections", item.getString("collection"));
  if (coll.getString("owner") !== user.id) throw new ForbiddenError("You can only remove items from your own collections.");
  e.app.runInTransaction((tx) => {
    tx.delete(tx.findRecordById("collection_items", item.id));
    const c = tx.findRecordById("collections", coll.id);
    c.set("items", Math.max(0, c.getInt("items") - 1));
    tx.save(c);
  });
  return e.noContent(204);
}

/**
 * The collection items a message create through the API names (`items`: their ids, as a JSON list in a form), as the
 * `files` rows to attach after the `uploads` uploads, and which collection each came from (`sources`, by stored
 * name). Items of a collection of yours or a public one only.
 * @param {core.RecordRequestEvent} e
 * @param {number} uploads
 * @returns {{ rows: core.Record[], sources: Record<string, string> }}
 */
function itemsToAttach(e, uploads) {
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  let ids = body.items;
  if (ids === undefined || ids === "" || ids === null) return { rows: [], sources: {} };
  if (typeof ids === "string") {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = null;
    }
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) throw fieldError("items", "Must be a list of item ids.");
  // The create rule would refuse it anyway.
  if (!e.auth) throw new ForbiddenError("Only signed-in users can post.");
  const list = [.../** @type {Set<string>} */ (new Set(ids))];
  if (!list.length) return { rows: [], sources: {} };
  if (list.length + uploads > files.MAX_FILES) throw fieldError("files", `At most ${files.MAX_FILES} files.`);
  const gone = () => fieldError("items", "A collection item is no longer available.");
  const items = list.map((id) => {
    const item = find(e.app, "collection_items", id);
    if (!item || !canView(e, item)) throw gone();
    return item;
  });
  const rows = files.byNames(
    e.app,
    items.map((i) => i.getString("file")),
  );
  /** @type {Record<string, string>} */
  const sources = {};
  const out = items.map((item) => {
    const row = rows.get(item.getString("file"));
    if (!row) throw gone();
    if (!sources[item.getString("file")]) sources[item.getString("file")] = item.getString("collection");
    return row;
  });
  return { rows: out, sources };
}

// ---------------------------------------------------------------- subscriptions

/** @param {core.App} app @param {string} user @param {string} collection */
function findSub(app, user, collection) {
  try {
    return app.findFirstRecordByFilter("collection_subs", "user = {:user} && collection = {:collection}", { user, collection });
  } catch {
    return null;
  }
}

/**
 * POST /api/chat/subs { collection, on } → { collection, on, seen_at }: follow someone else's public collection
 * (seen up to now), or stop following it. Idempotent.
 * @param {core.RequestEvent} e
 */
function subscribe(e) {
  const user = me(e);
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const id = typeof body.collection === "string" ? body.collection : "";
  const what = "Failed to subscribe.";
  // Not "false" or 0 taken for true.
  if (body.on !== undefined && typeof body.on !== "boolean") throw badRequest("on", "Must be true or false.", what);
  const on = body.on !== false;
  const coll = find(e.app, "collections", id);
  if (on) {
    if (!coll?.getBool("public")) throw new NotFoundError("The collection doesn't exist.");
    if (coll.getString("owner") === user.id) throw badRequest("collection", "This is your own collection.", what);
  }
  let row = findSub(e.app, user.id, id);
  if (!on) {
    if (row) e.app.delete(row);
    return e.json(200, { collection: id, on: false, seen_at: "" });
  }
  if (!row) {
    if (e.app.countRecords("collection_subs", $dbx.hashExp({ user: user.id })) >= MAX_SUBS) {
      throw badRequest("collection", `You can follow at most ${MAX_SUBS} collections.`, what);
    }
    const created = new Record(e.app.findCollectionByNameOrId("collection_subs"));
    created.set("user", user.id);
    created.set("collection", id);
    created.set("seen_at", new DateTime());
    try {
      e.app.save(created);
      row = created;
    } catch (err) {
      // Another tab won the race: the unique (user, collection) index kept it to one row.
      row = findSub(e.app, user.id, id);
      if (!row) throw err;
    }
  }
  return e.json(200, { collection: id, on: true, seen_at: row.getString("seen_at") });
}

/**
 * POST /api/chat/subs/seen { collection, at? }: you have seen the collection's items up to `at` (an item's `created`;
 * default now). Only moves forward, never past now. 404 when you don't follow it.
 * @param {core.RequestEvent} e
 */
function markSeen(e) {
  const user = me(e);
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const id = typeof body.collection === "string" ? body.collection : "";
  const row = id ? findSub(e.app, user.id, id) : null;
  if (!row) throw new NotFoundError("You don't follow this collection.");
  const now = new DateTime();
  let at = now;
  if (body.at !== undefined) {
    const bad = () => badRequest("at", "Must be a date.", "Failed to mark the collection as seen.");
    if (typeof body.at !== "string" || body.at === "") throw bad();
    try {
      at = new DateTime(body.at);
    } catch {
      throw bad();
    }
    if (at.isZero()) throw bad();
    if (at.after(now)) at = now;
  }
  if (at.after(row.getDateTime("seen_at"))) {
    row.set("seen_at", at);
    e.app.save(row);
  }
  return e.json(200, { collection: id, seen_at: row.getString("seen_at") });
}

module.exports = {
  MAX_COLLECTIONS,
  MAX_ITEMS,
  beforeCollectionSave,
  afterCollectionUpdate,
  afterCollectionSaved,
  list,
  badges,
  tellBadges,
  saveItem,
  saved,
  removeItem,
  itemsToAttach,
  subscribe,
  markSeen,
};
