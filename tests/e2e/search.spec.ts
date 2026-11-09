import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, message, openRoom, seed, test } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

test("search (§29): finds a room's messages in any case and goes to the one picked, far back in history", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  seed(room, ada, 200, { text: (i) => (i === 3 ? "Встреча в ПЯТНИЦУ" : `old ${i + 1}`) });
  await apiSend(ada, room, "встреча moved, see above");
  const page = await openRoom(browser, ada, room);

  await page.getByRole("button", { name: "Search messages" }).click();
  const field = page.getByRole("searchbox", { name: "Search messages" });
  await expect(field).toBeFocused();
  await field.fill("встреча пятницу");
  const results = page.getByRole("list", { name: "Search results" }).locator(".search-result");
  await expect(results).toHaveCount(1);
  await expect(results.first().locator("mark")).toHaveText(["Встреча", "ПЯТНИЦУ"]);
  const { violations } = await new AxeBuilder({ page }).include(".room-search").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);

  // The people search (forward dialog, new DM) shares its class names, not its 45vh scroll box (QA BUG-115).
  // The forward dialog is a lazy chunk since 2026-11-10 (not in the page until Forward): a list of its classes stands in.
  const maxHeight = await page.evaluate(() => {
    const ul = document.createElement("ul");
    ul.className = "search-results forward-list";
    document.body.append(ul);
    const v = getComputedStyle(ul).maxHeight;
    ul.remove();
    return v;
  });
  expect(maxHeight).toBe("none");

  await results.first().click();
  await expect(message(page, "Встреча в ПЯТНИЦУ")).toHaveClass(/target/);
  await expect(message(page, "Встреча в ПЯТНИЦУ")).toBeInViewport();
  await expect(results.first()).toBeHidden();

  await field.fill("встреча");
  await expect(results).toHaveCount(2);
  await expect(results.first()).toContainText("встреча moved");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Search messages" })).toBeFocused();
});

test("search (§29) in a DM finds only that conversation's messages", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const res = await fetch(`${E2E_BASE}/api/chat/dms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: ada.token },
    body: JSON.stringify({ user: bob.id }),
  });
  expect(res.ok).toBe(true);
  const dm = (await res.json()) as { id: string; name: string };
  await apiSend(bob, dm, "the wifi password is on the fridge");
  const room = await apiRoom(ada);
  await apiSend(ada, room, "wifi is down again");
  const page = await openRoom(browser, ada, dm);

  await page.getByRole("button", { name: "Search messages" }).click();
  const field = page.getByRole("searchbox", { name: "Search messages" });
  await expect(field).toHaveAttribute("placeholder", "Search Bob");
  await field.fill("WIFI");
  await field.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "found" })).toHaveText("1 message found.");
  await expect(page.locator(".search-result")).toHaveText([/Bob.*the wifi password is on the fridge/]);
});
