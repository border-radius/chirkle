import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { apiRoom, apiUser, composer, message, openRoom, send, test } from "./fixtures.ts";

async function seriousViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`reactions and emoji (§20), ${colorScheme}: emoji in a message; reactions show live and survive a reload`, async ({ browser }) => {
    // Two axe scans, two users and a reload: about 30 s in Firefox under a full run's load.
    test.slow();
    const ada = await apiUser("Ada");
    const bob = await apiUser("Bob");
    const room = await apiRoom(ada);
    const a = await openRoom(browser, ada, room);
    const b = await openRoom(browser, bob, room);
    await a.emulateMedia({ colorScheme });

    // The composer's emoji button inserts at the caret.
    await composer(a).fill("ship it ");
    await a.getByRole("button", { name: "Emoji" }).click();
    const picker = a.getByRole("dialog", { name: "Insert emoji" });
    await expect(picker).toBeVisible();
    await expect(picker).toBeInViewport();
    expect(await seriousViolations(a), "emoji picker").toEqual([]);
    // Its search box finds emoji by name (§20.6); Enter picks the first found.
    await picker.getByRole("searchbox", { name: "Search emoji" }).fill("rock");
    await expect(picker.getByRole("button", { name: "🚀" })).toBeVisible();
    await expect(picker.getByRole("button", { name: "🍕" })).toBeHidden();
    await picker.getByRole("searchbox", { name: "Search emoji" }).press("Enter");
    await expect(picker).toBeHidden();
    await expect(composer(a)).toHaveValue("ship it 🚀");
    await composer(a).press("Enter");

    // Emoji by name while typing (§20.6): ":tad" offers 🎉, and Enter puts it in rather than sending.
    await composer(a).pressSequentially("so :tad");
    const names = a.getByRole("listbox", { name: "Emoji" });
    await expect(names.getByRole("option", { name: "🎉 tada" })).toHaveAttribute("aria-selected", "true");
    expect(await seriousViolations(a), "emoji by name").toEqual([]);
    await composer(a).press("Enter");
    await expect(names).toBeHidden();
    await expect(composer(a)).toHaveValue("so 🎉 ");
    await composer(a).fill("");

    // Bob reacts twice from the picker; Ada sees both live, then adds hers to one.
    const forBob = message(b, "ship it 🚀");
    await forBob.hover();
    await forBob.getByRole("button", { name: "Add reaction" }).click();
    await b.getByRole("dialog", { name: "Add reaction" }).getByRole("button", { name: "🎉" }).click();
    // Now also the ☺+ after the reactions. (Not the toolbar one: the pointer left the message, so that is hidden.)
    await forBob.getByRole("group", { name: "Reactions" }).getByRole("button", { name: "Add reaction" }).click();
    // Keyboard: ↓ from the search box goes to the first emoji (or the most recent one); arrows move, Enter picks.
    await b.getByRole("dialog", { name: "Add reaction" }).getByRole("searchbox").press("ArrowDown");
    await b.keyboard.press("ArrowRight");
    await b.keyboard.press("Enter");
    const bobs = forBob.locator(".reaction");
    await expect(bobs).toHaveCount(2);

    const forAda = message(a, "ship it 🚀");
    await expect(forAda.locator(".reaction")).toHaveCount(2);
    const party = forAda.getByRole("button", { name: "🎉 1 reaction" });
    await expect(party).toHaveAttribute("aria-pressed", "false");
    await expect(party).toHaveAttribute("title", "Bob reacted with 🎉");
    await party.click();
    await expect(forAda.getByRole("button", { name: "🎉 2 reactions" })).toHaveAttribute("aria-pressed", "true");
    await expect(forBob.getByRole("button", { name: "🎉 2 reactions" })).toHaveAttribute("aria-pressed", "true");
    expect(await seriousViolations(a), "reactions").toEqual([]);

    await b.reload();
    await expect(message(b, "ship it 🚀").getByRole("button", { name: "🎉 2 reactions" })).toBeVisible();
    await expect(message(b, "ship it 🚀").locator(".reaction")).toHaveCount(2);

    // Bob takes his 🎉 back.
    await message(b, "ship it 🚀").getByRole("button", { name: "🎉 2 reactions" }).click();
    await expect(forAda.getByRole("button", { name: "🎉 1 reaction" })).toHaveAttribute("title", "You reacted with 🎉");
    await send(a, "done");
  });
}
