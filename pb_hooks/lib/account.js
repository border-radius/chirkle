/// <reference path="../../types/pocketbase.d.ts" />
// POST /api/chat/password (DESIGN.md §22.2): change your password. Checks the current one, signs out every other
// session, and answers like a login (a fresh token and record), so the tab that changed it stays logged in.

/**
 * @param {string} field
 * @param {string} message
 * @param {string} [code]
 */
function fieldError(field, message, code = "validation_invalid_value") {
  return new BadRequestError("Failed to change the password.", { [field]: new ValidationError(code, message) });
}

/** @param {core.RequestEvent} e */
function changePassword(e) {
  if (!e.auth) throw new UnauthorizedError("The request requires a logged-in user.");
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const oldPassword = typeof body.oldPassword === "string" ? body.oldPassword : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!oldPassword) throw fieldError("oldPassword", "Enter your current password.", "validation_required");
  if (!password) throw fieldError("password", "Enter a new password.", "validation_required");
  const user = e.app.findRecordById("users", e.auth.id);
  if (!user.validatePassword(oldPassword)) throw fieldError("oldPassword", "That isn't your current password.");
  if (password === oldPassword) throw fieldError("password", "That is your current password. Choose a new one.");
  require(`${__hooks}/lib/users.js`).checkPasswordLength(password);
  user.setPassword(password); // the field's own rules (length) are checked by save()
  user.refreshTokenKey(); // every token issued so far stops working: other devices are signed out
  e.app.save(user);
  return $apis.recordAuthResponse(e, user, "password");
}

module.exports = { changePassword };
