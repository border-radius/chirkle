/// <reference path="../../types/pocketbase.d.ts" />
// Invite-only signups (DESIGN.md §24): while the `site` record says invite_only, a new account needs its invite_code
// (sent as `invite_code` with the signup). Superusers create accounts as they like.

/**
 * The site record (the oldest, should a second one be added), or null without one.
 * @param {core.App} app
 */
function siteOf(app) {
  const found = app.findRecordsByFilter("site", "", "created", 1, 0);
  return found.length ? found[0] : null;
}

/**
 * users create request: refuse a signup without the invite code while the site is invite-only.
 * @param {core.RecordRequestEvent} e
 */
function checkInvite(e) {
  if (e.hasSuperuserAuth()) return;
  const site = siteOf(e.app);
  if (!site?.getBool("invite_only")) return;
  const want = site.getString("invite_code").trim();
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  const got = typeof body.invite_code === "string" ? body.invite_code.trim() : "";
  if (want !== "" && got !== "" && $security.equal(got, want)) return;
  const [code, message] =
    want === ""
      ? ["validation_signups_closed", "Signing up is closed."]
      : got === ""
        ? ["validation_required", "Enter your invite code."]
        : ["validation_invalid_invite", "This invite code isn't valid."];
  throw new BadRequestError("Failed to create record.", { invite_code: new ValidationError(code, message) });
}

/**
 * users OAuth2 login: no new accounts this way while the site is invite-only (there is no code to check).
 * @param {core.RecordAuthWithOAuth2RequestEvent} e
 */
function checkOAuth2Signup(e) {
  if (e.isNewRecord && siteOf(e.app)?.getBool("invite_only")) throw new ForbiddenError("Signing up is by invitation only.");
}

/**
 * GET /manifest.webmanifest: the web app manifest (§27), named after the site's title. The icons stay the app's own:
 * the logo may be any image (an SVG or a small one), and an installed app needs square PNGs.
 * @param {core.RequestEvent} e
 */
function manifest(e) {
  const name = siteOf(e.app)?.getString("title") || "Chirkle";
  const icon = (/** @type {string} */ src, /** @type {string} */ sizes, purpose = "any") => ({
    src: `/icons/${src}`,
    sizes,
    type: src.endsWith(".svg") ? "image/svg+xml" : "image/png",
    purpose,
  });
  e.response.header().set("Content-Type", "application/manifest+json");
  return e.string(
    200,
    JSON.stringify({
      id: "/",
      name,
      short_name: name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      // The app bar's color (--surface) and the page's (--bg), light theme: a manifest can't follow the system's.
      theme_color: "#f1eefc",
      background_color: "#fbfaff",
      icons: [
        icon("icon.svg", "any"),
        icon("icon-192.png", "192x192"),
        icon("icon-512.png", "512x512"),
        icon("maskable-512.png", "512x512", "maskable"),
      ],
    }),
  );
}

/**
 * GET /.well-known/assetlinks.json: lets the Android app open links to rooms and messages (docs/ANDROID.md §9.4). From ANDROID_APP_ID
 * (the app's own id, com.chirkle.android, when unset) and ANDROID_CERT_SHA256 (comma-separated fingerprints); 404
 * without fingerprints.
 * @param {core.RequestEvent} e
 */
function assetLinks(e) {
  const app = $os.getenv("ANDROID_APP_ID").trim() || "com.chirkle.android";
  const certs = $os
    .getenv("ANDROID_CERT_SHA256")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (!certs.length) throw new NotFoundError();
  e.response.header().set("Cache-Control", "public, max-age=3600");
  return e.json(200, [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: app, sha256_cert_fingerprints: certs },
    },
  ]);
}

module.exports = { siteOf, checkInvite, checkOAuth2Signup, manifest, assetLinks };
