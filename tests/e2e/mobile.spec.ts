import { expect } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiSend, apiUser, atPath, attach, login, message, send, test, uniq } from "./fixtures.ts";

// No isMobile: Firefox does not support it, and CI runs all three engines. Viewport + touch is what matters here.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test("on a phone: list → room → send → back to the list", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await login(page, ada);
  // No key hints on a touch screen: not the sidebar's Jump to row's either (QA BUG-266).
  await expect(page.getByRole("button", { name: "Jump to" }).first()).toBeVisible();
  await expect(page.locator("kbd:visible")).toHaveCount(0);

  await page.getByRole("link", { name: room.name }).tap();
  await expect(page.locator("header.room-header h1")).toHaveText(`#${room.name}`);
  await expect(page.locator("aside.sidebar")).toBeHidden();

  const form = await page.locator("form.composer").boundingBox();
  expect(form).not.toBeNull();
  expect(form!.y + form!.height).toBeLessThanOrEqual(844 + 1);

  await send(page, "sent from my phone");
  await expect(message(page, "sent from my phone")).toBeVisible();
  // touch screens have no hover: tapping a message shows its actions, tapping it again or elsewhere hides them
  // (toBeVisible() treats opacity:0 as visible, so check the computed opacity of the actions bar)
  const mine = message(page, "sent from my phone");
  const actions = mine.locator(".actions");
  await expect(actions).toHaveCSS("opacity", "0");
  await mine.locator(".body").tap();
  await expect(actions).toHaveCSS("opacity", "1");
  await mine.locator(".body").tap();
  await expect(actions).toHaveCSS("opacity", "0");
  await mine.locator(".body").tap();
  await expect(actions).toHaveCSS("opacity", "1");
  await page.locator("header.room-header h1").tap();
  await expect(actions).toHaveCSS("opacity", "0");

  // BUG-32: another user's long name truncates; their message time stays on screen
  const long = await apiUser("Bartholomew Longname-Smithson");
  await apiSend(long, room, "from a long name");
  const theirs = message(page, "from a long name");
  await expect(theirs).toBeVisible();
  const time = await theirs.locator(".meta time").boundingBox();
  expect(time!.x + time!.width).toBeLessThanOrEqual(390);

  // attachments work on a phone too (§17.4)
  await attach(page, [{ name: "phone.png", mimeType: "image/png", buffer: Buffer.from(PNG) }]);
  await send(page, "with a picture");
  await expect(message(page, "with a picture").locator(".att-tile img")).toBeVisible();

  await page.getByRole("link", { name: "Back to rooms" }).tap();
  await expect(page).toHaveURL(atPath("/"));
  await expect(page.getByRole("navigation", { name: "Rooms" })).toBeVisible();
  // A phone shows only the list; the welcome is out of sight, its heading kept as the page's h1 for a screen reader.
  await expect(page.locator("section.welcome p")).toBeHidden();
  await expect(page.locator(".layout.home .pane")).toHaveCSS("clip-path", "inset(50%)");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Welcome/);
});

test("on a phone, a tapped message's buttons: on screen, gone when you're done, only on messages that have some", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  for (let i = 1; i <= 30; i++) await apiSend(ada, room, `msg ${i}`);
  await login(page, ada);
  await page.getByRole("link", { name: room.name }).tap();
  const shown = (m: ReturnType<typeof message>) =>
    m.locator(".actions").evaluate((a) => getComputedStyle(a).opacity === "1" && a.getBoundingClientRect().height > 2);

  // The last message's buttons show below it: scrolled into view, not left under the composer.
  const last = message(page, "msg 30");
  await last.locator(".body").tap();
  const bar = await last.locator(".actions").boundingBox();
  const form = await page.locator("form.composer").boundingBox();
  expect(bar!.y + bar!.height).toBeLessThanOrEqual(form!.y);

  // Done with React: focus goes back to its button, which must not keep the buttons up.
  await last.getByRole("button", { name: "Add reaction" }).tap();
  await page.getByRole("dialog", { name: "Add reaction" }).getByRole("button", { name: "🎉" }).first().tap();
  await expect(last.locator(".reactions .reaction")).toHaveCount(1);
  expect(await shown(last)).toBe(false);

  // A reaction chip redraws its message: tapping one keeps that message's buttons, one on another message hides them.
  const other = message(page, "msg 29");
  await other.locator(".body").tap();
  await other.getByRole("button", { name: "Add reaction" }).tap();
  await page.getByRole("dialog", { name: "Add reaction" }).getByRole("button", { name: "🎉" }).first().tap();
  await last.locator(".body").tap();
  await last.locator(".reactions .reaction").tap();
  expect(await shown(last)).toBe(true);
  await other.locator(".reactions .reaction").tap();
  expect(await shown(last)).toBe(false);

  // A deleted message has no buttons, so it doesn't light up.
  await other.locator(".body").tap();
  await other.getByRole("button", { name: "Delete", exact: true }).tap();
  await other.getByRole("button", { name: "Delete message" }).tap();
  const deleted = page.locator("li.msg", { hasText: "Message deleted" });
  await deleted.locator(".body").tap();
  await expect(deleted).not.toHaveClass(/touched/);
});

test("on a phone, focusing a text field can't zoom the page in: fields are 16px, double-tap zoom is off", async ({ page }) => {
  // iOS Safari zooms in on focus when a field's text is under 16px (and stays zoomed). Chromium doesn't, so check the
  // cause: every field's computed size. Pinch zoom deliberately stays available (WCAG 1.4.4).
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await page.goto("/login");
  const sizes = () => page.locator("input:not([type=file]), textarea").evaluateAll((els) => els.map((e) => getComputedStyle(e).fontSize));
  for (const size of await sizes()) expect(parseFloat(size)).toBeGreaterThanOrEqual(16);

  await login(page, ada);
  await page.getByRole("link", { name: room.name }).tap();
  await expect(page.locator("form.composer textarea")).toHaveCSS("font-size", "16px");
  await page.getByRole("link", { name: "Back to rooms" }).tap();
  await page.locator("button.new-room-toggle").tap();
  for (const size of await sizes()) expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
  await expect(page.locator("html")).toHaveCSS("touch-action", "manipulation");
  const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(viewport).not.toMatch(/user-scalable\s*=\s*no|maximum-scale/);
});

test("on a phone, a long room name in the composer's placeholder ends in …, and the selection bar is one line", async ({ page }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada, `quarterly-planning-and-roadmap-${uniq()}`);
  await apiSend(ada, room, "pick me");
  await login(page, ada);
  await page.getByRole("link", { name: room.name }).tap();
  // Browsers ignore text-overflow on a textarea's placeholder: it was cut off mid-word (composer.ts fits it).
  const box = page.locator("form.composer textarea");
  await expect(box).toHaveAttribute("placeholder", /^Message #quarterly.*…$/);

  // Selecting: the count and Forward, Delete and Cancel on one line (Cancel wrapped onto a line of its own).
  const mine = message(page, "pick me");
  await mine.locator(".body").tap();
  await mine.getByRole("button", { name: "Select" }).tap();
  const bar = page.getByRole("toolbar", { name: "Selected messages" });
  const tops = await bar
    .locator("span, button:visible")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
  expect(new Set(tops.map((t) => Math.round(t / 10))).size).toBe(1);
});
