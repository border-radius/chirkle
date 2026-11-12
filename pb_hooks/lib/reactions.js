/// <reference path="../../types/pocketbase.d.ts" />
// Reactions (DESIGN.md §20): POST /api/chat/reactions adds or removes one of the caller's reactions on a message.
// They live on the message itself (`messages.reactions`), so they reach clients with it: pages, realtime updates and
// the reconnect refetch (§7.5) need nothing new.

const { isReactionEmoji } = require(`${__hooks}/lib/emoji.js`);
const { isService } = require(`${__hooks}/lib/messages.js`);

/**
 * @typedef {{ emoji: string, users: string[] }} Reaction
 */

/**
 * Most different emoji on one message (QA BUG-258). One person may add as many of them as they like: their reactions
 * to a message are one row in its author's Mentions & replies (lib/inbox.js), however many there are.
 */
const MAX_EMOJI = 20;

/**
 * @param {string} field
 * @param {string} message
 */
const badRequest = (field, message) =>
  new BadRequestError("Failed to update the reaction.", { [field]: new ValidationError("validation_invalid_value", message) });

/**
 * A message's reactions, in the order they were first added. Anything malformed is dropped.
 * @param {core.Record} rec
 * @returns {Reaction[]}
 */
function reactionsOf(rec) {
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(rec.getString("reactions") || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r.emoji === "string" && Array.isArray(r.users))
    .map((r) => ({ emoji: r.emoji, users: r.users.filter((/** @type {unknown} */ u) => typeof u === "string") }))
    .filter((r) => r.users.length > 0);
}

/**
 * `list` with `user`'s `emoji` reaction added (`on`) or removed; null when that changes nothing. A new emoji goes
 * last, and an emoji nobody uses any more goes away.
 * @param {Reaction[]} list
 * @param {string} emoji
 * @param {string} user
 * @param {boolean} on
 * @returns {Reaction[] | null}
 */
function setReaction(list, emoji, user, on) {
  const r = list.find((x) => x.emoji === emoji);
  const has = !!r && r.users.includes(user);
  if (has === on) return null;
  if (on) return r ? list.map((x) => (x === r ? { emoji, users: [...x.users, user] } : x)) : [...list, { emoji, users: [user] }];
  return list.map((x) => (x === r ? { emoji, users: x.users.filter((u) => u !== user) } : x)).filter((x) => x.users.length > 0);
}

/**
 * Why `user`'s new `emoji` reaction can't be added to `list` (a message's), "" when it can: at most MAX_EMOJI
 * different emoji (QA BUG-258). Taking one back is always fine.
 * @param {Reaction[]} list
 * @param {string} emoji
 * @param {string} user
 */
function overLimit(list, emoji, user) {
  if (list.some((r) => r.emoji === emoji && r.users.includes(user))) return "";
  if (!list.some((r) => r.emoji === emoji) && list.length >= MAX_EMOJI)
    return `A message can have at most ${MAX_EMOJI} different reactions.`;
  return "";
}

/**
 * POST /api/chat/reactions { message, emoji, on } → the message, as GET /api/collections/messages/records/:id
 * answers it (the same ?expand and ?fields apply): the caller's `emoji` reaction on
 * `message` is there (`on: true`) or not (`on: false`). Idempotent, so a retry or a double click can't flip it back.
 * Only on messages the caller can see, that aren't deleted, in rooms that aren't archived.
 * @param {core.RequestEvent} e
 */
function react(e) {
  // Its ?expand can't group messages by author: refused before this runs (server/anonymous.go bindProbes, §35).
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const info = e.requestInfo();
  const body = /** @type {Record<string, unknown>} */ (info.body);
  const id = typeof body.message === "string" ? body.message : "";
  const emoji = body.emoji;
  const on = body.on;
  if (!isReactionEmoji(emoji)) throw badRequest("emoji", "Choose one of the offered emoji.");
  if (typeof on !== "boolean") throw badRequest("on", "Must be true or false.");

  // Someone else's DM gets the same answer as a message that doesn't exist.
  const notFound = () => new NotFoundError("The message doesn't exist.");
  let msg;
  try {
    msg = e.app.findRecordById("messages", id);
  } catch {
    throw notFound();
  }
  // The list rule: seen in its room. The view rule would also let the readers of a forward react to its original (§21.3).
  const rule = e.app.findCollectionByNameOrId("messages").listRule;
  if (rule === null || rule === undefined || !e.app.canAccessRecord(msg, info, rule)) throw notFound();
  if (isService(msg)) throw badRequest("message", "Service messages take no reactions.");

  // Read and write in one transaction: two people reacting at once both count. (Errors are thrown after it, so
  // they keep their status.)
  let problem = "";
  let limit = "";
  e.app.runInTransaction((tx) => {
    const rec = tx.findRecordById("messages", id);
    msg = rec;
    if (rec.getBool("deleted")) problem = "That message was deleted.";
    else if (tx.findRecordById("rooms", rec.getString("room")).getBool("archived")) problem = "This room is archived and read-only.";
    if (problem) return;
    const list = reactionsOf(rec);
    const next = setReaction(list, /** @type {string} */ (emoji), me.id, on);
    if (!next) return;
    if (on) limit = overLimit(list, /** @type {string} */ (emoji), me.id);
    if (limit) return;
    rec.set("reactions", next);
    tx.save(rec);
  });
  if (problem) throw badRequest("message", problem);
  if (limit) throw badRequest("emoji", limit);
  // The whole message, not just its reactions: a copy the client patched with a newer `updated` would hide
  // changes it hasn't heard of yet (an edit while its realtime connection was down).
  msg.set("reactions", reactionsOf(msg));
  $apis.enrichRecord(e, msg);
  return e.json(200, msg);
}

module.exports = { overLimit, react, reactionsOf, setReaction };
