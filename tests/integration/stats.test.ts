// Usage statistics (§40): GET /api/chat/stats for moderators and superusers, counts only; the 5-minute samples and the
// daily activity rows (POST /api/stats/tick runs both, with the prune); site.no_stats stops recording.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type PocketBase from "pocketbase";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { adminClient, client, collect, newRoom, newUser, openDm, pngFile, post, rawDb, sleep, status, type TestUser } from "./helpers.ts";

interface Stats {
  history: boolean;
  sample_minutes: number;
  now: { online: number; guests: number; web: number; android: number };
  active: { day: number; week: number; month: number };
  accounts: { total: number; new_week: number; moderators: number; banned: number };
  messages: {
    days: { day: string; messages: number; people: number }[];
    people_week: number;
    people_month: number;
    dms_month: number;
    files_month: number;
    reactions_month: number;
  };
  samples: [number, number, number, number, number][];
}

const stats = (pb: PocketBase, tz = 0) => pb.send<Stats>(`/api/chat/stats?tz=${tz}`, {});
const tick = async () => (await adminClient()).send("/api/stats/tick", { method: "POST" });

async function newModerator(): Promise<TestUser> {
  const m = await newUser();
  await (await adminClient()).collection("users").update(m.user.id, { moderator: true });
  const { record } = await m.pb.collection("users").authRefresh();
  return { ...m, user: record };
}

/** Requests from `pb` say they are from `ua` (the Android app's OkHttp, a browser). */
function as(pb: PocketBase, ua: string) {
  pb.beforeSend = (url, options) => ({ url, options: { ...options, headers: { ...options.headers, "User-Agent": ua } } });
}

const today = () => new Date().toISOString().slice(0, 10);

describe("who sees the statistics (§40)", () => {
  it("moderators and superusers; not guests, not other people", async () => {
    const a = await newUser();
    const m = await newModerator();
    expect(await status(stats(client()))).toBe(403);
    expect(await status(stats(a.pb))).toBe(403);
    expect(await status(stats(m.pb))).toBe(200);
    expect(await status(stats(await adminClient()))).toBe(200);
  });

  it("the rows themselves never: no API rules", async () => {
    const m = await newModerator();
    for (const c of ["stats_samples", "stats_activity"]) expect(await status(m.pb.collection(c).getList(1, 1))).toBe(403);
    expect(await m.pb.collection("site").getFirstListItem("")).not.toHaveProperty("no_stats");
  });

  it("names no one", async () => {
    const m = await newModerator();
    const a = await newUser();
    await post(a, (await newRoom(a)).id, "hello");
    const text = JSON.stringify(await stats(m.pb));
    for (const x of [a.user.id, a.user.name, a.email, m.user.id]) expect(text).not.toContain(x);
  });

  it("the page is served at /stats to anyone (it asks the API); a 404 until built", async () => {
    const file = join(inject("pbPublicDir"), "stats.html");
    expect((await fetch(`${inject("pbUrl")}/stats`)).status).toBe(404);
    await mkdir(inject("pbPublicDir"), { recursive: true });
    await writeFile(file, "<!doctype html><title>Usage statistics</title>");
    try {
      const res = await fetch(`${inject("pbUrl")}/stats`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("link")).toBeNull(); // not the app's preloads
      expect(await res.text()).toContain("<title>Usage statistics</title>");
    } finally {
      await rm(file, { force: true });
    }
  });
});

describe("online now (§40)", () => {
  it("counts people with a live connection once each, by app, and guests' connections; not superusers", async () => {
    const m = await newModerator();
    const before = (await stats(m.pb)).now;
    const a = await newUser();
    const b = await newUser();
    as(a.pb, "okhttp/5.1.0");
    as(b.pb, "Mozilla/5.0 (X11; Linux x86_64) Chrome/140");
    const guest = client();
    const room = await newRoom(a);
    const subs = [
      await collect(a.pb, "rooms"),
      await collect(b.pb, "rooms"),
      await collect(b.pb, "messages", { filter: `room = "${room.id}"` }),
      await collect(guest, "rooms"),
      await collect(await adminClient(), "rooms"),
    ];
    try {
      const now = (await stats(m.pb)).now;
      expect(now.online - before.online).toBe(2);
      expect(now.android - before.android).toBe(1);
      expect(now.web - before.web).toBe(1);
      expect(now.guests - before.guests).toBe(1);
    } finally {
      for (const s of subs) await s.stop();
    }
    // Closed: they go (the server notices a closed connection at once, or within a moment).
    let online = -1;
    for (let i = 0; i < 40 && online !== before.online; i++) {
      online = (await stats(m.pb)).now.online;
      if (online !== before.online) await sleep(50);
    }
    expect(online).toBe(before.online);
  });
});

describe("recording (§40)", () => {
  let siteId = "";
  beforeAll(async () => {
    siteId = (await (await adminClient()).collection("site").getFirstListItem("", { sort: "created" })).id;
  });
  afterEach(async () => {
    await (await adminClient()).collection("site").update(siteId, { no_stats: false });
  });

  it("a subscription marks its account active today; a tick samples who is online and marks them too", async () => {
    const m = await newModerator();
    const a = await newUser();
    const db = rawDb();
    const sub = await collect(a.pb, "rooms");
    try {
      const row = db.prepare("SELECT day, last_at FROM stats_activity WHERE user = ?").get(a.user.id) as { day: string };
      expect(row.day).toBe(today());
      const samples = (db.prepare("SELECT COUNT(*) AS n FROM stats_samples").get() as { n: number }).n;
      await tick();
      expect((db.prepare("SELECT COUNT(*) AS n FROM stats_samples").get() as { n: number }).n).toBe(samples + 1);
      const s = await stats(m.pb);
      const latest = s.samples.at(-1)!;
      expect(latest[1]).toBeGreaterThanOrEqual(1);
      expect(Date.now() - latest[0]).toBeLessThan(60_000);
      expect(s.history).toBe(true);
      expect(s.active.day).toBeGreaterThanOrEqual(1);
      expect(s.active.week).toBeGreaterThanOrEqual(s.active.day);
      expect(s.active.month).toBeGreaterThanOrEqual(s.active.week);
    } finally {
      await sub.stop();
      db.close();
    }
  });

  it("site.no_stats: nothing more is recorded, and the page is told", async () => {
    const m = await newModerator();
    await (await adminClient()).collection("site").update(siteId, { no_stats: true });
    const a = await newUser();
    const db = rawDb();
    const sub = await collect(a.pb, "rooms");
    try {
      const samples = (db.prepare("SELECT COUNT(*) AS n FROM stats_samples").get() as { n: number }).n;
      await tick();
      expect((db.prepare("SELECT COUNT(*) AS n FROM stats_samples").get() as { n: number }).n).toBe(samples);
      expect(db.prepare("SELECT 1 FROM stats_activity WHERE user = ?").get(a.user.id)).toBeUndefined();
      const s = await stats(m.pb);
      expect(s.history).toBe(false);
      expect(s.now.online).toBeGreaterThanOrEqual(1); // live numbers still
    } finally {
      await sub.stop();
      db.close();
    }
  });

  it("old rows go: activity after 90 days, samples after a year; a deleted account's with it", async () => {
    const a = await newUser();
    const db = rawDb({ write: true });
    try {
      db.prepare(
        "INSERT INTO stats_activity (id, user, day, last_at) VALUES ('oldactivity0001', ?, '2020-01-01', '2020-01-01 10:00:00.000Z')",
      ).run(a.user.id);
      db.prepare("INSERT INTO stats_activity (id, user, day, last_at) VALUES ('newactivity0001', ?, ?, ?)").run(
        a.user.id,
        today(),
        new Date().toISOString().replace("T", " "),
      );
      db.prepare(
        "INSERT INTO stats_samples (id, at, online, guests, web, android) VALUES ('oldsample000001', '2020-01-01 10:00:00.000Z', 1, 0, 1, 0)",
      ).run();
      await tick();
      expect(db.prepare("SELECT id FROM stats_activity WHERE user = ?").all(a.user.id)).toEqual([{ id: "newactivity0001" }]);
      expect(db.prepare("SELECT 1 FROM stats_samples WHERE id = 'oldsample000001'").get()).toBeUndefined();
      await (await adminClient()).collection("users").delete(a.user.id);
      expect(db.prepare("SELECT 1 FROM stats_activity WHERE user = ?").get(a.user.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("messages and accounts (§40)", () => {
  it("counts the day's messages and posters, DMs, files and reactions", async () => {
    const m = await newModerator();
    const before = await stats(m.pb);
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "one");
    await post(a, room.id, "two");
    await post(b, room.id, "three", { files: [pngFile("a.png"), pngFile("b.png")] });
    await post(a, (await openDm(a, b)).id, "dm");
    await b.pb.send("/api/chat/reactions", { method: "POST", body: { message: msg.id, emoji: "👍", on: true } });
    const s = await stats(m.pb);
    const day = (x: Stats) => x.messages.days.find((d) => d.day === today()) ?? { messages: 0, people: 0 };
    expect(day(s).messages - day(before).messages).toBe(4);
    expect(s.messages.people_week - before.messages.people_week).toBe(2);
    expect(s.messages.dms_month - before.messages.dms_month).toBe(1);
    expect(s.messages.files_month - before.messages.files_month).toBe(2);
    expect(s.messages.reactions_month - before.messages.reactions_month).toBe(1);
    expect(s.accounts.new_week - before.accounts.new_week).toBe(2);
    expect(s.accounts.total - before.accounts.total).toBe(2);
    expect(s.accounts.moderators).toBeGreaterThanOrEqual(1);
  });

  it("days are the viewer's (tz, minutes east of UTC)", async () => {
    const m = await newModerator();
    const a = await newUser();
    await post(a, (await newRoom(a)).id, "now");
    const shifted = (min: number) => new Date(Date.now() + min * 60_000).toISOString().slice(0, 10);
    for (const tz of [-600, 0, 600]) {
      const s = await stats(m.pb, tz);
      expect(s.messages.days.at(-1)?.day).toBe(shifted(tz));
    }
  });
});
