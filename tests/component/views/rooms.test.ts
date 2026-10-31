import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Api, ApiError } from "../../../web/src/api.ts";
import { newId } from "../../../web/src/lib/id.ts";
import type { Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { createRoomsView } from "../../../web/src/views/rooms.ts";
import { instrument, type SignedUp, signedUp, subscribed, uniq, viewContext } from "../../support/api.ts";

type Section = "rooms" | "dms" | "more" | "hidden" | "archived";

describe("rooms view (§7.1)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let navigate: ReturnType<typeof vi.fn<(hash: string) => void>>;
  let view: View | undefined;

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
    navigate = vi.fn();
  });
  afterEach(async () => {
    view?.unmount();
    view = undefined;
    root.remove();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  async function mount(api: Api = me.api) {
    view = createRoomsView(viewContext(api, store, navigate));
    view.mount(root, {});
    await vi.waitFor(() => expect(root.querySelector("[aria-busy='true']")).toBeNull());
    await subscribed(api); // live events caused from here on reach the view
  }

  const row = (room: Room) => root.querySelector<HTMLElement>(`[data-room-id="${room.id}"]`);
  const sectionOf = (room: Room): Section | null =>
    (row(room)?.closest<HTMLElement>("[data-section]")?.dataset.section as Section | undefined) ?? null;
  const section = (s: Section) => root.querySelector<HTMLElement>(`[data-section="${s}"]`)!;
  /** Row titles (a DM row's link also holds the avatar; take the name). */
  const names = (s: Section) =>
    [...section(s).querySelectorAll("[data-room-id] a")].map((a) => a.querySelector("span:not(.avatar)")?.textContent ?? a.textContent);
  const button = (scope: Element, label: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label) ?? null;
  /** A row's button: only hidden and archived rows have one (Unhide, Unarchive); the rest is in the room's menu. */
  const action = (room: Room, label: string) => button(row(room)!, label);
  const room = (name = `room-${uniq()}`) => me.api.createRoom(name);

  describe("rendering", () => {
    it("shows rooms, hidden and archived sections, each sorted by name", async () => {
      const b = await room(`b-${uniq()}`);
      const a = await room(`A-${uniq()}`);
      const h = await room(`h-${uniq()}`);
      const x = await room(`x-${uniq()}`);
      await me.api.hideRoom(h.id);
      await me.api.setArchived(x.id, true);
      await mount();

      expect(sectionOf(a)).toBe("rooms");
      expect(sectionOf(b)).toBe("rooms");
      expect(sectionOf(h)).toBe("hidden");
      expect(sectionOf(x)).toBe("archived");
      const mine = names("rooms").filter((n) => n === a.name || n === b.name);
      expect(mine).toEqual([a.name, b.name]);
    });

    it("rooms link to their page; the active room is marked", async () => {
      const r = await room();
      store.set({ activeRoomId: r.id });
      await mount();
      const link = row(r)!.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(`/r/${r.id}`);
      expect(link.getAttribute("aria-current")).toBe("page");
    });

    it("hidden and archived rooms are in one folded section, with how many there are", async () => {
      const h = await room();
      await me.api.hideRoom(h.id);
      await mount();
      const more = section("more") as HTMLDetailsElement;
      expect(more.open).toBe(false);
      expect(section("hidden").closest("details")).toBe(more);
      expect(section("archived").closest("details")).toBe(more);
      const rows = (s: Section) => section(s).querySelectorAll("[data-room-id]").length;
      expect(rows("hidden")).toBe((await me.api.listHidden()).length);
      expect(more.querySelector("summary")!.textContent).toBe(`Hidden & archived${rows("hidden") + rows("archived")}`);
    });

    it("shows an empty state when there are no rooms", async () => {
      const api = me.api;
      vi.spyOn(api, "listRooms").mockResolvedValue([]);
      // Other test files create rooms on the shared server; keep their live events out of this view.
      vi.spyOn(api, "subscribeRooms").mockResolvedValue(async () => {});
      await mount(api);
      expect(section("rooms").textContent).toContain("No rooms yet");
    });

    it("QA BUG-44: with every room hidden or archived, it doesn't claim there are no rooms", async () => {
      const hidden = await room();
      const archived = await room();
      await me.api.hideRoom(hidden.id);
      await me.api.setArchived(archived.id, true);
      vi.spyOn(me.api, "listRooms").mockResolvedValue([hidden, { ...archived, archived: true }]);
      vi.spyOn(me.api, "subscribeRooms").mockResolvedValue(async () => {});
      await mount();
      expect(sectionOf(hidden)).toBe("hidden");
      expect(section("rooms").textContent).not.toContain("No rooms yet");
      expect(section("rooms").textContent).toContain("Hidden and archived ones are listed below.");
    });

    it("shows an error with a retry when loading fails", async () => {
      const ctl = instrument(me.api);
      ctl.failNext("listRooms", new ApiError("Failed to fetch", 0));
      const r = await room();
      await mount();
      const alert = root.querySelector('[role="alert"]')!;
      expect(alert.textContent).toContain("Couldn't load rooms");
      button(root, "Retry")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
      expect(alert.textContent).toBe("");
    });
  });

  describe("creating", () => {
    const toggle = () => root.querySelector<HTMLButtonElement>("button.new-room-toggle")!;
    /** Opens the form with "+ New room" and returns its input. */
    function openForm(): HTMLInputElement {
      toggle().click();
      return root.querySelector<HTMLInputElement>('form.new-room input[name="name"]')!;
    }

    it("the form is closed until “+ New room” (in the Rooms heading) opens it, focused; Escape or the toggle closes it", async () => {
      await mount();
      expect(toggle().closest("[data-section]")).toBe(section("rooms"));
      expect(root.querySelector("form.new-room")).toBeNull();
      expect(toggle().getAttribute("aria-expanded")).toBe("false");

      const input = openForm();
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(input);
      input.value = "draft";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(root.querySelector("form.new-room")).toBeNull();
      expect(document.activeElement).toBe(toggle());

      expect(openForm().value).toBe(""); // closing discards the draft
      toggle().click();
      expect(root.querySelector("form.new-room")).toBeNull();
    });

    it("creates a room, shows it, opens it, and closes the form", async () => {
      await mount();
      const name = `new-${uniq()}`;
      const input = openForm();
      input.value = name;
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/r\/[a-z0-9]{15}$/)));
      const id = navigate.mock.calls[0]![0].slice(3);
      expect(store.get().rooms.get(id)?.name).toBe(name);
      expect(root.querySelector(`[data-room-id="${id}"]`)).not.toBeNull();
      expect(input.value).toBe("");
      expect(root.querySelector("form.new-room")).toBeNull();
    });

    it("shows a duplicate-name error inline and keeps the input", async () => {
      const taken = await room(`taken-${uniq()}`);
      await mount();
      const input = openForm();
      input.value = taken.name.toUpperCase();
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      const err = () => document.getElementById(input.getAttribute("aria-describedby")!)!;
      await vi.waitFor(() => expect(err().textContent).toBe("A room with this name already exists."));
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe(taken.name.toUpperCase());
      expect(navigate).not.toHaveBeenCalled();
    });

    it("the name must be 1–48 characters, counted as the server counts them (an emoji is one)", async () => {
      const ctl = instrument(me.api);
      await mount();
      const input = openForm();
      const err = () => document.getElementById(input.getAttribute("aria-describedby")!)!;
      expect(input.required).toBe(true);
      // No maxlength: the browser would count UTF-16 units and stop at 24 emoji.
      expect(input.getAttribute("maxlength")).toBeNull();
      input.value = "x".repeat(49);
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      expect(err().textContent).toBe("Must be no more than 48 characters.");
      expect(ctl.calls("createRoom")).toBe(0);
      input.value = `${"🎉".repeat(40)}${uniq().slice(-8)}`; // 40 emoji + 8 = 48 characters (88 UTF-16 units)
      root.querySelector<HTMLFormElement>("form")!.requestSubmit();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    });
  });

  describe("hide and unhide (§5.4)", () => {
    it("rows in Rooms have no menu or buttons: Hide, Archive and the rest are in the room's own menu", async () => {
      const r = await room();
      await mount();
      expect(row(r)!.querySelector("details, button")).toBeNull();
    });

    it("a hidden room is listed under Hidden; its Unhide moves it back", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      await mount();
      expect(sectionOf(r)).toBe("hidden");

      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
      expect((await me.api.listHidden()).map((h) => h.room)).not.toContain(r.id);
    });

    it("a hide from another tab (realtime) updates the sections", async () => {
      const r = await room();
      await mount();
      const otherTab = await signedUpSameUser();
      const row = await otherTab.hideRoom(r.id);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("hidden"));
      await otherTab.unhideRoom(row.id);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("new messages in a hidden room change nothing in the list (silent hide)", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      await mount();
      const before = section("hidden").innerHTML;
      await me.api.send({ id: newId(), room: r.id, text: "psst" });
      await new Promise((res) => setTimeout(res, 300));
      expect(section("hidden").innerHTML).toBe(before);
    });

    it("archived rooms offer no Hide action (archived wins)", async () => {
      const r = await room();
      await me.api.setArchived(r.id, true);
      await mount();
      expect(action(r, "Hide")).toBeNull();
    });

    it("an archived room you had hidden can be unhidden from Archived", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      await me.api.setArchived(r.id, true);
      await mount();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("archived"));
      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(r.id)).toBe(false));
      await me.api.setArchived(r.id, false);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });
  });

  describe("archive and unarchive", () => {
    it("only the creator gets Unarchive", async () => {
      const other = await signedUp("Other");
      const theirs = await other.api.createRoom(`theirs-${uniq()}`);
      await other.api.setArchived(theirs.id, true);
      const mine = await room();
      await me.api.setArchived(mine.id, true);
      await mount();
      await vi.waitFor(() => expect(sectionOf(theirs)).toBe("archived"));
      expect(action(mine, "Unarchive")).not.toBeNull();
      expect(row(theirs)!.querySelector("button")).toBeNull();
    });

    it("Unarchive moves it back", async () => {
      const r = await room();
      await me.api.setArchived(r.id, true);
      await mount();
      action(r, "Unarchive")!.click();
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("an archive by the creator elsewhere (realtime) moves the room for everyone", async () => {
      const owner = await signedUp("Owner");
      const r = await owner.api.createRoom(`shared-${uniq()}`);
      await mount();
      expect(sectionOf(r)).toBe("rooms");
      await owner.api.setArchived(r.id, true);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("archived"));
      await owner.api.setArchived(r.id, false);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("a failed action shows an error and leaves the room where it was", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      instrument(me.api).failNext("unhideRoom", new ApiError("Failed to fetch", 0));
      await mount();
      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toContain("Couldn't unhide"));
      expect(root.querySelector('[role="alert"]')!.textContent).toContain("Check your connection");
      expect(sectionOf(r)).toBe("hidden");
    });

    it("QA BUG-39: a failed action says why, e.g. rate limiting, not always the connection", async () => {
      const r = await room();
      await me.api.hideRoom(r.id);
      instrument(me.api).failNext("unhideRoom", new ApiError("Too Many Requests.", 429));
      await mount();
      action(r, "Unhide")!.click();
      await vi.waitFor(() => expect(root.querySelector('[role="alert"]')!.textContent).toContain("Too many attempts"));
      expect(root.querySelector('[role="alert"]')!.textContent).not.toContain("connection");
    });
  });

  describe("unread badges (§18.4)", () => {
    const badge = (r: Room) => row(r)?.querySelector(".badge") ?? null;

    it("shows the count (99+ past 99) with a screen-reader label, and makes the name bold", async () => {
      const a = await room();
      const b = await room();
      const quiet = await room();
      await mount();
      store.set({
        unread: new Map([
          [a.id, 3],
          [b.id, 250],
        ]),
      });
      expect(badge(a)!.textContent).toBe("3 unread");
      expect(badge(a)!.querySelector(".visually-hidden")!.textContent).toBe(" unread");
      expect(badge(b)!.textContent).toBe("99+ unread");
      expect(row(a)!.querySelector("a")!.classList.contains("unread")).toBe(true);
      expect(badge(quiet)).toBeNull();
      expect(row(quiet)!.querySelector("a")!.classList.contains("unread")).toBe(false);
    });

    it("a new count redraws only that room's row; the others are kept as they are", async () => {
      const a = await room();
      const b = await room();
      await mount();
      const [rowA, rowB] = [row(a), row(b)];
      store.set({ unread: new Map([[a.id, 1]]) });
      expect(badge(a)!.textContent).toBe("1 unread");
      expect(row(a)).not.toBe(rowA);
      expect(row(b)).toBe(rowB);
    });

    it("no badge for the room you are in, or for hidden and archived rooms", async () => {
      const active = await room();
      const hidden = await room();
      const archived = await room();
      await me.api.hideRoom(hidden.id);
      await me.api.setArchived(archived.id, true);
      store.set({ activeRoomId: active.id });
      await mount();
      store.set({ unread: new Map([active, hidden, archived].map((r) => [r.id, 2])) });
      expect([active, hidden, archived].map(badge)).toEqual([null, null, null]);
    });

    it("a message from someone else shows up live; DMs get a badge too", async () => {
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`room-${uniq()}`);
      const dm = await other.api.openDm(me.user.id);
      await mount();
      await other.api.send({ id: newId(), room: r.id, text: "hello" });
      await other.api.send({ id: newId(), room: dm.id, text: "psst" });
      await vi.waitFor(() => expect(badge(r)?.textContent).toBe("1 unread"));
      await vi.waitFor(() => expect(badge(dm)?.textContent).toBe("1 unread"));
    });
  });

  describe("folding", () => {
    const fold = (s: string) => root.querySelector<HTMLButtonElement>(`button[data-fold="${s}"]`)!;
    // Folding is kept for the page's lifetime: leave the sections open for the other tests.
    afterEach(() => {
      if (fold("rooms")?.getAttribute("aria-expanded") === "false") fold("rooms").click();
    });

    it("a heading folds its section to its unread rooms and the open one, remembered across mounts", async () => {
      const quiet = await room();
      const busy = await room();
      const open = await room();
      store.set({ activeRoomId: open.id });
      await mount();
      store.set({ unread: new Map([[busy.id, 2]]) });
      expect(fold("rooms").getAttribute("aria-expanded")).toBe("true");
      expect(fold("rooms").closest("h2")!.textContent).toBe("Rooms");

      fold("rooms").click();
      expect(fold("rooms").getAttribute("aria-expanded")).toBe("false");
      expect(row(quiet)).toBeNull();
      expect(row(busy)).not.toBeNull();
      expect(row(open)).not.toBeNull();
      expect(fold("dms").getAttribute("aria-expanded")).toBe("true"); // the others stay as they were
      store.set({ unread: new Map() });
      expect(row(busy)).toBeNull();

      view!.unmount();
      await mount();
      expect(fold("rooms").getAttribute("aria-expanded")).toBe("false");
      expect(row(quiet)).toBeNull();
      fold("rooms").click();
      expect(row(quiet)).not.toBeNull();
      expect(localStorage.getItem("chat.folded")).toBe("[]");
    });
  });

  describe("realtime room list", () => {
    it("a room created elsewhere appears", async () => {
      await mount();
      const other = await signedUp("Other");
      const r = await other.api.createRoom(`elsewhere-${uniq()}`);
      await vi.waitFor(() => expect(sectionOf(r)).toBe("rooms"));
    });

    it("mounting fetches and subscribes nothing itself; the running sync supplies the data", async () => {
      const ctl = instrument(me.api);
      const ctx = viewContext(me.api, store, navigate);
      await vi.waitFor(() => expect(store.get().roomsStatus).toBe("ready"));
      view = createRoomsView(ctx);
      view.mount(root, {});
      expect(root.querySelector("[aria-busy='true']")).toBeNull();
      view.unmount();
      view = undefined;
      expect(root.childNodes).toHaveLength(0);
      expect(ctl.calls("listRooms")).toBe(1);
      expect(ctl.calls("subscribeRooms")).toBe(1);
    });
  });

  describe("direct messages (§16.5)", () => {
    const newDmButton = () => root.querySelector<HTMLButtonElement>("button.new-dm")!;
    const searchInput = () => root.querySelector<HTMLInputElement>(".user-search input");
    const results = () => [...root.querySelectorAll<HTMLButtonElement>(".user-search button.person")];
    const searchFor = (q: string) => {
      searchInput()!.value = q;
      searchInput()!.dispatchEvent(new Event("input"));
    };

    it("lists open DMs by activity, titled after the other person with their avatar; no # prefix", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const cat = await signedUp(`Cat ${uniq()}`);
      const withBob = await me.api.openDm(bob.user.id);
      const withCat = await me.api.openDm(cat.user.id);
      await bob.api.send({ id: newId(), room: withBob.id, text: "latest" });
      await mount();
      await vi.waitFor(() => expect(names("dms")).toEqual([bob.user.name, cat.user.name]));
      expect(row(withBob)!.classList.contains("dm")).toBe(true);
      expect(row(withBob)!.querySelector("a .avatar")!.textContent?.[0]).toBe("B");
      expect(sectionOf(withCat)).toBe("dms");
    });

    it("a new message in a DM moves it to the top, live", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const cat = await signedUp(`Cat ${uniq()}`);
      const withBob = await me.api.openDm(bob.user.id);
      const withCat = await me.api.openDm(cat.user.id);
      await bob.api.send({ id: newId(), room: withBob.id, text: "first" });
      await mount();
      await vi.waitFor(() => expect(names("dms")).toEqual([bob.user.name, cat.user.name]));
      await cat.api.send({ id: newId(), room: withCat.id, text: "now me" });
      await vi.waitFor(() => expect(names("dms")).toEqual([cat.user.name, bob.user.name]));
    });

    it("a DM someone else starts appears live with its first message, not before (BUG-29)", async () => {
      await mount();
      const bob = await signedUp(`Bob ${uniq()}`);
      const dm = await bob.api.openDm(me.user.id);
      await vi.waitFor(() => expect(store.get().rooms.has(dm.id)).toBe(true));
      expect(row(dm)).toBeNull();
      await bob.api.send({ id: newId(), room: dm.id, text: "hi" });
      await vi.waitFor(() => expect(sectionOf(dm)).toBe("dms"));
      expect(names("dms")).toContain(bob.user.name);
    });

    it("a conversation closed (from its room) leaves the list", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const dm = await me.api.openDm(bob.user.id);
      await mount();
      await vi.waitFor(() => expect(sectionOf(dm)).toBe("dms"));
      expect(row(dm)!.querySelector("details, button")).toBeNull();
      await me.api.hideRoom(dm.id);
      await vi.waitFor(() => expect(row(dm)).toBeNull());
    });

    it("BUG-30: picking someone you already have an open DM with goes straight there, without a request", async () => {
      const tag = uniq();
      const bob = await signedUp(`Bobby ${tag}`);
      const dm = await me.api.openDm(bob.user.id);
      const ctl = instrument(me.api);
      await mount();
      await vi.waitFor(() => expect(sectionOf(dm)).toBe("dms"));
      newDmButton().click();
      searchFor(`Bobby ${tag}`);
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      results()[0]!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/r/${dm.id}`));
      expect(ctl.calls("openDm")).toBe(0);
    });

    it("someone on a linked instance is found by address (§33.5), or the reason they can't be", async () => {
      const bob = await signedUp(`Bob ${uniq()}`);
      const stub = vi.spyOn(me.api, "remoteUser").mockResolvedValueOnce({ ...bob.user, instance: "b.example" });
      await mount();
      newDmButton().click();
      searchFor("bob@b.example");
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      expect(stub).toHaveBeenCalledWith("bob@b.example");
      expect(results()[0]!.title).toBe("On b.example");
      results()[0]!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/r\//)));
      stub.mockRejectedValueOnce(new ApiError("Failed to find them.", 400, { address: "This instance isn't linked to b.example." }));
      newDmButton().click();
      searchFor("zed@b.example");
      await vi.waitFor(() =>
        expect(root.querySelector(".user-search .search-status")!.textContent).toBe("This instance isn't linked to b.example."),
      );
    });

    it("BUG-30: a failure to open a DM says why (rate limiting is not a connection problem)", async () => {
      const tag = uniq();
      await signedUp(`Bobby ${tag}`);
      const ctl = instrument(me.api);
      ctl.failNext("openDm", new ApiError("Too many requests.", 429));
      await mount();
      newDmButton().click();
      searchFor(`Bobby ${tag}`);
      await vi.waitFor(() => expect(results()).toHaveLength(1));
      results()[0]!.click();
      await vi.waitFor(() => expect(root.querySelector(".list-error")!.textContent).toMatch(/Too many attempts/));
      expect(root.querySelector(".list-error")!.textContent).not.toMatch(/connection/);
    });

    it("+ opens a debounced user search; picking someone opens the DM and navigates to it", async () => {
      const tag = uniq();
      const bob = await signedUp(`Bobby ${tag}`);
      const ctl = instrument(me.api);
      await mount();
      expect(searchInput()).toBeNull();
      newDmButton().click();
      expect(newDmButton().getAttribute("aria-expanded")).toBe("true");
      expect(document.activeElement).toBe(searchInput());
      searchFor("Bob");
      searchFor(`Bobby ${tag}`);
      await vi.waitFor(() => expect(results().map((b) => b.querySelector("span:not(.avatar)")!.textContent)).toEqual([bob.user.name]));
      expect(ctl.calls("searchUsers")).toBe(1); // the first keystroke was debounced away
      results()[0]!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/r\//)));
      const roomId = navigate.mock.calls[0]![0].slice(3);
      expect(store.get().rooms.get(roomId)?.kind).toBe("dm");
      expect(searchInput()).toBeNull();
    });

    it("the search says when nobody matches, and Escape closes it, returning focus to +", async () => {
      await mount();
      newDmButton().click();
      searchFor(`nobody-${uniq()}`);
      await vi.waitFor(() => expect(root.querySelector(".search-status")!.textContent).toBe("No one found."));
      searchInput()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(searchInput()).toBeNull();
      expect(document.activeElement).toBe(newDmButton());
    });

    it("arrow keys move between the input and the results", async () => {
      const tag = uniq();
      await signedUp(`Arrow ${tag} 1`);
      await signedUp(`Arrow ${tag} 2`);
      await mount();
      newDmButton().click();
      searchFor(`Arrow ${tag}`);
      await vi.waitFor(() => expect(results()).toHaveLength(2));
      const down = (el: Element, key = "ArrowDown") => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      down(searchInput()!);
      expect(document.activeElement).toBe(results()[0]);
      down(results()[0]!);
      expect(document.activeElement).toBe(results()[1]);
      down(results()[1]!, "ArrowUp");
      down(results()[0]!, "ArrowUp");
      expect(document.activeElement).toBe(searchInput());
    });
  });

  /** A second client logged in as the same user ("another tab"). */
  async function signedUpSameUser(): Promise<Api> {
    const { newApi } = await import("../../support/api.ts");
    const api = newApi();
    await api.logIn(me.email, me.password);
    return api;
  }
});
