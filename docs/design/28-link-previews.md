# §28. Link previews

Part of the design document: [index](../DESIGN.md).

Under a message, a line for each link in its text: the page's favicon and title, opening the link in a new tab like
the link in the text (§7.6.3).

## 28.1 Data and the worker

- **`messages.previews`**: `[{ url, title, icon }]`, in the order the links come in the text. `icon` is a `data:` URL
  ("" when there is none), so nothing is hotlinked (the CSP allows only `data:` and the app's own images) and nobody's
  browser tells a site who reads the room. Set by the server only: create and update rules refuse it in a body, the
  hooks set `[]` on create, on an edit of the text and on delete, and an edit keeps the stored ones otherwise (as for
  reactions, §20.2). A forward shows its original's (`showOriginal`), and gets saved again when they arrive, like an
  edit of its original (§21.3).
- **Queue:** a new message with links, or an edit of the text, adds a `link_queue` row in the save's transaction.
  A cron job (`* * * * *`) runs `pb_hooks/lib/previews.js` for 57 s, once a second (one run at a time, a lock in the
  app store, renewed after every message: a pass can outlast the minute, QA BUG-111; the loop and lock are
  `lib/worker.js`, shared by every worker: a run whose lock was taken over stops, and leaves the new run's lock alone); `POST /api/previews/tick`
  (superusers) runs it at once. Each message: its links (found as `linkify` finds them, each once, at most 5), fetched
  one at a time, for 12 s at most (the links after that get no line); a host that doesn't answer (a timeout, a refused
  connection) isn't asked again for that message. So a message linking to sites that never answer holds up the queue
  for ~12 s, not minutes. The previews are saved in a transaction unless the text changed meanwhile (the edit queued it
  again). Everyone sees them live, as an update. A link that fails gets no line and isn't tried again.
- **Fetching:** with `curl` (`$os.cmd`, as ffmpeg in §30.1; `$http.send` follows redirects anywhere and reads a whole
  response into memory: a page that ignored `Range` took 1.1 GB). The page with `Range: bytes=0-262143` (4 s timeout,
  redirects included), `text/html` only, its UTF-8 or Latin-1 text. Only the start of a response is read (256 KB of a
  page, 16 KB + 1 byte of an icon), from curl's output, and then curl is stopped, whatever the site sends. The page
  is read in one pass (its `<meta>`/`<link>` tags, attributes and `<title>`), never with a regex that tries again
  from every `<`: a page of unclosed tags kept the worker busy for minutes.
  The title is `og:title`, else `<title>`, entities decoded, cleaned like a name (`tidy`: no control, invisible or
  bidi characters, QA BUG-110), whitespace collapsed, at most 200 characters; no title, no line. The icon is the first `<link rel="… icon …">`, else `/favicon.ico` (3 s), an image of at most 16 KB, its
  type as served or sniffed (PNG, ICO, GIF, JPEG, SVG).
- **Where the server may go** (server-side request forgery): http(s) on the default port, a public IPv4 address or a
  name with a dot whose last label is letters and isn't a local one (`localhost`, `.local`, `.internal`, `.lan`,
  `.home.arpa`…); no userinfo, no IPv6 literals, no single-label names (Docker service names), only ASCII
  names (no IDN: `getent` wouldn't find them). A name is looked up first (`getent ahostsv4`, 3 s) and refused when any of its
  addresses isn't public; curl then connects to the address checked and no other (`--connect-to`), so a name that
  answers differently the second time can't send it inward. No proxy, no `~/.curlrc`, no URL globbing. IPv4 literals
  in plain decimal only (`0177.0.0.1` is 127.0.0.1 to curl). Redirects (at most 3) are followed by the worker, each
  checked like a link. Without `curl`, `getent` or `timeout` (looked up once), links get no previews.
- **Settings:** `LINK_PREVIEWS=off` turns it off (test servers default to off, so tests never fetch what they link
  to). `LINK_PREVIEWS_ALLOW_HOSTS` (comma-separated `host` or `host:port`) lets hosts through the checks: tests.

## 28.2 Frontend

`MSG_FIELDS` asks for `previews`. Under the text and attachments, `ul.previews`: per line an `<a>` (same `target` and
`rel` as text links, the URL as its title) with a 16 px `<img alt="">` and the title, one line cut with an ellipsis.
Only `http(s)` URLs and `data:image/` icons are shown. An edit clears them at once (optimistic), until the new ones
come.

## 28.3 Tests

- **Integration** (`previews.test.ts`, its own PocketBase with previews on, a stub site): titles (og:title first,
  entities, Latin-1) and icons (the page's, `/favicon.ico`, too big); each link once; no line for an untitled page or a
  PDF, none past the 5th link; clients can't set them; an edit replaces them and a delete clears them; a forward shows
  its original's; local and private addresses are never fetched; redirects are followed, never inward and at most 3;
  only the start of a huge page or icon that ignores `Range` is read; a page of tags that never end is quick.
- **Unit** (room view): lines with favicon and title; a `javascript:` URL and a non-`data:` icon left out; titles as
  text.
