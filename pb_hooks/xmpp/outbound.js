/// <reference path="../../types/pocketbase.d.ts" />
// Chirkle → XMPP (DESIGN.md §38.7). The messages hooks only queue the work (xmpp_queue, in the save's transaction):
// a new message, an edit of its text, a delete, for each conference of the room. The worker (worker.js) has the child
// send it, so a user's request never waits for XMPP. Edits go as corrections (XEP-0308), deletes as retractions
// (XEP-0424), replies with XEP-0461 and a quote over them for clients without it, files as uploads (XEP-0363).

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
 * The file a message shows (its own, or for a forward its original's), as PocketBase serves it, and as it is named.
 * @param {core.Record} source the message that has the files
 */
function filesOf(source) {
  const names = /** @type {Record<string, string>} */ (JSON.parse(source.getString("file_names") || "{}") || {});
  return source.getStringSlice("files").map((name) => ({
    path: `/api/files/messages/${source.id}/${encodeURIComponent(name)}`,
    shown: names[name] || name.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1"),
  }));
}

/**
 * Who a message is from on XMPP, and the message that has its text and files: itself, or for a forward its
 * original's (§21.3). "Ann", "Ann (forwarded from Bob)"; a message of an anonymous room is the room's, and a forward
 * of one from its room (§35).
 * @param {core.App} app
 * @param {core.Record} msg
 */
function sourceOf(app, msg) {
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
  return { author, source };
}

/**
 * What a message's text says on XMPP, as plain text: "Ann: hello". Its files go as messages of their own (send);
 * with no text, the text names them, "Ann: [cat.jpg]", so it is known whose they are. An anonymous link's
 * conference gets the text alone, and no line for files alone. "" when there is nothing to say.
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {boolean} anonymous
 */
function bodyOf(app, msg, anonymous) {
  const { author, source } = sourceOf(app, msg);
  const text = source.getString("text").trim();
  if (anonymous) return text;
  const said =
    text ||
    filesOf(source)
      .map((f) => `[${f.shown}]`)
      .join(" ");
  return said ? `${author}: ${said}` : "";
}

/** The most of what a reply answers that its quote shows. */
const MAX_QUOTE = 100;
/** A retraction's body, for clients without retractions (XEP-0424's own wording). */
const RETRACTED = "This person attempted to retract a previous message, but it's unsupported by your client.";
/** Seconds an upload may take: the child's own limit is 5 minutes, but the worker's lock is renewed per file. */
const UPLOAD_TIMEOUT = 150;

/**
 * The xmpp_messages rows of a chat message in a conference, either way, first sent (or first part) first.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function rowsOf(app, messageId, muc) {
  return app
    .findRecordsByFilter("xmpp_messages", "message = {:message} && muc = {:muc}", "part,created,id", 0, 0, {
      message: messageId,
      muc,
    })
    .filter((r) => !!r);
}

/**
 * The row the bot's message to a conference has for one of its stanzas ("o:" + the stanza's id), or null.
 * @param {core.App} app
 * @param {string} muc
 * @param {string} stanzaId
 */
function sentRow(app, muc, stanzaId) {
  try {
    return app.findFirstRecordByFilter("xmpp_messages", "muc = {:muc} && xmpp_id = {:id}", { muc, id: `o:${stanzaId}` });
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
  const row = rowsOf(app, original.id, muc)[0] || null;
  // What it showed there: an XMPP person's own text (or its file's name), or what the bot sent for one of the room's
  // people.
  const shown =
    row?.getString("direction") === "in"
      ? original.getString("text") ||
        filesOf(original)
          .map((f) => `[${f.shown}]`)
          .join(" ")
      : bodyOf(app, original, anonymous) ||
        filesOf(sourceOf(app, original).source)
          .map((f) => `[${f.shown}]`)
          .join(" ");
  const chars = [...shown.replace(/\s+/g, " ").trim()];
  const cut = chars.length > MAX_QUOTE ? `${chars.slice(0, MAX_QUOTE).join("")}…` : chars.join("");
  if (!cut) return { quote: "", reply: null };
  const quote = `> ${cut}\n`;
  const id = row ? row.getString("stanza_id") || row.getString("msg_id") : "";
  const reply = id ? { id, to: row?.getString("direction") === "in" ? row.getString("nick") : "", end: [...quote].length } : null;
  return { quote, reply };
}

/**
 * What a message's text goes as: its body (the quote over a reply, then its text) and the reply. Empty when there is
 * no text to send.
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
 * Remember a stanza the bot sent for a chat message ("o:" + its id): its echo isn't brought back, and replies,
 * corrections and retractions find it.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 * @param {string} stanzaId
 */
function rememberSent(app, messageId, muc, stanzaId) {
  const row = new Record(app.findCollectionByNameOrId("xmpp_messages"));
  row.set("message", messageId);
  row.set("muc", muc);
  row.set("xmpp_id", `o:${stanzaId}`);
  row.set("msg_id", stanzaId);
  row.set("direction", "out");
  row.set("part", 0);
  app.save(row);
}

/**
 * Where a file is got from on XMPP: put on the bot's server (XEP-0363), or when it has no upload service, or won't
 * take one so large, the file's address at the site's App URL (§38.7). "" with neither. A failure for now throws.
 * @param {core.App} app
 * @param {{ path: string, shown: string }} f
 */
function fileURL(app, f) {
  const appURL = String($app.settings().meta.appURL || "").replace(/\/+$/, "");
  try {
    return String(call(app, "/upload", { path: f.path, name: f.shown }, UPLOAD_TIMEOUT).url || "");
  } catch (err) {
    if (/** @type {any} */ (err).transient !== false) throw err;
    if (!["unsupported", "too_large"].includes(/** @type {any} */ (err).code)) {
      app.logger().warn("xmpp: upload", "path", f.path, "error", String(err));
    }
    return appURL ? appURL + f.path : "";
  }
}

/**
 * Has the child send a message to a conference: its text first ("Ann: hello", with the reply), then each file as a
 * message of its own, its link as the body and in OOB (XEP-0066), which clients show inline. Each stanza is
 * remembered once sent, so a retry after a failure halfway sends only the rest.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 * @param {() => void} [renew] keeps the worker's lock between files
 */
function send(app, messageId, muc, renew = () => {}) {
  const msg = find(app, "messages", messageId);
  if (!msg || msg.getBool("deleted")) return;
  const link = linkFor(app, msg, muc);
  // Came from this conference.
  if (!link || rowsOf(app, messageId, muc).some((r) => r.getString("direction") === "in")) return;
  const anonymous = link.getBool("anonymous");
  const { body, reply } = outgoing(app, msg, muc, anonymous);
  // The reply goes with the first stanza: the text, or with none, the first file.
  let replyLeft = reply;
  if (body && !sentRow(app, muc, messageId)) {
    call(app, "/send", { muc, id: messageId, body, ...(reply ? { reply } : {}) });
    rememberSent(app, messageId, muc, messageId);
  }
  if (body) replyLeft = null;
  filesOf(sourceOf(app, msg).source).forEach((f, i) => {
    const id = `${messageId}-f${i + 1}`;
    if (sentRow(app, muc, id)) return;
    const url = fileURL(app, f);
    renew();
    const fileBody = url || `[${f.shown}]`;
    call(app, "/send", {
      muc,
      id,
      body: fileBody,
      ...(url ? { oob: url } : {}),
      ...(replyLeft ? { reply: { ...replyLeft, end: 0 } } : {}),
    });
    rememberSent(app, messageId, muc, id);
    replyLeft = null;
  });
}

/**
 * An edit: a correction (XEP-0308) of the text the bot sent, with its whole new text. Only where the bot sent it.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function edit(app, messageId, muc) {
  const msg = find(app, "messages", messageId);
  if (!msg || msg.getBool("deleted")) return;
  const link = linkFor(app, msg, muc);
  const row = link ? sentRow(app, muc, messageId) : null;
  if (!link || !row) return;
  const { body, reply } = outgoing(app, msg, muc, link.getBool("anonymous"));
  if (!body) return;
  // A correction is a message of its own, with an id of its own; it names the first one, as every correction does.
  const id = `${messageId}-${$security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
  call(app, "/send", { muc, id, body, replace: row.getString("msg_id"), ...(reply ? { reply } : {}) });
}

/**
 * A delete: a retraction (XEP-0424) of each stanza the bot sent for the message (its text, its files), by the
 * conference's stanza id and its origin id (versions 1 and before). Only where the bot sent it: a message that came
 * from a conference was deleted there already, or is one only a moderator could take out (§38.7).
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} muc
 */
function remove(app, messageId, muc) {
  const msg = find(app, "messages", messageId);
  if (!msg || !linkFor(app, msg, muc)) return;
  for (const row of rowsOf(app, messageId, muc)) {
    if (row.getString("direction") !== "out") continue;
    const id = `${messageId}-${$security.randomStringWithAlphabet(8, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
    call(app, "/send", {
      muc,
      id,
      body: RETRACTED,
      retract: { stanza_id: row.getString("stanza_id"), origin_id: row.getString("msg_id") },
    });
  }
}

module.exports = { queueCreate, changeOf, queueUpdate, send, edit, remove, bodyOf };
