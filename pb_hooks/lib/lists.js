/// <reference path="../../types/pocketbase.d.ts" />
// The room list and a room's message pages, as routes (docs/API.md): the clients say which page they want and the
// server writes the filter, so the schema can change under them. Both answer as the records API does (the same
// ?expand and ?fields, applied to each record; the enrich hooks), as a plain array, and see what the API rules let
// the caller see (lib/access.js). Apps from before these routes still list `rooms` and `messages` through the records
// API, which stays as it was.

const { SEES_SQL, visibleRoom } = require(`${__hooks}/lib/access.js`);
const { enrichInRooms } = require(`${__hooks}/lib/messages.js`);
const { searchKey } = require(`${__hooks}/lib/text.js`);

/** Messages in a page unless `limit` says otherwise (web/src/lib/cursor.ts PAGE_SIZE). */
const PAGE_SIZE = 50;
const MAX_LIMIT = 200;
/** Words of a search that count (web/src/views/room/search.ts MAX_WORDS). */
const MAX_WORDS = 5;
/** Rooms in one notification check, at most (ANDROID.md §21.2 asks for 40). */
const MAX_ROOMS = 50;

/**
 * A room's pages (DESIGN.md §7.5), keyset by (created, id), and the edits and deletes missed while offline (`changed`).
 * `latest` and `older` come newest first, the others oldest first.
 * @type {Record<string, { where: string, params: string[], sort: string }>}
 */
const KINDS = {
  latest: { where: "", params: [], sort: "-created,-id" },
  first: { where: "", params: [], sort: "created,id" },
  older: { where: "(created < {:created} || (created = {:created} && id < {:id}))", params: ["created", "id"], sort: "-created,-id" },
  newer: { where: "(created > {:created} || (created = {:created} && id > {:id}))", params: ["created", "id"], sort: "created,id" },
  changed: { where: "updated > {:since} && created >= {:from} && created <= {:to}", params: ["since", "from", "to"], sort: "updated,id" },
};

/**
 * GET /api/chat/rooms → the rooms: every room the caller can see, by name. Guests: the Open Air rooms (§23.3).
 * @param {core.RequestEvent} e
 */
function rooms(e) {
  // As the records API's (main.pb.js): this page's ?expand mustn't group messages by author (§35).
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  const me = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  const where = e.hasSuperuserAuth() ? "1" : me ? SEES_SQL : "r.visibility = 'open' AND NOT r.archived";
  const rows = arrayOf(new DynamicModel({ id: "" }));
  e.app.db().newQuery(`SELECT r.id FROM rooms r WHERE ${where} ORDER BY r.name, r.id`).bind({ me }).all(rows);
  const found = e.app.findRecordsByIds(
    "rooms",
    rows.map((r) => r.id),
  );
  const byId = new Map(found.map((r) => [r?.id, r]));
  const items = /** @type {core.Record[]} */ (rows.map((r) => byId.get(r.id)).filter(Boolean));
  $apis.enrichRecords(e, items);
  return e.json(200, items);
}

/**
 * GET /api/chat/rooms/{room}/messages?kind=latest|first|older|newer|changed → the messages. `older` and `newer` take the
 * cursor (`created`, `id`); `changed` takes `since` (an `updated` value) and `from`, `to` (`created` values). `files=1`:
 * only messages that may have attachments (theirs, or a forward's original's, §17.7). `q`: only messages with every
 * word of it (search, §29; with `latest` and `older`). `limit` (at most 200) and `page` (from 1) as the records API has
 * them. A room the caller can't see has no messages, as the records API says. Answered with an ETag: asked again with it
 * (If-None-Match), an unchanged page is a 304 without a body (PERF.md §5).
 * @param {core.RequestEvent} e
 */
function messages(e) {
  // As the records API's (main.pb.js): this page's ?expand mustn't group messages by author (§35).
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  const roomId = e.request?.pathValue("room") ?? "";
  const q = e.requestInfo().query;
  // Own keys only: "toString" and the like are the object's too (QA BUG-171).
  const name = q.kind || "latest";
  const kind = Object.keys(KINDS).includes(name) ? KINDS[name] : null;
  if (!kind) throw new BadRequestError("Unknown page kind.");
  const me = e.auth && !e.auth.isSuperuser() ? e.auth.id : "";
  if (!e.hasSuperuserAuth() && !visibleRoom(e.app, roomId, me)) return e.json(200, []);
  /** @type {Record<string, string>} */
  const params = { room: roomId };
  for (const p of kind.params) {
    // An empty id is a cursor too: `newer` than (created, "") starts at `created` itself (around a message, §7.5).
    if (typeof q[p] !== "string" || (p !== "id" && !q[p])) throw new BadRequestError(`Missing ${p}.`);
    params[p] = q[p];
  }
  const where = [
    "room = {:room}",
    ...searchWhere(q.q ?? "", params),
    kind.where,
    // `files` is JSON (§37): `:length` means nothing on it, and every message has at least [].
    q.files === "1" ? `(files != "[]" || forward_of != "")` : "",
  ];
  return tagged(e, list(e, where, kind.sort, q, params, [roomId]));
}

/**
 * Answer with `body` and an ETag of it, or 304 when the client has that one already. The tag is a hash of the records as
 * they serialize with their expands and what the enrich hooks added, so anything a page shows changes it. `no-store`:
 * nothing keeps a page but the app itself (cache.ts, which a logout clears), and it sends the tag it kept.
 * @param {core.RequestEvent} e
 * @param {(core.Record | undefined)[]} body
 */
function tagged(e, body) {
  const tag = `"${$security.sha256(JSON.stringify([e.requestInfo().query.fields ?? "", e.requestInfo().query.expand ?? "", body])).slice(0, 32)}"`;
  const h = e.response.header();
  h.set("ETag", tag);
  h.set("Cache-Control", "no-store");
  const asked = e.request?.header.get("If-None-Match") ?? "";
  if (asked.split(",").some((t) => t.trim() === tag)) return e.noContent(304);
  return e.json(200, body);
}

/**
 * The conditions for a search's words (§29), matched on `text_key`, folded as the server stores it: each word once, the
 * first MAX_WORDS. `~` treats a % in the value as a wildcard (and then stops adding its own), so it is escaped (QA
 * BUG-34); `_` already is. So is the escape character itself (QA BUG-112).
 * @param {string} text
 * @param {Record<string, string>} params the words' values go in here
 */
function searchWhere(text, params) {
  const words = [...new Set(searchKey(text).split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);
  return words.map((w, i) => {
    params[`w${i}`] = w.replace(/[\\%]/g, "\\$&");
    return `text_key ~ {:w${i}}`;
  });
}

/**
 * GET /api/chat/notifiable?rooms=a,b&since=…[&every=a] → other people's messages in `rooms` since `since` that are
 * DMs, replies to you or mentions of you (DESIGN.md §41), or any message in an `every` room (ANDROID.md §21.2, §24): newest first, `limit` of them. The
 * rooms you can't see are left out.
 * @param {core.RequestEvent} e
 */
function notifiable(e) {
  // As the records API's (main.pb.js): this page's ?expand mustn't group messages by author (§35).
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  const q = e.requestInfo().query;
  if (!q.since) throw new BadRequestError("Missing since.");
  const me = e.auth?.id ?? "";
  const ids = (/** @type {string} */ s) => (s ?? "").split(",").filter(Boolean);
  const rooms = ids(q.rooms)
    .slice(0, MAX_ROOMS)
    .filter((r) => visibleRoom(e.app, r, me));
  if (!rooms.length) return e.json(200, []);
  const every = new Set(ids(q.every));
  /** @type {Record<string, string>} */
  const params = { me, since: q.since };
  rooms.forEach((r, i) => {
    params[`r${i}`] = r;
  });
  const inRooms = rooms.map((_, i) => `room = {:r${i}}`).join(" || ");
  const all = rooms.map((r, i) => (every.has(r) ? ` || room = {:r${i}}` : "")).join("");
  const where = [
    `(${inRooms})`,
    "created > {:since}",
    "author != {:me}",
    "deleted = false",
    `(room.kind = "dm" || reply_to.author = {:me} || mentions.id ?= {:me}${all})`,
  ];
  return e.json(200, list(e, where, "-created,-id", q, params, rooms));
}

/**
 * The messages matching every condition in `where`, a page of them as `q`'s `limit` and `page` say, enriched. They
 * are all in `rooms`, which the caller can see.
 * @param {core.RequestEvent} e
 * @param {string[]} where
 * @param {string} sort
 * @param {Record<string, any>} q
 * @param {Record<string, string>} params
 * @param {string[]} rooms
 */
function list(e, where, sort, q, params, rooms) {
  const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || PAGE_SIZE, 1), MAX_LIMIT);
  const page = Math.max(Number.parseInt(q.page, 10) || 1, 1);
  const items = e.app.findRecordsByFilter("messages", where.filter(Boolean).join(" && "), sort, limit, (page - 1) * limit, params);
  enrichInRooms(e, rooms, () => {
    $apis.enrichRecords(e, items);
    return items;
  });
  return items;
}

module.exports = { rooms, messages, notifiable };
