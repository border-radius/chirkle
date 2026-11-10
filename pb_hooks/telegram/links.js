/// <reference path="../../types/pocketbase.d.ts" />
// Which Telegram group goes with which room (DESIGN.md §26.5, collection tg_links). A row appears, disabled and with
// no room, for every group the bot is in; a superuser links it in the admin UI by picking the room and enabling it.

const { postService } = require(`${__hooks}/lib/messages.js`);
const { fieldError, recordOf } = require(`${__hooks}/lib/records.js`);
const { isBlank, tidy } = require(`${__hooks}/lib/text.js`);

/**
 * @param {core.App} app
 * @param {string} chatId
 */
function linkOfChat(app, chatId) {
  try {
    return app.findFirstRecordByFilter("tg_links", "chat_id = {:chat}", { chat: chatId });
  } catch {
    return null;
  }
}

/**
 * The room of a link that is in use: enabled, with a room that isn't archived. Null otherwise.
 * @param {core.App} app
 * @param {core.Record} link
 */
function activeLink(app, link) {
  if (!link.getBool("enabled") || !link.getString("room")) return null;
  try {
    const room = app.findRecordById("rooms", link.getString("room"));
    return room.getBool("archived") ? null : room;
  } catch {
    return null;
  }
}

/**
 * The enabled links of a room (a room may be linked to several groups).
 * @param {core.App} app
 * @param {string} roomId
 */
function linksOfRoom(app, roomId) {
  return app.findRecordsByFilter("tg_links", "room = {:room} && enabled = true", "created", 0, 0, { room: roomId }).filter((l) => !!l);
}

/**
 * The group's link, made (disabled, no room) the first time the bot hears from it; its title kept up to date.
 * @param {core.App} app
 * @param {any} chat
 */
function ensureLink(app, chat) {
  const chatId = String(chat.id);
  const title = String(chat.title || "").slice(0, 255);
  let link = linkOfChat(app, chatId);
  if (!link) {
    link = new Record(app.findCollectionByNameOrId("tg_links"));
    link.set("chat_id", chatId);
    link.set("title", title);
    link.set("enabled", false);
    try {
      app.save(link);
    } catch (err) {
      const again = linkOfChat(app, chatId); // made meanwhile (the unique index)
      if (!again) throw err;
      link = again;
    }
  } else if (title && title !== link.getString("title")) {
    link.set("title", title);
    app.save(link);
  }
  return link;
}

/**
 * A group became a supergroup, which has a new id: its link follows.
 * @param {core.App} app
 * @param {string} from
 * @param {string} to
 */
function moveLink(app, from, to) {
  const link = linkOfChat(app, from);
  if (!link) return;
  app.runInTransaction((tx) => {
    // The new group heard from first (QA BUG-89) has a link of its own, unused: the old group's takes its place.
    const there = linkOfChat(tx, to);
    if (there) {
      if (there.getString("room") || there.getBool("enabled")) return;
      tx.delete(there);
    }
    link.set("chat_id", to);
    tx.save(link);
    // What waits to go to Telegram goes to the new group. tg_messages stays with the old one: the new group numbers
    // its messages afresh, so the old ids would stand for its new messages (QA BUG-257). Queued album items are the
    // old group's messages, brought over before this (handleUpdate).
    tx.db().newQuery("UPDATE tg_queue SET chat_id = {:to} WHERE chat_id = {:from} AND op != 'album'").bind({ to, from }).execute();
  });
}

/**
 * tg_links create/update: only a room (not a DM) can be linked, and only a link with a room can be enabled.
 * @param {core.RecordEvent} e
 */
function beforeLinkSave(e) {
  const rec = recordOf(e);
  const roomId = rec.getString("room");
  if (roomId) {
    const room = e.app.findRecordById("rooms", roomId);
    if (room.getString("kind") === "dm") throw fieldError("room", "Direct messages can't be linked to Telegram.");
  }
  if (rec.getBool("enabled") && !roomId) throw fieldError("enabled", "Choose the room first.");
}

/**
 * The room a link passes messages to: "" when disabled or without a room.
 * @param {core.Record} link
 */
const linkedRoom = (link) => (link.getBool("enabled") ? link.getString("room") : "");

/**
 * "Telegram group "Friends"", for service messages. The title is the group's (or a superuser's): tidied like a name,
 * so it can't break the line or turn it around (bidi overrides), and a blank one is left out.
 * @param {core.Record} link
 */
const groupName = (link) => {
  const title = tidy(link.getString("title"));
  return isBlank(title) ? "A Telegram group" : `Telegram group "${title}"`;
};

/**
 * A service message (§5.3) in the room, unless it is gone or archived (it passes nothing then anyway).
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} text
 */
function tellRoom(app, roomId, text) {
  try {
    if (app.findRecordById("rooms", roomId).getBool("archived")) return;
  } catch {
    return;
  }
  postService(app, roomId, text);
}

/**
 * tg_links saved or deleted: the room it stopped passing messages to and the one it started passing them to say so
 * (a superuser linking, unlinking or moving it; the bot removed from the group).
 * @param {core.App} app
 * @param {core.Record} link
 * @param {string} was linkedRoom before (read before the save)
 * @param {string} now linkedRoom after: "" once deleted
 * @param {string} [why] after "disconnected from this room", e.g. ": the bot was removed from the group"
 */
function tellLinkChange(app, link, was, now, why = "") {
  if (was === now) return;
  if (was) tellRoom(app, was, `${groupName(link)} was disconnected from this room${why}.`);
  if (now) tellRoom(app, now, `${groupName(link)} was connected to this room.`);
}

module.exports = { linkOfChat, activeLink, linksOfRoom, ensureLink, moveLink, beforeLinkSave, linkedRoom, tellLinkChange };
