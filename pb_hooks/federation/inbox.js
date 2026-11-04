/// <reference path="../../types/pocketbase.d.ts" />
// The routes peers call (DESIGN.md §33.6), all signed (net.js verify), and the one people call to find someone on a
// peer (POST /api/chat/remote-users).
// - POST /api/fed/inbox { events: [...] }: up to 50 events, each applied in a transaction of its own, in order. The
//   answer gives each one's status: 200 (applied, or a repeat), 4xx (refused: the sender drops it and logs why), 5xx
//   (failed for now: the sender tries it again).
// - GET /api/fed/files/{message}/{file}: a message file, to a peer the message's room is shared with.
// - GET /api/fed/avatars/{user}: the picture of someone the peer was told of.
// - GET /api/fed/users?name=&for=dm|member: one person by exact name, for a DM or to add to a shared private room.

const { canSee, accessOf } = require(`${__hooks}/lib/access.js`);
const { canManage } = require(`${__hooks}/lib/moderation.js`);
const { nameKey } = require(`${__hooks}/lib/text.js`);
const { gid, isActive, myHost, peerByHost, peerHost, splitGid } = require(`${__hooks}/federation/config.js`);
const { call, errorOf, jsonBody, verify } = require(`${__hooks}/federation/net.js`);
const fedMessages = require(`${__hooks}/federation/messages.js`);
const { applyUnpair } = require(`${__hooks}/federation/peers.js`);
const { applyUser, peopleFor, profileOf, standInRow, userOf } = require(`${__hooks}/federation/people.js`);
const fedRooms = require(`${__hooks}/federation/rooms.js`);
const fedMirror = require(`${__hooks}/federation/mirror.js`);

/** Events in one request, and from one peer in a minute (§33.6). */
const MAX_EVENTS = 50;
const PER_MINUTE = 600;

/**
 * The status to answer a failed event with: a refusal's own, 503 for a busy database (tried again), else 400 (the
 * hooks refused the save: trying again won't help).
 * @param {any} err
 */
function statusOf(err) {
  const s = Number(err?.status);
  if (s >= 400 && s < 600) return s;
  return /database is locked|busy/i.test(String(err)) ? 503 : 400;
}

/**
 * Apply one event.
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {any} ev
 * @returns {{ status: number, error: string } | void}
 */
function apply(app, peer, ev) {
  switch (ev.type) {
    case "room":
      return fedMirror.applyRoom(app, peer, ev);
    case "share":
      return fedMirror.applyShare(app, peer, ev);
    case "unshare":
      return fedMirror.applyUnshare(app, peer, ev);
    case "members":
      return fedRooms.applyMembers(app, peer, ev);
    case "message":
      return fedMessages.applyMessage(app, peer, ev);
    case "edit":
      return fedMessages.applyEdit(app, peer, ev);
    case "delete":
      return fedMessages.applyDelete(app, peer, ev);
    case "react":
      return fedMessages.applyReact(app, peer, ev);
    case "reactions":
      return fedMessages.applyReactions(app, peer, ev);
    case "user":
      return applyUser(app, peer, ev);
    default:
      return { status: 400, error: "Unknown event." };
  }
}

/**
 * Count `n` more events from the peer this minute; false when that is over the limit.
 * @param {core.App} app
 * @param {string} peerId
 * @param {number} n
 */
function withinRate(app, peerId, n) {
  const minute = Math.floor(Date.now() / 60_000);
  let ok = true;
  app.store().setFunc(`fed.rate.${peerId}`, (old) => {
    const [m, count] = String(old || "0 0")
      .split(" ")
      .map(Number);
    const used = m === minute ? count : 0;
    if (used + n > PER_MINUTE) {
      ok = false;
      return old;
    }
    return `${minute} ${used + n}`;
  });
  return ok;
}

/** @param {core.RequestEvent} e */
function inbox(e) {
  const { peer, body } = verify(e);
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BadRequestError("Not JSON.");
  }
  const events = parsed && Array.isArray(parsed.events) ? parsed.events : null;
  if (!events || events.length > MAX_EVENTS) throw new BadRequestError(`A list of at most ${MAX_EVENTS} events.`);
  if (!withinRate(e.app, peer.id, events.length)) throw new TooManyRequestsError("Too many events; try again in a minute.");
  /** @type {{ id: string, status: number, error?: string }[]} */
  const results = [];
  let unpair = false;
  for (const ev of events) {
    const id = ev && typeof ev.id === "string" ? ev.id.slice(0, 64) : "";
    if (!id || typeof ev.type !== "string") {
      results.push({ id, status: 400, error: "An event has an id and a type." });
      continue;
    }
    if (ev.type === "unpair") {
      unpair = true;
      results.push({ id, status: 200 });
      continue;
    }
    try {
      /** @type {any} */
      let answer = null;
      e.app.runInTransaction((tx) => {
        try {
          tx.findFirstRecordByFilter("fed_seen", "peer = {:p} && event = {:e}", { p: peer.id, e: id });
          return; // a repeat
        } catch {
          // new
        }
        const seen = new Record(tx.findCollectionByNameOrId("fed_seen"));
        seen.set("peer", peer.id);
        seen.set("event", id);
        tx.save(seen);
        answer = apply(tx, peer, ev);
      });
      results.push(answer ? { id, ...answer } : { id, status: 200 });
    } catch (err) {
      const status = statusOf(err);
      const error = String(/** @type {any} */ (err)?.message || err).slice(0, 300);
      e.app.logger().warn("federation: event refused", "peer", peerHost(peer), "type", ev.type, "status", status, "error", error);
      results.push({ id, status, error });
    }
  }
  if (unpair) applyUnpair(e.app, peer);
  return e.json(200, { results });
}

/**
 * GET /api/fed/files/{message}/{file}: a file of a message in a room shared with the peer (as the home, or as its
 * mirror's home). A forward's are its original's (§33.5).
 * @param {core.RequestEvent} e
 */
function file(e) {
  const { peer } = verify(e);
  const id = e.request?.pathValue("message") ?? "";
  const name = e.request?.pathValue("file") ?? "";
  let msg;
  try {
    msg = e.app.findRecordById("messages", id);
  } catch {
    throw new NotFoundError();
  }
  const room = e.app.findRecordById("rooms", msg.getString("room"));
  const shared =
    room.getString("peer") === peer.id ||
    e.app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p} && state = 'active'", "", 1, 0, { r: room.id, p: peer.id }).length >
      0;
  if (!shared || msg.getBool("deleted")) throw new NotFoundError();
  let src = msg;
  if (msg.getString("forward_of")) {
    try {
      src = e.app.findRecordById("messages", msg.getString("forward_of"));
    } catch {
      throw new NotFoundError();
    }
  }
  if (!src.getStringSlice("files").includes(name)) throw new NotFoundError();
  // Its shared file (§37).
  const files = require(`${__hooks}/lib/files.js`);
  const row = files.byName(e.app, name);
  if (!row) throw new NotFoundError();
  const fs = e.app.newFilesystem();
  try {
    fs.serve(e.response, /** @type {any} */ (e.request), files.keyOf(row), name);
  } finally {
    fs.close();
  }
}

/**
 * GET /api/fed/avatars/{user}: the picture of someone the peer was told of.
 * @param {core.RequestEvent} e
 */
function avatar(e) {
  const { peer } = verify(e);
  const id = e.request?.pathValue("user") ?? "";
  let user;
  try {
    user = e.app.findRecordById("users", id);
    e.app.findFirstRecordByFilter("fed_people", "peer = {:p} && user = {:u} && kind = 'known'", { p: peer.id, u: id });
  } catch {
    throw new NotFoundError();
  }
  const name = user.getString("avatar");
  if (!name) throw new NotFoundError();
  const fs = e.app.newFilesystem();
  try {
    fs.serve(e.response, /** @type {any} */ (e.request), `${user.baseFilesPath()}/${name}`, name);
  } finally {
    fs.close();
  }
}

/**
 * GET /api/fed/users?name=&for=dm|member: one of this instance's own people by their exact name (never a list, so
 * nobody can go through another instance's people, §33.5). For a DM, only while DMs with the peer are on and they take
 * DMs; to add to a room, only while a room is shared with the peer.
 * @param {core.RequestEvent} e
 */
function lookup(e) {
  const { peer } = verify(e);
  const q = e.requestInfo().query;
  const key = nameKey(String(q.name || "").trim());
  const forDm = q.for !== "member";
  if (!key) throw new NotFoundError();
  let user;
  try {
    user = e.app.findFirstRecordByFilter("users", "name_key = {:k}", { k: key });
  } catch {
    throw new NotFoundError();
  }
  if (standInRow(e.app, user.id)) throw new NotFoundError();
  if (forDm && (!peer.getBool("dms") || user.getBool("no_dms"))) throw new NotFoundError();
  if (!forDm && !e.app.findRecordsByFilter("fed_shares", "peer = {:p} && state = 'active'", "", 1, 0, { p: peer.id }).length) {
    throw new NotFoundError();
  }
  peopleFor(e.app, peer, [user.id]); // noted as known
  return e.json(200, { id: gid(user.id), profile: profileOf(e.app, user.id) });
}

/**
 * POST /api/chat/remote-users { address, room? } → a person on a linked instance, as a user here (their stand-in):
 * `name@host`, looked up there by exact name (§33.5). With `room`, to add them to that private room, which must be
 * the caller's, here, and shared with their instance; without, to message them.
 * @param {core.RequestEvent} e
 */
function remoteUser(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const address = typeof body.address === "string" ? body.address.trim() : "";
  const at = address.lastIndexOf("@");
  const name = at > 0 ? address.slice(0, at).trim() : "";
  const host =
    at > 0
      ? address
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : "";
  const bad = (/** @type {string} */ msg) =>
    new BadRequestError("Failed to find them.", { address: new ValidationError("validation_invalid_value", msg) });
  if (!name || !host) throw bad("Write it as name@instance, like ann@chat.example.org.");
  if (host === myHost()) throw bad("They are on this instance: find them by name.");
  const peer = peerByHost(e.app, host);
  if (!peer || !isActive(peer)) throw bad(`This instance isn't linked to ${host}.`);
  const roomId = typeof body.room === "string" ? body.room : "";
  if (roomId) {
    let room;
    try {
      room = e.app.findRecordById("rooms", roomId);
    } catch {
      throw new NotFoundError("The room doesn't exist.");
    }
    if (!canSee(accessOf(room), me.id)) throw new NotFoundError("The room doesn't exist.");
    if (!canManage(room, me) || room.getString("peer"))
      throw new ForbiddenError("Only the room's creator or a moderator adds people to it.");
    const shared = e.app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p} && state = 'active'", "", 1, 0, {
      r: room.id,
      p: peer.id,
    });
    if (!shared.length) throw bad(`This room isn't shared with ${host}.`);
  } else if (!peer.getBool("dms")) {
    throw bad(`Direct messages with people on ${host} are off.`);
  }
  /** @type {ReturnType<typeof call>} */
  let answer;
  try {
    answer = call(peer, "GET", `/api/fed/users?name=${encodeURIComponent(name)}&for=${roomId ? "member" : "dm"}`, undefined, {
      seconds: 10,
    });
  } catch {
    throw bad(`Can't reach ${host} right now.`);
  }
  if (answer.status === 404)
    throw bad(roomId ? `There's nobody called ${name} on ${host}.` : `There's nobody called ${name} on ${host} who takes direct messages.`);
  if (answer.status !== 200) {
    e.app.logger().warn("federation: lookup failed", "peer", host, "error", errorOf(answer));
    throw bad(`Can't reach ${host} right now.`);
  }
  const found = jsonBody(answer) || {};
  if (splitGid(found.id)?.host !== peerHost(peer)) throw bad(`Got an unexpected answer from ${host}.`);
  const id = userOf(e.app, peer, found.id, { [found.id]: found.profile || {} });
  if (!id) throw bad(`Got an unexpected answer from ${host}.`);
  const u = e.app.findRecordById("users", id);
  return e.json(200, {
    id: u.id,
    name: u.getString("name"),
    avatar: u.getString("avatar"),
    no_dms: u.getBool("no_dms"),
    instance: u.getString("instance"),
  });
}

module.exports = { inbox, file, avatar, lookup, remoteUser };
