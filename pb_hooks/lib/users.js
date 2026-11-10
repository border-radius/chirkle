/// <reference path="../../types/pocketbase.d.ts" />
// users (DESIGN.md §5.1, §22.1): the hooks that clean a saved user (display name, email) and find a login by email, and
// GET /api/chat/users?q= (§16.5): find people to message by name. Matched against `name_key` (case folded
// like names are compared, §22.1), so "иван" finds "Иван" and "strasse" "Straße": SQLite's LIKE only ignores the case
// of ASCII letters (QA BUG-55). `name_key` is hidden from clients, hence a route rather than a filter.

const { assertImagesFit } = require(`${__hooks}/lib/images.js`);
const { cleanName, originalNames, recordOf, setNameKey } = require(`${__hooks}/lib/records.js`);
const { nameKey } = require(`${__hooks}/lib/text.js`);

/** Most people one search returns. */
const LIMIT = 20;

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
 * up (`….invalid`) and nobody can log in as it. Answered like any other request, as PocketBase does for an unknown
 * address, so it doesn't tell which addresses have accounts. Only called for an address that matched: PocketBase
 * answers an unknown one before the hooks, so the clients send it in lower case, the way emails are stored (QA BUG-47).
 * @param {core.RecordRequestPasswordResetRequestEvent} e
 */
function skipStandInReset(e) {
  if (e.record?.getString("email").endsWith(".invalid")) return e.noContent(204);
  return e.next();
}

module.exports = { beforeUserSave, findLoginByEmail, searchUsers, skipStandInReset };
