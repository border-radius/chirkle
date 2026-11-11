import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import { apiRoom, apiSend, apiUser, composer, message, openRoom, send, test } from "./fixtures.ts";

const SHOTS = process.env.E2E_SHOTS;

test("mentions (§41): @ suggests people, the mention is highlighted for them, the room gets an @, and Mentions & replies lists it", async ({
  browser,
}) => {
  test.slow();
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  await apiSend(bob, room, "hello room");
  const a = await openRoom(browser, ada, room);

  // Ada types "@" and the start of Bob's handle: Bob is offered; Enter puts his handle in.
  await composer(a).fill("");
  await composer(a).pressSequentially(`thanks @${bob.handle.slice(0, 2)}`);
  const people = a.locator('ul.emoji-suggest[aria-label="People"]');
  await expect(people).toBeVisible();
  await expect(people.getByRole("option").first()).toContainText(`@${bob.handle}`);
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/mention-suggest.png` });
  await composer(a).press("Enter");
  await expect(composer(a)).toHaveValue(`thanks @${bob.handle} `);
  await composer(a).press("Enter");
  await expect(message(a, "thanks").locator(".mention")).toHaveText(`@${bob.handle}`);

  // Bob, elsewhere: the room has an @ and the sidebar's Mentions & replies a count.
  const other = await apiRoom(bob);
  const b = await openRoom(browser, bob, other);
  const row = b.locator(`[data-room-id="${room.id}"]`);
  await expect(row.locator(".badge").first()).toHaveText(/^@/);
  const inbox = b.locator('[data-section="inbox"] a');
  await expect(inbox).toContainText("1 new");
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/sidebar.png` });

  await inbox.click();
  await expect(b.locator("h1")).toHaveText("Mentions & replies");
  const item = b.locator(".inbox-list li").first();
  await expect(item).toContainText(`Ada mentioned you in #${room.name}`);
  await expect(item).toHaveClass(/new/);
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/inbox.png` });
  await expect(inbox).not.toContainText("new");

  // Following it opens the message in its room, highlighted as to you.
  await item.locator("a").click();
  await expect(message(b, "thanks")).toHaveClass(/to-me/);
  await expect(message(b, "thanks").locator(".mention.me")).toHaveText(`@${bob.handle}`);
  // Readable in both themes, on a message tinted as yours (QA BUG-262: 4.14:1 light, 4.33:1 dark).
  for (const colorScheme of ["light", "dark"] as const) {
    await b.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    const { violations } = await new AxeBuilder({ page: b }).include(".to-me").withRules(["color-contrast"]).analyze();
    expect(violations.flatMap((v) => v.nodes.map((n) => `${colorScheme}: ${n.target.join(" ")}`))).toEqual([]);
  }
  if (SHOTS) await b.screenshot({ path: `${SHOTS}/room.png` });
  await send(b, "you're welcome");
});
