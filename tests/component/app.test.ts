import { afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { type Api, ApiError, createApi } from "../../web/src/api.ts";
import { type App, startApp } from "../../web/src/app.ts";
import { newId } from "../../web/src/lib/id.ts";
import { createClient } from "../../web/src/pb.ts";
import { instrument, intercept, newApi, signedUp, subscribed } from "../support/api.ts";
import { visit } from "../support/dom.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("app boot (§7.1)", () => {
  let root: HTMLElement;
  let app: App | undefined;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.append(root);
    history.replaceState(null, "", "/");
  });
  afterEach(() => {
    app?.stop();
    app = undefined;
    root.remove();
    vi.restoreAllMocks();
  });

  /** The app bar's link to your profile: shown only while logged in. */
  const meLink = () => root.querySelector("header.app-bar a.me-link");
  const logoutButton = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Log out");

  it("without a session it shows the Open Air rooms to a guest, with Log in and Sign up (§23.3)", async () => {
    const ada = await signedUp("Ada");
    const open = await ada.api.createRoom(`open-${newId()}`, "open");
    const pub = await ada.api.createRoom(`pub-${newId()}`);
    const api = newApi();
    const ctl = instrument(api);
    app = startApp({ api, root });
    await tick();
    expect(location.pathname).toBe("/");
    expect(meLink()).toBeNull();
    const links = [...root.querySelectorAll<HTMLAnchorElement>("header.app-bar .guest-links a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Log in", "/login"],
      ["Sign up", "/signup"],
    ]);
    const sidebar = root.querySelector("aside.sidebar")!;
    await vi.waitFor(() => expect(sidebar.querySelector(`a[href="/r/${open.id}"]`)).not.toBeNull());
    expect(sidebar.querySelector(`a[href="/r/${pub.id}"]`)).toBeNull();
    expect(sidebar.querySelector("h2")!.textContent).toBe("Open Air rooms");
    expect(sidebar.querySelector("button.new-room-toggle, button.new-dm, details, summary")).toBeNull();
    expect(root.querySelector(".welcome p a[href='/login']")).not.toBeNull();
    // Nothing that needs an account is asked for.
    expect(ctl.calls("unreadCounts")).toBe(0);
    expect(ctl.calls("listHidden")).toBe(0);
    expect(ctl.calls("subscribeHidden")).toBe(0);
    visit("/me");
    await tick();
    expect(location.pathname).toBe("/login");
    expect(root.querySelector("form.auth-form")).not.toBeNull();
    await api.unsubscribeAll();
  });

  it("a guest reads an Open Air room: messages and authors, a banner instead of the composer, no actions (§23.3)", async () => {
    const ada = await signedUp("Ada");
    const open = await ada.api.createRoom(`open-${newId()}`, "open");
    const m = await ada.api.send({ id: newId(), room: open.id, text: "hello world" });
    await ada.api.react(m.id, "👍", true);
    const api = newApi();
    const ctl = instrument(api);
    history.replaceState(null, "", `/r/${open.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("li.msg .body")?.textContent).toBe("hello world"));
    const msg = root.querySelector("li.msg")!;
    expect(msg.querySelector(".author")!.textContent).toBe("Ada");
    expect(msg.querySelector("summary")).toBeNull(); // no "Message" menu
    expect(msg.querySelector(".actions")).toBeNull();
    expect(msg.querySelector(".reactions button")).toBeNull(); // shown, not clickable
    expect(msg.querySelector(".reactions .reaction")!.getAttribute("title")).toBe("Ada reacted with 👍"); // in the window: no lookup needed
    expect(root.querySelector("form.composer")).toBeNull();
    expect(root.querySelector("footer .guest-banner a[href='/login']")).not.toBeNull();
    expect(root.querySelector("header.room-header h1")!.textContent).toContain("Open Air");
    root.querySelector<HTMLElement>("header.room-header summary")!.click();
    const items = [...root.querySelectorAll("header.room-header .menu-items button")].map((b) => b.textContent);
    expect(items).toEqual(["Jump to beginning"]);
    await tick();
    expect(ctl.calls("usersById")).toBe(0);
    expect(ctl.calls("fileToken")).toBeLessThanOrEqual(1); // answered "" without a request
    await api.unsubscribeAll();
  });

  it("a guest following a link to a room that needs an account is told so; logging in takes them back to it", async () => {
    const ada = await signedUp("Ada");
    const pub = await ada.api.createRoom(`pub-${newId()}`);
    const api = newApi();
    history.replaceState(null, "", `/r/${pub.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector(".not-found")?.textContent).toContain("doesn't exist"));
    root.querySelector<HTMLAnchorElement>(".not-found a[href='/login']")!.click();
    visit("/login");
    await vi.waitFor(() => expect(root.querySelector("form.auth-form")).not.toBeNull());
    root.querySelector<HTMLInputElement>('input[name="email"]')!.value = ada.email;
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = ada.password;
    root.querySelector("form")!.requestSubmit();
    await vi.waitFor(() => expect(location.pathname).toBe(`/r/${pub.id}`));
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${pub.name}`));
    expect(root.querySelector("form.composer")).not.toBeNull();
    await api.unsubscribeAll();
  });

  it("with a stored session it goes straight to the route and refreshes auth in the background, once the room list is in", async () => {
    const { api, user } = await signedUp("Ada");
    const ctl = instrument(api);
    history.replaceState(null, "", "/r/abc");
    app = startApp({ api, root });
    expect(location.pathname).toBe("/r/abc");
    expect(app.store.get().user).toEqual(user);
    expect(ctl.calls("refreshAuth")).toBe(0); // the room list first (PERF.md §5)
    await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
    expect(app.store.get().roomsStatus).toBe("ready");
    expect(root.textContent).toContain("Ada");
    expect(meLink()).not.toBeNull();
  });

  it("QA BUG-145: a session that ran out while the app was closed leaves no drafts, kept rooms or thumbnails", async () => {
    const ada = await signedUp("Ada");
    const client = createClient(inject("pbUrl"));
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, "")}.x`;
    client.authStore.save(token, { id: ada.user.id, collectionName: "users", collectionId: "users" } as never);
    const api = createApi(client);
    localStorage.setItem(`chat.draft.${ada.user.id}.room1`, "half-written");
    localStorage.setItem("chat.draft.someone-else.room1", "theirs");
    const deleted: string[] = [];
    vi.stubGlobal("caches", { delete: async (name: string) => deleted.push(name) > 0 });
    try {
      app = startApp({ api, root });
      expect(app.store.get().user).toBeNull();
      expect(localStorage.getItem(`chat.draft.${ada.user.id}.room1`)).toBeNull();
      expect(localStorage.getItem("chat.draft.someone-else.room1")).toBe("theirs");
      expect(deleted).toEqual(["chat-files"]);
      // Forgotten: the next start has nothing left to clear.
      expect(client.authStore.record).toBeNull();
      expect(api.forgetExpired()).toBe("");
    } finally {
      vi.unstubAllGlobals();
      localStorage.removeItem("chat.draft.someone-else.room1");
      await api.unsubscribeAll();
    }
  });

  it("the app bar shows your avatar and name, linking to /me, and follows profile changes (§15.4)", async () => {
    const { api } = await signedUp("Ada Lovelace");
    app = startApp({ api, root });
    const link = root.querySelector<HTMLAnchorElement>("header.app-bar a.me-link")!;
    expect(link.getAttribute("href")).toBe("/me");
    expect(link.querySelector(".avatar")!.textContent).toBe("AL");
    expect(link.querySelector(".who")!.textContent).toBe("Ada Lovelace");

    visit("/me");
    await vi.waitFor(() => expect(root.querySelector("section.profile")).not.toBeNull());
    expect(root.querySelector("aside.sidebar")).not.toBeNull();
    const grace = `Grace ${newId()}`; // display names are unique (§22.1)
    app.store.set({ user: await api.rename(grace) });
    expect(root.querySelector("header.app-bar .who")!.textContent).toBe(grace);
    await api.unsubscribeAll();
  });

  it("the app bar, the login page and the tab show the site's title and logo, also after logging out (§24)", async () => {
    const { api } = await signedUp();
    intercept(api, "site", () => async () => ({ title: "Acme", logo: "/acme.png", inviteOnly: true }));
    app = startApp({ api, root });
    const brand = () => root.querySelector<HTMLAnchorElement>("header.app-bar a.brand")!;
    await vi.waitFor(() => expect(brand().textContent).toBe("Acme"));
    expect(brand().classList.contains("has-logo")).toBe(true);
    expect(brand().querySelector("img")!.getAttribute("src")).toBe("/acme.png");
    expect(document.title).toMatch(/^(\(\d+\+?\) )?Acme$/); // other tests' Open Air rooms may be unread
    app.logOut();
    expect(brand().textContent).toBe("Acme");
    visit("/signup");
    await vi.waitFor(() => expect(root.querySelector(".auth h1")!.textContent).toBe("Acme"));
    expect(root.querySelector('input[name="invite_code"]')).not.toBeNull();
  });

  it("/ shows the room list as a sidebar and a greeting where the room would be", async () => {
    const { api } = await signedUp("Ada Lovelace");
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("aside.sidebar nav[aria-label='Rooms']")).not.toBeNull());
    expect(root.querySelector(".layout.home .pane section.welcome h1")!.textContent).toBe("Welcome, Ada!");
    await api.unsubscribeAll();
  });

  it("BUG-27: a file dragged over or dropped anywhere doesn't make the browser open it; other drags are left alone", async () => {
    const { api } = await signedUp("Ada");
    app = startApp({ api, root });
    const drag = (type: "dragover" | "drop", types: string[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, "dataTransfer", { value: { types, files: [] } });
      root.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(drag("dragover", ["Files"])).toBe(true);
    expect(drag("drop", ["Files"])).toBe(true);
    expect(drag("dragover", ["text/plain"])).toBe(false);
    app.stop();
    app = undefined;
    expect(drag("drop", ["Files"])).toBe(false);
    await api.unsubscribeAll();
  });

  it("/r/:id shows the room with the room list as a sidebar; navigating between rooms switches the room", async () => {
    const { api } = await signedUp("Ada");
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    history.replaceState(null, "", `/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    const sidebar = root.querySelector("aside.sidebar")!;
    expect(sidebar.querySelector('nav[aria-label="Rooms"]')).not.toBeNull();
    await vi.waitFor(() => expect(sidebar.querySelector(`a[href="/r/${r1.id}"]`)?.getAttribute("aria-current")).toBe("page"));
    expect(root.querySelector("form.composer")).not.toBeNull();

    visit(`/r/${r2.id}`);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(app.store.get().activeRoomId).toBe(r2.id);
    await api.unsubscribeAll();
  });

  it("QA: logging out sends a read still waiting to go out (§18.3)", async () => {
    const me = await signedUp("Me");
    const other = await signedUp("Other");
    const room = await other.api.createRoom(`room-${newId()}`);
    const m = await other.api.send({ id: newId(), room: room.id, text: "hello" });
    const calls: string[] = [];
    const markRead = me.api.markRead.bind(me.api);
    me.api.markRead = (r, at) => {
      calls.push(`${r}@${at}`);
      return markRead(r, at);
    };
    history.replaceState(null, "", `/r/${room.id}`);
    app = startApp({ api: me.api, root });
    await vi.waitFor(() => expect(root.querySelector("li.msg")).not.toBeNull());
    expect(calls).toEqual([]); // batched: not sent yet
    app.logOut(); // (from the room: going to the profile first would close the room, which sends it too)
    expect(calls).toEqual([`${room.id}@${m.created}`]);
    const again = newApi();
    await again.logIn(me.email, me.password);
    await vi.waitFor(async () => expect((await again.unreadCounts()).rooms[room.id]).toBeUndefined());
    await again.unsubscribeAll();
  });

  it("Ctrl+K or Ctrl+P (⌘ too, any keyboard layout) opens Jump to from anywhere, and goes to the room picked (§32)", async () => {
    const { api } = await signedUp("Ada");
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    const r3 = await api.createRoom(`three-${newId()}`); // the newest, but never opened
    history.replaceState(null, "", `/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    await vi.waitFor(() => expect(app!.store.get().rooms.has(r3.id)).toBe(true));
    const press = (init: KeyboardEventInit, at: Element = document.activeElement ?? document.body) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      at.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const dialog = () => root.querySelector<HTMLDialogElement>("dialog.switcher");
    // Not with Shift or Alt (Ctrl+Shift+P is a private window), nor without Ctrl.
    expect(press({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ key: "k", code: "KeyK" })).toBe(false);
    // From the composer; a Cyrillic layout types "л" on K.
    expect(press({ key: "л", code: "KeyK", ctrlKey: true }, root.querySelector("form.composer textarea")!)).toBe(true);
    await vi.waitFor(() => expect(dialog()?.open).toBe(true));
    // Held down: the repeats don't close it (QA BUG-137).
    expect(press({ key: "л", code: "KeyK", ctrlKey: true, repeat: true })).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(dialog()!.open).toBe(true);
    expect(press({ key: "p", code: "KeyP", metaKey: true })).toBe(true); // again: closes
    await vi.waitFor(() => expect(dialog()!.open).toBe(false));
    press({ key: "p", code: "KeyP", ctrlKey: true });
    await vi.waitFor(() => expect(dialog()!.open).toBe(true));
    const input = dialog()!.querySelector("input")!;
    input.value = r2.name;
    input.dispatchEvent(new Event("input"));
    press({ key: "Enter" }, input);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(location.pathname).toBe(`/r/${r2.id}`);
    expect(dialog()!.open).toBe(false);
    // Ctrl+K Enter: back where you were, though no message says the room was recent (QA BUG-134).
    press({ key: "k", ctrlKey: true });
    await vi.waitFor(() => expect(dialog()!.open).toBe(true));
    press({ key: "Enter" }, input);
    await vi.waitFor(() => expect(location.pathname).toBe(`/r/${r1.id}`));
    // Logging out closes it: it lists the last user's rooms (QA BUG-136).
    press({ key: "k", ctrlKey: true });
    await vi.waitFor(() => expect(dialog()!.open).toBe(true));
    app.logOut();
    await vi.waitFor(() => expect(dialog()!.open).toBe(false));
    app.stop();
    app = undefined;
    expect(press({ key: "k", ctrlKey: true })).toBe(false); // gone with the app
    await api.unsubscribeAll();
  });

  it("switching rooms keeps the sidebar mounted: no refetch, and a half-typed room name survives", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    history.replaceState(null, "", `/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    const sidebar = root.querySelector("aside.sidebar")!;
    sidebar.querySelector<HTMLButtonElement>("button.new-room-toggle")!.click();
    const input = sidebar.querySelector<HTMLInputElement>('form.new-room input[name="name"]')!;
    input.value = "half-typ";
    const fetches = ctl.calls("listRooms");

    visit(`/r/${r2.id}`);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(root.querySelector("aside.sidebar")).toBe(sidebar);
    expect(input.isConnected).toBe(true);
    expect(input.value).toBe("half-typ");
    expect(ctl.calls("listRooms")).toBe(fetches);
    expect(ctl.calls("subscribeRooms")).toBe(1); // one app-wide subscription, not one per view
    await vi.waitFor(() => expect(sidebar.querySelector(`a[href="/r/${r2.id}"]`)?.getAttribute("aria-current")).toBe("page"));
  });

  it("a room left for another is kept, live: going back shows it with what came meanwhile, nothing fetched (PERF.md §5)", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    const r1 = await api.createRoom(`one-${newId()}`);
    const r2 = await api.createRoom(`two-${newId()}`);
    await api.send({ id: newId(), room: r1.id, text: "before" });
    history.replaceState(null, "", `/r/${r1.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("li.msg")?.textContent).toContain("before"));
    const list = root.querySelector("ol.messages")!;

    visit(`/r/${r2.id}`);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    expect(list.isConnected).toBe(false); // out of the page: not found by queries, not read out
    expect(root.querySelectorAll("ol.messages")).toHaveLength(1);
    await api.send({ id: newId(), room: r1.id, text: "meanwhile" });
    await vi.waitFor(() => expect(list.textContent).toContain("meanwhile"));
    const pages = ctl.calls("page");

    visit(`/r/${r1.id}`);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r1.name}`));
    expect(root.querySelector("ol.messages")).toBe(list);
    expect(ctl.calls("page")).toBe(pages);
    expect(root.querySelector("aside.sidebar a[aria-current=page]")?.getAttribute("href")).toBe(`/r/${r1.id}`);

    // Opened at a message, it starts afresh, there.
    const m = await api.send({ id: newId(), room: r1.id, text: "linked" });
    visit(`/r/${r2.id}`);
    await vi.waitFor(() => expect(root.querySelector("header.room-header h1")?.textContent).toBe(`#${r2.name}`));
    visit(`/r/${r1.id}/m/${m.id}`);
    await vi.waitFor(() => expect(root.querySelector("ol.messages")).not.toBe(list));
    expect(root.querySelectorAll("ol.messages")).toHaveLength(1);
  });

  it("a network failure during the background refresh keeps the session (offline ≠ logged out)", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    ctl.failNext("refreshAuth", new ApiError("Failed to fetch", 0));
    app = startApp({ api, root });
    await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
    await tick();
    expect(app.store.get().user?.name).toBe("Ada");
    expect(location.pathname).toBe("/");
  });

  it("a session rejected by the server logs out to the login screen", async () => {
    const { api } = await signedUp("Ada");
    instrument(api).failNext("refreshAuth", new ApiError("The request requires valid record authorization token.", 401));
    app = startApp({ api, root });
    await vi.waitFor(() => expect(location.pathname).toBe("/login"));
    expect(app.store.get().user).toBeNull();
    expect(api.currentUser()).toBeNull();
  });

  it("an expired session goes to the login page, and logging in again goes back to where you were (§23.3)", async () => {
    const ada = await signedUp("Ada");
    const room = await ada.api.createRoom(`r-${newId()}`);
    instrument(ada.api).failNext("refreshAuth", new ApiError("The request requires valid record authorization token.", 401));
    history.replaceState(null, "", `/r/${room.id}`);
    app = startApp({ api: ada.api, root });
    await vi.waitFor(() => expect(location.pathname).toBe("/login"));
    root.querySelector<HTMLInputElement>('input[name="email"]')!.value = ada.email;
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = ada.password;
    root.querySelector("form")!.requestSubmit();
    await vi.waitFor(() => expect(location.pathname).toBe(`/r/${room.id}`));
    await ada.api.unsubscribeAll();
  });

  it("knows when the tab is away (§22.4)", async () => {
    const { api } = await signedUp("Ada");
    app = startApp({ api, root });
    expect(app.store.get().away).toBe(false);
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(app.store.get().away).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    document.dispatchEvent(new Event("visibilitychange"));
    expect(app.store.get().away).toBe(false);
  });

  it("QA BUG-45: an open tab renews the session halfway through its lifetime", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    vi.spyOn(api, "sessionExpiry").mockImplementation(() => Date.now() + 400); // renew every 200 ms
    app = startApp({ api, root });
    await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBeGreaterThanOrEqual(3));
    expect(app.store.get().user?.name).toBe("Ada");
  });

  it("QA BUG-45: a session that ran out (e.g. while the computer slept) logs out once the tab is back", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
    await tick();
    vi.spyOn(api, "sessionExpiry").mockReturnValue(Date.now() - 1);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(location.pathname).toBe("/login"));
    expect(app.store.get().user).toBeNull();
  });

  describe("QA BUG-51: a session revoked on another device (its password changed) is noticed", () => {
    /** Ada, with the app running on a session that another device then revokes by changing the password. */
    async function revoked() {
      const ada = await signedUp("Ada");
      const ctl = instrument(ada.api);
      const room = await ada.api.createRoom(`r-${newId()}`);
      app = startApp({ api: ada.api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      await tick();
      const elsewhere = newApi();
      await elsewhere.logIn(ada.email, ada.password);
      await elsewhere.changePassword(ada.password, "new-password-1");
      return { ...ada, ctl, room };
    }
    /** Time passing (the checks are spaced out), without waiting for it. */
    function later(ms: number) {
      const now = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => now() + ms);
    }

    it("a refused send checks the session, and a revoked one goes to the login screen instead of “Not sent”", async () => {
      const { api, ctl, room } = await revoked();
      later(60_000);
      await expect(api.send({ id: newId(), room: room.id, text: "lost" })).rejects.toThrow();
      await vi.waitFor(() => expect(location.pathname).toBe("/login"));
      expect(ctl.calls("refreshAuth")).toBe(2);
      expect(app!.store.get().user).toBeNull();
    });

    it("QA BUG-151: a send refused just after a check is checked once 30 s have passed", async () => {
      const { api, room } = await revoked();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await expect(api.send({ id: newId(), room: room.id, text: "lost" })).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(location.pathname).toBe("/");
        await vi.advanceTimersByTimeAsync(29_000);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(location.pathname).toBe("/login"));
    });

    it("coming back to a tab whose session wasn't checked for a while checks it", async () => {
      await revoked();
      later(6 * 60_000);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(location.pathname).toBe("/login"));
    });

    it("a refused change with a good session keeps you logged in, and checks at most every 30 s", async () => {
      const { api } = await signedUp("Ada");
      const ctl = instrument(api);
      const room = await api.createRoom(`r-${newId()}`);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      await tick();
      later(60_000);
      await expect(api.createRoom(room.name)).rejects.toThrow(); // taken
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(2));
      await expect(api.createRoom(room.name)).rejects.toThrow();
      await tick();
      expect(ctl.calls("refreshAuth")).toBe(2);
      expect(app.store.get().user?.name).toBe("Ada");
      expect(location.pathname).toBe("/");
    });
  });

  it("logging in through the form goes to the room list", async () => {
    const ada = await signedUp("Ada");
    history.replaceState(null, "", "/login");
    app = startApp({ api: newApi(), root });
    await tick();
    root.querySelector<HTMLInputElement>('input[name="email"]')!.value = ada.email;
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = ada.password;
    root.querySelector("form")!.requestSubmit();
    await vi.waitFor(() => expect(location.pathname).toBe("/"));
    expect(app.store.get().user).toEqual(ada.user);
    expect(meLink()).not.toBeNull();
    await vi.waitFor(() => expect(root.querySelector('nav[aria-label="Rooms"]')).not.toBeNull()); // mounted on navigation
    expect(root.querySelector("button.new-room-toggle")).not.toBeNull();
  });

  it("Log out is on the profile page, not in the app bar (§22.2)", async () => {
    const { api } = await signedUp();
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("aside.sidebar nav[aria-label='Rooms']")).not.toBeNull());
    // The app bar has Jump to and nothing else.
    expect([...root.querySelectorAll("header.app-bar button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Jump to"]);
    expect(logoutButton()).toBeUndefined();
    visit("/me");
    await vi.waitFor(() => expect(logoutButton()).toBeDefined());
    await api.unsubscribeAll();
  });

  it("log out (on the profile page) clears auth, drops realtime subscriptions and goes home as a guest", async () => {
    const { api } = await signedUp("Ada");
    const ctl = instrument(api);
    history.replaceState(null, "", "/me");
    app = startApp({ api, root });
    await vi.waitFor(() => expect(logoutButton()).toBeDefined());
    logoutButton()!.click();
    await tick();
    expect(api.currentUser()).toBeNull();
    expect(ctl.calls("unsubscribeAll")).toBe(1);
    expect(app.store.get().user).toBeNull();
    expect(location.pathname).toBe("/");
    expect(meLink()).toBeNull();
    expect(logoutButton()).toBeUndefined();
    await tick();
    expect([...app.store.get().rooms.values()].every((r) => r.visibility === "open" && !r.archived)).toBe(true);
    expect(app.store.get().hidden.size).toBe(0);
  });

  it("QA BUG-59: whoever logs in after a logout starts from home, not from the previous user's page", async () => {
    const ada = await signedUp("Ada");
    const bob = await signedUp("Bob");
    history.replaceState(null, "", "/me");
    app = startApp({ api: ada.api, root });
    await vi.waitFor(() => expect(logoutButton()).toBeDefined());
    logoutButton()!.click();
    await tick();
    visit("/login");
    await tick();
    await vi.waitFor(() => expect(root.querySelector("form.auth-form")).not.toBeNull());
    root.querySelector<HTMLInputElement>('input[name="email"]')!.value = bob.email;
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = bob.password;
    root.querySelector("form")!.requestSubmit();
    await vi.waitFor(() => expect(app!.store.get().user?.id).toBe(bob.user.id));
    await tick();
    expect(location.pathname).toBe("/");
    await Promise.all([ada.api.unsubscribeAll(), bob.api.unsubscribeAll()]);
  });

  it("QA BUG-66: after logout the tab gets none of the previous user's live events, and the guest's list stays live", async () => {
    const ada = await signedUp("Ada");
    const bob = await signedUp("Bob");
    app = startApp({ api: ada.api, root });
    await vi.waitFor(() => expect(app!.store.get().roomsStatus).toBe("ready"));
    await subscribed(ada.api);
    app.logOut();
    await vi.waitFor(() => expect(app!.store.get().roomsStatus).toBe("ready"));
    await subscribed(ada.api);
    const dm = await bob.api.openDm(ada.user.id);
    await bob.api.send({ id: newId(), room: dm.id, text: "secret" });
    const priv = await bob.api.createRoom(`p-${newId()}`, "private");
    await bob.api.setAccess(priv.id, "private", [ada.user.id]);
    const open = await bob.api.createRoom(`o-${newId()}`, "open");
    // The Open Air room comes live; Ada's DM and private room, sent before it, never do.
    await vi.waitFor(() => expect(app!.store.get().rooms.has(open.id)).toBe(true));
    expect(app.store.get().rooms.has(dm.id)).toBe(false);
    expect(app.store.get().rooms.has(priv.id)).toBe(false);
    await bob.api.unsubscribeAll();
  });

  it("QA BUG-66: logging in from the guest view gets the user's live events", async () => {
    const ada = await signedUp("Ada");
    const bob = await signedUp("Bob");
    const api = newApi();
    history.replaceState(null, "", "/login");
    app = startApp({ api, root });
    await vi.waitFor(() => expect(app!.store.get().roomsStatus).toBe("ready"));
    await subscribed(api);
    await api.logIn(ada.email, ada.password);
    await vi.waitFor(() => expect(app!.store.get().user?.id).toBe(ada.user.id));
    await vi.waitFor(() => expect(app!.store.get().roomsStatus).toBe("ready"));
    await subscribed(api);
    const priv = await bob.api.createRoom(`p-${newId()}`, "private");
    await bob.api.setAccess(priv.id, "private", [ada.user.id]);
    await vi.waitFor(() => expect(app!.store.get().rooms.has(priv.id)).toBe(true));
    await Promise.all([bob.api.unsubscribeAll(), api.unsubscribeAll()]);
  });

  it("after logout, going back to a room that needs an account shows no room content", async () => {
    const { api } = await signedUp("Ada");
    const room = await api.createRoom(`r-${newId()}`);
    await api.send({ id: newId(), room: room.id, text: "members only" });
    history.replaceState(null, "", `/r/${room.id}`);
    app = startApp({ api, root });
    await vi.waitFor(() => expect(root.querySelector("li.msg")).not.toBeNull());
    app.logOut();
    await tick();
    visit(`/r/${room.id}`);
    await vi.waitFor(() => expect(root.querySelector(".not-found")).not.toBeNull());
    expect(root.querySelector("li.msg")).toBeNull();
    expect(root.textContent).not.toContain("members only");
  });

  describe("another tab changes the shared session (BUG-02, BUG-03)", () => {
    const opened: Api[] = [];
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((a) => a.unsubscribeAll().catch(() => {})));
    });

    /** A client whose auth store the test can change directly, as another tab would through localStorage. */
    async function sharedSession(email: string, password: string) {
      const pb = createClient(inject("pbUrl"));
      const api = createApi(pb);
      opened.push(api);
      await api.logIn(email, password);
      return { pb, api };
    }

    it("BUG-33: a profile change in another tab (same user) updates this tab's app bar, without a reset", async () => {
      const ada = await signedUp("Ada");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      const ctl = instrument(api);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      const listsBefore = ctl.calls("listRooms");
      pb.authStore.save(pb.authStore.token, { ...pb.authStore.record!, name: "Ada King", avatar: "new_abcdefghij.png" });
      await tick();
      expect(root.querySelector(".who")?.textContent).toBe("Ada King");
      expect(root.querySelector("header.app-bar img.avatar")?.getAttribute("src")).toContain("new_abcdefghij.png");
      expect(app.store.get().user).toMatchObject({ id: ada.user.id, name: "Ada King" });
      expect(ctl.calls("listRooms")).toBe(listsBefore); // same user: the session wasn't restarted
    });

    it("a logout in another tab logs this tab out too", async () => {
      const ada = await signedUp("Ada");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      app = startApp({ api, root });
      expect(meLink()).not.toBeNull();
      pb.authStore.clear();
      await tick();
      expect(app.store.get().user).toBeNull();
      expect(location.pathname).toBe("/");
      expect(meLink()).toBeNull();
    });

    it("a login as someone else in another tab switches this tab to that user", async () => {
      const ada = await signedUp("Ada");
      const bob = await signedUp("Bob");
      const { pb, api } = await sharedSession(ada.email, ada.password);
      const room = await api.createRoom(`r-${newId()}`);
      history.replaceState(null, "", `/r/${room.id}`);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(root.querySelector(".who")?.textContent).toBe("Ada"));
      const other = createClient(inject("pbUrl"));
      await createApi(other).logIn(bob.email, bob.password);
      pb.authStore.save(other.authStore.token, other.authStore.record);
      await vi.waitFor(() => expect(root.querySelector(".who")?.textContent).toBe("Bob"));
      expect(app.store.get().user?.id).toBe(bob.user.id);
      // The room view was started over for Bob: its own messages are his.
      await vi.waitFor(() => expect(root.querySelector("form.composer")).not.toBeNull());
      const sent = await api.send({ id: newId(), room: room.id, text: "hi" });
      expect(sent.author).toBe(bob.user.id);
    });

    it("our own login, refresh and logout don't trigger a second reset", async () => {
      const ada = await signedUp("Ada");
      const { api } = await sharedSession(ada.email, ada.password);
      const ctl = instrument(api);
      app = startApp({ api, root });
      await vi.waitFor(() => expect(ctl.calls("refreshAuth")).toBe(1));
      await tick();
      expect(ctl.calls("unsubscribeAll")).toBe(0);
      app.logOut();
      await tick();
      expect(ctl.calls("unsubscribeAll")).toBe(1);
    });
  });
});
