/// <reference path="../../types/pocketbase.d.ts" />
// The "Mentions & replies" inbox (DESIGN.md §41): a row (`inbox`) for each thing to tell someone of: a message that
// mentions them, a reply to one of their messages, someone's reactions to one (one row however many emoji they add:
// its `emoji` is "", the list shows the ones they have on the message now). The messages hooks keep the rows as messages are
// made, edited, deleted and reacted to, whichever way (the apps, a linked instance, the Telegram bridge); they go with a
// deleted message, and a room you can't see any more keeps its rows out of the list. Each new or removed row is told
// live to its person's apps (TOPIC). GET /api/chat/inbox lists them, newest first; POST /api/chat/inbox/seen notes how
// far they have been looked at, and GET /api/chat/unread counts the rest (`inbox`) and the unread mentions and replies
// of each room (`mentions`).

const { SEES_SQL } = require(`${__hooks}/lib/access.js`);
const { reactionsOf } = require(`${__hooks}/lib/reactions.js`);

const TOPIC = "chat/inbox";
/** Most rows one page lists. */
const PAGE = 30;
/** The "unseen" count stops here (shown as "99+"). */
const CAP = 100;
/** How much of a message's text a row shows. */
const SNIPPET = 200;
/** Most of one person's emoji a reaction row names in `emoji` ("👍🎉❤️😂🔥 +3"); `emojis` has them all. */
const EMOJI_SHOWN = 5;

/**
 * Does `user` have an inbox? Not a stand-in (a Telegram sender's, §26.3, or another instance's person's, §33.4): they
 * never sign in here.
 * @param {core.App} app
 * @param {string} userId
 */
function hasInbox(app, userId) {
  if (!userId) return false;
  try {
    const u = app.findRecordById("users", userId);
    return !/@(telegram|federation)\.invalid$/.test(u.getString("email"));
  } catch {
    return false;
  }
}

/**
 * Add a row, unless it is the actor's own or there already.
 * @param {core.App} app
 * @param {{ user: string, kind: string, message: core.Record, actor: string, emoji?: string }} row
 */
function add(app, { user, kind, message, actor, emoji = "" }) {
  if (!user || !actor || user === actor || !hasInbox(app, user)) return;
  try {
    app.findFirstRecordByFilter("inbox", "user = {:u} && message = {:m} && kind = {:k} && actor = {:a} && emoji = {:e}", {
      u: user,
      m: message.id,
      k: kind,
      a: actor,
      e: emoji,
    });
    return; // there already
  } catch {
    // not yet
  }
  const rec = new Record(app.findCollectionByNameOrId("inbox"));
  rec.set("user", user);
  rec.set("kind", kind);
  rec.set("message", message.id);
  rec.set("room", message.getString("room"));
  rec.set("actor", actor);
  rec.set("emoji", emoji);
  try {
    app.save(rec);
  } catch {
    // already there (the unique index)
  }
}

/**
 * Remove the rows of `messageId` that match `where` (a filter on inbox, with its own params).
 * @param {core.App} app
 * @param {string} messageId
 * @param {string} [where]
 * @param {Record<string, string>} [params]
 */
function remove(app, messageId, where = "", params = {}) {
  const filter = `message = {:m}${where ? ` && (${where})` : ""}`;
  for (const row of app.findRecordsByFilter("inbox", filter, "", 0, 0, { ...params, m: messageId })) if (row) app.delete(row);
}

/**
 * The author of the message `rec` replies to, "" when none (or a service message's).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function repliedTo(app, rec) {
  const id = rec.getString("reply_to");
  if (!id) return "";
  try {
    return app.findRecordById("messages", id).getString("author");
  } catch {
    return "";
  }
}

/**
 * messages create (saved, in its transaction): a reply tells the author of what it answers; a mention, whoever it
 * names (but not that author again: the reply says it).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function messageCreated(app, rec) {
  const author = rec.getString("author");
  if (!author || rec.getBool("deleted")) return;
  const parent = repliedTo(app, rec);
  if (parent) add(app, { user: parent, kind: "reply", message: rec, actor: author });
  for (const user of rec.getStringSlice("mentions")) {
    if (user !== parent) add(app, { user, kind: "mention", message: rec, actor: author });
  }
}

/**
 * What messageChanged compares with: the message's mentions and reactions before the save.
 * @param {core.Record} rec the record about to be saved
 */
const before = (rec) => {
  const orig = rec.original();
  return { mentions: orig.getStringSlice("mentions"), reactions: reactionsOf(orig), deleted: orig.getBool("deleted") };
};

/**
 * messages update (saved, in its transaction): a deleted message takes its rows; changed mentions add and remove
 * theirs; someone's first reaction to a message tells its author (one row for all their reactions to it), and the
 * last of them taken back, no longer does.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {ReturnType<typeof before>} was
 */
function messageChanged(app, rec, was) {
  if (rec.getBool("deleted")) {
    if (!was.deleted) remove(app, rec.id);
    return;
  }
  const author = rec.getString("author");
  if (!author) return;
  const now = rec.getStringSlice("mentions");
  if (now.join(",") !== was.mentions.join(",")) {
    const parent = repliedTo(app, rec);
    for (const user of was.mentions) {
      if (!now.includes(user)) remove(app, rec.id, "kind = 'mention' && user = {:u}", { u: user });
    }
    for (const user of now) {
      if (!was.mentions.includes(user) && user !== parent) add(app, { user, kind: "mention", message: rec, actor: author });
    }
  }
  /** @param {{ emoji: string, users: string[] }[]} list */
  const people = (list) => new Set(list.flatMap((r) => r.users));
  const nowBy = people(reactionsOf(rec));
  const wasBy = people(was.reactions);
  for (const u of nowBy) if (!wasBy.has(u)) add(app, { user: author, kind: "reaction", message: rec, actor: u });
  for (const u of wasBy) if (!nowBy.has(u)) remove(app, rec.id, "kind = 'reaction' && actor = {:a}", { a: u });
}

/**
 * An inbox row added or removed (committed): its person's apps hear of it on TOPIC, as { action, id, kind, room,
 * message, created }. A failure is logged: the apps count again when they reconnect.
 * @param {core.App} app
 * @param {core.Record | undefined} row
 * @param {"create" | "delete"} action
 */
function tell(app, row, action) {
  if (!row) return;
  try {
    const user = row.getString("user");
    const clients = app.subscriptionsBroker().clients();
    let data = "";
    for (const id of Object.keys(clients)) {
      const client = clients[id];
      if (!client || client.isDiscarded() || !client.hasSubscription(TOPIC)) continue;
      /** @type {core.Record | null | undefined} */
      const auth = client.get("auth");
      if (!auth || auth.isSuperuser() || auth.id !== user) continue;
      if (!data) {
        let created = "";
        try {
          created = app.findRecordById("messages", row.getString("message")).getString("created");
        } catch {
          created = ""; // deleted for good with it
        }
        data = JSON.stringify({
          action,
          id: row.id,
          kind: row.getString("kind"),
          room: row.getString("room"),
          message: row.getString("message"),
          created,
        });
      }
      client.send(new SubscriptionMessage({ name: TOPIC, data }));
    }
  } catch (err) {
    app.logger().error("inbox: a row wasn't told", "row", row.id, "error", String(err));
  }
}

/**
 * When `user` last looked at their inbox ("" for never).
 * @param {core.App} app
 * @param {string} user
 */
function seenAt(app, user) {
  try {
    return app.findFirstRecordByFilter("inbox_reads", "user = {:u}", { u: user }).getString("seen_at");
  } catch {
    return "";
  }
}

/** The rows a person is shown: their room still visible to them, the message not deleted. */
const VISIBLE_SQL = `FROM inbox i JOIN messages m ON m.id = i.message JOIN rooms r ON r.id = i.room
WHERE i.user = {:me} AND m.deleted = FALSE AND ${SEES_SQL}`;

/**
 * A mention or reply whose message you have read in its room: seen there, so not new in the inbox either (2026-11-10,
 * user: no reading it twice). A reaction is only seen in the inbox: it comes after the message it is on.
 */
const READ_IN_ROOM_SQL = `(i.kind != 'reaction' AND m.created <= COALESCE((SELECT rr.last_read_at FROM room_reads rr
  WHERE rr.user = {:me} AND rr.room = i.room), ''))`;

/**
 * For GET /api/chat/unread: how many rows `user` hasn't seen (at most CAP): newer than when they last looked at the
 * inbox, and (a mention or reply) not read in its room already, and per room the mentions of them and
 * replies to them that are still unread there (newer than their read position, or signup).
 * @param {core.App} app
 * @param {core.Record} user
 */
function counts(app, user) {
  const unseen = new DynamicModel({ n: 0 });
  app
    .db()
    .newQuery(`SELECT COUNT(*) AS n FROM (SELECT 1 ${VISIBLE_SQL} AND i.created > {:seen} AND NOT ${READ_IN_ROOM_SQL} LIMIT ${CAP})`)
    .bind({ me: user.id, seen: seenAt(app, user.id) })
    .one(unseen);
  const rows = arrayOf(new DynamicModel({ room: "", n: 0 }));
  app
    .db()
    .newQuery(
      `SELECT i.room AS room, COUNT(DISTINCT i.message) AS n ${VISIBLE_SQL} AND i.kind != 'reaction'
       AND m.created > MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = i.room), ''), {:since})
       GROUP BY i.room`,
    )
    .bind({ me: user.id, since: user.getString("created") })
    .all(rows);
  /** @type {Record<string, number>} */
  const mentions = {};
  for (const row of rows) mentions[row.room] = row.n;
  return { inbox: unseen.n, mentions };
}

/** @param {string} s */
const snippet = (s) => {
  const line = s.replace(/\s+/g, " ").trim();
  return [...line].length > SNIPPET ? `${[...line].slice(0, SNIPPET).join("")}…` : line;
};

/**
 * What a message shows in a row: its text (a forward's, its original's) cut short, and how many files it has.
 * @param {core.App} app
 * @param {core.Record} msg
 */
function shown(app, msg) {
  let src = msg;
  if (msg.getString("forward_of")) {
    try {
      src = app.findRecordById("messages", msg.getString("forward_of"));
      if (src.getBool("deleted")) return { text: "", files: 0 };
    } catch {
      return { text: "", files: 0 };
    }
  }
  return { text: snippet(src.getString("text")), files: src.getStringSlice("files").length };
}

/**
 * GET /api/chat/inbox?before=&limit= → { items, more, seen_at }: the caller's rows, newest first, PAGE at a time
 * (`before`: the last item's `cursor`). Each item: { id, cursor, kind, emoji (a reaction row's: the actor's emoji on
 * the message now, at most EMOJI_SHOWN then " +n"; "" otherwise), emojis (all of them, in the message's order), created, read (a mention or reply read in
 * its room: not new, whatever seen_at says), room, message: { id, text, files,
 * created }, quote (a reply's: the caller's message it answers, { id, text, files }), actor: { id, name, avatar,
 * instance } }. In an anonymous room (§35) a mention or reply shows the room, not who wrote it.
 * @param {core.RequestEvent} e
 */
function list(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const q = e.requestInfo().query;
  const limit = Math.max(1, Math.min(PAGE, Number.parseInt(String(q.limit ?? PAGE), 10) || PAGE));
  const before = typeof q.before === "string" ? q.before : "";
  const [bCreated, bId] = before.includes("|") ? before.split("|") : ["", ""];
  const rows = arrayOf(new DynamicModel({ id: "", kind: "", emoji: "", created: "", room: "", message: "", actor: "", read: false }));
  e.app
    .db()
    .newQuery(
      `SELECT i.id AS id, i.kind AS kind, i.emoji AS emoji, i.created AS created, i.room AS room, i.message AS message, i.actor AS actor,
         ${READ_IN_ROOM_SQL} AS read
       ${VISIBLE_SQL} ${bCreated ? "AND (i.created < {:bc} OR (i.created = {:bc} AND i.id < {:bi}))" : ""}
       ORDER BY i.created DESC, i.id DESC LIMIT ${limit + 1}`,
    )
    .bind({ me: me.id, bc: bCreated, bi: bId })
    .all(rows);
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const messages = new Map(e.app.findRecordsByIds("messages", [...new Set(page.map((r) => r.message))]).map((m) => [m?.id, m]));
  const actors = new Map(e.app.findRecordsByIds("users", [...new Set(page.map((r) => r.actor))]).map((u) => [u?.id, u]));
  const { roomName } = require(`${__hooks}/lib/anonymous.js`);
  const items = page.flatMap((row) => {
    const msg = messages.get(row.message);
    if (!msg) return [];
    const emojis =
      row.kind === "reaction"
        ? reactionsOf(msg)
            .filter((/** @type {{ emoji: string, users: string[] }} */ r) => r.users.includes(row.actor))
            .map((/** @type {{ emoji: string }} */ r) => r.emoji)
        : [];
    if (row.kind === "reaction" && !emojis.length) return []; // taken back meanwhile: its row goes in the same save
    const extra = emojis.length - EMOJI_SHOWN;
    const emoji = row.kind === "reaction" ? `${emojis.slice(0, EMOJI_SHOWN).join("")}${extra > 0 ? ` +${extra}` : ""}` : row.emoji;
    const u = actors.get(row.actor);
    const hidden = row.kind !== "reaction" && msg.getBool("anonymous") && !e.hasSuperuserAuth();
    const actor = hidden
      ? { id: row.room, name: roomName(e.app, row.room), avatar: "", instance: "" }
      : { id: row.actor, name: u?.getString("name") ?? "", avatar: u?.getString("avatar") ?? "", instance: u?.getString("instance") ?? "" };
    /** @type {{ id: string, text: string, files: number } | null} */
    let quote = null;
    if (row.kind === "reply" && msg.getString("reply_to")) {
      try {
        const original = e.app.findRecordById("messages", msg.getString("reply_to"));
        quote = original.getBool("deleted") ? { id: original.id, text: "", files: 0 } : { id: original.id, ...shown(e.app, original) };
      } catch {
        quote = null;
      }
    }
    return [
      {
        id: row.id,
        cursor: `${row.created}|${row.id}`,
        kind: row.kind,
        emoji,
        emojis,
        created: row.created,
        read: !!row.read,
        room: row.room,
        message: { id: msg.id, created: msg.getString("created"), ...shown(e.app, msg) },
        quote,
        actor,
      },
    ];
  });
  return e.json(200, { items, more, seen_at: seenAt(e.app, me.id) });
}

/**
 * POST /api/chat/inbox/seen { at? }: the caller has looked at their inbox up to `at` (a row's `created`; default now).
 * Never moves back, nor past now.
 * @param {core.RequestEvent} e
 */
function markSeen(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const now = new DateTime();
  let at = now;
  if (body.at !== undefined) {
    try {
      at = typeof body.at === "string" && body.at ? new DateTime(body.at) : now;
    } catch {
      throw new BadRequestError("Failed to mark the inbox as seen.", {
        at: new ValidationError("validation_invalid_value", "Must be a date."),
      });
    }
    if (at.isZero() || at.after(now)) at = now;
  }
  let row = null;
  try {
    row = e.app.findFirstRecordByFilter("inbox_reads", "user = {:u}", { u: me.id });
  } catch {
    row = null;
  }
  if (!row) {
    row = new Record(e.app.findCollectionByNameOrId("inbox_reads"));
    row.set("user", me.id);
    row.set("seen_at", at);
    try {
      e.app.save(row);
    } catch {
      // another tab made it meanwhile
      row = e.app.findFirstRecordByFilter("inbox_reads", "user = {:u}", { u: me.id });
    }
  }
  if (at.after(row.getDateTime("seen_at"))) {
    row.set("seen_at", at);
    e.app.save(row);
  }
  return e.json(200, { seen_at: row.getString("seen_at") });
}

module.exports = { TOPIC, before, messageCreated, messageChanged, tell, counts, list, markSeen };
