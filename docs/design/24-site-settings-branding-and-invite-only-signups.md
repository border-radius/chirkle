# §24. Site settings: branding and invite-only signups

Part of the design document: [index](../DESIGN.md).

An admin (a PocketBase superuser) sets the site's title and logo, and can make signing up need an invite code. There
is no admin page in the app: it is all in the PocketBase admin UI (`/_/`, *Collections → site*).

## 24.1 Data model and rules

`site` (migration `1760000015_site.js`) holds one record, created by the migration:

| Field | Type | Notes |
|---|---|---|
| `title` | text, required, 1–48 | Shown in the app bar, on the login page and in the tab's title. "Chirkle" at first (a site still titled "Chat", the name before 2026-10-27, takes it: migration `1760000036`). |
| `logo` | file, optional | SVG, PNG, JPEG, WebP or GIF, up to 1 MB, public. Replaces the app bar's speech bubble and sits above the title on the login page. |
| `invite_only` | bool | Signing up needs `invite_code`. |
| `invite_code` | text, **hidden**, ≤ 100 | Only superusers see it. Empty while invite-only: signups are closed. |

List and view rules are `""` (anyone, guests too: the login page needs the branding and whether to ask for a code);
create, update and delete are superusers only. Should a second record be added, the oldest one counts. PocketBase
serves files with a `sandbox` Content-Security-Policy, so an SVG logo can't run scripts even opened on its own.

## 24.2 Invite-only signups

`checkInvite()` (`pb_hooks/lib/site.js`, a users create-request hook) runs before the record is validated. While the
site is invite-only, the request must carry `invite_code` (not a users field, so PocketBase doesn't store it) equal to
the site's, ignoring spaces around it and compared in constant time; otherwise a 400 on `invite_code`:
`validation_required` (none sent), `validation_invalid_invite` (wrong, case-sensitive) or `validation_signups_closed`
(the site has no code). Superusers create accounts as before (the admin UI). Existing accounts log in as before. OAuth2
(off, §14) can't create accounts while invite-only either: `checkOAuth2Signup()` refuses them. The signup rate limit
(§5) also limits guessing.

## 24.3 Frontend

`api.site()` reads the record (`id,title,logo,invite_only`) and `startSite()` (`web/src/site.ts`) puts it in the store
as `site` at startup: the app bar's brand, the login page's heading and the tab's title (§22.4) follow it. It stays when
the session ends. The last one seen is kept in localStorage (`chat.site`), so a reload shows the site's own branding
at once; a failed load keeps what is shown. On the Sign up tab of an invite-only site, an **Invite code** field comes
last, and its errors show next to it. A site made invite-only after the page loaded still refuses the signup, with the
server's message above the button.

A site with its own name (anything but "Chirkle") says where it runs: **chirps on Chirkle**, small and muted, with
"Chirkle" a link to https://chirkle.com in a new tab. It sits under the title in the sidebar (where the title, not the
whole brand, is then the link home, stretched over the logo and title so the line's link stays its own) and under the
login page's heading; not in the narrow app bar, which has no room for a second line (`byLine()`, `header.ts`).

## 24.4 Tests

- **Integration** (`site.test.ts`): one public record without its code; only superusers change it; the logo is a public
  image and an SVG one is sandboxed; signups open, needing the code (missing, wrong, wrong case, padded), and closed;
  existing accounts still log in and superusers still create accounts.
- **Unit**: loading, caching and failing to load the site (`site.test.ts`); the app bar, login page and tab title with
  a custom site, kept after logging out; "chirps on Chirkle" in the sidebar and on the login page, not for a site
  called Chirkle (`app.test.ts`); the invite code field, what it sends and its errors (`login.test.ts`).
