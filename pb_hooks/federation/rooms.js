/// <reference path="../../types/pocketbase.d.ts" />
// Shared rooms (DESIGN.md §33.5): a room lives on its home; each instance it is shared with keeps a mirror, an
// ordinary room whose `peer` is the home and `remote_id` the room's global id. The home sends the room's state (a
// `room` event) whenever it changes; a mirror takes it as it comes. Rooms are shared by superusers on both sides
// (fed_shares rows); DMs with a peer's people are shared as they are opened. This is the home's side and what both
// sides share; a mirror's side (the events it takes from the home, and its superusers' edits) is federation/mirror.js.

const { MAX_MEMBERS } = require(`${__hooks}/lib/access.js`);
const { postService } = require(`${__hooks}/lib/messages.js`);
const { fieldError } = require(`${__hooks}/lib/records.js`);
const { enqueue, gid, isActive, jsonOf, myHost, peerById, peerHost, splitGid } = require(`${__hooks}/federation/config.js`);
const { gidOf, peopleFor, standInRow, userOf } = require(`${__hooks}/federation/people.js`);

/** rooms.name max. */
const ROOM_NAME_MAX = 48;
/** What a share sends of a room's history when it starts (§33.11, milestone 6). */
const BACKFILL = 200;

/**
 * A refusal of a peer's event: its status goes back in the inbox's answer (§33.6).
 * @param {number} status
 * @param {string} message
 */
function refusal(status, message) {
  const err = /** @type {Error & { status?: number }} */ (new Error(message));
  err.status = status;
  return err;
}

/** @param {core.Record} room */
const isMirror = (room) => room.getString("peer") !== "";

/** The room's global id. @param {core.Record} room */
const roomGid = (room) => (isMirror(room) ? room.getString("remote_id") : gid(room.id));

/**
 * @param {core.App} app
 * @param {string} id
 */
function findRoom(app, id) {
  if (!id) return null;
  try {
    return app.findRecordById("rooms", id);
  } catch {
    return null;
  }
}

/**
 * The room's shares in these states.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string[]} [states]
 */
function sharesOf(app, roomId, states = ["active"]) {
  const rows = /** @type {core.Record[]} */ (
    app.findRecordsByFilter("fed_shares", "room = {:r}", "created", 0, 0, { r: roomId }).filter(Boolean)
  );
  return rows.filter((s) => states.includes(s.getString("state")));
}

/**
 * The share of the room with `peerId` that isn't over, or null.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} peerId
 */
function shareOf(app, roomId, peerId) {
  const rows = app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p} && state != 'ended'", "created", 1, 0, {
    r: roomId,
    p: peerId,
  });
  return rows[0] || null;
}

/**
 * On a mirror's side: the share of the home's room `g` with peer `peerId` that isn't over, or null.
 * @param {core.App} app
 * @param {string} peerId
 * @param {string} g
 */
function offerOf(app, peerId, g) {
  const rows = app.findRecordsByFilter("fed_shares", "peer = {:p} && remote_id = {:g} && state != 'ended'", "created", 1, 0, {
    p: peerId,
    g,
  });
  return rows[0] || null;
}

/**
 * The room a peer's event names, as the peer may name it: one of ours shared with it (`home`), or a mirror of one of
 * its rooms. Null otherwise.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {unknown} g
 * @returns {{ room: core.Record, home: boolean } | null}
 */
function roomFor(app, sender, g) {
  const s = splitGid(g);
  if (!s) return null;
  if (s.host === myHost()) {
    const room = findRoom(app, s.id);
    if (!room || isMirror(room)) return null;
    const share = shareOf(app, room.id, sender.id);
    return share && share.getString("state") === "active" ? { room, home: true } : null;
  }
  if (s.host !== peerHost(sender)) return null;
  const share = offerOf(app, sender.id, /** @type {string} */ (g));
  if (share?.getString("state") !== "active") return null;
  const room = findRoom(app, share.getString("room"));
  return room ? { room, home: false } : null;
}

// ---------------------------------------------------------------- the home's side

/**
 * The room's state as a `room` event to `peer` (§33.6): people as global ids, with the profiles it may not have.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {core.Record} peer
 * @param {string} [refused] why its `members` request was refused
 */
function roomEvent(app, room, peer, refused = "") {
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  const creator = room.getString("created_by");
  const shared = jsonOf(room, "shared", {});
  return {
    type: "room",
    room: gid(room.id),
    name: room.getString("name"),
    kind: room.getString("kind"),
    visibility: room.getString("visibility"),
    posting: room.getString("posting"),
    anonymous: room.getBool("anonymous"),
    archived: room.getBool("archived"),
    created_by: gidOf(app, creator),
    members: members.map((id) => gidOf(app, id)),
    writers: writers.map((id) => gidOf(app, id)),
    shared_with: [myHost(), ...(Array.isArray(shared.with) ? shared.with : [])],
    people: peopleFor(app, peer, [creator, ...members, ...writers]),
    ...(refused ? { refused } : {}),
  };
}

/**
 * Send the room's state to every peer it is shared with (or only `onlyPeer`).
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} [onlyPeer]
 * @param {string} [refused]
 */
function sendRoom(app, room, onlyPeer = "", refused = "") {
  for (const share of sharesOf(app, room.id)) {
    const peer = peerById(app, share.getString("peer"));
    if (!peer || (onlyPeer && peer.id !== onlyPeer)) continue;
    enqueue(app, peer.id, roomEvent(app, room, peer, refused));
  }
}

/**
 * A field's value, comparable with ===: lists of relations joined (getString has nothing for them), JSON as parsed.
 * @param {core.Record} r
 * @param {string} f
 */
const fieldValue = (r, f) =>
  f === "members" || f === "writers" ? r.getStringSlice(f).join(",") : f === "shared" ? JSON.stringify(jsonOf(r, f, {})) : r.getString(f);

/** What a room event says, compared before and after a save. @param {core.Record} r */
const stateOf = (r) =>
  ["name", "kind", "visibility", "posting", "anonymous", "archived", "created_by", "members", "writers", "shared"]
    .map((f) => fieldValue(r, f))
    .join("|");

/**
 * rooms update (saved): a home room that is shared sends its new state to every mirror.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} before stateOf the room before
 */
function roomChanged(app, room, before) {
  if (isMirror(room) || stateOf(room) === before) return;
  sendRoom(app, room);
}

/**
 * Set the home room's `shared` (§33.10: who else holds it) from its active shares. Saves it when that changed, which
 * sends its state to every mirror. Returns whether it saved.
 * @param {core.App} app
 * @param {core.Record} room
 */
function refreshShared(app, room) {
  const hosts = sharesOf(app, room.id)
    .map((s) => peerById(app, s.getString("peer")))
    .filter((p) => !!p)
    .map((p) => peerHost(/** @type {core.Record} */ (p)));
  const want = hosts.length ? { with: hosts } : {};
  if (JSON.stringify(jsonOf(room, "shared", {})) === JSON.stringify(want)) return false;
  room.set("shared", want);
  app.save(room);
  return true;
}

/**
 * rooms create (saved): a DM opened with a peer's person (POST /api/chat/dms) is shared with that peer at once
 * (§33.5): the home is here, and the peer makes its mirror. Who may DM whom was checked by the DM route (no_dms on the
 * stand-in says whether their instance takes DMs from here).
 * @param {core.App} app
 * @param {core.Record} room
 */
function roomCreated(app, room) {
  if (isMirror(room) || room.getString("kind") !== "dm") return;
  for (const id of room.getStringSlice("members")) {
    const row = standInRow(app, id);
    if (!row) continue;
    const peer = peerById(app, row.getString("peer"));
    if (!peer || !isActive(peer)) throw fieldError("members", "That instance can't be reached.");
    const share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("room", room.id);
    share.set("peer", peer.id);
    share.set("state", "active");
    share.set("kind", "dm");
    share.set("visibility", "private");
    app.save(share);
    refreshShared(app, room);
  }
}

/**
 * rooms update request on a home room: people from other instances may be made members or writers only when the room
 * is shared with their instance (§33.5), so its creator can't take it where the admins didn't.
 * @param {core.RecordRequestEvent} e
 */
function checkHomeMembers(e) {
  const rec = e.record;
  if (!rec || isMirror(rec)) return;
  const orig = rec.original();
  for (const field of ["members", "writers"]) {
    const was = new Set(orig.getStringSlice(field));
    for (const id of rec.getStringSlice(field)) {
      if (was.has(id)) continue;
      const row = standInRow(e.app, id);
      if (!row) continue;
      const share = shareOf(e.app, rec.id, row.getString("peer"));
      if (share?.getString("state") !== "active") {
        throw fieldError(field, "This room isn't shared with that person's instance.");
      }
    }
  }
}

/**
 * A `members` request from a mirror (§33.5): its own people in or out of a private room. Applied unless it breaks a
 * rule, then the room goes back to every mirror (the sender learns the outcome from it, `refused` saying why not).
 * A refusal is answered, not thrown: the room sent back with it must be kept.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 * @returns {{ status: number, error: string } | void}
 */
function applyMembers(app, sender, ev) {
  const found = roomFor(app, sender, ev.room);
  if (!found?.home) throw refusal(403, "That room isn't shared with you from here.");
  const room = found.room;
  const refuse = (/** @type {string} */ why) => {
    sendRoom(app, room, sender.id, why);
    return { status: 403, error: why };
  };
  if (room.getString("kind") !== "public" || room.getString("visibility") !== "private")
    return refuse("Only a private room's members are listed.");
  if (room.getBool("archived")) return refuse("This room is archived.");
  const add = Array.isArray(ev.add) ? ev.add.map(String) : [];
  const remove = Array.isArray(ev.remove) ? ev.remove.map(String) : [];
  const host = peerHost(sender);
  if ([...add, ...remove].some((g) => splitGid(g)?.host !== host)) return refuse("Only your own people can be added or removed.");
  const members = new Set(room.getStringSlice("members"));
  for (const g of remove) {
    const id = userOf(app, sender, g, {}, true);
    if (id && id !== room.getString("created_by")) members.delete(id);
  }
  for (const g of add) {
    const id = userOf(app, sender, g, ev.people || {}, true);
    if (!id) return refuse("Someone to add is unknown.");
    members.add(id);
  }
  if (members.size > MAX_MEMBERS) return refuse(`A room has at most ${MAX_MEMBERS} members.`);
  const before = room.getStringSlice("members").join(",");
  room.set("members", [...members]);
  if (room.getStringSlice("members").join(",") === before) {
    sendRoom(app, room, sender.id);
    return;
  }
  app.save(room); // its state goes to every mirror (roomChanged)
}

/**
 * Remove a peer's people from a home room's members and writers (a share that ended, §33.5).
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} peerId
 */
function dropPeople(app, room, peerId) {
  if (room.getString("kind") === "dm") return;
  const theirs = (/** @type {string} */ id) => standInRow(app, id)?.getString("peer") === peerId;
  const members = room.getStringSlice("members");
  const writers = room.getStringSlice("writers");
  if (!members.some(theirs) && !writers.some(theirs)) return;
  room.set(
    "members",
    members.filter((id) => !theirs(id)),
  );
  room.set(
    "writers",
    writers.filter((id) => !theirs(id)),
  );
  app.save(room);
}

/**
 * A service message, unless the room is gone or archived.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {string} text
 */
function tell(app, room, text) {
  const fresh = findRoom(app, room.id);
  if (fresh && !fresh.getBool("archived") && fresh.getString("kind") !== "dm") postService(app, fresh.id, text);
}

/**
 * End a share on this side (§33.5): on the home, the peer's people leave the room; on a mirror, it is archived and
 * keeps its history. Both sides say so in the room. `tellPeer`: send `unshare` (when it ends here first).
 * @param {core.App} app
 * @param {core.Record} share
 * @param {boolean} tellPeer
 */
function endShare(app, share, tellPeer) {
  const was = share.getString("state");
  if (was === "ended") return;
  const peer = peerById(app, share.getString("peer"));
  const host = peer ? peerHost(peer) : "another instance";
  const room = findRoom(app, share.getString("room"));
  const mirror = share.getString("remote_id") !== "";
  if (tellPeer && peer) enqueue(app, peer.id, { type: "unshare", room: mirror ? share.getString("remote_id") : room ? gid(room.id) : "" });
  share.set("state", "ended");
  app.save(share);
  if (!room || was !== "active") return;
  if (mirror) {
    tell(app, room, `This room is no longer shared with ${host}.`);
    // Kept as it was, read-only, and no longer said to be shared (§33.5). A DM is closed by its stand-in's no_dms.
    const fresh = findRoom(app, room.id);
    if (fresh) {
      if (fresh.getString("kind") !== "dm") fresh.set("archived", true);
      fresh.set("shared", {});
      app.save(fresh);
    }
  } else {
    tell(app, room, `This room is no longer shared with ${host}.`);
    dropPeople(app, room, share.getString("peer"));
    refreshShared(app, room);
  }
}

/**
 * Queue the room's latest messages for a peer that just took it (§33.11, milestone 6), oldest first.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {core.Record} peer
 */
function backfill(app, room, peer) {
  const { messageEvent } = require(`${__hooks}/federation/messages.js`);
  const recs = app.findRecordsByFilter("messages", "room = {:r} && deleted = false && author != ''", "-created,-id", BACKFILL, 0, {
    r: room.id,
  });
  // Backwards by index: recs is a Go slice, which reverse() garbles in place (its second half became the first's
  // copies, so half the messages went twice and the newest half never).
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    if (!rec) continue;
    const ev = messageEvent(app, rec, peer);
    if (ev) enqueue(app, peer.id, { ...ev, backfill: true });
  }
}

// ---------------------------------------------------------------- superusers sharing (fed_shares requests)

/**
 * fed_shares create request: a superuser on the home offers a room to a peer (§33.5, step 1).
 * @param {core.RecordRequestEvent} e
 */
function beforeOffer(e) {
  const rec = /** @type {core.Record} */ (e.record);
  const room = findRoom(e.app, rec.getString("room"));
  if (!room) throw fieldError("room", "Choose the room to share.", "validation_required");
  if (isMirror(room)) throw fieldError("room", "This room is shared with this instance; only its home can share it.");
  if (room.getString("kind") === "dm") throw fieldError("room", "Direct messages are shared as they are opened.");
  if (room.getBool("archived")) throw fieldError("room", "This room is archived.");
  const peer = peerById(e.app, rec.getString("peer"));
  if (!peer || !isActive(peer)) throw fieldError("peer", "Choose an instance this one is paired with.");
  if (shareOf(e.app, room.id, peer.id)) throw fieldError("room", "This room is already shared with that instance.");
  // An ended share before it makes way: sharing again starts afresh.
  for (const old of e.app.findRecordsByFilter("fed_shares", "room = {:r} && peer = {:p}", "", 0, 0, { r: room.id, p: peer.id })) {
    if (old) e.app.delete(old);
  }
  rec.set("remote_id", "");
  rec.set("state", "offered");
  rec.set("accepted", false);
  rec.set("last_error", "");
  rec.set("name", room.getString("name"));
  rec.set("kind", room.getString("kind"));
  rec.set("visibility", room.getString("visibility"));
}

/**
 * fed_shares create request (saved): tell the peer.
 * @param {core.App} app
 * @param {core.Record} share
 */
function afterOffer(app, share) {
  const room = /** @type {core.Record} */ (findRoom(app, share.getString("room")));
  enqueue(app, share.getString("peer"), {
    type: "share",
    room: gid(room.id),
    name: room.getString("name"),
    kind: room.getString("kind"),
    visibility: room.getString("visibility"),
  });
}

/**
 * fed_shares update request: a peer's superuser accepts an offer (ticks `accepted`), or either side ends a share
 * (`state` → ended). Nothing else of a share changes by hand. Returns what to do once saved.
 * @param {core.RecordRequestEvent} e
 * @returns {"" | "accept" | "end"}
 */
function beforeShareEdit(e) {
  const rec = /** @type {core.Record} */ (e.record);
  const orig = rec.original();
  for (const f of ["room", "peer", "remote_id", "name", "kind", "visibility"]) {
    if (rec.getString(f) !== orig.getString(f)) throw fieldError(f, "This field can't be changed.");
  }
  const state = rec.getString("state");
  if (state !== orig.getString("state")) {
    if (state !== "ended") throw fieldError("state", "A share can only be ended here.");
    // Ended once saved, by endShare, which needs it as it was.
    rec.set("state", orig.getString("state"));
    rec.set("accepted", orig.getBool("accepted"));
    return "end";
  }
  if (rec.getBool("accepted") !== orig.getBool("accepted")) {
    if (!orig.getString("remote_id")) throw fieldError("accepted", "The peer accepts a room you offer.");
    if (!rec.getBool("accepted") || orig.getString("state") !== "offered")
      throw fieldError("accepted", "It can't be taken back; end the share instead.");
    return "accept";
  }
  return "";
}

/**
 * fed_shares update request (saved).
 * @param {core.App} app
 * @param {core.Record} share
 * @param {"" | "accept" | "end"} what
 */
function afterShareEdit(app, share, what) {
  if (what === "accept") enqueue(app, share.getString("peer"), { type: "share", room: share.getString("remote_id"), accepted: true });
  if (what === "end") endShare(app, app.findRecordById("fed_shares", share.id), true);
}

/**
 * fed_shares delete request: a superuser declines an offer or ends a share; the peer is told.
 * @param {core.App} app
 * @param {core.Record} share
 */
function beforeShareDelete(app, share) {
  endShare(app, share, true);
}

// ---------------------------------------------------------------- both sides

/**
 * Before a room is deleted for good (a superuser): the peers to tell, as [peer id, room global id].
 * @param {core.App} app
 * @param {core.Record} room
 * @returns {string[][]}
 */
function peersToTell(app, room) {
  if (isMirror(room)) {
    const share = app.findRecordsByFilter("fed_shares", "room = {:r} && state = 'active'", "", 1, 0, { r: room.id })[0];
    return share ? [[share.getString("peer"), room.getString("remote_id")]] : [];
  }
  return sharesOf(app, room.id, ["offered", "active"]).map((s) => [s.getString("peer"), gid(room.id)]);
}

/**
 * A room deleted for good: its shares went with it; the peers hear that they ended.
 * @param {core.App} app
 * @param {core.Record} _room
 * @param {string[][]} peers peersToTell
 */
function tellDeleted(app, _room, peers) {
  for (const [peerId, g] of peers) enqueue(app, peerId, { type: "unshare", room: g });
}

/**
 * The rooms of a peer that can't be reached (suspended here, or not answering) say so in their header (§33.7).
 * @param {core.App} app
 * @param {string} peerId
 * @param {boolean} down
 */
function setDown(app, peerId, down) {
  for (const room of app.findRecordsByFilter("rooms", "peer = {:p}", "", 0, 0, { p: peerId })) {
    if (!room) continue;
    const shared = jsonOf(room, "shared", {});
    if (!!shared.down === down || !shared.home) continue;
    if (down) shared.down = true;
    else delete shared.down;
    room.set("shared", shared);
    app.save(room);
  }
}

module.exports = {
  ROOM_NAME_MAX,
  fieldValue,
  refusal,
  findRoom,
  shareOf,
  offerOf,
  sendRoom,
  tell,
  backfill,
  isMirror,
  roomGid,
  roomFor,
  sharesOf,
  stateOf,
  roomChanged,
  roomCreated,
  refreshShared,
  checkHomeMembers,
  applyMembers,
  endShare,
  beforeOffer,
  afterOffer,
  beforeShareEdit,
  afterShareEdit,
  beforeShareDelete,
  setDown,
  peersToTell,
  tellDeleted,
};
