/// <reference path="../../types/pocketbase.d.ts" />
// The federation worker (DESIGN.md §33.8), as the Telegram bridge's (§26.7): a cron job starts it every minute and it
// runs for most of that minute, once a second. Per peer, in order: the queued events go in batches of up to 50, then
// files and avatars are fetched. A row being worked on is claimed (locked_until), so it is handled once. What failed
// for now (no answer, 5xx, 429) is tried again after 2, 4, 8… seconds, at most 10 minutes; rows are kept 3 days. A 4xx
// is dropped at once. fed_peers.last_ok and last_error show how a peer is doing. POST /api/fed/tick runs a pass now.

const { isActive, jsonOf, peerHost } = require(`${__hooks}/federation/config.js`);
const { call, errorOf, jsonBody } = require(`${__hooks}/federation/net.js`);
const { applyFiles, applyMessage, MAX_FILES } = require(`${__hooks}/federation/messages.js`);
const { setDown } = require(`${__hooks}/federation/rooms.js`);
const { isLost } = require(`${__hooks}/lib/worker.js`);

const LOCK = "federation.worker";
const STALE_MS = 90_000;
const CLAIM_MS = 10 * 60_000;
const BATCH = 50;
/** Fetches per peer in one pass: files can be big. */
const WORK_BATCH = 5;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_WAIT_S = 600;
/** A peer is shown as unreachable after this many failed tries in a row. */
const DOWN_AFTER = 3;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_AVATAR = 5 * 1024 * 1024;

/**
 * Claim queue row `id` unless another pass has it, or it isn't due yet.
 * @param {core.App} app
 * @param {string} id
 */
function claim(app, id) {
  let mine = false;
  app.runInTransaction((tx) => {
    let row;
    try {
      row = tx.findRecordById("fed_queue", id);
    } catch {
      return;
    }
    const now = Date.now();
    const until = row.getDateTime("locked_until");
    const due = row.getDateTime("next_at");
    if (!until.isZero() && until.time().unixMilli() > now) return;
    if (!due.isZero() && due.time().unixMilli() > now) return;
    row.set("locked_until", new DateTime(new Date(now + CLAIM_MS).toISOString()));
    tx.save(row);
    mine = true;
  });
  return mine;
}

/**
 * Try a row again later.
 * @param {core.App} app
 * @param {core.Record} row
 * @param {string} error
 * @returns {number} its tries so far
 */
function retry(app, row, error) {
  const tries = row.getInt("tries") + 1;
  const wait = Math.min(2 ** tries, MAX_WAIT_S) * 1000;
  row.set("tries", tries);
  row.set("next_at", new DateTime(new Date(Date.now() + wait).toISOString()));
  row.set("locked_until", "");
  row.set("error", error.slice(0, 1000));
  app.save(row);
  return tries;
}

/**
 * Note how the peer is doing (§33.8): last_ok, last_error, and its rooms shown as unreachable or not (§33.7).
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {string} error "" when it answered
 * @param {number} [tries] of the item that failed
 */
function note(app, peer, error, tries = 0) {
  const key = `fed.down.${peer.id}`;
  if (!error) {
    const last = peer.getDateTime("last_ok");
    if (peer.getString("last_error") || last.isZero() || Date.now() - last.time().unixMilli() > 60_000) {
      peer.set("last_ok", new DateTime());
      peer.set("last_error", "");
      app.save(peer);
    }
    if (app.store().get(key)) {
      app.store().remove(key);
      setDown(app, peer.id, false);
    }
    return;
  }
  peer.set("last_error", error.slice(0, 1000));
  app.save(peer);
  if (tries >= DOWN_AFTER && !app.store().get(key)) {
    app.store().set(key, true);
    setDown(app, peer.id, true);
  }
}

/**
 * Send the peer's queued events, oldest first, up to BATCH at once (stopping at one that isn't due).
 * @param {core.App} app
 * @param {core.Record} peer
 */
function sendEvents(app, peer) {
  const rows = app.findRecordsByFilter("fed_queue", "peer = {:p} && op = 'event'", "seq", BATCH, 0, { p: peer.id });
  /** @type {core.Record[]} */
  const batch = [];
  for (const row of rows) {
    if (!row || !claim(app, row.id)) break;
    batch.push(app.findRecordById("fed_queue", row.id));
  }
  if (!batch.length) return;
  const events = batch.map((r) => jsonOf(r, "payload", {}));
  /** @type {ReturnType<typeof call> | null} */
  let answer = null;
  let error = "";
  try {
    answer = call(peer, "POST", "/api/fed/inbox", { events });
  } catch (err) {
    error = String(err);
  }
  if (answer && answer.status === 200) {
    const results = jsonBody(answer)?.results;
    /** @type {Record<string, any>} */
    const byId = {};
    for (const r of Array.isArray(results) ? results : []) if (r && typeof r.id === "string") byId[r.id] = r;
    let refused = "";
    for (const row of batch) {
      const r = byId[row.id];
      const status = r ? Number(r.status) : 503;
      if (status >= 500 || status === 429) {
        retry(app, row, `${status} ${r?.error || "no result"}`);
        continue;
      }
      if (status >= 400) {
        refused = `${jsonOf(row, "payload", {}).type}: ${status} ${r?.error || ""}`;
        app.logger().warn("federation: event refused by peer", "peer", peerHost(peer), "event", row.id, "result", refused);
      }
      app.delete(row);
    }
    note(app, peer, refused);
    return;
  }
  if (answer && answer.status >= 400 && answer.status < 500 && answer.status !== 429) {
    error = errorOf(answer);
    app.logger().error("federation: events dropped", "peer", peerHost(peer), "count", batch.length, "error", error);
    for (const row of batch) app.delete(row);
    note(app, peer, error);
    return;
  }
  if (answer) error = errorOf(answer);
  let tries = 0;
  for (const row of batch) tries = Math.max(tries, retry(app, row, error));
  note(app, peer, error, tries);
}

/**
 * A temp file for a download.
 */
const tempPath = () => `${$os.tempDir()}/chirkle-fed-${$security.randomString(16)}`;

/**
 * A name to store a fetched file under (PocketBase's style: safe characters, a random suffix).
 * @param {string} original
 */
function storedName(original) {
  const dot = original.lastIndexOf(".");
  const ext =
    dot > 0
      ? original
          .slice(dot)
          .toLowerCase()
          .replace(/[^a-z0-9.]/g, "")
          .slice(0, 10)
      : "";
  const stem =
    (dot > 0 ? original.slice(0, dot) : original)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "file";
  return `${stem}_${$security.randomStringWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789")}${ext}`;
}

/** Thrown for a fetch that may work later. */
class Later extends Error {}

/**
 * Fetch a peer file to a temp file: its path, "" when the peer says it is gone (or too big). Throws Later otherwise.
 * @param {core.Record} peer
 * @param {string} path
 * @param {number} max
 */
function download(peer, path, max) {
  const out = tempPath();
  let answer;
  try {
    answer = call(peer, "GET", path, undefined, { out, max, seconds: 120 });
  } catch (err) {
    throw new Later(String(err));
  }
  const there = (() => {
    try {
      return $os.stat(out).size() > 0;
    } catch {
      return false;
    }
  })();
  if (answer.status === 200 && there) return out;
  try {
    $os.remove(out);
  } catch {
    // never written
  }
  if (answer.status >= 500 || answer.status === 429) throw new Later(errorOf(answer));
  return "";
}

/**
 * A message that came with files (§33.5): fetch them from the peer that sent it, then save it.
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {any} payload
 */
function fetchMessage(app, peer, payload) {
  const ev = payload.event || {};
  // A message's, or (a `files` event) a message's new attachments.
  const refiled = ev.type === "files";
  const src = refiled ? ev.files : ev.message?.files;
  const listed = (Array.isArray(src) ? src : []).slice(0, MAX_FILES);
  /** @type {string[]} */
  const temps = [];
  try {
    /** @type {any[]} */
    const uploads = [];
    for (const f of listed) {
      const path = typeof f?.path === "string" && f.path.startsWith("/api/fed/files/") ? f.path : "";
      if (!path) continue;
      const tmp = download(peer, path, MAX_FILE);
      if (!tmp) continue;
      temps.push(tmp);
      const up = $filesystem.fileFromPath(tmp);
      const name = String(f.name || "file").slice(0, 200);
      up.name = storedName(name);
      up.originalName = name;
      uploads.push(up);
    }
    app.runInTransaction((tx) => {
      if (refiled) applyFiles(tx, peer, ev, uploads);
      else applyMessage(tx, peer, ev, uploads);
    });
  } finally {
    for (const t of temps) {
      try {
        $os.remove(t);
      } catch {
        // gone
      }
    }
  }
}

/**
 * A stand-in's picture changed (§33.4): fetch it, unless a newer one was asked for meanwhile.
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {any} payload
 */
function fetchAvatar(app, peer, payload) {
  let row;
  try {
    row = app.findFirstRecordByFilter("fed_people", "user = {:u} && kind = 'standin'", { u: String(payload.user || "") });
  } catch {
    return;
  }
  if (row.getString("avatar") !== payload.key) return;
  const path = String(payload.path || "");
  if (!path.startsWith("/api/fed/avatars/")) return;
  const tmp = download(peer, path, MAX_AVATAR);
  if (!tmp) return;
  try {
    const user = app.findRecordById("users", row.getString("user"));
    const up = $filesystem.fileFromPath(tmp);
    up.name = storedName(String(payload.key));
    up.originalName = String(payload.key);
    user.set("avatar", up);
    app.save(user);
  } finally {
    try {
      $os.remove(tmp);
    } catch {
      // gone
    }
  }
}

/**
 * Fetch what came from the peer and waits for its files, or avatars, oldest first.
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {() => void} renew
 */
function doWork(app, peer, renew) {
  const rows = app.findRecordsByFilter("fed_queue", "peer = {:p} && op != 'event'", "seq", WORK_BATCH, 0, { p: peer.id });
  for (const r of rows) {
    if (!r || !claim(app, r.id)) break;
    const row = app.findRecordById("fed_queue", r.id);
    const payload = jsonOf(row, "payload", {});
    try {
      if (row.getString("op") === "fetch") fetchMessage(app, peer, payload);
      else fetchAvatar(app, peer, payload);
      app.delete(row);
    } catch (err) {
      if (err instanceof Later) {
        const tries = retry(app, row, String(err.message));
        note(app, peer, String(err.message), tries);
        break; // in order: the rest wait for it
      }
      app.logger().warn(`federation: ${row.getString("op")} dropped`, "peer", peerHost(peer), "error", String(err));
      app.delete(row);
    } finally {
      renew();
    }
  }
}

/**
 * Drop what is older than 3 days: queue rows (logged) and the ids of events taken.
 * @param {core.App} app
 */
function prune(app) {
  const before = new Date(Date.now() - KEEP_MS).toISOString().replace("T", " ");
  for (const row of app.findRecordsByFilter("fed_queue", "created < {:t}", "created", 100, 0, { t: before })) {
    if (!row) continue;
    app
      .logger()
      .error("federation: dropped after 3 days", "op", row.getString("op"), "peer", row.getString("peer"), "error", row.getString("error"));
    app.delete(row);
  }
  app.db().newQuery("DELETE FROM fed_seen WHERE created < {:t}").bind({ t: before }).execute();
}

/**
 * One pass over every active peer. `renew` (the worker's lock) after each item.
 * @param {core.App} app
 * @param {() => void} renew
 */
function pass(app, renew) {
  prune(app);
  for (const peer of app.findRecordsByFilter("fed_peers", "status = 'active'", "created", 0, 0)) {
    if (!peer || !isActive(peer)) continue;
    try {
      sendEvents(app, peer);
      renew();
      doWork(app, peer, renew);
    } catch (err) {
      if (isLost(err)) throw err;
      app.logger().error("federation: worker", "peer", peerHost(peer), "error", String(err));
    }
  }
}

/**
 * The cron job (lib/worker.js): passes, once a second, until the minute is nearly over; pending requests every 30 s.
 * @param {core.App} app
 */
function run(app) {
  let pendingAt = 0;
  require(`${__hooks}/lib/worker.js`).run(app, {
    ...worker(app),
    pass: (/** @type {() => void} */ renew) => {
      if (Date.now() - pendingAt >= PENDING_MS) {
        pending(app);
        pendingAt = Date.now();
      }
      pass(app, renew);
    },
  });
}

/** @param {core.App} app */
const worker = (app) => ({
  name: LOCK,
  label: "federation",
  staleMs: STALE_MS,
  pass: (/** @type {() => void} */ renew) => pass(app, renew),
});

/** How often a run looks at pending pairing requests. */
const PENDING_MS = 30_000;

/**
 * Pending pairing requests (§33.3), every 30 s of a run and on every tick: sent again until delivered, ended once
 * expired.
 * @param {core.App} app
 */
function pending(app) {
  try {
    require(`${__hooks}/federation/peers.js`).pendingPass(app);
  } catch (err) {
    app.logger().error("federation: pending requests", "error", String(err));
  }
}

/**
 * POST /api/fed/tick (superusers): one pass now, unless a run is going (it does the work within a second).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  pending(e.app);
  const ran = require(`${__hooks}/lib/worker.js`).once(e.app, worker(e.app));
  return e.json(ran ? 200 : 202, { ran });
}

module.exports = { run, tick };
