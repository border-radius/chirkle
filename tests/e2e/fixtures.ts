// Helpers for e2e specs: users and rooms are created through the real REST API (fast setup);
// everything a spec asserts on goes through the real UI in a real browser.

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Browser, type BrowserContext, test as base, expect, type Locator, type Page } from "@playwright/test";
import { newId } from "../../web/src/lib/id.ts";
import { foldKey } from "../../web/src/views/room/search.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { E2E_BASE, E2E_DATA_DIR } from "./paths.ts";

export { uniq } from "../support/ids.ts";

export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  token: string;
}
export interface Room {
  id: string;
  name: string;
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}, base = E2E_BASE): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.token ? { authorization: init.token } : {}) },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Frees the name first if an earlier test took it (support/names.ts). */
export async function apiUser(name = "User", base = E2E_BASE): Promise<User> {
  const email = `user-${uniq()}@test.local`; // not derived from the name, which may contain markup
  const password = "password-123";
  await withName(base, name, () =>
    call(
      "/api/collections/users/records",
      { method: "POST", body: JSON.stringify({ email, password, passwordConfirm: password, name }) },
      base,
    ),
  );
  const auth = await call<{ token: string; record: { id: string } }>(
    "/api/collections/users/auth-with-password",
    { method: "POST", body: JSON.stringify({ identity: email, password }) },
    base,
  );
  return { id: auth.record.id, name, email, password, token: auth.token };
}

export async function apiRoom(owner: User, name = `room-${uniq()}`, base = E2E_BASE): Promise<Room> {
  return call<Room>(
    "/api/collections/rooms/records",
    { method: "POST", token: owner.token, body: JSON.stringify({ name, created_by: owner.id }) },
    base,
  );
}

export async function apiSend(user: User, room: Room, text: string): Promise<{ id: string; text: string }> {
  return call("/api/collections/messages/records", {
    method: "POST",
    token: user.token,
    body: JSON.stringify({ room: room.id, author: user.id, text }),
  });
}

/**
 * Insert `n` messages oldest-first, `stepMs` apart (default: one minute, ending in the past).
 * Fixture data: no hooks, no realtime events. Written straight into data.db, which also works while the server is down
 * (reconnect.spec.ts); a write from outside can make one of the server's transactions fail now and then
 * (docs/REFACTOR.md item 30), so it is only for histories too long to create through the API.
 */
export function seed(
  room: Room,
  author: User,
  n: number,
  opts: { text?: (i: number) => string; dataDir?: string; startAt?: number; stepMs?: number } = {},
): string[] {
  const { text = (i: number) => `history ${i + 1}`, dataDir = E2E_DATA_DIR, stepMs = 60_000 } = opts;
  const out: string[] = [];
  const db = new DatabaseSync(join(dataDir, "data.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    const ins = db.prepare(
      "INSERT INTO messages (id, room, author, text, text_key, edited_at, deleted, deleted_at, created, updated) VALUES (?, ?, ?, ?, ?, '', 0, '', ?, ?)",
    );
    const start = opts.startAt ?? Date.now() - (n + 1) * stepMs;
    for (let i = 0; i < n; i++) {
      const ts = new Date(start + i * stepMs).toISOString().replace("T", " ");
      ins.run(newId(), room.id, author.id, text(i), foldKey(text(i)), ts, ts);
      out.push(text(i));
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return out;
}

/** Log in through the real form. */
/** For `toHaveURL`: the page is `path` (exactly, or matching), with no old-style `#/` hash (§7.1). */
export const atPath =
  (path: string | RegExp) =>
  (url: URL): boolean =>
    !url.hash && (typeof path === "string" ? url.pathname === path : path.test(url.pathname));

export async function login(page: Page, user: User, base = ""): Promise<void> {
  await page.goto(`${base}/login`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(atPath("/"));
}

/** Log out the way a user does: Log out is on the profile page (§22.2). */
export async function logOut(page: Page): Promise<void> {
  await page.locator("a.me-link:visible").click();
  await page.getByRole("button", { name: "Log out" }).click();
}

/** The contexts openRoom() made in the running test. */
const opened = new Set<BrowserContext>();

/**
 * Playwright's `test`, which closes the contexts openRoom() made once the test is over. The worker's browser outlives
 * the test, and so did they: by the end of a run each worker had ~20 earlier users online, all fetching a busy room's
 * page at once on each of its messages, which made later specs time out (QA pass 14). Specs import `test` from here.
 */
export const test = base.extend<{ closeOpened: undefined }, { firefoxBlankFirst: undefined }>({
  /**
   * Playwright's Firefox misses "load" on a new page's first goto now and then (1 in 5 here, any page, even a bare
   * one), and the test hangs until its timeout. Going to about:blank first doesn't. Every new page, the `page`
   * fixture's too, starts there.
   */
  firefoxBlankFirst: [
    async ({ browser, browserName }, use) => {
      if (browserName === "firefox") {
        const ctx = await browser.newContext();
        const proto = Object.getPrototypeOf(ctx) as BrowserContext;
        await ctx.close();
        const newPage = proto.newPage;
        proto.newPage = async function (this: BrowserContext) {
          const page = await newPage.call(this);
          await page.goto("about:blank");
          return page;
        };
      }
      await use(undefined);
    },
    { scope: "worker", auto: true },
  ],
  closeOpened: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern
    async ({}, use) => {
      await use(undefined);
      await Promise.all([...opened].map((ctx) => ctx.close().catch(() => {})));
      opened.clear();
    },
    { auto: true },
  ],
});

/** A new browser context logged in as `user`, opened on `room` or a DM (no name) (closed after the test). */
export async function openRoom(browser: Browser, user: User, room: Room, base = ""): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  opened.add(ctx);
  const page = await ctx.newPage();
  await login(page, user, base);
  await page.goto(`${base}/r/${room.id}`);
  if (room.name) await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(page.locator("ol.messages")).toHaveAttribute("aria-busy", "false");
  return page;
}

export const messages = (page: Page): Locator => page.locator("ol.messages li.msg");
export const message = (page: Page, text: string | RegExp): Locator =>
  page.locator("ol.messages li.msg").filter({ has: page.locator(".body", { hasText: text }) });
export const composer = (page: Page): Locator => page.locator("form.composer textarea");

export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

/** Open the room header menu and click an item. */
export async function headerAction(page: Page, label: string): Promise<void> {
  await page.locator("header.room-header summary").click();
  // The item's name starts with its label; a hint or a value may follow it ("Room access… Private").
  const name = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`);
  await page.locator("header.room-header .menu-items").getByRole("button", { name }).click();
}

/** Attach files through the composer's (hidden) file input, and wait for them to show in the tray. */
export async function attach(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const before = await page.locator(".tray-item").count();
  await page.locator("form.composer input[type=file]").setInputFiles(files);
  await expect(page.locator(".tray-item")).toHaveCount(before + files.length);
}
