/// <reference path="../../types/pocketbase.d.ts" />
// Telegram → chat (DESIGN.md §26.4): updates from the webhook, or from polling in development. A Telegram message
// becomes a chat message of its sender's stand-in, with its files; an album (sent as one update per item) becomes one
// message once all of it is in; an edit edits it. Telegram doesn't tell bots about deleted messages.

const { call, config, download } = require(`${__hooks}/telegram/api.js`);
const { personOf } = require(`${__hooks}/telegram/people.js`);
const { activeLink, ensureLink, linkedRoom, linkOfChat, moveLink, tellLinkChange } = require(`${__hooks}/telegram/links.js`);
const { richText } = require(`${__hooks}/telegram/rich.js`);
const { isBlank } = require(`${__hooks}/lib/text.js`);

/** The largest file the Bot API lets a bot download, and the largest attachment (§17.1). */
const MAX_FILE = 20 * 1024 * 1024;
/** messages.files maxSelect and messages.text max. */
const MAX_FILES = 10;
const MAX_TEXT = 2000;
/** An album is complete when nothing more of it came for this long. */
const ALBUM_QUIET_MS = 1500;

const mb = (/** @type {number} */ n) => `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;

/** The most of a Telegram quote that comes over, so that it leaves room for the message's own text. */
const MAX_QUOTE = 500;

/**
 * Who a message came from first (a MessageOrigin: a forward's, an external reply's), or "".
 * @param {any} o
 */
function originName(o) {
  if (!o) return "";
  return o.type === "user"
    ? [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(" ")
    : o.type === "hidden_user"
      ? o.sender_user_name
      : o.type === "chat"
        ? o.sender_chat.title
        : o.type === "channel"
          ? o.chat.title
          : "";
}

/**
 * "Forwarded from Bob", when the Telegram message is a forward.
 * @param {any} msg
 */
function forwardLine(msg) {
  if (!msg.forward_origin) return "";
  return `↪ Forwarded from ${originName(msg.forward_origin) || "someone"}`;
}

/**
 * What a Telegram reply quotes, as lines over its text: the part it quotes ("> …"), and whom it answers when the room
 * can't show that as a reply: a message in another chat (a channel's post) or one the bridge doesn't know. A reply to
 * a message in the room that quotes nothing needs no lines: it replies to it there.
 * @param {any} msg
 * @param {boolean} known its reply_to_message is in the room
 */
function quoteLines(msg, known) {
  const ext = msg.external_reply;
  const replied = msg.reply_to_message;
  const quote = String(msg.quote?.text || "").trim();
  if (!ext && !quote) return [];
  /** @type {string[]} */
  const lines = [];
  let from = null;
  if (ext) from = originName(ext.origin) || ext.chat?.title || "";
  else if (replied && !known)
    from = replied.sender_chat?.title || [replied.from?.first_name, replied.from?.last_name].filter(Boolean).join(" ");
  if (from !== null) lines.push(`↩ In reply to ${from || "a message"}`);
  if (quote) {
    const chars = [...quote];
    const cut = chars.length <= MAX_QUOTE ? quote : `${chars.slice(0, MAX_QUOTE - 1).join("")}…`;
    lines.push(...cut.split("\n").map((l) => `> ${l}`));
  }
  return lines;
}

/**
 * A Telegram message's text (its caption, or a rich message's blocks as text), its files (that can be brought over),
 * and lines for what can't be: files over the download limit, and things that aren't files (a location, a poll…).
 * @param {any} msg
 * @returns {{ text: string, files: { id: string, name: string }[], notes: string[] }}
 */
function partsOf(msg) {
  /** @type {{ id: string, name: string }[]} */
  const files = [];
  /** @type {string[]} */
  const notes = [];
  const n = msg.message_id;
  /**
   * @param {any} f
   * @param {string} name
   */
  const add = (f, name) => {
    if (f.file_size && f.file_size > MAX_FILE) notes.push(`[${name}, ${mb(f.file_size)}: too large to bring over from Telegram]`);
    else files.push({ id: f.file_id, name });
  };
  if (msg.photo?.length) add(msg.photo[msg.photo.length - 1], `photo_${n}.jpg`);
  if (msg.video) add(msg.video, msg.video.file_name || `video_${n}.mp4`);
  // A GIF comes as an animation, with a document of the same file next to it.
  if (msg.animation) add(msg.animation, msg.animation.file_name || `animation_${n}.mp4`);
  else if (msg.document) add(msg.document, msg.document.file_name || `file_${n}`);
  if (msg.audio) add(msg.audio, msg.audio.file_name || `audio_${n}.mp3`);
  if (msg.voice) add(msg.voice, `voice_${n}.ogg`);
  if (msg.video_note) add(msg.video_note, `video_note_${n}.mp4`);
  if (msg.sticker) {
    if (msg.sticker.is_animated) notes.push(`[sticker ${msg.sticker.emoji || ""}]`.replace(" ]", "]"));
    else add(msg.sticker, `sticker_${n}.${msg.sticker.is_video ? "webm" : "webp"}`);
  }
  const loc = msg.venue ? msg.venue.location : msg.location;
  if (loc) {
    const where = `https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}`;
    notes.push(msg.venue ? `[${msg.venue.title}, ${msg.venue.address}: ${where}]` : `[location: ${where}]`);
  }
  if (msg.contact)
    notes.push(`[contact: ${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(" ")} ${msg.contact.phone_number}]`);
  if (msg.poll) notes.push(`[poll: ${msg.poll.question}]`);
  if (msg.dice) notes.push(`[${msg.dice.emoji} ${msg.dice.value}]`);
  // A rich message (Bot API 10.1) has neither text nor caption: without this it was taken for a service message.
  const text = msg.text || msg.caption || (msg.rich_message ? richText(msg.rich_message, n, add, notes) : "");
  return { text, files, notes };
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
 * What a Telegram message came over as: its tg_messages rows (either way), first part first. `date` is the Telegram
 * message's, when known: rows older than it are stale and left out (`current`).
 * @param {core.App} app
 * @param {string} chatId
 * @param {number} tgId
 * @param {number} [date]
 */
function partsMapped(app, chatId, tgId, date = 0) {
  return app
    .findRecordsByFilter("tg_messages", "chat_id = {:chat} && tg_message_id = {:id}", "part", 0, 0, { chat: chatId, id: tgId })
    .filter((r) => !!r)
    .filter((r) => current(r, date));
}

/**
 * Clock skew allowed between Telegram and this server when telling a mapping from a stale one.
 * A mapping is made once its Telegram message exists, so one made well before it was sent is another message's: a
 * group that became a supergroup, before its mappings stayed with the old group (QA BUG-257), had the new group's ids,
 * which start over, stand for its old messages.
 */
const SKEW_MS = 5 * 60_000;

/**
 * Is a tg_messages row this Telegram message's, which was sent at `date` (Unix seconds; 0 when unknown)?
 * @param {core.Record} row
 * @param {number} date
 */
const current = (row, date) => !date || row.getDateTime("created").time().unixMilli() >= date * 1000 - SKEW_MS;

/**
 * The chat message a Telegram message is (either way; its first part, when it came over as several), or null.
 * `date` is the Telegram message's, when known: a mapping older than it is stale.
 * @param {core.App} app
 * @param {string} chatId
 * @param {number} tgId
 * @param {number} [date]
 */
function mapped(app, chatId, tgId, date = 0) {
  const row = partsMapped(app, chatId, tgId, date).find((r) => r.getInt("part") === 0);
  return row ? findMessage(app, row.getString("message")) : null;
}

/**
 * Drop the stale mappings of a Telegram message (see `current`), before it gets its own.
 * @param {core.App} tx
 * @param {string} chatId
 * @param {number} tgId
 */
function forgetStale(tx, chatId, tgId) {
  for (const row of tx.findRecordsByFilter("tg_messages", "chat_id = {:chat} && tg_message_id = {:id}", "", 0, 0, {
    chat: chatId,
    id: tgId,
  })) {
    if (row) tx.delete(row);
  }
}

/**
 * Save the tg_messages row of a part of a Telegram message.
 * @param {core.App} tx
 * @param {string} messageId
 * @param {string} chatId
 * @param {number} tgId
 * @param {"text" | "media"} kind
 * @param {number} part
 */
function rememberIn(tx, messageId, chatId, tgId, kind, part) {
  const row = new Record(tx.findCollectionByNameOrId("tg_messages"));
  row.set("message", messageId);
  row.set("chat_id", chatId);
  row.set("tg_message_id", tgId);
  row.set("direction", "in");
  row.set("kind", kind);
  row.set("part", part);
  tx.save(row);
}

/**
 * A further part of a long Telegram message: its text, under the same stand-in, after the first.
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
 * hook checks both, §23, §23.6): the Telegram group decides who speaks.
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
 * Bring Telegram messages over as one chat message: one message, or the items of an album.
 * @param {core.App} app
 * @param {core.Record} link tg_links
 * @param {core.Record} room
 * @param {any[]} msgs
 */
function bringOver(app, link, room, msgs) {
  const chatId = link.getString("chat_id");
  // Delivered twice (a webhook retry): brought over already, or an album item queued twice, which would fail the save
  // of the whole album on the unique (chat_id, tg_message_id) (QA BUG-147).
  const seen = new Set();
  msgs = msgs.filter((m) => !seen.has(m.message_id) && seen.add(m.message_id) && !mapped(app, chatId, m.message_id, m.date));
  if (!msgs.length) return;
  msgs.sort((a, b) => a.message_id - b.message_id);
  const first = msgs[0];
  const parts = msgs.map(partsOf);
  const notes = parts.flatMap((p) => p.notes);
  // A service message (a new group photo, a timer, a topic…) has nothing to show: it makes no stand-in, and none joins
  // a private room for it (QA BUG-88).
  if (!notes.length && !parts.some((p) => p.files.length) && !parts.some((p) => p.text.trim())) return;
  const author = personOf(app, first);
  ensureMember(app, room, author.id);

  /** @type {any[]} */
  const files = [];
  for (const f of parts.flatMap((p) => p.files)) {
    if (files.length >= MAX_FILES) {
      notes.push(`[${f.name}: more files than a message holds]`);
      continue;
    }
    try {
      files.push(download(f.id, f.name));
    } catch (err) {
      app.logger().warn("telegram: download", "chat", chatId, "error", String(err));
      notes.push(`[${f.name}: couldn't be brought over from Telegram]`);
    }
  }
  const reply = first.reply_to_message ? mapped(app, chatId, first.reply_to_message.message_id, first.reply_to_message.date) : null;
  const known = !!reply && reply.getString("room") === room.id && !reply.getBool("deleted");
  const textOf = (/** @type {boolean} */ withReply) =>
    [forwardLine(first), ...quoteLines(first, withReply && known), ...parts.map((p) => p.text), ...notes].filter(Boolean).join("\n");
  if (!textOf(true).trim() && !files.length) return;

  // The messages and what they map to in one transaction: the outbound hook queues them for the room's other linked
  // groups, and the worker must find they came from this one (outbound.js), never send them back. A text too long for
  // one message comes as several: the first with the files and the reply, the rest after it.
  const save = (/** @type {boolean} */ withReply) =>
    app.runInTransaction((tx) => {
      const pieces = split(textOf(withReply));
      const ids = orderedIds(pieces.length);
      const rec = new Record(tx.findCollectionByNameOrId("messages"));
      rec.id = ids[0];
      rec.set("room", room.id);
      rec.set("author", author.id);
      rec.set("text", pieces[0]);
      if (files.length) require(`${__hooks}/lib/files.js`).attachUploads(tx, rec, files);
      if (withReply && known && reply) rec.set("reply_to", reply.id);
      tx.save(rec);
      msgs.forEach((m, i) => {
        forgetStale(tx, chatId, m.message_id);
        rememberIn(tx, rec.id, chatId, m.message_id, i === 0 ? "text" : "media", 0);
      });
      for (let i = 1; i < pieces.length; i++) {
        const part = savePart(tx, room.id, author.id, pieces[i], ids[i]);
        rememberIn(tx, part.id, chatId, first.message_id, "text", i);
      }
    });
  try {
    save(true);
  } catch (err) {
    if (!reply) throw err;
    save(false); // the quoted message went meanwhile: without the quote, as the app does (§19)
  }
}

/**
 * A Telegram edit: the chat message gets the new text.
 * @param {core.App} app
 * @param {any} msg
 */
function editOver(app, msg) {
  const chatId = String(msg.chat.id);
  const rows = partsMapped(app, chatId, msg.message_id, msg.date);
  const rec = rows[0]?.getInt("part") === 0 ? findMessage(app, rows[0].getString("message")) : null;
  if (!rec || rec.getBool("deleted") || rec.getString("forwarded_from")) return;
  const quoted = quoteLines(msg, !!rec.getString("reply_to"));
  const { text, notes } = partsOf(msg);
  const lines = [forwardLine(msg), ...quoted, text, ...notes].filter(Boolean);
  const pieces = split(lines.join("\n"));
  if (!pieces[0] && !rec.getStringSlice("files").length) return;
  // The parts still in the room get the pieces in order: a shorter text deletes the parts left over, a longer one adds
  // parts (after what came since). A deleted message can't come back, so a part deleted meanwhile is passed over.
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
      rememberIn(tx, part.id, chatId, msg.message_id, "text", next + i - parts.length - 1);
    }
  });
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
 * Queue an album's item: the album becomes one message when it is complete (flushAlbums).
 * @param {core.App} app
 * @param {any} msg
 */
function queueAlbumItem(app, msg) {
  const row = new Record(app.findCollectionByNameOrId("tg_queue"));
  row.set("op", "album");
  row.set("chat_id", String(msg.chat.id));
  row.set("album", msg.media_group_id);
  row.set("payload", msg);
  app.save(row);
}

/**
 * Take an album's queued items, so only one caller brings it over.
 * @param {core.App} app
 * @param {string} chatId
 * @param {string} album
 * @returns {any[]} its Telegram messages
 */
function takeAlbum(app, chatId, album) {
  /** @type {any[]} */
  const msgs = [];
  app.runInTransaction((tx) => {
    const rows = tx.findRecordsByFilter("tg_queue", "op = 'album' && chat_id = {:chat} && album = {:album}", "created", 0, 0, {
      chat: chatId,
      album,
    });
    for (const row of rows) {
      if (!row) continue;
      msgs.push(JSON.parse(row.getString("payload") || "null"));
      tx.delete(row);
    }
  });
  return msgs.filter(Boolean);
}

/**
 * Bring over queued albums: those of `chatId` except `except` (something else came after them, so they are complete),
 * or with no chat given, those quiet for ALBUM_QUIET_MS or full. `renew` (the worker's lock) after each one.
 * @param {core.App} app
 * @param {string} [chatId]
 * @param {string} [except]
 * @param {() => void} [renew]
 */
function flushAlbums(app, chatId, except, renew) {
  const rows = chatId
    ? app.findRecordsByFilter("tg_queue", "op = 'album' && chat_id = {:chat}", "created", 0, 0, { chat: chatId })
    : app.findRecordsByFilter("tg_queue", "op = 'album'", "created", 0, 0);
  /** @type {Map<string, { chat: string, album: string, last: number, count: number }>} */
  const groups = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = `${row.getString("chat_id")} ${row.getString("album")}`;
    const g = groups.get(key) || { chat: row.getString("chat_id"), album: row.getString("album"), last: 0, count: 0 };
    g.last = Math.max(g.last, row.getDateTime("created").time().unixMilli());
    g.count++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    if (chatId ? g.album === except : g.count < MAX_FILES && Date.now() - g.last < ALBUM_QUIET_MS) continue;
    const msgs = takeAlbum(app, g.chat, g.album);
    const link = linkOfChat(app, g.chat);
    const room = link && activeLink(app, link);
    if (!msgs.length || !link || !room) continue;
    try {
      bringOver(app, link, room, msgs);
    } catch (err) {
      app.logger().error("telegram: album", "chat", g.chat, "error", String(err));
    }
    renew?.();
  }
}

/** /chatid or /start, maybe addressed to the bot ("/chatid@my_bot"). */
const COMMAND = /^\/(chatid|start)(@\w+)?(\s|$)/;

/**
 * Tell a group its id and whether it is linked: what a superuser needs to link it in the admin UI.
 * @param {core.App} app
 * @param {string} chatId
 */
function sayStatus(app, chatId) {
  const link = linkOfChat(app, chatId);
  const room = link && activeLink(app, link);
  const text = room
    ? `This group is linked to the chat room "${room.getString("name")}". Chat id: ${chatId}`
    : `This group isn't linked to a chat room yet. Chat id: ${chatId}\nAn admin of the chat links it in the admin UI (collection tg_links).`;
  call("sendMessage", { chat_id: chatId, text });
}

/**
 * Handle one update, from the webhook or polling.
 * @param {core.App} app
 * @param {any} update
 */
function handleUpdate(app, update) {
  if (update.my_chat_member) return memberChange(app, update.my_chat_member);
  // Sent only where the bot is an admin (§26.9). What came before it must be there to react to.
  if (update.message_reaction) {
    if (update.message_reaction.chat) flushAlbums(app, String(update.message_reaction.chat.id));
    return require(`${__hooks}/telegram/reactions.js`).reactionOver(app, update.message_reaction);
  }
  // A channel's posts and their edits come as channel_post and edited_channel_post, sent as the channel itself.
  const posted = update.message || update.channel_post;
  const edited = update.edited_message || update.edited_channel_post;
  const msg = posted || edited;
  if (!msg?.chat) return;
  const chatId = String(msg.chat.id);
  if (msg.chat.type === "private") {
    if (posted)
      call("sendMessage", { chat_id: chatId, text: "I bring messages between Telegram groups and chat rooms. Add me to a group." });
    return;
  }
  // A group that became a supergroup: Telegram says so in both, in either order (QA BUG-89).
  // The old group's albums come over first, under its id: their messages are its own.
  if (msg.migrate_to_chat_id) {
    flushAlbums(app, chatId);
    return moveLink(app, chatId, String(msg.migrate_to_chat_id));
  }
  if (msg.migrate_from_chat_id) {
    flushAlbums(app, String(msg.migrate_from_chat_id));
    return moveLink(app, String(msg.migrate_from_chat_id), chatId);
  }
  const link = ensureLink(app, msg.chat);
  if (posted && COMMAND.test(msg.text || "")) return sayStatus(app, chatId);
  const room = activeLink(app, link);
  if (!room) return;
  if (posted && msg.media_group_id) {
    flushAlbums(app, chatId, msg.media_group_id);
    queueAlbumItem(app, msg);
    return;
  }
  flushAlbums(app, chatId); // what came before this must show before it
  if (edited) editOver(app, msg);
  else if (!msg.new_chat_members && !msg.left_chat_member && !msg.pinned_message && !msg.new_chat_title) bringOver(app, link, room, [msg]);
}

/**
 * The bot was added to a group, or removed from it.
 * @param {core.App} app
 * @param {any} change
 */
function memberChange(app, change) {
  if (change.chat.type === "private") return;
  const status = change.new_chat_member?.status;
  const link = ensureLink(app, change.chat);
  if (status === "left" || status === "kicked") {
    app.runInTransaction((tx) => {
      // Read again in the transaction: the same news twice at once must tell the room once.
      const fresh = tx.findRecordById("tg_links", link.id);
      const was = linkedRoom(fresh);
      if (!was) return;
      fresh.set("enabled", false);
      // Past the tg_links hooks, which would tell the room it was disconnected without saying why.
      tx.unsafeWithoutHooks().save(fresh);
      tellLinkChange(tx, fresh, was, "", ": the bot was removed from the group");
    });
    return;
  }
  const was = change.old_chat_member?.status;
  if ((status === "member" || status === "administrator") && (was === "left" || was === "kicked")) sayStatus(app, String(change.chat.id));
}

/**
 * POST /api/telegram/webhook: an update from Telegram, which signs it with the secret given to setWebhook. Always
 * answers 200 once the secret is right: Telegram would retry a failed update, and one that can't be handled
 * (logged) shouldn't block the ones after it.
 * @param {core.RequestEvent} e
 */
function webhook(e) {
  const given = e.request ? e.request.header.get("X-Telegram-Bot-Api-Secret-Token") : "";
  if (!$security.equal(given, config().secret)) throw new UnauthorizedError("Wrong secret."); // in constant time (QA BUG-91)
  const update = e.requestInfo().body;
  try {
    handleUpdate(e.app, update);
  } catch (err) {
    e.app.logger().error("telegram: update", "update", update?.update_id, "error", String(err));
  }
  return e.json(200, { ok: true });
}

module.exports = { webhook, handleUpdate, flushAlbums, mapped };
