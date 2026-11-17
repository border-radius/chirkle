---
title: Rate limits
description: The rate limits a Chirkle server applies per IP address to messages, signups and other actions, and how to change them.
section: Administration
order: 7
---

Chirkle limits how often each IP address can do things, so one person or script can't flood the server.

## The defaults

| Action | Limit per IP address |
|---|---|
| Sending messages | 10 per 5 seconds |
| Editing and deleting messages | 20 per 10 seconds |
| Reactions | 30 per 10 seconds |
| Forwarding several messages | 20 requests per minute |
| Deleting several messages | 20 requests per minute |
| Creating rooms | 5 per minute |
| Opening DMs | 10 per minute |
| Marking rooms read | 120 per minute |
| Signing up | 20 per minute |
| Changing a password | 5 per minute |
| Password reset emails | 5 per 10 minutes |

Everything else uses PocketBase's defaults.

## Change them

In the admin UI, *Settings → Rate limits*. Changes apply at once.

## Behind a proxy

The limits count per visitor's IP address. Behind a reverse proxy, start Chirkle with
`TRUSTED_PROXY=X-Forwarded-For`, or every request seems to come from the proxy and one visitor tripping a limit trips
it for everyone. See [Behind a reverse proxy](../deploy/reverse-proxy.md).

Many people behind one address (an office, a school) share its limits. If they run into them, raise the limits for
the actions they hit.
