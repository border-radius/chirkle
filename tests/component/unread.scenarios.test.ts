// The unread counts' shared scenarios (shared/vectors/unread.json, docs/REFACTOR.md item 55): the web's unread.ts
// against a real PocketBase. The app runs the same in android/core/data/src/test/kotlin/chirkle/android/data/repo/
// UnreadScenariosTest.kt. RECORD=1 writes what the web's module does as each step's `expect` (what the app is held to).

import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "../../web/src/lib/id.ts";
import { type AppState, createStore, initialState, upsertRoom } from "../../web/src/store.ts";
import { createUnread, type RoomReader, type Unread } from "../../web/src/unread.ts";
import { type SignedUp, signedUp, uniq } from "../support/api.ts";

const FILE = "shared/vectors/unread.json";
const RECORD = process.env.RECORD === "1";
const vectors = JSON.parse(readFileSync(FILE, "utf8")) as { scenarios: Scenario[] };

type Who = "me" | "ann" | "bob";
interface Step {
  do: "say" | "react" | "delete" | "open" | "seen" | "close" | "readElsewhere" | "wait";
  who?: Who;
  room?: "A" | "B";
  label?: string;
  mention?: boolean;
  replyTo?: string;
  at?: string;
  upTo?: string;
  caughtUp?: boolean;
  ms?: number;
  expect?: Counts;
}
interface Scenario {
  name: string;
  steps: Step[];
}
interface Counts {
  unread: Record<string, number>;
  mentions: Record<string, number>;
  inbox: number;
}

describe("shared scenarios: the unread counts (§18.3, §41.4)", () => {
  let unread: Unread | undefined;
  const users: SignedUp[] = [];
  afterEach(async () => {
    unread?.stop();
    unread = undefined;
    await Promise.all(users.splice(0).map((u) => u.api.unsubscribeAll()));
  });
  afterAll(() => {
    if (RECORD) writeFileSync(FILE, `${JSON.stringify(vectors, null, 2)}\n`);
  });

  for (const sc of vectors.scenarios) {
    it(sc.name, async () => {
      const [me, ann, bob] = await Promise.all([signedUp(`Me ${uniq()}`), signedUp(`Ann ${uniq()}`), signedUp(`Bob ${uniq()}`)]);
      users.push(me, ann, bob);
      const people: Record<Who, SignedUp> = { me, ann, bob };
      const rooms = { A: await ann.api.createRoom(`a-${uniq()}`), B: await ann.api.createRoom(`b-${uniq()}`) };
      const roomLabel = new Map<string, string>([
        [rooms.A.id, "A"],
        [rooms.B.id, "B"],
      ]);
      const msgs = new Map<string, { id: string; created: string }>(); // label → message

      let state: AppState = { ...initialState(), user: me.user, roomsStatus: "ready" };
      state = { ...state, ...upsertRoom(rooms.A)(state) };
      state = { ...state, ...upsertRoom(rooms.B)(state) };
      const store = createStore<AppState>(state);
      unread = createUnread({ api: me.api, store });
      unread.start();
      // Settled before the first step: counted once, and following live (the subscription has no promise to wait on).
      await vi.waitFor(() => expect(store.get().listLoads).toBe(0), { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 1500));
      const readers = new Map<string, RoomReader>();

      // Only A and B: the server is shared with other tests, whose public rooms anyone may have unread messages in.
      const byLabel = (m: Map<string, number>) =>
        Object.fromEntries(
          [...m]
            .filter(([id, n]) => n > 0 && roomLabel.has(id))
            .map(([id, n]) => [roomLabel.get(id) ?? id, n] as const)
            .sort(),
        );
      const shown = (): Counts => {
        const s = store.get();
        return { unread: byLabel(s.unread), mentions: byLabel(s.mentions), inbox: s.inbox };
      };

      for (const [i, step] of sc.steps.entries()) {
        const room = step.room ? rooms[step.room] : undefined;
        switch (step.do) {
          case "say": {
            const text = step.mention ? `${step.label} @${me.user.handle}` : step.label!;
            const m = await people[step.who!].api.send({
              id: newId(),
              room: room!.id,
              text,
              ...(step.replyTo ? { replyTo: msgs.get(step.replyTo)!.id } : {}),
            });
            msgs.set(step.label!, m);
            break;
          }
          case "react":
            await people[step.who!].api.react(msgs.get(step.at!)!.id, "👍", true);
            break;
          case "delete":
            await people[step.who!].api.softDelete(msgs.get(step.at!)!.id);
            break;
          case "open":
            readers.set(step.room!, unread.open(room!.id));
            break;
          case "seen":
            readers.get(step.room!)!.seen(msgs.get(step.upTo!)!.created, step.caughtUp!);
            break;
          case "close":
            readers.get(step.room!)!.close(step.caughtUp!);
            readers.delete(step.room!);
            break;
          case "readElsewhere":
            await me.api.markRead(room!.id, msgs.get(step.upTo!)!.created);
            break;
          case "wait":
            await new Promise((r) => setTimeout(r, step.ms));
            break;
        }
        if (RECORD) {
          // Settled: the same for two seconds (reads are batched for one, refetches wait a quarter).
          let last = "";
          for (let still = 0; still < 20; ) {
            await new Promise((r) => setTimeout(r, 100));
            const now = JSON.stringify(shown());
            still = now === last ? still + 1 : 0;
            last = now;
          }
          step.expect = shown();
        } else {
          await vi.waitFor(() => expect(shown(), `step ${i + 1}: ${step.do}`).toEqual(step.expect), { timeout: 10_000, interval: 25 });
        }
      }
    }, 60_000);
  }
});
