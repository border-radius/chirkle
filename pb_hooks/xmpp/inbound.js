/// <reference path="../../types/pocketbase.d.ts" />
// What the child tells PocketBase (DESIGN.md §38.3, §38.6): POST /api/xmpp/in, one event at a time, in order. An
// event that fails here is logged and still answered 200, so it can't hold back the ones after it; the child sends
// again only what got no answer at all.

const child = require(`${__hooks}/xmpp/child.js`);
const links = require(`${__hooks}/xmpp/links.js`);
const { personOf, renamed, standInOf } = require(`${__hooks}/xmpp/people.js`);
const { ensureMember, orderedIds, savePart, split } = require(`${__hooks}/lib/bridges.js`);
const { isBlank } = require(`${__hooks}/lib/text.js`);

/** What it said in the room when the bot was taken out of a conference. */
const REASONS = /** @type {Record<string, string>} */ ({
  kicked: ": the bot was removed from the conference",
  banned: ": the bot was banned from the conference",
  removed: ": the bot is no longer a member of the conference",
  destroyed: ": the conference was closed",
});

/**
 * POST /api/xmpp/in.
 * @param {core.RequestEvent} e
 */
function route(e) {
  if (!child.isOurs(e.app, e.request?.header.get("X-Chirkle-Bridge") || "")) return e.json(401, { error: "wrong secret" });
  const ev = e.requestInfo().body || {};
  child.beat(e.app);
  try {
    handle(e.app, ev);
  } catch (err) {
    e.app.logger().error("xmpp: event", "type", ev.type, "muc", ev.muc, "error", String(err));
  }
  return e.json(200, {});
}

/**
 * @param {core.App} app
 * @param {any} ev
 */
function handle(app, ev) {
  switch (ev.type) {
    case "hello":
      child.hello(app, ev);
      return;
    case "status":
      return status(app, ev);
    case "message":
      return message(app, ev);
    case "occupant":
      return renamed(app, { ...ev, muc: links.cleanMuc(ev.muc) });
    case "invite":
      return links.ensureLink(app, String(ev.muc || ""), String(ev.password || ""));
    case "retraction":
      return retraction(app, ev);
    case "kicked":
      return kicked(app, ev);
  }
}

/** The last connection error logged, so the same one every 10 s is logged once. */
const LAST_ERROR = "xmpp.lastError";

/**
 * The child's status (every 10 s, and when something changes): how each conference's join went, and its title.
 * Written only when it changed.
 * @param {core.App} app
 * @param {any} ev
 */
function status(app, ev) {
  const err = ev.connected ? "" : String(ev.error || "not connected");
  if (app.store().get(LAST_ERROR) !== err) {
    app.store().set(LAST_ERROR, err);
    if (err) app.logger().warn("xmpp: not connected", "error", err);
    else app.logger().info("xmpp: connected");
  }
  for (const r of ev.rooms || []) {
    const link = links.linkOfMuc(app, r.muc);
    if (!link) continue;
    const text = !ev.connected
      ? `not connected: ${err}`
      : r.state === "joined"
        ? `joined as ${r.nick}`
        : r.state === "error" || r.state === "removed"
          ? `${r.state}: ${r.error || "unknown"}`
          : r.state;
    /** @type {Record<string, string>} */
    const fields = {};
    if (text.slice(0, 1000) !== link.getString("status")) fields.status = text.slice(0, 1000);
    const title = String(r.title || "").slice(0, 255);
    if (title && title !== link.getString("title")) fields.title = title;
    links.note(app, link.id, fields);
  }
}

/**
 * A message in a conference (§38.6). The bot's own, as the conference sends it back, isn't brought over: the stanza id
 * the conference gave it is noted for the chat message it was. Seen before (sent again, or history overlapping what
 * came live), it isn't brought over twice. A correction edits the message it corrects; a reply to a message the
 * bridge knows replies to it, without the quote over it.
 * @param {core.App} app
 * @param {any} ev
 */
function message(app, ev) {
  const link = links.linkOfMuc(app, ev.muc);
  const room = link ? links.activeLink(app, link) : null;
  if (!link || !room) return;
  const muc = link.getString("muc");
  const at = new DateTime(ev.delay || new Date().toISOString());
  links.seen(app, link.id, at.string());

  if (ev.origin_id) {
    const out = mapped(app, muc, `o:${ev.origin_id}`);
    if (out) {
      if (ev.stanza_id && !out.getString("stanza_id")) {
        out.set("stanza_id", String(ev.stanza_id).slice(0, 255));
        app.save(out);
      }
      return;
    }
  }
  if (ev.self) return; // ours from before (history), or another bridge's on the same account
  if (ev.delay && at.unix() < link.getDateTime("enabled_at").unix()) return; // from before the link
  if (ev.replace) return correction(app, muc, ev);
  // With no id at all there's nothing to know it by again: it is brought over each time it comes.
  const id = ev.stanza_id ? String(ev.stanza_id) : `n:${ev.nick} ${ev.id || $security.randomString(15)}`;
  if (mapped(app, muc, id)) return;
  const reply = ev.reply_id ? findByXmppId(app, muc, String(ev.reply_id)) : null;
  const known = !!reply && reply.getString("room") === room.id && !reply.getBool("deleted");
  // Without the message it answers here, the quote over it stays: it says what it answers.
  const body = String((known && ev.reply_body) || ev.body || "");
  if (isBlank(body)) return;

  const author = personOf(app, { muc, nick: String(ev.nick || ""), occupant_id: ev.occupant_id, jid: ev.jid });
  ensureMember(app, room, author.id);
  const pieces = split(body);
  const ids = orderedIds(pieces.length);
  const sender = { msgId: String(ev.origin_id || ev.id || ""), nick: String(ev.nick || "") };
  const save = (/** @type {boolean} */ withReply) =>
    // The messages and what they map to in one transaction: the outbound hook queues them for the room's other
    // conferences, and the worker must find they came from this one (outbound.js), never send them back.
    app.runInTransaction((tx) => {
      pieces.forEach((/** @type {string} */ text, /** @type {number} */ i) => {
        const rec = new Record(tx.findCollectionByNameOrId("messages"));
        rec.id = ids[i];
        rec.set("room", room.id);
        rec.set("author", author.id);
        rec.set("text", text);
        if (i === 0 && withReply && reply) rec.set("reply_to", reply.id);
        tx.save(rec);
        remember(tx, rec.id, muc, id, ev.stanza_id || "", i, sender);
      });
    });
  try {
    try {
      save(known);
    } catch (err) {
      if (!known) throw err;
      save(false); // the message it answers went meanwhile: without the reply, as the app does (§19)
    }
  } catch (err) {
    if (mapped(app, muc, id)) return; // the same message, brought over meanwhile (the unique index)
    throw err;
  }
}

/**
 * The chat message a conference knows by `xmppId`, either way: its stanza id, else the sender's own id. The first
 * part, of one that came over as several. Null when the bridge doesn't know it.
 * @param {core.App} app
 * @param {string} muc
 * @param {string} xmppId
 */
function findByXmppId(app, muc, xmppId) {
  const row = rowByXmppId(app, muc, xmppId);
  return row ? findMessage(app, row.getString("message")) : null;
}

/**
 * @param {core.App} app
 * @param {string} muc
 * @param {string} xmppId
 */
function rowByXmppId(app, muc, xmppId) {
  for (const field of ["stanza_id", "msg_id"]) {
    try {
      return app.findFirstRecordByFilter("xmpp_messages", `muc = {:muc} && ${field} = {:id} && part = 0`, { muc, id: xmppId });
    } catch {
      // not by this one
    }
  }
  return null;
}

/**
 * @param {core.App} app
 * @param {string} id
 */
function findMessage(app, id) {
  try {
    return app.findRecordById("messages", id);
  } catch {
    return null;
  }
}

/**
 * A row's message and the parts that came with it (a long message that came over as several), first part first.
 * @param {core.App} app
 * @param {core.Record} row
 */
function partsOf(app, row) {
  return app
    .findRecordsByFilter("xmpp_messages", "muc = {:muc} && xmpp_id = {:id}", "part", 0, 0, {
      muc: row.getString("muc"),
      id: row.getString("xmpp_id"),
    })
    .filter((r) => !!r);
}

/**
 * Did this person write that message? The stand-in they are must be its author.
 * @param {core.App} app
 * @param {string} muc
 * @param {any} ev
 * @param {core.Record} rec
 */
function byAuthor(app, muc, ev, rec) {
  const who = standInOf(app, { muc, nick: String(ev.nick || ""), occupant_id: ev.occupant_id, jid: ev.jid });
  return !!who && who === rec.getString("author");
}

/**
 * A correction (XEP-0308): the message it names (by the sender's own id, as the XEP says) gets the new text, if it
 * came from this conference and the same person corrects it. One that came over as several parts gets them anew, as
 * a Telegram edit does (§26.4): a shorter text deletes the parts left over, a longer one adds parts.
 * @param {core.App} app
 * @param {string} muc
 * @param {any} ev
 */
function correction(app, muc, ev) {
  let row = null;
  try {
    row = app.findFirstRecordByFilter("xmpp_messages", "muc = {:muc} && msg_id = {:id} && direction = 'in' && part = 0", {
      muc,
      id: String(ev.replace),
    });
  } catch {
    return; // not one the bridge brought over
  }
  const rec = findMessage(app, row.getString("message"));
  if (!rec || rec.getBool("deleted") || !byAuthor(app, muc, ev, rec)) return;
  const body = String((rec.getString("reply_to") && ev.reply_body) || ev.body || "");
  const pieces = split(body);
  if (!pieces[0]) return;
  const rows = partsOf(app, row);
  const parts = /** @type {core.Record[]} */ (
    rows
      .slice(1)
      .map((r) => findMessage(app, r.getString("message")))
      .filter((p) => !!p && !p.getBool("deleted"))
  );
  const next = rows.length ? rows[rows.length - 1].getInt("part") + 1 : 1;
  app.runInTransaction((tx) => {
    [rec, ...parts].forEach((part, i) => {
      if (i >= pieces.length) part.set("deleted", true);
      else if (pieces[i] === part.getString("text")) return;
      else part.set("text", pieces[i]);
      tx.save(part);
    });
    const ids = orderedIds(pieces.length);
    for (let i = parts.length + 1; i < pieces.length; i++) {
      const part = savePart(tx, rec.getString("room"), rec.getString("author"), pieces[i], ids[i]);
      remember(tx, part.id, muc, row.getString("xmpp_id"), "", next + i - parts.length - 1, {
        msgId: row.getString("msg_id"),
        nick: row.getString("nick"),
      });
    }
  });
}

/**
 * A retraction (XEP-0424) by its author, or a moderator's (XEP-0425): the message is deleted in the room, all of its
 * parts. Only a message that came from the conference: one of the room's own people's, which the bot sent, stays in
 * the room when the conference's moderators take it out there.
 * @param {core.App} app
 * @param {any} ev
 */
function retraction(app, ev) {
  if (ev.self) return; // the bot's own, of a message deleted in the room
  const link = links.linkOfMuc(app, ev.muc);
  if (!link || !links.activeLink(app, link)) return;
  const muc = link.getString("muc");
  const row = rowByXmppId(app, muc, String(ev.target || ""));
  if (row?.getString("direction") !== "in") return;
  const rec = findMessage(app, row.getString("message"));
  if (!rec || (!ev.moderated && !byAuthor(app, muc, ev, rec))) return;
  app.runInTransaction((tx) => {
    for (const r of partsOf(tx, row)) {
      const part = findMessage(tx, r.getString("message"));
      if (!part || part.getBool("deleted")) continue;
      part.set("deleted", true);
      tx.save(part);
    }
  });
}

/**
 * The xmpp_messages row of what a conference knows as `xmppId` (its first part), or null.
 * @param {core.App} app
 * @param {string} muc
 * @param {string} xmppId
 */
function mapped(app, muc, xmppId) {
  try {
    return app.findFirstRecordByFilter("xmpp_messages", "muc = {:muc} && xmpp_id = {:id} && part = 0", { muc, id: xmppId });
  } catch {
    return null;
  }
}

/**
 * @param {core.App} tx
 * @param {string} messageId
 * @param {string} muc
 * @param {string} xmppId
 * @param {string} stanzaId
 * @param {number} part
 * @param {{ msgId: string, nick: string }} sender its own id, and nickname
 */
function remember(tx, messageId, muc, xmppId, stanzaId, part, sender) {
  const row = new Record(tx.findCollectionByNameOrId("xmpp_messages"));
  row.set("message", messageId);
  row.set("muc", muc);
  row.set("xmpp_id", xmppId.slice(0, 600));
  row.set("stanza_id", stanzaId.slice(0, 255));
  row.set("msg_id", sender.msgId.slice(0, 255));
  row.set("nick", sender.nick.slice(0, 255));
  row.set("direction", "in");
  row.set("part", part);
  tx.save(row);
}

/**
 * The bot was taken out of a conference (kicked, banned, no longer a member, the conference closed): its link is
 * disabled, and the room told why.
 * @param {core.App} app
 * @param {any} ev
 */
function kicked(app, ev) {
  const link = links.linkOfMuc(app, ev.muc);
  if (!link) return;
  app.runInTransaction((tx) => {
    // Read again in the transaction: the same news twice at once must tell the room once.
    const fresh = tx.findRecordById("xmpp_links", link.id);
    const was = links.linkedRoom(fresh);
    if (!was) return;
    fresh.set("enabled", false);
    fresh.set("status", `removed: ${ev.reason || "unknown"}`);
    // Past the xmpp_links hooks, which would tell the room it was disconnected without saying why.
    tx.unsafeWithoutHooks().save(fresh);
    links.tellLinkChange(tx, fresh, was, "", REASONS[ev.reason] || ": the bot was removed from the conference");
  });
}

module.exports = { route, handle };
