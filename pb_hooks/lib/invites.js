/// <reference path="../../types/pocketbase.d.ts" />
// Room invite links (DESIGN.md §44, REFACTOR P9): whoever may change a private room's members (its creator, or a
// moderator who is in it, §36) shares a link, /invite/<token>, that adds whoever opens it, signed in, to the members.
// One link per room at a time, kept in `room_invites` (migration 54, no API rules): made again, the old one stops
// working; revoked, it is deleted. It expires after 1, 7 or 30 days, and stops working once the room is no longer
// private (the rooms update hook deletes it, dropInvites) or while it is archived.
//
// The token is 24 random letters and digits (about 143 bits): it is the whole secret, so no rate limit guards it.

const { MAX_MEMBERS, accessOf, sees, viewerOf } = require(`${__hooks}/lib/access.js`);
const { isDm } = require(`${__hooks}/lib/rooms.js`);

/** How long a new link works, in days: the choices the clients offer. */
const DAYS = [1, 7, 30];
/** When none is given. */
const DEFAULT_DAYS = 7;
const TOKEN_LENGTH = 24;
/** What a link that doesn't work (any more) says: never which of the reasons, so a token tells nothing. */
const GONE = "This invite link has expired or was revoked.";

/** PocketBase's date text for `ms`. @param {number} ms */
const dbDate = (ms) => new Date(ms).toISOString().replace("T", " ");
/** @param {string} s PocketBase's date text */
const msOf = (s) => Date.parse(s.replace(" ", "T"));

/**
 * The room's invite row, or null.
 * @param {core.App} app
 * @param {string} roomId
 */
function inviteOf(app, roomId) {
  try {
    return app.findFirstRecordByFilter("room_invites", "room = {:r}", { r: roomId });
  } catch {
    return null;
  }
}

/** Has the link run out? @param {core.Record} inv @param {number} [now] */
const expired = (inv, now = Date.now()) => msOf(inv.getString("expires")) <= now;

/**
 * What the managing routes answer: the room's working link, or null.
 * @param {core.Record | null} inv
 */
function answer(inv) {
  if (!inv || expired(inv)) return { invite: null };
  return {
    invite: {
      token: inv.getString("token"),
      created: inv.getString("created"),
      expires: inv.getString("expires"),
      uses: inv.getInt("uses"),
    },
  };
}

/**
 * The room in the path, for someone who may manage its link: signed in, sees it, its creator or a moderator, not a DM,
 * not a copy of another instance's room (§33.5: its members are changed there). Throws what to answer otherwise.
 * @param {core.RequestEvent} e
 */
function managedRoom(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  const id = e.request?.pathValue("room") ?? "";
  let room;
  try {
    room = e.app.findRecordById("rooms", id);
  } catch {
    throw new NotFoundError("This room doesn't exist.");
  }
  if (!sees(viewerOf(e.auth), accessOf(room))) throw new NotFoundError("This room doesn't exist.");
  const { canManage } = require(`${__hooks}/lib/moderation.js`);
  if (isDm(room) || !canManage(room, e.auth)) {
    throw new ForbiddenError("Only the room's creator or a moderator can share an invite link.");
  }
  if (room.getString("peer")) throw new BadRequestError("This room's home is another instance: invite people there.");
  return room;
}

/**
 * GET /api/chat/rooms/{room}/invite → { invite: { token, created, expires, uses } | null }: the room's working link.
 * @param {core.RequestEvent} e
 */
function get(e) {
  const room = managedRoom(e);
  if (room.getString("visibility") !== "private") return e.json(200, { invite: null });
  return e.json(200, answer(inviteOf(e.app, room.id)));
}

/**
 * POST /api/chat/rooms/{room}/invite { days: 1 | 7 | 30 } → a new link (as GET answers), replacing the room's last one.
 * Private rooms only, and not archived ones.
 * @param {core.RequestEvent} e
 */
function create(e) {
  const room = managedRoom(e);
  if (room.getString("visibility") !== "private") throw new BadRequestError("Only a private room has an invite link.");
  if (room.getBool("archived")) throw new BadRequestError("This room is archived.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body ?? {});
  const days = body.days === undefined || body.days === null ? DEFAULT_DAYS : body.days;
  if (typeof days !== "number" || !DAYS.includes(days)) {
    throw new BadRequestError("Failed to make the invite link.", {
      days: new ValidationError("validation_invalid_value", `A link works for ${DAYS.join(", ")} days.`),
    });
  }
  /** @type {core.Record | null} */
  let made = null;
  e.app.runInTransaction((tx) => {
    const old = inviteOf(tx, room.id);
    if (old) tx.delete(old);
    const inv = new Record(tx.findCollectionByNameOrId("room_invites"));
    inv.set("room", room.id);
    inv.set("token", $security.randomString(TOKEN_LENGTH));
    inv.set("created_by", e.auth?.id ?? "");
    inv.set("expires", dbDate(Date.now() + days * 24 * 3600_000));
    inv.set("uses", 0);
    tx.save(inv);
    made = inv;
  });
  return e.json(200, answer(made));
}

/**
 * DELETE /api/chat/rooms/{room}/invite → 204: the link stops working. Nothing to revoke is fine too.
 * @param {core.RequestEvent} e
 */
function revoke(e) {
  const room = managedRoom(e);
  const inv = inviteOf(e.app, room.id);
  if (inv) e.app.delete(inv);
  return e.noContent(204);
}

/**
 * The working invite the path's token names, with its room; null when there is none (unknown, expired, revoked, the
 * room no longer private or archived, a DM).
 * @param {core.App} app
 * @param {string} token
 */
function working(app, token) {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return null;
  let inv;
  try {
    inv = app.findFirstRecordByFilter("room_invites", "token = {:t}", { t: token });
  } catch {
    return null;
  }
  if (expired(inv)) return null;
  let room;
  try {
    room = app.findRecordById("rooms", inv.getString("room"));
  } catch {
    return null;
  }
  if (isDm(room) || room.getString("visibility") !== "private" || room.getBool("archived")) return null;
  return { inv, room };
}

/**
 * GET /api/chat/invites/{token} → { room: { id, name, members }, by, expires, member }: what the link is to, for its
 * page (guests too: the link is the secret, and they are asked to log in or sign up to join). `members` counts its
 * members; `by` is who made the link; `member` says whether you are in already.
 * 404 when it doesn't work.
 * @param {core.RequestEvent} e
 */
function preview(e) {
  const found = working(e.app, e.request?.pathValue("token") ?? "");
  if (!found) throw new NotFoundError(GONE);
  const { inv, room } = found;
  const members = room.getStringSlice("members");
  let by = "";
  try {
    by = e.app.findRecordById("users", inv.getString("created_by")).getString("name");
  } catch {}
  const me = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  return e.json(200, {
    room: { id: room.id, name: room.getString("name"), members: members.length },
    by,
    expires: inv.getString("expires"),
    member: !!me && (members.includes(me) || room.getString("created_by") === me),
  });
}

/**
 * POST /api/chat/invites/{token} → { room }: join the room as a member (signed in). Already in, nothing changes. 404
 * when the link doesn't work; 400 when the room is full. The room's save goes through its hooks, so whoever is in it
 * (the new member too) hears of it live (§23.4), and a shared room's peers are told (§33).
 * @param {core.RequestEvent} e
 */
function join(e) {
  if (!e.auth || e.auth.isSuperuser()) throw new UnauthorizedError("Log in to join the room.");
  const me = e.auth.id;
  const token = e.request?.pathValue("token") ?? "";
  /** @type {string} */
  let roomId = "";
  e.app.runInTransaction((tx) => {
    const found = working(tx, token);
    if (!found) throw new NotFoundError(GONE);
    const { inv, room } = found;
    roomId = room.id;
    const members = room.getStringSlice("members");
    if (members.includes(me) || room.getString("created_by") === me) return;
    if (members.length >= MAX_MEMBERS) throw new BadRequestError(`This room is full: it has ${MAX_MEMBERS} members.`);
    room.set("members", [...members, me]);
    tx.save(room);
    inv.set("uses", inv.getInt("uses") + 1);
    tx.save(inv);
  });
  return e.json(200, { room: roomId });
}

/**
 * rooms update (saved): a room that stopped being private has no invite link. Made private again, it needs a new one,
 * so an old link doesn't come back to life. Only on that change: every DM message saves its room.
 * @param {core.App} app
 * @param {string} wasVisibility
 * @param {core.Record} room
 */
function dropInvites(app, wasVisibility, room) {
  if (wasVisibility !== "private" || room.getString("visibility") === "private") return;
  const inv = inviteOf(app, room.id);
  if (inv) app.delete(inv);
}

module.exports = { DAYS, DEFAULT_DAYS, GONE, get, create, revoke, preview, join, dropInvites };
