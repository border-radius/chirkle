/// <reference path="../../types/pocketbase.d.ts" />
// People from other instances (DESIGN.md §33.4): each gets a stand-in user ("Ann (B)") that their messages, reactions
// and memberships show under, as Telegram senders do (§26.3). fed_people says who a stand-in is (peer, global id); it
// also lists which of this instance's own people a peer has been told of ("known"), who it hears from again when their
// name, picture or DM setting changes.
//
// Events name people by global id and carry their profiles ({ name, no_dms, avatar, path }), so a receiver can make
// the stand-ins it needs. A peer vouches for its own people, and the home for the people of a third instance it shares
// a room with (§33.4): those are labelled with their host and take no DMs here.

const { fieldError } = require(`${__hooks}/lib/records.js`);
const { nameKey, tidy } = require(`${__hooks}/lib/text.js`);
const { enqueue, enqueueWork, gid, isActive, myHost, newId, peerByHost, peerHost, splitGid } = require(`${__hooks}/federation/config.js`);

/** users.name max. */
const NAME_MAX = 32;
/** The label of a third instance's people: their host, cut. */
const HOST_LABEL_MAX = 12;

/**
 * @typedef {{ name: string, no_dms: boolean, avatar: string, path: string }} Profile `avatar` names the picture (a new
 * one has a new name, "" for none); `path` is where the sender serves it.
 */

/**
 * "Ann (B)", or "Ann 2 (B)" when that is taken (names are unique, §22.1), within users.name's 32.
 * @param {string} name
 * @param {string} label
 * @param {number} n
 */
function displayName(name, label, n) {
  const tail = `${n > 1 ? ` ${n}` : ""} (${label})`;
  const base =
    [...tidy(name)]
      .slice(0, NAME_MAX - tail.length)
      .join("")
      .trim() || "Someone";
  return `${base}${tail}`;
}

/**
 * Save `user` with the first free display name for `name`.
 * @param {core.App} app
 * @param {core.Record} user
 * @param {string} name
 * @param {string} label
 */
function saveWithName(app, user, name, label) {
  for (let n = 1; n < 1000; n++) {
    const candidate = displayName(name, label, n);
    if (candidate === user.getString("name")) return app.save(user);
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
 * The fed_people row of a stand-in user, or null for anyone else.
 * @param {core.App} app
 * @param {string} userId
 */
function standInRow(app, userId) {
  if (!userId) return null;
  try {
    return app.findFirstRecordByFilter("fed_people", "user = {:u} && kind = 'standin'", { u: userId });
  } catch {
    return null;
  }
}

/**
 * The stand-in row for a person, looked up under the peer that speaks for them: their own instance when it is paired
 * here, else the instance that told of them (the home of a room they are in, §33.4).
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {string} g
 */
function rowOf(app, sender, g) {
  const host = splitGid(g)?.host ?? "";
  const own = host === peerHost(sender) ? sender : peerByHost(app, host);
  for (const p of own && own.id !== sender.id ? [own, sender] : [sender]) {
    try {
      return { row: app.findFirstRecordByFilter("fed_people", "peer = {:p} && remote = {:g}", { p: p.id, g }), peer: p };
    } catch {
      // not under this one
    }
  }
  return { row: null, peer: own && isActive(own) ? own : sender };
}

/**
 * The DM setting a stand-in has here: their own, unless DMs with them can't happen (§33.5): their instance didn't tick
 * `dms` here, isn't paired any more, or isn't the one vouching for them.
 * @param {core.Record} peer
 * @param {string} g
 * @param {boolean} theirs
 */
const noDmsHere = (peer, g, theirs) => theirs || !peer.getBool("dms") || !isActive(peer) || splitGid(g)?.host !== peerHost(peer);

/**
 * The label a stand-in's name ends in: their peer's, or for a vouched-for person their host, cut.
 * @param {core.Record} peer
 * @param {string} g
 */
function labelOf(peer, g) {
  const host = splitGid(g)?.host ?? "";
  return host === peerHost(peer) ? peer.getString("label") : host.slice(0, HOST_LABEL_MAX);
}

/**
 * Bring a stand-in up to date with what its own speaker says: its name, DM setting and picture (fetched later).
 * @param {core.App} app
 * @param {core.Record} row
 * @param {core.Record} peer
 * @param {Profile} p
 */
function applyProfile(app, row, peer, p) {
  const g = row.getString("remote");
  const user = app.findRecordById("users", row.getString("user"));
  const name = String(p.name || "").slice(0, 255);
  const noDms = !!p.no_dms;
  if (name && name !== row.getString("name")) {
    row.set("name", name);
    saveWithName(app, user, name, labelOf(peer, g));
  }
  const want = noDmsHere(peer, g, noDms);
  if (row.getBool("no_dms") !== noDms || user.getBool("no_dms") !== want) {
    row.set("no_dms", noDms);
    user.set("no_dms", want);
    app.save(user);
  }
  const avatar = String(p.avatar || "").slice(0, 255);
  if (avatar !== row.getString("avatar")) {
    row.set("avatar", avatar);
    if (!avatar) {
      user.set("avatar", null);
      app.save(user);
    } else if (typeof p.path === "string" && p.path.startsWith("/api/fed/avatars/")) {
      enqueueWork(app, peer.id, "avatar", { user: user.id, path: p.path, key: avatar });
    }
  }
  app.save(row);
}

/**
 * The local user a global id stands for, made when it is a new stand-in and its profile came with the event.
 * One of this instance's own ids is that user (who must exist and be no one's stand-in). "" when unknown.
 * @param {core.App} app
 * @param {core.Record} sender the peer the event came from
 * @param {unknown} g
 * @param {Record<string, Profile>} [people] the event's profiles
 * @param {boolean} [own] only the sender's own people (what a mirror may name, §33.6)
 */
function userOf(app, sender, g, people = {}, own = false) {
  const s = splitGid(g);
  if (!s) return "";
  const key = /** @type {string} */ (g);
  if (own && s.host !== peerHost(sender)) return "";
  if (s.host === myHost()) {
    try {
      const u = app.findRecordById("users", s.id);
      return standInRow(app, u.id) ? "" : u.id;
    } catch {
      return "";
    }
  }
  const { row, peer } = rowOf(app, sender, key);
  const profile = people && typeof people === "object" ? people[key] : undefined;
  if (row) {
    // Only who speaks for them changes them: a home relaying a third instance's person doesn't, once that instance does.
    if (profile && row.getString("peer") === sender.id) applyProfile(app, row, sender, profile);
    return row.getString("user");
  }
  if (!profile || typeof profile.name !== "string") return "";
  const user = new Record(app.findCollectionByNameOrId("users"));
  user.set("email", `fed${newId()}@federation.invalid`);
  user.setPassword($security.randomString(40));
  user.set("peer", peer.id);
  user.set("instance", s.host);
  user.set("kind", "peer");
  user.set("no_dms", true);
  saveWithName(app, user, profile.name, labelOf(peer, key));
  const made = new Record(app.findCollectionByNameOrId("fed_people"));
  made.set("peer", peer.id);
  made.set("remote", key);
  made.set("user", user.id);
  made.set("kind", "standin");
  made.set("name", "");
  try {
    app.save(made);
  } catch (err) {
    // Made meanwhile by another delivery (the unique index): use that one.
    app.delete(user);
    const again = rowOf(app, sender, key).row;
    if (!again) throw err;
    return again.getString("user");
  }
  applyProfile(app, made, peer, profile);
  return user.id;
}

/**
 * The global id of a local user: a stand-in's, or this instance's own.
 * @param {core.App} app
 * @param {string} userId
 */
function gidOf(app, userId) {
  const row = standInRow(app, userId);
  return row ? row.getString("remote") : gid(userId);
}

/**
 * What a peer is told of a person (§33.4): their own name (a stand-in's as their instance says it), DM setting and
 * picture, which the peer fetches from here.
 * @param {core.App} app
 * @param {string} userId
 * @returns {Profile | null}
 */
function profileOf(app, userId) {
  let user;
  try {
    user = app.findRecordById("users", userId);
  } catch {
    return null;
  }
  const row = standInRow(app, userId);
  const avatar = user.getString("avatar");
  return {
    name: row ? row.getString("name") || user.getString("name") : user.getString("name"),
    no_dms: row ? row.getBool("no_dms") : user.getBool("no_dms"),
    avatar: row ? (avatar ? row.getString("avatar") : "") : avatar,
    path: `/api/fed/avatars/${user.id}`,
  };
}

/**
 * The profiles of these users, by global id, for an event to `peer`. Its own people need none: it has them. This
 * instance's own people are noted as known to the peer, which then hears of their changes.
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {string[]} userIds
 */
function peopleFor(app, peer, userIds) {
  /** @type {Record<string, Profile>} */
  const out = {};
  for (const id of new Set(userIds.filter(Boolean))) {
    const g = gidOf(app, id);
    if (splitGid(g)?.host === peerHost(peer)) continue;
    const p = profileOf(app, id);
    if (!p) continue;
    out[g] = p;
    remember(app, peer, id, g);
  }
  return out;
}

/**
 * Note that `peer` has been told of local user `userId` (one of ours, or a stand-in it doesn't own).
 * @param {core.App} app
 * @param {core.Record} peer
 * @param {string} userId
 * @param {string} g
 */
function remember(app, peer, userId, g) {
  try {
    app.findFirstRecordByFilter("fed_people", "peer = {:p} && remote = {:g}", { p: peer.id, g });
    return;
  } catch {
    // not yet
  }
  const row = new Record(app.findCollectionByNameOrId("fed_people"));
  row.set("peer", peer.id);
  row.set("remote", g);
  row.set("user", userId);
  row.set("kind", "known");
  try {
    app.save(row);
  } catch {
    // noted meanwhile
  }
}

/** What peers are told of a user, to compare before and after a save. @param {core.Record} u */
const profileKey = (u) => ["name", "avatar", "no_dms"].map((f) => u.getString(f)).join("|");

/**
 * users update (saved): a person whose name, picture or DM setting changed is told of to the peers that know them
 * (a `user` event), but not to the one they are from.
 * @param {core.App} app
 * @param {core.Record} user
 * @param {string} before profileKey before
 */
function userChanged(app, user, before) {
  if (profileKey(user) === before) return;
  const g = gidOf(app, user.id);
  const p = profileOf(app, user.id);
  if (!p) return;
  for (const row of app.findRecordsByFilter("fed_people", "user = {:u} && kind = 'known'", "", 0, 0, { u: user.id })) {
    if (row) enqueue(app, row.getString("peer"), { type: "user", person: g, profile: p });
  }
}

/**
 * A `user` event: a peer's person changed. Only their own instance, or whoever vouches for them here, says so.
 * @param {core.App} app
 * @param {core.Record} sender
 * @param {any} ev
 */
function applyUser(app, sender, ev) {
  const g = String(ev.person || "");
  const { row } = rowOf(app, sender, g);
  if (!row || row.getString("peer") !== sender.id || row.getString("kind") !== "standin") return; // not one we have
  if (ev.profile && typeof ev.profile === "object") applyProfile(app, row, sender, ev.profile);
}

/**
 * After a peer's `dms` or status changed (§33.5, §33.7): its stand-ins take DMs, or not.
 * @param {core.App} app
 * @param {core.Record} peer
 */
function refreshDms(app, peer) {
  for (const row of app.findRecordsByFilter("fed_people", "peer = {:p} && kind = 'standin'", "", 0, 0, { p: peer.id })) {
    if (!row) continue;
    try {
      const user = app.findRecordById("users", row.getString("user"));
      const want = noDmsHere(peer, row.getString("remote"), row.getBool("no_dms"));
      if (user.getBool("no_dms") !== want) {
        user.set("no_dms", want);
        app.save(user);
      }
    } catch {
      // gone
    }
  }
}

/**
 * users create/update request: names ending in a peer's label, " (B)" however written, are its people's while it is
 * paired (§33.4). Superusers name anyone.
 * @param {core.RecordRequestEvent} e
 */
function refuseLabelName(e) {
  const rec = e.record;
  if (!rec || e.hasSuperuserAuth()) return;
  const name = rec.getString("name");
  if (!rec.isNew() && name === rec.original().getString("name")) return;
  const key = nameKey(tidy(name)).replace(/\s+/g, "");
  for (const p of e.app.findRecordsByFilter("fed_peers", "", "", 0, 0)) {
    if (!p) continue;
    const label = p.getString("label");
    if (label && key.endsWith(nameKey(`(${label})`).replace(/\s+/g, ""))) {
      throw fieldError("name", `Names ending in (${label}) are for people on ${peerHost(p)}. Choose another one.`);
    }
  }
}

module.exports = {
  userOf,
  gidOf,
  standInRow,
  profileOf,
  peopleFor,
  profileKey,
  userChanged,
  applyUser,
  refreshDms,
  refuseLabelName,
  displayName,
};
