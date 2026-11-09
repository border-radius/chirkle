/// <reference path="../../types/pocketbase.d.ts" />
// Handles and mentions (DESIGN.md §41): every account has a handle (`users.handle`, a–z 0–9 _, 3–24, unique), which
// "@handle" in a message names. The hooks resolve a message's mentions from its text (`messages.mentions`: those named
// who can see its room); GET /api/chat/mentionable suggests people as "@" is typed.

const { accessOf, canSee, visibleRoom } = require(`${__hooks}/lib/access.js`);
const { fieldError } = require(`${__hooks}/lib/records.js`);
const { nameKey } = require(`${__hooks}/lib/text.js`);

const HANDLE_MIN = 3;
const HANDLE_MAX = 24;
const HANDLE = /^[a-z0-9_]{3,24}$/;
/** Kept for what may one day mean everyone in a room. */
const RESERVED = new Set(["all", "everyone", "here", "room", "channel"]);
/** Most people one message mentions. */
const MAX_MENTIONS = 20;
/** Most people GET /api/chat/mentionable suggests. */
const SUGGESTIONS = 8;

/**
 * "@handle" in a message: after the start or anything but a letter, digit, "_", "@", "." or "/" (an email, a path, a
 * linked instance's "ann@b.example"), and not followed by one of those. Keep in sync with web/src/lib/mentions.ts and
 * the app's lib/Mentions.kt (shared/vectors/mentions.json).
 */
const MENTION = /(^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_@])/g;

/** @type {Record<string, string>} */
const CYRILLIC = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
};

/**
 * Letters NFKD leaves whole (Ł, Ø, Æ, Þ…) and Greek, spelled in Latin: "Łukasz" was "ukasz", "Ørjan" "rjan" (QA BUG-255).
 * @type {Record<string, string>}
 */
const LATIN = {
  ł: "l",
  ø: "o",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ħ: "h",
  ŧ: "t",
  ŋ: "ng",
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

/**
 * A handle made from a display name: Latin letters without their accents, Cyrillic spelled in Latin, anything else
 * an "_" (at most 20, so a number fits after it). Keep in sync with pb_migrations/1760000045_mentions.js.
 * @param {string} name
 */
function handleFrom(name) {
  let s = [...name.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join("");
  if (typeof s.normalize === "function") s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s
    .replace(/ß/g, "ss")
    .replace(/[\u0080-\uffff]/g, (c) => LATIN[c] ?? c)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/, "");
  if (s.length < HANDLE_MIN) s = s ? `${s}_user` : "user";
  return s;
}

/**
 * Is `handle` someone else's than user `id`'s?
 * @param {core.App} app
 * @param {string} handle
 * @param {string} id
 */
function taken(app, handle, id) {
  if (RESERVED.has(handle)) return true;
  try {
    app.findFirstRecordByFilter("users", "handle = {:h} && id != {:id}", { h: handle, id });
    return true;
  } catch {
    return false;
  }
}

/**
 * The first free handle for `base` ("ann", then "ann2", "ann3"…).
 * @param {core.App} app
 * @param {string} base
 * @param {string} id the user's own (their handle isn't taken from them)
 */
function freeHandle(app, base, id) {
  for (let n = 1; n < 10000; n++) {
    const tail = n > 1 ? String(n) : "";
    const candidate = `${base.slice(0, HANDLE_MAX - tail.length)}${tail}`;
    if (!taken(app, candidate, id)) return candidate;
  }
  return `${base.slice(0, HANDLE_MAX - 10)}_${$security.randomStringWithAlphabet(9, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
}

/**
 * A handle as typed: no leading "@", in lower case, trimmed.
 * @param {string} raw
 */
const normalHandle = (raw) => raw.trim().replace(/^@/, "").toLowerCase();

/**
 * users create/update (lib/users.js beforeUserSave): a new account without a handle gets one from its name; one typed
 * is checked (allowed characters, length, not someone else's). An update that keeps it keeps it unchecked.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function setHandle(app, rec) {
  const typed = normalHandle(rec.getString("handle"));
  if (!rec.isNew() && typed === rec.original().getString("handle")) {
    rec.set("handle", typed);
    return;
  }
  if (typed === "") {
    if (!rec.isNew() && rec.original().getString("handle") !== "") throw fieldError("handle", "Cannot be blank.", "validation_required");
    rec.set("handle", freeHandle(app, handleFrom(rec.getString("name")), rec.id));
    return;
  }
  if (!HANDLE.test(typed)) {
    throw fieldError("handle", `Use ${HANDLE_MIN} to ${HANDLE_MAX} letters a–z, digits or underscores.`);
  }
  if (taken(app, typed, rec.id)) throw fieldError("handle", "This handle is taken. Choose another one.", "validation_not_unique");
  rec.set("handle", typed);
}

/**
 * The handles "@"-named in `text`, in lower case, each once, at most MAX_MENTIONS.
 * @param {string} text
 */
function handlesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(MENTION)) {
    out.add(m[2].toLowerCase());
    if (out.size >= MAX_MENTIONS) break;
  }
  return [...out];
}

/**
 * Who message `rec` mentions: the people its text names who can see its room, but not its author.
 * @param {core.App} app
 * @param {core.Record} rec
 * @returns {string[]} user ids
 */
function mentionsOf(app, rec) {
  const handles = handlesIn(rec.getString("text"));
  if (!handles.length) return [];
  let room;
  try {
    room = app.findRecordById("rooms", rec.getString("room"));
  } catch {
    return [];
  }
  const access = accessOf(room);
  const params = Object.fromEntries(handles.map((h, i) => [`h${i}`, h]));
  const found = app.findRecordsByFilter("users", handles.map((_, i) => `handle = {:h${i}}`).join(" || "), "", MAX_MENTIONS, 0, params);
  const author = rec.getString("author");
  const byHandle = new Map(found.flatMap((u) => (u ? [[u.getString("handle"), u.id]] : [])));
  return handles.flatMap((h) => {
    const id = byHandle.get(h);
    return id && id !== author && canSee(access, id) ? [id] : [];
  });
}

/**
 * messages create and update (main.pb.js): `mentions` from the text, unless the save is a linked instance's (§33),
 * which names the people itself (federation/messages.js). A forward mentions no one: its words are the original's.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {boolean} fromPeer
 */
function setMentions(app, rec, fromPeer) {
  if (fromPeer) return;
  if (rec.getString("forwarded_from") !== "" || rec.getBool("deleted") || rec.getString("author") === "") {
    rec.set("mentions", []);
    return;
  }
  // Unchanged text keeps them (or what PocketBase left of them, a mentioned account deleted for good). The update
  // request hook refuses any other change.
  if (!rec.isNew() && rec.getString("text") === rec.original().getString("text")) return;
  rec.set("mentions", mentionsOf(app, rec));
}

/** Messages looked at for who has written in a room lately. */
const RECENT = 300;

/**
 * GET /api/chat/mentionable?room=&q= → up to SUGGESTIONS people who can see `room` whose handle or name starts with
 * (or, failing enough of those, contains) `q`, as the composer's "@" suggestions: [{ id, name, handle, avatar,
 * instance }]. Those who wrote there lately first (not in an anonymous room, where that would say who they are), the
 * caller never. An empty `q` lists those recent writers, or a private room's members.
 * @param {core.RequestEvent} e
 */
function mentionable(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const q = e.requestInfo().query;
  const room = visibleRoom(e.app, typeof q.room === "string" ? q.room : "", me.id);
  if (!room) throw new NotFoundError("The room doesn't exist.");
  const typed = normalHandle(typeof q.q === "string" ? q.q : "").slice(0, 32);
  const key = nameKey(typed);
  const access = accessOf(room);

  /** @type {string[]} */
  let recent = [];
  if (!room.getBool("anonymous")) {
    const rows = arrayOf(new DynamicModel({ author: "" }));
    e.app
      .db()
      .newQuery(
        `SELECT author FROM (SELECT author, created FROM messages WHERE room = {:room} AND author != '' AND deleted = FALSE ORDER BY created DESC LIMIT ${RECENT}) GROUP BY author ORDER BY MAX(created) DESC LIMIT 50`,
      )
      .bind({ room: room.id })
      .all(rows);
    recent = rows.map((r) => r.author);
  }
  const rank = new Map(recent.map((id, i) => [id, i]));

  /** @type {core.Record[]} */
  let pool = [];
  const members = access.visibility === "private" ? [...new Set([access.createdBy, ...access.members])].filter(Boolean) : [];
  if (members.length) {
    pool = e.app.findRecordsByIds("users", members).filter((u) => !!u);
  } else if (typed) {
    const like = { h: `${typed.replace(/[%_\\]/g, "\\$&")}%`, k: `%${key.replace(/[%_\\]/g, "\\$&")}%` };
    const rows = arrayOf(new DynamicModel({ id: "" }));
    e.app
      .db()
      .newQuery(
        "SELECT id FROM users WHERE banned = FALSE AND (handle LIKE {:h} ESCAPE '\\' OR name_key LIKE {:k} ESCAPE '\\') ORDER BY handle LIMIT 200",
      )
      .bind(like)
      .all(rows);
    // With those who wrote lately, whom a short query may match among many more.
    pool = e.app.findRecordsByIds("users", [...new Set([...recent, ...rows.map((r) => r.id)])]).filter((u) => !!u);
  } else if (recent.length) {
    pool = e.app.findRecordsByIds("users", recent).filter((u) => !!u);
  }

  /** @param {core.Record} u */
  const score = (u) => {
    const handle = u.getString("handle");
    const name = nameKey(u.getString("name"));
    if (!typed) return 0;
    if (handle.startsWith(typed)) return 0;
    if (name.startsWith(key) || name.split(/[\s_\-.]+/).some((/** @type {string} */ w) => w.startsWith(key))) return 1;
    if (handle.includes(typed) || name.includes(key)) return 2;
    return 3;
  };
  const found = pool
    .filter((u) => u.id !== me.id && u.getString("handle") !== "" && !u.getBool("banned") && canSee(access, u.id) && score(u) < 3)
    .sort(
      (a, b) =>
        score(a) - score(b) ||
        (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) ||
        a.getString("handle").localeCompare(b.getString("handle")),
    )
    .slice(0, SUGGESTIONS);
  return e.json(
    200,
    found.map((u) => ({
      id: u.id,
      name: u.getString("name"),
      handle: u.getString("handle"),
      avatar: u.getString("avatar"),
      instance: u.getString("instance"),
    })),
  );
}

module.exports = { HANDLE, MENTION, handleFrom, freeHandle, setHandle, handlesIn, mentionsOf, setMentions, mentionable, normalHandle };
