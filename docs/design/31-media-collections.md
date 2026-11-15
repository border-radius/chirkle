# §31. Media collections

Part of the design document: [index](../DESIGN.md).

A user keeps images and videos in **collections** of their own, public or private. Any image or video of the chat can
be saved to one (the collections icon on a tile, or in the viewer), and anything in a collection can be attached to a
message. Others can **subscribe** to a public collection, use what is in it, and see what has been added since they
last looked. Collections are listed in the sidebar. Decisions: §13 (2026-10-21).

## 31.1 Data (`pb_migrations/1760000030_collections.js`)

- **`collections`:** `owner` (cascade with the user), `name` (1–60 characters, unique among the owner's whatever the
  case: `name_key`, hidden, as `nameKey()` folds it), `public`, `items` and `last_added` (kept by the routes below).
  Rules: list and view `public = true || owner = @request.auth.id` (guests see public ones); create with yourself as
  `owner`, update and delete by the owner, never `owner`, `items`, `last_added` or `name_key` from a request body. The
  hooks (`lib/collections.js`) clean the name and refuse a 51st collection.
- **`collection_items`:** `collection` (cascade), `file` (one, **protected**, 20 MB, the thumbs of `messages.files`),
  `name` (the original file name), `video`, `poster`, `ready` and `origin` (hidden: which message file, `m:<id>/<file>`,
  or item, `i:<id>`, it was copied from), `created`. Unique `(collection, origin)`: a file is in a collection once,
  however it came. Rules: list and view `collection.public = true || collection.owner = @request.auth.id`, which is
  also what a file token is checked against (§17.3); no writes but the routes'. At most 2,000 per collection.
- **`collection_subs`:** `user`, `collection` (both cascade), `seen_at`. Unique `(user, collection)`. Rules: your own
  rows only, written by the routes (as `room_reads`, §18.1). At most 200 per user.
- **`messages.file_sources`:** stored file name → the collection that file was attached from. Set only by the create
  hook (the rules refuse it in a body, `beforeMessageCreateRequest` backs that up); never changed by an edit; emptied
  with the files by a delete; a forward shows its original's (`showOriginal`, §21.3).
- Rate limits: `collections:create` 10 per 60 s, `POST /api/chat/items` 30 per 60 s, `POST /api/chat/subs` 60 per 60 s.

**Saving copies the file** (and attaching copies it again, into the message). A collection item doesn't point at the
message: its file would follow the message's room rules (a subscriber couldn't see a file saved from a DM) and its
lifetime (a delete wipes it, §17.1). So an item outlives the message it came from, and a message outlives the item
and the collection it was attached from: the media grid, the viewer, forwards and the Telegram bridge see an ordinary
file. The copy is Go's. A save copies the stored file straight into the new item's folder (`fs.copy`; in S3 that is
CopyObject, so the bucket copies it and PocketBase neither downloads nor uploads it) and saves the item without
PocketBase's validation, which takes only uploads as a new record's files (every field is the route's own); a save
that loses the race to the unique index removes its copy. An attach adds uploads to the message being created:
PocketBase reads the stored file from its path (`$filesystem.fileFromPath`), or, kept in S3, from a copy in the temp
folder (`media.js` `tempCopy`), removed once the save is done. A video's poster comes along
when the file it was saved from has one; otherwise the media worker (§30.1) makes the item's grid thumbnail or poster.

## 31.2 Routes (`pb_hooks/lib/collections.js`)

- **`GET /api/chat/collections`** → `{ mine, subs }` by name: yours, and the public ones you follow with their owner,
  `seen_at` and `new` (items added after `seen_at`, at most 100, one range scan each on `(collection, created)`); each
  with `preview`, its newest four items (`id`, `file`, `video`, `poster`) for its tile in the Android room list.
  One that turned private is left out but its row kept: public again, it is back.
- **`POST /api/chat/items`** `{ collection, message, file }` or `{ collection, item }` → the item. Yours only (403
  for someone else's you can see, 404 for one you can't); a message file you can see by the messages **view** rule (a
  forward's reader saves its original's, §21.3), not deleted, an image or video; or an item you can see. 409 when it
  is in there already. As multipart `{ collection, file }`: an image or video of your own (20 MB at most) uploaded
  straight into a collection of yours, a new item with no `origin` (two uploads of one file are two items); an image
  over 25 megapixels is refused as an attachment is (QA BUG-140), and its name cleaned as one's (QA BUG-149).
  `DELETE /api/chat/items/{id}`: the owner takes one out.
- **`GET /api/chat/saved?message=&file=`** (or `?item=`) → `{ collection: item }`: which of your collections have it.
  `{}` for an item that isn't there or that you can't see (QA BUG-148).
- **Attaching:** a message create may name items (`items`, their ids: a JSON list in a form). They must be yours or in
  a public collection; their files are added after the uploads (10 in all), copied, with their names in `file_names`
  and their collections in `file_sources`.
- **`GET /api/chat/badges?ids=`** → per id `{ name, public, mine }` for a public collection or your own, `{ private:
  true }` for someone else's private one, `null` for one that is gone. Guests too.
- **Realtime topic `chat/badges`:** once a collection is saved public or private, renamed, or deleted, every client
  listening (guests too) gets `{ id }`, after the save is committed (`onRecordAfterUpdateSuccess`/`DeleteSuccess`), so
  asking `/badges` at once reads the new state. Only the id: what each may see, `/badges` says. The collection's own
  record events wouldn't do: PocketBase sends a change only to those who can see the result.
- **`POST /api/chat/subs`** `{ collection, on }`: follow someone else's public collection (seen up to now), or stop.
  **`POST /api/chat/subs/seen`** `{ collection, at? }`: as `/reads` (§18.2), forward only, never past now.
- **`GET /api/chat/posters/items/{item}/{file}`**: an item's video poster, checked like the file (§30.1).
- A collection turning private (or public again) saves its subscribers' rows again, so they hear of it live.

## 31.3 Client

- **The icon:** a picture with another behind it, drawn by CSS (`.ci`, a mask of an inline SVG, so it takes the text
  color; `ui/icon.ts`). Every collection button is the icon alone, named for screen readers: Save to collection (on
  a tile, top right, shown on hover and focus, always on touch screens; in the viewer's bar), Attach from collections
  (in the composer, next to +), and the sidebar rows.
- **State:** `collections.ts`, started with the session like `unread.ts`, keeps `AppState.collections`. It refetches
  (debounced 250 ms) on a change of any of yours or those you follow (one realtime subscription on `collections`,
  filtered to those ids, renewed when they change: a public collection's changes never reach everyone) and of your
  `collection_subs` rows, and on reconnect.
- **Sidebar:** a Collections section after Direct messages: yours (🔒 when private), then those you follow with their
  owner's name and a badge of new items (`99+`, " new" for screen readers). "+" opens the new-collection dialog.
- **The page, `/c/:id`:** in the room pane, the sidebar kept. Its name, whose it is, Public or Private and how many
  items; the owner can upload images and videos into it (Upload, several at once, dropped on the page or pasted: one at a
  time with the percentage sent, what isn't an image or video or is over 20 MB named and left out, a rate limit
  waited out), rename it, make it public or private and delete it (confirmed); others Subscribe or
  Unsubscribe. The items as square tiles, newest first under month headings, 60 at a time (the records API, cursor
  on `(created, id)`). Items added since your `seen_at` have a ring and a dot, and "*n* new since your last visit" says
  how many; once they are on screen in a visible tab the page sends `seen` with the newest item's `created`, and the
  badge goes. A tile opens the viewer (§17.7, without "Show in chat"); the owner can remove one, anyone signed in save
  one to their own collections. The page follows the store for a collection of yours or one you follow: what is added
  meanwhile comes in at the top, marked new and seen at once (no badge for the page you are on); a rename or a change
  of Public shows; made private or deleted, it says it doesn't exist. Narrow screens get the back arrow (as a room, §7.8).
- **Saving** opens a menu of your collections, ticked where the file is already (`/saved`): tick to add, untick to
  take out, or make a new (private) one there. Public ones say so: a file saved from a private room or a DM into a
  public collection is then anyone's to see (§13).
- **Attaching:** the picker lists your collections and those you follow, a row of chips over the grid (the first one
  chosen, as the app's); pick up to what the message still takes and they join the tray (after the uploads, as the
  server attaches them), "From a collection". The pending message shows their thumbnails; Retry sends the same ids.
- **The badge:** a file with a `file_sources` entry gets a chip over its tile, bottom left: the icon and the
  collection's name, a link to it, if it is public or yours (yours private: 🔒 after the name); "Private collection",
  not a link, if it is someone else's private one; nothing if it is gone. The room view asks `/badges` once for the ids
  a render shows that it hasn't asked about, and draws again when the answer comes (a message's signature includes
  its badges). Made public or private, renamed or deleted meanwhile, a badge follows live: the room listens to
  `chat/badges` once it shows one and asks again about the ids it shows (the old badge stays until the answer), and
  about all of them after a reconnect.
- **Loading:** `views/collection/lazy.ts` (the page, the save menu, the picker and the new-collection dialog:
  `page.ts`, `save.ts`, `picker.ts`, `create.ts`, with their requests in `calls.ts`, through `api.request`) is a lazy chunk with its own stylesheet, `styles/collections.css`
  (`COLLECTIONS_CSS`), imported on first use by `views/collection.ts`. In `app.js`: the service, the sidebar section,
  the badge and Save on tiles, the composer button and the route.
- Guests read public collections and see badges, but can't save, subscribe or attach.

## 31.4 Tests

- **Integration** (`collections.test.ts`): names unique per owner whatever the case; counters, owner and limits kept
  by the server; who sees which collection and item file (owner, others, guests; public and private); saving (a copy
  that outlives the message, the original name, 409 twice, only media, not deleted, only what you can see, a
  forward's original, copying an item, saved at once: one copy kept); uploading (yours only, media only, 20 MB, its
  thumbnail, then saved and attached as any item); `/saved`; removing; attaching (after uploads, names, `file_sources`, the room's
  rules for the copy, JSON and form bodies, forwards, only yours or public, no `file_sources` from a client, 10 at
  most, cleared by a delete); badges, and `chat/badges` (made public or private, renamed, deleted: the id, the new
  state readable at once; nothing for other saves); subscriptions (not your own, not private, new counts, seen, unsubscribe; turned
  private: hidden and told live); the count's query plan; item thumbnails and posters (copied along, or made by
  ffmpeg, served by the item's rules). `media.s3.test.ts`: saving a video and attaching it back with S3, poster
  included, no temp copy left.
- **E2E** (`collections.spec.ts`): make one from the sidebar, save from a tile, its page; another user subscribes,
  sees "1 new" live, opens it with the new item highlighted and the badge gone; attaches it from the picker and the
  message's badge links to it; made private, the badge says "Private collection" (not a link) to others and still
  names it to the owner, live; public again and renamed, both badges follow without a reload; axe on the page. Saving and unsaving from the viewer. Uploading with the button (a PDF
  refused by name) and by dropping; no Upload on someone else's.
