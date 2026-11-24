// Linked instances (§33) in the browser: two servers of their own, paired, serving the built app. Ann on A and Bob on B
// share a room and talk in it live, and Ann finds Bob by his address for a DM. Each server's worker runs on a cron
// job; here a timer ticks both meanwhile, so nothing waits for the minute.

import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { disableRateLimits, enableFederation, freePort, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { apiRoom, apiUser, message, openRoom, send, test, uniq } from "./fixtures.ts";

interface Instance {
  server: PocketBaseServer;
  url: string;
  host: string;
  token: string;
}

let A: Instance;
let B: Instance;
let ticker: ReturnType<typeof setInterval> | undefined;

async function start(): Promise<Instance> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = await startPocketBase({
    port,
    publicDir: resolve("pb_public"),
    fixtureRoute: true,
    env: { FEDERATION_ALLOW_PRIVATE: "1" },
  });
  await disableRateLimits(url);
  await enableFederation(url);
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
  });
  const { token } = (await res.json()) as { token: string };
  return { server, url, host: `127.0.0.1:${port}`, token };
}

async function admin<T>(i: Instance, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${i.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: i.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const records = (c: string) => `/api/collections/${c}/records`;

test.describe.configure({ mode: "serial" });

let aPeer = "";

test.beforeAll(async () => {
  [A, B] = await Promise.all([start(), start()]);
  // A asks; the request shows on B, whose admin accepts it.
  const asked = await admin<{ id: string }>(A, "POST", records("fed_peers"), { origin: B.url, label: "B", dms: true });
  const filter = encodeURIComponent(`origin = "${A.url}"`);
  const { items } = await admin<{ items: { id: string }[] }>(B, "GET", `${records("fed_peers")}?filter=${filter}`);
  await admin(B, "PATCH", `${records("fed_peers")}/${items[0]?.id}`, { status: "active", label: "A", dms: true });
  aPeer = asked.id;
  ticker = setInterval(() => {
    for (const i of [A, B]) void admin(i, "POST", "/api/fed/tick").catch(() => {});
  }, 300);
});

test.afterAll(async () => {
  clearInterval(ticker);
  await Promise.all([A?.server.stop(), B?.server.stop()]);
});

test("a shared room: messages both ways live, people from the other instance say where they are from (§33.5)", async ({ browser }) => {
  const ann = await apiUser(`Ann ${uniq()}`, A.url);
  const bob = await apiUser(`Bob ${uniq()}`, B.url);
  const room = await apiRoom(ann, `linked-${uniq()}`, A.url);
  await admin(A, "POST", records("fed_shares"), { room: room.id, peer: aPeer });
  const offerOnB = async () =>
    (
      await admin<{ items: { id: string }[] }>(
        B,
        "GET",
        `${records("fed_shares")}?filter=${encodeURIComponent(`remote_id = "${room.id}@${A.host}"`)}`,
      )
    ).items[0]?.id ?? "";
  await expect.poll(offerOnB).not.toBe("");
  const offerId = await offerOnB();
  await admin(B, "PATCH", `${records("fed_shares")}/${offerId}`, { accepted: true });
  let mirrorId = "";
  await expect
    .poll(async () => {
      const row = await admin<{ room: string; state: string }>(B, "GET", `${records("fed_shares")}/${offerId}`);
      mirrorId = row.state === "active" ? row.room : "";
      return mirrorId;
    })
    .not.toBe("");

  const annPage = await openRoom(browser, ann, room, A.url);
  await expect(annPage.locator("header.room-header .room-shared")).toHaveText(`Shared with ${B.host}`);
  const bobPage = await openRoom(browser, bob, { id: mirrorId, name: `${room.name} (A)` }, B.url);
  await expect(bobPage.locator("header.room-header .room-shared")).toHaveText(`Shared with ${A.host}`);

  await send(bobPage, "hello from B");
  const there = message(annPage, "hello from B");
  await expect(there).toBeVisible({ timeout: 15_000 });
  const author = there.locator("button.author");
  await expect(author).toHaveText(`${bob.name} (B)`);
  await expect(author).toHaveAttribute("title", `Message ${bob.name} (B) · On ${B.host}`);

  await send(annPage, "hello from A");
  await expect(message(bobPage, "hello from A")).toBeVisible({ timeout: 15_000 });
  await expect(message(bobPage, "hello from A").locator(".author")).toContainText(`${ann.name} (A)`);
  await annPage.screenshot({ path: "test-results/linked-home.png" });
  await bobPage.screenshot({ path: "test-results/linked-mirror.png" });
});

test("a DM by address: name@host in New message (§33.5)", async ({ browser }) => {
  const ann = await apiUser(`Ann ${uniq()}`, A.url);
  const bob = await apiUser(`Bob ${uniq()}`, B.url);
  const annPage = await openRoom(browser, ann, await apiRoom(ann, `lobby-${uniq()}`, A.url), A.url);
  await annPage.getByRole("button", { name: "New message" }).click();
  await annPage.locator(".user-search input").fill(`${bob.name}@${B.host}`);
  const found = annPage.locator(".user-search button.person", { hasText: `${bob.name} (B)` });
  await expect(found).toBeVisible({ timeout: 15_000 });
  await expect(found).toHaveAttribute("title", `On ${B.host}`);
  await found.click();
  await expect(annPage.locator("header.room-header h1")).toContainText(`${bob.name} (B)`);
  await expect(annPage.locator("header.room-header .room-shared")).toHaveText(`Shared with ${B.host}`);
  await send(annPage, "hi Bob, from A");

  const bobPage = await openRoom(browser, bob, await apiRoom(bob, `lobby-${uniq()}`, B.url), B.url);
  const dm = bobPage.locator(".room-section a", { hasText: `${ann.name} (A)` });
  await expect(dm).toBeVisible({ timeout: 15_000 });
  await dm.click();
  await expect(message(bobPage, "hi Bob, from A")).toBeVisible({ timeout: 15_000 });
  await send(bobPage, "hi Ann");
  await expect(message(annPage, "hi Ann")).toBeVisible({ timeout: 15_000 });
  await annPage.screenshot({ path: "test-results/linked-dm.png" });
});
