// Room invite links (§44): the creator makes one in the access dialog; someone without a session opens it, logs in,
// comes back to it, joins and lands in the room.
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page } from "@playwright/test";
import { apiUser, atPath, headerAction, login, send, test, uniq } from "./fixtures.ts";

const newPage = async (browser: Browser): Promise<Page> => (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
const axe = (page: Page, include: string) =>
  new AxeBuilder({ page })
    .include(include)
    .analyze()
    .then((r) => r.violations.map((v) => v.id));

test("an invite link: made in the dialog, opened logged out, joined after logging in (§44)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const [a, b] = await Promise.all([newPage(browser), newPage(browser)]);
  await login(a, ada);

  const name = `club-${tag}`;
  await a.getByRole("button", { name: "New room" }).click();
  await a.getByLabel("Room name").fill(name);
  await a.locator("form.new-room .seg label", { hasText: "Private" }).click();
  await a.getByRole("button", { name: "Create" }).click();
  await expect(a.locator("header.room-header h1")).toContainText("Private");
  await send(a, "welcome, everyone");

  await headerAction(a, "Room access…");
  const dialog = a.locator("dialog.access");
  const invite = dialog.locator(".invite");
  await invite.getByLabel("Works for").selectOption("1");
  await invite.getByRole("button", { name: "Create link" }).click();
  await expect(invite.getByRole("status")).toHaveText("The link is ready to share.");
  const link = await invite.locator(".invite-url").inputValue();
  expect(link).toMatch(/\/invite\/[A-Za-z0-9]{24}$/);
  expect(await axe(a, "dialog.access")).toEqual([]);

  // Bob, logged out, opens it: asked to log in, and back here after.
  await b.goto(link);
  await expect(b.getByRole("heading", { name: `Join #${name}` })).toBeVisible();
  await expect(b.getByText(`${ada.name} invited you to this private room. 1 member`)).toBeVisible();
  expect(await axe(b, ".invite-page")).toEqual([]);
  await b.locator(".invite-page").getByRole("link", { name: "log in" }).click();
  await b.getByLabel("Email").fill(bob.email);
  await b.getByLabel("Password").fill(bob.password);
  await b.getByRole("button", { name: "Log in" }).click();
  await expect(b).toHaveURL(atPath(new URL(link).pathname));
  await b.getByRole("button", { name: "Join the room" }).click();

  await expect(b.locator("header.room-header h1")).toContainText(`#${name}`);
  await expect(b.locator("li.msg", { hasText: "welcome, everyone" })).toBeVisible();
  await expect(b.locator('[data-section="rooms"] li', { hasText: name })).toHaveCount(1);

  // Ada's dialog counts him once it is opened again; the link opened again takes him to the room.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await headerAction(a, "Room access…");
  await expect(invite.locator(".invite-meta")).toContainText("1 person joined by it");
  await expect(dialog.locator(".members .member")).toHaveCount(2);
  await b.goto(link);
  await expect(b.getByText("You're in this room already.")).toBeVisible();

  // Revoked, it doesn't work.
  await invite.getByRole("button", { name: "Revoke" }).click();
  await expect(invite.getByRole("status")).toHaveText("The link no longer works.");
  await b.reload();
  await expect(b.getByRole("heading", { name: "This invite link doesn't work" })).toBeVisible();
});
