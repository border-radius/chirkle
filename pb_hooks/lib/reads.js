/// <reference path="../../types/pocketbase.d.ts" />
// Unread counts (DESIGN.md §18): GET /api/chat/unread and POST /api/chat/reads.

const { SEES_SQL, visibleRoom } = require(`${__hooks}/lib/access.js`);

/**
 * Unread messages per room the caller can see (§23.1): other people's, not deleted, newer than the caller's read position
 * (or their signup, for a room they never opened). One correlated count per room, so each one is a range scan on
 * idx_messages_room_created, stopped at UNREAD_CAP (the badge shows "99+" past 99, so more is never needed).
 * Hidden and archived rooms are counted too; the client doesn't show those (§18.4).
 */
const UNREAD_CAP = 100;
const UNREAD_SQL = `
SELECT room, n FROM (
  SELECT r.id AS room, (
    SELECT COUNT(*) FROM (
      SELECT 1 FROM messages m
      WHERE m.room = r.id
        AND m.created > MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = r.id), ''), {:since})
        AND m.author != {:me}
        AND m.deleted = FALSE
      LIMIT ${UNREAD_CAP}
    )
  ) AS n
  FROM rooms r
  WHERE ${SEES_SQL}
) WHERE n > 0`;

/** How far back GET /api/chat/unread lists the messages its counts already account for (QA BUG-106). */
const ACCOUNTED_MS = 30_000;

/**
 * UNREAD_SQL's rows (`id` "") and, in the same statement so from the same snapshot, the ids of other people's
 * messages in the rooms the caller sees created since {:from} (`room` ""): whatever its read position, the counts
 * account for each of them. Their live events arrive late (or during the request), so the client skips those instead
 * of guessing from `created`, which says nothing about when a message was committed (QA BUG-106). CROSS JOIN keeps
 * rooms the outer loop (SQLite doesn't reorder it), so each room is a range scan on idx_messages_room_created, not a
 * scan of every message (an integration test pins the plan).
 */
const COUNTS_SQL = `
SELECT room, n, '' AS id FROM (${UNREAD_SQL})
UNION ALL
SELECT * FROM (
  SELECT '' AS room, 0 AS n, m.id AS id FROM rooms r CROSS JOIN messages m ON m.room = r.id
  WHERE ${SEES_SQL}
    AND m.created > {:from}
    AND m.author != {:me}
  LIMIT 1000
)`;

/** The oldest unread message in one room, by the same rule as UNREAD_SQL (§18.2). */
const FIRST_UNREAD_SQL = `
SELECT m.id, m.created FROM messages m
WHERE m.room = {:room}
  AND m.created > MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = {:room}), ''), {:since})
  AND m.author != {:me}
  AND m.deleted = FALSE
ORDER BY m.created, m.id
LIMIT 1`;

/** @param {core.RequestEvent} e */
function me(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  return e.auth;
}

/** @param {string} message */
const badRequest = (message) =>
  new BadRequestError("Failed to mark the room as read.", { at: new ValidationError("validation_invalid_value", message) });

/**
 * GET /api/chat/unread → { at, rooms: { "<roomId>": count }, ids } for every room with unread messages (at most
 * UNREAD_CAP each). `at` is when the counts were taken. `ids` are the recent messages (ACCOUNTED_SQL) the counts
 * account for: the client adds the live ones it gets that aren't among them, and only those (§18.3, QA BUG-106).
 * @param {core.RequestEvent} e
 */
function unread(e) {
  const user = me(e);
  const at = new DateTime().string();
  const rows = arrayOf(new DynamicModel({ room: "", n: 0, id: "" }));
  e.app
    .db()
    .newQuery(COUNTS_SQL)
    // {:from} in PocketBase's format, "2006-01-02 15:04:05.000Z".
    .bind({ me: user.id, since: user.getString("created"), from: new Date(Date.now() - ACCOUNTED_MS).toISOString().replace("T", " ") })
    .all(rows);
  /** @type {Record<string, number>} */
  const out = {};
  /** @type {string[]} */
  const ids = [];
  for (const row of rows) {
    if (row.id) ids.push(row.id);
    else out[row.room] = row.n;
  }
  // The inbox's unseen rows and each room's unread mentions and replies (§41).
  const { inbox, mentions } = require(`${__hooks}/lib/inbox.js`).counts(e.app, user);
  return e.json(200, { at, rooms: out, ids, inbox, mentions });
}

/**
 * GET /api/chat/unread/{room} → { id, created } of the oldest message in `room` that is unread for the caller, or
 * { id: "", created: "" } when there is none. The room view opens there (§18.5).
 * @param {core.RequestEvent} e
 */
function firstUnread(e) {
  const user = me(e);
  const roomId = e.request?.pathValue("room") ?? "";
  if (!visibleRoom(e.app, roomId, user.id)) throw new NotFoundError("The room doesn't exist.");
  const row = new DynamicModel({ id: "", created: "" });
  try {
    e.app
      .db()
      .newQuery(FIRST_UNREAD_SQL)
      .bind({ me: user.id, room: roomId, since: user.getString("created") })
      .one(row);
  } catch {
    // No rows: nothing unread.
  }
  return e.json(200, { id: row.id, created: row.created });
}

/**
 * @param {core.App} app
 * @param {string} user
 * @param {string} room
 */
function findRead(app, user, room) {
  try {
    return app.findFirstRecordByFilter("room_reads", "user = {:user} && room = {:room}", { user, room });
  } catch {
    return null;
  }
}

/**
 * POST /api/chat/reads { room, at? }: the caller has read `room` up to `at` (a message's `created`; default now).
 * Never moves the read position back, and never past now. Idempotent.
 * @param {core.RequestEvent} e
 */
function markRead(e) {
  const user = me(e);
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const roomId = typeof body.room === "string" ? body.room : "";
  // Someone else's DM (or private room) gets the same answer as a room that doesn't exist.
  if (!roomId || !visibleRoom(e.app, roomId, user.id)) throw new NotFoundError("The room doesn't exist.");

  const now = new DateTime();
  let at = now;
  if (body.at !== undefined) {
    // "" too: DateTime("") would be now, which a client sending a message's `created` never means.
    if (typeof body.at !== "string" || body.at === "") throw badRequest("Must be a date.");
    try {
      at = new DateTime(body.at);
    } catch {
      throw badRequest("Must be a date.");
    }
    if (at.isZero()) throw badRequest("Must be a date.");
    if (at.after(now)) at = now;
  }

  let row = findRead(e.app, user.id, roomId);
  if (!row) {
    const created = new Record(e.app.findCollectionByNameOrId("room_reads"));
    created.set("user", user.id);
    created.set("room", roomId);
    created.set("last_read_at", at);
    try {
      e.app.save(created);
      return e.json(200, { room: roomId, last_read_at: created.getString("last_read_at") });
    } catch (err) {
      // Lost a race with another tab: the unique (user, room) index kept it to one row. Update that one.
      row = findRead(e.app, user.id, roomId);
      if (!row) throw err;
    }
  }
  if (at.after(row.getDateTime("last_read_at"))) {
    row.set("last_read_at", at);
    e.app.save(row);
  }
  return e.json(200, { room: roomId, last_read_at: row.getString("last_read_at") });
}

module.exports = { unread, firstUnread, markRead };
