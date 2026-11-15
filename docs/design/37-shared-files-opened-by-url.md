# §37. Shared files, opened by URL (2026-11-04)

Part of the design document: [index](../DESIGN.md).

The user asked: "can we move all files into one table and link to them everywhere? so we don't need to duplicate files
on saving to collection, etc", then "can we also drop access tokens for files?", and for the apps: "change apps to
remove token from url".

## 37.1 Data (`pb_migrations/1760000041_shared_files.js`, `pb_hooks/lib/files.js`)

- **`files`**: one row per stored file: `file` (a file field, 20 MB, not protected, the thumbnails of §17.1), `name`
  (the original name), `video`, `dims` (its shape, §17.5), `poster` (a video's poster is made), `ready` (thumbnails or
  poster made), `sized` (shape known), `refs`, `src` (where a file from before still is, §37.5), `created`. No API
  rules: only superusers list or read it.
- **`messages.files`** is JSON now: the stored names of its files, as it held as a file field, so every client builds
  the same URLs. Its `maxSize` is 10 × 20 MB: PocketBase holds a create's body to its fields' sizes, and the uploads
  come in that body.
- **`collection_items.file`** is text: a stored name too.
- **`refs`** counts the messages and items that name a file. Each save that adds or drops a name changes it in the same
  transaction (`link`, `unlink`). A file nothing names is deleted, and PocketBase deletes what is stored once that is
  committed (in the background, with S3).
- **Uploads** to `messages` are still sent as `files`. The create request hook makes the rows (`fromUploads`), with the
  checks the field made (size, an image's decodable size, the original name cleaned), and the save names them
  (`linkPending`, in its transaction). Since 2026-11-12 the rows are stored before the save's transaction, so the
  write connection isn't held for the round trips to S3 (PERF.md §12); a create refused after that drops them
  (`discard`). Items attached from
  collections (`items`, §31.2) add their rows' names: nothing is copied. Edits can't change `files` (`files+`, `files-`,
  uploads: "Attachments can't be changed.").
- **Saving to a collection** gives the item the message's stored name (`origin` = the row's id), and **Upload** makes a
  row. A message deleted, or an item taken out, unlinks its names. *Saved in* (`GET /api/chat/saved`) lists every
  collection of yours that has the file, the one an item was opened from included (before, only those holding a copy
  of it), so its menu shows that one ticked too.
- **The media worker** (§30.1) makes thumbnails, posters and shapes per `files` row, once, whoever names it. The `media`
  index keeps `file` and joins `files` for the poster.
- **Federation and Telegram** make rows from the files they receive (`attachUploads`) and send each row's stored file.

The migration makes a row for every message's file, and gives every item the row of the file it was saved from (`origin`
`m:…` or `i:…`), so copies saved before become one file. Two items of one collection that turn out to be the same file
become one. It changes only the database: the files themselves are moved afterwards, in the background (§37.5). It
reverses: the down migration copies each file back into its messages and items.

## 37.2 URLs

Unchanged: `/api/files/messages/{message}/{name}` and `/api/files/collection_items/{item}/{name}`, with `?thumb=`.
Routes of their own (`server/files.go`, in Go so a download holds no JS runtime; more specific than PocketBase's `/api/files/{collection}/…`) answer them: if the
message shows that name (its own, or a forward's original's, §21.3; not deleted) or the item has it, the `files` row's
file is served as PocketBase's handler would serve it (thumbnails of the field's sizes or 100x100, made when first
asked for; ranges; `download`; `Content-Disposition` for unsafe types). Otherwise 404, as for `/api/files/files/…`
itself (`OnFileDownloadRequest`). They go by collection name: with the collection's id (as the PocketBase SDK's
`files.getURL` builds them) a message's or an item's file is a 404 since 2026-11-09. Not a router middleware, which
would hold a JS runtime for every request (PERF.md §6, QA BUG-250).
Posters (`/api/chat/posters/{message}/{file}`, `/api/chat/posters/items/{item}/{file}`) are checked the same way.

## 37.3 Access by URL

No file token. Whoever has an attachment's URL has the file; a `?token=` is ignored. The URL can't be guessed: it holds
the message's id and the stored name's random suffix, and only those who may read the message see either. Once the
message is deleted, or the item taken out, the URL is 404 (the file may still be named elsewhere).

What changed with it: a leaked URL keeps working until the message is deleted (before, 3 minutes). Thumbnails keep one
URL, so the browser cache and the service worker (§27.2) keep them as they are, and the app no longer waits for a token
before showing a room.

**Clients.** The web builds URLs without a token (`api.fileUrl`, `api.itemUrl`); `lib/token.ts`, the token cache, the
re-signing of links and the retry with a new token are gone: an image that fails shows "Couldn't load image" with
Retry. The Android app asks a server once whether it wants tokens (`ChirkleApi.needsFileTokens`: listing `files` is a
403 here, a 404 on a server from before) and sends none to this one; it still fetches them for an older server. Apps
from before (Android 0.1.2) send tokens, which are ignored.

## 37.4 Tests

`messages.files.test.ts` (access by URL, forwards, deleted), `collections.test.ts` (one file for a message and its
items; `refs`; a race), `media.test.ts` (the worker per row; the migration down and up, merging copies),
`media.s3.test.ts` (the bucket keeps one file, gone once nothing names it), the access matrix and room access tests
(every viewer opens an attachment by URL). Android: `ChirkleApiTest` (no token here).
## 37.5 Moving the files in the background (2026-11-04)

The first deploy (chat.th61.com, on S3) showed the migration copying every file there and then: about 5 minutes for 259
messages with files, and PocketBase serves nothing until its migrations are done. The user: "migration took too long.
and app is not working while migrations is not done. we need to fix this before deploying to other instances."

- **The migration** reads and writes only the database: each row's `src` is where its file is (`{collection}/{record}/
  {name}` of the message or item it came from), and what the worker had made of it (`ready`, `poster`) comes from the
  old columns (`media`, `collection_items`). An item copy merged into its message's file is queued for deletion
  (`storage_cleanup`). The server starts in seconds.
- **Serving** (`files.serve`): a row with `src` is served from there by `fs.serve` (ranges, the headers that keep it
  from running as a page, `?download`); `?thumb=` serves the thumbnail if the old folder has it, else the file itself
  (PocketBase makes a missing one only for a file field's own files). Posters, Telegram and federation read `keyOf`,
  which is `src` until the move.
- **The media worker** moves them (`movePass`), after new uploads' thumbnails and before shapes: copy the file and its
  thumbnails folder into the row's folder, then, in a transaction, clear `src` if it hasn't changed and queue the old
  place for deletion (`cleanupPass` deletes it once that is committed, and the record's old folder once it is empty).
  A row deleted meanwhile has its copy deleted; one whose file isn't there any more just loses `src`. A file the
  migration renamed (a stored name two records had) gets its thumbnails made again. Thumbnails and shapes wait for the
  move (`src = ''`).
- **Deleting** a row not moved yet (`unlink`) queues its `src` for deletion too.
- **`1760000042_files_src.js`** adds `src` where the earlier version of the migration ran (chat.th61.com): all moved.

Tests: `media.test.ts` (served from the old place with poster, thumbnail and ranges, then moved; one missing; the
migration leaves storage untouched, a message deleted before the move), `media.s3.test.ts` (the same in a bucket).
