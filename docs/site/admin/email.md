---
title: Email and password resets
description: Set up email on a Chirkle server so people can reset forgotten passwords themselves, on the web and on Android.
section: Administration
order: 5
---

Once your server can send email, the login page (on the web and in the Android app) offers **Forgot password?**.
Until then it doesn't, and you reset passwords yourself in the admin UI.

## Set it up

1. **Set the public address.** In the admin UI, *Settings → Application → Application URL*: your server's address,
   for example `https://chat.example.com`. The link in the email starts with it.
2. **Set up mail.** In *Settings → Mail settings*, fill in the sender's name and address, turn on
   **Use SMTP mail server**, and enter your mail provider's host, port, username and password.
3. **Test it** with **Send test email**.

**Forgot password?** shows on the login page as soon as SMTP is turned on. An SMTP server that is filled in but turned
off isn't used.

## What people get

They enter their account's email, and a link to set a new password is sent to it. The page doesn't say whether an
account uses that email, so nobody can find out who has an account.

The link works once, for 30 minutes. Setting a new password logs the account out on every device. Asking for links is
[rate limited](rate-limits.md): 5 per 10 minutes per IP address.

## Change the email's wording

*Collections → users → Options → Default Password reset email template*. Keep `{APP_URL}/reset-password/{TOKEN}` as the
link.

## Reset a password yourself

In *Collections → users*, edit the person's record and set a new password. Tell them what it is, and ask them to change
it in [Settings](../guide/account.md#password).
