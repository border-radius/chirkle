# §15. Avatars

Part of the design document: [index](../DESIGN.md).

## 15.1 Data model

PocketBase's built-in `users` collection already has an `avatar` file field. A migration configures it:

| Setting | Value |
|---|---|
| `maxSelect` | 1 |
| `maxSize` | 2 MB |
| `mimeTypes` | `image/jpeg`, `image/png`, `image/webp`, `image/gif` (**not** `image/svg+xml`) |
| `thumbs` | `48x48`, `96x96` (center crop; 2× for high-DPI screens) |
| `protected` | `false`: avatars are public, and the random filename suffix PocketBase adds keeps them unguessable |

The `users` update rule already limits writes to the owner. Uploading a new file replaces the old one, and
PocketBase deletes the old file from storage. Removing the avatar is `update(id, {avatar: null})`.

## 15.2 API usage

| Action | Call |
|---|---|
| Set avatar | `users.update(me, formData{avatar: File})` |
| Remove avatar | `users.update(me, {avatar: null})` |
| Change display name | `users.update(me, {name})` (the hook already cleans names, §5.6) |
| Avatar URL | `pb.files.getURL(user, user.avatar, {thumb: "48x48"})`, built only in `api.ts` and exposed as `avatarUrl(user, size)` |

`MSG_FIELDS` gains `expand.author.avatar`, and `User` gains `avatar: string` (the filename, `""` when unset). The
logged-in user's own record already contains it.

**Staleness:** messages carry the author's avatar from when they were fetched. A user who changes their avatar is
seen with the new one on the next page load, window move or reconnect. This is accepted. Subscribing to `users`
would push every profile change to every client for little benefit.

## 15.3 Client-side image preparation (`lib/image.ts`)

Before upload, `prepareImage(file, maxEdge)` decodes the image with `createImageBitmap`, scales it so the longest
edge is at most `maxEdge` (512 px for avatars, 2048 px for attachments), and re-encodes it, PNG as PNG (keeps
transparency) and everything else as JPEG, through `OffscreenCanvas.convertToBlob`, falling back to a `<canvas>` element where
`OffscreenCanvas` is missing. Re-encoding drops EXIF, so photos never leak GPS location.

- Not WebP: PocketBase can't write WebP, so a WebP's thumbnails would be PNGs, often bigger than the image itself
  (QA BUG-26). PNG and JPEG are thumbnailed in kind.
- GIFs and animated WebPs are uploaded as they are (re-encoding would drop the animation). An animated WebP is told
  by its header: a VP8X chunk with the animation flag (`isAnimatedWebp`). Before 2026-11-19 it became a still JPEG.
- A still WebP with transparency (VP8X's alpha flag, or VP8L's alpha bit: `webpHasAlpha`) is re-encoded as PNG, as a
  PNG is: JPEG has none, and its transparent parts arrived black (QA BUG-287, 2026-11-20).
- If decoding fails, the original file is uploaded unchanged, and the server limits decide.
- The function is pure apart from the browser image APIs, and unit-testable with a stubbed `createImageBitmap`.

## 15.4 Rendering

- **Fallback:** a user without an avatar gets a circle with their initials. The initials are the first letters of
  the first two words of the name, by grapheme (`Intl.Segmenter`, so emoji and combining marks don't break), leaving
  out a word in brackets (a linked instance's or Telegram's label: "Ann (B)" is "A", QA BUG-176) and punctuation
  before a word. The
  background color is one of 8 palette colors picked by a hash of the user **id**, not the name, so it survives
  renames. Both live in `lib/avatar.ts` and are pure. Every palette color passes 4.5:1 contrast with white text in both themes.
- **Message list:** the avatar (32 px, `48x48` thumb, or `96x96` on high-DPI screens via `srcset`) sits next to
  the author header of each group (§7.5 `group`). Continuation messages get none. The image has `alt=""` because the
  author name is right next to it.
- **App bar:** the user's own avatar (24 px) next to their name. Both open `/me`.
- A failing avatar image (`error` event) swaps itself for the initials circle.
- `messageNode`'s signature cache (§7.5 DOM rendering) includes the avatar filename, so a changed avatar re-renders.

## 15.5 Profile view (`/me`)

A new route and view (`views/profile.ts`): the avatar with **Change** (file picker, also accepts drag-and-drop)
and **Remove**, plus the display name with **Save**.

- Picking a file shows a local preview right away (object URL), then uploads the prepared image. On failure the
  previous avatar comes back with the error text inline.
- Client-side checks mirror the server: type in the allowlist, size ≤ 2 MB after preparation. Limits live in
  `lib/limits.ts` with the others, and `schema.test.ts` checks they match the migration.
- On success the store's `user` is replaced with the response, so the app bar updates.

## 15.6 Tests

- **Integration:** the field settings match §15.1; an SVG or a 3 MB file is rejected; user B cannot change A's
  avatar; the thumb URL returns an image; removing the avatar deletes the file (its old URL returns 404); a message
  list includes `expand.author.avatar` and still no email.
- **Unit:** initials (one word, emoji, combining marks, empty name); color is stable for an id and differs across
  ids; `prepareImage` scaling math and GIF passthrough; profile view upload success, failure rollback and remove;
  the message group header shows the image, and initials on `error`.
- **E2E:** A uploads an avatar on `/me`; B sees it next to A's next message. Axe check on `/me`.
