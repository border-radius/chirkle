# §10. Security considerations

Part of the design document: [index](../DESIGN.md).

| Threat | Mitigation |
|---|---|
| XSS through message, room or user names | Rendered with text nodes only. No `innerHTML` (enforced in CI). Strict CSP with no inline scripts. |
| Impersonation (posting as someone else) | `@request.body.author = @request.auth.id` create rule. Author can't change on update. Covered by integration tests. |
| Deleted content lingering | Soft delete wipes `text` on the server inside the same update. Only the placeholder metadata (author, time) remains, and an integration test checks the DB row directly. |
| Filter injection | `pb.filter()` with bound params everywhere. |
| Email harvesting | `emailVisibility = false`, and `fields` requests never include email. |
| Spam and flooding | PocketBase rate limits, the 2000-char cap, and signup rate limiting. The limits are per client IP: behind a reverse proxy, `TRUSTED_PROXY=X-Forwarded-For` (applied on start by `trustProxy` in `http.js`, set in the Docker image) makes them per client rather than one for everyone; the rightmost address is used, so clients can't choose theirs. |
| Server-side request forgery (link previews) | The previews worker fetches only http(s) on default ports from public hosts (§28.1): no local names, private IPv4, IPv6 literals or userinfo. Names are looked up first and refused when any address is private; curl connects only to the address checked. Redirects are checked the same way, one by one. Only the start of a response is read (256 KB, 16 KB for icons), so a huge one can't fill memory. `LINK_PREVIEWS=off` turns it off. |
| Untrusted video files (video posters) | ffmpeg reads uploads to make posters (§30.1): only the local file, the container's own demuxer (no playlists, no other protocols), one thread, 20 s at most, not as root. `FFMPEG=off` turns it off. |
| Filling the disk | Uploads are capped per file, per message and by the message rate limit; forwards copy nothing (§21.3). |
| Token theft | The token is stored in `localStorage` by the client (`pb.ts`). The CSP greatly lowers XSS risk. Moving to HttpOnly cookies is noted as future work. |
| Admin UI exposure | Strong superuser password. In production, optionally restrict `/_/` by IP using a hook. |
