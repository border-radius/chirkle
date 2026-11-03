/// <reference path="../../types/pocketbase.d.ts" />
// Acting on several messages at once (DESIGN.md §21): POST /api/chat/delete soft-deletes the caller's own messages,
// POST /api/chat/forward forwards messages the caller can see into another room or DM, pointing at them (nothing is copied). All or nothing: each runs in one
// transaction. The saves go through the messages hooks (messages.js) like any other, so the soft delete wipes what it
// should, a forward is checked like a new message, and realtime tells everyone.

const { canWrite } = require(`${__hooks}/lib/access.js`);
const { isService } = require(`${__hooks}/lib/messages.js`);
const { canModerate } = require(`${__hooks}/lib/moderation.js`);

/** Most messages one request may act on (MAX_SELECTED in web/src/lib/limits.ts). */
const MAX_MESSAGES = 50;

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [what]
 */
const badRequest = (field, message, what = "Failed to update the messages.") =>
  new BadRequestError(what, { [field]: new ValidationError("validation_invalid_value", message) });

/**
 * The message ids of the request body: distinct, 1 to MAX_MESSAGES of them.
 * @param {Record<string, unknown>} body
 * @param {string} what
 */
function messageIds(body, what) {
  const raw = body.messages;
  if (!Array.isArray(raw) || !raw.length || raw.some((id) => typeof id !== "string" || !id)) {
    throw badRequest("messages", "Choose at least one message.", what);
  }
  const ids = [.../** @type {Set<string>} */ (new Set(raw))];
  if (ids.length > MAX_MESSAGES) throw badRequest("messages", `At most ${MAX_MESSAGES} messages at a time.`, what);
  return ids;
}

/**
 * Can the caller see `rec` where it is (its collection's list rule)? Not the messages view rule, which also lets the
 * readers of a forward view its original (§21.3), in a room they can't see. Someone else's DM gets the same answer
 * as a record that doesn't exist.
 * @param {core.RequestEvent} e
 * @param {core.RequestInfo} info
 * @param {string} collection
 * @param {string} id
 * @returns {core.Record | null}
 */
function visible(e, info, collection, id) {
  let rec;
  try {
    rec = e.app.findRecordById(collection, id);
  } catch {
    return null;
  }
  const rule = e.app.findCollectionByNameOrId(collection).listRule;
  return rule !== null && rule !== undefined && e.app.canAccessRecord(rec, info, rule) ? rec : null;
}

/**
 * The messages with these ids, oldest first (as they are shown), all visible to the caller; else a 404.
 * @param {core.RequestEvent} e
 * @param {core.RequestInfo} info
 * @param {string[]} ids
 */
function visibleMessages(e, info, ids) {
  const found = ids.map((id) => visible(e, info, "messages", id));
  if (found.some((m) => !m)) throw new NotFoundError("A message doesn't exist.");
  const msgs = /** @type {core.Record[]} */ (found);
  const key = (/** @type {core.Record} */ m) => `${m.getString("created")}|${m.id}`;
  return msgs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * The saved messages as GET /api/collections/messages/records/:id answers them (the same ?expand and ?fields apply).
 * @param {core.RequestEvent} e
 * @param {core.Record[]} recs
 */
function answer(e, recs) {
  $apis.enrichRecords(e, recs);
  return e.json(200, recs);
}

/**
 * POST /api/chat/delete { messages: [ids] } → the messages, soft-deleted (§21.2). Only the caller's own, in rooms that
 * aren't archived and they may still post in; a moderator's, anyone's outside DMs (§36). Already deleted ones are left
 * as they are, so a retry succeeds.
 * @param {core.RequestEvent} e
 */
function deleteMessages(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const what = "Failed to delete the messages.";
  const info = e.requestInfo();
  const msgs = visibleMessages(e, info, messageIds(/** @type {Record<string, unknown>} */ (info.body), what));
  const rooms = msgs.map((m) => e.app.findRecordById("rooms", m.getString("room")));
  const moderating = rooms.map((r) => canModerate(r, me));
  if (msgs.some((m, i) => m.getString("author") !== me.id && !moderating[i])) {
    throw new ForbiddenError("You can only delete your own messages.");
  }
  // The app's own lines stay (no author has them; only a moderator gets this far).
  if (msgs.some(isService)) throw badRequest("messages", "Service messages can't be deleted.", what);
  // (Archived meanwhile: beforeMessageUpdate refuses the save, and the transaction rolls back.)
  if (rooms.some((r) => r.getBool("archived"))) throw badRequest("messages", "This room is archived and read-only.", what);
  // As the update rule says: no longer allowed to post there, no deleting either (§23.6). Moderators still can.
  if (rooms.some((r, i) => !moderating[i] && !canWrite(r, me.id))) {
    throw badRequest("messages", "Only some people can post in this room.", what);
  }

  /** @type {core.Record[]} */
  const saved = [];
  e.app.runInTransaction((tx) => {
    for (const m of msgs) {
      const rec = tx.findRecordById("messages", m.id);
      saved.push(rec);
      if (rec.getBool("deleted")) continue;
      rec.set("deleted", true);
      tx.save(rec);
    }
  });
  return answer(e, saved);
}

/**
 * What a message shows when forwarded (§21.3): itself, or for a forward, the message it shows. Null when that is
 * deleted, or gone (a forward whose original was removed for good shows nothing).
 * @param {core.App} app
 * @param {core.Record} m
 */
function originalOf(app, m) {
  if (m.getBool("deleted")) return null;
  const id = m.getString("forward_of");
  if (!id) {
    const empty = m.getString("text") === "" && m.getStringSlice("files").length === 0;
    return m.getString("forwarded_from") !== "" && empty ? null : m;
  }
  try {
    const original = app.findRecordById("messages", id);
    return original.getBool("deleted") ? null : original;
  } catch {
    return null;
  }
}

/**
 * POST /api/chat/forward { messages: [ids], room } → the new messages in `room` (§21.3), oldest first, by the caller:
 * forwards pointing at the given messages (`forward_of`; a forward of a forward points at its original), showing their
 * text and attachments as they are now, and saying who first wrote them (`forwarded_from`). Nothing is copied, so a
 * forward costs a row however big its attachments are. Replies, reactions and edit stamps aren't forwarded.
 * @param {core.RequestEvent} e
 */
function forward(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const what = "Failed to forward the messages.";
  const info = e.requestInfo();
  const body = /** @type {Record<string, unknown>} */ (info.body);
  const ids = messageIds(body, what);
  const room = visible(e, info, "rooms", typeof body.room === "string" ? body.room : "");
  if (!room) throw new NotFoundError("The room doesn't exist.");
  if (room.getBool("archived")) throw badRequest("room", "This room is archived and read-only.", what);
  const originals = visibleMessages(e, info, ids).map((m) => originalOf(e.app, m));
  if (originals.some((m) => !m)) throw badRequest("messages", "A message was deleted.", what);
  if (originals.some((m) => m && isService(m))) throw badRequest("messages", "Service messages can't be forwarded.", what);

  const collection = e.app.findCollectionByNameOrId("messages");
  /** @type {core.Record[]} */
  const saved = [];
  e.app.runInTransaction((tx) => {
    // One millisecond apart, so they keep their order: messages sort by (created, id), and ids are random.
    const now = Date.now();
    /** @type {core.Record[]} */ (originals).forEach((src, i) => {
      const rec = new Record(collection);
      const at = new Date(now + i).toISOString().replace("T", " ");
      rec.setRaw("created", at);
      rec.setRaw("updated", at);
      rec.set("room", room.id);
      rec.set("author", me.id);
      rec.set("text", "");
      rec.set("forward_of", src.id);
      rec.set("forwarded_from", src.getString("forwarded_from") || src.getString("author"));
      tx.save(rec);
      saved.push(rec);
    });
  });
  return answer(e, saved);
}

module.exports = { deleteMessages, forward, MAX_MESSAGES };
