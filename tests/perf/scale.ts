// How the app holds up at a larger size (docs/REFACTOR.md item 26): a throwaway server with ROOMS public rooms, USERS
// users and MESSAGES messages, then the requests whose cost grows with that, timed through the app's own client.
//
//   node --experimental-eventsource --no-warnings tests/perf/scale.ts
//
// Sizes can be changed with env vars (ROOMS, USERS, MESSAGES, LISTENERS). Prints a table; nothing is kept, unless
// DATA_DIR names a directory for the server's data (then the seeded database stays there, to look into).

import { performance } from "node:perf_hooks";
import { type Api, createApi } from "../../web/src/api.ts";
import { latest } from "../../web/src/lib/cursor.ts";
import { newId } from "../../web/src/lib/id.ts";
import { toPb } from "../../web/src/lib/time.ts";
import { createClient } from "../../web/src/pb.ts";
import { searchQuery } from "../../web/src/views/room/search.ts";
import { disableRateLimits, startPocketBase } from "../support/pocketbase.ts";
import { runSql } from "../support/sql.ts";

const ROOMS = Number(process.env.ROOMS ?? 200);
const USERS = Number(process.env.USERS ?? 50);
const MESSAGES = Number(process.env.MESSAGES ?? 100_000);
/** Clients listening to every message event, as every open tab of a signed-in user does (unread counts, §18.3). */
const LISTENERS = Number(process.env.LISTENERS ?? 50);
const RUNS = 20;

const pb = await startPocketBase({ fixtureRoute: true, ...(process.env.DATA_DIR ? { dataDir: process.env.DATA_DIR } : {}) });
try {
  await disableRateLimits(pb.url);
  const client = (): Api => createApi(createClient(pb.url));

  // ---- seed
  let t = performance.now();
  const users: { api: Api; id: string }[] = [];
  for (let i = 0; i < USERS; i++) {
    const api = client();
    const name = `perf ${i} ${newId().slice(0, 6)}`;
    const user = await api.signUp({ email: `perf-${newId()}@test.local`, password: "password-123", name });
    users.push({ api, id: user.id });
  }
  const rooms: string[] = [];
  for (let i = 0; i < ROOMS; i++) rooms.push((await users[i % USERS]!.api.createRoom(`perf-${i}-${newId().slice(0, 6)}`)).id);
  // Messages after every user signed up (unread counts start at signup), oldest first, 1 ms apart.
  const start = Date.now() + 1000;
  const BATCH = 2000;
  for (let from = 0; from < MESSAGES; from += BATCH) {
    const statements = [];
    for (let i = from; i < Math.min(from + BATCH, MESSAGES); i++) {
      const ts = toPb(start + i);
      statements.push({
        sql: "INSERT INTO messages (id, room, author, text, text_key, edited_at, deleted, deleted_at, created, updated) VALUES ({:id}, {:room}, {:author}, {:text}, {:key}, '', 0, '', {:ts}, {:ts})",
        params: { id: newId(), room: rooms[i % ROOMS]!, author: users[(i * 7) % USERS]!.id, text: `message ${i}`, key: `message ${i}`, ts },
      });
    }
    await runSql(pb.url, statements);
  }
  await new Promise((r) => setTimeout(r, Math.max(0, start + MESSAGES - Date.now() + 50))); // all in the past now
  console.log(`seeded ${USERS} users, ${ROOMS} rooms, ${MESSAGES} messages in ${((performance.now() - t) / 1000).toFixed(1)} s`);

  // ---- requests
  const me = users[0]!.api;
  async function time(label: string, fn: () => Promise<unknown>) {
    await fn(); // warm up
    const ms: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      t = performance.now();
      await fn();
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))]!.toFixed(1);
    console.log(`${label.padEnd(44)} median ${p(0.5).padStart(7)} ms   p90 ${p(0.9).padStart(7)} ms`);
  }
  await time(`unread counts (${ROOMS} rooms, all ≥ 100 unread)`, () => me.unreadCounts());
  await time(`list rooms (${ROOMS})`, () => me.listRooms());
  await time("latest page of a room (50 messages)", () => me.page(latest(rooms[0]!)));
  const perRoom = Math.round(MESSAGES / ROOMS);
  // §29: no match reads every message of the room; a common word stops at the first page.
  await time(`search a room (${perRoom} messages), no match`, () => me.page(searchQuery(rooms[0]!, ["nothing-matches"])));
  await time(`search a room (${perRoom} messages), 50 matches`, () => me.page(searchQuery(rooms[0]!, ["message"])));
  await time("send a message (no listeners)", () => me.send({ id: newId(), room: rooms[1]!, text: "hello" }));

  // ---- realtime fan-out: every listener gets every message event of every room it can see
  const listeners = users.slice(0, LISTENERS);
  const seen = new Map<string, number>();
  const waiters = new Map<string, () => void>();
  for (const u of listeners) {
    await u.api.subscribeAllMessages((action, m) => {
      if (action !== "create") return;
      const n = (seen.get(m.id) ?? 0) + 1;
      seen.set(m.id, n);
      if (n === listeners.length) waiters.get(m.id)?.();
    });
  }
  await time(`send, until all ${listeners.length} listeners have the event`, async () => {
    const id = newId();
    const all = new Promise<void>((resolve) => waiters.set(id, resolve));
    await me.send({ id, room: rooms[2]!, text: "fan-out" });
    await all;
  });
  for (const u of listeners) await u.api.unsubscribeAll();
} finally {
  await pb.stop();
}
