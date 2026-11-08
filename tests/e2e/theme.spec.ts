import { expect, type Page } from "@playwright/test";
import { apiUser, login, test } from "./fixtures.ts";

const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const LIGHT = "rgb(251, 250, 255)"; // --bg, tokens.css
const DARK = "rgb(26, 27, 30)"; // --bg dark, #1a1b1e

test.use({ colorScheme: "light" });

test("Appearance on the profile page picks Light, Dark or the system's theme, and a reload keeps it (§7.8)", async ({ page }) => {
  const blocked: string[] = [];
  page.on("console", (m) => /Content Security Policy/i.test(m.text()) && blocked.push(m.text()));
  await login(page, await apiUser("Ada"));
  await page.goto("/me");
  const appearance = page.getByRole("group", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: "Auto" })).toBeChecked();
  expect(await bg(page)).toBe(LIGHT);

  await appearance.getByText("Dark", { exact: true }).click();
  await expect.poll(() => bg(page)).toBe(DARK);
  // The inline script sets it before the first paint: no flash of the light theme, and the CSP lets it run.
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  expect(await bg(page)).toBe(DARK);

  // Auto follows the system again, whichever it is.
  await page.getByRole("group", { name: "Appearance" }).getByText("Auto", { exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => bg(page)).toBe(DARK);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => bg(page)).toBe(LIGHT);

  // Light wins over a dark system.
  await page.getByRole("group", { name: "Appearance" }).getByText("Light", { exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await bg(page)).toBe(LIGHT);
  expect(blocked).toEqual([]);
});

test("a profile page taller than the window scrolls on its own; the sidebar stays (QA BUG-135)", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 560 });
  await login(page, await apiUser("Ada"));
  await page.goto("/me");
  await expect(page.getByRole("button", { name: "Log out" })).toBeAttached();
  await page.getByRole("button", { name: "Log out" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Log out" })).toBeInViewport();
  const box = await page.evaluate(() => {
    const side = document.querySelector(".sidebar")!.getBoundingClientRect();
    const pane = document.querySelector(".pane")!;
    return {
      sideTop: side.top,
      sideBottom: side.bottom,
      mainScrolled: document.querySelector(".app-main")!.scrollTop,
      paneScrolled: pane.scrollTop,
    };
  });
  expect(box.paneScrolled).toBeGreaterThan(0);
  expect(box.mainScrolled).toBe(0);
  expect(box.sideBottom).toBe(560);
});
