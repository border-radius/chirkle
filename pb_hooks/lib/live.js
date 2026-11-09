/// <reference path="../../types/pocketbase.d.ts" />
// Live messages (docs/PERF.md §7): each message saved or deleted is sent once, by one hook call, to every realtime
// client subscribed to TOPIC that can see its room, as the clients' rooms and activity need it. Not by PocketBase's
// own `messages/*` subscriptions: for those it checks the list rule and runs the messages enrich hook (JS, lib/enrich.js)
// once for each subscriber, and with a hundred people listening every message and reaction cost seconds (PERF.md
// §6.1). Here the message is expanded once, a forward shows its original once (lib/messages.js showOriginal), and an
// anonymous room's message is hidden once (lib/anonymous.js hide), with its author's own view beside it.
//
// The event is what a `messages/*` subscription with the apps' live options sent: { action, record }, the record with the
// contract's message fields, expanded with `author` and `forwarded_from`. Who gets it is who that subscription's list rule lets see the message: anyone who can
// see its room (lib/access.js canSee; tests/integration/access.matrix.test.ts checks they agree). The view rule's
// other way in, a forward of it in a room you see, isn't one here: such a reader is told of the forward instead
// (lib/messages.js touches forwards when their original changes), as the apps' list subscriptions always were.
//
// Apps ask GET /api/chat/live first; a server from before has no such route (404), and they subscribe as before.

const { accessOf, canSee } = require(`${__hooks}/lib/access.js`);

const TOPIC = "chat/messages";
const EXPAND = ["author", "forwarded_from"];
/** What an event carries: the fields the apps ask the records API for (shared/contract.json, tests/unit/contract.test.ts). */
const FIELDS =
  "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,file_dims,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms,expand.author.instance,reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files,expand.reply_to.expand.author.id,expand.reply_to.expand.author.name,forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name,mentions";

/**
 * `value` (a record as JSON) with only `fields` (PocketBase's `fields` syntax, dotted paths), as the API's `fields` gives it.
 * @param {any} value
 * @param {string} fields
 */
function pick(value, fields) {
  /** @type {Record<string, any>} */
  const tree = {};
  for (const path of fields.split(",")) {
    let node = tree;
    for (const key of path.split(".")) node = node[key] ??= {};
  }
  /** @param {any} v @param {Record<string, any>} t @returns {any} */
  const walk = (v, t) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, t));
    if (!v || typeof v !== "object" || !Object.keys(t).length) return v;
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(t)) if (k in v) out[k] = walk(v[k], t[k]);
    return out;
  };
  return walk(value, tree);
}

/**
 * Send `record` (a message just saved, or deleted) to the clients listening that can see its room.
 * @param {core.App} app
 * @param {core.Record} record
 * @param {"create" | "update" | "delete"} action
 */
function send(app, record, action) {
  const clients = app.subscriptionsBroker().clients();
  /** @type {any[]} */
  const listening = [];
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    if (client && !client.isDiscarded() && client.hasSubscription(TOPIC)) listening.push(client);
  }
  if (!listening.length) return;
  let room;
  try {
    room = app.findRecordById("rooms", record.getString("room"));
  } catch {
    return; // the room is gone, and with it everyone's right to see the message
  }
  const access = accessOf(room);
  const base = record.fresh();
  app.expandRecord(base, EXPAND, /** @type {any} */ (null));
  if (action !== "delete") require(`${__hooks}/lib/messages.js`).showOriginal(/** @type {any} */ ({ app, record: base }));
  const anonymous = base.getBool("anonymous");
  const forwardedAnonymous = base.getBool("forwarded_anonymous");
  const author = base.getString("author");
  const from = base.getString("forwarded_from");

  /** @type {Record<string, string>} */
  const payloads = {};
  /**
   * The event as `userId` sees it: the real author only to the author (and the forward's source only to its writer),
   * as the enrich hook's hide would show it to them.
   * @param {string} key
   * @param {string} userId
   */
  const payload = (key, userId) => {
    if (payloads[key] === undefined) {
      let rec = base;
      if (key !== "real") {
        rec = base.fresh();
        rec.setExpand(base.expand());
        const auth = { id: userId, isSuperuser: () => false };
        require(`${__hooks}/lib/anonymous.js`).hide(/** @type {any} */ ({ app, record: rec, requestInfo: { auth } }));
      }
      payloads[key] = JSON.stringify({ action, record: pick(JSON.parse(JSON.stringify(rec)), FIELDS) });
    }
    return payloads[key];
  };

  for (const client of listening) {
    /** @type {core.Record | null | undefined} */
    const auth = client.get("auth");
    const superuser = !!auth?.isSuperuser();
    const userId = auth && !superuser ? auth.id : "";
    if (!superuser && !canSee(access, userId)) continue;
    const hidesAuthor = anonymous && author !== "" && author !== userId;
    const hidesFrom = forwardedAnonymous && from !== "" && from !== userId;
    const key = superuser || (!hidesAuthor && !hidesFrom) ? "real" : `${hidesAuthor ? "a" : ""}${hidesFrom ? "f" : ""}`;
    client.send(new SubscriptionMessage({ name: TOPIC, data: payload(key, userId) }));
  }
}

/**
 * send, with a failure logged instead of thrown: the save is committed already.
 * @param {core.App} app
 * @param {core.Record | undefined} record
 * @param {"create" | "update" | "delete"} action
 */
function sendSafely(app, record, action) {
  if (!record) return;
  try {
    send(app, record, action);
  } catch (err) {
    app.logger().error("live: a message event wasn't sent", "message", record.id, "action", action, "error", String(err));
  }
}

/**
 * GET /api/chat/live: that this server sends messages on TOPIC (apps from before subscribe to `messages/*`).
 * @param {core.RequestEvent} e
 */
function info(e) {
  return e.json(200, { topic: TOPIC });
}

module.exports = { TOPIC, send, sendSafely, info };
