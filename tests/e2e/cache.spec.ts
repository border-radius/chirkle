import { expect, type Page } from "@playwright/test";
import { apiRoom, apiSend, apiUser, login, logOut, message, openRoom, test } from "./fixtures.ts";

/** Hold every message list request until the returned function is called (a slow network). */
async function holdMessages(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/chat/rooms/*/messages?**", async (route) => {
    await held;
    await route.continue().catch(() => {}); // the page may have gone on meanwhile
  });
  return release;
}

/** How many rooms the cache (IndexedDB) keeps, or with `roomId`, the texts it keeps for that room. */
const kept = (page: Page, roomId?: string) =>
  page.evaluate(
    (roomId) =>
      new Promise<number | string[]>((resolve, reject) => {
        const req = indexedDB.open("chat", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("rooms");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const store = req.result.transaction("rooms").objectStore("rooms");
          const get = roomId ? store.get(roomId) : store.count();
          get.onsuccess = () => {
            req.result.close();
            const r = get.result as number | { items: { text: string }[] } | undefined;
            resolve(typeof r === "number" ? r : (r?.items.map((m) => m.text) ?? []));
          };
        };
      }),
    roomId,
  );

test("a room opens at once from the cache, after switching and after a reload, and the cache goes with the session (§7.5)", async ({
  page,
}) => {
  const ada = await apiUser("Ada");
  const first = await apiRoom(ada);
  const second = await apiRoom(ada);
  await apiSend(ada, first, "kept from last time");
  await apiSend(ada, second, "in the second room");
  await login(page, ada);
  await page.goto(`/r/${first.id}`);
  await expect(message(page, "kept from last time")).toBeVisible();

  // Switching back while no page can come: the room was kept live (PERF.md §5), with what came meanwhile.
  await page.locator(`a[href="/r/${second.id}"]`).click();
  await expect(message(page, "in the second room")).toBeVisible();
  await apiSend(ada, first, "sent meanwhile");
  await page.waitForTimeout(500); // the live event
  let release = await holdMessages(page);
  await page.locator(`a[href="/r/${first.id}"]`).click();
  await expect(message(page, "kept from last time")).toBeVisible();
  await expect(message(page, "sent meanwhile")).toBeVisible();
  release();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // After a reload too, before the room list is in (the window is saved a second after it last changed: a reload
  // sooner may show it without its newest message, which the first page then brings).
  await expect.poll(() => kept(page, first.id)).toContain("sent meanwhile");
  release = await holdMessages(page);
  await page.reload();
  await expect(message(page, "kept from last time")).toBeVisible();
  release();
  await expect(message(page, "sent meanwhile")).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });

  await logOut(page);
  await expect.poll(() => kept(page)).toBe(0);
});

test("a room with unread messages is prefetched: opening it shows them at once (§7.5)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  const page = await openRoom(browser, bob, lobby);
  const row = page.locator(`li[data-room-id="${room.id}"]`);

  // Bob has never opened the room: all he got is the unread event, without its text.
  await apiSend(ada, room, "new while away");
  await expect(row.locator(".badge")).toHaveText("1 unread", { timeout: 2_000 });
  await expect.poll(() => kept(page, room.id)).toEqual(["new while away"]);

  const release = await holdMessages(page);
  await row.getByRole("link").click();
  await expect(message(page, "new while away")).toBeVisible();
  // Seen, though the first page never came: back in the lobby, the room isn't unread.
  await page.locator(`li[data-room-id="${lobby.id}"]`).getByRole("link").click();
  await page.waitForTimeout(500);
  await expect(row.locator(".badge")).toHaveCount(0);
  release();
  await page.close();
});

test("after a reload, a kept room shows before the server has answered anything, then goes to its first unread message (§7.5, §18.5)", async ({
  browser,
}) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  for (let i = 1; i <= 30; i++) await apiSend(ada, room, `older ${i}`);
  const bob = await apiUser("Bob"); // nothing is unread for him yet (counts start at signup)
  const page = await openRoom(browser, bob, room);
  await expect(message(page, "older 30")).toBeVisible();
  // Bob reads elsewhere while Ada writes: the room is prefetched with what she wrote.
  const lobby = await apiRoom(ada);
  await page.locator(`a[href="/r/${lobby.id}"]`).click();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${lobby.name}`);
  await apiSend(ada, room, "unread one");
  await apiSend(ada, room, "unread two");
  await expect.poll(() => kept(page, room.id)).toContain("unread two");

  // Every API request is held: the room, its header and its messages come from the cache alone.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/**", async (route) => {
    await held;
    await route.continue().catch(() => {});
  });
  await page.goto(`/r/${room.id}`);
  // Sent once the page is gone: kept live in the room left open (PERF.md §5), it would be in the cache already.
  await apiSend(ada, room, "unread three");
  await expect(message(page, "unread two")).toBeVisible();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(message(page, "unread three")).toHaveCount(0);
  release();
  await expect(message(page, "unread three")).toBeVisible();
  await expect(page.locator("li.new-line + li.msg .body")).toHaveText("unread one");
  await page.close();
});

test("QA BUG-104: leaving the page right after a message keeps the room with it (§7.5)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await apiSend(ada, room, "first");
  await login(page, ada);
  await page.goto(`/r/${room.id}`);
  await expect(message(page, "first")).toBeVisible();
  await apiSend(ada, room, "just now");
  await expect(message(page, "just now")).toBeVisible();
  await page.goto("/"); // within the second after which it would be kept anyway
  await expect.poll(() => kept(page, room.id)).toContain("just now");
});

test("QA BUG-102: a reload into a prefetched room with many unread messages leaves unread what was never on screen (§18.5)", async ({
  browser,
}) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  await apiSend(ada, room, "read already");
  const page = await openRoom(browser, bob, room);
  await page.locator(`a[href="/r/${lobby.id}"]`).click();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${lobby.name}`);
  for (let i = 1; i <= 60; i++) await apiSend(ada, room, `unread ${i}`);
  // A burst is fetched once, and again only 30 s later (QA BUG-108); the counts loaded at start fetch it at once.
  await page.reload();
  await expect.poll(() => kept(page, room.id), { timeout: 10_000 }).toContain("unread 60");

  // Where the unread messages start comes late: the kept window shows at the bottom meanwhile.
  await page.route("**/api/chat/unread/**", async (route) => {
    await new Promise((r) => setTimeout(r, 1000));
    await route.continue().catch(() => {});
  });
  await page.goto(`/r/${room.id}`);
  await expect(page.locator("li.new-line + li.msg .body")).toHaveText("unread 1");
  await page.waitForTimeout(1500); // reads go out a second after they are seen
  await page.locator(`a[href="/r/${lobby.id}"]`).click();
  await expect(page.locator(`a[href="/r/${room.id}"] .badge`)).toBeVisible();
  await page.close();
});
