/// <reference path="../../types/pocketbase.d.ts" />
// What the bridges (Telegram §26, XMPP §38) do alike: their people's stand-ins ("Ann (TG)", "Ann (XMPP)"), long
// messages from elsewhere saved as several, under the same stand-in, and the names files from elsewhere are stored
// under.

const { fieldError } = require(`${__hooks}/lib/records.js`);
const { isBlank, nameKey, tidy } = require(`${__hooks}/lib/text.js`);

/** users.name max, and messages.text max. */
const NAME_MAX = 32;
const MAX_TEXT = 2000;

/**
 * "Ann (TG)", or "Ann 2 (TG)" and so on when that is taken (names are unique, §22.1), within users.name's 32.
 * @param {string} name
 * @param {number} n
 * @param {string} suffix " (TG)"
 * @param {string} fallback for a blank name, "Telegram user"
 */
function standInName(name, n, suffix, fallback) {
  const tail = `${n > 1 ? ` ${n}` : ""}${suffix}`;
  const base =
    [...tidy(name)]
      .slice(0, NAME_MAX - tail.length)
      .join("")
      .trim() || fallback;
  return `${base}${tail}`;
}

/**
 * Save stand-in `user` with the first free name for `name`.
 * @param {core.App} app
 * @param {core.Record} user
 * @param {string} name
 * @param {string} suffix
 * @param {string} fallback
 */
function saveWithName(app, user, name, suffix, fallback) {
  for (let n = 1; n < 1000; n++) {
    const candidate = standInName(name, n, suffix, fallback);
    try {
      app.findFirstRecordByFilter("users", "name_key = {:key} && id != {:id}", { key: nameKey(candidate), id: user.id });
      continue; // taken
    } catch {
      // free
    }
    user.set("name", candidate);
    app.save(user);
    return;
  }
  throw new Error("no free display name");
}

/**
 * A new stand-in: an address nobody receives mail at, a random password nobody knows, and no direct messages
 * (`no_dms`, §16.7). Saved with its name.
 * @param {core.App} app
 * @param {string} email
 * @param {string} name
 * @param {string} suffix
 * @param {string} fallback
 */
function newStandIn(app, email, name, suffix, fallback) {
  const user = new Record(app.findCollectionByNameOrId("users"));
  user.set("email", email);
  user.setPassword($security.randomString(40));
  user.set("no_dms", true);
  saveWithName(app, user, name, suffix, fallback);
  return user;
}

/**
 * users create/update request: a name ending in the suffix ("(TG)", however written: "(tg)", full-width, spaced) is
 * a stand-in's. Anyone else could pass for one of the bridge's people (QA BUG-86). Superusers name anyone.
 * @param {core.RecordRequestEvent} e
 * @param {string} suffix
 * @param {string} message
 */
function refuseSuffix(e, suffix, message) {
  const rec = e.record;
  if (!rec || e.hasSuperuserAuth()) return;
  const name = rec.getString("name");
  if (!rec.isNew() && name === rec.original().getString("name")) return;
  // The name as it will be stored (cleanName tidies it after this hook): "Ann (TG)\u0001" is "Ann (TG)" (QA BUG-142).
  if (nameKey(tidy(name)).replace(/\s+/g, "").endsWith(nameKey(suffix).trim())) throw fieldError("name", message);
}

/**
 * Text in pieces that each fit messages.text (in code points, as PocketBase counts): a Telegram message holds twice as
 * much as a chat message, and comes over as several rather than cut. Each piece ends at a line break, else a space, in
 * its second half; a text with neither there is cut at the limit. Always one piece at least, blank for no text.
 * @param {string} text
 * @returns {string[]}
 */
function split(text) {
  /** @type {string[]} */
  const pieces = [];
  let chars = [...text];
  while (chars.length > MAX_TEXT) {
    // The character just past the limit may be where it breaks: the break itself is left out.
    const room = chars.slice(0, MAX_TEXT + 1);
    let at = room.lastIndexOf("\n");
    if (at < MAX_TEXT / 2) for (at = MAX_TEXT; at >= MAX_TEXT / 2 && !/\s/.test(room[at]); at--);
    const cut = at >= MAX_TEXT / 2;
    pieces.push(
      chars
        .slice(0, cut ? at : MAX_TEXT)
        .join("")
        .trim(),
    );
    chars = chars.slice(cut ? at + 1 : MAX_TEXT);
  }
  pieces.push(chars.join("").trim());
  const kept = pieces.filter((p) => !isBlank(p));
  return kept.length ? kept : [""];
}

/**
 * Ids for messages saved at once, in the order they were written: the room shows messages by created, then id, and
 * those saved within the same millisecond would otherwise show in any order.
 * @param {number} n
 */
function orderedIds(n) {
  const ids = Array.from({ length: n }, () => $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"));
  return ids.sort();
}

/**
 * A message of a stand-in's, or a further part of a long one: its text, under the same stand-in, after the first.
 * @param {core.App} tx
 * @param {string} roomId
 * @param {string} authorId
 * @param {string} text
 * @param {string} [id]
 */
function savePart(tx, roomId, authorId, text, id) {
  const rec = new Record(tx.findCollectionByNameOrId("messages"));
  if (id) rec.id = id;
  rec.set("room", roomId);
  rec.set("author", authorId);
  rec.set("text", text);
  tx.save(rec);
  return rec;
}

/**
 * Stand-ins write in a private room as members, and in a room where only some people post as writers (the messages
 * hook checks both, §23, §23.6): the group on the other side decides who speaks.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} userId
 */
function ensureMember(app, room, userId) {
  if (room.getString("created_by") === userId) return;
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  const member = room.getString("visibility") !== "private" || members.includes(userId);
  const writer = room.getString("posting") !== "selected" || writers.includes(userId);
  if (member && writer) return;
  if (!member) room.set("members", [...members, userId]);
  if (!writer) room.set("writers", [...writers, userId]);
  app.save(room);
}

/**
 * A stored name as PocketBase makes them ("report_k3j2h1g0f9.pdf"): the client tells images and videos by its
 * extension, so it is the original's, or else that of `path` (where the file was served from).
 * @param {string} name
 * @param {string} path
 */
function storedName(name, path) {
  const ext = (/** @type {string} */ s) => (/\.([a-z0-9]{1,8})$/i.exec(s) || ["", ""])[1].toLowerCase();
  const base =
    name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "file";
  const suffix = $security.randomStringWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  const e = ext(name) || ext(path);
  return `${base}_${suffix}${e ? `.${e}` : ""}`;
}

module.exports = { MAX_TEXT, storedName, standInName, saveWithName, newStandIn, refuseSuffix, split, orderedIds, savePart, ensureMember };
