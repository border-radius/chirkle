/// <reference path="../../types/pocketbase.d.ts" />
// Usage statistics (DESIGN.md §40): GET /api/chat/stats, for moderators and superusers, and what feeds it. Counts only:
// no response names anyone, and the per-account rows (stats_activity) never leave the server.
//
// Online is who has a realtime connection now: every open web tab and the Android app while it is in front hold one,
// with at least one subscription. A connection's app (web or Android) is noted when it subscribes, from its
// User-Agent (the app's OkHttp sends "okhttp/…"), by server/stats.go: in Go, so a subscription takes no JS runtime.
//
// Every 5 minutes `run` writes a sample of those counts and marks everyone online active today; a subscription marks
// its account too, at most once an hour (so a visit shorter than 5 minutes counts; server/stats.go). `site.no_stats`
// stops both.

/** The client store key of a connection's app (server/stats.go statsAppKey). */
const KEY_APP = "chirkle_app";
const SAMPLE_MINUTES = 5;
const ACTIVITY_DAYS = 90;
const SAMPLE_DAYS = 365;
const DAY_MS = 86_400_000;

/** @param {Date} d @returns {string} as PocketBase stores dates */
const dbDate = (d) => d.toISOString().replace("T", " ");

/** @param {core.App} app */
function off(app) {
  return !!require(`${__hooks}/lib/site.js`).siteOf(app)?.getBool("no_stats");
}

/**
 * `user` was online at `at`: its row for that (UTC) day says so.
 * @param {core.App} app
 * @param {string[]} users
 * @param {Date} at
 */
function touch(app, users, at) {
  const day = at.toISOString().slice(0, 10);
  const when = dbDate(at);
  for (const user of users) {
    app
      .db()
      .newQuery(
        "INSERT INTO stats_activity (id, user, day, last_at) VALUES ({:id}, {:user}, {:day}, {:at}) ON CONFLICT (user, day) DO UPDATE SET last_at = excluded.last_at",
      )
      .bind({ id: $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"), user, day, at: when })
      .execute();
  }
}

/**
 * Who is online now: distinct accounts (also by app; someone on both counts in each) and guests' connections.
 * Superusers (the admin UI) and connections that haven't subscribed to anything yet don't count.
 * @param {core.App} app
 */
function online(app) {
  const people = new Set();
  const web = new Set();
  const android = new Set();
  let guests = 0;
  const clients = app.subscriptionsBroker().clients();
  for (const id of Object.keys(clients)) {
    const client = clients[id];
    if (!client || client.isDiscarded() || !Object.keys(client.subscriptions()).length) continue;
    /** @type {core.Record | null | undefined} */
    const auth = client.get("auth");
    if (auth?.isSuperuser()) continue;
    if (!auth) {
      guests++;
      continue;
    }
    people.add(auth.id);
    const kind = client.get(KEY_APP);
    if (kind === "web") web.add(auth.id);
    else if (kind === "android") android.add(auth.id);
  }
  return { ids: [...people], online: people.size, guests, web: web.size, android: android.size };
}

/**
 * The 5-minute run: a sample, and everyone online marked active. Nothing while `site.no_stats` is ticked.
 * @param {core.App} app
 */
function run(app) {
  if (off(app)) return;
  const now = new Date();
  const o = online(app);
  app.runInTransaction((tx) => {
    tx.db()
      .newQuery(
        "INSERT INTO stats_samples (id, at, online, guests, web, android) VALUES ({:id}, {:at}, {:online}, {:guests}, {:web}, {:android})",
      )
      .bind({
        id: $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"),
        at: dbDate(now),
        online: o.online,
        guests: o.guests,
        web: o.web,
        android: o.android,
      })
      .execute();
    touch(tx, o.ids, now);
  });
}

/**
 * Daily: activity rows after 90 days, samples after a year. Also while statistics are off, so what there is goes.
 * @param {core.App} app
 */
function prune(app) {
  const now = Date.now();
  app
    .db()
    .newQuery("DELETE FROM stats_activity WHERE day < {:day}")
    .bind({ day: new Date(now - ACTIVITY_DAYS * DAY_MS).toISOString().slice(0, 10) })
    .execute();
  app
    .db()
    .newQuery("DELETE FROM stats_samples WHERE at < {:at}")
    .bind({ at: dbDate(new Date(now - SAMPLE_DAYS * DAY_MS)) })
    .execute();
}

/** POST /api/stats/tick (superusers, tests): a run now, and the prune with it. @param {core.RequestEvent} e */
function tick(e) {
  run(e.app);
  prune(e.app);
  return e.noContent(204);
}

/** Accounts of this server's own: not a linked server's people (§33), nor the Telegram bridge's stand-ins (§26). */
const LOCAL_USER = "u.kind NOT IN ('telegram', 'peer')";

const DAYS_SQL = `
SELECT date(m.created, {:shift}) AS day, COUNT(*) AS messages, COUNT(DISTINCT m.author) AS people
FROM messages m JOIN users u ON u.id = m.author
WHERE m.created >= {:since} AND ${LOCAL_USER}
GROUP BY day ORDER BY day`;

const MESSAGES_SQL = `
SELECT
  COUNT(DISTINCT CASE WHEN m.created >= {:week} THEN m.author END) AS people_week,
  COUNT(DISTINCT m.author) AS people_month,
  COALESCE(SUM(r.kind = 'dm'), 0) AS dms,
  COALESCE(SUM(CASE WHEN json_valid(m.files) THEN json_array_length(m.files) ELSE 0 END), 0) AS files,
  COALESCE(SUM((SELECT SUM(json_array_length(x.value, '$.users')) FROM json_each(CASE WHEN json_valid(m.reactions) THEN m.reactions ELSE '[]' END) x)), 0) AS reactions
FROM messages m JOIN users u ON u.id = m.author JOIN rooms r ON r.id = m.room
WHERE m.created >= {:month} AND ${LOCAL_USER}`;

const ACCOUNTS_SQL = `
SELECT COUNT(*) AS total, COALESCE(SUM(u.created >= {:week}), 0) AS new_week,
  COALESCE(SUM(u.moderator), 0) AS moderators, COALESCE(SUM(u.banned), 0) AS banned
FROM users u WHERE ${LOCAL_USER}`;

const ACTIVE_SQL = `
SELECT COUNT(DISTINCT CASE WHEN last_at >= {:day} THEN user END) AS day,
  COUNT(DISTINCT CASE WHEN last_at >= {:week} THEN user END) AS week,
  COUNT(DISTINCT user) AS month
FROM stats_activity WHERE last_at >= {:month}`;

/**
 * GET /api/chat/stats?tz=<minutes east of UTC>: for moderators and superusers. Days (the messages per day) are the
 * viewer's, from `tz`; "today" on the page is theirs too.
 * @param {core.RequestEvent} e
 */
function get(e) {
  const auth = e.auth;
  if (!auth || !(auth.isSuperuser() || require(`${__hooks}/lib/moderation.js`).isModerator(auth))) {
    throw new ForbiddenError("Only moderators can see the statistics.");
  }
  const tzRaw = Math.round(Number(e.request?.url?.query().get("tz") || 0));
  const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, tzRaw)) : 0;
  const now = Date.now();
  // The viewer's midnight today, as a UTC instant, and the 30 days' first.
  const midnight = Math.floor((now + tz * 60_000) / DAY_MS) * DAY_MS - tz * 60_000;
  const month = dbDate(new Date(midnight - 29 * DAY_MS));
  const week = dbDate(new Date(midnight - 6 * DAY_MS));
  const db = e.app.db();

  const days = arrayOf(new DynamicModel({ day: "", messages: 0, people: 0 }));
  db.newQuery(DAYS_SQL)
    .bind({ shift: `${tz >= 0 ? "+" : ""}${tz} minutes`, since: month })
    .all(days);

  const msgs = new DynamicModel({ people_week: 0, people_month: 0, dms: 0, files: 0, reactions: 0 });
  db.newQuery(MESSAGES_SQL).bind({ week, month }).one(msgs);

  const accounts = new DynamicModel({ total: 0, new_week: 0, moderators: 0, banned: 0 });
  db.newQuery(ACCOUNTS_SQL)
    .bind({ week: dbDate(new Date(now - 7 * DAY_MS)) })
    .one(accounts);

  const active = new DynamicModel({ day: 0, week: 0, month: 0 });
  db.newQuery(ACTIVE_SQL)
    .bind({
      day: dbDate(new Date(now - DAY_MS)),
      week: dbDate(new Date(now - 7 * DAY_MS)),
      month: dbDate(new Date(now - 30 * DAY_MS)),
    })
    .one(active);

  const rows = arrayOf(new DynamicModel({ at: "", online: 0, guests: 0, web: 0, android: 0 }));
  db.newQuery("SELECT at, online, guests, web, android FROM stats_samples WHERE at >= {:since} ORDER BY at")
    .bind({ since: dbDate(new Date(now - 7 * DAY_MS)) })
    .all(rows);

  const o = online(e.app);
  return e.json(200, {
    at: now,
    history: !off(e.app),
    sample_minutes: SAMPLE_MINUTES,
    now: { online: o.online, guests: o.guests, web: o.web, android: o.android },
    active: { day: active.day, week: active.week, month: active.month },
    accounts: { total: accounts.total, new_week: accounts.new_week, moderators: accounts.moderators, banned: accounts.banned },
    messages: {
      days: days.map((d) => ({ day: d.day, messages: d.messages, people: d.people })),
      people_week: msgs.people_week,
      people_month: msgs.people_month,
      dms_month: msgs.dms,
      files_month: msgs.files,
      reactions_month: msgs.reactions,
    },
    samples: rows.map((r) => [Date.parse(String(r.at).replace(" ", "T")), r.online, r.guests, r.web, r.android]),
  });
}

module.exports = { online, run, prune, tick, get };
