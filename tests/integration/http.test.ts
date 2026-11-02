import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, newRoom, newUser, post, status, uniq } from "./helpers.ts";

const url = (path: string) => `${inject("pbUrl")}${path}`;

describe("security and cache headers (§5.6)", () => {
  beforeAll(async () => {
    const pub = inject("pbPublicDir");
    await mkdir(join(pub, "assets"), { recursive: true });
    await writeFile(
      join(pub, "index.html"),
      '<!doctype html><title>Chirkle</title><link rel="preload" href="/assets/inter-TEST1234.woff2" as="font" type="font/woff2" crossorigin>' +
        '<link rel="stylesheet" href="/assets/app-TEST1234.css"><script type="module" src="/assets/app-TEST1234.js"></script>',
    );
    await writeFile(join(pub, "assets/app-TEST1234.js"), "console.log(1)");
    await writeFile(join(pub, "assets/inter-TEST1234.woff2"), "wOF2");
    await writeFile(join(pub, "assets/app.js"), "console.log(2)"); // unhashed, as written by npm run dev
    await writeFile(join(pub, "sw.js"), "console.log(3)");
  });

  it("GET / sends CSP, nosniff and referrer policy", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
    ]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("API responses are also nosniff", async () => {
    const res = await fetch(url("/api/health"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("the admin UI keeps PocketBase's own CSP, not the strict app CSP", async () => {
    const app = (await fetch(url("/"))).headers.get("content-security-policy");
    const admin = (await fetch(url("/_/"))).headers.get("content-security-policy");
    expect(admin).not.toBe(app);
  });

  it("hashed assets (the fonts too) are cached immutably", async () => {
    for (const path of ["/assets/app-TEST1234.js", "/assets/inter-TEST1234.woff2"]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
    }
  });

  it("unhashed assets (dev build) are not cached, so rebuilds show up on reload", async () => {
    const res = await fetch(url("/assets/app.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("a missing asset is a 404 that isn't cached, not the app's index.html cached for a year (an old build's chunk)", async () => {
    for (const path of ["/assets/viewer-GONE1234.js", "/assets/app-GONE1234.css", "/assets/nope.js", "/assets/"]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("content-type"), path).not.toMatch(/html/);
    }
  });

  it("an unknown API path is a 404, not the app's index.html; the app's pages still get it", async () => {
    const api = await fetch(url("/api/nope"));
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toMatch(/json/);
    for (const path of ["/r/abc", "/me", "/r/abc/m/def"]) {
      const res = await fetch(url(path));
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain("<title>Chirkle</title>");
    }
  });

  it("the service worker (§27) is served from the root and never cached, so a new one is found on the next load", async () => {
    const res = await fetch(url("/sw.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("a page says what it loads first (Link, for 103 Early Hints, PERF.md §5); assets and the API don't", async () => {
    for (const path of ["/", "/r/abc"]) {
      const link = (await fetch(url(path))).headers.get("link");
      expect(link, path).toBe(
        '</assets/inter-TEST1234.woff2>; rel=preload; as=font; type="font/woff2"; crossorigin, ' +
          "</assets/app-TEST1234.css>; rel=preload; as=style, </assets/app-TEST1234.js>; rel=modulepreload",
      );
    }
    for (const path of ["/assets/app-TEST1234.js", "/assets/nope.js", "/api/health", "/sw.js"]) {
      expect((await fetch(url(path))).headers.get("link"), path).toBeNull();
    }
  });

  it("index.html is never cached", async () => {
    for (const path of ["/", "/index.html"]) {
      const res = await fetch(url(path));
      expect(res.headers.get("cache-control"), path).toBe("no-cache");
    }
  });
});

describe("rate limits (§5.6)", () => {
  it("migrations enable a message-create limit of 10 per 5 seconds", () => {
    const rl = inject("bootRateLimits");
    expect(rl.enabled).toBe(true);
    expect(rl.rules).toContainEqual(expect.objectContaining({ label: "messages:create", maxRequests: 10, duration: 5 }));
    expect(rl.rules).toContainEqual(expect.objectContaining({ label: "users:create" }));
  });

  describe("when enabled", () => {
    beforeAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: true } });
    });
    afterAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: false } });
    });

    it("a burst of messages hits 429 after 10", async () => {
      const a = await newUser();
      const room = await newRoom(a);
      const codes: number[] = [];
      // 25 > 2 windows' worth, so a 429 shows up even if a window boundary falls inside the burst.
      for (let i = 0; i < 25; i++) codes.push(await status(post(a, room.id, `burst ${i}`)));
      expect(codes.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(codes).toContain(429);
    });
  });
});

describe("extra rate limits (BUG-22, BUG-23)", () => {
  it("migrations add limits for message edits/deletes and room creation", () => {
    const rules = inject("bootRateLimits").rules;
    expect(rules).toContainEqual(expect.objectContaining({ label: "messages:update", maxRequests: 20, duration: 10 }));
    expect(rules).toContainEqual(expect.objectContaining({ label: "rooms:create", maxRequests: 5, duration: 60 }));
    // the original rules are kept
    expect(rules).toContainEqual(expect.objectContaining({ label: "messages:create", maxRequests: 10, duration: 5 }));
  });

  describe("when enabled", () => {
    beforeAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: true } });
    });
    afterAll(async () => {
      const admin = await adminClient();
      await admin.settings.update({ rateLimits: { ...inject("bootRateLimits"), enabled: false } });
    });

    it("a burst of edits hits 429", async () => {
      const a = await newUser();
      const m = await post(a, (await newRoom(a)).id, "v0");
      const codes: number[] = [];
      for (let i = 0; i < 45; i++) codes.push(await status(a.pb.collection("messages").update(m.id, { text: `v${i + 1}` })));
      expect(codes.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(codes).toContain(429);
    });

    it("a burst of room creation hits 429", async () => {
      const a = await newUser();
      const codes: number[] = [];
      for (let i = 0; i < 7; i++)
        codes.push(await status(a.pb.collection("rooms").create({ name: `flood-${uniq()}`, created_by: a.user.id })));
      expect(codes).toContain(429);
    });
  });
});
