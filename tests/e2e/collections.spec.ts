import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { PNG } from "../support/files.ts";
import { apiRoom, apiUser, attach, composer, message, openRoom, type Room, test, type User } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

/** A message with images, through the API. */
async function sendImages(user: User, room: Room, text: string, names: string[]) {
  const form = new FormData();
  form.set("room", room.id);
  form.set("author", user.id);
  form.set("text", text);
  for (const n of names) form.append("files", new Blob([PNG], { type: "image/png" }), n);
  const res = await fetch(`${E2E_BASE}/api/collections/messages/records`, {
    method: "POST",
    headers: { authorization: user.token },
    body: form,
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { id: string; files: string[] };
}

async function apiCollection(user: User, name: string, isPublic: boolean) {
  const res = await fetch(`${E2E_BASE}/api/collections/collections/records`, {
    method: "POST",
    headers: { authorization: user.token, "content-type": "application/json" },
    body: JSON.stringify({ owner: user.id, name, public: isPublic }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as { id: string };
}

const sidebarRow = (page: Page, name: string) => page.locator(`.room-section[data-section="collections"] li a`, { hasText: name });

async function saveTo(page: Page, text: string, collection: string) {
  const tile = message(page, text).locator(".att-cell").first();
  await tile.hover();
  await message(page, text).screenshot({ path: "test-results/collection-save.png" });
  await tile.getByRole("button", { name: /to collection$/ }).click();
  const menu = page.getByRole("dialog", { name: "Save to collection" });
  await menu.getByRole("checkbox", { name: collection }).check();
  await expect(menu.getByRole("status")).toHaveText("Saved.");
  await menu.getByRole("button", { name: "Close" }).click();
  await expect(menu).toHaveCount(0);
}

test("collections: make one, save from the chat, follow, see what's new, attach with its badge (§31)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  await sendImages(ada, room, "a cat", ["cat.png"]);
  await sendImages(ada, room, "a dog", ["dog.png"]);
  const a = await openRoom(browser, ada, room);

  // A new collection from the sidebar's "+": its page, empty.
  await a.getByRole("button", { name: "New collection" }).click();
  const create = a.getByRole("dialog", { name: "New collection" });
  await create.getByRole("textbox", { name: "Name" }).fill("Pets");
  await create.getByRole("checkbox", { name: /Public/ }).check();
  await create.getByRole("button", { name: "Create" }).click();
  await expect(a.getByRole("heading", { level: 1, name: "Pets" })).toBeVisible();
  await expect(a.getByText("Nothing here yet.", { exact: false })).toBeVisible();
  await expect(sidebarRow(a, "Pets")).toHaveAttribute("aria-current", "page");
  const collUrl = a.url();

  // Saved from a message's tile (the collections icon), it shows on the page.
  await a.goBack();
  await saveTo(a, "a cat", "Pets");
  await sidebarRow(a, "Pets").click();
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(1);
  await expect(a.locator(".coll-grid .media-tile")).toHaveAccessibleName("cat.png");
  await expect(a.locator(".coll-head .coll-meta")).toHaveText("Yours · Public · 1 item");

  // Bob subscribes; Ada adds another; Bob's sidebar says 1 new, live.
  const b = await openRoom(browser, bob, room);
  await b.goto(collUrl);
  await b.getByRole("button", { name: "Subscribe" }).click();
  await expect(b.getByRole("button", { name: "Unsubscribe" })).toBeVisible();
  await expect(sidebarRow(b, "Pets")).toContainText("Ada");
  await b.goto(`/r/${room.id}`);
  await a.goBack();
  await saveTo(a, "a dog", "Pets");
  await expect(sidebarRow(b, "Pets").locator(".badge")).toHaveText("1 new");

  // Opened: the new one is highlighted, and the count goes.
  await sidebarRow(b, "Pets").click();
  await expect(b.locator(".coll-cell.new")).toHaveCount(1);
  await expect(b.locator(".coll-cell.new .media-tile")).toHaveAccessibleName("dog.png, new");
  await expect(b.locator(".coll-new")).toHaveText("1 new since your last visit");
  await expect(sidebarRow(b, "Pets").locator(".badge")).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page: b }).include("section.collection").withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  await b.screenshot({ path: "test-results/collection-page.png" });

  // Bob attaches from the collection: the message shows it with a badge that links to it.
  await b.goto(`/r/${room.id}`);
  await b.locator("form.composer summary").click();
  await b.getByRole("button", { name: "From collection" }).click();
  const picker = b.getByRole("dialog", { name: "Attach from collections" });
  await picker.getByRole("button", { name: "dog.png" }).click();
  await picker.getByRole("button", { name: "Attach 1" }).click();
  await expect(b.locator(".tray-item")).toContainText("From a collection");
  await b.locator("form.composer").screenshot({ path: "test-results/collection-tray.png" });
  await composer(b).fill("from Ada's pets");
  await composer(b).press("Enter");
  const sent = message(b, "from Ada's pets");
  await expect(sent.locator(".att-tile img")).toBeVisible();
  await expect(sent.locator(".att-tile img")).toHaveJSProperty("complete", true);
  const badge = sent.getByRole("link", { name: "Pets" });
  await expect(badge).toHaveAttribute("href", collUrl.replace(/^.*?\/c\//, "/c/"));
  await sent.screenshot({ path: "test-results/collection-badge.png" });

  // Private now: Bob's badge says so at once (no reload), and isn't a link; Ada's still names it.
  const patch = (body: Record<string, unknown>) =>
    fetch(`${E2E_BASE}/api/collections/collections/records/${collUrl.split("/c/")[1]}`, {
      method: "PATCH",
      headers: { authorization: ada.token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  await patch({ public: false });
  await expect(message(b, "from Ada's pets").locator(".att-src")).toHaveText("Private collection");
  await expect(message(b, "from Ada's pets").locator("a.att-src")).toHaveCount(0);
  await expect(sidebarRow(b, "Pets")).toHaveCount(0);
  await a.goto(`/r/${room.id}`);
  await expect(message(a, "from Ada's pets").getByRole("link", { name: /Pets/ })).toBeVisible();
  // Public again, then renamed: both badges follow live.
  await patch({ public: true });
  await expect(message(b, "from Ada's pets").getByRole("link", { name: "Pets" })).toBeVisible();
  await patch({ name: "Good pets" });
  await expect(message(b, "from Ada's pets").getByRole("link", { name: "Good pets" })).toBeVisible();
  await expect(message(a, "from Ada's pets").getByRole("link", { name: /Good pets/ })).toBeVisible();
});

test("collections: the viewer saves too, and unticking takes it out (§31)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  await sendImages(ada, room, "in the viewer", ["sun.png"]);
  await apiCollection(ada, "Skies", false);
  const a = await openRoom(browser, ada, room);
  await expect(sidebarRow(a, "Skies")).toBeVisible();
  await message(a, "in the viewer").locator("a.att-tile").click();
  const viewer = a.locator("dialog.viewer");
  await viewer.getByRole("button", { name: "Save to collection" }).click();
  const menu = a.getByRole("dialog", { name: "Save to collection" });
  // A slow copy: the row spins, the box stays ticked and the status says so until it is done.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await a.route("**/api/chat/items", async (route) => {
    await held;
    await route.continue();
  });
  await menu.getByRole("checkbox", { name: "Skies" }).click();
  await expect(menu.getByRole("status")).toHaveText("Saving…");
  await expect(menu.locator("li[aria-busy=true] .coll-spin")).toBeVisible();
  await expect(menu.getByRole("checkbox", { name: "Skies" })).toBeChecked();
  await expect(menu.getByRole("checkbox", { name: "Skies" })).toBeDisabled();
  release();
  await expect(menu.getByRole("status")).toHaveText("Saved.");
  await expect(menu.locator(".coll-spin")).toHaveCount(0);
  await a.unroute("**/api/chat/items");
  // Unticked: taken out again.
  await menu.getByRole("checkbox", { name: "Skies" }).uncheck();
  await expect(menu.getByRole("status")).toHaveText("Removed.");
  await a.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(viewer).toBeVisible();
});

/** A copy of a message's file in a collection, through the API. */
async function apiSave(user: User, collection: string, message: { id: string; files: string[] }) {
  const res = await fetch(`${E2E_BASE}/api/chat/items`, {
    method: "POST",
    headers: { authorization: user.token, "content-type": "application/json" },
    body: JSON.stringify({ collection, message: message.id, file: message.files[0] }),
  });
  expect(res.ok).toBe(true);
}

test("collections: the page follows changes; renaming, removing and the dialogs (QA pass 18: BUG-124–132)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const cat = await sendImages(ada, room, "cat", ["cat.png"]);
  const dog = await sendImages(ada, room, "dog", ["dog.png"]);
  const { id } = await apiCollection(ada, "Live", true);
  await apiCollection(ada, "Taken", false);
  await apiSave(ada, id, cat);

  // BUG-129: a guest sees whose it is.
  const guest = await browser.newContext();
  try {
    const g = await guest.newPage();
    await g.goto(`${E2E_BASE}/c/${id}`);
    await expect(g.locator(".coll-head .coll-meta")).toHaveText(`By ${ada.name} · Public · 1 item`);
  } finally {
    await guest.close();
  }

  // BUG-125: someone with no collections doesn't wait for some to come (it waited 2 s).
  const b = await openRoom(browser, bob, room);
  await b.goto(`/c/${id}`);
  await expect(b.getByRole("button", { name: "Subscribe" })).toBeVisible({ timeout: 1500 });
  // BUG-126: a follower on the page sees what is added, and no "new" badge for it.
  await b.getByRole("button", { name: "Subscribe" }).click();
  await expect(sidebarRow(b, "Live")).toBeVisible();
  await apiSave(ada, id, dog);
  await expect(b.locator(".coll-grid .media-tile")).toHaveCount(2);
  await expect(b.locator(".coll-cell.new .media-tile")).toHaveAccessibleName("dog.png, new");
  await expect(b.locator(".coll-head .coll-meta")).toContainText("2 items");
  await expect(sidebarRow(b, "Live").locator(".badge")).toHaveCount(0);
  // Made private meanwhile: the page says so.
  await fetch(`${E2E_BASE}/api/collections/collections/records/${id}`, {
    method: "PATCH",
    headers: { authorization: ada.token, "content-type": "application/json" },
    body: JSON.stringify({ public: false }),
  });
  await expect(b.getByRole("heading", { level: 1 })).toHaveText(/doesn't exist/);

  // BUG-127: a refused rename says why and keeps the form; a saved one shows the name as saved.
  const a = await openRoom(browser, ada, room);
  await a.goto(`/c/${id}`);
  await a.getByRole("button", { name: "Rename" }).click();
  const name = a.getByRole("textbox", { name: "Collection name" });
  await name.fill("taken");
  await a.getByRole("button", { name: "Save", exact: true }).click();
  await expect(a.locator(".coll-notice")).toHaveText("Couldn't save. You already have a collection with this name.");
  await expect(name).toBeVisible();
  await name.fill("  Pets  ");
  await name.press("Enter");
  await expect(a.getByRole("heading", { level: 1 })).toHaveText(/^\W*Pets$/);
  await expect(a.getByRole("button", { name: "Rename" })).toBeFocused();

  // BUG-131: the viewer doesn't call an item's author "Unknown".
  await a.locator(".coll-cell .media-tile").first().click();
  await expect(a.locator("dialog.viewer")).toContainText(/Added \w/);
  await expect(a.locator("dialog.viewer")).not.toContainText("Unknown");
  await a.keyboard.press("Escape");
  await expect(a.locator("dialog.viewer")).toBeHidden();

  // BUG-124: the tile's buttons show on focus; the dialogs are styled.
  await a.locator(".coll-cell .media-tile").first().focus();
  await a.keyboard.press("Tab");
  await a.keyboard.press("Tab");
  const remove = a.getByRole("button", { name: /^Remove dog\.png/ });
  await expect(remove).toBeFocused();
  await expect(remove).toHaveCSS("opacity", "1");
  await a.getByRole("button", { name: "Save dog.png to collection" }).click();
  const menu = a.getByRole("dialog", { name: "Save to collection" });
  await expect(menu).toHaveCSS("border-top-width", "1px");
  await a.keyboard.press("Escape");

  // BUG-128: removing the last ones leaves no month heading, says it is empty, and keeps focus on the page.
  await remove.click();
  await a.getByRole("button", { name: /^Remove cat\.png/ }).click();
  await expect(a.locator(".coll-grid h3")).toHaveCount(0);
  await expect(a.locator(".collection .media-status")).toHaveText(/Nothing here yet/);
  await expect(a.getByRole("button", { name: "Upload" })).toBeFocused();
  await a.getByRole("button", { name: "Delete" }).click();
  await expect(a.locator(".coll-actions")).toContainText("Delete “Pets”? This can't be undone.");

  // BUG-132: the picker says why nothing can be picked when the message is full.
  await a.goto(`/r/${room.id}`);
  await attach(
    a,
    Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.png`, mimeType: "image/png", buffer: Buffer.from(PNG) })),
  );
  await a.locator("form.composer summary").click();
  await a.getByRole("button", { name: "From collection" }).click();
  await expect(a.getByRole("dialog", { name: "Attach from collections" })).toContainText("The message has all the files it can take.");
  await a.keyboard.press("Escape");
  await a.goBack();

  // BUG-130: a narrow screen has its way back to the rooms.
  await a.setViewportSize({ width: 375, height: 700 });
  await a.getByRole("link", { name: "Back to rooms" }).click();
  await expect(a).toHaveURL(/\/$/);
});

test("collections: the page drops what is taken out elsewhere: the save menu, another tab", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const bob = await apiUser("Bob");
  const room = await apiRoom(ada);
  const cat = await sendImages(ada, room, "cat", ["cat.png"]);
  const dog = await sendImages(ada, room, "dog", ["dog.png"]);
  const { id } = await apiCollection(ada, "Pets", true);
  await apiSave(ada, id, cat);
  await apiSave(ada, id, dog);
  const a = await openRoom(browser, ada, room);
  await a.goto(`/c/${id}`);
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(2);
  const b = await openRoom(browser, bob, room);
  await b.goto(`/c/${id}`);
  await b.getByRole("button", { name: "Subscribe" }).click();
  await expect(sidebarRow(b, "Pets")).toBeVisible();

  // Unticked in the tile's save menu: the tile goes, for the owner and for a follower.
  await a.getByRole("button", { name: "Save dog.png to collection" }).click();
  const menu = a.getByRole("dialog", { name: "Save to collection" });
  await menu.getByRole("checkbox", { name: "Pets" }).uncheck();
  await expect(menu.getByRole("status")).toHaveText("Removed.");
  await a.keyboard.press("Escape");
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(1);
  await expect(a.locator(".coll-grid .media-tile")).toHaveAccessibleName("cat.png");
  await expect(a.locator(".coll-head .coll-meta")).toContainText("1 item");
  await expect(b.locator(".coll-grid .media-tile")).toHaveCount(1);
  await expect(b.locator(".coll-grid .media-tile")).toHaveAccessibleName("cat.png");

  // Taken out through the API (another tab): the last one goes, with its month, and the page says it is empty.
  const { items } = (await (
    await fetch(`${E2E_BASE}/api/collections/collection_items/records?filter=${encodeURIComponent(`collection = "${id}"`)}`, {
      headers: { authorization: ada.token },
    })
  ).json()) as { items: { id: string }[] };
  const res = await fetch(`${E2E_BASE}/api/chat/items/${items[0]!.id}`, { method: "DELETE", headers: { authorization: ada.token } });
  expect(res.ok).toBe(true);
  for (const p of [a, b]) {
    await expect(p.locator(".coll-grid .media-tile")).toHaveCount(0);
    await expect(p.locator(".coll-grid h3")).toHaveCount(0);
    await expect(p.locator(".collection .media-status")).toHaveText(/Nothing here yet/);
  }
});

test("collections: the owner uploads images straight into one, with the button, by dropping or pasting them (§31)", async ({ browser }) => {
  const ada = await apiUser("Ada");
  const room = await apiRoom(ada);
  const { id } = await apiCollection(ada, "Uploads", false);
  const a = await openRoom(browser, ada, room);
  await a.goto(`/c/${id}`);
  await expect(a.getByText("Nothing here yet. Upload images", { exact: false })).toBeVisible();

  // Two images and a PDF: the images go in, the PDF is named as refused.
  const chooser = a.waitForEvent("filechooser");
  await a.getByRole("button", { name: "Upload" }).click();
  await (await chooser).setFiles([
    { name: "one.png", mimeType: "image/png", buffer: Buffer.from(PNG) },
    { name: "two.png", mimeType: "image/png", buffer: Buffer.from(PNG) },
    { name: "doc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
  ]);
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(2);
  await expect(a.locator(".coll-notice")).toHaveText(/Couldn't upload doc\.pdf: not an image or video/);
  await expect(a.locator(".coll-head .coll-meta")).toHaveText("Yours · Private · 2 items");

  // Dropped on the page.
  const drop = await a.evaluateHandle(
    (png) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(png)], "three.png", { type: "image/png" }));
      return dt;
    },
    [...PNG],
  );
  await a.locator(".coll-grid").dispatchEvent("drop", { dataTransfer: drop });
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(3);
  await expect(a.locator(".coll-grid .media-tile").first()).toHaveAccessibleName(/^three\.png/);

  // Pasted (Ctrl+V) on the page.
  await a.evaluate(
    (png) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(png)], "image.png", { type: "image/png" }));
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [...PNG],
  );
  await expect(a.locator(".coll-grid .media-tile")).toHaveCount(4);
  await expect(a.locator(".coll-grid .media-tile").first()).toHaveAccessibleName(/^image\.png/);

  // Someone else's collection has no Upload.
  const bob = await apiUser("Bob");
  const pub = await apiCollection(ada, "Shown", true);
  const b = await openRoom(browser, bob, room);
  await b.goto(`/c/${pub.id}`);
  await expect(b.getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(b.getByRole("button", { name: "Upload" })).toHaveCount(0);
});
