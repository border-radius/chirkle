/// <reference path="../../types/pocketbase.d.ts" />
// users (DESIGN.md §5.1, §22.1): the hooks that clean a saved user (display name, email) and find a login by email, and
// GET /api/chat/users?q= (§16.5): find people to message by name. Matched against `name_key` (case folded
// like names are compared, §22.1), so "иван" finds "Иван" and "strasse" "Straße": SQLite's LIKE only ignores the case
// of ASCII letters (QA BUG-55). `name_key` is hidden from clients, hence a route rather than a filter.

const { assertImagesFit } = require(`${__hooks}/lib/images.js`);
const { cleanName, fieldError, originalNames, recordOf, setNameKey } = require(`${__hooks}/lib/records.js`);
const { nameKey } = require(`${__hooks}/lib/text.js`);

/** Most people one search returns. */
const LIMIT = 20;

/** Most bytes of a password: bcrypt reads 72, PocketBase takes 71. */
const PASSWORD_MAX_BYTES = 71;

/**
 * Signup, password change, password reset: a password over PocketBase's limit is refused with the reason. Past 72 bytes
 * PocketBase answered 400 with none ("Failed to create record.", "Invalid value."), which a password manager's long
 * password ran into (QA BUG-267).
 * @param {unknown} password
 */
function checkPasswordLength(password) {
  if (typeof password !== "string") return;
  let bytes = 0;
  for (const c of password) {
    const n = /** @type {number} */ (c.codePointAt(0));
    bytes += n < 0x80 ? 1 : n < 0x800 ? 2 : n < 0x10000 ? 3 : 4;
  }
  if (bytes > PASSWORD_MAX_BYTES) {
    throw fieldError(
      "password",
      "Use at most 71 characters (fewer if some aren't plain Latin letters, digits or punctuation).",
      "validation_max_text_constraint",
    );
  }
}

/**
 * What kind of account `user` is (§5.1, `users.kind`): "person" (signs in here), "telegram" (a Telegram sender's
 * stand-in, §26.3) or "peer" (a linked instance's person, §33.4). Never set: a person.
 * @param {core.Record} user
 * @returns {"person" | "telegram" | "peer"}
 */
function kindOf(user) {
  const kind = user.getString("kind");
  return kind === "telegram" || kind === "peer" ? kind : "person";
}

/** A stand-in: an account nobody signs in to here (a Telegram sender's, another instance's person's). @param {core.Record} user */
const isStandIn = (user) => kindOf(user) !== "person";

/** @param {core.RequestEvent} e */
function searchUsers(e) {
  const me = e.auth;
  if (!me) throw new UnauthorizedError("The request requires a logged-in user.");
  const raw = e.requestInfo().query.q;
  const key = nameKey(typeof raw === "string" ? raw.trim() : "");
  if (!key) return e.json(200, []);
  // `~` treats a % in the value as a wildcard (and then stops adding its own): escape it (QA BUG-34). `_` is escaped.
  // "@ann" finds Ann by her handle (§41) as well as by name.
  const handle = key.replace(/^@/, "");
  const found = e.app.findRecordsByFilter("users", "(name_key ~ {:q} || handle ~ {:h}) && id != {:me}", "name", LIMIT, 0, {
    q: key.replace(/%/g, "\\%"),
    h: handle.replace(/%/g, "\\%"),
    me: me.id,
  });
  // Only the public profile, never the email (§6).
  return e.json(
    200,
    found.flatMap((u) =>
      u
        ? [
            {
              id: u.id,
              name: u.getString("name"),
              handle: u.getString("handle"),
              avatar: u.getString("avatar"),
              no_dms: u.getBool("no_dms"),
              instance: u.getString("instance"),
            },
          ]
        : [],
    ),
  );
}

/**
 * users create/update: clean the display name (§5.1), which must be unique (§22.1). A new email is stored in lower case, so the same address can't
 * make two accounts and logging in doesn't depend on how it was capitalized (QA BUG-47). Existing ones are left as they
 * are on other updates (the migration lowered every one it could).
 * @param {core.RecordEvent} e
 */
function beforeUserSave(e) {
  const rec = recordOf(e);
  const email = rec.getString("email");
  if (rec.isNew() || email !== rec.original().getString("email")) rec.set("email", email.trim().toLowerCase());
  // Signups and accounts a superuser makes are people; the bridges set their stand-ins' kind before saving.
  if (rec.isNew() && !rec.getString("kind")) rec.set("kind", "person");
  cleanName(rec);
  if (!rec.isNew() && rec.getString("name") === rec.original().getString("name")) {
    // Name unchanged: keep its key. Accounts named before name_key existed may share a name (the migration made
    // their keys unique), and must still be able to change their picture or password.
    rec.set("name_key", rec.original().getString("name_key"));
  } else {
    setNameKey(e.app, "users", rec, "This display name is taken. Choose another one.");
  }
  require(`${__hooks}/lib/handles.js`).setHandle(e.app, rec);
  assertImagesFit(rec, "avatar");
  originalNames(rec, "avatar"); // only for the upload's own name (QA BUG-35)
}

/**
 * users auth-with-password: an email that matched nobody as typed is looked up in lower case, the way emails are
 * stored (QA BUG-47). PocketBase then checks the password as usual.
 * @param {core.RecordAuthWithPasswordRequestEvent} e
 */
function findLoginByEmail(e) {
  if (e.record || (e.identityField && e.identityField !== "email") || !e.identity.includes("@")) return;
  try {
    e.record = e.app.findFirstRecordByFilter("users", "email = {:email}", { email: e.identity.trim().toLowerCase() });
  } catch {
    // no such user: PocketBase answers "Failed to authenticate." as for any wrong login
  }
}

/**
 * users request-password-reset (§39): no email to a stand-in (Telegram, another instance): its address is made
 * up (`….invalid`) and nobody can log in as it (`kind`, §5.1). Answered like any other request, as PocketBase does for an unknown
 * address, so it doesn't tell which addresses have accounts. Only called for an address that matched: PocketBase
 * answers an unknown one before the hooks, so the clients send it in lower case, the way emails are stored (QA BUG-47).
 * @param {core.RecordRequestPasswordResetRequestEvent} e
 */
function skipStandInReset(e) {
  if (e.record && isStandIn(e.record)) return e.noContent(204);
  return e.next();
}

module.exports = { beforeUserSave, checkPasswordLength, findLoginByEmail, isStandIn, kindOf, searchUsers, skipStandInReset };
