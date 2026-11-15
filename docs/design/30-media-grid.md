# §30. Media grid

Part of the design document: [index](../DESIGN.md).

A button (🖼️, "Media") in the header of every room and DM, next to search (§29), opens a modal dialog with the
room's images and videos as a grid of square tiles, **newest first** under month headings ("October 2026"), so one
sent long ago is quick to find without scrolling the history. Scrolling to the end fetches older ones (60 tiles a
page). A tile opens the viewer (§17.7) over the grid, stepping through the grid's images and videos (oldest first, as
the viewer always does) and fetching older ones as it nears them; closing the viewer comes back to the grid with focus
on the tile. "Show in chat" in the viewer closes both and goes to the message, as from a thumbnail in the list.
Escape or × closes the grid and gives focus back to the button. Guests can open it in the Open Air rooms they read.

## 30.1 Data

- **Index:** the `media` collection (migration `1760000029_media.js`, no API rules), one row per image or video a
  room shows: `room`, `message` (the one in the room), `source` (whose file it is: the message, or a forward's
  original, §21.3), `file`, `pos` (its place in the source's files), `video`, `sent` (the message's `created`),
  `ready` and `poster` (below). The messages hooks keep it (`pb_hooks/lib/media.js`): a new message adds its rows in the
  save's transaction, a delete takes out its rows and its forwards', and the relations cascade when a message or room
  goes for good. Image and video are by extension, as in `lib/files.ts`. The migration fills it from the messages there
  are. Before it the grid paged through the room's messages (`withFiles`, 50 at a time, with the list rule, expands and
  the enrich hook), for a few tiles a page.
- **Page:** `GET /api/chat/media/{room}?sent=&message=&pos=&limit=` (`api.media`): rows older than the last one shown
  (or the newest), newest first, a message's files last to first, 60 a page (at most 100), with the file's original name
  and the author's id and name, and `more`. The room is checked once (`visibleRoom`, §23: guests in Open Air rooms);
  404 for a room you can't see. One query on the index `(room, sent, message, pos)`.
- **Thumbnails:** a `240x240` thumb (cropped to the square, centred), added to `messages.files` by migration
  `1760000028_media_grid_thumbs.js`; the fitted thumbs of §17.5 would be blurry once cropped. A tile that fails to load
  tries once more with a new file token.
- **The worker** (`lib/media.js`, a cron job like the previews' (§28.1): 57 s a minute, one run at a time;
  `POST /api/media/tick` for superusers runs it at once; `MEDIA_CRON=off` leaves it to that, as tests do): takes the
  rows not `ready`, newest first (so a new upload goes before the migration's backlog), and makes what they need before
  anyone asks. PocketBase makes a thumbnail on its first request, so a grid opened over old images had the server
  decode and resize dozens at once. An image gets the grid's thumb, and for a message from the last 7 days the room's
  too (a GIF only the grid's: the room shows the file, §17.5); avif none (PocketBase serves it as it is). A video gets a
  **poster**: its first frame, fitted in 800×480 in its own shape and never enlarged (the room's large tile, §17.5),
  JPEG, from `ffmpeg` (`FFMPEG`: the command, default `ffmpeg`;
  `off`, or not installed: no posters), stored as `thumbs_{file}/poster.jpg` next to the file, so PocketBase deletes
  it with the file; then the source's rows and its forwards' say `poster`. ffmpeg reads only the local file
  (`-protocol_whitelist file`, the container's own demuxer forced by extension, so a "video" that is a playlist reads
  nothing else), on one thread, stopped after 20 s (`timeout`). A video kept in S3 has no local path: it is copied to the temp folder first (Go copies it,
  never through JS) and the copy removed after, so each video is downloaded once. Each file is tried
  once. After each one the worker rests as long as it worked: at most half of one CPU.
- **Posters:** `GET /api/chat/posters/{message}/{file}?token=`, the URL of the video with its token on another route.
  Checked as PocketBase checks the file (§17.3): the file token's user against the message's view rule; 404 otherwise,
  and until the poster is made. `Cache-Control: private, max-age=2592000`; the service worker keeps them like
  thumbnails (§27.2).
- Not live: what is posted while the grid is open shows the next time it opens.

## 30.2 Frontend

`views/room/media.ts` is a lazy chunk like search: imported on the first click, types only; the room view passes it
`api`, `h`, the file-name helpers and `viewImage` (which takes the grid's list, its "more before" flag and a callback
that closes the grid). It links `styles/media.css` (hashed, its URL in the `MEDIA_CSS` define) and opens once that has
loaded, like the viewer; if the chunk can't load, the notice says "Couldn't open media. Check your connection.". The
dialog follows the theme (unlike the viewer) and fills the window on narrow screens. Like the viewer it adds a history
entry with the same URL: Back closes it (and from the viewer over it, closes just the viewer); closing it from itself
goes Back off its entry, and after "Show in chat" waits for the viewer's own Back first. An entry with no grid open on
it (a reload while it was open, Forward after Back closed it) is passed over by the router, as the viewer's is (QA
BUG-118). The viewer gets messages made from the rows (id, room, author, `created`, the file names, `forward_of` for a
forward's), which is all it and "Show in chat" use. A video's tile is its poster (cropped to the square by
`object-fit: cover`, like the images' `240x240`), or until there is one a plain tile, with the room's round play badge
(`.att-play`, a drawn triangle, not "▶": QA BUG-242) in the middle of either: never the video, which every browser would start fetching (`preload="metadata"`); a poster that
fails twice leaves the plain tile. A tile is a button named "file name[, video], author, date". The status line says "Loading…", "No photos or
videos here yet." or "Couldn't load media." with Retry; until Retry, the end of the grid doesn't ask again (QA BUG-116). A message deleted while the grid is open, or a forward whose original was, takes its tiles
with it (the room view's events, as the viewer's; QA BUG-244).

## 30.3 Tests

- **Integration** (`media.test.ts`): the page (media only, newest first, files last to first, paging by the cursor);
  a forward's tiles, and none once the original is deleted; 404 for outsiders of a private room and for guests outside
  Open Air; the query plan uses the index with no sort; the worker's thumbnails (all for a recent message, the grid's
  for an old one); a poster made with ffmpeg (skipped without it, except in CI, which installs it), served with the
  file token to those who may see the video, a forward's readers too, in the video's shape and not enlarged, and gone
  with the file; no poster for an image
  or another message's file; the migration's backfill (media only, a forward's from its original, none of deleted ones).
  `media.s3.test.ts`, its own PocketBase on an S3 server (versitygw serving a temp folder, `tests/support/s3.ts`;
  skipped without it or ffmpeg, except in CI): the poster and thumbnails land in the bucket, no temp copy is left, the
  poster is served, and it goes with the file.
- **Unit** (`views/room/media.test.ts`): newest first, a message's files in reverse, month headings across pages, the
  next page at the end, no more after the last; a video's poster or plain tile, never a `<video>`; the empty state;
  Retry; Escape and focus; one grid at a time.
- **E2E** (`media.spec.ts`): images 120 messages back, opened in the viewer ("2 / 3"), Escape and Back back to the
  grid, "Show in chat" loads the message and leaves no history entry; Back and Escape close the grid; axe: no serious
  violations; an empty room says so.
