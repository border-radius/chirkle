import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, composer, login, message, send, test, uniq, urlOf } from "./fixtures.ts";

test("direct messages: start one from the user search, reply live, private to the two, reopen on a new message (§16)", async ({
  browser,
}) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const cat = await apiUser(`Cat ${tag}`);
  await apiRoom(ada); // something in the public list

  const ctx = async () => (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const a = await ctx();
  const b = await ctx();
  const c = await ctx();
  await Promise.all([login(a, ada), login(b, bob), login(c, cat)]);

  // Ada starts the DM from the sidebar's user search.
  await a.getByRole("button", { name: "New message" }).click();
  await a.getByLabel("Find someone to message").fill(`Bob ${tag}`);
  await a.locator(".user-search button.person", { hasText: bob.name }).click();
  await expect(a.locator("header.room-header h1")).toHaveText(new RegExp(bob.name));
  await expect(composer(a)).toHaveAttribute("placeholder", `Message ${bob.name}`);
  const dmUrl = await urlOf(a);
  await send(a, "psst, Bob");

  // Bob sees the DM appear in his sidebar live, opens it and replies.
  const bobRow = b.locator('[data-section="dms"] li', { hasText: ada.name });
  await expect(bobRow).toBeVisible();
  await bobRow.locator("a").click();
  await expect(message(b, "psst, Bob")).toBeVisible();
  await send(b, "hi Ada");
  await expect(message(a, "hi Ada")).toBeVisible();

  // Cat never sees it, and its URL is "not found" for her.
  await expect(c.locator('[data-section="dms"] li')).toHaveCount(0);
  await c.goto(dmUrl);
  await expect(c.getByText("This room doesn't exist.")).toBeVisible();

  // Bob closes it; Ada writes again and it comes back for Bob.
  await b.locator("header.room-header summary").click();
  await b.locator("header.room-header .menu-items").getByRole("button", { name: "Close conversation" }).click();
  await expect(bobRow).toHaveCount(0);
  await send(a, "still there?");
  await expect(bobRow).toBeVisible();
});

test("Message from an author's name opens the DM (§16.5)", async ({ browser }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  const bob = await apiUser(`Bob ${uniq()}`);
  const room = await apiRoom(ada);
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  await login(page, ada);
  await page.goto(`/r/${room.id}`);
  await apiSend(bob, room, "ping");
  const theirs = message(page, "ping");
  await theirs.locator("summary.author").click();
  await theirs.getByRole("button", { name: "Message" }).click();
  await expect(page.locator("header.room-header h1")).toHaveText(new RegExp(bob.name));
  await expect(page.locator(`[data-section="dms"] li`, { hasText: bob.name }).locator("a")).toHaveAttribute("aria-current", "page");
});
