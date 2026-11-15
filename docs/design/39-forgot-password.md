# §39. Forgot password (2026-11-08)

Part of the design document: [index](../DESIGN.md).

The user asked to "add 'forgot password' function to the product". It is PocketBase's own password reset, offered once
the admin set up email, with the emailed link opening the app's page instead of PocketBase's dashboard.

## 39.1 Server

- **Offered only with mail:** the site record answers `password_reset` (not a field: set by an enrich hook,
  `lib/site.js` `showPasswordReset`, from `settings.smtp.enabled`). Without SMTP, PocketBase falls back to the
  host's `sendmail`, which a container rarely delivers through: the request would answer 204 and no email come.
- **The request** is PocketBase's `POST /api/collections/users/request-password-reset { email }`: 204 whether or not
  the address has an account, so it tells nobody which addresses do. PocketBase sends at most one email per account
  every 2 minutes, and the migration (`1760000045_password_reset.js`) adds `users:requestPasswordReset`, 5 per 10
  minutes per IP. PocketBase looks the address up exactly as sent and answers an unknown one before any hook, so the
  clients send it in lower case, the way emails are stored (QA BUG-47).
- **Stand-ins** (Telegram, another instance) get no email: their addresses are made up (`….invalid`). The
  hook (`lib/users.js` `skipStandInReset`) answers 204 without sending, as for an unknown address.
- **The link:** the migration changes the users collection's reset template from
  `{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}` (the dashboard's page) to `{APP_URL}/reset-password/{TOKEN}`.
  A template an admin had already changed keeps its own link. `{APP_URL}` is *Settings → Application → Application
  URL*, which an admin sets anyway for linked instances (§33.2).
- **The token** is PocketBase's: a JWT for 30 minutes (*Collections → users → Options → Tokens*) whose claims hold the
  account's id and email, signed with the account's token key. `POST
  /api/collections/users/confirm-password-reset { token, password, passwordConfirm }` sets the password (the
  field's own rules: at least 8 characters) and changes the token key, so the link works once and every session of
  the account ends, as changing the password does (§22.2). A banned account (§36) can set a password and still can't
  log in.

## 39.2 Web (`web/src/views/login.ts`)

- **Log in** shows "Forgot password?" under the password while the site says `passwordReset` (cached with the rest of
  the site, §24; a cache from before it has none, so it waits for the server). It opens the **Reset password** form
  in the same card, without the tabs: the email (the one typed to log in, if any) and "Send link". Sent, the form
  makes way for "If an account uses …, a link to set a new password is on its way. It works for 30 minutes." "Back to
  log in" returns.
- **`/reset-password/:token`** (public, so a link opened while logged in works too; `app.ts` counts it with the auth
  pages, never a page to come back to) is **Set a new password**: one field (`autocomplete="new-password"`,
  `minlength`), "Set password". Then it logs in with the new password, as the email in the token's claims, and goes
  home. If that login fails, it shows Log in with the email filled and "Your password was changed. Log in with it."
  A link that ran out or was used: "This link has expired or was already used. Ask for a new one."
- Two more modes of the login view rather than a lazy chunk: +0.57 KB gzipped (app.js 49.70 of 49.75 KB). Since the login
  view became a lazy chunk (2026-11-10) they are in it: `loginJs` 2.24 KB, its budget raised from 2 to 2.30 KB, and
  `app.css` 11.27 KB with mentions, its budget raised from 11.25 to 11.30 KB (the user's call, 2026-11-10).

## 39.3 Android (ANDROID.md §62)

The auth screen has the same "Forgot password?" and Reset password form (`AuthMode.Forgot`). The link opens in the
browser: the app's links (`/r/`, `/c/`) don't include `/reset-password/`, and the web page logs that browser in.

## 39.4 Tests

- `tests/integration/password_reset.test.ts`, against a test SMTP server (`tests/support/smtp.ts`): offered only
  with mail; the email links to `/reset-password/`, not the dashboard; the token sets the password once and ends
  every session; unknown addresses and stand-ins get nothing and the same answer; short passwords and made-up tokens
  are refused; one email per account at a time; the rate limit rule.
- `tests/component/views/login.test.ts` "forgot password (§39)": the link only with `passwordReset`, the forms, the
  login after the reset and its fallback, the expired link. `site.test.ts`: the flag and an old cache.
- `tests/e2e/password_reset.spec.ts`: the whole flow in a browser, the email read from the test SMTP server.
- Android `UiPasswordResetTest`: the site's flag, the request, the form on the screen and its absence without mail.
