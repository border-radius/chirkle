// Web client profile (docs/PERF.md §4): a throwaway server (as the tests start one) with a busy room and many quiet
// ones, the built client (pb_public, `npm run build` first) in Chromium with its CPU slowed down and the network
// delayed, and timings of what people do most.
//
//   node --no-warnings scripts/profile-web.ts [--cpu=4] [--latency=80] [--out=run.json] [--check]
//
// Scenarios: a cold load straight into the busy room, a reload (warm: HTTP cache, service worker, IndexedDB), room
// switches (first visits; back and forth between the last few rooms; first visits with the pointer resting on the
// link first), 8 s of scrolling up through history, and a burst of 60 incoming messages. Times are from the page's own
// clock: until the room list / the messages are in the DOM, and the frame after a switch shows the room. --out keeps the
// numbers as JSON, to compare a change against the run before it. --check fails (exit 1) on numbers far over CHECKS:
// loose enough for a CI runner, meant to catch a change that makes something several times slower, not to measure.

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import "../tests/support/eventsource.ts";
import { disableRateLimits, startPocketBase } from "../tests/support/pocketbase.ts";
import { runSql, type SqlStatement } from "../tests/support/sql.ts";
import { type Api, createApi } from "../web/src/api.ts";
import { newId } from "../web/src/lib/id.ts";
import { toPb } from "../web/src/lib/time.ts";
import { createClient } from "../web/src/pb.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const CPU = Number(arg("cpu", "4"));
const LATENCY = Number(arg("latency", "80"));
const OUT = arg("out", "");
const CHECK = process.argv.includes("--check");
const ROOMS = 150;
const BUSY = 3000;
const PER_ROOM = 20;
const USERS = 25;
/** Upper limits for --check, in ms, at --cpu=4 (results.* names). */
const CHECKS: Record<string, number> = {
  coldMessagesMs: 6000,
  warmMessagesMs: 4000,
  switchFirstP50Ms: 1500,
  switchKeptP50Ms: 600,
  scrollFrameP95Ms: 600,
};

const WORDS =
  "the a we should meet tomorrow at office about plan release notes design review lunch coffee photos trip budget deadline weekend train hotel ok sure thanks great idea later maybe".split(
    " ",
  );
const text = (i: number) => Array.from({ length: 4 + ((i * 7) % 30) }, (_, k) => WORDS[(i * 13 + k * 5) % WORDS.length]).join(" ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

const pb = await startPocketBase({
  fixtureRoute: true,
  publicDir: join(import.meta.dirname, "../pb_public"),
  env: { MEDIA_CRON: "off", LINK_PREVIEWS: "off" },
});
const results: Record<string, number> = {};
const browser = await chromium.launch();
try {
  await disableRateLimits(pb.url);
  const api = () => createApi(createClient(pb.url));
  const others: { a: Api; id: string }[] = [];
  for (let i = 0; i < USERS; i++) {
    const a = api();
    const u = await a.signUp({ email: `u${i}@profile.local`, password: "password-123", name: `Person ${i}` });
    others.push({ a, id: u.id });
  }
  const me = api();
  await me.signUp({ email: "me@profile.local", password: "password-123", name: "Me" });
  const rooms: string[] = [];
  for (let i = 0; i < ROOMS; i++) rooms.push((await me.createRoom(`room ${i} ${WORDS[i % WORDS.length]}`, "public")).id);
  const busy = rooms[0]!;
  // Messages straight into the database: thousands through the API would take minutes.
  const start = Date.now() - 5 * 24 * 3600_000;
  const stmts: SqlStatement[] = [];
  const add = (room: string, i: number, ts: number) =>
    stmts.push({
      sql: "INSERT INTO messages (id, room, author, text, text_key, edited_at, deleted, deleted_at, created, updated) VALUES ({:id}, {:room}, {:author}, {:text}, {:key}, '', 0, '', {:ts}, {:ts})",
      params: { id: newId(), room, author: others[(i * 7) % USERS]!.id, text: text(i), key: text(i), ts: toPb(ts) },
    });
  for (let i = 0; i < BUSY; i++) add(busy, i, start + i * 60_000);
  for (let r = 1; r < ROOMS; r++) for (let i = 0; i < PER_ROOM; i++) add(rooms[r]!, r * 100 + i, start + (r * PER_ROOM + i) * 30_000);
  for (let i = 0; i < stmts.length; i += 2000) await runSql(pb.url, stmts.slice(i, i + 2000));
  // The busy room's tail through the API: reactions and replies, as people make them.
  for (let i = 0; i < 30; i++) {
    const o = others[i % USERS]!.a;
    const m = await o.send({ id: newId(), room: busy, text: `lately ${text(i)}` });
    if (i % 3 === 0) await others[(i + 1) % USERS]!.a.react(m.id, "👍", true);
    if (i % 4 === 1) await o.send({ id: newId(), room: busy, text: `reply ${i}`, replyTo: m.id });
  }

  // When the room list and the messages first show, by the page's clock.
  const init = () => {
    const w = window as unknown as { __shown: Record<string, number> };
    const shown: Record<string, number> = {};
    w.__shown = shown;
    const mo = new MutationObserver(() => {
      if (!shown.rooms && document.querySelector('.rooms a[href^="/r/"]')) shown.rooms = performance.now();
      if (!shown.messages && document.querySelector("ol.messages li[data-id]")) shown.messages = performance.now();
    });
    document.addEventListener("DOMContentLoaded", () => mo.observe(document.body, { childList: true, subtree: true }));
  };

  const login = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const lp = await login.newPage();
  await lp.goto(`${pb.url}/login`);
  await lp.getByLabel("Email").fill("me@profile.local");
  await lp.getByLabel("Password").fill("password-123");
  await lp.getByRole("button", { name: "Log in" }).click();
  await lp.waitForSelector('.rooms a[href^="/r/"]');
  const storageState = await login.storageState();
  await login.close();

  const ctx = await browser.newContext({ storageState, viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY,
    downloadThroughput: 1_310_720,
    uploadThroughput: 655_360,
  });
  const shown = () => page.evaluate(() => (window as unknown as { __shown: Record<string, number> }).__shown);

  // Cold, then warm.
  await page.goto(`${pb.url}/r/${busy}`);
  await page.waitForSelector("ol.messages li[data-id]");
  const cold = await shown();
  results.coldRoomsMs = Math.round(cold.rooms ?? 0);
  results.coldMessagesMs = Math.round(cold.messages ?? 0);
  await sleep(4000); // prefetching, the service worker installing
  await page.reload();
  await page.waitForSelector("ol.messages li[data-id]");
  const warm = await shown();
  results.warmRoomsMs = Math.round(warm.rooms ?? 0);
  results.warmMessagesMs = Math.round(warm.messages ?? 0);
  await sleep(3000);

  results.switchFirstP50Ms = median(await switches(page, rooms.slice(60, 75)));
  for (const id of rooms.slice(80, 83)) await switchTo(page, id);
  results.switchKeptP50Ms = median(
    await switches(
      page,
      [81, 80, 82, 81, 80, 82, 81, 80, 82, 81].map((i) => rooms[i]!),
    ),
  );
  results.switchHoveredP50Ms = median(await switches(page, rooms.slice(90, 100), true));

  await switchTo(page, busy);
  await sleep(500);
  const scroll = await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>("ol.messages")!;
    const frames: number[] = [];
    let last = performance.now();
    const t0 = last;
    while (performance.now() - t0 < 8000) {
      list.scrollBy(0, -120);
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    frames.sort((a, b) => a - b);
    return { p50: frames[frames.length >> 1]!, p95: frames[Math.floor(frames.length * 0.95)]! };
  });
  results.scrollFrameP50Ms = Math.round(scroll.p50);
  results.scrollFrameP95Ms = Math.round(scroll.p95);

  // A burst at the live bottom: how long the page is busy for it.
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>("ol.messages")!;
    list.scrollTop = list.scrollHeight;
    const w = window as unknown as { __busy: number };
    w.__busy = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__busy += e.duration;
    }).observe({ type: "longtask" });
  });
  await sleep(1500);
  for (let i = 0; i < 60; i++) {
    void others[i % USERS]!.a.send({ id: newId(), room: busy, text: `burst ${text(i)}` });
    await sleep(30);
  }
  await sleep(3000);
  results.burstLongTasksMs = Math.round(await page.evaluate(() => (window as unknown as { __busy: number }).__busy));
  await Promise.all(others.map((o) => o.a.unsubscribeAll().catch(() => {})));
} finally {
  await browser.close();
  await pb.stop();
}

/** Click room `id`'s link; ms until the frame after its messages show. */
async function switchTo(page: Page, id: string): Promise<number> {
  return page.evaluate(async (id) => {
    const a = document.querySelector<HTMLAnchorElement>(`.rooms a[href="/r/${id}"]`)!;
    a.scrollIntoView();
    const t0 = performance.now();
    a.click();
    const list = () => document.querySelector("ol.messages");
    const done = () =>
      location.pathname === `/r/${id}` && list()?.querySelector("li[data-id]") && list()?.getAttribute("aria-busy") !== "true";
    while (!done()) await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    return Math.round(performance.now() - t0);
  }, id);
}

/** Each room in turn; with `hover`, the pointer rests on its link a moment first (as when reading the name). */
async function switches(page: Page, ids: string[], hover = false): Promise<number[]> {
  const out: number[] = [];
  for (const id of ids) {
    const link = `.rooms a[href="/r/${id}"]`;
    if (hover) {
      await page.evaluate((link) => document.querySelector(link)!.scrollIntoView(), link);
      await page.hover(link);
      await sleep(250);
    }
    out.push(await switchTo(page, id));
    await sleep(300);
  }
  return out;
}

const width = Math.max(...Object.keys(results).map((k) => k.length));
for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(width)}  ${v}${CHECKS[k] ? `  (≤ ${CHECKS[k]})` : ""}`);
if (OUT) await writeFile(OUT, `${JSON.stringify({ cpu: CPU, latency: LATENCY, ...results }, null, 2)}\n`);
const over = Object.entries(CHECKS).filter(([k, max]) => !(results[k]! <= max));
if (CHECK && over.length) {
  console.error(`over the limit: ${over.map(([k]) => `${k} ${results[k]}`).join(", ")}`);
  process.exit(1);
}
