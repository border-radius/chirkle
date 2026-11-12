/// <reference path="../../types/pocketbase.d.ts" />
// Anonymous rooms (DESIGN.md §35): a room a superuser marks `anonymous` shows its messages as the room's, not their
// authors'. Each message is stamped when it is made (`anonymous`, `forwarded_anonymous`), so turning the flag on later
// hides nothing already seen, and turning it off shows nothing that was posted unseen. The real author stays stored:
// they still edit and delete their messages, and see them as their own. Everyone else gets, in every answer and live
// event, the room in place of the author, and can't find out who it is by filtering, sorting or expanding on it.

/**
 * What the messages of anonymous room `roomId` show as: its name, and whether it is private. Kept by the app until the
 * room is saved again (forget).
 * @param {core.App} app
 * @param {string} roomId
 * @returns {{ name: string, private: boolean }}
 */
function roomOf(app, roomId) {
  const key = `anonymous.${roomId}`;
  const kept = app.store().get(key);
  if (kept) return { name: String(kept.name), private: !!kept.private };
  // Not with getOrSet: it holds the store while it looks, and finding a record reads PocketBase's collections there.
  let room = { name: "Anonymous", private: true };
  try {
    const rec = app.findRecordById("rooms", roomId);
    room = { name: rec.getString("name") || "Anonymous", private: rec.getString("visibility") === "private" };
  } catch {
    return room; // being removed
  }
  app.store().set(key, room);
  return room;
}

/** @param {core.App} app @param {string} roomId */
const roomName = (app, roomId) => roomOf(app, roomId).name;

/**
 * A forward's "from": the room's name, but not a private room's to readers elsewhere, who may not know it.
 * @param {core.App} app
 * @param {string} roomId
 */
function sourceName(app, roomId) {
  const room = roomOf(app, roomId);
  return room.private ? "Anonymous" : room.name;
}

/**
 * rooms saved or deleted: its name is read again when next needed.
 * @param {core.App} app
 * @param {string} roomId
 */
function forget(app, roomId) {
  app.store().remove(`anonymous.${roomId}`);
}

// Filters, sorts and expands that would say who wrote a message are refused in Go (server/anonymous.go bindProbes).

/**
 * The media grid's author of an item (lib/media.js list): the room for an anonymous message, as hide does.
 * @param {core.RequestEvent} e the caller's request (superusers see the author)
 * @param {{ author: string, name: string, anonymous: boolean, room: string }} row
 */
function gridAuthor(e, row) {
  if (!row.author) return null;
  if (row.anonymous && row.author !== (e.auth?.id ?? "") && !e.hasSuperuserAuth()) return { id: row.room, name: roomName(e.app, row.room) };
  return { id: row.author, name: row.name };
}

module.exports = { forget, roomName, sourceName, gridAuthor };
