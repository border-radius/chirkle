# Post-MVP features

Part of the design document: [index](../DESIGN.md).

Sections 15–17 extend the MVP. They follow the same principles: access control lives in API rules (with hooks as
defense in depth), no `innerHTML`, no new runtime dependencies, and the size budget (§7.7) still applies. The
implementation plan (finished) is [`history/NEXT_FEATURES_PLAN.md`](../history/NEXT_FEATURES_PLAN.md).

**Shared rules for every uploaded file (§15, §17):**

- **No SVG, no HTML from the upload pipeline into the page.** Images are shown only through PocketBase thumbnails
  (`?thumb=`), which PocketBase re-encodes as raster images. Files are never inlined, fetched as text or parsed.
- **Files are served from `/api/files/…` with a sandbox CSP.** PocketBase already sends
  `Content-Security-Policy: default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox` for files.
  The headers hook (§5.6) adds `X-Content-Type-Options: nosniff` (it already does, for every response), and an
  integration test pins both headers, so an uploaded `.html` can never run script on our origin.
- **The app CSP (§5.6) gains `blob:` in `img-src`,** for previews of files that are not uploaded yet
  (`URL.createObjectURL`). Every object URL is revoked when its message is sent, removed or unmounted.
- **Images keep fixed dimensions in the layout** (`width`/`height` attributes plus CSS), with `loading="lazy"` and
  `decoding="async"`. A late-loading image must never change the height of a message, or scroll anchoring (§7.5)
  breaks.
- **Client-side re-encoding (§15.3)** shrinks and strips metadata before upload; the server limits are the real
  enforcement.
- **At most 25 megapixels per image.** PocketBase decodes a whole image to thumbnail it, so a small, highly
  compressed file declaring huge dimensions would exhaust server memory (QA BUG-24: an 875 KB PNG of 30000×30000 took
  4.6 GB). The avatar and message create hooks read the header of every PNG, JPEG, GIF and WebP upload
  (`pb_hooks/lib/images.js`) and reject larger images, or images whose dimensions can't be found in the first
  256 KB, with `validation_image_too_large`.
