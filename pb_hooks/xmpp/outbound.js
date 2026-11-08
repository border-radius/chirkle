/// <reference path="../../types/pocketbase.d.ts" />
// Chirkle → XMPP (DESIGN.md §38.7). The messages hooks only queue the work (xmpp_queue, in the save's transaction):
// a new message, an edit of its text, a delete, for each conference of the room. The worker (worker.js) has the child
// send it, so a user's request never waits for XMPP. Edits go as corrections (XEP-0308), deletes as retractions
// (XEP-0424), replies with XEP-0461 and a quote over them for clients without it.

const { roomName, sourceName } = require(`${__hooks}/lib/anonymous.js`);
const { call } = require(`${__hooks}/xmpp/child.js`);
const { linkOfMuc, linksOfRoom } = require(`${__hooks}/xmpp/links.js`);

/**
 * @param {core.App} app
 * @param {string} op
 * @param {string} messageId
 * @param {string} muc
 */
function enqueue(app, op, messageId, muc) {
  const row = new Record(app.findCollectionByNameOrId("xmpp_queue"));
  row.set("op", op);
  row.set("message", messageId);
  row.set("muc", muc);
  app.save(row);
}

/**
 * messages create (saved): queue it for each conference its room is linked to. One that came from one of them is
 * queued too, for the others; the worker leaves out the conference it came from. Service messages (no author, §5.3)
 * stay in the room.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function queueCreate(app, rec) {
  if (!rec.getString("author")) return;
  for (const link of linksOfRoom(app, rec.getString("room"))) enqueue(app, "send", rec.id, link.getString("muc"));
}

/**
 * What a messages update changes for the conferences, read before it is saved.
 * @param {core.Record} rec
 * @returns {"" | "edit" | "delete"}
 */
function changeOf(rec) {
  const orig = rec.original();
  if (rec.getBool("deleted") && !orig.getBool("deleted")) return "delete";
  if (!rec.getBool("deleted") && rec.getString("text") !== orig.getString("text")) return "edit";
  return "";
}

/**
 * messages update (saved): queue an edit or delete for the conferences of its room. The worker passes it on only
 * where the message went (outbound rows): not back to the conference it came from.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {"" | "edit" | "delete"} change
 */
function queueUpdate(app, rec, change) {
  if (!change || !rec.getString("author")) return; // a service message never went to XMPP
  for (const link of linksOfRoom(app, rec.getString("room"))) enqueue(app, change, rec.id, link.getString("muc"));
}

// ---------------------------------------------------------------- the worker's side

/**
 * @param {core.App} app
 * @param {string} collection
 * @param {string} id
 */
function find(app, collection, id) {
  try {
    return app.findRecordById(collection, id);
  } catch {
    return null;
  }
}

/** @param {core.App} app @param {string} id */
const userName = (app, id) => find(app, "users", id)?.getString("name") || "";

/**
 * A message's file, as a link: its address at the site's App URL (§38.7), else just its name.
 * @param {string} appURL
 * @param {core.Record} source the message that has the file
 * @param {string} name its stored name
 * @param {string} shown the name it shows
 */
function fileLine(appURL, source, name, shown) {
  if (!appURL) return `[${shown}]`;
  return `${appURL}/api/files/messages/${source.id}/${encodeURIComponent(name)}`;
}

/**
 * What a message says on XMPP, as plain text: "Ann: hello", a forward "Ann (forwarded from Bob): …" with its
 * original's text and files (§21.3), and its files as links after the text. An anonymous link's conference gets the
 * text alone. A message of an anonymous room is the room's, and a forward of one from its room (§35).
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {boolean} anonymous
 */
function bodyOf(app, msg, anonymous) {
  let source = msg;
  let author = msg.getBool("anonymous") ? roomName(app, msg.getString("room")) : userName(app, msg.getString("author"));
  author = author || "Someone";
  if (msg.getString("forwarded_from")) {
    const original = msg.getString("forward_of") ? find(app, "messages", msg.getString("forward_of")) : null;
    const from = !msg.getBool("forwarded_anonymous")
      ? userName(app, msg.getString("forwarded_from"))
      : original
        ? sourceName(app, original.getString("room"))
        : "Anonymous";
    author += ` (forwarded from ${from || "someone"})`;
    if (msg.getString("forward_of")) source = original && !original.getBool("deleted") ? original : msg;
  }
  const appURL = String($app.settings().meta.appURL || "").replace(/\/+$/, "");
  const names = /** @type {Record<string, string>} */ (JSON.parse(source.getString("file_names") || "{}") || {});
  const files = source
    .getStringSlice("files")
    .map((name) => fileLine(appURL, source, name, names[name] || name.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1")));
  const text = [source.getString("text"), ...files].filter((l) => l.trim()).join("\n");
  if (!text) return "";
  return anonymous ? text : `${author}: ${text}`;
}

/** The most of what a reply answers that its quote shows. */
const MAX_QUOTE = 100;
/** A retraction's body, for clients without retractions (XEP-0424's own wording). */
const RETRACTED = "This person attempted to retract a previous message, but it's unsupported by your client.";

/**
 * The xmpp_messages row of a chat message in a conference, either way (its first part), or null.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 * @param {string} [filter] more conditions
 */
function rowOf(app, messageId, muc, filter = "") {
  try {
    return app.findFirstRecordByFilter("xmpp_messages", `message = {:message} && muc = {:muc} && part = 0${filter}`, {
      message: messageId,
      muc,
    });
  } catch {
    return null;
  }
}

/**
 * The quote over a reply ("> Ann: what time?") and the reply to put with it: the message it answers, as the
 * conference knows it (its stanza id, else its sender's own id), and who wrote it there. The quote stays even when
 * the conference doesn't know that message: it says what the reply answers.
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {string} muc
 * @param {boolean} anonymous
 */
function replyOf(app, msg, muc, anonymous) {
  const original = msg.getString("reply_to") ? find(app, "messages", msg.getString("reply_to")) : null;
  if (!original || original.getBool("deleted")) return { quote: "", reply: null };
  const row = rowOf(app, original.id, muc);
  // What it showed there: an XMPP person's own text, or what the bot sent for one of the room's people.
  const shown = row?.getString("direction") === "in" ? original.getString("text") : bodyOf(app, original, anonymous);
  const chars = [...shown.replace(/\s+/g, " ").trim()];
  const cut = chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : chars.join("");
  if (!cut) return { quote: "", reply: null };
  const quote = `> ${cut}\n`;
  const id = row ? row.getString("stanza_id") || row.getString("msg_id") : "";
  const reply = id ? { id, to: row?.getString("direction") === "in" ? row.getString("nick") : "", end: [...quote].length } : null;
  return { quote, reply };
}

/**
 * What a message goes as: its body (the quote over a reply, then its content) and the reply. Empty when it shows
 * nothing.
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {string} muc
 * @param {boolean} anonymous
 */
function outgoing(app, msg, muc, anonymous) {
  const content = bodyOf(app, msg, anonymous);
  if (!content) return { body: "", reply: null };
  const { quote, reply } = replyOf(app, msg, muc, anonymous);
  return { body: quote + content, reply };
}

/**
 * The link a message goes through to a conference: enabled, and of the message's room. Null otherwise.
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {string} muc
 */
function linkFor(app, msg, muc) {
  const link = linkOfMuc(app, muc);
  return link?.getBool("enabled") && link.getString("room") === msg.getString("room") ? link : null;
}

/**
 * Has the child send a message to a conference, and remember it as ours ("o:" + its id), so that the conference's echo
 * of it isn't brought back, and replies can find it later.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function send(app, messageId, muc) {
  const msg = find(app, "messages", messageId);
  if (!msg || msg.getBool("deleted")) return;
  const link = linkFor(app, msg, muc);
  // Came from this conference, or already sent (a retry after the worker stopped halfway).
  if (!link || rowOf(app, messageId, muc)) return;
  const { body, reply } = outgoing(app, msg, muc, link.getBool("anonymous"));
  if (!body) return;
  call(app, "/send", { muc, id: messageId, body, ...(reply ? { reply } : {}) });
  const row = new Record(app.findCollectionByNameOrId("xmpp_messages"));
  row.set("message", messageId);
  row.set("muc", muc);
  row.set("xmpp_id", `o:${messageId}`);
  row.set("msg_id", messageId);
  row.set("direction", "out");
  row.set("part", 0);
  app.save(row);
}

/**
 * An edit: a correction (XEP-0308) of the message the bot sent, with its whole new text. Only where the bot sent it.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function edit(app, messageId, muc) {
  const msg = find(app, "messages", messageId);
  if (!msg || msg.getBool("deleted")) return;
  const link = linkFor(app, msg, muc);
  const row = link ? rowOf(app, messageId, muc, " && direction = 'out'") : null;
  if (!link || !row) return;
  const { body, reply } = outgoing(app, msg, muc, link.getBool("anonymous"));
  if (!body) return;
  // A correction is a message of its own, with an id of its own; it names the first one, as every correction does.
  const id = `${messageId}-${$security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
  call(app, "/send", { muc, id, body, replace: row.getString("msg_id"), ...(reply ? { reply } : {}) });
}

/**
 * A delete: a retraction (XEP-0424) of the message the bot sent, by the conference's stanza id and its origin id
 * (versions 1 and before). Only where the bot sent it: a message that came from a conference was deleted there
 * already, or is one only a moderator could take out (§38.7).
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function remove(app, messageId, muc) {
  const msg = find(app, "messages", messageId);
  const row = msg ? rowOf(app, messageId, muc, " && direction = 'out'") : null;
  if (!msg || !row || !linkFor(app, msg, muc)) return;
  const id = `${messageId}-${$security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
  call(app, "/send", {
    muc,
    id,
    body: RETRACTED,
    retract: { stanza_id: row.getString("stanza_id"), origin_id: row.getString("msg_id") },
  });
}

module.exports = { queueCreate, changeOf, queueUpdate, send, edit, remove, bodyOf };
