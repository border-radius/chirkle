// Server stress test (docs/PERF.md §6.1): a throwaway server with its files in S3 behind added latency (as a hosted
// instance's are), many users at once, each doing what the web app does, for a while. Compared with scripts/bench.ts,
// which times one thing at a time, this is a crowd.
//
//   node --no-warnings scripts/stress.ts [--users=100] [--seconds=90] [--think=1000] [--s3-delay=150]
//        [--photos=0.1] [--live=on|off] [--hooks=pb_hooks] [--images=dir] [--out=result.json]
//        [--cpu=7] [--memlimit=700MiB] [--warm] [--files=on|off] [--arrive=5] [--workers=n]
//
// A small VPS (PERF.md §8): --cpu pins the server (and what it spawns: ffmpeg) to that one CPU with GOMAXPROCS=1, and
// --memlimit sets GOMEMLIMIT. Run the script itself on the other CPUs (taskset -c 0-5 node …), not the pinned one's
// SMT sibling. The memory reported is then the server's and its children's together, as a VPS's RAM would hold.
// --warm makes the history's thumbnails before the crowd comes, as a live instance has them (made once, on the first
// view), so the run measures the steady state rather than 100 users making 800 thumbnails at once. --files=off: no
// thumbnail or photo is fetched, as when a CDN (Cloudflare) or the browser's cache has them.
//
// The users are spread over --workers processes (default: 250 each, up to 6), each its own event loop: one Node
// process parsing every live event for 2,000 clients ran at 90% of a core and measured itself, not the server (PERF.md
// §13). They are seeded in SQL from one signed-up user and signed in by superuser impersonation: signing up 2,000 one
// by one cost the pinned CPU 15 minutes of bcrypt. A sent message's id carries its send time, so the process that hears
// it times the delivery.
//
// Every user keeps a realtime connection (all messages' activity, plus the open room's messages, as the web
// subscribes) and then, after a think time (exponential, mean --think ms), does one of: open a room (its latest page,
// then up to 8 of its images' thumbnails), scroll back a page, send (some replies, some with a photo), react, mark read
// and count unread, list rooms, open a photo. Reported: each action's latency (p50/p95/p99/max) and errors, how long a
// sent message took to reach every user live, and the server's CPU and memory. Needs versitygw (tests/support/s3.ts).

import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import PocketBase from "pocketbase";
import "../tests/support/eventsource.ts";
import { disableRateLimits, SUPERUSER, startPocketBase } from "../tests/support/pocketbase.ts";
import { startS3 } from "../tests/support/s3.ts";
import { runSql, type SqlStatement } from "../tests/support/sql.ts";
import { type Api, createApi } from "../web/src/api.ts";
import { latest, older } from "../web/src/lib/cursor.ts";
import { newId } from "../web/src/lib/id.ts";
import type { Message } from "../web/src/lib/types.ts";
import { createClient } from "../web/src/pb.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const USERS = Number(arg("users", "100"));
const SECONDS = Number(arg("seconds", "90"));
const THINK_MS = Number(arg("think", "1000"));
/** The share of sends with a photo, and whether users keep realtime subscriptions ("off": to see what they cost). */
const PHOTOS = Number(arg("photos", "0.1"));
const LIVE = arg("live", "on") !== "off";
const S3_DELAY_MS = Number(arg("s3-delay", "150"));
const HOOKS = arg("hooks", "");
const OUT = arg("out", "");
const CPU = arg("cpu", "");
const MEMLIMIT = arg("memlimit", "");
const WARM = process.argv.includes("--warm");
const FILES = arg("files", "on") !== "off";
/** Over how many seconds the users arrive (5: a reconnect storm, as after a restart). */
const ARRIVE_MS = Number(arg("arrive", "5")) * 1000;
/** Processes the users are spread over (each one event loop, one core at most): 250 users each, up to 6. */
const WORKERS = Math.max(1, Number(arg("workers", String(Math.min(6, Math.ceil(USERS / 250))))));
const ROOMS = 10;
const HISTORY = 150; // messages a room starts with
const THUMB = "800x480f"; // what the web asks for in a room

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
const pct = (xs: number[], p: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]! : 0;
const round = (x: number) => Math.round(x);

/**
 * Photos to send: the JPEGs in --images. Any ~60 KB photos do, as hosted rooms have, for instance made with ffmpeg:
 * for i in 1 2 3 4 5 6; do ffmpeg -f lavfi -i testsrc2=size=1280x960 -vf hue=h=$((i*60)) -frames:v 1 -q:v 4 p$i.jpg; done
 */
const imageDir = arg("images", "");
const photos = imageDir
  ? readdirSync(imageDir)
      .filter((f) => f.endsWith(".jpg"))
      .map((f) => readFileSync(join(imageDir, f)))
  : [];
if (!photos.length) throw new Error("--images: a folder of .jpg photos (see the comment above)");
const photo = (n: number) => new File([pick(photos)], `photo_${n}.jpg`, { type: "image/jpeg" });

/** A TCP proxy to `port` that holds each answer's bytes back `ms`: S3 far away (about 200 ms an operation, measured). */
async function slowProxy(port: number, ms: number): Promise<{ port: number; close(): void }> {
  // Half-closes pass through in order (after the bytes before them), as a network's would: tearing both sides down at
  // once cut keep-alive connections the server had just been sent a request on (EOF in PocketBase's S3 client).
  const srv = createServer({ allowHalfOpen: true }, (client) => {
    const up = connect({ port, host: "127.0.0.1", allowHalfOpen: true });
    client.on("data", (d) => up.write(d));
    client.on("end", () => up.end());
    up.on("data", (d) => setTimeout(() => client.writable && client.write(d), ms));
    up.on("end", () => setTimeout(() => client.end(), ms));
    const kill = () => {
      client.destroy();
      up.destroy();
    };
    client.on("error", kill);
    up.on("error", kill);
    client.on("close", () => setTimeout(() => up.destroy(), ms));
    up.on("close", () => setTimeout(() => client.destroy(), ms + 10));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const addr = srv.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, close: () => srv.close() };
}

function serverPid(port: string): number {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, "utf8").includes(`--http=127.0.0.1:${port}`)) return Number(d);
    } catch {}
  }
  throw new Error(`no server on ${port}`);
}
const cpuMs = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return (Number(f[11]) + Number(f[12])) * 10;
};
const rssKb = (pid: number) => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
  } catch {
    return 0; // gone
  }
};
/** The server's memory, with its children's (ffmpeg making posters and thumbnails) when --cpu or --memlimit is given. */
const rssMb = (pid: number) => {
  let kb = rssKb(pid);
  if (CPU || MEMLIMIT)
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1]!.split(" ")[1] === String(pid)) kb += rssKb(Number(d));
      } catch {}
    }
  return Math.round(kb / 1024);
};

// ---- timings (each worker's; the coordinator merges them)
/** Wall-clock milliseconds, the same in every process on the machine: a delivery is timed across processes. */
const now = () => performance.timeOrigin + performance.now();
const times = new Map<string, number[]>();
/** After the first 30 s of the crowd (everyone has arrived and opened a room): the steady state, reported apart. */
const steadyTimes = new Map<string, number[]>();
const STEADY_AFTER_MS = 30_000;
let loadStart = Infinity; // now() at the crowd's start
const errors = new Map<string, { n: number; first: string }>();
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t = now();
  try {
    const out = await fn();
    const ms = now() - t;
    (times.get(name) ?? times.set(name, []).get(name)!).push(ms);
    if (t - loadStart > STEADY_AFTER_MS) (steadyTimes.get(name) ?? steadyTimes.set(name, []).get(name)!).push(ms);
    return out;
  } catch (err) {
    const e = errors.get(name) ?? errors.set(name, { n: 0, first: String((err as Error)?.message ?? err).slice(0, 400) }).get(name)!;
    e.n++;
    return undefined;
  }
}

/** Run `fns` at most `n` at a time. */
async function limited(n: number, fns: (() => Promise<unknown>)[]) {
  const queue = [...fns];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await queue.shift()!();
    }),
  );
}

/** A user as a worker gets it: a session made by the coordinator (no password to check). */
interface Session {
  token: string;
  record: { id: string; collectionId: string; collectionName: string } & Record<string, unknown>;
}

/** What the coordinator tells a worker. */
type ToWorker =
  | { type: "start"; url: string; first: number; sessions: Session[]; rooms: string[] }
  | { type: "go"; loadStart: number }
  | { type: "stop" };

/** What a worker answers. */
type FromWorker =
  | { type: "ready" }
  | {
      type: "done";
      times: [string, number[]][];
      steady: [string, number[]][];
      errors: [string, { n: number; first: string }][];
      sent: number;
      delivered: number[];
    };

/**
 * A sent message's id, carrying when it was sent so whichever process hears it can time the delivery (the live
 * activity events carry ids, not text): "t", the send time in 0.1 ms as 9 base-36 digits, then 5 random characters;
 * 15 of [a-z0-9] as every id. The history's ids (random) are made before anyone listens.
 */
const timedId = () =>
  `t${Math.round(now() * 10)
    .toString(36)
    .padStart(9, "0")
    .slice(-9)}${newId().slice(0, 5)}`;
const sentAtOf = (id: string) => (id.length === 15 && id[0] === "t" ? parseInt(id.slice(1, 10), 36) / 10 : NaN);

// ---- a worker: some of the users, from their sessions to their results
async function worker(): Promise<void> {
  // The coordinator gone (killed, failed): so is the worker.
  process.on("disconnect", () => process.exit(1));
  const start = await new Promise<Extract<ToWorker, { type: "start" }>>((ok) =>
    process.once("message", (m) => ok(m as Extract<ToWorker, { type: "start" }>)),
  );
  const { url, first, rooms } = start;
  const apis: Api[] = start.sessions.map((s) => {
    const client = createClient(url);
    client.authStore.save(s.token, s.record as never);
    return createApi(client);
  });

  // Realtime: each user hears every message's activity; delivery timed from the send's start.
  const delivered: number[] = [];
  const unsubs: (() => Promise<void>)[] = [];
  await limited(
    10,
    (LIVE ? apis : []).map((api) => async () => {
      unsubs.push(
        await api.subscribeAllMessages((action, m) => {
          const at = action === "create" ? sentAtOf(m.id) : NaN;
          if (at > loadStart - 60_000) delivered.push(Math.round((now() - at) * 10) / 10);
        }),
      );
    }),
  );

  let sent = 0;
  let stop = false;
  const go = new Promise<void>((ok) =>
    process.on("message", (m) => {
      const msg = m as ToWorker;
      if (msg.type === "go") {
        loadStart = msg.loadStart;
        ok();
      } else if (msg.type === "stop") stop = true;
    }),
  );
  process.send!({ type: "ready" } satisfies FromWorker);
  await go;

  const file = (m: Message, f: string, thumb?: string) =>
    fetch(`${url}/api/files/messages/${m.forward_of || m.id}/${f}${thumb ? `?thumb=${thumb}` : ""}`).then(async (res) => {
      const body = await res.arrayBuffer();
      if (!res.ok)
        throw new Error(`${res.status} ${res.url.slice(res.url.indexOf("/api/"))} ${new TextDecoder().decode(body).slice(0, 400)}`);
    });

  await Promise.all(
    apis.map(async (api, i) => {
      const u = first + i;
      await sleep(Math.random() * ARRIVE_MS); // arrive over --arrive seconds
      let room = pick(rooms);
      let page: Message[] = [];
      let roomSub: (() => Promise<void>) | undefined;
      const open = async () => {
        room = pick(rooms);
        await roomSub?.();
        if (LIVE) roomSub = await api.subscribeMessages(room, () => {});
        page = (await timed("page (latest)", () => api.page(latest(room)))) ?? [];
        const thumbs = page.flatMap((m) => (m.files ?? []).map((f) => () => timed("thumbnail", () => file(m, f, THUMB)))).slice(-8);
        if (FILES) await limited(6, thumbs);
      };
      await timed("open room (page + thumbnails)", open);
      while (!stop) {
        await sleep(-Math.log(1 - Math.random()) * THINK_MS);
        if (stop) break;
        const r = Math.random();
        if (r < 0.25) await timed("open room (page + thumbnails)", open);
        else if (r < 0.35 && page.length) {
          const last = page[page.length - 1]!;
          await timed("page (older)", () => api.page(older(room, { created: last.created, id: last.id })));
        } else if (r < 0.55) {
          const id = timedId();
          const withPhoto = Math.random() < PHOTOS;
          const replyTo = Math.random() < 0.3 && page.length ? pick(page).id : undefined;
          sent++;
          await timed(withPhoto ? "send (with photo)" : "send", () =>
            api.send({ id, room, text: `live from ${u}`, ...(replyTo ? { replyTo } : {}), ...(withPhoto ? { files: [photo(u)] } : {}) }),
          );
        } else if (r < 0.7 && page.length) {
          await timed("react", () => api.react(pick(page).id, pick(["👍", "❤️", "😂"]), Math.random() < 0.7));
        } else if (r < 0.85 && page.length) {
          await timed("mark read + unread", async () => {
            await api.markRead(room, page[0]!.created);
            await api.unreadCounts();
          });
        } else if (r < 0.93) {
          await timed("room list", () => api.listRooms());
        } else {
          const withFile = page.filter((m) => m.files?.length);
          if (withFile.length && FILES) {
            const m = pick(withFile);
            await timed("photo (original)", () => file(m, m.files![0]!));
          }
        }
      }
      await roomSub?.();
    }),
  );
  await sleep(3000); // the last messages' deliveries
  for (const un of unsubs) await un().catch(() => {});
  process.send!(
    {
      type: "done",
      times: [...times],
      steady: [...steadyTimes],
      errors: [...errors],
      sent,
      delivered,
    } satisfies FromWorker,
    () => process.exit(0),
  );
}

// ---- the coordinator: the server, the seed, the workers, the report
async function coordinate(): Promise<void> {
  const s3 = await startS3();
  const proxy = await slowProxy(Number(new URL(s3.endpoint).port), S3_DELAY_MS);
  const pb = await startPocketBase({
    ...(HOOKS ? { hooksDir: HOOKS } : {}),
    fixtureRoute: true, // the users are seeded in SQL
    // The workers on, as in production; no page has a link, so previews fetch nothing.
    verbose: process.argv.includes("--server-log"),
    env: { MEDIA_CRON: "on", LINK_PREVIEWS: "off", ...(CPU ? { GOMAXPROCS: "1" } : {}), ...(MEMLIMIT ? { GOMEMLIMIT: MEMLIMIT } : {}) },
  });
  const children: ChildProcess[] = [];
  // Killed (`timeout`, Ctrl-C): the server goes too. Left running on the pinned CPU, it skewed the next runs (PERF.md §11).
  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.once(sig, () => {
      for (const c of children) c.kill();
      void Promise.allSettled([pb.stop(), s3.stop()]).then(() => process.exit(130));
    });
  try {
    const pid = serverPid(new URL(pb.url).port);
    if (CPU) execFileSync("taskset", ["-a", "-p", "-c", CPU, String(pid)], { stdio: "ignore" });
    await disableRateLimits(pb.url);
    const su = new PocketBase(pb.url);
    su.autoCancellation(false);
    await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    await su.settings.update({
      s3: {
        enabled: true,
        bucket: s3.bucket,
        region: "us-east-1",
        endpoint: S3_DELAY_MS ? `http://127.0.0.1:${proxy.port}` : s3.endpoint,
        accessKey: s3.accessKey,
        secret: s3.secret,
        forcePathStyle: true,
      },
    });

    // ---- seed: users, rooms, history with photos and replies
    let t0 = performance.now();
    const sessions = await seedUsers(pb.url, su);
    const apis: Api[] = sessions.map((s) => {
      const client = createClient(pb.url);
      client.authStore.save(s.token, s.record as never);
      return createApi(client);
    });
    const rooms: string[] = [];
    for (let r = 0; r < ROOMS; r++) rooms.push((await apis[r % USERS]!.createRoom(`room ${r}`, "public")).id);
    let n = 0;
    await limited(
      ROOMS,
      rooms.map((room, r) => async () => {
        const ids: string[] = [];
        for (let i = 0; i < HISTORY; i++) {
          const id = newId();
          const replyTo = i % 5 === 4 ? ids[ids.length - 3] : undefined;
          const files = i % 6 === 5 ? [photo(n++)] : undefined;
          await apis[(r * 7 + i) % USERS]!.send({
            id,
            room,
            text: `history ${i} of room ${r}`,
            ...(replyTo ? { replyTo } : {}),
            ...(files ? { files } : {}),
          });
          ids.push(id);
        }
      }),
    );
    const seedS = (performance.now() - t0) / 1000;
    console.log(`seeded ${USERS} users, ${ROOMS} rooms × ${HISTORY} messages in ${seedS.toFixed(0)} s; connecting ${WORKERS} workers`);
    if (WARM) {
      const all = await su.collection("messages").getFullList<{ id: string; files?: string[] }>({ batch: 500 });
      const withFiles = all.filter((m) => m.files?.length) as { id: string; files: string[] }[];
      await limited(
        4,
        withFiles.flatMap((m) =>
          m.files.map((f) => async () => {
            const res = await fetch(`${pb.url}/api/files/messages/${m.id}/${f}?thumb=${THUMB}`);
            await res.arrayBuffer();
          }),
        ),
      );
      console.log(`warmed ${withFiles.length} thumbnails; server memory ${rssMb(pid)} MB`);
    }

    // ---- the workers: each a share of the users, subscribed, then all let go at once
    const per = Math.ceil(USERS / WORKERS);
    const results: Promise<Extract<FromWorker, { type: "done" }>>[] = [];
    const ready: Promise<void>[] = [];
    for (let w = 0; w < WORKERS; w++) {
      const first = w * per;
      const mine = sessions.slice(first, first + per);
      if (!mine.length) break;
      const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), "--worker"], {
        execArgv: process.execArgv,
        stdio: "inherit",
      });
      children.push(child);
      ready.push(
        new Promise((ok, fail) => {
          child.on("message", (m) => (m as FromWorker).type === "ready" && ok());
          child.once("exit", (code) => fail(new Error(`worker ${w} exited (${code}) before it was ready`)));
        }),
      );
      results.push(
        new Promise((ok, fail) => {
          child.on("message", (m) => {
            if ((m as FromWorker).type === "done") ok(m as Extract<FromWorker, { type: "done" }>);
          });
          child.once("exit", (code) => code !== 0 && fail(new Error(`worker ${w} exited (${code})`)));
        }),
      );
      child.send({ type: "start", url: pb.url, first, sessions: mine, rooms } satisfies ToWorker);
    }
    await Promise.all(ready);

    // ---- the crowd
    const cpu0 = cpuMs(pid);
    let rssMax = rssMb(pid);
    const rssTimer = setInterval(() => (rssMax = Math.max(rssMax, rssMb(pid))), 250);
    t0 = performance.now();
    const goAt = now();
    for (const c of children) c.send({ type: "go", loadStart: goAt } satisfies ToWorker);
    await sleep(SECONDS * 1000);
    // Timed at the stop, not when the last user has finished: a user then ends its think time before it sees the stop.
    const loadS = (performance.now() - t0) / 1000;
    const cpu = cpuMs(pid) - cpu0;
    for (const c of children) c.send({ type: "stop" } satisfies ToWorker);
    const done = await Promise.all(results);
    clearInterval(rssTimer);

    // ---- report
    const merge = (lists: [string, number[]][][]) => {
      const out = new Map<string, number[]>();
      for (const list of lists) for (const [k, xs] of list) out.set(k, (out.get(k) ?? []).concat(xs));
      return out;
    };
    const allTimes = merge(done.map((d) => d.times));
    const allSteady = merge(done.map((d) => d.steady));
    const allErrors = new Map<string, { n: number; first: string }>();
    for (const d of done)
      for (const [k, e] of d.errors) {
        const has = allErrors.get(k);
        if (has) has.n += e.n;
        else allErrors.set(k, { ...e });
      }
    const delivered = done.flatMap((d) => d.delivered);
    const sent = done.reduce((s, d) => s + d.sent, 0);
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    for (const [name, xs] of [...allTimes.entries()].sort()) {
      total += xs.length;
      const err = allErrors.get(name);
      rows.push({
        action: name,
        n: xs.length,
        p50: round(pct(xs, 50)),
        p95: round(pct(xs, 95)),
        p99: round(pct(xs, 99)),
        max: round(pct(xs, 100)),
        errors: err?.n ?? 0,
      });
    }
    for (const [name, e] of allErrors) if (!allTimes.has(name)) rows.push({ action: name, n: 0, errors: e.n });
    console.table(rows);
    console.log(`steady state (after the first ${STEADY_AFTER_MS / 1000} s):`);
    const steady = [...allSteady.entries()].sort().map(([action, xs]) => ({
      action,
      n: xs.length,
      p50: round(pct(xs, 50)),
      p95: round(pct(xs, 95)),
      p99: round(pct(xs, 99)),
      max: round(pct(xs, 100)),
    }));
    console.table(steady);
    for (const [name, e] of allErrors) console.log(`errors in ${name}: ${e.n}, first: ${e.first}`);
    const expected = sent * USERS;
    const summary = {
      users: USERS,
      workers: children.length,
      seconds: round(loadS),
      actionsPerS: Math.round((total / loadS) * 10) / 10,
      sent,
      liveDelivered: `${delivered.length}/${expected} (${((100 * delivered.length) / Math.max(1, expected)).toFixed(1)}%)`,
      liveP50: round(pct(delivered, 50)),
      liveP95: round(pct(delivered, 95)),
      liveP99: round(pct(delivered, 99)),
      liveMax: round(pct(delivered, 100)),
      serverCpuPct: Math.round((cpu / (loadS * 1000)) * 100),
      serverRssMaxMb: rssMax,
    };
    console.log(summary);
    if (OUT) await writeFile(OUT, `${JSON.stringify({ summary, rows, steady, errors: Object.fromEntries(allErrors) }, null, 2)}\n`);
  } finally {
    for (const c of children) c.kill();
    await pb.stop();
    proxy.close();
    await s3.stop();
  }
}

/**
 * The users, made in seconds: one signs up (the server hashes its password once), the rest are copies of its row in
 * SQL with their own id, email, name and handle, and each gets a session by superuser impersonation, so no password is
 * hashed or checked again. Signing up 2,000 one by one took the one pinned CPU 15 minutes of bcrypt.
 */
async function seedUsers(url: string, su: PocketBase): Promise<Session[]> {
  const api = createApi(createClient(url));
  await api.signUp({ email: "stress0@example.com", password: "password-123", name: "Stress 0" });
  const tpl = await su
    .collection("users")
    .getFirstListItem<{ id: string; handle: string; name_key: string }>('email = "stress0@example.com"');
  if (!tpl.handle.endsWith("0") || !tpl.name_key.endsWith("0"))
    throw new Error(`unexpected template handle/name_key: ${tpl.handle} ${tpl.name_key}`);
  const ids = [tpl.id];
  const stmts: SqlStatement[] = [];
  for (let i = 1; i < USERS; i++) {
    const id = newId();
    ids.push(id);
    stmts.push({
      sql: `INSERT INTO users (id, password, tokenKey, email, emailVisibility, verified, name, avatar, created, updated,
              name_key, no_dms, peer, instance, moderator, banned, handle)
            SELECT {:id}, password, {:tk}, {:email}, emailVisibility, verified, {:name}, avatar, created, updated,
              {:nk}, no_dms, peer, instance, moderator, banned, {:handle}
            FROM users WHERE id = {:tpl}`,
      params: {
        id,
        tk: `${newId()}${newId()}${newId()}`,
        email: `stress${i}@example.com`,
        name: `Stress ${i}`,
        nk: `${tpl.name_key.slice(0, -1)}${i}`,
        handle: `${tpl.handle.slice(0, -1)}${i}`,
        tpl: tpl.id,
      },
    });
  }
  for (let i = 0; i < stmts.length; i += 500) await runSql(url, stmts.slice(i, i + 500));
  const sessions: Session[] = new Array(USERS);
  await limited(
    16,
    ids.map((id, i) => async () => {
      sessions[i] = await su.send<Session>(`/api/collections/users/impersonate/${id}`, {
        method: "POST",
        body: { duration: SECONDS + 3600 },
      });
    }),
  );
  return sessions;
}

if (process.argv.includes("--worker")) await worker();
else {
  await coordinate();
  process.exit(0);
}
