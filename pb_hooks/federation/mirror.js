/// <reference path="../../types/pocketbase.d.ts" />
// Shared rooms on a mirror's side (DESIGN.md §33.5): the events a home sends about its rooms (share, unshare, room),
// and what a mirror's superusers may change themselves (its name; in a private room, their own people, which goes to
// the home as a `members` request). The home's side is federation/rooms.js.

const { MAX_MEMBERS } = require(`${__hooks}/lib/access.js`);
const { fieldError } = require(`${__hooks}/lib/records.js`);
const { nameKey, stripHashes, tidy } = require(`${__hooks}/lib/text.js`);
const { enqueue, gid, jsonOf, myHost, newId, peerById, peerHost, splitGid } = require(`${__hooks}/federation/config.js`);
const { peopleFor, standInRow, userOf } = require(`${__hooks}/federation/people.js`);
const {
  ROOM_NAME_MAX,
  backfill,
  endShare,
  fieldValue,
  findRoom,
  isMirror,
  offerOf,
  refreshShared,
  refusal,
  sendRoom,
  shareOf,
  tell,
} = require(`${__hooks}/federation/rooms.js`);

// ---------------------------------------------------------------- events from the peer

/**
 * A `share` event: an offer from a home (§33.5, step 2), or the peer's answer to ours.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyShare(app, sender, ev) {
  const s = splitGid(ev.room);
  if (!s) throw refusal(400, "No room.");
  if (s.host === myHost()) {
    // Our offer, taken.
    const room = findRoom(app, s.id);
    const share = room ? shareOf(app, room.id, sender.id) : null;
    if (!room || !share) throw refusal(404, "That room isn't offered to you.");
    if (!ev.accepted || share.getString("state") !== "offered") return;
    share.set("state", "active");
    share.set("accepted", true);
    app.save(share);
    if (!refreshShared(app, room)) sendRoom(app, room, sender.id);
    tell(app, room, `This room is now shared with ${peerHost(sender)}.`);
    backfill(app, room, sender);
    return;
  }
  if (s.host !== peerHost(sender)) throw refusal(403, "Only a room's home offers it.");
  const g = /** @type {string} */ (ev.room);
  let share = offerOf(app, sender.id, g);
  if (share?.getString("state") === "active") return;
  if (!share) {
    share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("peer", sender.id);
    share.set("remote_id", g);
    share.set("state", "offered");
    share.set("accepted", false);
  }
  share.set("name", tidy(String(ev.name || "")).slice(0, 255));
  share.set("kind", ev.kind === "dm" ? "dm" : "public");
  share.set("visibility", ["public", "private", "open"].includes(ev.visibility) ? ev.visibility : "public");
  app.save(share);
}

/**
 * An `unshare` event: the peer ended a share, or declined or withdrew an offer.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyUnshare(app, sender, ev) {
  const s = splitGid(ev.room);
  if (!s) return;
  /** @type {core.Record | null} */
  let share = null;
  if (s.host === myHost()) {
    share = shareOf(app, s.id, sender.id);
  } else if (s.host === peerHost(sender)) {
    share = offerOf(app, sender.id, /** @type {string} */ (ev.room));
  }
  if (!share) return;
  if (share.getString("state") === "offered") {
    if (share.getString("remote_id"))
      app.delete(share); // withdrawn
    else {
      share.set("state", "ended"); // declined
      share.set("last_error", "Declined.");
      app.save(share);
    }
    return;
  }
  endShare(app, share, false);
}

/**
 * A mirror's name: the home's plus the label ("general (A)"), numbered when that is taken, within rooms.name's 48.
 * @param {core.App} app
 * @param {string} name
 * @param {string} label
 * @param {string} selfId
 */
function mirrorName(app, name, label, selfId) {
  for (let n = 1; n < 1000; n++) {
    const tail = `${n > 1 ? ` ${n}` : ""} (${label})`;
    const base =
      [...stripHashes(tidy(name))]
        .slice(0, ROOM_NAME_MAX - tail.length)
        .join("")
        .trim() || "room";
    const candidate = `${base}${tail}`;
    try {
      app.findFirstRecordByFilter("rooms", "name_key = {:k} && id != {:id}", { k: nameKey(candidate), id: selfId });
    } catch {
      return candidate;
    }
  }
  throw new Error("no free room name");
}

/**
 * A `room` event from a home: make the mirror (once its share is accepted, or a DM is opened) or bring it up to date.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyRoom(app, sender, ev) {
  const g = String(ev.room || "");
  if (splitGid(g)?.host !== peerHost(sender)) throw refusal(403, "Only a room's home sends it.");
  const dm = ev.kind === "dm";
  let share = offerOf(app, sender.id, g);
  if (!share) {
    if (!dm) return; // not offered, or ended here
    if (!sender.getBool("dms")) throw refusal(403, "Direct messages with your people are off here.");
    share = new Record(app.findCollectionByNameOrId("fed_shares"));
    share.set("peer", sender.id);
    share.set("remote_id", g);
    share.set("state", "offered");
    share.set("accepted", true);
    share.set("kind", "dm");
    share.set("visibility", "private");
  }
  if (!share.getBool("accepted")) return; // its admin hasn't taken it yet
  const people = ev.people && typeof ev.people === "object" ? ev.people : {};
  const map = (/** @type {unknown} */ list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, MAX_MEMBERS)
      .map((x) => userOf(app, sender, x, people))
      .filter(Boolean);
  // Its creator is one of the home's own people: one of ours would get a creator's rights over the copy.
  const creator = userOf(app, sender, ev.created_by, people, true);
  if (!creator) throw refusal(400, "The room's creator is unknown.");
  const members = map(ev.members);
  const writers = map(ev.writers);
  const hosts = (Array.isArray(ev.shared_with) ? ev.shared_with : []).map(String).filter((/** @type {string} */ h) => h && h !== myHost());
  const shared = { home: peerHost(sender), with: [...new Set([peerHost(sender), ...hosts])] };

  let room = findRoom(app, share.getString("room"));
  const name = tidy(String(ev.name || "")).slice(0, 255);
  if (!room) {
    room = new Record(app.findCollectionByNameOrId("rooms"));
    room.set("id", newId());
    room.set("kind", dm ? "dm" : "public");
    room.set("created_by", creator);
    room.set("peer", sender.id);
    room.set("remote_id", g);
    if (dm) {
      const pair = [...members].sort();
      // One of the home's people and one of ours: a home doesn't open DMs between two people here.
      const own = (/** @type {unknown} */ g) => splitGid(g)?.host === peerHost(sender);
      const gids = Array.isArray(ev.members) ? ev.members : [];
      const ours = (/** @type {unknown} */ g) => splitGid(g)?.host === myHost();
      if (pair.length !== 2 || gids.length !== 2 || !gids.some(own) || !gids.some(ours)) {
        throw refusal(400, "A DM is between one of your people and one of ours.");
      }
      room.set("dm_key", pair.join(":"));
      try {
        app.findFirstRecordByFilter("rooms", "dm_key = {:k}", { k: pair.join(":") });
        throw refusal(409, "These two already have a DM here.");
      } catch (err) {
        if (/** @type {any} */ (err)?.status === 409) throw err;
      }
    } else {
      room.set("name", mirrorName(app, name, sender.getString("label"), room.id));
    }
  } else if (!dm && name && name !== share.getString("name")) {
    room.set("name", mirrorName(app, name, sender.getString("label"), room.id));
  }
  share.set("name", name);
  if (!dm) {
    room.set("visibility", ["public", "private", "open"].includes(ev.visibility) ? ev.visibility : "public");
    room.set("posting", ev.posting === "selected" ? "selected" : "everyone");
    room.set("anonymous", ev.anonymous === true); // DESIGN.md §35; a home from before it sends none
    room.set("archived", !!ev.archived);
    room.set("writers", writers);
  }
  // A DM's two members are set once, when it is made: a home naming others later would let them read it (QA BUG-172).
  if (!dm || room.isNew()) room.set("members", members);
  const down = jsonOf(room, "shared", {}).down;
  room.set("shared", down ? { ...shared, down: true } : shared);
  app.save(room);
  const wasActive = share.getString("state") === "active";
  share.set("room", room.id);
  share.set("state", "active");
  share.set("last_error", ev.refused ? String(ev.refused).slice(0, 1000) : "");
  app.save(share);
  if (!wasActive && !dm) tell(app, room, `This room is shared from ${peerHost(sender)}.`);
}

// ---------------------------------------------------------------- a mirror's superuser and its members

/**
 * rooms update request on a mirror (§33.5): its state is the home's. Its superusers may rename it here, and in a
 * private room add or remove their own people, which goes to the home as a `members` request. Returns that request,
 * to send once saved (null when there is none).
 * @param {core.RecordRequestEvent} e
 * @returns {{ add: string[], remove: string[] } | null}
 */
function checkMirrorEdit(e) {
  const rec = e.record;
  if (!rec || !isMirror(rec)) return null;
  const orig = rec.original();
  const home = peerById(e.app, orig.getString("peer"));
  const where = home ? peerHost(home) : "its home";
  if (!e.hasSuperuserAuth()) throw new ForbiddenError(`This room is shared from ${where}; it is changed there.`);
  for (const f of [
    "kind",
    "visibility",
    "posting",
    "anonymous",
    "writers",
    "archived",
    "created_by",
    "dm_key",
    "peer",
    "remote_id",
    "shared",
  ]) {
    if (fieldValue(rec, f) !== fieldValue(orig, f)) throw fieldError(f, `This room is shared from ${where}; this is changed there.`);
  }
  const was = orig.getStringSlice("members");
  const now = rec.getStringSlice("members");
  if (was.join(",") === now.join(",")) return null;
  if (orig.getString("kind") !== "public" || orig.getString("visibility") !== "private") {
    throw fieldError("members", "Only a private room's members are listed.");
  }
  const add = now.filter((id) => !was.includes(id));
  const remove = was.filter((id) => !now.includes(id));
  for (const id of [...add, ...remove]) {
    if (standInRow(e.app, id) || id === orig.getString("created_by")) {
      throw fieldError("members", `People from other instances are added and removed on ${where}.`);
    }
  }
  return { add, remove };
}

/**
 * rooms update request on a mirror (saved): send its superuser's member change to the home.
 * @param {core.App} app
 * @param {core.Record} room
 * @param {{ add: string[], remove: string[] }} change
 */
function sendMembers(app, room, change) {
  const peer = peerById(app, room.getString("peer"));
  if (!peer) return;
  enqueue(app, peer.id, {
    type: "members",
    room: room.getString("remote_id"),
    add: change.add.map((id) => gid(id)),
    remove: change.remove.map((id) => gid(id)),
    people: peopleFor(app, peer, change.add),
  });
}

module.exports = { applyShare, applyUnshare, applyRoom, checkMirrorEdit, sendMembers };
