/// <reference path="../../types/pocketbase.d.ts" />
// Telegram senders as chat users (DESIGN.md §26.3): each gets a stand-in user ("Ann (TG)") that their messages show
// under, with their Telegram profile picture. Stand-ins can't log in (an address nobody receives mail at, a random
// password nobody knows) and take no direct messages (`no_dms`, §16.7).

const { call, download } = require(`${__hooks}/telegram/api.js`);
const { newStandIn, refuseSuffix, saveWithName, standInName } = require(`${__hooks}/lib/bridges.js`);

const SUFFIX = " (TG)";
const FALLBACK = "Telegram user";
/** How often a sender's profile picture is checked for a change. */
const PHOTO_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Who sent a Telegram message: a user, or a chat posting as itself (an anonymous admin, a linked channel).
 * @param {any} msg
 * @returns {{ id: string, name: string, username: string, isChat: boolean }}
 */
function senderOf(msg) {
  const chat = msg.sender_chat;
  if (chat) return { id: String(chat.id), name: chat.title || chat.username || "Telegram", username: chat.username || "", isChat: true };
  const u = msg.from || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  return { id: String(u.id), name: name || u.username || "Telegram user", username: u.username || "", isChat: false };
}

/**
 * The stand-in user of a Telegram sender, made on their first message. A changed Telegram name renames it.
 * @param {core.App} app
 * @param {any} msg
 * @returns {core.Record} the users record
 */
function personOf(app, msg) {
  const s = senderOf(msg);
  let row = null;
  try {
    row = app.findFirstRecordByFilter("tg_people", "tg_user_id = {:id}", { id: s.id });
  } catch {
    row = null;
  }
  if (row) {
    const user = app.findRecordById("users", row.getString("user"));
    if (row.getString("name") !== s.name || row.getString("username") !== s.username) {
      saveWithName(app, user, s.name, SUFFIX, FALLBACK);
      row.set("name", s.name);
      row.set("username", s.username);
      app.save(row);
    }
    if (!s.isChat) refreshPhoto(app, row, user, s.id);
    return user;
  }

  const email = `tg${s.id.replace(/\D/g, "")}.${$security.randomStringWithAlphabet(6, "abcdefghijklmnopqrstuvwxyz")}@telegram.invalid`;
  const user = newStandIn(app, email, s.name, SUFFIX, FALLBACK);
  row = new Record(app.findCollectionByNameOrId("tg_people"));
  row.set("tg_user_id", s.id);
  row.set("user", user.id);
  row.set("name", s.name);
  row.set("username", s.username);
  app.save(row);
  if (!s.isChat) refreshPhoto(app, row, user, s.id);
  return user;
}

/**
 * Use the sender's Telegram profile picture as the stand-in's avatar: on their first message, then at most once a
 * day. A picture that can't be fetched is left for the next check; the stand-in keeps its initials meanwhile.
 * @param {core.App} app
 * @param {core.Record} row tg_people
 * @param {core.Record} user
 * @param {string} tgUserId
 */
function refreshPhoto(app, row, user, tgUserId) {
  const checked = row.getDateTime("photo_checked");
  if (!checked.isZero() && Date.now() - checked.unix() * 1000 < PHOTO_CHECK_MS) return;
  row.set("photo_checked", new DateTime());
  app.save(row);
  try {
    const res = call("getUserProfilePhotos", { user_id: Number(tgUserId), limit: 1 });
    const sizes = res?.photos?.[0] || [];
    // The smallest size at least 160 px wide (avatars show at up to 96 px), else the largest.
    const size = sizes.find((/** @type {any} */ p) => p.width >= 160) || sizes[sizes.length - 1];
    const id = size ? size.file_unique_id : "";
    if (id === row.getString("photo")) return;
    user.set("avatar", size ? download(size.file_id, "avatar.jpg") : null);
    app.save(user);
    row.set("photo", id);
    app.save(row);
  } catch (err) {
    app.logger().warn("telegram: profile picture", "tgUser", tgUserId, "error", String(err));
  }
}

/**
 * Is this user a Telegram stand-in? Their messages came from Telegram and don't go back.
 * @param {core.App} app
 * @param {string} userId
 */
function isStandIn(app, userId) {
  try {
    app.findFirstRecordByFilter("tg_people", "user = {:user}", { user: userId });
    return true;
  } catch {
    return false;
  }
}

/**
 * users create/update request: a name ending in "(TG)" is a stand-in's (lib/bridges.js).
 * @param {core.RecordRequestEvent} e
 */
const refuseStandInName = (e) => refuseSuffix(e, SUFFIX, "Names ending in (TG) are for people on Telegram. Choose another one.");

/** "Ann (TG)", or "Ann 2 (TG)" when that is taken. @param {string} name @param {number} n */
const displayName = (name, n) => standInName(name, n, SUFFIX, FALLBACK);

module.exports = { personOf, isStandIn, senderOf, displayName, refuseStandInName };
