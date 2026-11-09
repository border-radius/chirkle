/// <reference path="../types/pocketbase.d.ts" />
// Forgot password (DESIGN.md §39): PocketBase's own reset, with the email's link opening the app's page
// (/reset-password/{TOKEN}, web/src/views/reset.ts) instead of the admin dashboard's. A template an admin already
// changed keeps its own link. Asking for emails is limited per IP, beyond PocketBase's one email per address every
// two minutes.

const DASHBOARD_LINK = "{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}";
const APP_LINK = "{APP_URL}/reset-password/{TOKEN}";
const RESET_LIMIT = { label: "users:requestPasswordReset", audience: "", duration: 600, maxRequests: 5 };

/**
 * @param {Parameters<Parameters<typeof migrate>[0]>[0]} app
 * @param {string} from
 * @param {string} to
 */
function relink(app, from, to) {
  const users = app.findCollectionByNameOrId("users");
  const body = users.resetPasswordTemplate.body;
  if (!body.includes(from)) return;
  users.resetPasswordTemplate.body = body.split(from).join(to);
  app.save(users);
}

migrate(
  (app) => {
    relink(app, DASHBOARD_LINK, APP_LINK);
    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== RESET_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (RESET_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    relink(app, APP_LINK, DASHBOARD_LINK);
    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== RESET_LIMIT.label);
    app.save(settings);
  },
);
