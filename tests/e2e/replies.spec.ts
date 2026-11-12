import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { apiRoom, apiUser, composer, message, openRoom, seed, send, test } from "./fixtures.ts";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`replies (§19), ${colorScheme}: a reply quotes the original live for others; its quote goes back to it`, async ({ browser }) => {
    // ~9 s alone, ~4 s of it the two axe scans; with the rest of the suite running it went over 30 s (QA pass 14).
    test.slow();
    const ada = await apiUser("Ada");
    const bob = await apiUser("Bob");
    const room = await apiRoom(ada);
    seed(room, ada, 200, { text: (i) => `old ${i + 1}` });
    const a = await openRoom(browser, ada, room);
    const b = await openRoom(browser, bob, room);
    await a.emulateMedia({ colorScheme });

    await send(a, "who's up for lunch?");
    const original = message(b, "who's up for lunch?");
    await original.hover();
    await original.getByRole("button", { name: "Reply" }).click();
    await expect(b.locator(".replying")).toContainText("Replying to Ada");
    await expect(composer(b)).toBeFocused();
    await send(b, "me!");

    const reply = message(a, "me!");
    await expect(reply.locator(".reply-quote")).toHaveText(/Ada.*who's up for lunch\?/);
    expect(await seriousViolations(a), "quote").toEqual([]);

    // Ada replies to a message far back in history, then follows Bob's quote of it from the bottom.
    await a.locator("header.room-header summary").click();
    await a.locator(".menu-items").getByRole("button", { name: "Jump to beginning" }).click();
    const old = message(a, /^old 2$/);
    await old.hover();
    await old.getByRole("button", { name: "Reply" }).click();
    await expect(a.locator(".replying")).toBeVisible();
    expect(await seriousViolations(a), "reply bar and quotes").toEqual([]);
    await send(a, "remember this?");
    const quote = message(b, "remember this?").locator(".reply-quote");
    await expect(quote).toContainText("old 2");
    await quote.click();
    await expect(message(b, /^old 2$/)).toHaveClass(/target/);
    await expect(message(b, /^old 2$/)).toBeInViewport();
    await expect(message(b, "remember this?")).toHaveCount(0); // the window moved back in history
  });
}

test("QA BUG-271: a long quote stays within its message, also when the reply continues a group", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const a = await openRoom(browser, ada, room);
  await send(a, `a long one: ${"and on ".repeat(40)}`);
  const original = message(a, "a long one");
  await original.hover();
  await original.getByRole("button", { name: "Reply" }).click();
  await send(a, "continuing"); // Ada's own message right after hers: no name, no avatar
  const reply = message(a, "continuing");
  await expect(reply).not.toHaveClass(/group-start/);
  const [right, edge] = await reply.evaluate((li) => {
    const box = li.getBoundingClientRect();
    return [li.querySelector(".reply-quote")!.getBoundingClientRect().right, box.right - parseFloat(getComputedStyle(li).paddingRight)];
  });
  expect(right).toBeLessThanOrEqual(edge + 0.5); // was 32px past it
});
