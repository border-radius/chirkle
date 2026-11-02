import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, openRoom, seed, test } from "./fixtures.ts";

test("unread badges (§18): live count, cleared by opening the room, kept across reloads and tabs", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  // Bob is in another room; Ada writes in `room`.
  const b = await openRoom(browser, bob, lobby);
  const row = b.locator(`li[data-room-id="${room.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator(".badge")).toHaveCount(0);

  await apiSend(ada, room, "one");
  await apiSend(ada, room, "two");
  await expect(row.locator(".badge")).toHaveText("2 unread", { timeout: 2_000 });

  await b.reload();
  await expect(row.locator(".badge")).toHaveText("2 unread");

  // A second tab of Bob's, still in the lobby, sees the badge go when the first tab opens the room.
  const b2 = await b.context().newPage();
  await b2.goto(`/r/${lobby.id}`);
  const row2 = b2.locator(`li[data-room-id="${room.id}"]`);
  await expect(row2.locator(".badge")).toHaveText("2 unread");

  await row.getByRole("link").click();
  await expect(b.locator("ol.messages")).toContainText("two");
  await expect(row2.locator(".badge")).toHaveCount(0, { timeout: 3_000 });

  // Back in the lobby: nothing unread, and new messages count again.
  await b.goto(`/r/${lobby.id}`);
  await expect(row.locator(".badge")).toHaveCount(0);
  await apiSend(ada, room, "three");
  await expect(row.locator(".badge")).toHaveText("1 unread", { timeout: 2_000 });
});

test("QA: scrolled up in history, a new message stays unread until you scroll down to it", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  seed(room, ada, 60, { startAt: Date.now() - 60_000, stepMs: 900 });
  const b = await openRoom(browser, bob, room);
  const row = b.locator(`li[data-room-id="${room.id}"]`);
  // Leaving the room inside the app (not a page load, which would drop a read still being batched).
  const toLobby = () => b.locator(`li[data-room-id="${lobby.id}"]`).getByRole("link").click();
  await b.locator("ol.messages").evaluate((el) => (el.scrollTop = 0));
  await apiSend(ada, room, "unseen");
  await expect(b.locator("button.new-messages")).toBeVisible();
  await b.waitForTimeout(1_500); // longer than the read batching
  await toLobby();
  await expect(row.locator(".badge")).toHaveText("1 unread", { timeout: 2_000 });

  // Back in the room and down to the bottom: read.
  await row.getByRole("link").click();
  await expect(b.locator("ol.messages")).toContainText("unseen");
  await toLobby();
  await expect(row.locator(".badge")).toHaveCount(0);
});

test("§18.5: clicking a room with a badge opens it at the first unread message, under a New line that goes", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  seed(room, ada, 40, { startAt: Date.now() - 60_000, stepMs: 900 }); // before Bob signed up: never unread
  const bob = await apiUser("Bob");
  const b = await openRoom(browser, bob, lobby);
  for (let i = 1; i <= 25; i++) await apiSend(ada, room, `unread ${i}`);
  const row = b.locator(`li[data-room-id="${room.id}"]`);
  await expect(row.locator(".badge")).toHaveText("25 unread", { timeout: 3_000 });

  await row.getByRole("link").click();
  const list = b.locator("ol.messages");
  const line = list.locator("li.new-line");
  await expect(line).toBeVisible();
  await expect(line).toHaveText("New");
  // Right over the first unread message, which is on screen; the newest one is further down.
  await expect(line.locator("+ li.msg")).toContainText("unread 1");
  await expect(list.locator("li.msg", { hasText: /unread 1\b/ })).toBeInViewport();
  await expect(list.locator("li.msg", { hasText: "unread 25" })).not.toBeInViewport();
  await expect(line).toHaveCount(0, { timeout: 7_000 });
});

test("§18.3: opening a room reads only what is on screen; scrolling down reads the rest", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const lobby = await apiRoom(ada);
  const bob = await apiUser("Bob");
  const b = await openRoom(browser, bob, lobby);
  for (let i = 1; i <= 25; i++) await apiSend(ada, room, `unread ${i}`);
  const row = b.locator(`li[data-room-id="${room.id}"]`);
  await expect(row.locator(".badge")).toHaveText("25 unread", { timeout: 3_000 });
  const toLobby = () => b.locator(`li[data-room-id="${lobby.id}"]`).getByRole("link").click();

  await row.getByRole("link").click();
  const list = b.locator("ol.messages");
  await expect(list.locator("li.msg", { hasText: /unread 1\b/ })).toBeInViewport();
  await expect(list.locator("li.msg", { hasText: "unread 25" })).not.toBeInViewport();
  // 2026-11-02: open, it keeps its badge and its place at the top while messages below are unread, the badge coming
  // down to what is left once the read is in.
  const badgeOf = (r: typeof row) => async () =>
    Number.parseInt(
      (await r
        .locator(".badge")
        .textContent({ timeout: 1_000 })
        .catch(() => "0")) ?? "0",
      10,
    );
  await expect.poll(badgeOf(row), { timeout: 3_000 }).toBeLessThan(25);
  expect(await badgeOf(row)()).toBeGreaterThan(0);
  // Among the unread rooms at the top (the shared server has others): every row above it has a badge too.
  expect(
    await row.evaluate((li) =>
      [...li.parentElement!.children].slice(0, [...li.parentElement!.children].indexOf(li)).every((x) => x.querySelector(".badge")),
    ),
  ).toBe(true);
  await b.waitForTimeout(1_500); // longer than the read batching
  await toLobby();
  // What was on screen is read, the messages below it aren't (the count is refetched once the read is in).
  const badge = async () =>
    Number.parseInt(
      (await row
        .locator(".badge")
        .textContent({ timeout: 1_000 })
        .catch(() => "0")) ?? "0",
      10,
    );
  await expect.poll(badge, { timeout: 3_000 }).toBeLessThan(25);
  const left = await badge();
  expect(left).toBeGreaterThan(0);

  // Back in the room, it opens at the first message still unread; scrolled to the bottom, all of them are read.
  await row.getByRole("link").click();
  await expect(list.locator("li.new-line + li.msg")).toContainText(`unread ${26 - left}`);
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(list.locator("li.msg", { hasText: "unread 25" })).toBeInViewport();
  await b.waitForTimeout(1_500);
  await toLobby();
  await expect(row.locator(".badge")).toHaveCount(0, { timeout: 3_000 });
});
