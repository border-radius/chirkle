/// <reference path="../../types/pocketbase.d.ts" />
// The bridge's worker (DESIGN.md §38.8), on lib/worker.js like Telegram's: a cron job starts it every minute and it
// runs for most of that minute, once a second. Each pass looks at the child (started again when it went quiet), tells
// it the conferences to be in when they changed, and has it send what is queued, oldest first. One runs at a time;
// POST /api/xmpp/tick runs one pass at once (tests, or an admin who doesn't want to wait).

const child = require(`${__hooks}/xmpp/child.js`);
const { wanted } = require(`${__hooks}/xmpp/links.js`);
const { edit, remove, send } = require(`${__hooks}/xmpp/outbound.js`);

const LOCK = "xmpp.worker";
/** What the child was last told to be in, with its boot: told again when either changes. */
const SENT = "xmpp.rooms";
/** A lock not renewed for this long was left by a run that died (lib/worker.js). */
const STALE_MS = 90_000;
/** A queue row being sent is claimed for this long: no other pass sends it meanwhile (as in §26.7). */
const CLAIM_MS = 5 * 60_000;
/** How many times a send that failed for now is tried before it is dropped. */
const MAX_TRIES = 8;
const BATCH = 50;

/**
 * Tell the child the conferences to be in, when they aren't what it was last told (or it is a new child).
 * @param {core.App} app
 */
function syncRooms(app) {
  const c = child.current(app);
  if (!c?.port) return;
  const rooms = wanted(app);
  // `since` moves with every message: it isn't a change to tell the child about (it keeps its own).
  const sig = `${c.boot} ${JSON.stringify(rooms.map((/** @type {{ muc: string, key: string, password: string }} */ r) => [r.muc, r.key, r.password]))}`;
  if (app.store().get(SENT) === sig) return;
  try {
    child.call(app, "/rooms", { rooms });
    app.store().set(SENT, sig);
  } catch (err) {
    app.logger().warn("xmpp: rooms", "error", String(err));
  }
}

/**
 * Claim queue row `id` for sending (locked_until), unless another pass has it.
 * @param {core.App} app
 * @param {string} id
 */
function claim(app, id) {
  let mine = false;
  app.runInTransaction((tx) => {
    let row;
    try {
      row = tx.findRecordById("xmpp_queue", id);
    } catch {
      return; // done by another pass
    }
    const until = row.getDateTime("locked_until");
    if (!until.isZero() && until.time().unixMilli() > Date.now()) return;
    row.set("locked_until", new DateTime(new Date(Date.now() + CLAIM_MS).toISOString()));
    tx.save(row);
    mine = true;
  });
  return mine;
}

/**
 * Send what is queued, oldest first. A conference whose oldest item has to wait (a failure that may pass, or another
 * pass sending it) gets nothing more this pass, so its messages arrive in order. `renew` after each one.
 * @param {core.App} app
 * @param {() => void} renew
 */
function drain(app, renew) {
  const c = child.current(app);
  if (!c?.port) return; // nothing can go before the child says hello
  const rows = app.findRecordsByFilter("xmpp_queue", "", "created,id", BATCH, 0);
  const blocked = new Set();
  const now = Date.now();
  for (const row of rows) {
    if (!row) continue;
    const muc = row.getString("muc");
    if (blocked.has(muc)) continue;
    const due = row.getDateTime("next_at");
    if ((!due.isZero() && due.time().unixMilli() > now) || !claim(app, row.id)) {
      blocked.add(muc);
      continue;
    }
    const message = row.getString("message");
    try {
      const op = row.getString("op");
      if (op === "send") send(app, message, muc);
      else if (op === "edit") edit(app, message, muc);
      else if (op === "delete") remove(app, message, muc);
      app.delete(row);
    } catch (err) {
      const tries = row.getInt("tries") + 1;
      const transient = /** @type {any} */ (err).transient !== false;
      app.logger().warn(`xmpp: ${row.getString("op")}`, "message", message, "muc", muc, "try", tries, "error", String(err));
      if (!transient || tries >= MAX_TRIES) {
        app.delete(row);
        continue;
      }
      row.set("tries", tries);
      row.set("next_at", new DateTime(new Date(Date.now() + 2 ** tries * 1000).toISOString()));
      row.set("locked_until", "");
      row.set("error", String(err).slice(0, 1000));
      app.save(row);
      blocked.add(muc);
    } finally {
      renew();
    }
  }
}

/**
 * One pass.
 * @param {core.App} app
 * @param {() => void} renew
 */
function pass(app, renew) {
  child.supervise(app);
  syncRooms(app);
  drain(app, renew);
}

/** The worker (lib/worker.js). */
const worker = (/** @type {core.App} */ app) => ({
  name: LOCK,
  label: "xmpp",
  staleMs: STALE_MS,
  pass: (/** @type {() => void} */ renew) => pass(app, renew),
});

/**
 * The cron job: passes until the minute is nearly over.
 * @param {core.App} app
 */
function run(app) {
  require(`${__hooks}/lib/worker.js`).run(app, worker(app));
}

/**
 * POST /api/xmpp/tick (superusers): one pass now, unless a run is going (it does the work within a second).
 * @param {core.RequestEvent} e
 */
function tick(e) {
  const ran = require(`${__hooks}/lib/worker.js`).once(e.app, worker(e.app));
  return e.json(ran ? 200 : 202, { ran });
}

module.exports = { run, tick, syncRooms };
