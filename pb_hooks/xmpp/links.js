/// <reference path="../../types/pocketbase.d.ts" />
// Which XMPP conference goes with which room (DESIGN.md §38.4, collection xmpp_links). A superuser adds the conference
// in the admin UI, picks the room and enables it; an invitation to the bot adds one, disabled and with no room.

const { postService } = require(`${__hooks}/lib/messages.js`);
const { fieldError, recordOf } = require(`${__hooks}/lib/records.js`);
const { isBlank, tidy } = require(`${__hooks}/lib/text.js`);

/**
 * A conference's address as stored: bare, the domain in lower case. "" when it isn't one.
 * @param {string} s
 */
function cleanMuc(s) {
  const m = /^([^@/\s]+)@([^@/\s]+)$/.exec(String(s || "").trim());
  return m ? `${m[1].toLowerCase()}@${m[2].toLowerCase()}` : "";
}

/**
 * @param {core.App} app
 * @param {string} muc
 */
function linkOfMuc(app, muc) {
  try {
    return app.findFirstRecordByFilter("xmpp_links", "muc = {:muc}", { muc: cleanMuc(muc) });
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
 * The enabled links of a room (a room may be linked to several conferences).
 * @param {core.App} app
 * @param {string} roomId
 */
function linksOfRoom(app, roomId) {
  return app.findRecordsByFilter("xmpp_links", "room = {:room} && enabled = true", "created", 0, 0, { room: roomId }).filter((l) => !!l);
}

/**
 * The conferences the child should be in: those of links in use, each with what makes it join again when it changes
 * (`key`: the link saved), and the history to ask for (`since`).
 * @param {core.App} app
 */
function wanted(app) {
  /** @type {{ muc: string, key: string, password: string, since: string }[]} */
  const rooms = [];
  for (const l of app.findRecordsByFilter("xmpp_links", "enabled = true && room != ''", "created", 0, 0)) {
    if (!l || !activeLink(app, l)) continue;
    const seen = l.getDateTime("last_seen");
    const since = !seen.isZero() ? seen : l.getDateTime("enabled_at");
    rooms.push({
      muc: l.getString("muc"),
      key: `${l.id} ${l.getDateTime("updated").string()}`,
      password: l.getString("password"),
      since: since.isZero() ? "" : since.string().replace(" ", "T"),
    });
  }
  return rooms;
}

/**
 * An invitation to the bot: the conference gets a link, disabled and with no room, for a superuser to link. Its
 * password, if the invitation gave one, kept.
 * @param {core.App} app
 * @param {string} muc
 * @param {string} password
 */
function ensureLink(app, muc, password) {
  const addr = cleanMuc(muc);
  if (!addr || linkOfMuc(app, addr)) return;
  const link = new Record(app.findCollectionByNameOrId("xmpp_links"));
  link.set("muc", addr);
  link.set("enabled", false);
  if (password) link.set("password", password.slice(0, 255));
  try {
    app.save(link);
  } catch (err) {
    if (!linkOfMuc(app, addr)) throw err; // made meanwhile (the unique index)
  }
}

/**
 * Write what the bridge learned about a link (status, title, the newest message seen) without saving the record: no
 * hooks, and `updated` stays as it is, so the child doesn't take it for a change that needs a new join.
 * @param {core.App} app
 * @param {string} id
 * @param {Record<string, string>} fields
 */
function note(app, id, fields) {
  const names = Object.keys(fields);
  if (!names.length) return;
  app
    .db()
    .newQuery(`UPDATE xmpp_links SET ${names.map((n) => `[[${n}]] = {:${n}}`).join(", ")} WHERE id = {:id}`)
    .bind({ ...fields, id })
    .execute();
}

/**
 * Note a message seen at `at` (an ISO date): the history asked for on the next join starts there.
 * @param {core.App} app
 * @param {string} id
 * @param {string} at
 */
function seen(app, id, at) {
  app
    .db()
    .newQuery("UPDATE xmpp_links SET last_seen = {:at} WHERE id = {:id} AND (last_seen = '' OR last_seen < {:at})")
    .bind({ at, id })
    .execute();
}

/**
 * xmpp_links create/update: a conference's address, only a room (not a DM) linked, and only a link with a room
 * enabled. Enabling it notes when (older history isn't brought over).
 * @param {core.RecordEvent} e
 */
function beforeLinkSave(e) {
  const rec = recordOf(e);
  const muc = cleanMuc(rec.getString("muc"));
  if (!muc) throw fieldError("muc", "The conference's address, like room@conference.example.org.");
  rec.set("muc", muc);
  const roomId = rec.getString("room");
  if (roomId) {
    const room = e.app.findRecordById("rooms", roomId);
    if (room.getString("kind") === "dm") throw fieldError("room", "Direct messages can't be linked to XMPP.");
  }
  if (rec.getBool("enabled") && !roomId) throw fieldError("enabled", "Choose the room first.");
  const was = rec.isNew() ? false : rec.original().getBool("enabled");
  if (rec.getBool("enabled") && !was) {
    rec.set("enabled_at", new DateTime());
    rec.set("last_seen", "");
  }
}

/**
 * The room a link passes messages to: "" when disabled or without a room.
 * @param {core.Record} link
 */
const linkedRoom = (link) => (link.getBool("enabled") ? link.getString("room") : "");

/**
 * "XMPP conference "Friends"", for service messages: its title tidied like a name (no bidi overrides or line breaks),
 * else its address.
 * @param {core.Record} link
 */
const conferenceName = (link) => {
  const title = tidy(link.getString("title"));
  return `XMPP conference "${isBlank(title) ? link.getString("muc") : title}"`;
};

/**
 * A service message (§5.3) in the room, unless it is gone or archived.
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
 * xmpp_links saved or deleted: the room it stopped passing messages to and the one it started passing them to say so.
 * @param {core.App} app
 * @param {core.Record} link
 * @param {string} was linkedRoom before (read before the save)
 * @param {string} now linkedRoom after: "" once deleted
 * @param {string} [why] after "disconnected from this room", e.g. ": the bot was removed from the conference"
 */
function tellLinkChange(app, link, was, now, why = "") {
  if (was === now) return;
  if (was) tellRoom(app, was, `${conferenceName(link)} was disconnected from this room${why}.`);
  if (now) tellRoom(app, now, `${conferenceName(link)} was connected to this room.`);
}

module.exports = {
  cleanMuc,
  linkOfMuc,
  activeLink,
  linksOfRoom,
  wanted,
  ensureLink,
  note,
  seen,
  beforeLinkSave,
  linkedRoom,
  tellLinkChange,
};
