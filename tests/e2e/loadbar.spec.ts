import { expect, type Page } from "@playwright/test";
import { apiRoom, apiSend, apiUser, login, test } from "./fixtures.ts";

/** Set to a folder to save what the lines look like. */
const SHOTS = process.env.LOADBAR_SHOTS;

/** Hold the requests to `url` until the returned function is called; then let them through. */
async function hold(page: Page, url: RegExp): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(url, async (route) => {
    await held;
    await route.continue();
  });
  return release;
}

test("a slow fetch shows a thin line over the room list and over the room (§7.9)", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await apiSend(ada, room, "hello");
  const listBar = page.locator(".rooms > .loadbar");
  const roomBar = page.locator(".room-body > .loadbar");
  const row = page.locator("aside.sidebar").getByRole("link", { name: room.name });

  // The room list takes a while: the line shows over it until it is in. The room's messages too (held from the
  // start: once the list is in, the app fetches rooms ahead).
  const pageIn = await hold(page, /\/api\/chat\/rooms\/[^/]+\/messages/);
  const listIn = await hold(page, /\/api\/chat\/rooms\?/);
  await login(page, ada);
  await expect(listBar).toHaveClass(/\bon\b/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/list.png` });
  listIn();
  await expect(row).toBeVisible();
  await expect(listBar).not.toHaveClass(/\bon\b/);

  // The room's messages are still out: the line shows over the room.
  await row.click();
  await expect(roomBar).toHaveClass(/\bon\b/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/room.png` });
  pageIn();
  await expect(page.locator("ol.messages li.msg")).toContainText("hello");
  await expect(roomBar).not.toHaveClass(/\bon\b/);
});
