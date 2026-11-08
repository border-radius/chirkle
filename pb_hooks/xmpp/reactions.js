/// <reference path="../../types/pocketbase.d.ts" />
// Reactions across the bridge (DESIGN.md §38.6, §38.7). XEP-0444 sends one person's whole set of reactions on a
// message: their stand-in's reactions on the chat message become that set, each as the picker's emoji or the nearest
// it has (one with neither is left out). The other way, the bot keeps a set of its own on each message: every emoji
// someone in the room reacted with, but for this conference's own stand-ins, whose reactions are there already.

const { pickerEmoji } = require(`${__hooks}/lib/emoji.js`);
const { reactionsOf, setReaction } = require(`${__hooks}/lib/reactions.js`);

/**
 * The users who are stand-ins of people in `muc`, of those given.
 * @param {core.App} app
 * @param {string[]} users
 * @param {string} muc
 */
function standInsOf(app, users, muc) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const user of new Set(users)) {
    try {
      app.findFirstRecordByFilter("xmpp_people", "user = {:user} && muc = {:muc}", { user, muc });
      out.add(user);
    } catch {
      // not one of theirs
    }
  }
  return out;
}

/**
 * The bot's reactions on a message in `muc`: each emoji someone reacted with who isn't one of the conference's own
 * people, in the order they were first added. None on a deleted message.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {string} muc
 * @returns {string[]}
 */
function botSet(app, rec, muc) {
  if (rec.getBool("deleted")) return [];
  /** @type {{ emoji: string, users: string[] }[]} */
  const list = reactionsOf(rec);
  const theirs = standInsOf(
    app,
    list.flatMap((r) => r.users),
    muc,
  );
  return list.filter((r) => r.users.some((u) => !theirs.has(u))).map((r) => r.emoji);
}

/**
 * The conferences (of `mucs`) whose bot set an update changes, read before it is saved.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {string[]} mucs
 */
function changedFor(app, rec, mucs) {
  const orig = rec.original();
  if (rec.getString("reactions") === orig.getString("reactions") && rec.getBool("deleted") === orig.getBool("deleted")) return [];
  return mucs.filter((muc) => botSet(app, rec, muc).join(" ") !== botSet(app, orig, muc).join(" "));
}

/**
 * A `reactions` event: someone's reactions on a message became `emoji`. Their stand-in's reactions on the chat
 * message become the same, in one transaction, as the reactions route does (§20.2).
 * @param {core.App} app
 * @param {any} ev
 */
function reactionsIn(app, ev) {
  if (ev.self) return; // the bot's own, as the conference sends them back
  const links = require(`${__hooks}/xmpp/links.js`);
  const link = links.linkOfMuc(app, ev.muc);
  const room = link ? links.activeLink(app, link) : null;
  if (!link || !room) return;
  const muc = link.getString("muc");
  const { rowByXmppId } = require(`${__hooks}/xmpp/inbound.js`);
  const row = rowByXmppId(app, muc, String(ev.target || ""));
  if (!row) return;
  let target;
  try {
    target = app.findRecordById("messages", row.getString("message"));
  } catch {
    return;
  }
  if (target.getString("room") !== room.id || !target.getString("author") || target.getBool("deleted")) return;
  /** @type {Set<string>} */
  const now = new Set();
  for (const e of Array.isArray(ev.emoji) ? ev.emoji : []) {
    const picked = typeof e === "string" ? pickerEmoji(e) : "";
    if (picked) now.add(picked);
  }
  const { ensureMember } = require(`${__hooks}/lib/bridges.js`);
  const { personOf, standInOf } = require(`${__hooks}/xmpp/people.js`);
  const who = { muc, nick: String(ev.nick || ""), occupant_id: ev.occupant_id, jid: ev.jid };
  // Taking reactions back makes nobody a stand-in.
  const person = now.size ? personOf(app, who).id : standInOf(app, who);
  if (!person) return;
  if (now.size) ensureMember(app, room, person);
  app.runInTransaction((tx) => {
    const rec = tx.findRecordById("messages", target.id);
    if (rec.getBool("deleted")) return;
    const before = reactionsOf(rec);
    let list = before;
    for (const r of before) {
      if (r.users.includes(person) && !now.has(r.emoji)) list = setReaction(list, r.emoji, person, false) || list;
    }
    for (const e of now) list = setReaction(list, e, person, true) || list;
    if (JSON.stringify(list) === JSON.stringify(before)) return;
    rec.set("reactions", list);
    tx.save(rec);
  });
}

/**
 * Send the bot's set of reactions on a message to a conference, on the stanza the conference knows it by (its text,
 * or its first file): the conference's stanza id, else the sender's own id. As the message's reactions are when it
 * goes.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function react(app, messageId, muc) {
  const { linkOfMuc } = require(`${__hooks}/xmpp/links.js`);
  const { call } = require(`${__hooks}/xmpp/child.js`);
  let msg;
  try {
    msg = app.findRecordById("messages", messageId);
  } catch {
    return;
  }
  if (msg.getBool("deleted")) return;
  const link = linkOfMuc(app, muc);
  if (!link?.getBool("enabled") || link.getString("room") !== msg.getString("room")) return;
  const row = app
    .findRecordsByFilter("xmpp_messages", "message = {:message} && muc = {:muc}", "part,created,id", 1, 0, { message: messageId, muc })
    .find((r) => !!r);
  const target = row ? row.getString("stanza_id") || row.getString("msg_id") : "";
  if (!target) return;
  const id = `${messageId}-r${$security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
  call(app, "/send", { muc, id, body: "", react: { id: target, emoji: botSet(app, msg, muc) } });
}

module.exports = { botSet, changedFor, reactionsIn, react };
