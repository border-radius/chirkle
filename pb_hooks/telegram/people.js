/// <reference path="../../types/pocketbase.d.ts" />
// Telegram senders as chat users (DESIGN.md §26.3): each gets a stand-in user ("Ann (TG)") that their messages show
// under, with their Telegram profile picture. Stand-ins can't log in (an address nobody receives mail at, a random
// password nobody knows) and take no direct messages (`no_dms`, §16.7).

const { call, download } = require(`${__hooks}/telegram/api.js`);
const { fieldError } = require(`${__hooks}/lib/records.js`);
const { nameKey, tidy } = require(`${__hooks}/lib/text.js`);

/** users.name max. */
const NAME_MAX = 32;
const SUFFIX = " (TG)";
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
 * "Ann (TG)", or "Ann 2 (TG)" and so on when that is taken (names are unique, §22.1), within users.name's 32.
 * @param {string} name
 * @param {number} n
 */
function displayName(name, n) {
  const tail = `${n > 1 ? ` ${n}` : ""}${SUFFIX}`;
  const base =
    [...tidy(name)]
      .slice(0, NAME_MAX - tail.length)
      .join("")
      .trim() || "Telegram user";
  return `${base}${tail}`;
}

/**
 * Save `user` with the first free display name for `name`.
 * @param {core.App} app
 * @param {core.Record} user
 * @param {string} name
 */
function saveWithName(app, user, name) {
  for (let n = 1; n < 1000; n++) {
    const candidate = displayName(name, n);
    try {
      app.findFirstRecordByFilter("users", "name_key = {:key} && id != {:id}", { key: nameKey(candidate), id: user.id });
      continue; // taken
    } catch {
      // free
    }
    user.set("name", candidate);
    app.save(user);
    return;
  }
  throw new Error("no free display name");
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
      saveWithName(app, user, s.name);
      row.set("name", s.name);
      row.set("username", s.username);
      app.save(row);
    }
    if (!s.isChat) refreshPhoto(app, row, user, s.id);
    return user;
  }

  const user = new Record(app.findCollectionByNameOrId("users"));
  user.set("email", `tg${s.id.replace(/\D/g, "")}.${$security.randomStringWithAlphabet(6, "abcdefghijklmnopqrstuvwxyz")}@telegram.invalid`);
  user.setPassword($security.randomString(40));
  user.set("kind", "telegram");
  user.set("no_dms", true);
  // Their Telegram username as their handle when it is one and free (§41), so "@username" means them on both sides.
  const { HANDLE, freeHandle, normalHandle } = require(`${__hooks}/lib/handles.js`);
  const wanted = normalHandle(s.username);
  if (HANDLE.test(wanted)) user.set("handle", freeHandle(app, wanted, user.id));
  saveWithName(app, user, s.name);
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
 * Is this user a Telegram stand-in (`users.kind`, §5.1)? Their messages came from Telegram and don't go back.
 * @param {core.App} app
 * @param {string} userId
 */
function isStandIn(app, userId) {
  try {
    return require(`${__hooks}/lib/users.js`).kindOf(app.findRecordById("users", userId)) === "telegram";
  } catch {
    return false;
  }
}

/**
 * users create/update request: a name ending in "(TG)", however written ("(tg)", full-width, spaced), is a stand-in's.
 * Anyone else could pass for a Telegram person, here and in the groups (QA BUG-86). Superusers name anyone.
 * @param {core.RecordRequestEvent} e
 */
function refuseStandInName(e) {
  const rec = e.record;
  if (!rec || e.hasSuperuserAuth()) return;
  const name = rec.getString("name");
  if (!rec.isNew() && name === rec.original().getString("name")) return;
  // The name as it will be stored (cleanName tidies it after this hook): "Ann (TG)\u0001" is "Ann (TG)" (QA BUG-142).
  if (nameKey(tidy(name)).replace(/\s+/g, "").endsWith(nameKey(SUFFIX).trim())) {
    throw fieldError("name", "Names ending in (TG) are for people on Telegram. Choose another one.");
  }
}

module.exports = { personOf, isStandIn, senderOf, displayName, refuseStandInName };
