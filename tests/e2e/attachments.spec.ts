import { deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { SUPERUSER } from "../support/sql.ts";
import { makeMp4 } from "../support/video.ts";
import { apiRoom, apiUser, attach, composer, login, message, openRoom, seed, send, test, uniq } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

const png = (name: string) => ({ name, mimeType: "image/png", buffer: Buffer.from(PNG) });
/** A w×h PNG (a horizontal gradient). */
function sizedPng(name: string, w: number, h: number) {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2], 8); // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3] = (x * 255) / w;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const buffer = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return { name, mimeType: "image/png", buffer };
}
const pdf = { name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

/** HTTP status of a URL fetched from inside the page, bypassing the HTTP cache (files are cached for 30 days). */
const statusOf = (page: Page, url: string) => page.evaluate((u) => fetch(u, { cache: "no-store" }).then((r) => r.status), url);

test("attachments: an image and a PDF go live to others, open, and disappear with the message (§17)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);

  await attach(a, [png("photo.png"), pdf]);
  await expect(a.locator(".tray-item img")).toHaveCount(1);
  await send(a, "look at this");
  await expect(a.locator(".tray-item")).toHaveCount(0);

  const theirs = message(b, "look at this");
  const tile = theirs.locator(".att-tile");
  await expect(tile).toHaveCount(1);
  // fixed height whether or not the image has loaded: loading never moves the list
  expect((await tile.boundingBox())!.height).toBe(240);
  const img = tile.locator("img");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  expect((await tile.boundingBox())!.height).toBe(240);
  // uncropped, in the image's own aspect ratio (within the 400px width cap)
  const ratio = await img.evaluate((i: HTMLImageElement) => i.naturalWidth / i.naturalHeight);
  expect((await tile.boundingBox())!.width).toBeCloseTo(Math.min(400, Math.max(120, 240 * ratio)), 0);

  const chip = theirs.locator("a.att-file");
  await expect(chip).toHaveText("notes.pdf");
  const imageUrl = (await tile.getAttribute("href"))!;
  const pdfUrl = (await chip.getAttribute("href"))!;
  expect(await statusOf(b, imageUrl)).toBe(200);
  expect(await statusOf(b, pdfUrl)).toBe(200);

  // Delete: the attachments go away for Bob, and their URLs stop working.
  const mine = message(a, "look at this");
  await mine.hover();
  await mine.getByRole("button", { name: "Delete", exact: true }).click();
  await mine.getByRole("button", { name: "Delete message" }).click();
  await expect(b.locator("li.msg.deleted")).toHaveCount(1);
  await expect(b.locator(".att-tile, .att-file")).toHaveCount(0);
  expect(await statusOf(b, pdfUrl)).toBe(404);
});

test("a GIF's tile is the file itself, so it plays: its thumbnail would be the first frame only (§17.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  await attach(a, [{ name: "dance.gif", mimeType: "image/gif", buffer: gif }, png("still.png")]);
  await send(a, "moving pictures");

  const imgs = message(a, "moving pictures").locator(".att-tile img");
  await expect(imgs).toHaveCount(2);
  await expect(imgs.nth(0)).toHaveAttribute("src", /\/dance_\w+\.gif\?token=[^&]+$/);
  await expect(imgs.nth(1)).toHaveAttribute("src", /thumb=480x240f/);
  await expect.poll(() => imgs.nth(0).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
});

test("images keep their shape: narrow ones are centred, and a sent one doesn't change width as it loads (§17.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  // Thumbnails load slowly, so the sent message shows its server tile before the image arrives.
  await a.route(/thumb=/, async (r) => {
    await new Promise((res) => setTimeout(res, 1000));
    await r.continue().catch(() => {});
  });
  await attach(a, [sizedPng("tall.png", 100, 1000)]);
  await send(a, "tall");
  const tile = message(a, "tall").locator("a.att-tile");
  await expect(tile).toHaveCount(1);
  // Not yet loaded, but already the preview's width (the 120px minimum: half the height).
  const img = tile.locator("img");
  expect(await img.evaluate((i: HTMLImageElement) => i.complete)).toBe(false);
  const box = (await tile.boundingBox())!;
  expect([box.width, box.height]).toEqual([120, 240]);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  // 24px of image, centred in its 120px tile.
  const pic = (await img.boundingBox())!;
  expect(pic.x - box.x + pic.width / 2).toBeCloseTo(60, 0);

  await attach(a, [sizedPng("wide.png", 1600, 900), sizedPng("square.png", 600, 600)]);
  await send(a, "pair");
  const widths = () =>
    message(a, "pair")
      .locator("a.att-tile")
      .evaluateAll((ts) => ts.map((t) => Math.round(t.getBoundingClientRect().width)));
  await expect(message(a, "pair").locator("a.att-tile")).toHaveCount(2);
  expect(
    await message(a, "pair")
      .locator("a.att-tile img")
      .evaluateAll((is) => is.some((i) => (i as HTMLImageElement).complete)),
  ).toBe(false);
  expect(await widths()).toEqual([213, 120]);
});

test("a DM's attachments can't be fetched by others, not even with the URL (§17.3)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const cat = await apiUser(`Cat ${tag}`);
  const page = async () => (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const a = await page();
  const c = await page();
  await login(a, ada);
  await login(c, cat);
  await a.getByRole("button", { name: "New message" }).click();
  await a.getByLabel("Find someone to message").fill(bob.name);
  await a.locator(".user-search button.person", { hasText: bob.name }).click();
  await expect(composer(a)).toHaveAttribute("placeholder", `Message ${bob.name}`);
  await attach(a, [pdf]);
  await send(a, "for your eyes only");
  const href = (await message(a, "for your eyes only").locator("a.att-file").getAttribute("href"))!;
  expect(await statusOf(a, href)).toBe(200);
  const unsigned = href.replace(/[?&]token=[^&]*/, "");
  expect([403, 404]).toContain(await statusOf(c, unsigned));
});

test("an uploaded HTML file never runs on our origin (§17, XSS)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const html = `<title>file</title><script>document.title = "pwned"; try { window.opener.__pwned = 1 } catch {}</script>`;
  await attach(a, [{ name: "evil.html", mimeType: "text/html", buffer: Buffer.from(html) }]);
  await send(a, "open me");
  const href = (await message(a, "open me").locator("a.att-file").getAttribute("href"))!;
  // Served as a download, never rendered; and sandboxed even if it were.
  const [disposition, csp] = await a.evaluate(
    (u) => fetch(u, { cache: "no-store" }).then((r) => [r.headers.get("content-disposition"), r.headers.get("content-security-policy")]),
    href,
  );
  expect(disposition).toMatch(/^attachment/);
  expect(csp).toMatch(/sandbox/);
  const tab = await a.context().newPage();
  // Chromium and Firefox start a download; WebKit's goto resolves instead. Either way nothing of it may run.
  await tab.goto(href).then(
    () => {},
    (e: Error) => expect(e.message).toMatch(/Download is starting/),
  );
  expect(await tab.title()).not.toBe("pwned");
  expect(await a.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("the image viewer: loaded on first use, steps through the room's images, closes back to the thumbnail (§17.7)", async ({
  browser,
}) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  await attach(a, [sizedPng("wide.png", 1600, 900), sizedPng("square.png", 600, 600)]);
  await send(a, "first");
  await attach(a, [sizedPng("tall.png", 100, 1000), pdf]);
  await send(a, "second");
  const tiles = a.locator("a.att-tile");
  await expect(tiles).toHaveCount(3);
  await expect(a.locator("li.msg.pending")).toHaveCount(0);

  const loaded = () => a.evaluate(() => performance.getEntriesByType("resource").some((r) => /\/viewer-[^/]*\.(js|css)$/.test(r.name)));
  expect(await loaded()).toBe(false);

  const opener = message(a, "first").locator("a.att-tile").nth(1);
  // Its stylesheet comes slowly here: keys pressed before it shows are still the page's, and don't step.
  await a.route(/\/viewer-[^/]*\.css$/, async (r) => {
    await new Promise((ok) => setTimeout(ok, 500));
    await r.continue();
  });
  await Promise.all([a.waitForRequest(/\/viewer-[^/]*\.css$/), opener.click()]);
  await a.keyboard.press("End");
  // Named after the image it shows.
  await expect(a.getByRole("dialog", { name: "square.png" })).toBeVisible();
  const viewer = a.getByRole("dialog");
  expect(await loaded()).toBe(true);
  // Its stylesheet applied: it covers the window.
  expect(await viewer.boundingBox()).toEqual({ x: 0, y: 0, width: 1100, height: 720 });
  await expect(viewer.locator(".viewer-count")).toHaveText("2 / 3");
  await expect(viewer.locator(".viewer-meta")).toContainText(ada.name);
  const img = viewer.locator(".viewer-stage img");
  // The full file, not a thumbnail.
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(600);

  await a.keyboard.press("ArrowRight");
  await expect(viewer.locator("h2")).toHaveText("tall.png");
  await expect(viewer.locator(".viewer-count")).toHaveText("3 / 3");
  await expect(viewer.getByRole("button", { name: "Next image" })).toBeHidden();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalHeight)).toBe(1000);

  await viewer.getByRole("button", { name: "Previous image" }).click();
  await a.keyboard.press("Home");
  await expect(viewer.locator("h2")).toHaveText("wide.png");
  await expect(viewer.getByRole("button", { name: "Previous image" })).toBeHidden();
  const download = viewer.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("download", "wide.png");
  expect(await statusOf(a, (await download.getAttribute("href"))!)).toBe(200);

  // A swipe (here with the mouse) steps, and isn't taken for a click on the space around the image, which closes.
  const box = (await viewer.locator(".viewer-stage").boundingBox())!;
  await a.mouse.move(box.x + 700, box.y + 40);
  await a.mouse.down();
  await a.mouse.move(box.x + 500, box.y + 45, { steps: 4 });
  await a.mouse.up();
  await expect(viewer.locator("h2")).toHaveText("square.png");
  await a.mouse.click(box.x + 20, box.y + 20);
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Back closes it, and stays in the room.
  const roomUrl = a.url();
  const viewerEntry = () => a.evaluate(() => (history.state as { viewer?: string } | null)?.viewer ?? null);
  await opener.click();
  await expect(viewer).toBeVisible();
  expect(await viewerEntry()).not.toBeNull();
  await a.evaluate(() => history.back());
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  expect(a.url()).toBe(roomUrl);
  await expect(composer(a)).toBeVisible();
  await expect(opener).toBeFocused();

  // Escape closes too, and takes its history entry with it, so Back would leave the room as before.
  await opener.click();
  await expect(viewer).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  await expect.poll(viewerEntry).toBeNull();
  expect(a.url()).toBe(roomUrl);

  // Closed and opened again at once: the first one going Back off its entry doesn't close the second.
  await opener.click();
  await expect(viewer).toBeVisible();
  await a.keyboard.press("Escape");
  await opener.click();
  await expect(viewer).toBeVisible();
  await a.waitForTimeout(300);
  await expect(viewer).toBeVisible();
  await expect.poll(viewerEntry).not.toBeNull();

  // Forward after Back closed it, or a reload while it was open, doesn't land on an entry that takes a Back that
  // seems to do nothing.
  await a.goBack();
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  await a.goForward();
  await expect.poll(viewerEntry).toBeNull();
  await opener.click();
  await expect(viewer).toBeVisible();
  await a.reload();
  await expect(composer(a)).toBeVisible();
  await expect.poll(viewerEntry).toBeNull();
  expect(a.url()).toBe(roomUrl);

  // Its message redrawn while it is open (a reaction from another tab): focus still goes back to the thumbnail.
  await opener.click();
  await expect(viewer).toBeVisible();
  const other = await a.context().newPage();
  await other.goto(roomUrl);
  const there = message(other, "first");
  await there.hover();
  await there.getByRole("button", { name: "Add reaction" }).click();
  await other.getByRole("dialog", { name: "Add reaction" }).getByRole("button", { name: "🎉" }).click();
  await expect(message(a, "first").locator(".reaction")).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await other.close();

  // Ctrl/Cmd-click still opens the image in a new tab.
  const [tab] = await Promise.all([a.context().waitForEvent("page"), opener.click({ modifiers: ["ControlOrMeta"] })]);
  await tab.waitForURL(/\/api\/files\/messages\//); // under load it can still be about:blank here
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
});

/**
 * A short 320×180 video, recorded in the page (webm, or mp4 where that is what the browser records). Playwright's
 * WebKit has no MediaRecorder: there ffmpeg makes an mp4, and without ffmpeg the test is skipped.
 */
async function recordedVideo(page: Page, base: string) {
  if (await page.evaluate(() => typeof MediaRecorder === "undefined")) {
    const mp4 = makeMp4(320, 180);
    test.skip(!mp4, "no MediaRecorder and no ffmpeg here");
    return { name: `${base}.mp4`, mimeType: "video/mp4", buffer: mp4! };
  }
  const { type, bytes } = await page.evaluate(async () => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 180 });
    const ctx = canvas.getContext("2d")!;
    const type = ["video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t))!;
    const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((ok) => (rec.onstop = ok));
    rec.start();
    for (let i = 0; i < 15; i++) {
      ctx.fillStyle = `hsl(${i * 20} 80% 50%)`;
      ctx.fillRect(0, 0, 320, 180);
      await new Promise((ok) => setTimeout(ok, 33));
    }
    rec.stop();
    await done;
    return { type, bytes: [...new Uint8Array(await new Blob(chunks).arrayBuffer())] };
  });
  return { name: `${base}.${type === "video/mp4" ? "mp4" : "webm"}`, mimeType: type, buffer: Buffer.from(bytes) };
}

test("videos: their first frame shows like an image, and a click plays them in the viewer (§17.5, §17.7)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);
  // No poster (§30.1): the tile is the video's own first frame. (Another test's worker run could make one.)
  await b.route("**/api/chat/posters/**", (r) => r.fulfill({ status: 404 }));

  const clip = await recordedVideo(a, "clip");
  await attach(a, [clip, sizedPng("photo.png", 600, 600)]);
  await expect(a.locator(".tray-item video")).toHaveCount(1);
  await send(a, "watch this");

  const theirs = message(b, "watch this");
  const tile = theirs.locator("a.att-tile:has(video)");
  await expect(tile).toHaveAccessibleName(`${clip.name}, video`);
  await expect(tile.locator(".att-play")).toBeVisible();
  const preview = tile.locator("video");
  await expect.poll(() => preview.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth)).toBe(320);
  // Two media in a row: 120px high, as wide as the video's aspect ratio makes it.
  const box = (await tile.boundingBox())!;
  expect(box.height).toBe(120);
  expect(Math.abs(box.width - (120 * 320) / 180)).toBeLessThan(2);

  await tile.click();
  await expect(b.getByRole("dialog", { name: clip.name })).toBeVisible();
  const viewer = b.getByRole("dialog");
  await expect(viewer.locator(".viewer-count")).toHaveText("1 / 2");
  const video = viewer.locator(".viewer-stage video");
  await expect(video).toBeVisible();
  await expect(viewer.locator(".viewer-stage img")).toBeHidden();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth)).toBe(320);
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);

  // Stepping to the image stops the video.
  await viewer.getByRole("button", { name: "Next image" }).click();
  await expect(viewer.locator("h2")).toHaveText("photo.png");
  await expect(video).toBeHidden();
  expect(await video.evaluate((v: HTMLVideoElement) => v.getAttribute("src"))).toBeNull();
  await b.keyboard.press("Escape");
  await expect(b.locator("dialog.viewer")).toHaveCount(0);
  await expect(tile).toBeFocused();
});

/** Run the media worker now (POST /api/media/tick, superusers): every video not done yet gets its poster. */
async function mediaTick() {
  const auth = await fetch(`${E2E_BASE}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
  });
  const { token } = (await auth.json()) as { token: string };
  const res = await fetch(`${E2E_BASE}/api/media/tick`, { method: "POST", headers: { Authorization: token } });
  expect(res.status).toBe(204);
}

test("a video with a poster shows it, and the browser fetches nothing of the video until it plays (§17.5, §30.1)", async ({ browser }) => {
  test.skip(!process.env.CI && !makeMp4(), "no ffmpeg here (CI installs it)");
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const clip = await recordedVideo(a, "poster");
  await attach(a, [clip]);
  await send(a, "with a poster");
  await expect(message(a, "with a poster").locator(".att-tile")).toHaveCount(1);
  await mediaTick();

  // Bob's page from the start, to see every request it makes.
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const b = await ctx.newPage();
  const asked: string[] = [];
  b.on("request", (r) => asked.push(new URL(r.url()).pathname));
  await login(b, bob);
  await b.goto(`/r/${room.id}`);
  const tile = message(b, "with a poster").locator("a.att-tile");
  await expect(tile).toHaveAccessibleName(`${clip.name}, video`);
  const poster = tile.locator("img");
  await expect.poll(() => poster.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(320); // never enlarged
  await expect(tile.locator("video")).toHaveCount(0);
  expect(await poster.getAttribute("src")).toMatch(/\/api\/chat\/posters\//);
  // One video: 240px high, as an image would be; 16:9 at that height is over the 400px most, so it is narrowed.
  const box = (await tile.boundingBox())!;
  expect(box.height).toBe(240);
  expect(box.width).toBe(400);
  expect(asked.filter((u) => u.startsWith("/api/files/messages/"))).toEqual([]);

  await tile.click();
  const video = b.getByRole("dialog").locator(".viewer-stage video");
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth)).toBe(320);
  await ctx.close();
});

test("the viewer steps through the whole room's images, fetching those beyond the loaded messages (§17.7)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  await attach(a, [sizedPng("old.png", 300, 200), pdf]);
  await send(a, "old pic");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  // More than a page of messages after it, so the room opens without it.
  seed(room, ada, 60, { startAt: Date.now(), stepMs: 1 });
  await attach(a, [sizedPng("new.png", 300, 200)]);
  await send(a, "new pic");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  await a.reload();
  await expect(message(a, "new pic")).toBeVisible();
  await expect(message(a, "old pic")).toHaveCount(0);

  await message(a, "new pic").locator("a.att-tile").click();
  const viewer = a.getByRole("dialog");
  await expect(viewer.locator("h2")).toHaveText("new.png");
  await a.keyboard.press("ArrowLeft");
  await expect(viewer.locator("h2")).toHaveText("old.png");
  await expect.poll(() => viewer.locator(".viewer-stage img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(300);
  // Now it knows the whole room's: the count, and no Previous at the first.
  await expect(viewer.locator(".viewer-count")).toHaveText("1 / 2");
  await expect(viewer.getByRole("button", { name: "Previous image" })).toBeHidden();
  await viewer.getByRole("button", { name: "Next image" }).click();
  await expect(viewer.locator("h2")).toHaveText("new.png");
  await expect(viewer.locator(".viewer-count")).toHaveText("2 / 2");
});

test("a message deleted while the viewer shows its image takes it out: the next one shows, none left closes it (QA BUG-120)", async ({
  browser,
}) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  await attach(a, [sizedPng("wide.png", 600, 300), sizedPng("square.png", 300, 300)]);
  await send(a, "first");
  await attach(a, [sizedPng("tall.png", 100, 400)]);
  await send(a, "second");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  const softDelete = async (text: string) => {
    const id = await message(a, text).getAttribute("data-id");
    const res = await fetch(`${E2E_BASE}/api/collections/messages/records/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: ada.token },
      body: JSON.stringify({ deleted: true }),
    });
    expect(res.status).toBe(200);
  };

  await message(a, "first").locator("a.att-tile").nth(1).click();
  const viewer = a.getByRole("dialog");
  await expect(viewer.locator("h2")).toHaveText("square.png");
  await expect(viewer.locator(".viewer-count")).toHaveText("2 / 3");
  await softDelete("first");
  await expect(viewer.locator("h2")).toHaveText("tall.png");
  await expect(viewer.locator(".viewer-count")).toHaveText("");
  await expect(viewer.getByRole("button", { name: "Previous image" })).toBeHidden();
  await expect.poll(() => viewer.locator(".viewer-stage img").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(100);
  await softDelete("second");
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  // It went Back off its own history entry: one more Back leaves the room.
  await expect.poll(() => a.evaluate(() => (history.state as { viewer?: string } | null)?.viewer ?? null)).toBeNull();
  await expect(a).toHaveURL(new RegExp(`/r/${room.id}$`));
});

test("Show in chat closes the viewer and goes to the image's message, loading it if need be (§17.7)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  await attach(a, [sizedPng("old.png", 300, 200), sizedPng("old2.png", 200, 300)]);
  await send(a, "old pic");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  seed(room, ada, 60, { startAt: Date.now(), stepMs: 1 });
  await attach(a, [sizedPng("new.png", 300, 200)]);
  await send(a, "new pic");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  await a.reload();
  await expect(message(a, "new pic")).toBeVisible();
  await expect(message(a, "old pic")).toHaveCount(0);

  await message(a, "new pic").locator("a.att-tile").click();
  const viewer = a.getByRole("dialog");
  await expect(viewer.locator("h2")).toHaveText("new.png");
  await a.keyboard.press("ArrowLeft");
  await expect(viewer.locator("h2")).toHaveText("old2.png");
  await viewer.getByRole("button", { name: "Show in chat" }).click();
  await expect(a.locator("dialog.viewer")).toHaveCount(0);
  const old = message(a, "old pic");
  await expect(old).toBeInViewport();
  await expect(old).toHaveClass(/\btarget\b/);
  // Its tile, the second image's.
  await expect(old.locator("a.att-tile").nth(1)).toBeFocused();
  // The viewer's history entry is gone: Back doesn't stay in the room with nothing to close.
  await expect.poll(() => a.evaluate(() => (history.state as { viewer?: string } | null)?.viewer ?? null)).toBeNull();
});

test("a forwarded image is the original's: its thumbnail and the viewer load it from there (§21.3)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const from = await apiRoom(ada);
  const to = await apiRoom(ada);
  const a = await openRoom(browser, ada, from);
  await attach(a, [sizedPng("square.png", 600, 600)]);
  await send(a, "look");
  await expect(a.locator("li.msg.pending")).toHaveCount(0);
  const original = await message(a, "look").getAttribute("data-id");

  await message(a, "look").hover();
  await message(a, "look").getByRole("button", { name: "Forward" }).click();
  const dialog = a.getByRole("dialog", { name: "Forward message" });
  await dialog.getByRole("searchbox", { name: "Search rooms and people" }).fill(to.name);
  await dialog.getByRole("button", { name: `# ${to.name}` }).click();
  await expect(a.locator("header.room-header h1")).toHaveText(`#${to.name}`);
  const forwarded = message(a, "look");
  await expect(forwarded).toContainText("Forwarded from Ada");
  expect(await forwarded.getAttribute("data-id")).not.toBe(original);

  const thumb = forwarded.locator("a.att-tile img");
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  expect(await thumb.getAttribute("src")).toContain(`/api/files/messages/${original}/`);
  await forwarded.locator("a.att-tile").click();
  const img = a.getByRole("dialog", { name: "square.png" }).locator(".viewer-stage img");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(600);
});

/** Half a second of silence as an 8 kHz, 8-bit mono WAV. */
function wav(name: string) {
  const n = 4000;
  const b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(n, 40);
  return { name, mimeType: "audio/wav", buffer: b };
}

test("attachments: audio plays in the message, and a reaction doesn't stop it (§17.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  const b = await openRoom(browser, bob, room);
  await attach(a, [wav("Voice memo.wav")]);
  await send(a, "have a listen");

  const theirs = message(b, "have a listen");
  const player = theirs.locator("audio");
  await expect(player).toHaveAttribute("controls", "");
  await expect(player).toHaveAccessibleName("Voice memo.wav");
  await expect(theirs.locator("a.att-file")).toHaveAttribute("download", "Voice memo.wav");
  // The signed URL loads in the browser: it knows how long the file is.
  await expect.poll(() => player.evaluate((el: HTMLAudioElement) => el.duration)).toBeCloseTo(0.5, 1);
  await player.evaluate((el: HTMLAudioElement) => {
    el.loop = true;
    return el.play();
  });
  // Ada reacts: Bob’s copy of the message is drawn again, live.
  const mine = message(a, "have a listen");
  await mine.hover();
  await mine.getByRole("button", { name: "Add reaction" }).click();
  await a.getByRole("dialog", { name: "Add reaction" }).getByRole("button", { name: "🎉" }).click();
  await expect(theirs.getByRole("button", { name: "🎉 1 reaction" })).toBeVisible();
  expect(await player.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  await a.close();
  await b.close();
});
