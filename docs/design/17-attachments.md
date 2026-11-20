# §17. Attachments

Part of the design document: [index](../DESIGN.md).

## 17.1 Data model

`messages` gains one field:

| Field | Type | Notes |
|---|---|---|
| `files` | file, multiple | `maxSelect` 10, `maxSize` 20 MB each (4 and 8 MB until 1760000018, raised to take a whole Telegram album, §26), **`protected: true`**, `thumbs`: `480x360` (center crop) and `240x180`. No `mimeTypes` allowlist: any file can be attached, because nothing is ever rendered from the file itself (§15 shared rules). |
| `file_names` | json | stored name → original upload name, written only by the create hook from the uploads themselves (bidi and invisible characters removed, 200 characters max); cleared by a soft delete, never changed by an edit (QA BUG-28) |

PocketBase's default request body limit is 32 MB, and it sizes a collection's record create and update by their fields:
32 MB plus each file field's and JSON field's `maxSize`. `messages.files` is JSON with `maxSize` 10 × 20 MB (§37,
QA BUG-219), so a message create takes 10 files of 20 MB, and every other route keeps about 32 MB. The limiter counts
what is read: 413 for a body declaring more, and for a chunked one (no `Content-Length`) once it goes over (QA
BUG-143). Chunked bodies are still taken: the Android app sends one when it can't tell a file's size. Tests pin all
three. No JS middleware does any of this: a `routerUse` JS handler holds a JS runtime for the whole request, realtime
connections and file downloads too (PERF.md §6).

**Text becomes optional when files are attached:** the hook rule "text is non-empty" (§5.6) changes to "text is
non-empty **or** at least one file is attached". A message with neither is still rejected.

**Files are immutable after sending.** Edits change text only: the update rule adds `@request.body.files:isset =
false`, and the update hook rejects any change to `files` (including the `files+` / `files-` modifiers) except the
soft-delete wipe below.

**Soft delete wipes the files.** When `deleted` becomes true, the hook also sets `files = []`. Each file nothing else
names any more (§37.1) is deleted, and PocketBase deletes it from storage after the update commits, so the content is really gone (§5.3), and the old URLs return 404.
PocketBase serves files with `Cache-Control: max-age=2592000`, so a browser that already loaded an attachment may
keep it in its own cache after the delete; the server copy is gone.

**Non-image files are downloads.** PocketBase serves types it doesn't consider safe to display (HTML among them)
with `Content-Disposition: attachment`, on top of the sandbox CSP, so opening one never renders it on our origin.

## 17.2 Rate limits and storage

- `messages:create` keeps its 10 per 5 s limit. Uploads are bounded by that, `maxSelect` and `maxSize`.
- Files live in `pb_data/storage` (or the S3-compatible storage configured in PocketBase's settings) and are part of
  backups, so backup sizes grow; §11 notes this.
- No per-user quota in this round (§13, still open).

## 17.3 Access control and file tokens

**Superseded by §37.3 (2026-11-04):** files are shared rows opened by URL alone, with no file token. What follows is
how it was, for servers and apps from before.

Because the field is `protected`, `GET /api/files/messages/:id/:file` requires `?token=` with a **file token**
(`pb.files.getToken()`), and PocketBase checks the **message's view rule** for the token's user. Therefore:

- DM attachments are visible only to the two members (§16.3), and public-room attachments only to logged-in users.
- A leaked URL stops working when its token expires (PocketBase's default file token lifetime is 3 minutes;
  Settings → Tokens).

**Token handling (`api.ts`, `lib/token.ts`):** `fileUrl(message, filename, thumb?)` builds URLs from a cached token.
The cache fetches a new token when the current one is older than 2 minutes, shares one in-flight request between
callers, and is dropped when the session changes. The room view waits for a token before its first render and
keeps one fresh (a check every 30 s). Links to full files re-sign their `href` on hover, focus and click, so a
click never uses a stale token. Already-rendered images keep their URLs (the browser has them). An image that is lazy-loaded later with an
expired token fails; its `error` handler asks for a fresh URL **once** and retries, then falls back to a "Couldn't
load image" box with a Retry button.

Tokens change the URL, so the browser cache can't reuse a thumbnail across token refreshes. The service worker
(§27.2) keeps thumbnails under their URL without the token instead, so switching rooms or reloading doesn't download
them again. Full files (the viewer, downloads, video and audio) still go to the server with their token.

## 17.4 Sending (optimistic, retry-safe)

The composer gains an **Attach** button ("+", opening a hidden `multiple` file input), drag-and-drop onto the room and paste
(`clipboardData.files`). Selected files show as a tray above the textarea: image thumbnails from object URLs,
other files as chips with name and size, each with a remove (×) button.

- Client checks before sending: at most 10 files, each ≤ 20 MB after preparation (§15.3, images re-encoded to at most
  2048 px). A rejected file shows why, inline, and is not added.
- Send works as in §7.5, with `FormData` instead of JSON: the client id, room, author, text and the files. The
  pending message shows the local previews dimmed, with a progress bar under them: a send with files goes through
  XHR (`pb.ts` `upload`, used when the request has an `onUpload` callback), since fetch can't report upload
  progress. The controller passes it on (`onUpload`), and the list moves the bar in place (`setUpload`), without
  re-rendering the message. The tray shows about three rows of files, then scrolls.
- **The pending entry keeps its `File` objects,** so **Retry** re-sends the same id with the same files. A duplicate
  id is still rejected by the server, so a retry after a lost response can never post twice.
- Once the server version replaces the pending one (§7.5 step 4), the object URLs are revoked.
- Leaving the room while an upload runs lets it finish (writes are not aborted, §6); a reload loses unsent files,
  like unsent text today.
- Archived rooms have no composer, so no attach button.

## 17.5 Rendering

- **Images** (by file extension: `jpg jpeg png gif webp avif`): a wrapping row under the text, uncropped, in their
  own aspect ratio. One image shows 240px high and at most 400px wide (the `800x480f` thumb); two or more show
  120px high and at most 240px wide (the `480x240f` thumb). At most 4 tiles show: with more images and videos the 4th
  says "+N" over it (N more), and the viewer (§17.7) steps through all of them. The height is fixed, so loading never shifts the list
  vertically: a too-wide image is narrowed and letterboxed rather than shortened, a very narrow one is centred in a
  tile at least half as wide as it is high, and a small one is never enlarged (`object-fit: scale-down`). A GIF's
  or a WebP's tile shows the file itself, not a thumbnail (`showsItself`): PocketBase thumbnails them from their
  first frame only, so an animated one would not play (the full file is up to the attachment limit, and loads lazily
  like the thumbnails). A still WebP is turned into JPEG (PNG if transparent) before upload (§15.3), so a WebP is mostly an animated one,
  and a still one's thumbnail would be a PNG, often bigger than the file itself (QA BUG-26). While a
  message sends it shows the local previews, at the size its thumbnails will take: the thumbnails get the previews'
  aspect ratio before they load. Only files the server will show as images (by extension) show as previews. Clicking
  opens the image viewer (§17.7); a click asking for a new tab or window (Ctrl/Cmd/Shift/middle click) opens the full
  file there instead (`target="_blank" rel="noopener"`), served under the sandbox CSP.
- **Shapes** (2026-10-28, user: "store media aspect ratio so placeholders will not change size while media is
  loading"): `messages.file_dims` maps each stored image or video name to `[width, height]` as it is shown, and a
  tile takes that aspect ratio before it loads, so it no longer starts narrow and widens (web: `aspect-ratio` on the
  thumbnail; Android: the tile's width, and a single image's whole box). Only the server sets it (create and update
  rules refuse it; an edit keeps the stored value). An image's comes from the header the create hook already reads for
  the pixel limit (`pb_hooks/lib/images.js`), with a JPEG's EXIF orientation 5–8 swapping width and height, as
  browsers and PocketBase's thumbnails show it; every upload path (the composer, collection items, Telegram, linked
  instances) goes through that hook. A video's comes from its poster (§30.1), which is in its shape: the media
  worker reads the poster's header once it is made, then marks the `media` row `sized`; files sent before this
  (`sized` false after migration `1760000037_file_dims.js`) are sized the same way, newest first, after the
  thumbnails. The worker writes the value with SQL, not a save: no hooks, no realtime event, `updated` unchanged,
  so clients see it on their next load, and until then (a video just sent, an AVIF, no ffmpeg) a tile takes its
  width once loaded, as before. A forward shows its original's (`showOriginal`); a delete clears it.
- **Videos** (by extension: `mp4 m4v webm mov ogv`): tiles like images, in the same row and at the same sizes,
  showing the video's first frame with a play badge over it. The tile is the **poster** the server makes of the video
  (§30.1: its first frame, in its own shape, at most 800×480), an `<img loading="lazy">` like an image's thumbnail, so
  the browser fetches nothing of the video until it plays. Without one (just sent, before the worker gets to it; a
  server without ffmpeg) the poster's request fails (404) and the tile becomes a `<video preload="metadata">` of the
  full file with `#t=0.001` (so every browser, Safari too, draws the first frame), fetching only enough of it to draw
  that, at once and without a new token. While sending, the local preview is the file's
  object URL (so the app CSP allows `media-src blob:`), and its aspect ratio carries over like an image's. Clicking
  plays it in the viewer (§17.7); a failed load retries once with a new token, then shows "Couldn't load video" with
  Retry (a format the browser can't play ends up there too; Ctrl/Cmd-click still gets the file).
- **Audio** (by extension: `mp3 m4a aac ogg oga opus wav flac weba`): the download chip with an
  `<audio controls preload="metadata">` of the full file next to it (as high as the chip, at most as wide as the
  message), named after the file, so it plays in the message. Its token expires (§17.3), so playing or seeking long
  after it loaded can fail: the first error after a load gets a new token, reloads the file and carries on from the
  same time (playing again if it was). Players are kept by message and file across renders (a new reaction or an edit
  re-renders the message without stopping one), and stopped once off the page (a deleted message, a message gone from
  the window, unmount): a detached `<audio>` would keep playing. While sending, audio is a plain chip.
- **Other files:** a chip with an icon, the display name and a download link (`download` attribute).
- **Display name:** PocketBase stores `quarterly_report_final_k3j2h1g0f9.pdf` for "Quarterly Report (final).pdf". The
  create hook records each upload's original name in `file_names` (§17.1), and the list shows and downloads files
  under it (`attachmentName()` in `lib/files.ts`). Messages from before that field fall back to `displayName()`,
  which strips the `_` + 10-character suffix (QA BUG-28).
- **Deleted messages** show the placeholder only (the files are gone, §17.1).
- **Edit mode** edits only the text; attachments stay visible below the textarea, without remove buttons. The text
  of a message with attachments may be emptied.
- `MSG_FIELDS` gains `files`, and the `messageNode` signature includes it.

## 17.6 Tests

- **Integration:** files-only message accepted, no text and no files rejected; a 5th file and an over-size file are
  rejected; the file URL without a token is 403/404, with A's token works, and with C's token on an A–B DM file
  is 404; responses carry the sandbox CSP and `nosniff` (an uploaded `.html` and `.svg` included); an edit cannot
  add, remove or replace files; soft delete empties `files` and the old file URL returns 404; the body limit fits
  10 × 20 MB, and other requests still get 413 over 32 MB.
- **Unit:** a video's tile is its poster, and the video's first frame when the poster fails (no new token for that);
  `displayName`; token cache (reuse, refresh after 2 min, one in-flight request); the composer tray (add,
  remove, limits, paste, drop); optimistic send with files, failure, and Retry with the same id and files; object
  URLs revoked on ack, removal and unmount; image grid layout classes for 1–4 images, and "+N" past 4; the upload
  progress bar; expired-token retry happens once.
- **E2E:** A attaches an image and a PDF and sends; B sees the thumbnail and the file chip live and can open both;
  in a DM, C can't load the file URL even when given it; deleting the message removes the attachments for B; the
  XSS smoke test (§9.3) also uploads an `.html` file and checks that opening it runs no script.

## 17.7 Image viewer

Clicking a thumbnail shows the image full size in a full-window viewer, and you can step through every image and
video in the room, oldest first: those of the room's window (§7.5) to start with, and the others fetched from the
server as you get near them.

- **What it shows:** the full file (not a thumbnail; uploads are at most 2048 px, §15.3), fitted to the window; a bar
  with the file name, who sent it and when, "*n* / *total*", **Show in chat**, **Download** (`download` attribute, re-signed before use
  like every file link, §17.3) and **Close**. Images of deleted messages and of messages still sending are left out.
  It starts with the window's images; it doesn't follow new messages. It does follow deletes (the room view passes on
  every update of the room's messages): a deleted message's images leave it, and a forward's once its original is
  deleted; the one shown gives way to the next (else the one before), and with none left the viewer closes (QA BUG-120).
- **Beyond the window:** when the image shown is within 3 of the first or last one it has, and the room has messages
  beyond the window on that side (`hasOlder`/`hasNewer`), it fetches the next page of the room's messages that have
  attachments (`withFiles` in `lib/cursor.ts`: `files=1` on the route, the usual `(created, id)` cursor from its first or
  last image), and the next while a page has none to show (only other files). Stepping past the end waits for it;
  a failed fetch is tried again by the next step. Previous/Next stay while there may be more. The count shows once the
  viewer has the whole room's images (at once in a room that fits the window), since it can't know the total before.
  The paging is in the viewer chunk; the room view passes only the page request and which files are images or videos.
- **Moving:** Previous/Next buttons on the sides (hidden at the first and last image), ←/→, Home/End, or a one-finger
  horizontal swipe (≥ 50 px, mostly horizontal; pinch-zoom still works). The neighbours are preloaded, so stepping is
  instant.
- **Show in chat:** closes the viewer and goes to the message the image or video shown is in, as a search result
  does (§29): centred and highlighted, loading the window around it if it isn't in this one. Focus goes to its tile.
- **Closing:** Close, Escape, a click on the dark space around the image, or the browser's **Back** (Android's back
  gesture too). Focus goes back to the thumbnail, or to the one drawn in its place if its message was redrawn while
  the viewer was open (a reaction, an edit). Leaving the room closes it. Keys pressed before it shows (its stylesheet
  is still loading) are still the page's.
- **Back:** opening the viewer pushes a history entry with the same URL (`history.state.viewer`, a token new on each
  page load, so an entry left from before a reload isn't taken for one). Back leaves it: `popstate` closes the viewer,
  and since the path doesn't change, the router's `popstate` handler finds the page already shown and does nothing. Closing it any other way
  goes back over the entry (`history.back()`), so Back then works as before; a viewer opened again before that Back has
  landed waits for it, or the Back would close it. Leaving the room doesn't go back (it would undo the navigation).
  An entry with no viewer open on it (Forward after Back closed the viewer, a reload while it was open, one left by
  leaving the room) would take a Back that seems to do nothing, so the router passes over it with `history.back()`
  whenever it lands on one, on start or on `popstate`.
- **Videos** step along with the images. One plays in a `<video controls>` (autoplay where the browser allows it, else
  the controls start it); stepping away or closing stops it and drops its download. Neighbouring videos aren't
  preloaded. Swipes don't start on the video (dragging its seek bar isn't a swipe) and the arrow keys are the video's
  own while it has focus. A video whose token expires mid-play (the browser fetches it in ranges) gets a new token and
  carries on from where it was.
- **Failures:** an image that doesn't load gets one retry with a new file token (an expired token is the usual cause),
  then "Couldn't load image" with Retry, like thumbnails (§17.3).
- **Accessibility:** a modal `<dialog>` (focus stays inside, the room behind is inert), named after the image shown;
  the caption is a polite live region, so stepping announces the new image; the image's alt text is its file name.
- **Look:** dark in both themes, so the image stands out.

**Loading (the main bundle stays as it was).** `views/room/viewer.ts` is a lazy chunk: the room view `import()`s it on
the first click (`app.js` grew by 0.2 KB gzipped for the click handler and the import), and it links its own
stylesheet, `viewer.css`, before it shows. Both have hashed names and a budget of their own (§7.7). It imports only
types (§7.7: a lazy module mustn't share modules with `app.js`); the DOM helper, names, dates and signed URLs come
from the room view as options. If the chunk can't be loaded (offline, or a new version was deployed and the old chunk
is gone), the image opens in a new tab as before.

An iframe with the viewer inside was considered and rejected: it is a heavier way to load code lazily (its own HTML
document, and its own copy of the session and file-token code), keyboard focus and Escape don't cross into an iframe
by themselves, and `frame-ancestors 'none'` (§5.6) would have to be relaxed.

**Not done yet:** zooming in beyond fit-to-window is the browser's pinch-zoom only.

**Tests (e2e):** the chunk and stylesheet aren't loaded before the first click; the viewer covers the window, shows the
full image, steps with the keys, the buttons and a swipe (which isn't taken for a click that closes it), the Download
link works, Escape and a click beside the image close it and focus goes back to the thumbnail; Back closes it and
stays in the room, and after Escape its history entry is gone; closing and opening again at once leaves it open;
Forward after Back and a reload while open leave no entry behind; focus finds the thumbnail after its message was
redrawn; keys pressed while its stylesheet is still loading don't step; Ctrl/Cmd-click still opens a tab. **Unit:** the build helpers (no shared chunk, the stylesheet define, budgets).
