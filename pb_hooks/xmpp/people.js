/// <reference path="../../types/pocketbase.d.ts" />
// People in XMPP conferences as chat users (DESIGN.md §38.5): each gets a stand-in ("Ann (XMPP)") that their messages
// show under. They are known by the steadiest identity the conference gives: its occupant id (XEP-0421), else their
// own address, else the conference and their nickname, when it hides both (a new nickname is then a new person).

const { newStandIn, refuseSuffix, saveWithName } = require(`${__hooks}/lib/bridges.js`);

const SUFFIX = " (XMPP)";
const FALLBACK = "XMPP user";

/**
 * Who someone is, as xmpp_people.key.
 * @param {{ muc: string, nick: string, occupant_id?: string, jid?: string }} who
 */
function keyOf(who) {
  if (who.occupant_id) return `oid:${who.muc} ${who.occupant_id}`;
  if (who.jid) return `jid:${who.jid.toLowerCase()}`;
  return `nick:${who.muc}/${who.nick}`;
}

/**
 * @param {core.App} app
 * @param {string} key
 */
function rowOf(app, key) {
  try {
    return app.findFirstRecordByFilter("xmpp_people", "key = {:key}", { key });
  } catch {
    return null;
  }
}

/**
 * The stand-in of whoever wrote an XMPP message, made on their first one. A new nickname renames it.
 * @param {core.App} app
 * @param {{ muc: string, nick: string, occupant_id?: string, jid?: string }} who
 * @returns {core.Record} the users record
 */
function personOf(app, who) {
  const key = keyOf(who);
  let row = rowOf(app, key);
  if (row) {
    const user = app.findRecordById("users", row.getString("user"));
    if (row.getString("nick") !== who.nick) {
      saveWithName(app, user, who.nick, SUFFIX, FALLBACK);
      row.set("nick", who.nick);
      app.save(row);
    }
    return user;
  }
  const email = `xmpp.${$security.randomStringWithAlphabet(12, "abcdefghijklmnopqrstuvwxyz0123456789")}@xmpp.invalid`;
  const user = newStandIn(app, email, who.nick, SUFFIX, FALLBACK);
  row = new Record(app.findCollectionByNameOrId("xmpp_people"));
  row.set("key", key);
  row.set("user", user.id);
  row.set("muc", who.muc);
  row.set("nick", who.nick);
  row.set("jid", who.jid || "");
  app.save(row);
  // Their avatar, if they have one: the child may have told its hash before there was a stand-in to give it to.
  require(`${__hooks}/xmpp/avatars.js`).queueFetch(app, row, who.muc, who.nick, "");
  return user;
}

/**
 * The stand-in someone already has (its users id), or "": a correction or a retraction makes none.
 * @param {core.App} app
 * @param {{ muc: string, nick: string, occupant_id?: string, jid?: string }} who
 */
function standInOf(app, who) {
  return rowOf(app, keyOf(who))?.getString("user") || "";
}

/**
 * Someone in a conference changed their nickname (presence 303): their stand-in is renamed. One known by their
 * nickname alone is known by the new one from now on.
 * @param {core.App} app
 * @param {{ muc: string, nick: string, new_nick: string, occupant_id?: string, jid?: string }} ev
 */
function renamed(app, ev) {
  const key = keyOf(ev);
  const row = rowOf(app, key);
  if (!row || !ev.new_nick) return;
  if (key.startsWith("nick:")) {
    const next = keyOf({ ...ev, nick: ev.new_nick });
    if (rowOf(app, next)) return; // someone already wrote under the new one: they are another stand-in
    row.set("key", next);
  }
  row.set("nick", ev.new_nick);
  app.save(row);
  saveWithName(app, app.findRecordById("users", row.getString("user")), ev.new_nick, SUFFIX, FALLBACK);
}

/**
 * Is this user an XMPP stand-in? Their messages came from XMPP and don't go back.
 * @param {core.App} app
 * @param {string} userId
 */
function isStandIn(app, userId) {
  try {
    app.findFirstRecordByFilter("xmpp_people", "user = {:user}", { user: userId });
    return true;
  } catch {
    return false;
  }
}

/**
 * users create/update request: a name ending in "(XMPP)" is a stand-in's (lib/bridges.js).
 * @param {core.RecordRequestEvent} e
 */
const refuseStandInName = (e) => refuseSuffix(e, SUFFIX, "Names ending in (XMPP) are for people on XMPP. Choose another one.");

module.exports = { keyOf, personOf, standInOf, renamed, isStandIn, refuseStandInName };
