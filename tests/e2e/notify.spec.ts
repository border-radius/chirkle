import { expect, type Page } from "@playwright/test";
import { apiRoom, apiSend, apiUser, atPath, login, test, type User, uniq } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

// Notifications (DESIGN.md §34): turned on in the profile page, a pop-up for a DM and for a reply to you while the
// tab is in the background, made by the page itself from its realtime connection: no push service.
//
// Headless Chromium says "denied" to every notification, granted or not, so the page's Notification and the service
// worker registration's showNotification/getNotifications are stand-ins that record what the app asks for (as the
// system would: one per tag). sw.ts's click handler has a unit test (tests/unit/sw.test.ts).

interface Made {
  title: string;
  body: string;
  tag: string;
  url: string;
  closed: boolean;
  via: "page" | "worker";
}

/** The page records its pop-ups (`window.made`) and believes it is behind another window. */
async function recordPopups(page: Page) {
  await page.addInitScript(() => {
    const made: (Made & { close(): void; click(): void })[] = [];
    (window as unknown as { made: typeof made }).made = made;
    const record = (title: string, opts: NotificationOptions, via: Made["via"], click: () => void) => {
      for (const m of made) if (m.tag === opts.tag) m.closed = true; // the newer replaces it
      const m = {
        title,
        body: opts.body ?? "",
        tag: opts.tag ?? "",
        url: (opts.data as { url?: string } | undefined)?.url ?? "",
        closed: false,
        via,
        close: () => {
          m.closed = true;
        },
        click,
      };
      made.push(m);
      return m;
    };
    // Granted for the tab, across its page loads.
    class Recorded {
      static get permission() {
        return sessionStorage.getItem("test.permission") ?? "default";
      }
      static requestPermission = async () => {
        sessionStorage.setItem("test.permission", "granted");
        return "granted";
      };
      onclick: (() => void) | null = null;
      close: () => void;
      constructor(title: string, opts: NotificationOptions = {}) {
        this.close = record(title, opts, "page", () => this.onclick?.()).close;
      }
    }
    window.Notification = Recorded as unknown as typeof Notification;
    if (window.ServiceWorkerRegistration) {
      ServiceWorkerRegistration.prototype.showNotification = async (title, opts = {}) => void record(title, opts, "worker", () => {});
      ServiceWorkerRegistration.prototype.getNotifications = async (filter) =>
        made.filter((m) => m.via === "worker" && !m.closed && (!filter?.tag || m.tag === filter.tag)) as unknown as Notification[];
    }
    document.hasFocus = () => false;
  });
}
const popups = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { made: Made[] }).made.map(({ title, body, tag, url, closed, via }) => ({ title, body, tag, url, closed, via })),
  );

/**
 * Run `go`, and wait until the notifications chunk it loads alerts: the server has its subscriptions and the tab leads
 * (notify.ts says so as `data-notify` on the page). Its realtime POST can't tell: the unread counts follow the same
 * topics, so the subscriptions may already be there and the next POST someone else's.
 */
async function following(page: Page, go: () => Promise<unknown>) {
  await go();
  await expect(page.locator("html")).toHaveAttribute("data-notify", "on");
}

async function dmWith(me: User, other: User): Promise<{ id: string }> {
  const res = await fetch(`${E2E_BASE}/api/chat/dms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: me.token },
    body: JSON.stringify({ user: other.id }),
  });
  return (await res.json()) as { id: string };
}

async function reply(user: User, room: { id: string }, text: string, to: string) {
  await fetch(`${E2E_BASE}/api/collections/messages/records`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: user.token },
    body: JSON.stringify({ room: room.id, author: user.id, text, reply_to: to }),
  });
}

test("turned on in the profile: a DM and a reply to you pop up in a background tab; a click opens the message (§34)", async ({
  browser,
}) => {
  const tag = uniq();
  const ada = await apiUser(`Ada ${tag}`);
  const bob = await apiUser(`Bob ${tag}`);
  const room = await apiRoom(ada);
  const mine = await apiSend(ada, room, "my question");
  const dm = await dmWith(bob, ada);

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await ctx.newPage();
  await recordPopups(page);
  await login(page, ada);
  await page.goto("/me");
  const box = page.getByRole("group", { name: "Notifications" });
  await box.getByLabel("Direct messages").check();
  await box.getByLabel("Mentions and replies").check();
  await expect(box.getByLabel("Show a pop-up")).toBeChecked(); // chosen for you with the first
  await expect(box.getByRole("status")).toHaveText("");
  await following(page, () => page.goto("/"));
  await expect(page.locator(".sidebar li", { hasText: room.name })).toBeVisible();

  await apiSend(bob, room, "not for you");
  await reply(bob, room, "an answer", mine.id);
  const psst = await apiSend(bob, { id: dm.id, name: "" }, "psst");
  await expect
    .poll(async () => (await popups(page)).map(({ title, body, via }) => ({ title, body, via })))
    .toEqual([
      { title: `${bob.name} replied in #${room.name}`, body: "an answer", via: "page" },
      { title: bob.name, body: "psst", via: "page" },
    ]);
  expect((await popups(page))[1]!.url).toBe(`/r/${dm.id}/m/${psst.id}`);

  await page.evaluate(() => (window as unknown as { made: { click(): void }[] }).made[1]!.click());
  await expect(page).toHaveURL(atPath(`/r/${dm.id}/m/${psst.id}`));
  await expect(page.locator("ol.messages li.msg", { hasText: "psst" })).toBeVisible();
  await expect.poll(async () => (await popups(page))[1]!.closed).toBe(true);

  // Off again (from the header, not a reload: the recorder stays): silent.
  await page.locator("a.me-link:visible").click();
  for (const label of ["Direct messages", "Mentions and replies"]) await box.getByLabel(label).uncheck();
  await apiSend(bob, { id: dm.id, name: "" }, "anyone?");
  await page.waitForTimeout(1000);
  expect(await popups(page)).toHaveLength(2);
  await ctx.close();
});

test.describe("with the service worker", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "service workers: Chromium only");
  test.use({ serviceWorkers: "allow" });

  test("the pop-up is the worker's, one per room, and goes once the room is read elsewhere (§34)", async ({ browser }) => {
    const tag = uniq();
    const ada = await apiUser(`Ada ${tag}`);
    const bob = await apiUser(`Bob ${tag}`);
    const dm = await dmWith(bob, ada);
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await ctx.newPage();
    await recordPopups(page);
    await page.addInitScript(() =>
      localStorage.setItem("chat.notify", JSON.stringify({ dms: true, replies: true, popup: true, sound: false })),
    );
    await page.addInitScript(() => (Notification as unknown as { requestPermission(): void }).requestPermission());
    await following(page, () => login(page, ada));
    await page.evaluate(() => navigator.serviceWorker.ready);
    const open = async () => (await popups(page)).filter((m) => !m.closed).map(({ body, tag, via }) => ({ body, tag, via }));

    await apiSend(bob, { id: dm.id, name: "" }, "one");
    await expect.poll(open).toEqual([{ body: "one", tag: dm.id, via: "worker" }]);
    const last = (await apiSend(bob, { id: dm.id, name: "" }, "two")) as unknown as { created: string };
    await expect.poll(open).toEqual([{ body: "two", tag: dm.id, via: "worker" }]);

    // Read on another device.
    await fetch(`${E2E_BASE}/api/chat/reads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: ada.token },
      body: JSON.stringify({ room: dm.id, at: last.created }),
    });
    await expect.poll(open).toEqual([]);
    await ctx.close();
  });
});
