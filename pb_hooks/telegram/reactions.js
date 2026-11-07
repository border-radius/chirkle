/// <reference path="../../types/pocketbase.d.ts" />
// Reactions across the bridge (DESIGN.md §26.9). Telegram tells a bot about reactions only where it is an admin
// (`message_reaction`): each person's change comes over as their stand-in's reaction on the message. The other way, a
// bot may set one reaction of its own on a message: it shows the one most of the room's own people (not Telegram's
// stand-ins, whose reactions are in the group already) reacted with, among those Telegram offers.

const { call } = require(`${__hooks}/telegram/api.js`);
const { isReactionEmoji } = require(`${__hooks}/lib/emoji.js`);
const { reactionsOf, setReaction } = require(`${__hooks}/lib/reactions.js`);

const VS16 = "️";

/** The emoji Telegram takes as a reaction (Bot API ReactionTypeEmoji), written without variation selectors. */
const TELEGRAM = new Set(
  (
    "❤ 👍 👎 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 " +
    "👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡"
  ).split(" "),
);

/**
 * The picker's emoji (§20.1) for a Telegram reaction, or "" when it has none: "❤" is "❤️", a shrug of either gender is
 * "🤷". Custom and paid reactions have no emoji.
 * @param {any} r ReactionType
 */
function fromTelegram(r) {
  if (r?.type !== "emoji" || typeof r.emoji !== "string") return "";
  const bare = r.emoji.replace(/\uFE0F/g, "").replace(/\u200D[♂♀]$/, "");
  return [r.emoji, bare, `${bare}${VS16}`].find((e) => isReactionEmoji(e)) || "";
}

/**
 * Telegram's reaction for one of the picker's emoji, or "" when it has none.
 * @param {string} emoji
 */
function toTelegram(emoji) {
  const bare = emoji.replace(/\uFE0F/g, "");
  return TELEGRAM.has(bare) ? bare : "";
}

/**
 * The bot's reaction on a message: the emoji most of the room's own people reacted with (the first used, of those
 * as many), that Telegram offers; "" for none.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function botReaction(app, rec) {
  if (rec.getBool("deleted")) return "";
  const { isStandIn } = require(`${__hooks}/telegram/people.js`);
  /** @type {Map<string, boolean>} */
  const standIns = new Map();
  const ours = (/** @type {string} */ u) => {
    if (!standIns.has(u)) standIns.set(u, isStandIn(app, u));
    return !standIns.get(u);
  };
  let best = "";
  let most = 0;
  for (const r of reactionsOf(rec)) {
    const emoji = toTelegram(r.emoji);
    if (!emoji) continue;
    const n = r.users.filter(ours).length;
    if (n > most) [best, most] = [emoji, n];
  }
  return best;
}

/**
 * A `message_reaction` update: someone's reactions on a message changed. Their stand-in's reactions on the chat message
 * change the same way (those the picker has; the rest are left out).
 * @param {core.App} app
 * @param {any} update MessageReactionUpdated
 */
function reactionOver(app, update) {
  const { mapped } = require(`${__hooks}/telegram/inbound.js`);
  const { activeLink, linkOfChat } = require(`${__hooks}/telegram/links.js`);
  if (!update?.chat || update.chat.type === "private" || (!update.user && !update.actor_chat)) return;
  const chatId = String(update.chat.id);
  const link = linkOfChat(app, chatId);
  const room = link && activeLink(app, link);
  if (!room) return;
  const found = mapped(app, chatId, update.message_id);
  if (!found || found.getString("room") !== room.id || !found.getString("author")) return;
  const emojiOf = (/** @type {any} */ list) => new Set((Array.isArray(list) ? list : []).map(fromTelegram).filter(Boolean));
  const was = emojiOf(update.old_reaction);
  const now = emojiOf(update.new_reaction);
  const changes = [
    ...[...was].filter((e) => !now.has(e)).map((e) => ({ emoji: e, on: false })),
    ...[...now].filter((e) => !was.has(e)).map((e) => ({ emoji: e, on: true })),
  ];
  if (!changes.length) return;
  const person = require(`${__hooks}/telegram/people.js`).personOf(app, { from: update.user, sender_chat: update.actor_chat });
  // Read and written in one transaction, as the reactions route does (§20.2): reactions at once all count.
  app.runInTransaction((tx) => {
    const rec = tx.findRecordById("messages", found.id);
    if (rec.getBool("deleted")) return;
    let list = reactionsOf(rec);
    for (const c of changes) list = setReaction(list, c.emoji, person.id, c.on) || list;
    if (JSON.stringify(list) === JSON.stringify(reactionsOf(rec))) return;
    rec.set("reactions", list);
    tx.save(rec);
  });
}

/**
 * Set the bot's reaction on the Telegram message a chat message is (its first, when it is several) to what the
 * message's reactions are now.
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} chatId
 */
function react(app, messageId, chatId) {
  const { linkOfChat } = require(`${__hooks}/telegram/links.js`);
  let msg;
  try {
    msg = app.findRecordById("messages", messageId);
  } catch {
    return;
  }
  if (msg.getBool("deleted")) return;
  const link = linkOfChat(app, chatId);
  if (!link?.getBool("enabled") || link.getString("room") !== msg.getString("room")) return;
  const row = app
    .findRecordsByFilter("tg_messages", "message = {:message} && chat_id = {:chat} && part = 0", "tg_message_id", 1, 0, {
      message: messageId,
      chat: chatId,
    })
    .find((r) => !!r);
  if (!row) return;
  const emoji = botReaction(app, msg);
  call("setMessageReaction", {
    chat_id: chatId,
    message_id: row.getInt("tg_message_id"),
    reaction: emoji ? [{ type: "emoji", emoji }] : [],
  });
}

module.exports = { botReaction, fromTelegram, toTelegram, reactionOver, react };
