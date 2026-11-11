/// <reference path="../../types/pocketbase.d.ts" />
// Messages in shared rooms (DESIGN.md §33.5, §33.6). A message written on a mirror goes to the home, which saves it
// and passes it on to every other mirror; edits, deletes and reactions go the same way, the home deciding. A copy
// keeps the message's global id (`messages.remote_id`, unique per room), which replies, edits and reactions name it by.
// A message with files is saved once its files are fetched (the worker, §33.8); a forward goes as a snapshot of what it
// shows. Service messages, reads, previews and push stay on each instance.

const { overLimit, reactionsOf, setReaction } = require(`${__hooks}/lib/reactions.js`);
/** @typedef {{ emoji: string, users: string[] }} Reaction */
const { isReactionEmoji } = require(`${__hooks}/lib/emoji.js`);
const { accessOf, canSee } = require(`${__hooks}/lib/access.js`);
const { enqueue, enqueueWork, fromPeer, gid, isMine, jsonOf, newId, originOf, peerById, peerHost, splitGid } = require(
  `${__hooks}/federation/config.js`,
);
const { gidOf, peopleFor, standInRow, userOf } = require(`${__hooks}/federation/people.js`);
const { isMirror, refusal, roomFor, roomGid, sharesOf } = require(`${__hooks}/federation/rooms.js`);

/** Files one message may have (§17.1). */
const MAX_FILES = 10;

/** A message's global id. @param {core.Record} rec */
const messageGid = (rec) => rec.getString("remote_id") || gid(rec.id);

/**
 * The message of room `roomId` that global id `g` names: a copy (by remote_id), or one written here.
 * @param {core.App} app
 * @param {string} roomId
 * @param {unknown} g
 */
function messageIn(app, roomId, g) {
  const s = splitGid(g);
  if (!s) return null;
  try {
    return app.findFirstRecordByFilter("messages", "room = {:r} && remote_id = {:g}", { r: roomId, g: String(g) });
  } catch {
    // not a copy
  }
  try {
    const rec = app.findRecordById("messages", s.id);
    return rec.getString("room") === roomId && !rec.getString("remote_id") && gid(rec.id) === g ? rec : null;
  } catch {
    return null;
  }
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
 * Reactions with people as global ids.
 * @param {core.App} app
 * @param {core.Record} rec
 */
const reactionsOut = (app, rec) =>
  reactionsOf(rec).map((/** @type {Reaction} */ r) => ({ emoji: r.emoji, users: r.users.map((u) => gidOf(app, u)) }));

/**
 * A message as a `message` event to `peer` (§33.6): a forward as what it shows (its original's text and files, now).
 * Null for one that shows nothing.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} peer
 */
function messageEvent(app, rec, peer) {
  const room = app.findRecordById("rooms", rec.getString("room"));
  let src = rec;
  if (rec.getString("forward_of")) {
    const original = findMessage(app, rec.getString("forward_of"));
    if (!original || original.getBool("deleted")) return null;
    src = original;
  }
  const names = jsonOf(src, "file_names", {});
  const files = src.getStringSlice("files").map((f) => ({ path: `/api/fed/files/${rec.id}/${f}`, name: String(names[f] || f) }));
  const reply = rec.getString("reply_to") ? findMessage(app, rec.getString("reply_to")) : null;
  const author = rec.getString("author");
  const from = rec.getString("forwarded_from");
  const reactions = reactionsOf(rec);
  const mentions = rec.getStringSlice("mentions");
  return {
    type: "message",
    room: roomGid(room),
    message: {
      id: messageGid(rec),
      author: gidOf(app, author),
      text: src.getString("text"),
      reply_to: reply ? messageGid(reply) : "",
      forwarded_from: from ? gidOf(app, from) : "",
      created: rec.getString("created"),
      files,
      reactions: reactionsOut(app, rec),
      mentions: mentions.map((u) => gidOf(app, u)),
    },
    people: peopleFor(app, peer, [author, from, ...mentions, ...reactions.flatMap((/** @type {Reaction} */ r) => r.users)]),
  };
}

/**
 * Who a change in this room goes to: the home, for a mirror's own change; every mirror but the one it came from, for
 * the home's. `all`: the sender too (the home's word on reactions is final).
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} recordId
 * @param {boolean} [all]
 * @returns {string[]} peer ids
 */
function audience(app, room, recordId, all = false) {
  const origin = originOf(app, recordId);
  if (isMirror(room)) return origin ? [] : [room.getString("peer")];
  return sharesOf(app, room.id)
    .map((/** @type {core.Record} */ s) => s.getString("peer"))
    .filter((/** @type {string} */ p) => all || p !== origin);
}

/**
 * messages create (saved): a message by someone goes to where its room is shared (§33.5).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function messageCreated(app, rec) {
  if (!rec.getString("author")) return; // a service message stays here
  const room = app.findRecordById("rooms", rec.getString("room"));
  for (const peerId of audience(app, room, rec.id)) {
    const peer = peerById(app, peerId);
    const ev = peer ? messageEvent(app, rec, peer) : null;
    if (ev) enqueue(app, peerId, ev);
  }
}

/**
 * What a messages update changes for peers, read before it is saved.
 * @param {core.Record} rec
 */
function before(rec) {
  const orig = rec.original();
  return { text: orig.getString("text"), deleted: orig.getBool("deleted"), reactions: reactionsOf(orig) };
}

/**
 * messages update request on a mirror: only its own people's messages are changed here; the home's word goes for the
 * rest (§33.5). Reactions are anyone's.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function checkMirrorChange(app, rec) {
  const orig = rec.original();
  if (rec.getString("text") === orig.getString("text") && rec.getBool("deleted") === orig.getBool("deleted")) return;
  if (originOf(app, rec.id)) return;
  let room;
  try {
    room = app.findRecordById("rooms", rec.getString("room"));
  } catch {
    return;
  }
  if (isMirror(room) && standInRow(app, orig.getString("author"))) {
    throw new BadRequestError("This message is from another instance; it is changed there.");
  }
}

/**
 * messages update (saved): an edit, delete or reaction goes where its room is shared.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {ReturnType<typeof before>} was
 */
function messageChanged(app, rec, was) {
  if (!rec.getString("author")) return;
  let room;
  try {
    room = app.findRecordById("rooms", rec.getString("room"));
  } catch {
    return;
  }
  if (!isMirror(room) && !sharesOf(app, room.id).length) return;
  const g = messageGid(rec);
  const rg = roomGid(room);
  const deleted = rec.getBool("deleted") && !was.deleted;
  const edited = !rec.getBool("deleted") && rec.getString("text") !== was.text;
  if (deleted || edited) {
    for (const peerId of audience(app, room, rec.id)) {
      enqueue(
        app,
        peerId,
        deleted
          ? { type: "delete", room: rg, message: g }
          : {
              type: "edit",
              room: rg,
              message: g,
              text: rec.getString("text"),
              mentions: rec.getStringSlice("mentions").map((u) => gidOf(app, u)),
              people: peerById(app, peerId) ? peopleFor(app, peerById(app, peerId), rec.getStringSlice("mentions")) : {},
            },
      );
    }
  }
  const now = reactionsOf(rec);
  if (deleted || JSON.stringify(now) === JSON.stringify(was.reactions)) return;
  if (isMirror(room)) {
    if (originOf(app, rec.id)) return;
    // This instance's own people's reactions, as add/remove requests.
    const has = (/** @type {typeof now} */ list, /** @type {string} */ emoji, /** @type {string} */ u) =>
      list.some((/** @type {Reaction} */ r) => r.emoji === emoji && r.users.includes(u));
    const changes = [];
    for (const r of now) for (const u of r.users) if (!has(was.reactions, r.emoji, u)) changes.push({ emoji: r.emoji, user: u, on: true });
    for (const r of was.reactions) for (const u of r.users) if (!has(now, r.emoji, u)) changes.push({ emoji: r.emoji, user: u, on: false });
    for (const c of changes) {
      if (standInRow(app, c.user)) continue;
      enqueue(app, room.getString("peer"), { type: "react", room: rg, message: g, emoji: c.emoji, on: c.on, user: gid(c.user) });
    }
    return;
  }
  for (const peerId of audience(app, room, rec.id, true)) {
    const peer = peerById(app, peerId);
    if (!peer) continue;
    enqueue(app, peerId, {
      type: "reactions",
      room: rg,
      message: g,
      list: reactionsOut(app, rec),
      people: peopleFor(
        app,
        peer,
        now.flatMap((/** @type {Reaction} */ r) => r.users),
      ),
    });
  }
}

// ---------------------------------------------------------------- events from a peer

/**
 * Save a record for a peer's event: the hooks then don't send it back to it.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} sender
 */
function saveFor(app, rec, sender) {
  fromPeer(app, rec.id, sender.id, () => app.save(rec));
}

/**
 * The room of a message event and whether this is its home; refused when the sender may not name it.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function roomOf(app, sender, ev) {
  const found = roomFor(app, sender, ev.room);
  if (!found) throw refusal(403, "That room isn't shared with you.");
  return found;
}

/**
 * A `message` event (§33.6). On the home, only from the author's own instance; on a mirror, from its home. With
 * files, it waits for the worker to fetch them (`files`: the fetched ones, then).
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 * @param {any[]} [files] filesystem.File
 */
function applyMessage(app, sender, ev, files) {
  const { room, home } = roomOf(app, sender, ev);
  const m = ev.message && typeof ev.message === "object" ? ev.message : {};
  const g = String(m.id || "");
  if (!splitGid(g)) throw refusal(400, "No message id.");
  if (messageIn(app, room.id, g)) return; // had it
  const people = ev.people && typeof ev.people === "object" ? ev.people : {};
  // Our own people write here, never through a peer: a home naming one of them as the author would speak for them
  // (QA BUG-173). What they wrote in its room it already has from us, and doesn't send back.
  if (isMine(String(m.author || ""))) throw refusal(403, "People of this instance write here themselves.");
  const author = userOf(app, sender, m.author, people, home);
  if (!author) throw refusal(403, home ? "Only your own people write here." : "The author is unknown.");
  const listed = (Array.isArray(m.files) ? m.files : []).slice(0, MAX_FILES);
  if (listed.length && !files) {
    enqueueWork(app, sender.id, "fetch", { event: ev });
    return;
  }
  const rec = new Record(app.findCollectionByNameOrId("messages"));
  rec.set("id", newId());
  rec.set("room", room.id);
  rec.set("author", author);
  rec.set("text", String(m.text || "").slice(0, 2000));
  rec.set("remote_id", g);
  const reply = m.reply_to ? messageIn(app, room.id, m.reply_to) : null;
  if (reply && !reply.getBool("deleted") && reply.getString("author")) rec.set("reply_to", reply.id);
  if (m.forwarded_from) {
    const from = userOf(app, sender, m.forwarded_from, people);
    if (from) rec.set("forwarded_from", from);
  }
  if (files?.length) require(`${__hooks}/lib/files.js`).attachUploads(app, rec, files);
  rec.set("mentions", mentionsIn(app, sender, room, author, m.mentions, people));
  if (ev.backfill && typeof m.created === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(m.created)) {
    rec.setRaw("created", m.created);
    rec.setRaw("updated", m.created);
  }
  if (!rec.getString("text") && !files?.length && !rec.getString("forwarded_from")) return; // nothing to show
  saveFor(app, rec, sender);
  const list = Array.isArray(m.reactions) ? m.reactions : [];
  if (list.length) setReactions(app, sender, rec, list, people);
}

/**
 * Who a peer's message mentions (§41): the people its event names by global id (its text's "@handle"s are the sender's
 * handles, not ours) who can see the room here, but not its author. An instance from before mentions sends none.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {core.Record} room
 * @param {string} author
 * @param {unknown} list
 * @param {Record<string, any>} people
 * @returns {string[]}
 */
function mentionsIn(app, sender, room, author, list, people) {
  if (!Array.isArray(list)) return [];
  const access = accessOf(room);
  const out = new Set();
  for (const g of list.slice(0, 20)) {
    const id = userOf(app, sender, g, people);
    if (id && id !== author && canSee(access, id)) out.add(id);
  }
  return [...out];
}

/**
 * Is this save of a message a linked instance's (it then says whom the message mentions, mentionsIn)?
 * @param {core.App} app
 * @param {core.Record} rec
 */
const isFromPeer = (app, rec) => !!originOf(app, rec.id);

/**
 * Set a message's reactions from a list naming people by global id.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {core.Record} rec
 * @param {any[]} list
 * @param {Record<string, any>} people
 */
function setReactions(app, sender, rec, list, people) {
  const out = [];
  for (const r of list.slice(0, 64)) {
    if (!r || !isReactionEmoji(r.emoji) || !Array.isArray(r.users)) continue;
    const users = [...new Set(r.users.map((/** @type {unknown} */ u) => userOf(app, sender, u, people)).filter(Boolean))];
    if (users.length) out.push({ emoji: r.emoji, users });
  }
  if (JSON.stringify(out) === JSON.stringify(reactionsOf(rec))) return;
  rec.set("reactions", out);
  saveFor(app, rec, sender);
}

/**
 * The message an edit, delete or reaction names; on the home, an edit or delete only of the sender's own people's.
 * Null when it isn't here (not shared yet, or still being fetched).
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 * @param {boolean} ownOnly
 */
function target(app, sender, ev, ownOnly) {
  const { room, home } = roomOf(app, sender, ev);
  const rec = messageIn(app, room.id, ev.message);
  if (!rec) return null;
  if (home && ownOnly && splitGid(gidOf(app, rec.getString("author")))?.host !== peerHost(sender)) {
    throw refusal(403, "Only your own people's messages are changed from there.");
  }
  return rec;
}

/**
 * An `edit` event.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyEdit(app, sender, ev) {
  const rec = target(app, sender, ev, true);
  if (!rec || rec.getBool("deleted")) return;
  // On a mirror the home names any message, but our own people's words are edited only here (QA BUG-174). A delete
  // still comes through: the home's superusers may take a message out of their room.
  if (isMine(gidOf(app, rec.getString("author")))) throw refusal(403, "People of this instance edit their messages here.");
  const text = String(ev.text || "").slice(0, 2000);
  if (text === rec.getString("text")) return;
  rec.set("text", text);
  const { room } = roomOf(app, sender, ev);
  const people = ev.people && typeof ev.people === "object" ? ev.people : {};
  rec.set("mentions", mentionsIn(app, sender, room, rec.getString("author"), ev.mentions, people));
  saveFor(app, rec, sender);
}

/**
 * A `delete` event. A message still being fetched is dropped from the queue.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyDelete(app, sender, ev) {
  const rec = target(app, sender, ev, true);
  if (!rec) {
    for (const row of app.findRecordsByFilter("fed_queue", "peer = {:p} && op = 'fetch'", "", 0, 0, { p: sender.id })) {
      if (row && jsonOf(row, "payload", {}).event?.message?.id === ev.message) app.delete(row);
    }
    return;
  }
  if (rec.getBool("deleted")) return;
  rec.set("deleted", true);
  saveFor(app, rec, sender);
}

/**
 * A `react` event on the home: one of the sender's own people's reactions, on or off.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyReact(app, sender, ev) {
  const { home } = roomOf(app, sender, ev);
  if (!home) throw refusal(403, "Reactions go to the room's home.");
  if (!isReactionEmoji(ev.emoji) || typeof ev.on !== "boolean") throw refusal(400, "Not a reaction.");
  const user = userOf(app, sender, ev.user, ev.people || {}, true);
  if (!user) throw refusal(403, "Only your own people react from there.");
  const rec = target(app, sender, ev, false);
  if (!rec || rec.getBool("deleted") || !rec.getString("author")) return;
  const list = reactionsOf(rec);
  const next = setReaction(list, ev.emoji, user, ev.on);
  // Over the limits (QA BUG-258): dropped. A mirror running these hooks refuses it first (lib/reactions.js).
  if (!next || (ev.on && overLimit(list, ev.emoji, user))) return;
  rec.set("reactions", next);
  saveFor(app, rec, sender);
}

/**
 * A `reactions` event on a mirror: the home's whole list for a message.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyReactions(app, sender, ev) {
  const { home } = roomOf(app, sender, ev);
  if (home) throw refusal(403, "Only a room's home sends its reactions.");
  const rec = target(app, sender, ev, false);
  if (!rec || rec.getBool("deleted")) return;
  setReactions(app, sender, rec, Array.isArray(ev.list) ? ev.list : [], ev.people || {});
}

module.exports = {
  MAX_FILES,
  messageGid,
  messageEvent,
  messageCreated,
  before,
  checkMirrorChange,
  messageChanged,
  applyMessage,
  applyEdit,
  applyDelete,
  applyReact,
  applyReactions,
  isFromPeer,
};
