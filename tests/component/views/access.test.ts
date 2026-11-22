// Room access in the UI (§23): the access dialog, the header's items, markers in the room list, and a room that goes
// away (or comes back) while it is open.

import PocketBase from "pocketbase";
import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { Api } from "../../../web/src/api.ts";
import type { Ctx } from "../../../web/src/context.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { createRoomView } from "../../../web/src/views/room.ts";
import { createRoomsView } from "../../../web/src/views/rooms.ts";
import { instrument, newApi, type SignedUp, signedUp, subscribed, uniq, viewContext } from "../../support/api.ts";
import { fakeLayout, installIntersectionObserver } from "../../support/dom.ts";
import { labelOf } from "./room/harness.ts";

describe("room access UI (§23)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let views: View[];
  let io: ReturnType<typeof installIntersectionObserver>;
  let ctx: Ctx;

  beforeEach(async () => {
    io = installIntersectionObserver();
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp(`Me ${uniq()}`);
    store = createStore<AppState>({ ...initialState(), user: me.user });
    views = [];
  });
  afterEach(async () => {
    for (const v of views) v.unmount();
    root.remove();
    io.restore();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  async function mountRoom(room: Room, api: Api = me.api, s: Store<AppState> = store) {
    ctx = viewContext(api, s, vi.fn());
    const view = createRoomView(ctx);
    views.push(view);
    const el = document.createElement("div");
    root.append(el);
    view.mount(el, { id: room.id });
    const list = el.querySelector<HTMLOListElement>("ol.messages");
    if (list) fakeLayout(list, { rowHeight: 40, clientHeight: 400 });
    await vi.waitFor(() => expect(el.querySelector("ol.messages[aria-busy='false'], .not-found")).not.toBeNull());
    await subscribed(api);
    return el;
  }

  const menuItems = (el: Element) => {
    el.querySelector<HTMLDetailsElement>("header.room-header details")!.open = true;
    return [...el.querySelectorAll("header.room-header .menu-items button")].map(labelOf);
  };
  const clickItem = (el: Element, label: string) => {
    el.querySelector<HTMLDetailsElement>("header.room-header details")!.open = true;
    [...el.querySelectorAll<HTMLButtonElement>("header.room-header .menu-items button")].find((b) => labelOf(b) === label)!.click();
  };
  const dialog = (el: Element) => el.querySelector<HTMLDialogElement>("dialog.access")!;
  /** Open the dialog from the header's menu: a lazy chunk, so it opens once that is loaded. */
  const openDialog = async (el: Element, label: string) => {
    clickItem(el, label);
    await vi.waitFor(() => expect(dialog(el)?.open).toBe(true));
  };
  const radio = (el: Element, v: string) => dialog(el).querySelector<HTMLInputElement>(`input[type=radio][value="${v}"]`)!;
  const choose = (el: Element, v: string) => {
    radio(el, v).checked = true;
    radio(el, v).dispatchEvent(new Event("change", { bubbles: true }));
  };
  const buttonIn = (el: Element, label: string | RegExp) =>
    [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? b.textContent === label : label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""),
    );
  const names = (el: Element, list: string) =>
    [...dialog(el).querySelectorAll(`${list} .member .member-name`)].map((n) => n.firstChild?.textContent); // without " (you)"
  const memberNames = (el: Element) => names(el, ".members");
  const writerNames = (el: Element) => names(el, ".writers");
  /** Search `list`'s people for `name` and click the first result. */
  async function pick(el: Element, list: string, name: string) {
    const section = dialog(el).querySelector(list)!;
    if (!section.querySelector(".user-search")) buttonIn(section, "Add people")!.click();
    const search = section.querySelector<HTMLInputElement>(".user-search input")!;
    search.value = name;
    search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(section.querySelector(".user-search button.person")?.textContent).toContain(name));
    section.querySelector<HTMLButtonElement>(".user-search button.person")!.click();
  }

  describe("header", () => {
    it("the creator gets “Room access…”; a member of a private room “Members (n)”; others neither", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await me.api.setAccess(room.id, "private", [bob.user.id]);
      const mine = await mountRoom(room);
      expect(menuItems(mine)).toContain("Room access…");
      expect(mine.querySelector("header.room-header h1")!.textContent).toBe(`#${room.name}Private`);

      const bobStore = createStore<AppState>({ ...initialState(), user: bob.user });
      const theirs = await mountRoom(room, bob.api, bobStore);
      expect(menuItems(theirs)).toContain("Members (2)");
      expect(menuItems(theirs)).not.toContain("Room access…");

      const pub = await me.api.createRoom(`p-${uniq()}`);
      const other = await mountRoom(pub, bob.api, bobStore);
      expect(menuItems(other).some((l) => l?.startsWith("Members") || l === "Room access…")).toBe(false);
      await bob.api.unsubscribeAll();
    });
  });

  describe("dialog", () => {
    it("shows the current visibility; making a room private starts with you, and you add and remove people", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const cat = await signedUp(`Cat ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      expect(dialog(el).open).toBe(true);
      expect(radio(el, "public").checked).toBe(true);
      expect(dialog(el).querySelector<HTMLElement>(".members")!.hidden).toBe(true);
      choose(el, "private");
      expect(dialog(el).querySelector<HTMLElement>(".members")!.hidden).toBe(false);
      expect(memberNames(el)).toEqual([me.user.name]); // named, not "Unknown"
      expect(dialog(el).querySelector(".access-warning")!.textContent).toContain("Only you and the people you add");

      buttonIn(dialog(el), "Add people")!.click();
      const search = dialog(el).querySelector<HTMLInputElement>(".user-search input")!;
      for (const u of [bob, cat]) {
        search.value = u.user.name;
        search.dispatchEvent(new Event("input"));
        await vi.waitFor(() => expect(dialog(el).querySelector(".user-search button.person")?.textContent).toContain(u.user.name));
        dialog(el).querySelector<HTMLButtonElement>(".user-search button.person")!.click();
      }
      expect(memberNames(el)).toEqual([me.user.name, bob.user.name, cat.user.name]);
      buttonIn(dialog(el), new RegExp(`^Remove ${bob.user.name}$`))!.click();
      expect(memberNames(el)).toEqual([me.user.name, cat.user.name]);
      expect(buttonIn(dialog(el), new RegExp(`^Remove ${me.user.name}$`))).toBeUndefined(); // the creator stays

      buttonIn(dialog(el), "Save")!.click();
      await vi.waitFor(() => expect(dialog(el).open).toBe(false));
      const saved = await me.api.getRoom(room.id);
      expect(saved.visibility).toBe("private");
      expect(saved.members).toEqual([me.user.id, cat.user.id]);
      expect(store.get().rooms.get(room.id)?.visibility).toBe("private");
      await Promise.all([bob.api.unsubscribeAll(), cat.api.unsubscribeAll()]);
    });

    it("search marks who is in and toggles them; Telegram stand-ins are left out but stay members (§26.3)", async () => {
      const tag = uniq();
      const bob = await signedUp(`Bob ${tag}`);
      const cat = await signedUp(`Cat ${tag}`);
      const bot = await signedUp(`Bot ${tag}`);
      const pb = new PocketBase(inject("pbUrl"));
      await pb.collection("users").authWithPassword(bot.email, bot.password);
      await pb.collection("users").update(bot.user.id, { no_dms: true });
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await me.api.setAccess(room.id, "private", [bob.user.id, bot.user.id]);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      expect(memberNames(el)).toEqual([me.user.name, bob.user.name]);
      expect(dialog(el).querySelector("h3")!.textContent).toBe("Members · 2");

      buttonIn(dialog(el), "Add people")!.click();
      const search = dialog(el).querySelector<HTMLInputElement>(".user-search input")!;
      search.value = tag;
      search.dispatchEvent(new Event("input"));
      const result = (name: string) =>
        [...dialog(el).querySelectorAll<HTMLButtonElement>(".user-search button.person")].find((b) => b.textContent?.endsWith(name));
      await vi.waitFor(() => expect(result(cat.user.name)).toBeDefined());
      expect(result(bot.user.name)).toBeUndefined();
      expect(result(bob.user.name)!.getAttribute("aria-pressed")).toBe("true");
      expect(result(cat.user.name)!.getAttribute("aria-pressed")).toBe("false");

      result(cat.user.name)!.click();
      result(bob.user.name)!.click();
      expect(result(cat.user.name)!.getAttribute("aria-pressed")).toBe("true");
      expect(result(bob.user.name)!.getAttribute("aria-pressed")).toBe("false");
      expect(memberNames(el)).toEqual([me.user.name, cat.user.name]);

      buttonIn(dialog(el), "Save")!.click();
      await vi.waitFor(() => expect(dialog(el).open).toBe(false));
      expect((await me.api.getRoom(room.id)).members).toEqual([me.user.id, bot.user.id, cat.user.id]);
      await Promise.all([bob.api.unsubscribeAll(), cat.api.unsubscribeAll(), bot.api.unsubscribeAll()]);
    });

    it("Open Air warns that anyone can read the whole history; a failed save says why and stays open", async () => {
      const room = await me.api.createRoom(`r-${uniq()}`);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      choose(el, "open");
      expect(dialog(el).querySelector(".access-warning")!.textContent).toContain("anyone on the web");
      instrument(me.api).failNext("setAccess", new (await import("../../../web/src/api.ts")).ApiError("Too many requests.", 429));
      buttonIn(dialog(el), "Save")!.click();
      await vi.waitFor(() => expect(dialog(el).querySelector(".field-error")!.textContent).toContain("Too many attempts"));
      expect(dialog(el).open).toBe(true);
      buttonIn(dialog(el), "Save")!.click();
      await vi.waitFor(() => expect(dialog(el).open).toBe(false));
      expect((await me.api.getRoom(room.id)).visibility).toBe("open");
    });

    it("a member sees who is in the room, read-only", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await me.api.setAccess(room.id, "private", [bob.user.id]);
      const bobStore = createStore<AppState>({ ...initialState(), user: bob.user });
      const el = await mountRoom(room, bob.api, bobStore);
      await openDialog(el, "Members (2)");
      expect(dialog(el).open).toBe(true);
      expect(dialog(el).querySelector<HTMLElement>(".vis-choices")!.hidden).toBe(true);
      expect(memberNames(el)).toEqual([me.user.name, bob.user.name]);
      expect(dialog(el).querySelector(".remove-member")).toBeNull();
      expect(buttonIn(dialog(el), "Save")!.hidden).toBe(true);
      expect(dialog(el).querySelector<HTMLElement>(".add-member")!.hidden).toBe(true);
      // No invite link for them (§44).
      expect(dialog(el).querySelector<HTMLElement>(".invite")!.hidden).toBe(true);
      await bob.api.unsubscribeAll();
    });
  });

  describe("invite link (§44)", () => {
    const section = (el: Element) => dialog(el).querySelector<HTMLElement>(".invite")!;
    const url = (el: Element) => section(el).querySelector<HTMLInputElement>(".invite-url")!;
    const status = (el: Element) => section(el).querySelector(".invite-status")!.textContent;

    it("the creator makes one, copies it, makes a new one and revokes it, each at once", async () => {
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      await vi.waitFor(() => expect(buttonIn(section(el), "Create link")!.disabled).toBe(false));
      expect(section(el).hidden).toBe(false);
      expect(section(el).querySelector<HTMLElement>(".invite-shown")!.hidden).toBe(true);
      section(el).querySelector<HTMLSelectElement>("select")!.value = "30";
      buttonIn(section(el), "Create link")!.click();
      await vi.waitFor(() => expect(url(el).value).toMatch(/\/invite\/[A-Za-z0-9]{24}$/));
      expect(url(el).value.startsWith(location.origin)).toBe(true);
      expect(status(el)).toBe("The link is ready to share.");
      expect(section(el).querySelector(".invite-meta")!.textContent).toContain("nobody has joined by it yet");
      const token = url(el).value.split("/").pop()!;
      const invites = await me.api.invites();
      const made = await invites.get(room.id);
      expect(made?.token).toBe(token);
      expect((Date.parse(made!.expires.replace(" ", "T")) - Date.now()) / 86_400_000).toBeGreaterThan(29);

      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      buttonIn(section(el), "Copy link")!.click();
      await vi.waitFor(() => expect(status(el)).toBe("Copied."));
      expect(writeText).toHaveBeenCalledWith(url(el).value);

      buttonIn(section(el), "New link")!.click();
      await vi.waitFor(() => expect(url(el).value.endsWith(token)).toBe(false));
      expect(status(el)).toBe("A new link is ready. The old one no longer works.");
      await expect(invites.preview(token)).rejects.toMatchObject({ status: 404 });

      buttonIn(section(el), "Revoke")!.click();
      await vi.waitFor(() => expect(status(el)).toBe("The link no longer works."));
      expect(section(el).querySelector<HTMLElement>(".invite-shown")!.hidden).toBe(true);
      expect(buttonIn(section(el), "Create link")!.hidden).toBe(false);
      expect(await invites.get(room.id)).toBeNull();
    });

    it("shows the link made before, and only while the room is private", async () => {
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      const inv = await (await me.api.invites()).make(room.id, 7);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      await vi.waitFor(() => expect(url(el).value.endsWith(inv.token)).toBe(true));
      choose(el, "public");
      expect(section(el).hidden).toBe(true);
      choose(el, "private");
      expect(section(el).hidden).toBe(false);

      const pub = await me.api.createRoom(`p-${uniq()}`);
      const other = await mountRoom(pub);
      await openDialog(other, "Room access…");
      // Not until it is saved as private.
      choose(other, "private");
      expect(dialog(other).querySelector<HTMLElement>(".invite")!.hidden).toBe(true);
    });

    it("an archived room's link can only be revoked: no new one, no address to copy (QA BUG-282)", async () => {
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await (await me.api.invites()).make(room.id, 7);
      const archived = await me.api.setArchived(room.id, true);
      const el = await mountRoom(archived);
      await openDialog(el, "Room access…");
      await vi.waitFor(() => expect(buttonIn(section(el), "Revoke")!.disabled).toBe(false));
      expect(section(el).querySelector(".vis-hint")!.textContent).toBe(
        "The room is archived: its link doesn't work until the room is unarchived.",
      );
      expect(section(el).querySelector<HTMLElement>(".invite-shown")!.hidden).toBe(true);
      expect(buttonIn(section(el), "New link")!.hidden).toBe(true);
      expect(section(el).querySelector<HTMLElement>(".invite-days")!.hidden).toBe(true);
      buttonIn(section(el), "Revoke")!.click();
      await vi.waitFor(() => expect(status(el)).toBe("The link no longer works."));
      // Nothing to make while archived.
      expect(buttonIn(section(el), "Create link")!.hidden).toBe(true);
    });
  });

  describe("who can post (§23.6)", () => {
    it("the creator chooses who can post: starts with them, adds people, saves", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      expect(radio(el, "everyone").checked).toBe(true);
      expect(dialog(el).querySelector<HTMLElement>(".writers")!.hidden).toBe(true);
      choose(el, "selected");
      expect(dialog(el).querySelector<HTMLElement>(".writers")!.hidden).toBe(false);
      expect(writerNames(el)).toEqual([me.user.name]);
      expect(buttonIn(dialog(el), new RegExp(`^Remove ${me.user.name}$`))).toBeUndefined(); // the creator always posts
      await pick(el, ".writers", bob.user.name);
      expect(writerNames(el)).toEqual([me.user.name, bob.user.name]);
      buttonIn(dialog(el), "Save")!.click();
      await vi.waitFor(() => expect(dialog(el).open).toBe(false));
      const saved = await me.api.getRoom(room.id);
      expect(saved).toMatchObject({ visibility: "public", posting: "selected", writers: [me.user.id, bob.user.id] });
      expect(store.get().rooms.get(room.id)?.posting).toBe("selected");
      await bob.api.unsubscribeAll();
    });

    it("in a private room only members can be chosen, and a member taken out stops posting", async () => {
      const tag = uniq();
      const bob = await signedUp(`Bob ${tag}`);
      const cat = await signedUp(`Cat ${tag}`);
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await me.api.setAccess(room.id, "private", [bob.user.id], "selected", [bob.user.id]);
      const el = await mountRoom(room);
      await openDialog(el, "Room access…");
      expect(writerNames(el)).toEqual([me.user.name, bob.user.name]);
      const section = dialog(el).querySelector(".writers")!;
      buttonIn(section, "Add people")!.click();
      const search = section.querySelector<HTMLInputElement>(".user-search input")!;
      search.value = tag;
      search.dispatchEvent(new Event("input"));
      await vi.waitFor(() => expect(section.querySelector(".user-search button.person")?.textContent).toContain(bob.user.name));
      expect(section.textContent).not.toContain(cat.user.name); // not a member
      buttonIn(dialog(el).querySelector(".members")!, new RegExp(`^Remove ${bob.user.name}$`))!.click();
      expect(writerNames(el)).toEqual([me.user.name]);
      await Promise.all([bob.api.unsubscribeAll(), cat.api.unsubscribeAll()]);
    });

    it("a reader gets a banner instead of the composer, reacts but can't reply; made a writer, the composer comes", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`);
      await me.api.setAccess(room.id, "public", [], "selected", []);
      await me.api.send({ id: newId(), room: room.id, text: "news" });
      const bobStore = createStore<AppState>({ ...initialState(), user: bob.user });
      const el = await mountRoom(room, bob.api, bobStore);
      await vi.waitFor(() => expect(el.querySelector("li.msg .body")?.textContent).toBe("news"));
      expect(el.querySelector("form.composer")).toBeNull();
      expect(el.querySelector("footer .reader-banner")!.textContent).toContain("Only some people can post");
      const msg = el.querySelector("li.msg")!;
      expect(msg.querySelector("button.react")).not.toBeNull();
      expect(msg.querySelector("button.reply")).toBeNull();

      await me.api.setAccess(room.id, "public", [], "selected", [bob.user.id]);
      await vi.waitFor(() => expect(el.querySelector("form.composer")).not.toBeNull());
      expect(el.querySelector(".reader-banner")).toBeNull();
      await vi.waitFor(() => expect(el.querySelector("li.msg button.reply")).not.toBeNull());
      await bob.api.unsubscribeAll();
    });
  });

  describe("a DM that takes no messages (§16.7)", () => {
    it("says why instead of a composer that could only fail (QA BUG-178)", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const dm = await me.api.openDm(bob.user.id);
      await me.api.send({ id: newId(), room: dm.id, text: "still there?" });
      const pb = new PocketBase(inject("pbUrl"));
      await pb.collection("users").authWithPassword(bob.email, bob.password);
      await pb.collection("users").update(bob.user.id, { no_dms: true });
      const el = await mountRoom(dm);
      await vi.waitFor(() => expect(el.querySelector("li.msg .body")?.textContent).toBe("still there?"));
      expect(el.querySelector("form.composer")).toBeNull();
      expect(el.querySelector("footer .reader-banner")!.textContent).toBe(`${bob.user.name} doesn't take direct messages.`);
      await bob.api.unsubscribeAll();
    });
  });

  describe("losing and regaining access (§23.4)", () => {
    it("taken out of a private room while in it: the room and its messages go; added back, it shows again", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      await me.api.setAccess(room.id, "private", [bob.user.id]);
      await me.api.send({ id: newId(), room: room.id, text: "secret plans" });
      const bobStore = createStore<AppState>({ ...initialState(), user: bob.user });
      const el = await mountRoom(room, bob.api, bobStore);
      await vi.waitFor(() => expect(el.textContent).toContain("secret plans"));
      await vi.waitFor(() => expect(bobStore.get().rooms.has(room.id)).toBe(true));

      await me.api.setAccess(room.id, "private", []);
      await vi.waitFor(() => expect(el.querySelector(".not-found h1")?.textContent).toBe("You can't see this room any more."));
      expect(el.textContent).not.toContain("secret plans");
      expect(bobStore.get().activeRoomId).toBeNull();
      const reopen = vi.mocked(ctx.reopen);
      expect(reopen).not.toHaveBeenCalled();

      await me.api.setAccess(room.id, "private", [bob.user.id]);
      await vi.waitFor(() => expect(reopen).toHaveBeenCalledTimes(1));
      await bob.api.unsubscribeAll();
    });

    it("a room you can't see yet opens by itself once you are let in", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const room = await me.api.createRoom(`r-${uniq()}`, "private");
      const bobStore = createStore<AppState>({ ...initialState(), user: bob.user });
      const el = await mountRoom(room, bob.api, bobStore);
      expect(el.querySelector(".not-found")!.textContent).toContain("This room doesn't exist.");
      await me.api.setAccess(room.id, "private", [bob.user.id]);
      await vi.waitFor(() => expect(vi.mocked(ctx.reopen)).toHaveBeenCalledTimes(1));
      await bob.api.unsubscribeAll();
    });
  });

  describe("room list", () => {
    it("marks private and Open Air rooms, and offers a visibility when creating one", async () => {
      const priv = await me.api.createRoom(`priv-${uniq()}`, "private");
      const open = await me.api.createRoom(`open-${uniq()}`, "open");
      const pub = await me.api.createRoom(`pub-${uniq()}`);
      const view = createRoomsView(viewContext(me.api, store, vi.fn()));
      views.push(view);
      view.mount(root, {});
      await vi.waitFor(() => expect(root.querySelector(`[data-room-id="${pub.id}"]`)).not.toBeNull());
      const mark = (r: Room) => root.querySelector(`[data-room-id="${r.id}"] .vis`)?.textContent ?? null;
      // The leading icon ("#" for private), named for screen readers.
      expect(mark(priv)).toBe("# (Private)");
      expect(mark(open)).toBe(" (Open Air)");
      expect(mark(pub)).toBe(" (Public)");

      root.querySelector<HTMLButtonElement>("button.new-room-toggle")!.click();
      const form = root.querySelector<HTMLFormElement>("form.new-room")!;
      const name = `made-${uniq()}`;
      form.querySelector<HTMLInputElement>("input[name=name]")!.value = name;
      form.querySelector<HTMLInputElement>("input[name=visibility][value=private]")!.click();
      form.requestSubmit();
      await vi.waitFor(() => expect([...store.get().rooms.values()].find((r) => r.name === name)?.visibility).toBe("private"));
    });

    it("a guest's list holds only the Open Air rooms, without actions", async () => {
      const open = await me.api.createRoom(`open-${uniq()}`, "open");
      const pub = await me.api.createRoom(`pub-${uniq()}`);
      const guest = newApi();
      const guestStore = createStore<AppState>(initialState());
      const ctl = instrument(guest);
      const view = createRoomsView(viewContext(guest, guestStore, vi.fn()));
      views.push(view);
      view.mount(root, {});
      await vi.waitFor(() => expect(root.querySelector(`[data-room-id="${open.id}"]`)).not.toBeNull());
      expect(root.querySelector(`[data-room-id="${pub.id}"]`)).toBeNull();
      expect(root.querySelector("details, button.new-room-toggle, button.new-dm")).toBeNull();
      expect(ctl.calls("listHidden")).toBe(0);
      await guest.unsubscribeAll();
    });
  });
});
