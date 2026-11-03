// Moderators (DESIGN.md §36) in a real browser: a superuser ticks the flag; the moderator deletes someone else's
// messages (one, and several selected), changes their room's access, archives it, and bans its author, whose open tab
// is signed out and who can't log in again until unbanned.

import { expect, type Page } from "@playwright/test";
import { SUPERUSER } from "../support/pocketbase.ts";
import { apiRoom, apiSend, apiUser, headerAction, login, message, openRoom, test, type User } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

async function admin(method: string, path: string, body: unknown) {
  const auth = await fetch(`${E2E_BASE}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
  });
  const { token } = (await auth.json()) as { token: string };
  const res = await fetch(`${E2E_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", Authorization: token },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
}

async function moderator(name = "Mod"): Promise<User> {
  const u = await apiUser(name);
  await admin("PATCH", `/api/collections/users/records/${u.id}`, { moderator: true });
  return u;
}

const authorMenu = (page: Page, text: string) => message(page, text).locator("details.author-menu");

test("a moderator deletes someone else's messages, one and several, and everyone sees it live", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const mod = await moderator();
  const room = await apiRoom(ada);
  await apiSend(ada, room, "spam one");
  await apiSend(ada, room, "spam two");
  await apiSend(ada, room, "spam three");
  const a = await openRoom(browser, ada, room);
  const m = await openRoom(browser, mod, room);

  const one = message(m, "spam one");
  await one.hover();
  await expect(one.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await one.getByRole("button", { name: "Delete" }).click();
  await one.getByRole("button", { name: "Delete message" }).click();
  await expect(a.locator("ol.messages li.msg").filter({ hasText: "spam one" })).toHaveCount(0);

  // Several, selected
  const two = message(m, "spam two");
  await two.hover();
  await two.getByRole("button", { name: "Select" }).click();
  await message(m, "spam three").click();
  await m
    .getByRole("button", { name: /^Delete/ })
    .last()
    .click();
  const confirm = m.getByRole("button", { name: /^Delete \d+ messages|^Delete$/ });
  if (await confirm.count()) await confirm.last().click();
  await expect(a.locator("ol.messages li.msg .body").filter({ hasText: /spam (two|three)/ })).toHaveCount(0);
});

test("a moderator changes someone else's room's access, starting in its member list, and archives it", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const mod = await moderator();
  const room = await apiRoom(ada);
  const m = await openRoom(browser, mod, room);
  await headerAction(m, "Room access…");
  const dialog = m.locator("dialog.access");
  await dialog.getByText("Private", { exact: true }).click();
  await expect(dialog).toContainText(ada.name);
  await expect(dialog).toContainText(`${mod.name} (you)`);
  await expect(dialog).toContainText("Only its creator and the people added will see this room.");
  await expect(dialog).not.toContainText("Unknown");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).not.toBeVisible();
  // Still theirs to see
  await expect(m.locator("header.room-header h1")).toContainText(`#${room.name}`);
  await expect(m.locator(".archived-banner, .room-gone, .not-found")).toHaveCount(0);
  await headerAction(m, "Archive room");
  await m.locator("header.room-header .menu-items").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(m.locator(".archived-banner")).toBeVisible();
  // Unarchive from the room list
  await headerAction(m, "Unarchive room");
  await expect(m.locator(".archived-banner")).toHaveCount(0);
});

test("a moderator bans an author: their open tab is signed out and they can't log in, until unbanned", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const mod = await moderator();
  const room = await apiRoom(mod);
  await apiSend(ada, room, "hello there");
  const a = await openRoom(browser, ada, room);
  const m = await openRoom(browser, mod, room);

  const menu = authorMenu(m, "hello there");
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Ban…" }).click();
  await expect(menu).toContainText("can't sign in until unbanned");
  await menu.getByRole("button", { name: "Ban", exact: true }).click();
  await expect(m.getByText("Banned. They can't sign in until unbanned.")).toBeVisible();

  // Ada's tab: signed out without her doing anything.
  await expect(
    a
      .getByRole("button", { name: "Log in" })
      .or(a.getByRole("link", { name: "Log in" }))
      .first(),
  ).toBeVisible({
    timeout: 20_000,
  });

  const again = await (await browser.newContext()).newPage();
  await again.goto("/login");
  await again.getByLabel("Email").fill(ada.email);
  await again.getByLabel("Password").fill(ada.password);
  await again.getByRole("button", { name: "Log in" }).click();
  await expect(again.getByText("This account is banned.")).toBeVisible();

  await menu.locator("summary").click(); // closed by the action: open again
  if (!(await menu.evaluate((d) => (d as HTMLDetailsElement).open))) await menu.locator("summary").click();
  await menu.getByRole("button", { name: "Unban" }).click();
  await expect(m.getByText("Unbanned.")).toBeVisible();
  await login(again, ada);
  await again.context().close();
});

test("others get no Ban, no Delete on others' messages and no access settings", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  await apiSend(ada, room, "plain");
  const b = await openRoom(browser, bob, room);
  const msg = message(b, "plain");
  await msg.hover();
  await expect(msg.getByRole("button", { name: "Delete" })).toHaveCount(0);
  const menu = authorMenu(b, "plain");
  await menu.locator("summary").click();
  await expect(menu.getByRole("button", { name: "Message" })).toBeVisible();
  await expect(menu.getByRole("button", { name: /Ban/ })).toHaveCount(0);
  await b.keyboard.press("Escape");
  await b.locator("header.room-header summary").click();
  await expect(b.locator("header.room-header .menu-items").getByRole("button", { name: /Room access|Archive room/ })).toHaveCount(0);
});
