/// <reference path="../../types/pocketbase.d.ts" />
// Chirkle → Telegram (DESIGN.md §26.6). The messages hooks only queue the work (tg_queue): a message, edit or delete in
// a linked room. The worker (worker.js) sends it, so a user's request never waits for Telegram, and what Telegram
// refuses for now (it is down, or asks to slow down) is retried in order.

const { roomName, sourceName } = require(`${__hooks}/lib/anonymous.js`);
const { asTelegram, call } = require(`${__hooks}/telegram/api.js`);
const { linkOfChat, linksOfRoom } = require(`${__hooks}/telegram/links.js`);

/** Telegram's limits: a caption's length, and the largest photo it takes as a photo (bigger ones go as files). */
const MAX_CAPTION = 1024;
const MAX_PHOTO = 10 * 1024 * 1024;

const PHOTO_EXT = new Set(["jpg", "jpeg", "png", "webp"]);
/** A sticker's largest side: a lone WebP no bigger goes as a sticker, which keeps its transparency (a photo is made a JPEG). */
const MAX_STICKER = 512;
/** MPEG-4 and QuickTime (what phones record): Telegram plays them inline. WebM and Ogg would arrive as files anyway. */
const VIDEO_EXT = new Set(["mp4", "m4v", "mov"]);
/** A video plays while it downloads, rather than only once it has (Telegram shows it as a file to fetch first). */
const STREAM = { supports_streaming: true };

/**
 * @param {core.App} app
 * @param {string} op
 * @param {string} messageId
 * @param {string} chatId
 */
function enqueue(app, op, messageId, chatId) {
  const row = new Record(app.findCollectionByNameOrId("tg_queue"));
  row.set("op", op);
  row.set("message", messageId);
  row.set("chat_id", chatId);
  app.save(row);
}

/**
 * messages create (saved): queue it for each group its room is linked to. A message that came from one of them is
 * queued too, for the others; the worker leaves out the group it came from. Service messages (no author, §5.3) stay
 * in the room.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function queueCreate(app, rec) {
  if (!rec.getString("author")) return;
  for (const link of linksOfRoom(app, rec.getString("room"))) enqueue(app, "send", rec.id, link.getString("chat_id"));
}

/**
 * What a messages update changes for Telegram, read before it is saved: "react" when the bot's reaction on it would
 * change (§26.9).
 * @param {core.App} app
 * @param {core.Record} rec
 * @returns {"" | "edit" | "delete" | "react"}
 */
function changeOf(app, rec) {
  const orig = rec.original();
  if (rec.getBool("deleted") && !orig.getBool("deleted")) return "delete";
  if (!rec.getBool("deleted") && rec.getString("text") !== orig.getString("text")) return "edit";
  if (rec.getString("reactions") !== orig.getString("reactions")) {
    const { botReaction } = require(`${__hooks}/telegram/reactions.js`);
    if (botReaction(app, rec) !== botReaction(app, orig)) return "react";
  }
  return "";
}

/**
 * messages update (saved): queue an edit, delete or reaction for the groups of its room. A reaction already waiting
 * for a group isn't queued again: it sends the message's reactions as they are when it goes.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {"" | "edit" | "delete" | "react"} change
 */
function queueUpdate(app, rec, change) {
  if (!change || !rec.getString("author")) return; // a service message never went to Telegram
  for (const link of linksOfRoom(app, rec.getString("room"))) {
    const chatId = link.getString("chat_id");
    if (change === "react" && waiting(app, rec.id, chatId)) continue;
    enqueue(app, change, rec.id, chatId);
  }
}

/**
 * Is a reaction of this message queued for this group and not yet taken by the worker?
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 */
function waiting(app, messageId, chatId) {
  try {
    app.findFirstRecordByFilter("tg_queue", "op = 'react' && message = {:message} && chat_id = {:chat} && locked_until = ''", {
      message: messageId,
      chat: chatId,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the worker's side

const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A header over a text, either of which may be "". */
const joined = (/** @type {string} */ header, /** @type {string} */ text) => (header && text ? `${header}\n${text}` : header || text);

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
 * @param {core.App} app
 * @param {string} id
 */
function userName(app, id) {
  try {
    return app.findRecordById("users", id).getString("name");
  } catch {
    return "";
  }
}

/**
 * What a message shows, as Telegram HTML: its author in bold over its text; a forward says whose it is, and shows its
 * original's text and files (§21.3). An anonymous link's group gets no header: only the text (and files). A message of an
 * anonymous room is the room's, and a forward of one from its room (DESIGN.md §35).
 * @param {core.App} app
 * @param {core.Record} msg
 * @param {boolean} anonymous
 */
function contentOf(app, msg, anonymous) {
  let source = msg;
  const author = msg.getBool("anonymous") ? roomName(app, msg.getString("room")) : userName(app, msg.getString("author"));
  let header = anonymous ? "" : `<b>${esc(author || "Someone")}</b>`;
  if (msg.getString("forwarded_from")) {
    const original = msg.getString("forward_of") ? findMessage(app, msg.getString("forward_of")) : null;
    const from = !msg.getBool("forwarded_anonymous")
      ? userName(app, msg.getString("forwarded_from"))
      : original
        ? sourceName(app, original.getString("room"))
        : "Anonymous";
    if (!anonymous) header += ` <i>forwarded from ${esc(from || "someone")}</i>`;
    if (msg.getString("forward_of")) source = original && !original.getBool("deleted") ? original : msg;
  }
  const text = source.getString("text");
  const plain = joined(header.replace(/<[^>]+>/g, ""), text);
  return { html: joined(header, esc(text)), plain, source, header, text };
}

/**
 * The caption of a message's files: its content, the text cut to fit Telegram's limit. A message is sent with its text
 * as a caption only when it fits, but an edit can make it longer, which Telegram would refuse (QA BUG-87).
 * @param {ReturnType<typeof contentOf>} content
 */
function captionOf({ html, plain, header, text }) {
  const over = [...plain].length - MAX_CAPTION;
  if (over <= 0) return html;
  const chars = [...text];
  return joined(header, `${esc(chars.slice(0, chars.length - over - 1).join(""))}…`);
}

/**
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 * @param {string} [filter] more conditions
 */
function mappings(app, messageId, chatId, filter = "") {
  return app
    .findRecordsByFilter("tg_messages", `message = {:message} && chat_id = {:chat}${filter}`, "tg_message_id", 0, 0, {
      message: messageId,
      chat: chatId,
    })
    .filter((r) => !!r);
}

/**
 * Record what Telegram messages a chat message became.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 * @param {any} sent Telegram's Message
 * @param {"text" | "caption" | "media"} kind
 */
function remember(app, messageId, chatId, sent, kind) {
  const row = new Record(app.findCollectionByNameOrId("tg_messages"));
  row.set("message", messageId);
  row.set("chat_id", chatId);
  row.set("tg_message_id", sent.message_id);
  row.set("direction", "out");
  row.set("kind", kind);
  app.save(row);
}

/**
 * A message's files as Telegram takes them: photos and videos (shown, and sent together as an album), and documents
 * (an album of their own: Telegram doesn't mix them). Each is its shared file (§37); one that is gone is left out.
 * @param {core.App} app
 * @param {filesystem.System} fsys
 * @param {core.Record} source
 */
function filesOf(app, fsys, source) {
  const shared = require(`${__hooks}/lib/files.js`);
  const names = /** @type {Record<string, string>} */ (JSON.parse(source.getString("file_names") || "{}") || {});
  const dims = /** @type {Record<string, number[]>} */ (JSON.parse(source.getString("file_dims") || "{}") || {});
  const rows = shared.byNames(app, source.getStringSlice("files"));
  const all = source.getStringSlice("files").filter((name) => rows.has(name));
  return all.map((name) => {
    const key = shared.keyOf(/** @type {core.Record} */ (rows.get(name)));
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const size = fsys.attributes(key).size;
    const [w, h] = Array.isArray(dims[name]) ? dims[name] : [];
    const sticker = all.length === 1 && ext === "webp" && w > 0 && h > 0 && w <= MAX_STICKER && h <= MAX_STICKER;
    const kind = sticker ? "sticker" : PHOTO_EXT.has(ext) && size <= MAX_PHOTO ? "photo" : VIDEO_EXT.has(ext) ? "video" : "document";
    const file = fsys.getReuploadableFile(key, true);
    file.name = names[name] || name.replace(/_[a-z0-9]{10}(\.[^.]*)?$/i, "$1");
    return { kind, file };
  });
}

const SEND = /** @type {Record<string, string>} */ ({
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  sticker: "sendSticker",
});

/**
 * Send a message to a group: its text (with its files as their caption when it fits), its files as one or two
 * albums, as a reply when the message it answers is there.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 */
function send(app, messageId, chatId) {
  const msg = findMessage(app, messageId);
  if (!msg || msg.getBool("deleted")) return;
  const link = linkOfChat(app, chatId);
  if (!link?.getBool("enabled") || link.getString("room") !== msg.getString("room")) return;
  // Came from this group, or already sent (a retry after the worker stopped halfway).
  if (mappings(app, messageId, chatId).length) return;

  const { html, plain, source } = contentOf(app, msg, link.getBool("anonymous"));
  const replyTo = msg.getString("reply_to") ? mappings(app, msg.getString("reply_to"), chatId)[0] : null;
  /** @type {any} */
  let reply = replyTo ? { reply_parameters: { message_id: replyTo.getInt("tg_message_id"), allow_sending_without_reply: true } } : {};

  const fsys = app.newFilesystem();
  try {
    const files = filesOf(app, fsys, source);
    const groups = [files.filter((f) => f.kind !== "document"), files.filter((f) => f.kind === "document")].filter((g) => g.length);
    // A sticker takes no caption: its text goes before it.
    const captioned = groups.length && files[0].kind !== "sticker";
    let caption = captioned && [...plain].length <= MAX_CAPTION ? { caption: html, parse_mode: "HTML" } : null;
    // No text goes alone when there is none: an anonymous link's sticker, or a forward of a deleted message.
    if (!caption && html) {
      remember(app, messageId, chatId, call("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", ...reply }), "text");
      reply = {};
    }
    for (const group of groups) {
      if (group.length === 1) {
        const f = group[0];
        const sent = call(
          SEND[f.kind],
          { chat_id: chatId, ...(f.kind === "video" ? STREAM : {}), ...(caption || {}), ...reply },
          { [f.kind]: f.file },
        );
        remember(app, messageId, chatId, sent, caption ? "caption" : "media");
      } else {
        /** @type {Record<string, any>} */
        const attach = {};
        const media = group.map((f, i) => {
          attach[`file${i}`] = f.file;
          return {
            type: f.kind,
            media: `attach://file${i}`,
            ...(f.kind === "video" ? STREAM : {}),
            ...(i === 0 && caption ? caption : {}),
          };
        });
        const sent = call("sendMediaGroup", { chat_id: chatId, media, ...reply }, attach);
        for (let i = 0; i < sent.length; i++) remember(app, messageId, chatId, sent[i], i === 0 && caption ? "caption" : "media");
      }
      caption = null;
      reply = {};
    }
  } finally {
    fsys.close();
  }
}

/**
 * Pass an edit on: the Telegram messages that hold the text (sent from here) get the new one.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 */
function edit(app, messageId, chatId) {
  const msg = findMessage(app, messageId);
  if (!msg || msg.getBool("deleted")) return;
  const content = contentOf(app, msg, !!linkOfChat(app, chatId)?.getBool("anonymous"));
  const { html } = content;
  for (const row of mappings(app, messageId, chatId, " && direction = 'out' && kind != 'media'")) {
    const id = row.getInt("tg_message_id");
    try {
      if (row.getString("kind") === "text") call("editMessageText", { chat_id: chatId, message_id: id, text: html, parse_mode: "HTML" });
      else call("editMessageCaption", { chat_id: chatId, message_id: id, caption: captionOf(content), parse_mode: "HTML" });
    } catch (err) {
      const tg = asTelegram(err);
      if (!tg || tg.transient || !/not modified/i.test(tg.message)) throw err;
    }
  }
}

/**
 * Pass a delete on: delete the Telegram messages. Bots can delete their own only for 48 hours (and others' only as an
 * admin): one that stays says it was deleted instead.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 */
function remove(app, messageId, chatId) {
  // A later part of a long Telegram message (§26.4) is only a piece of it: deleting it leaves the message there.
  for (const row of mappings(app, messageId, chatId, " && part = 0")) {
    const id = row.getInt("tg_message_id");
    try {
      call("deleteMessage", { chat_id: chatId, message_id: id });
    } catch (err) {
      const tg = asTelegram(err);
      if (!tg || tg.transient) throw err;
      if (row.getString("direction") !== "out" || row.getString("kind") === "media") continue;
      const gone = "<i>Message deleted</i>";
      try {
        if (row.getString("kind") === "text") call("editMessageText", { chat_id: chatId, message_id: id, text: gone, parse_mode: "HTML" });
        else call("editMessageCaption", { chat_id: chatId, message_id: id, caption: gone, parse_mode: "HTML" });
      } catch (err2) {
        const tg2 = asTelegram(err2);
        if (!tg2 || tg2.transient) throw err2;
      }
    }
  }
}

module.exports = { queueCreate, queueUpdate, changeOf, send, edit, remove };
