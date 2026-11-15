/// <reference path="../../types/pocketbase.d.ts" />
// Your account (DESIGN.md §22.2, §43):
// - POST /api/chat/password: change your password. Checks the current one, signs out every other session, and
//   answers like a login (a fresh token and record), so the tab that changed it stays logged in.
// - POST /api/chat/export, GET /api/chat/export, GET /api/chat/export/file: everything you wrote and keep here, as a
//   JSON file. Asked for, it is made by a worker (an account job), and is then there to download for 7 days.
// - POST /api/chat/account/delete: delete your account. Its personal data goes at once; its collections, and its
//   messages if its person chooses so, go after, by the same worker, a batch at a time.
//
// The worker (a cron job, lib/worker.js) does the work that grows with the account, so a big account or a busy
// server never holds a request, or the database's write lock, for long (§43.5).

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [code]
 */
function fieldError(field, message, code = "validation_invalid_value", what = "Failed to change the password.") {
  return new BadRequestError(what, { [field]: new ValidationError(code, message) });
}

/** @param {core.RequestEvent} e */
function changePassword(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!oldPassword) throw fieldError("oldPassword", "Enter your current password.", "validation_required");
  if (!password) throw fieldError("password", "Enter a new password.", "validation_required");
  const user = e.app.findRecordById("users", e.auth.id);
  if (!user.validatePassword(oldPassword)) throw fieldError("oldPassword", "That isn't your current password.");
  if (password === oldPassword) throw fieldError("password", "That is your current password. Choose a new one.");
  require(`${__hooks}/lib/users.js`).checkPasswordLength(password);
  user.setPassword(password); // the field's own rules (length) are checked by save()
  user.refreshTokenKey(); // every token issued so far stops working: other devices are signed out
  e.app.save(user);
  return $apis.recordAuthResponse(e, user, "password");
}

/** Rows read at a time by the export and the delete. */
const PAGE = 500;

/** Items or messages deleted in one transaction by an erase job. */
const ERASE_BATCH = 200;

/** What an export says it is (§43.2); `version` changes when its shape does. */
const FORMAT = "chirkle-export";
const VERSION = 1;

/** How long a made export is kept to download. */
const KEEP_MS = 7 * 24 * 3600_000;

/** A made export asked for again within this long is the same one: no new job. */
const FRESH_MS = 10 * 60_000;

/** A job that failed this many times is given up ("failed"). */
const MAX_TRIES = 5;

/** The worker's lock (lib/worker.js), and how long before a run that stopped renewing it is taken over. */
const LOCK = "account.worker";
const STALE_MS = 5 * 60_000;

/** A time as the database stores it. @param {number} ms */
const dbDate = (ms) => new Date(ms).toISOString().replace("T", " ");

/** A stored time in ms, or 0. @param {string} t */
const msOf = (t) => (t ? Date.parse(t.replace(" ", "T")) || 0 : 0);

/**
 * What a file is called: its upload's name when recorded, else its stored name without the "_" and 10 characters
 * PocketBase adds (web/src/lib/files.ts attachmentName).
 * @param {Record<string, string>} names
 * @param {string} stored
 */
const fileName = (names, stored) => names[stored] || stored.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1");

/**
 * Every record of `collection` matching `filter`, a page at a time, oldest first, by (created, id): a page costs the
 * same however far in it is. `renew` (the worker's) after each page.
 * @param {core.App} app
 * @param {string} collection
 * @param {string} filter
 * @param {Record<string, unknown>} params
 * @param {(rec: core.Record) => void} each
 * @param {() => void} [renew]
 */
function eachRecord(app, collection, filter, params, each, renew) {
  /** @type {{ c: string, i: string } | null} */
  let after = null;
  for (;;) {
    /** @type {(core.Record | undefined)[]} */
    const page = after
      ? app.findRecordsByFilter(collection, `(${filter}) && (created > {:_c} || (created = {:_c} && id > {:_i}))`, "created,id", PAGE, 0, {
          ...params,
          _c: after.c,
          _i: after.i,
        })
      : app.findRecordsByFilter(collection, filter, "created,id", PAGE, 0, params);
    for (const rec of page) if (rec) each(rec);
    if (renew) renew();
    /** @type {core.Record | undefined} */
    const last = page[page.length - 1];
    if (page.length < PAGE || !last) return;
    after = { c: last.getString("created"), i: last.id };
  }
}

// ---------------------------------------------------------------- your data (§43.2)

/**
 * A user's newest job of `kind`, or null.
 * @param {core.App} app
 * @param {string} userId
 * @param {"export" | "erase"} kind
 */
function latestJob(app, userId, kind) {
  const rows = app.findRecordsByFilter("account_jobs", "user = {:u} && kind = {:k}", "-created,-id", 1, 0, { u: userId, k: kind });
  return rows[0] ?? null;
}

/**
 * What GET and POST /api/chat/export answer: where the newest export is. `state` "none" (never asked, or gone after 7
 * days), "queued" (being made), "done" (to download until `expires`) or "failed".
 * @param {core.Record | null} job
 */
function exportStatus(job) {
  if (!job) return { id: "", state: "none", created: "", finished: "", expires: "", size: 0 };
  const state = job.getString("state");
  return {
    id: job.id,
    state,
    created: job.getString("created"),
    finished: job.getString("finished"),
    expires: state === "done" ? dbDate(msOf(job.getString("created")) + KEEP_MS) : "",
    size: job.getInt("size"),
  };
}

/**
 * GET /api/chat/export: where your newest export is (exportStatus).
 * @param {core.RequestEvent} e
 */
function exportState(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  return e.json(200, exportStatus(latestJob(e.app, e.auth.id, "export")));
}

/**
 * POST /api/chat/export: make your data into a file (§43.2). Queued for the worker; asked again while it is being made,
 * or within 10 minutes of it being made, the same one. Answers as GET does.
 * @param {core.RequestEvent} e
 */
function startExport(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  const last = latestJob(e.app, e.auth.id, "export");
  const state = last?.getString("state");
  if (last && (state === "queued" || (state === "done" && Date.now() - msOf(last.getString("created")) < FRESH_MS))) {
    return e.json(200, exportStatus(last));
  }
  const job = new Record(e.app.findCollectionByNameOrId("account_jobs"));
  job.set("user", e.auth.id);
  job.set("kind", "export");
  job.set("state", "queued");
  e.app.save(job);
  wake(e.app);
  return e.json(200, exportStatus(job));
}

/**
 * GET /api/chat/export/file: your newest made export, as a download. Signed in, or with a file token
 * (`?token=`, POST /api/files/token) so that a plain link (the web's, the app's download manager) can fetch it.
 * @param {core.RequestEvent} e
 */
function exportFile(e) {
  /** @type {core.Record | undefined} */
  let user = e.auth;
  const token = e.request?.url?.query().get("token") ?? "";
  if (!user && token) {
    try {
      user = e.app.findAuthRecordByToken(token, "file");
    } catch {
      user = undefined;
    }
  }
  if (!e.request) throw new BadRequestError("No request.");
  if (user?.collection().name !== "users") throw new UnauthorizedError("The request requires a logged-in user.");
  const job = latestJob(e.app, user.id, "export");
  const file = job?.getString("state") === "done" ? job.getString("file") : "";
  if (!job || !file) throw new NotFoundError("There is no export to download. Ask for one first.");
  const name = `chirkle-export-${job.getString("created").slice(0, 10)}.json`;
  const fsys = e.app.newFilesystem();
  try {
    e.response.header().set("Cache-Control", "no-store");
    e.response.header().set("Content-Disposition", `attachment; filename="${name}"`);
    fsys.serve(e.response, e.request, `${job.baseFilesPath()}/${file}`, name);
  } finally {
    fsys.close();
  }
}

/**
 * Write export job `job`'s file (§43.2): the user's profile (with their e-mail); the messages they wrote and haven't
 * deleted, with their files; the rooms those are in and the rooms they made; their collections with their items; the
 * collections they follow; the rooms they hid. Written a record at a time into a temporary file, which is then the
 * job's (protected) `file`: what is held in memory is the room list, not the messages. Files are paths on this server
 * (`/api/files/…`), which whoever has them can open (§37.3). Other people's words aren't in it: a forward names the
 * message it shows, not its text.
 * @param {core.App} app
 * @param {core.Record} job
 * @param {() => void} [renew]
 */
function writeExport(app, job, renew) {
  const id = job.getString("user");
  const me = app.findRecordById("users", id);
  const at = new Date().toISOString();
  const dir = $os.tempDir();
  const tmp = `chirkle-export-${job.id}-${$security.randomString(8)}.json`;
  const root = $os.openRoot(dir);
  const out = root.create(tmp);
  const w = (/** @type {string} */ s) => out.writeString(s);
  try {
    const account = {
      id,
      name: me.getString("name"),
      handle: me.getString("handle"),
      email: me.getString("email"),
      created: me.getString("created"),
      avatar: me.getString("avatar") ? `/api/files/users/${id}/${me.getString("avatar")}` : "",
      no_dms: me.getBool("no_dms"),
    };
    w(`{"format":${JSON.stringify(FORMAT)},"version":${VERSION},"exported":${JSON.stringify(at)},"account":${JSON.stringify(account)}`);

    /** The rooms its messages are in. @type {Set<string>} */
    const roomIds = new Set();
    let first = true;
    w(`,"messages":[`);
    eachRecord(
      app,
      "messages",
      "author = {:id} && deleted = false",
      { id },
      (m) => {
        roomIds.add(m.getString("room"));
        const names = /** @type {Record<string, string>} */ (m.get("file_names") ?? {});
        const row = {
          id: m.id,
          room: m.getString("room"),
          created: m.getString("created"),
          edited: m.getString("edited_at"),
          text: m.getString("text"),
          reply_to: m.getString("reply_to"),
          forward_of: m.getString("forward_of"),
          files: m.getStringSlice("files").map((f) => ({ name: fileName(names, f), url: `/api/files/messages/${m.id}/${f}` })),
        };
        w(`${first ? "" : ","}${JSON.stringify(row)}`);
        first = false;
      },
      renew,
    );

    /** A DM is named for whoever else is in it. @param {core.Record} r */
    const roomRow = (r) => {
      let name = r.getString("name");
      if (r.getString("kind") === "dm") {
        const others = r.getStringSlice("members").filter((u) => u !== id);
        name = (others.length ? app.findRecordsByIds("users", others) : []).map((u) => (u ? u.getString("name") : "")).join(", ");
      }
      return { id: r.id, name, kind: r.getString("kind") === "dm" ? "dm" : "room", mine: r.getString("created_by") === id };
    };
    first = true;
    w(`],"rooms":[`);
    const room = (/** @type {core.Record} */ r) => {
      w(`${first ? "" : ","}${JSON.stringify(roomRow(r))}`);
      first = false;
    };
    eachRecord(app, "rooms", "created_by = {:id}", { id }, (r) => {
      roomIds.delete(r.id);
      room(r);
    });
    const rest = [...roomIds];
    for (let i = 0; i < rest.length; i += PAGE) {
      for (const r of app.findRecordsByIds("rooms", rest.slice(i, i + PAGE))) if (r) room(r);
      if (renew) renew();
    }

    first = true;
    w(`],"collections":[`);
    eachRecord(app, "collections", "owner = {:id}", { id }, (c) => {
      w(
        `${first ? "" : ","}{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.getString("name"))},"public":${c.getBool("public")},"created":${JSON.stringify(c.getString("created"))},"items":[`,
      );
      first = false;
      let firstItem = true;
      eachRecord(
        app,
        "collection_items",
        "collection = {:c}",
        { c: c.id },
        (it) => {
          const file = it.getString("file");
          const row = {
            id: it.id,
            name: it.getString("name") || fileName({}, file),
            created: it.getString("created"),
            url: file ? `/api/files/collection_items/${it.id}/${file}` : "",
          };
          w(`${firstItem ? "" : ","}${JSON.stringify(row)}`);
          firstItem = false;
        },
        renew,
      );
      w("]}");
    });

    first = true;
    w(`],"following":[`);
    eachRecord(app, "collection_subs", "user = {:id}", { id }, (sub) => {
      try {
        const c = app.findRecordById("collections", sub.getString("collection"));
        w(`${first ? "" : ","}${JSON.stringify({ id: c.id, name: c.getString("name") })}`);
        first = false;
      } catch {
        // gone
      }
    });

    first = true;
    w(`],"hidden_rooms":[`);
    eachRecord(app, "hidden_rooms", "user = {:id}", { id }, (row) => {
      w(`${first ? "" : ","}${JSON.stringify(row.getString("room"))}`);
      first = false;
    });
    w("]}\n");
  } finally {
    out.close();
    root.close();
  }
  const path = `${dir}/${tmp}`;
  try {
    const file = $filesystem.fileFromPath(path);
    file.originalName = `chirkle-export-${at.slice(0, 10)}.json`;
    job.set("file", file);
    job.set("size", $os.stat(path).size());
    app.save(job);
  } finally {
    $os.remove(path);
  }
}

// ---------------------------------------------------------------- deleting the account (§43.3)

/**
 * POST /api/chat/account/delete { password, messages: "keep" | "delete" } → 204 (§43.3). The caller's password says
 * it is them. The account is a deleted one at once (erase); what grows with it (its collections' items, and with
 * "delete" its messages) goes after, by the worker (an erase job).
 * @param {core.RequestEvent} e
 */
function deleteAccount(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  const what = "Failed to delete the account.";
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const password = typeof body.password === "string" ? body.password : "";
  const choice = body.messages;
  if (!password) throw fieldError("password", "Enter your password.", "validation_required", what);
  if (choice !== "keep" && choice !== "delete") {
    throw fieldError("messages", "Choose whether your messages stay or go.", "validation_required", what);
  }
  const user = e.app.findRecordById("users", e.auth.id);
  if (!user.validatePassword(password)) throw fieldError("password", "That isn't your password.", undefined, what);
  erase(e.app, user.id, choice === "delete");
  wake(e.app);
  return e.noContent(204);
}

/**
 * Make `userId` a deleted account (§43.3), in one transaction, and queue the rest. Its name becomes "Deleted account"
 * (lib/users.js beforeUserSave), its handle, picture and e-mail go, it takes no DMs, it is no moderator. Every session
 * ends and no sign-in works again: a random password, its OAuth2 links, one-time codes and sign-in origins gone. What
 * only it had and is small goes now: whom and what it follows, hid and read, its inbox, its exports. Its collections
 * stop being public, and go with their items by the erase job. It leaves the private rooms it was in and the lists of
 * who may post. The row stays, so the messages (kept, or deleted) and rooms that name it still have an author; a room
 * it made keeps it as its creator, and moderators look after it.
 * @param {core.App} app
 * @param {string} userId
 * @param {boolean} messages its messages go too (by the erase job)
 */
function erase(app, userId, messages) {
  app.runInTransaction((tx) => {
    const user = tx.findRecordById("users", userId);
    user.set("kind", "deleted");
    user.set("email", `${userId}@deleted.invalid`);
    user.set("emailVisibility", false);
    user.set("verified", false);
    user.set("avatar", null);
    user.set("no_dms", true);
    user.set("moderator", false);
    user.set("banned", false);
    user.setPassword($security.randomString(48));
    user.refreshTokenKey();
    tx.save(user);
    tx.deleteAllExternalAuthsByRecord(user);
    tx.deleteAllMFAsByRecord(user);
    tx.deleteAllOTPsByRecord(user);
    tx.deleteAllAuthOriginsByRecord(user);

    for (const [collection, field] of [
      ["collection_subs", "user"],
      ["hidden_rooms", "user"],
      ["room_reads", "user"],
      ["inbox", "user"],
      ["inbox_reads", "user"],
      ["stats_activity", "user"],
      ["account_jobs", "user"],
    ]) {
      for (;;) {
        const rows = tx.findRecordsByFilter(collection, `${field} = {:id}`, "", PAGE, 0, { id: userId });
        for (const row of rows) if (row) tx.delete(row);
        if (rows.length < PAGE) break;
      }
    }
    // Read all first, as below: saved, a record no longer matches, and the pages would skip some.
    /** @type {core.Record[]} */
    const shown = [];
    eachRecord(tx, "collections", "owner = {:id} && public = true", { id: userId }, (c) => shown.push(c));
    for (const c of shown) {
      c.set("public", false);
      tx.save(c);
    }

    // Private rooms' members and who may post (§23): not a DM's two, which name the DM.
    /** @type {core.Record[]} */
    const rooms = [];
    eachRecord(tx, "rooms", "kind != 'dm' && (members.id ?= {:id} || writers.id ?= {:id})", { id: userId }, (r) => rooms.push(r));
    for (const room of rooms) {
      room.set(
        "members",
        room.getStringSlice("members").filter((u) => u !== userId),
      );
      room.set(
        "writers",
        room.getStringSlice("writers").filter((u) => u !== userId),
      );
      tx.save(room);
    }

    const job = new Record(tx.findCollectionByNameOrId("account_jobs"));
    job.set("user", userId);
    job.set("kind", "erase");
    job.set("state", "queued");
    job.set("messages", messages);
    tx.save(job);
  });
}

/**
 * One step of erase job `job`: a batch of a collection's items (the collection itself after its last), else with
 * `messages` a batch of its messages soft-deleted (§21.2) through the messages hooks, so files, previews, the media
 * grid, the inbox, forwards and the bridges follow as for any delete, archived rooms too (`@erasing`). Each batch in a
 * transaction. True while there is more.
 * @param {core.App} app
 * @param {core.Record} job
 */
function eraseStep(app, job) {
  const userId = job.getString("user");
  const coll = app.findRecordsByFilter("collections", "owner = {:u}", "created,id", 1, 0, { u: userId })[0];
  if (coll) {
    const items = app.findRecordsByFilter("collection_items", "collection = {:c}", "", ERASE_BATCH, 0, { c: coll.id });
    app.runInTransaction((tx) => {
      for (const it of items) if (it) tx.delete(it);
      if (items.length < ERASE_BATCH) tx.delete(tx.findRecordById("collections", coll.id));
    });
    return true;
  }
  if (!job.getBool("messages")) return false;
  const batch = app.findRecordsByFilter("messages", "author = {:id} && deleted = false", "created,id", ERASE_BATCH, 0, { id: userId });
  if (!batch.length) return false;
  const { ERASING } = require(`${__hooks}/lib/messages.js`);
  app.runInTransaction((tx) => {
    for (const m of batch) {
      if (!m) continue;
      const rec = tx.findRecordById("messages", m.id);
      if (rec.getBool("deleted")) continue;
      rec.set(ERASING, true);
      rec.set("deleted", true);
      tx.save(rec);
    }
  });
  return true;
}

// ---------------------------------------------------------------- the worker (§43.5)

/**
 * One pass: exports older than 7 days deleted (their files with them), then one step of the queued job touched
 * longest ago: an export written whole, or a batch of an erase. Saving the job touches it, so jobs take turns: a
 * large erase doesn't keep an export waiting. A step that fails is tried again on a later pass, at most MAX_TRIES
 * times. Returns whether there may be more to do now.
 * @param {core.App} app
 * @param {() => void} [renew]
 */
function pass(app, renew) {
  const old = app.findRecordsByFilter("account_jobs", "kind = 'export' && created < {:t}", "", 50, 0, { t: dbDate(Date.now() - KEEP_MS) });
  for (const j of old) if (j) app.delete(j);
  const job = app.findRecordsByFilter("account_jobs", "state = 'queued'", "updated,id", 1, 0)[0];
  if (!job) return old.length === 50;
  try {
    let more = false;
    if (job.getString("kind") === "export") writeExport(app, job, renew);
    else more = eraseStep(app, job);
    if (!more) {
      job.set("state", "done");
      job.set("finished", new DateTime());
    }
    app.save(job);
  } catch (err) {
    if (require(`${__hooks}/lib/worker.js`).isLost(err)) throw err;
    app.logger().error("account: job failed", "job", job.id, "kind", job.getString("kind"), "error", String(err));
    try {
      const fresh = app.findRecordById("account_jobs", job.id);
      const tries = fresh.getInt("tries") + 1;
      fresh.set("tries", tries);
      fresh.set("error", String(err).slice(0, 500));
      if (tries >= MAX_TRIES) {
        fresh.set("state", "failed");
        fresh.set("finished", new DateTime());
      }
      app.save(fresh);
    } catch {
      // gone meanwhile (its account deleted)
    }
  }
  if (renew) renew();
  return true;
}

/**
 * The cron job: passes until the minute is nearly over; with nothing to do, when a request wakes it. One run at a time.
 * @param {core.App} app
 */
function run(app) {
  require(`${__hooks}/lib/worker.js`).run(app, {
    name: LOCK,
    label: "account",
    staleMs: STALE_MS,
    wakes: true,
    pass: (/** @type {() => void} */ renew) => pass(app, renew),
  });
}

/** A job was queued (committed): the worker looks now. @param {core.App} app */
function wake(app) {
  require(`${__hooks}/lib/worker.js`).wake(app, LOCK);
}

/**
 * POST /api/account/tick (superusers): every queued job done now (tests; ACCOUNT_CRON=off).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  for (let i = 0; i < 10_000 && pass(e.app); i++);
  return e.noContent(204);
}

module.exports = { changePassword, deleteAccount, erase, exportFile, exportState, run, startExport, tick };
