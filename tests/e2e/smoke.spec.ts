import { expect } from "@playwright/test";
import { apiRoom, apiUser, atPath, login, test, uniq } from "./fixtures.ts";

test("app boots to the guest home (Open Air rooms) without console errors; Log in is one click away", async ({ page }) => {
  const errors: string[] = [];
  // WebKit doesn't know the viewport's interactive-widget (the keyboard resizes the page elsewhere), and says so.
  const ignored = /^Viewport argument key "interactive-widget" not recognized/;
  page.on("console", (m) => m.type() === "error" && !ignored.test(m.text()) && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Chirkle");
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Rooms" })).toContainText("Open Air rooms");
  await page.locator(".app-bar:visible, .side-foot").getByRole("link", { name: "Log in" }).click();
  await expect(page).toHaveURL(atPath("/login"));
  await expect(page.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Email")).toBeVisible();
  expect(errors).toEqual([]);
});

test("text is set in the app's own Inter, fetched from the app (§7.7), only the scripts a page shows", async ({ page }) => {
  const fonts: string[] = [];
  page.on("response", (r) => r.url().endsWith(".woff2") && fonts.push(new URL(r.url()).pathname));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => f.family.replace(/"/g, "") === "Inter" && f.status === "loaded").length;
  });
  expect(loaded).toBeGreaterThan(0);
  expect(fonts.some((p) => /^\/assets\/inter-latin-[A-Z0-9]{8}\.woff2$/.test(p))).toBe(true);
  expect(fonts.some((p) => p.includes("cyrillic"))).toBe(false);
});

test("a long room name is cut short in its row; the sidebar keeps its width", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada, `quarterly-planning-and-roadmap-discussion-${uniq()}`.slice(0, 48));
  await login(page, ada);
  const row = page.locator("aside.sidebar").getByRole("link", { name: room.name });
  await expect(row).toBeVisible();
  // It widened the sidebar (a flex item's min-width is its content's), squeezing the room next to it.
  expect((await page.locator("aside.sidebar").boundingBox())!.width).toBe(280);
  const name = row.locator("span").first();
  expect(await name.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
});
