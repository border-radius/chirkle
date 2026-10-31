// §22: unique display names, changing your password, drafts across reloads, the unread favicon, focus on entering a
// room, "Jump to latest", and the forward confirmation going away.
import { expect } from "@playwright/test";
import {
  apiRoom,
  apiSend,
  apiUser,
  atPath,
  composer,
  login,
  logOut,
  message,
  messages,
  openRoom,
  seed,
  send,
  test,
  uniq,
} from "./fixtures.ts";

test("change your password on the profile page, then log in with the new one", async ({ page }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  await login(page, ada);
  await page.locator("a.me-link:visible").click();
  const form = page.locator("form.profile-password");
  await form.getByLabel("Current password").fill("not-it-at-all");
  await form.getByLabel("New password", { exact: true }).fill("brand-new-pass");
  await form.getByLabel("Confirm new password").fill("brand-new-pass");
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form).toContainText("That isn't your current password.");

  await form.getByLabel("Current password").fill(ada.password);
  await form.getByRole("button", { name: "Change password" }).click();
  await expect(form).toContainText("Password changed.");
  // Still logged in here, with a session that works.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await logOut(page);
  await expect(page).toHaveURL(atPath("/"));
  await login(page, { ...ada, password: "brand-new-pass" });
});

test("a display name that is taken is refused at sign up", async ({ page }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  await page.goto("/login");
  await page.getByRole("tab", { name: "Sign up" }).click();
  await page.getByLabel("Display name").fill(ada.name.toLowerCase());
  await page.getByLabel("Email").fill(`${uniq()}@test.local`);
  await page.getByLabel("Password").fill("password-123");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText("This display name is taken. Choose another one.")).toBeVisible();
  await expect(page).toHaveURL(atPath("/login"));
});

test("an unsent message survives a reload; entering a room puts the caret in the composer", async ({ browser }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  const one = await apiRoom(ada);
  const two = await apiRoom(ada);
  const page = await openRoom(browser, ada, one);
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("half written");
  await page.reload();
  await expect(composer(page)).toHaveValue("half written");
  await expect(composer(page)).toBeFocused();

  await page.locator("aside.sidebar").getByRole("link", { name: two.name }).click();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${two.name}`);
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("");
  await page.goBack();
  await expect(composer(page)).toHaveValue("half written");
  await composer(page).press("Enter");
  await expect(message(page, "half written")).toBeVisible();
  await page.reload();
  await expect(composer(page)).toHaveValue("");
  await page.context().close();
});

test("the tab shows how many messages are unread, in the favicon and the title", async ({ browser }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  const bob = await apiUser(`Bob ${uniq()}`);
  const room = await apiRoom(bob);
  const home = await apiRoom(ada);
  const page = await openRoom(browser, ada, home);
  let open = home.name; // the title names the open room
  // Other specs post in their own public rooms meanwhile, which count too: compare with the room list's badges.
  const tab = () =>
    page.evaluate(() => {
      const badges = [...document.querySelectorAll("aside.sidebar .badge")].map((b) => Number.parseInt(b.textContent ?? "", 10));
      const icon = decodeURIComponent(document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href);
      return { title: document.title, icon: icon.match(/>([^<]*)<\/text>/)?.[1] ?? "", sum: badges.reduce((a, b) => a + b, 0) };
    });
  const consistent = async () => {
    const t = await tab();
    const label = t.sum > 99 ? "99+" : t.sum ? String(t.sum) : "";
    return t.title === `${label ? `(${label}) ` : ""}#${open} – Chirkle` && t.icon === label;
  };
  await expect.poll(consistent).toBe(true);

  await apiSend(bob, room, "one");
  await apiSend(bob, room, "two");
  const badge = page.locator("aside.sidebar li").filter({ hasText: room.name }).locator(".badge");
  await expect(badge).toContainText("2");
  await expect.poll(consistent).toBe(true);
  await expect(page).toHaveTitle(new RegExp(`^\\(\\d+\\+?\\) #${home.name} – Chirkle$`));

  // Reading the room takes its messages off the count.
  await page.locator("aside.sidebar").getByRole("link", { name: room.name }).click();
  open = room.name;
  await expect(badge).toHaveCount(0);
  await expect.poll(consistent).toBe(true);
  await page.context().close();
});

test("scrolled up, 'Jump to latest' takes you back down; a forward confirmation goes away", async ({ browser }) => {
  const ada = await apiUser(`Ada ${uniq()}`);
  const room = await apiRoom(ada);
  seed(room, ada, 60);
  const page = await openRoom(browser, ada, room);
  const jump = page.getByRole("button", { name: "Jump to latest" });
  await expect(jump).toBeHidden();
  await page.locator("ol.messages").evaluate((el) => el.scrollTo(0, 0));
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  await expect(messages(page).last()).toBeInViewport();

  await send(page, "pass it on");
  await message(page, "pass it on").hover();
  await message(page, "pass it on").getByRole("button", { name: "Forward" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: `# ${room.name}` })
    .click();
  const notice = page.locator(".room-notice");
  await expect(notice).toHaveText("Message forwarded.");
  await expect(notice).toBeHidden({ timeout: 8000 });
  await page.context().close();
});
