import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiSend, apiUser, attach, login, send, test } from "./fixtures.ts";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("login, rooms, room and archived room have no serious accessibility violations", async ({ page }) => {
      // Six axe scans and the wait for the "New" line: over 30 s under a full run's load.
      test.slow();
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Welcome!" })).toBeVisible();
      expect(await seriousViolations(page), "guest home").toEqual([]);
      await page.goto("/login");
      await expect(page.getByLabel("Email")).toBeVisible();
      expect(await seriousViolations(page), "login").toEqual([]);

      const ada = await apiUser("Ada");
      const bob = await apiUser("Bob");
      const room = await apiRoom(ada);
      const archived = await apiRoom(ada);
      await apiSend(ada, room, "hello");
      await apiSend(bob, room, "hi there");
      await login(page, ada);
      expect(await seriousViolations(page), "rooms").toEqual([]);

      await page.goto(`/r/${room.id}`);
      await expect(page.locator("li.msg")).toHaveCount(2);
      expect(await seriousViolations(page), "room").toEqual([]);

      // attachments: a sent image + file, and a filled tray (§17)
      const files = [
        { name: "a.png", mimeType: "image/png", buffer: Buffer.from(PNG) },
        { name: "b.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF") },
      ];
      await attach(page, files);
      await send(page, "files");
      await expect(page.locator(".att-tile")).toHaveCount(1);
      await attach(page, files);
      // Not while the "New" line fades out (§22): text half faded is low contrast by design.
      await expect(page.locator("li.new-line")).toHaveCount(0, { timeout: 10_000 });
      expect(await seriousViolations(page), "attachments").toEqual([]);

      await page.goto(`/r/${archived.id}`);
      await page.locator("header.room-header summary").click();
      await page.locator(".menu-items").getByRole("button", { name: "Archive room" }).click();
      await page.locator(".menu-items").getByRole("button", { name: "Archive", exact: true }).click();
      await expect(page.locator(".archived-banner")).toBeVisible();
      expect(await seriousViolations(page), "archived room").toEqual([]);

      // Jump to, its picked row with a note ("Archived") on the row's tint (QA BUG-202).
      await page.keyboard.press("Control+k");
      const jump = page.getByRole("dialog", { name: "Jump to" });
      await jump.locator("input").fill(archived.name);
      await expect(jump.locator('[aria-selected="true"] small')).toHaveText(/Archived/);
      expect(await seriousViolations(page), "jump to").toEqual([]);
      await page.keyboard.press("Escape");

      // A DM, with the user search open in the sidebar.
      await page.goto("/");
      await page.getByRole("button", { name: "New message" }).click();
      await page.getByLabel("Find someone to message").fill("Bob");
      await expect(page.locator(".user-search button.person").first()).toBeVisible();
      expect(await seriousViolations(page), "user search").toEqual([]);
      await page.locator(".user-search button.person", { hasText: "Bob" }).first().click();
      await expect(page.locator("header.room-header h1")).toContainText("Bob");
      expect(await seriousViolations(page), "dm").toEqual([]);

      await page.goto("/me");
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      expect(await seriousViolations(page), "profile").toEqual([]);
    });
  });
}
