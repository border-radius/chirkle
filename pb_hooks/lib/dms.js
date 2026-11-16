/// <reference path="../../types/pocketbase.d.ts" />
// POST /api/chat/dms (DESIGN.md §16.2): get or create the DM between the caller and another user.
// Idempotent, so the client calls it every time someone clicks "Message".

/**
 * @param {string} message
 * @param {string} [code]
 */
function userError(message, code = "validation_invalid_value") {
  return new BadRequestError("Failed to open the conversation.", { user: new ValidationError(code, message) });
}

/**
 * @param {core.App} app
 * @param {string} key
 */
function findByKey(app, key) {
  try {
    return app.findFirstRecordByFilter("rooms", "dm_key = {:key}", { key });
  } catch {
    return null;
  }
}

/**
 * The room as the rooms API returns it to the client (ROOM_FIELDS in web/src/api.ts), with the members
 * expanded to id, name and avatar only (never email).
 * @param {core.App} app
 * @param {core.Record} room
 */
function shape(app, room) {
  const members = room.getStringSlice("members").map((id) => {
    const u = app.findRecordById("users", id);
    return { id: u.id, name: u.getString("name"), avatar: u.getString("avatar") };
  });
  return {
    id: room.id,
    name: room.getString("name"),
    kind: room.getString("kind"),
    visibility: room.getString("visibility"),
    archived: room.getBool("archived"),
    created_by: room.getString("created_by"),
    members: room.getStringSlice("members"),
    posting: room.getString("posting"),
    writers: room.getStringSlice("writers"),
    last_message_at: room.getString("last_message_at"),
    created: room.getString("created"),
    expand: { members },
  };
}

/**
 * The first of these users who doesn't take direct messages (§16.7), or null.
 * @param {core.App} app
 * @param {string[]} ids
 */
function noDmsUser(app, ids) {
  for (const id of ids) {
    try {
      const u = app.findRecordById("users", id);
      if (u.getBool("no_dms")) return u;
    } catch {
      // a member deleted meanwhile: the relation drops it
    }
  }
  return null;
}

/**
 * Why `me` can't write in a DM with these members, or "" when they can.
 * @param {core.App} app
 * @param {string} me
 * @param {string[]} members
 */
function dmRefusal(app, me, members) {
  const u = noDmsUser(app, members);
  if (!u) return "";
  return u.id === me ? "You've turned off direct messages." : `${u.getString("name")} doesn't take direct messages.`;
}

/** @param {core.RequestEvent} e */
function openDm(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body ?? {});
  const other = typeof body.user === "string" ? body.user : "";
  if (!other) throw userError("Choose who to message.", "validation_required");
  if (other === me.id) throw userError("You can't message yourself.");
  try {
    e.app.findRecordById("users", other);
  } catch {
    throw userError("There is no such user.");
  }
  const refused = dmRefusal(e.app, me.id, [me.id, other]);
  if (refused) throw userError(refused);

  const members = [me.id, other].sort();
  const key = members.join(":");
  let room = findByKey(e.app, key);
  if (!room) {
    const created = new Record(e.app.findCollectionByNameOrId("rooms"));
    created.set("kind", "dm");
    created.set("members", members);
    created.set("dm_key", key);
    created.set("created_by", me.id);
    try {
      e.app.save(created);
      room = created;
    } catch (err) {
      // Lost a race with a concurrent call for the same pair: the unique dm_key index kept it to one room.
      room = findByKey(e.app, key);
      if (!room) throw err;
    }
  }

  // Reopen it for the caller if they had closed it (§16.4).
  const rows = e.app.findRecordsByFilter("hidden_rooms", "user = {:user} && room = {:room}", "", 1, 0, { user: me.id, room: room.id });
  for (const row of rows) if (row) e.app.delete(row);

  return e.json(200, shape(e.app, room));
}

module.exports = { openDm, dmRefusal };
