// Image preparation before upload (§15.3): scale down and re-encode, which also drops EXIF (GPS location).
// Best effort: anything that can't be decoded or re-encoded is uploaded as it is, and the server limits decide.

/** Types we re-encode. GIFs, and animated WebPs (isAnimatedWebp), are left alone: re-encoding would drop the animation. */
const REENCODE = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Is `head` (a file's first bytes, at least 21) an animated WebP? An extended WebP (a VP8X chunk first) says so in its
 * flags byte. A plain WebP (VP8 or VP8L) is one frame.
 */
export function isAnimatedWebp(head: Uint8Array): boolean {
  const at = (i: number, s: string) => [...s].every((c, k) => head[i + k] === c.charCodeAt(0));
  return at(0, "RIFF") && at(8, "WEBP") && at(12, "VP8X") && ((head[20] ?? 0) & 0x02) !== 0;
}

/** Size of a `w`×`h` image scaled down (never up) so its longest edge is at most `maxEdge`. */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canvas(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  return Object.assign(document.createElement("canvas"), { width, height });
}

function encode(c: Canvas, type: string): Promise<Blob | null> {
  if ("convertToBlob" in c) return c.convertToBlob({ type, quality: 0.85 }).catch(() => null);
  return new Promise((ok) => c.toBlob(ok, type, 0.85));
}

/**
 * `file` scaled to at most `maxEdge` px and re-encoded: PNG as PNG (keeps transparency), the rest as JPEG. Both are
 * formats PocketBase thumbnails in kind; a WebP's thumbnails would be PNGs, often bigger than the image (QA BUG-26).
 */
export async function prepareImage(file: File, maxEdge: number): Promise<File> {
  if (!REENCODE.has(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap | undefined;
  try {
    // A canvas holds one frame: an animated WebP would become a still JPEG.
    if (file.type === "image/webp" && isAnimatedWebp(new Uint8Array(await file.slice(0, 32).arrayBuffer()))) return file;
    bitmap = await createImageBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const c = canvas(width, height);
    const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    // An encoder that doesn't support a type falls back to PNG: check what we actually got.
    const blob = await encode(c, type);
    if (blob?.type !== type) return file;
    const keepsName = type === "image/png" ? /\.png$/i.test(file.name) : /\.jpe?g$/i.test(file.name);
    const name = keepsName ? file.name : `${file.name.replace(/\.[^.]*$/, "") || "image"}.${type === "image/png" ? "png" : "jpg"}`;
    return new File([blob], name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
