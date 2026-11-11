/// <reference path="../../types/pocketbase.d.ts" />
// Retention (REFACTOR item 49, DESIGN.md §2): tables that only grew get a daily prune, as statistics (lib/stats.js)
// and the federation queues (federation/worker.js) already had.
//
// - `inbox` (§41): a person's newest INBOX_KEEP rows, none older than INBOX_DAYS. The list pages back no further than
//   that, and the counts (server/unread.go) stop at 100 anyway.
// - Rows left behind by deletes that skipped the hooks (raw SQL, an old migration, a crash between two saves): inbox
//   rows of a deleted (or soft-deleted) message, room, person or actor; room reads, inbox reads and hidden rooms of a
//   person or room that is gone; media rows (§30) and link preview jobs (§28) of a soft-deleted or gone message (a
//   forward's media rows go with its original, as lib/media.js drop() does). PocketBase's cascades only run for
//   deletes it makes itself.
//
// Messages are never pruned: history is kept (DESIGN.md §2). A retention period for them would be the owner's choice.

/** The inbox rows kept per person, newest first. */
const INBOX_KEEP = 500;
/** No inbox row older than this many days. */
const INBOX_DAYS = 180;

/** A live message: there and not soft-deleted. @param {string} col */
const live = (col) => `EXISTS (SELECT 1 FROM messages m WHERE m.id = ${col} AND m.deleted = FALSE)`;
/** @param {string} table @param {string} col */
const there = (table, col) => `EXISTS (SELECT 1 FROM ${table} t WHERE t.id = ${col})`;

/** What a prune deletes, by name: [label, SQL]. {:before} is INBOX_DAYS ago. */
const STEPS = [
  ["inbox_old", "DELETE FROM inbox WHERE created < {:before}"],
  [
    "inbox_over",
    `DELETE FROM inbox WHERE id IN (
       SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user ORDER BY created DESC, id DESC) AS n FROM inbox)
       WHERE n > ${INBOX_KEEP})`,
  ],
  [
    "inbox_orphans",
    `DELETE FROM inbox WHERE NOT ${live("inbox.message")} OR NOT ${there("rooms", "inbox.room")}
       OR NOT ${there("users", "inbox.user")} OR NOT ${there("users", "inbox.actor")}`,
  ],
  [
    "room_reads_orphans",
    `DELETE FROM room_reads WHERE NOT ${there("users", "room_reads.user")} OR NOT ${there("rooms", "room_reads.room")}`,
  ],
  ["inbox_reads_orphans", `DELETE FROM inbox_reads WHERE NOT ${there("users", "inbox_reads.user")}`],
  [
    "hidden_rooms_orphans",
    `DELETE FROM hidden_rooms WHERE NOT ${there("users", "hidden_rooms.user")} OR NOT ${there("rooms", "hidden_rooms.room")}`,
  ],
  ["media_orphans", `DELETE FROM media WHERE NOT ${live("media.message")} OR (media.source != '' AND NOT ${live("media.source")})`],
  ["link_queue_orphans", `DELETE FROM link_queue WHERE NOT ${live("link_queue.message")}`],
];

/** PocketBase's date text for `ms`. @param {number} ms */
const dbDate = (ms) => new Date(ms).toISOString().replace("T", " ");

/**
 * The daily prune. Returns how many rows each step deleted; logs them when there were any.
 * @param {core.App} app
 * @param {number} [now]
 * @returns {Record<string, number>}
 */
function prune(app, now = Date.now()) {
  /** @type {Record<string, number>} */
  const deleted = {};
  const before = dbDate(now - INBOX_DAYS * 24 * 3600_000);
  for (const [label, sql] of STEPS) {
    try {
      const res = app.db().newQuery(sql).bind({ before }).execute();
      deleted[label] = Number(res.rowsAffected());
    } catch (err) {
      deleted[label] = -1;
      app.logger().error("retention: a prune step failed", "step", label, "error", String(err));
    }
  }
  if (Object.values(deleted).some((n) => n !== 0)) app.logger().info("retention: pruned", ...Object.entries(deleted).flat());
  const failed = Object.entries(deleted).filter(([, n]) => n < 0);
  require(`${__hooks}/lib/worker.js`).noted(app, "retention", failed.length ? `failed: ${failed.map(([k]) => k).join(", ")}` : undefined);
  return deleted;
}

/** POST /api/retention/tick (superusers, tests): a prune now → { deleted: { step: rows } }. @param {core.RequestEvent} e */
function tick(e) {
  return e.json(200, { deleted: prune(e.app) });
}

module.exports = { INBOX_KEEP, INBOX_DAYS, prune, tick };
