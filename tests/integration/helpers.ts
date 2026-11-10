import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PocketBase, { ClientResponseError, type RecordModel, type RecordSubscription } from "pocketbase";
import { expect, inject } from "vitest";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { SUPERUSER } from "../support/pocketbase.ts";

export { PNG, pngFile } from "../support/files.ts";
export { uniq } from "../support/ids.ts";
/**
 * A record as the files URL of a message's or a collection item's file names it: by its collection's name, as the apps
 * build them. Those files are served by routes of their own, which go by name (pb_hooks/lib/files.js); pass this to
 * `pb.files.getURL`, which uses the id when there is one.
 */
export const byName = <T extends { collectionName: string }>(rec: T) => ({ ...rec, collectionId: rec.collectionName });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fresh SDK client with an in-memory auth store, so clients never share tokens. */
export function client(): PocketBase {
  const pb = new PocketBase(inject("pbUrl"));
  pb.autoCancellation(false);
  return pb;
}

export async function adminClient(): Promise<PocketBase> {
  const pb = client();
  await pb.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  return pb;
}

export interface TestUser {
  pb: PocketBase;
  user: RecordModel;
  email: string;
  password: string;
}

export async function newUser(name = `user-${uniq()}`): Promise<TestUser> {
  const pb = client();
  const email = `${name}@test.local`;
  const password = "password-123";
  await withName(inject("pbUrl"), name, () => pb.collection("users").create({ email, password, passwordConfirm: password, name }));
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record, email, password };
}

export async function newRoom(u: TestUser, name = `room-${uniq()}`): Promise<RecordModel> {
  return u.pb.collection("rooms").create({ name, created_by: u.user.id });
}

export async function post(u: TestUser, room: string, text: string, extra: Record<string, unknown> = {}) {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, ...extra });
}

/** Resolve to the HTTP status of an SDK call (200 when it succeeds). */
export async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ClientResponseError) return e.status;
    throw e;
  }
}

/** Assert an SDK call is refused by PocketBase (validation, rule or permission failure). */
export async function expectRejected(p: Promise<unknown>): Promise<void> {
  expect([400, 403, 404]).toContain(await status(p));
}

/**
 * Handle on the live SQLite DB, for checks that must bypass the API.
 * Writable only for test fixtures the API can't produce (e.g. identical autodate values).
 */
export function rawDb({ write = false } = {}): DatabaseSync {
  const db = new DatabaseSync(join(inject("pbDataDir"), "data.db"), { readOnly: !write });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Subscribe and collect realtime events until `stop()` is called. */
export async function collect(
  pb: PocketBase,
  collection: string,
  options: Record<string, unknown> = {},
): Promise<{ events: RecordSubscription<RecordModel>[]; stop: () => Promise<void> }> {
  const events: RecordSubscription<RecordModel>[] = [];
  const unsubscribe = await pb.collection(collection).subscribe("*", (e) => events.push(e), options);
  return {
    events,
    stop: async () => {
      await unsubscribe();
      pb.realtime.unsubscribe();
    },
  };
}

/**
 * Make "this subscription received nothing it shouldn't" deterministic, without sleeping: `trigger` causes an event
 * the subscription must receive (on the same client, so the same connection). Events on one connection arrive in
 * order, so once that marker is in, anything sent before it has arrived too. The marker is removed from `events`.
 */
export async function barrier(sub: { events: RecordSubscription<RecordModel>[] }, trigger: () => Promise<{ id: string }>) {
  const { id } = await trigger();
  await eventually(() => expect(sub.events.some((e) => e.record.id === id)).toBe(true));
  for (let i = sub.events.length - 1; i >= 0; i--) if (sub.events[i]!.record.id === id) sub.events.splice(i, 1);
}

/** Poll until `fn` stops throwing, or fail after `ms`. */
export async function eventually(fn: () => void, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await sleep(25);
    }
  }
}

/** POST /api/chat/dms as `u` (§16.2): the DM room with `other`. */
export function openDm(u: TestUser, other: string | TestUser): Promise<RecordModel> {
  const user = typeof other === "string" ? other : other.user.id;
  return u.pb.send<RecordModel>("/api/chat/dms", { method: "POST", body: { user } });
}
