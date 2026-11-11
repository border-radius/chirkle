/// <reference path="../../types/pocketbase.d.ts" />
// The cron workers' run loop (link previews §28, media §30.1, Telegram §26.7, federation §33.8): a cron job starts a
// run every minute and it goes on for most of that minute, a pass at a time. One run at a time, by a lock in the app
// store holding the run's own handle and when it was last renewed. A lock not renewed for `staleMs` was left by a run
// that died (or is stuck) and is taken over; the old run then stops at its next renew, and its unlock leaves the new
// run's lock alone (QA BUG-147). Passes renew after every item they handle (`renew`), so a slow item can't make the
// lock look stale while it is still being worked on (QA BUG-111).
//
// A worker whose work is queued by this server's own saves can say so (`wakes`): with nothing to do, its run then
// looks for work only when a save wakes it (`wake`, after the save is committed) and every IDLE_MS, not every
// second (docs/PERF.md). The pass every IDLE_MS finds what was queued some other way (a migration, raw SQL).
//
// Each pass notes when it ran (`<name>.last`, epoch ms) and a failed one its error (`<name>.error`, "<ms> <error>"),
// in the app store: GET /api/chat/metrics (server/metrics.go) reports them, with the lock's last renew.

/** How long one run goes on: the next one starts on the next minute. */
const RUN_MS = 57_000;
/** With nothing to do, how often a worker that `wakes` looks for work unwoken. */
const IDLE_MS = 30_000;
/** Thrown by `renew` once the lock is another run's: the pass stops there. */
const LOST = "worker: lock lost";

/** @param {unknown} err */
const isLost = (err) => String(err).includes(LOST);

/**
 * Take lock `name`, unless a run holds it. Returns the run's handle ("" when not taken).
 * @param {core.App} app
 * @param {string} name
 * @param {number} staleMs
 */
function lock(app, name, staleMs) {
  const me = $security.randomString(12);
  let mine = false;
  app.store().setFunc(name, (old) => {
    if (old && Date.now() - Number(String(old).split(" ")[1]) < staleMs) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine ? me : "";
}

/**
 * Renew run `me`'s lock. False when it isn't its lock any more.
 * @param {core.App} app
 * @param {string} name
 * @param {string} me
 */
function beat(app, name, me) {
  let mine = false;
  app.store().setFunc(name, (old) => {
    if (String(old || "").split(" ")[0] !== me) return old;
    mine = true;
    return `${me} ${Date.now()}`;
  });
  return mine;
}

/** @param {core.App} app @param {string} name @param {string} me */
function unlock(app, name, me) {
  app.store().setFunc(name, (old) => (String(old || "").split(" ")[0] === me ? undefined : old));
}

/**
 * @typedef {object} Worker
 * @property {string} name the lock's key in the app store, e.g. "media.worker"
 * @property {string} label how its log lines start, e.g. "media"
 * @property {number} staleMs
 * @property {(renew: () => void) => unknown} pass one pass; call `renew` after each item. Truthy: there may be more
 *   to do now, so the next pass goes at once; otherwise the run waits a second first.
 * @property {boolean} [wakes] its work is queued by saves that call `wake`: idle, it passes only when woken
 */

/**
 * Note a pass of worker `name`: when, and its error if it failed (REFACTOR item 51).
 * @param {core.App} app
 * @param {string} name
 * @param {unknown} [err]
 */
function noted(app, name, err) {
  const now = Date.now();
  app.store().set(`${name}.last`, String(now));
  if (err !== undefined) app.store().set(`${name}.error`, `${now} ${String(err).slice(0, 300)}`);
}

/** The app store's key of worker `name`'s wake-up. @param {string} name */
const wakeKey = (name) => `${name}.wake`;

/**
 * Something was queued for worker `name` (its lock's key): its run passes within a second. Call it once the work is
 * committed: a pass that starts before that wouldn't see it.
 * @param {core.App} app
 * @param {string} name
 */
function wake(app, name) {
  app.store().set(wakeKey(name), true);
}

/**
 * Was worker `name` woken? Then it isn't any more.
 * @param {core.App} app
 * @param {string} name
 */
function woken(app, name) {
  let was = false;
  app.store().setFunc(wakeKey(name), (old) => {
    was = !!old;
    return undefined;
  });
  return was;
}

/**
 * The cron job: passes until the minute is nearly over.
 * @param {core.App} app
 * @param {Worker} w
 */
function run(app, w) {
  const me = lock(app, w.name, w.staleMs);
  if (!me) return;
  const renew = () => {
    if (!beat(app, w.name, me)) throw new Error(LOST);
  };
  try {
    const until = Date.now() + RUN_MS;
    let passed = 0;
    let busy = true;
    while (Date.now() < until) {
      // Idle: a wakes worker passes when woken, or once IDLE_MS have gone by.
      if (w.wakes && !busy && !woken(app, w.name) && Date.now() - passed < IDLE_MS) {
        sleep(1000);
        if (!beat(app, w.name, me)) return;
        continue;
      }
      if (w.wakes) woken(app, w.name); // what was queued before this pass, it sees
      passed = Date.now();
      busy = false;
      try {
        busy = !!w.pass(renew);
        noted(app, w.name);
      } catch (err) {
        if (isLost(err)) return app.logger().warn(`${w.label}: worker took too long, another run took over`);
        noted(app, w.name, err);
        app.logger().error(`${w.label}: worker`, "error", String(err));
      }
      if (!busy) sleep(1000);
      if (!beat(app, w.name, me)) return;
    }
  } finally {
    unlock(app, w.name, me);
  }
}

/**
 * One pass now, holding the lock (a tick route), unless a run holds it: it does the work within a second. Returns
 * whether it ran.
 * @param {core.App} app
 * @param {Worker} w
 */
function once(app, w) {
  const me = lock(app, w.name, w.staleMs);
  if (!me) {
    if (w.wakes) wake(app, w.name);
    return false;
  }
  try {
    w.pass(() => {
      if (!beat(app, w.name, me)) throw new Error(LOST);
    });
    noted(app, w.name);
  } catch (err) {
    if (!isLost(err)) noted(app, w.name, err);
    throw err;
  } finally {
    unlock(app, w.name, me);
  }
  return true;
}

module.exports = { run, once, wake, isLost, lock, beat, unlock, noted };
