---
title: Branding and signups
description: Give your Chirkle server its own name and logo, and make signing up need an invite code or close it entirely.
section: Administration
order: 2
---

Both are on the one record under *Collections → site* in the admin UI.

## Your name and logo

Edit the site record:

- **`title`**: up to 48 characters. It shows in the app bar, on the login page, in the browser tab's title, and as the
  name of the [installed app](../guide/app.md).
- **`logo`**: an SVG, PNG, JPEG, WebP or GIF of up to 1 MB. It replaces Chirkle's logo in the app bar and above the
  title on the login page.

The installed app's icon stays Chirkle's, since it needs square images in fixed sizes.

## Invite-only signups

1. On the site record, tick **`invite_only`** and set **`invite_code`**. Codes are case-sensitive; spaces around them
   are ignored.
2. Send the code to the people you want to let in. They enter it as the **Invite code** on the sign-up form.

- **To revoke a code,** change it. People who already signed up keep their accounts.
- **To close signups entirely,** clear `invite_code` while `invite_only` stays ticked.
- **You can always create accounts yourself** under *Collections → users*.

Only superusers can see the code. Wrong guesses are slowed by the signup [rate limit](rate-limits.md).

For a private room rather than the whole server, a room's creator can share an
[invite link](../guide/rooms.md#invite-links) instead. It only lets in people who already have an account.
