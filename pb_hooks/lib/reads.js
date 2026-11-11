/// <reference path="../../types/pocketbase.d.ts" />
// Read positions (DESIGN.md §18): POST /api/chat/reads. The counts (GET /api/chat/unread, /api/chat/unread/{room}) are
// the Go server's (server/unread.go).

const { visibleRoom } = require(`${__hooks}/lib/access.js`);

/** @param {core.RequestEvent} e */
function me(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  return e.auth;
}

/** @param {string} message */
const badRequest = (message) =>
  new BadRequestError("Failed to mark the room as read.", { at: new ValidationError("validation_invalid_value", message) });

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

module.exports = { markRead };
