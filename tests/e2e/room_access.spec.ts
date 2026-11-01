// Room access (§23): private rooms with chosen members, Open Air rooms that guests read without an account.
import AxeBuilder from "@axe-core/playwright";
import { type Browser, expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import {
  apiRoom,
  apiSend,
  apiUser,
  atPath,
  attach,
  composer,
  headerAction,
  login,
  message,
  openRoom,
  send,
  test,
  uniq,
} from "./fixtures.ts";

const newPage = async (browser: Browser): Promise<Page> => (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();

const row = (page: Page, name: string) => page.locator('[data-section="rooms"] li', { hasText: name });

test("a private room: only the people its creator adds see it; someone taken out loses it live (§23.1, §23.2)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const cat = await apiUser(`Cat ${tag}`);
  const [a, b, c] = await Promise.all([newPage(browser), newPage(browser), newPage(browser)]);
  await Promise.all([login(a, ada), login(b, bob), login(c, cat)]);

  // Ada creates it private from the sidebar.
  const name = `secret-${tag}`;
  await a.getByRole("button", { name: "New room" }).click();
  await a.getByLabel("Room name").fill(name);
  await a.locator("form.new-room .seg label", { hasText: "Private" }).click();
  await a.getByRole("button", { name: "Create" }).click();
  await expect(a.locator("header.room-header h1")).toContainText("Private");
  await expect(row(a, name).locator(".vis")).toHaveText("(Private)");
  await send(a, "just us");

  // Bob isn't in it yet.
  await expect(row(b, name)).toHaveCount(0);

  // Ada adds Bob.
  await headerAction(a, "Room access…");
  const dialog = a.locator("dialog.access");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Private/ })).toBeChecked();
  await expect(dialog.locator(".member")).toHaveText([new RegExp(`${ada.name}.*creator`, "i")]);
  await dialog.getByRole("button", { name: "Add people" }).click();
  await dialog.getByLabel("Find someone to message").fill(`Bob ${tag}`);
  await dialog.locator("button.person", { hasText: bob.name }).click();
  await expect(dialog.locator(".member")).toHaveCount(2);
  // Escape in the people search closes the search, not the dialog (and keeps what was chosen).
  await dialog.getByLabel("Find someone to message").press("Escape");
  await expect(dialog.locator(".user-search")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add people" })).toBeFocused();
  expect(
    await new AxeBuilder({ page: a })
      .include("dialog.access")
      .analyze()
      .then((r) => r.violations.map((v) => v.id)),
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Bob gets it live, with its history; Cat never does.
  await expect(row(b, name)).toBeVisible();
  await row(b, name).locator("a").click();
  await expect(message(b, "just us")).toBeVisible();
  await send(b, "hi Ada");
  await expect(message(a, "hi Ada")).toBeVisible();
  await expect(row(c, name)).toHaveCount(0);
  await c.goto(a.url());
  await expect(c.getByText("This room doesn't exist.")).toBeVisible();

  // Bob can see who is in it, not change it.
  await headerAction(b, "Members (2)");
  const bobDialog = b.locator("dialog.access");
  await expect(bobDialog.locator(".member")).toHaveCount(2);
  await expect(bobDialog.getByRole("radio")).toHaveCount(0);
  await expect(bobDialog.getByRole("button", { name: "Save" })).toBeHidden();
  await expect(bobDialog.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
  await bobDialog.getByRole("button", { name: "Close" }).click();

  // Ada takes Bob out while he is reading it.
  await headerAction(a, "Room access…");
  await dialog.getByRole("button", { name: `Remove ${bob.name}` }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(b.getByText("You can't see this room any more.")).toBeVisible();
  await expect(b.locator("ol.messages")).toHaveCount(0);
  await expect(row(b, name)).toHaveCount(0);
});

test("Open Air: a guest reads a room live, attachments included, then logs in and lands back in it (§23.3)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const room = await apiRoom(ada, `town-square-${tag}`);
  const hidden = await apiRoom(ada, `members-${tag}`);
  await apiSend(ada, room, "welcome, everyone");
  await apiSend(ada, hidden, "not for guests");

  const guest = await newPage(browser);
  const errors: string[] = [];
  guest.on("pageerror", (e) => errors.push(e.message));
  await guest.goto("/");
  await expect(row(guest, room.name)).toHaveCount(0);

  // Ada opens the room to everyone.
  const a = await newPage(browser);
  await login(a, ada);
  await a.goto(`/r/${room.id}`);
  await headerAction(a, "Room access…");
  const dialog = a.locator("dialog.access");
  await dialog.getByRole("radio", { name: /Open Air/ }).check();
  await expect(dialog.locator(".access-warning")).toContainText("anyone on the web");
  await expect(dialog.locator(".members")).toBeHidden();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(a.locator("header.room-header h1")).toContainText("Open Air");
  await attach(a, [{ name: "map.png", mimeType: "image/png", buffer: Buffer.from(PNG) }]);
  await send(a, "here's the map");

  // The guest gets it live, reads it, and sees the picture, but can't write or react.
  await expect(row(guest, room.name).locator(".vis")).toHaveText("(Open Air)");
  await expect(row(guest, hidden.name)).toHaveCount(0);
  await row(guest, room.name).locator("a").click();
  await expect(message(guest, "welcome, everyone")).toBeVisible();
  await expect(message(guest, "welcome, everyone").locator(".author")).toHaveText(ada.name);
  const map = message(guest, "here's the map");
  await expect
    .poll(() => map.locator(".att-tile img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  await expect(guest.locator("form.composer")).toHaveCount(0);
  await expect(guest.locator(".guest-banner")).toContainText("Log in or sign up to join the conversation.");
  await expect(map.locator(".actions")).toHaveCount(0);
  await apiSend(ada, room, "live for guests too");
  await expect(message(guest, "live for guests too")).toBeVisible();

  // A link to a room that needs an account says so.
  await guest.goto(`/r/${hidden.id}`);
  await expect(guest.getByText("This room doesn't exist.")).toBeVisible();
  await expect(guest.getByText("not for guests")).toHaveCount(0);

  // Logging in from the room takes the guest back to it, ready to write.
  const cat = await apiUser(`Cat ${tag}`);
  await guest.goto(`/r/${room.id}`);
  await guest.locator(".guest-banner").getByRole("link", { name: "Log in" }).click();
  await guest.getByLabel("Email").fill(cat.email);
  await guest.getByLabel("Password").fill(cat.password);
  await guest.getByRole("button", { name: "Log in" }).click();
  await expect(guest).toHaveURL(atPath(`/r/${room.id}`));
  await send(guest, "hello from Cat");
  await expect(message(a, "hello from Cat")).toBeVisible();
  expect(errors).toEqual([]);
});

test("Open Air rooms leave a guest's view as soon as they close to guests (§23.4)", async ({ browser }) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const room = await apiRoom(ada, `open-${tag}`);
  const a = await newPage(browser);
  await login(a, ada);
  await a.goto(`/r/${room.id}`);
  await headerAction(a, "Room access…");
  await a
    .locator("dialog.access")
    .getByRole("radio", { name: /Open Air/ })
    .check();
  await a.locator("dialog.access").getByRole("button", { name: "Save" }).click();
  // The dialog is modal: the composer takes keys once it has closed.
  await expect(a.locator("dialog.access")).toBeHidden();
  await send(a, "open for now");
  await expect(message(a, "open for now")).not.toHaveClass(/pending/);

  const guest = await newPage(browser);
  await guest.goto(`/r/${room.id}`);
  await expect(message(guest, "open for now")).toBeVisible();

  // Archived: gone for guests.
  await headerAction(a, "Archive room");
  await a.locator(".menu-items").getByRole("button", { name: "Archive", exact: true }).click();
  await expect(guest.getByText("You can't see this room any more.")).toBeVisible();
  await expect(row(guest, room.name)).toHaveCount(0);

  // Unarchived: back in the guest's list, live, and on the guest's screen again.
  await headerAction(a, "Unarchive room");
  await expect(row(guest, room.name)).toBeVisible();
  await expect(message(guest, "open for now")).toBeVisible();
  await row(guest, room.name).locator("a").click();
  await expect(message(guest, "open for now")).toBeVisible();

  // Made public (members only): gone again.
  await headerAction(a, "Room access…");
  await a
    .locator("dialog.access")
    .getByRole("radio", { name: /^Public/ })
    .check();
  await a.locator("dialog.access").getByRole("button", { name: "Save" }).click();
  await expect(guest.getByText("You can't see this room any more.")).toBeVisible();
  await expect(composer(a)).toBeVisible();
});

test("only the people its creator chooses post; the others read and react, and get the composer once chosen (§23.6)", async ({
  browser,
}) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const room = await apiRoom(ada, `news-${tag}`);
  await apiSend(ada, room, "welcome");
  const [a, b] = await Promise.all([openRoom(browser, ada, room), openRoom(browser, bob, room)]);
  await expect(composer(b)).toBeVisible();

  await headerAction(a, "Room access…");
  const dialog = a.locator("dialog.access");
  await dialog.getByRole("radio", { name: /Only people you choose/ }).check();
  await expect(dialog.locator(".writers .member")).toHaveText([new RegExp(`${ada.name}.*creator`, "i")]);
  expect(
    await new AxeBuilder({ page: a })
      .include("dialog.access")
      .analyze()
      .then((r) => r.violations.map((v) => v.id)),
  ).toEqual([]);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  // Bob loses the composer live, but still reacts; Ada still posts.
  await expect(b.locator("footer .reader-banner")).toHaveText(/Only some people can post in this room/);
  await expect(composer(b)).toHaveCount(0);
  await message(b, "welcome").hover();
  await expect(message(b, "welcome").getByRole("button", { name: "Reply" })).toHaveCount(0);
  await expect(message(b, "welcome").getByRole("button", { name: "Add reaction" })).toHaveCount(1);
  await send(a, "only from me");
  await expect(message(b, "only from me")).toBeVisible();

  // Chosen, he gets it back.
  await headerAction(a, "Room access…");
  await dialog.locator(".writers").getByRole("button", { name: "Add people" }).click();
  await dialog.getByLabel("Find someone to message").fill(`Bob ${tag}`);
  await dialog.locator("button.person", { hasText: bob.name }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(composer(b)).toBeVisible();
  await send(b, "thanks");
  await expect(message(a, "thanks")).toBeVisible();
});
