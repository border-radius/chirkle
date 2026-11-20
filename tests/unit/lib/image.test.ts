import { afterEach, describe, expect, it, vi } from "vitest";
import { fitWithin, isAnimatedWebp, prepareImage, webpHasAlpha } from "../../../web/src/lib/image.ts";

describe("fitWithin (§15.3)", () => {
  it("scales the longest edge down to the limit, keeping the aspect ratio", () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3000, 4000, 512)).toEqual({ width: 384, height: 512 });
    expect(fitWithin(1000, 1000, 512)).toEqual({ width: 512, height: 512 });
  });

  it("never scales up", () => {
    expect(fitWithin(300, 200, 2048)).toEqual({ width: 300, height: 200 });
  });

  it("never returns a zero edge", () => {
    expect(fitWithin(10_000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

/** The first bytes of a WebP: an extended one (VP8X) with these flags, or a plain lossy one. */
function webpHead(flags: number | "plain"): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(32);
  const put = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) b[i + k] = s.charCodeAt(k);
  };
  put(0, "RIFF");
  put(8, "WEBP");
  put(12, flags === "plain" ? "VP8 " : "VP8X");
  if (flags !== "plain") b[20] = flags;
  return b;
}

describe("isAnimatedWebp (§15.3)", () => {
  it("reads the animation flag of an extended WebP", () => {
    expect(isAnimatedWebp(webpHead(0x02))).toBe(true);
    expect(isAnimatedWebp(webpHead(0x12))).toBe(true); // animated, with alpha
    expect(isAnimatedWebp(webpHead(0x10))).toBe(false); // alpha only
  });

  it("a plain WebP, anything else or too few bytes is not", () => {
    expect(isAnimatedWebp(webpHead("plain"))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isAnimatedWebp(new Uint8Array())).toBe(false);
  });
});

/** A lossless WebP (VP8L) header, its alpha bit set or not. */
function losslessHead(alpha: boolean): Uint8Array<ArrayBuffer> {
  const b = webpHead("plain");
  b.set(
    [..."VP8L"].map((c) => c.charCodeAt(0)),
    12,
  );
  b[20] = 0x2f;
  b[24] = alpha ? 0x10 : 0;
  return b;
}

describe("webpHasAlpha (BUG-287)", () => {
  it("reads the alpha flag of an extended WebP and the alpha bit of a lossless one", () => {
    expect(webpHasAlpha(webpHead(0x10))).toBe(true);
    expect(webpHasAlpha(webpHead(0x00))).toBe(false);
    expect(webpHasAlpha(losslessHead(true))).toBe(true);
    expect(webpHasAlpha(losslessHead(false))).toBe(false);
  });

  it("a plain lossy WebP, anything else or too few bytes has none", () => {
    expect(webpHasAlpha(webpHead("plain"))).toBe(false);
    expect(webpHasAlpha(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(webpHasAlpha(new Uint8Array())).toBe(false);
  });
});

describe("prepareImage (§15.3)", () => {
  const drawn: { width: number; height: number }[] = [];
  let encodable = new Set(["image/webp", "image/jpeg", "image/png"]);

  function stubBrowser(size = { width: 4000, height: 3000 }, decode: "ok" | "fail" = "ok") {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        if (decode === "fail") throw new Error("bad image");
        return { ...size, close };
      }),
    );
    class FakeCanvas {
      getContext() {
        return { drawImage: (_b: unknown, _x: number, _y: number, width: number, height: number) => drawn.push({ width, height }) };
      }
      async convertToBlob({ type }: { type: string }) {
        return new Blob(["x"], { type: encodable.has(type) ? type : "image/png" });
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    return { close };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    drawn.length = 0;
    encodable = new Set(["image/webp", "image/jpeg", "image/png"]);
  });

  const file = (name: string, type: string) => new File(["original"], name, { type });

  it("re-encodes JPEG as JPEG at most maxEdge px, keeping the name, and frees the bitmap", async () => {
    const { close } = stubBrowser();
    const out = await prepareImage(file("photo.jpeg", "image/jpeg"), 2048);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("photo.jpeg");
    expect(drawn).toEqual([{ width: 2048, height: 1536 }]);
    expect(close).toHaveBeenCalled();
  });

  it("BUG-26: WebP becomes JPEG, so PocketBase thumbnails it as JPEG rather than PNG", async () => {
    stubBrowser();
    const out = await prepareImage(file("pic.webp", "image/webp"), 2048);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("pic.jpg");
  });

  it("BUG-26: PNG stays PNG (transparency), also where WebP can't be encoded", async () => {
    stubBrowser();
    encodable = new Set(["image/jpeg", "image/png"]);
    const out = await prepareImage(file("shot.png", "image/png"), 512);
    expect(out.type).toBe("image/png");
    expect(out.name).toBe("shot.png");
  });

  it("BUG-287: a WebP with transparency becomes PNG, not JPEG (which would turn it black)", async () => {
    stubBrowser({ width: 512, height: 512 });
    for (const head of [webpHead(0x10), losslessHead(true)]) {
      const out = await prepareImage(new File([head], "sticker.webp", { type: "image/webp" }), 2048);
      expect(out.type).toBe("image/png");
      expect(out.name).toBe("sticker.png");
    }
    const opaque = await prepareImage(new File([losslessHead(false)], "flat.webp", { type: "image/webp" }), 2048);
    expect(opaque.type).toBe("image/jpeg");
  });

  it("uploads GIFs and non-images unchanged", async () => {
    stubBrowser();
    const gif = file("anim.gif", "image/gif");
    const pdf = file("doc.pdf", "application/pdf");
    expect(await prepareImage(gif, 512)).toBe(gif);
    expect(await prepareImage(pdf, 512)).toBe(pdf);
    expect(drawn).toEqual([]);
  });

  it("uploads an animated WebP unchanged: a canvas would keep its first frame only", async () => {
    stubBrowser();
    const anim = new File([webpHead(0x02)], "dance.webp", { type: "image/webp" });
    expect(await prepareImage(anim, 2048)).toBe(anim);
    expect(drawn).toEqual([]);
  });

  it("returns the original when decoding fails", async () => {
    stubBrowser(undefined, "fail");
    const f = file("broken.jpg", "image/jpeg");
    expect(await prepareImage(f, 512)).toBe(f);
  });

  it("returns the original when nothing usable can be encoded", async () => {
    stubBrowser();
    encodable = new Set();
    const f = file("x.webp", "image/webp");
    expect(await prepareImage(f, 512)).toBe(f);
  });
});
