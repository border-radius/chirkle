import { expect } from "@playwright/test";
import { test } from "./fixtures.ts";

test("a new version (§27.4): a line says so when index.html names another build, and Reload loads it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
  await expect(page.locator(".update-bar")).toHaveCount(0);

  // A deploy: the page the app checks now names another script. Navigations still get the real one.
  await page.route("/", async (route) => {
    if (route.request().isNavigationRequest()) return route.continue();
    const res = await route.fetch();
    const body = (await res.text()).replace(/\/assets\/app-[^"]+\.js/, "/assets/app-NEWBUILD.js");
    await route.fulfill({ response: res, body });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  const bar = page.locator("#app > .update-bar");
  await expect(bar).toContainText("A new version of the app is out.");
  await expect(bar).toHaveAttribute("role", "status");
  await page.screenshot({ path: test.info().outputPath("update-bar.png") });
  await bar.getByRole("link", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
  await expect(page.locator(".update-bar")).toHaveCount(0);
});
