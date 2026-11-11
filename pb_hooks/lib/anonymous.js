/// <reference path="../../types/pocketbase.d.ts" />
// Anonymous rooms (DESIGN.md §35): a room a superuser marks `anonymous` shows its messages as the room's, not their
// authors'. Each message is stamped when it is made (`anonymous`, `forwarded_anonymous`), so turning the flag on later
// hides nothing already seen, and turning it off shows nothing that was posted unseen. The real author stays stored:
// they still edit and delete their messages, and see them as their own. Everyone else gets, in every answer and live
// event, the room in place of the author, and can't find out who it is by filtering, sorting or expanding on it.

/**
 * What the messages of anonymous room `roomId` show as: its name, and whether it is private. Kept by the app until the
 * room is saved again (forget).
 * @param {core.App} app
 * @param {string} roomId
 * @returns {{ name: string, private: boolean }}
 */
function roomOf(app, roomId) {
  const key = `anonymous.${roomId}`;
  const kept = app.store().get(key);
  if (kept) return { name: String(kept.name), private: !!kept.private };
  // Not with getOrSet: it holds the store while it looks, and finding a record reads PocketBase's collections there.
  let room = { name: "Anonymous", private: true };
  try {
    const rec = app.findRecordById("rooms", roomId);
    room = { name: rec.getString("name") || "Anonymous", private: rec.getString("visibility") === "private" };
  } catch {
    return room; // being removed
  }
  app.store().set(key, room);
  return room;
}

/** @param {core.App} app @param {string} roomId */
const roomName = (app, roomId) => roomOf(app, roomId).name;

/**
 * A forward's "from": the room's name, but not a private room's to readers elsewhere, who may not know it.
 * @param {core.App} app
 * @param {string} roomId
 */
function sourceName(app, roomId) {
  const room = roomOf(app, roomId);
  return room.private ? "Anonymous" : room.name;
}

/**
 * rooms saved or deleted: its name is read again when next needed.
 * @param {core.App} app
 * @param {string} roomId
 */
function forget(app, roomId) {
  app.store().remove(`anonymous.${roomId}`);
}

/** Fields whose value says who wrote a message: no one but a superuser filters or sorts on them. */
const AUTHOR_FIELD = /(^|[^a-z0-9])(author|forwarded_from)(?![a-z0-9])/i;
/** A back-relation from users to the messages they wrote: expanded, it would group them by author. */
const AUTHOR_BACK_RELATION = /_via_(author|forwarded_from)(?![a-z0-9_])/i;

/**
 * An author compared with the caller (`author != {:me}`, `reply_to.author = {:me}`): says only which messages are
 * the caller's own. Apps from before 2026-10-29 filter so (docs/API.md); `ME` stands for the caller's id.
 */
const OWN_AUTHOR = String.raw`\b(author|forwarded_from)\s*(=|!=|\?=|\?!=)\s*(@request\.auth\.id\b|"ME"|'ME')`;

/**
 * Does a filter, sort or expand (as a client sends it) say who wrote a message? Quoted text is a value, not a field.
 * @param {{ filter?: unknown, sort?: unknown, expand?: unknown }} q
 * @param {string} me the caller's id ("" for guests)
 */
function probes(q, me) {
  const own = new RegExp(OWN_AUTHOR.replace(/ME/g, me.replace(/[^a-z0-9]/gi, "") || "@"), "gi");
  const fields = `${q.filter ?? ""} ${q.sort ?? ""}`.replace(own, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "''");
  return AUTHOR_FIELD.test(fields) || AUTHOR_BACK_RELATION.test(String(q.expand ?? ""));
}

const REFUSAL = "Messages can't be filtered, sorted or grouped by who wrote them.";

/**
 * A request refused when its query filters, sorts or groups by author (the records API's ?filter, ?sort, ?expand, on any
 * collection, as a relation or back-relation can reach messages from any of them; our routes' ?expand). Called by the
 * record request hooks (main.pb.js) and by each route that enriches records. Superusers may.
 * @param {core.RequestEvent} e
 */
function refuseProbes(e) {
  // requestInfo, not e.request: the record request hooks' events have no `request` in JS. Its values are decoded
  // (%61uthor is "author").
  const info = e.requestInfo();
  const q = { filter: info.query.filter ?? "", sort: info.query.sort ?? "", expand: info.query.expand ?? "" };
  if (!/author|forwarded_from/i.test(`${q.filter} ${q.sort} ${q.expand}`)) return;
  if (!probes(q, info.auth?.id ?? "")) return;
  if (info.auth?.isSuperuser()) return;
  throw new BadRequestError(REFUSAL);
}

/**
 * Realtime subscriptions: the same, for the filter, sort and expand in a subscription's options.
 * @param {core.RealtimeSubscribeRequestEvent} e
 */
function refuseSubscriptionProbes(e) {
  if (e.hasSuperuserAuth()) return;
  for (const topic of e.subscriptions ?? []) {
    const at = topic.indexOf("?options=");
    if (at < 0) continue;
    let query = {};
    try {
      query = JSON.parse(decodeURIComponent(topic.slice(at + "?options=".length)))?.query ?? {};
    } catch {
      query = {}; // PocketBase ignores options it can't read
    }
    if (probes(query, e.auth?.id ?? "")) throw new BadRequestError(REFUSAL);
  }
}

/**
 * The media grid's author of an item (lib/media.js list): the room for an anonymous message, as hide does.
 * @param {core.RequestEvent} e the caller's request (superusers see the author)
 * @param {{ author: string, name: string, anonymous: boolean, room: string }} row
 */
function gridAuthor(e, row) {
  if (!row.author) return null;
  if (row.anonymous && row.author !== (e.auth?.id ?? "") && !e.hasSuperuserAuth()) return { id: row.room, name: roomName(e.app, row.room) };
  return { id: row.author, name: row.name };
}

module.exports = { forget, roomName, sourceName, refuseProbes, refuseSubscriptionProbes, gridAuthor };
