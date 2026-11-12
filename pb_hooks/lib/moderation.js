/// <reference path="../../types/pocketbase.d.ts" />
// Moderators (DESIGN.md §36): people a superuser ticked `moderator` for in the admin UI. They delete anyone's messages
// (POST /api/chat/delete), change any public room's access and archive it (the rooms update rule), and ban and unban
// people (POST /api/chat/ban). A banned account can't sign in (the users authRule), its sessions end and its live
// connections close.

const { isDm } = require(`${__hooks}/lib/rooms.js`);

/**
 * Is `user` (e.auth) a moderator? Superusers aren't users, and act through the admin UI.
 * @param {core.Record | null | undefined} user
 */
function isModerator(user) {
  return !!user && user.collection().name === "users" && user.getBool("moderator") && !user.getBool("banned");
}

/**
 * May `user` change the room's access and archive it? Its creator, or a moderator; never a DM.
 * @param {core.Record} room
 * @param {core.Record | null | undefined} user
 */
function canManage(room, user) {
  if (!user || isDm(room)) return false;
  return room.getString("created_by") === user.id || isModerator(user);
}

/**
 * May `user` delete someone else's message in this room? A moderator, outside DMs.
 * @param {core.Record} room
 * @param {core.Record | null | undefined} user
 */
const canModerate = (room, user) => isModerator(user) && !isDm(room);

/**
 * users update: a ban ends the account's sessions (its tokens no longer check out). Returns whether it was banned now,
 * for afterBan once saved.
 * @param {core.Record} rec
 */
function beforeBan(rec) {
  if (rec.isNew() || !rec.getBool("banned") || rec.original().getBool("banned")) return false;
  rec.refreshTokenKey();
  return true;
}

/**
 * users update (saved) that banned someone: close their live connections, which outlive the token.
 * @param {core.App} app
 * @param {string} userId
 */
function afterBan(app, userId) {
  const broker = app.subscriptionsBroker();
  const clients = broker.clients();
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    /** @type {core.Record | null | undefined} */
    const auth = client?.get("auth");
    if (!client || !auth || auth.isSuperuser() || auth.id !== userId) continue;
    client.discard();
    broker.unregister(id);
  }
}

/**
 * users auth-with-password / OAuth2: a banned account is told so (the authRule alone answers "doesn't satisfy the
 * collection requirements"). Only once the password checks out, so a stranger learns nothing.
 * @param {core.Record | null | undefined} rec
 * @param {string | null} password the password tried; null for OAuth2, whose provider vouched for them
 */
function refuseBanned(rec, password) {
  if (!rec?.getBool("banned")) return;
  if (password !== null && !rec.validatePassword(password)) return;
  throw new ForbiddenError("This account is banned.");
}

/**
 * POST /api/chat/ban { user, banned } → the user's public profile with `banned`. Moderators only. Not themselves,
 * another moderator, or someone who doesn't sign in here (a linked instance's people, a Telegram stand-in); anyone
 * banned can be unbanned (a superuser may have banned them).
 * @param {core.RequestEvent} e
 */
function ban(e) {
  const me = e.auth;
  if (!isModerator(me)) throw new ForbiddenError("Only moderators can ban people.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const what = body.banned === false ? "Failed to unban them." : "Failed to ban them.";
  const bad = (/** @type {string} */ field, /** @type {string} */ msg) =>
    new BadRequestError(what, { [field]: new ValidationError("validation_invalid_value", msg) });
  if (typeof body.banned !== "boolean") throw bad("banned", "Say whether they are banned.");
  let user;
  try {
    user = e.app.findRecordById("users", typeof body.user === "string" ? body.user : "");
  } catch {
    throw new NotFoundError("They don't exist.");
  }
  if (user.id === me?.id) throw bad("user", "You can't ban yourself.");
  if (body.banned && user.getBool("moderator")) throw bad("user", "Moderators can't be banned here; an admin can.");
  if (body.banned && require(`${__hooks}/lib/users.js`).isStandIn(user)) {
    throw bad("user", "Only people who sign in here can be banned.");
  }
  if (user.getBool("banned") !== body.banned) {
    user.set("banned", body.banned);
    e.app.save(user);
  }
  return e.json(200, {
    id: user.id,
    name: user.getString("name"),
    avatar: user.getString("avatar"),
    no_dms: user.getBool("no_dms"),
    instance: user.getString("instance"),
    banned: user.getBool("banned"),
  });
}

module.exports = { isModerator, canManage, canModerate, beforeBan, afterBan, refuseBanned, ban };
