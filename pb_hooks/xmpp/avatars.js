/// <reference path="../../types/pocketbase.d.ts" />
// Stand-ins' avatars (DESIGN.md §38.5): the vCard photo (XEP-0153) of someone in a conference, whose presence carries
// its hash. A new hash, or a new stand-in, queues a fetch ("avatar" in xmpp_queue), at most once a day each; the
// worker has the child fetch the vCard through the conference and reads the photo from it by a one-time URL.

const DAY_MS = 24 * 60 * 60 * 1000;
/** users.avatar's types (§15.1), and the extension each is stored under. */
const TYPES = /** @type {Record<string, string>} */ ({
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
});

/**
 * Is an avatar fetch for this person already waiting?
 * @param {core.App} app
 * @param {string} person
 */
function waiting(app, person) {
  try {
    app.findFirstRecordByFilter("xmpp_queue", "op = 'avatar' && person = {:p} && locked_until = ''", { p: person });
    return true;
  } catch {
    return false;
  }
}

/**
 * Queue a fetch of someone's avatar, unless it is the one they have, or theirs was fetched within a day.
 * @param {core.App} app
 * @param {core.Record} person xmpp_people
 * @param {string} muc where to ask
 * @param {string} nick as whom
 * @param {string} hash the photo's hash, "" when not told
 */
function queueFetch(app, person, muc, nick, hash) {
  if (hash && hash === person.getString("avatar_hash")) return;
  const at = person.getDateTime("avatar_at");
  if (!at.isZero() && Date.now() - at.time().unixMilli() < DAY_MS) return;
  if (!nick || waiting(app, person.id)) return;
  const row = new Record(app.findCollectionByNameOrId("xmpp_queue"));
  row.set("op", "avatar");
  row.set("muc", muc);
  row.set("person", person.id);
  row.set("nick", nick);
  row.set("hash", hash);
  app.save(row);
}

/**
 * A `photo` event: someone's presence told their photo's hash (new, or the first this run). Only for people who
 * have a stand-in: one is made on their first message, which fetches it then (people.js).
 * @param {core.App} app
 * @param {any} ev
 */
function photo(app, ev) {
  const links = require(`${__hooks}/xmpp/links.js`);
  const link = links.linkOfMuc(app, ev.muc);
  if (!link || !links.activeLink(app, link)) return;
  const muc = link.getString("muc");
  const { keyOf } = require(`${__hooks}/xmpp/people.js`);
  const key = keyOf({ muc, nick: String(ev.nick || ""), occupant_id: ev.occupant_id, jid: ev.jid });
  let person;
  try {
    person = app.findFirstRecordByFilter("xmpp_people", "key = {:key}", { key });
  } catch {
    return;
  }
  const hash = String(ev.hash || "");
  if (!hash) {
    // Took their photo away: so does the stand-in.
    if (!person.getString("avatar_hash")) return;
    const user = app.findRecordById("users", person.getString("user"));
    user.set("avatar", null);
    app.save(user);
    person.set("avatar_hash", "");
    app.save(person);
    return;
  }
  queueFetch(app, person, muc, String(ev.nick || ""), hash);
}

/**
 * The worker's "avatar" op: fetch the photo and set it as the stand-in's avatar; none takes it away. Noted as
 * fetched either way, so it is asked again in a day at the soonest.
 * @param {core.App} app
 * @param {core.Record} row xmpp_queue
 */
function fetch(app, row) {
  const { call, current } = require(`${__hooks}/xmpp/child.js`);
  let person;
  try {
    person = app.findRecordById("xmpp_people", row.getString("person"));
  } catch {
    return; // the stand-in is gone
  }
  const user = app.findRecordById("users", person.getString("user"));
  let res;
  try {
    res = call(app, "/avatar", { muc: row.getString("muc"), nick: row.getString("nick") });
  } catch (err) {
    if (/** @type {any} */ (err).transient !== false) throw err;
    res = {}; // no vCard, or not one we can take: as none, until tomorrow
  }
  const type = String(res?.type || "").toLowerCase();
  if (res?.token && TYPES[type]) {
    const child = current(app);
    if (!child?.port) throw new Error("the child went away");
    const file = $filesystem.fileFromURL(`http://127.0.0.1:${child.port}/photo/${res.token}`, 30);
    file.originalName = `avatar.${TYPES[type]}`;
    file.name = require(`${__hooks}/lib/bridges.js`).storedName(file.originalName, "");
    user.set("avatar", file);
    app.save(user);
  } else if (!res?.token && user.getString("avatar")) {
    user.set("avatar", null);
    app.save(user);
  }
  person.set("avatar_hash", row.getString("hash"));
  person.set("avatar_at", new DateTime());
  app.save(person);
}

module.exports = { queueFetch, photo, fetch };
