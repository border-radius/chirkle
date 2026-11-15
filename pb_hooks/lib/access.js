/// <reference path="../../types/pocketbase.d.ts" />
// Room access (DESIGN.md §23): who can see a room, the way the rooms view rule says it (CAN_SEE in pb_migrations/
// 1760000014_room_access.js). For hooks and routes that check a room themselves, for SQL that lists rooms, and for
// telling realtime clients about a room they can no longer see. The rule, canSee and SEES_SQL must agree:
// tests/integration/access.matrix.test.ts checks every way in against one table.

/** Most members a private room can have (rooms.members maxSelect). */
const MAX_MEMBERS = 100;

/**
 * What decides who can see a room, copied out of the record (so a hook can keep it from before a save).
 * @typedef {{ id: string, visibility: string, archived: boolean, createdBy: string, members: string[] }} Access
 */

/**
 * @param {core.Record} room
 * @returns {Access}
 */
function accessOf(room) {
  return {
    id: room.id,
    visibility: room.getString("visibility"),
    archived: room.getBool("archived"),
    createdBy: room.getString("created_by"),
    members: room.getStringSlice("members"),
  };
}

/**
 * Can `userId` ("" for a guest) see the room? Open Air rooms that aren't archived: anyone. Otherwise only signed in:
 * any public room, or a private one (DMs too) they are a member or the creator of.
 * @param {Access} a
 * @param {string} userId
 */
function canSee(a, userId) {
  if (a.visibility === "open" && !a.archived) return true;
  if (!userId) return false;
  return a.visibility !== "private" || a.createdBy === userId || a.members.includes(userId);
}

/**
 * Who asks a route for a room: a guest, a signed-in user or a superuser, whom no room is hidden from. canSee is for users
 * only (a mention's target, a member); a request's caller is a viewer. `id` is "" for a guest and for a superuser (a
 * superuser's id is no user's). server/access.go has the same.
 * @typedef {{ id: string, superuser: boolean }} Viewer
 */

/**
 * @param {core.Record | null | undefined} auth
 * @returns {Viewer}
 */
function viewerOf(auth) {
  if (!auth) return { id: "", superuser: false };
  if (auth.isSuperuser()) return { id: "", superuser: true };
  return { id: auth.id, superuser: false };
}

/**
 * canSee for a viewer.
 * @param {Viewer} v
 * @param {Access} a
 */
function sees(v, a) {
  return v.superuser || canSee(a, v.id);
}

/**
 * Can `userId` post in the room (§23.6)? They must see it, signed in, and the room let everyone post or list them as a
 * writer (its creator always is). The messages create rule says the same.
 * @param {core.Record} room
 * @param {string} userId
 */
function canWrite(room, userId) {
  if (!userId || !canSee(accessOf(room), userId)) return false;
  if (room.getString("posting") !== "selected") return true;
  return room.getString("created_by") === userId || room.getStringSlice("writers").includes(userId);
}

/**
 * canSee for a signed-in user, as an SQL condition on `rooms r`, with the user's id bound as {:me}. (Open Air rooms are
 * not private, so no guest case is needed: guests never run these queries.)
 */
const SEES_SQL = "(r.visibility != 'private' OR r.created_by = {:me} OR EXISTS (SELECT 1 FROM json_each(r.members) WHERE value = {:me}))";

/**
 * The room if `v` can see it, else null (also for a room that doesn't exist).
 * @param {core.App} app
 * @param {string} roomId
 * @param {Viewer} v
 */
function visibleRoom(app, roomId, v) {
  let room;
  try {
    room = app.findRecordById("rooms", roomId);
  } catch {
    return null;
  }
  return sees(v, accessOf(room)) ? room : null;
}

/**
 * After a room changed (§23.4): every realtime client that could see it before but can't now gets a `delete` event
 * for it on its rooms subscriptions. PocketBase only sends a change to those who can see the result, so otherwise
 * they would never hear of it: a member taken out of a private room would keep it in their list, and a guest an Open
 * Air room that was archived or made private. Only the id goes out.
 * @param {core.App} app
 * @param {Access} before
 * @param {core.Record} room
 */
function dropLostAccess(app, before, room) {
  const after = accessOf(room);
  // Most saves don't touch access (every DM message saves its room): then there is no one to tell (QA BUG-63).
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const data = JSON.stringify({ action: "delete", record: { id: room.id } });
  const clients = app.subscriptionsBroker().clients();
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    if (!client || client.isDiscarded()) continue;
    const v = viewerOf(/** @type {core.Record | null | undefined} */ (client.get("auth")));
    if (!sees(v, before) || sees(v, after)) continue;
    for (const name of Object.keys(client.subscriptions("rooms"))) client.send(new SubscriptionMessage({ name, data }));
  }
}

module.exports = { MAX_MEMBERS, SEES_SQL, accessOf, canSee, canWrite, viewerOf, sees, visibleRoom, dropLostAccess };
