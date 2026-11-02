import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { apiRoom, apiSend, apiUser, composer, message, messages, openRoom, test, uniq, urlOf } from "./fixtures.ts";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`selecting messages (§21), ${colorScheme}: forward several into a DM, delete several of your own`, async ({ browser }) => {
    const ada = await apiUser("Ada");
    const bob = await apiUser(`Bob ${uniq()}`);
    const room = await apiRoom(ada);
    await apiSend(bob, room, "lunch at noon?");
    await apiSend(ada, room, "sure");
    await apiSend(ada, room, "typo");
    await apiSend(ada, room, "another typo");
    const a = await openRoom(browser, ada, room);
    await a.emulateMedia({ colorScheme });

    // Ada selects two messages, one of them Bob's: she can forward them, but not delete them.
    await message(a, "lunch at noon?").hover();
    await message(a, "lunch at noon?").getByRole("button", { name: "Select" }).click();
    await message(a, "sure").click();
    const bar = a.getByRole("toolbar", { name: "Selected messages" });
    await expect(bar).toContainText("2 selected");
    await expect(composer(a)).toBeHidden();
    await expect(bar.getByRole("button", { name: "Delete" })).toBeHidden();
    // Not while the "New" line fades out (§22): text half faded is low contrast by design.
    await expect(a.locator("li.new-line")).toHaveCount(0, { timeout: 10_000 });
    expect(await seriousViolations(a), "selecting").toEqual([]);

    // Forward them to Bob, whom she has no DM with yet: found by name.
    await bar.getByRole("button", { name: "Forward" }).click();
    const dialog = a.getByRole("dialog", { name: "Forward 2 messages" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("searchbox", { name: "Search rooms and people" }).fill(bob.name);
    expect(await seriousViolations(a), "forward dialog").toEqual([]);
    await dialog.getByRole("button", { name: bob.name }).click();
    await expect.poll(async () => new URL(await urlOf(a)).pathname).toMatch(/^\/r\/\w+$/);
    await expect(messages(a)).toHaveCount(2);
    await expect(messages(a).first()).toContainText(`Forwarded from ${bob.name}`);
    await expect(messages(a).first()).toContainText("lunch at noon?");
    await expect(messages(a).last()).toContainText("Forwarded from Ada");
    const dm = await urlOf(a);

    // Bob gets them live in the DM.
    const b = await openRoom(browser, bob, room);
    await b.goto(dm);
    await expect(message(b, "lunch at noon?")).toContainText(`Forwarded from ${bob.name}`);

    // Back in the room, Ada deletes her two typos at once; Bob sees them go.
    await a.goBack();
    await b.goBack();
    await message(a, "another typo").hover();
    await message(a, "another typo").getByRole("button", { name: "Select" }).click();
    await message(a, /^.*typo$/)
      .filter({ hasNotText: "another" })
      .getByRole("checkbox")
      .check();
    await bar.getByRole("button", { name: "Delete" }).click();
    await bar.getByRole("button", { name: "Delete" }).click();
    await expect(bar).toBeHidden();
    await expect(composer(a)).toBeVisible();
    await expect(message(b, "Message deleted")).toHaveCount(2);
    await expect(message(b, "sure")).toBeVisible();
  });
}
