// "Mentions & replies" (§41): the page lists what was told to you, marks what is new, and sees it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../web/src/dom.ts";
import { newId } from "../../../web/src/lib/id.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { mountInbox } from "../../../web/src/views/inbox.ts";
import { type SignedUp, signedUp, uniq } from "../../support/api.ts";

describe("inbox page (§41)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let ac: AbortController;

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Me");
    store = createStore<AppState>({ ...initialState(), user: me.user });
    ac = new AbortController();
  });
  afterEach(() => {
    ac.abort();
    root.remove();
  });

  const mount = () =>
    mountInbox(root, {
      api: me.api,
      h,
      store,
      signal: ac.signal,
      avatar: (u) => h("span", { class: "avatar" }, u.name[0]),
      roomName: (id) => (store.get().rooms.get(id) ? `#${store.get().rooms.get(id)!.name}` : ""),
      when: () => "now",
    });
  const rows = () => [...root.querySelectorAll<HTMLLIElement>(".inbox-list li")];

  it("lists mentions, replies and reactions, newest first, each a link to its message; opening it sees them", async () => {
    const other = await signedUp(`Other ${uniq()}`);
    const room = await other.api.createRoom(`room-${uniq()}`);
    store.set({ rooms: new Map([[room.id, room]]), inbox: 3 });
    const mine = await me.api.send({ id: newId(), room: room.id, text: "my words" });
    const mention = await other.api.send({ id: newId(), room: room.id, text: `hi @${me.user.handle}` });
    const reply = await other.api.send({ id: newId(), room: room.id, text: "answer", replyTo: mine.id });
    await other.api.react(mine.id, "👍", true);
    await mount();
    expect(root.querySelector("h1")!.textContent).toBe("Mentions & replies");
    expect(rows().map((r) => r.querySelector(".inbox-what")!.textContent)).toEqual([
      `${other.user.name} reacted 👍 to your message in #${room.name}now`,
      `${other.user.name} replied to you in #${room.name}now`,
      `${other.user.name} mentioned you in #${room.name}now`,
    ]);
    expect(rows().map((r) => r.querySelector("a")!.getAttribute("href"))).toEqual([
      `/r/${room.id}/m/${mine.id}`,
      `/r/${room.id}/m/${reply.id}`,
      `/r/${room.id}/m/${mention.id}`,
    ]);
    expect(rows()[1]!.querySelector(".inbox-quote")!.textContent).toBe("my words");
    expect(rows().every((r) => r.classList.contains("new"))).toBe(true);
    expect(store.get().inbox).toBe(0);
    await vi.waitFor(async () => expect((await me.api.unreadCounts()).inbox).toBe(0));

    // Again: nothing new.
    ac.abort();
    ac = new AbortController();
    await mount();
    expect(rows().some((r) => r.classList.contains("new"))).toBe(false);
  });

  it("drops a row taken away while it is open (QA BUG-254)", async () => {
    const other = await signedUp(`Other ${uniq()}`);
    const room = await other.api.createRoom(`room-${uniq()}`);
    store.set({ rooms: new Map([[room.id, room]]) });
    const kept = await other.api.send({ id: newId(), room: room.id, text: `stays @${me.user.handle}` });
    const gone = await other.api.send({ id: newId(), room: room.id, text: `goes @${me.user.handle}` });
    await mount();
    expect(rows()).toHaveLength(2);
    await other.api.edit(gone.id, "goes nowhere");
    await vi.waitFor(() => expect(rows()).toHaveLength(1), { timeout: 5000 });
    expect(rows()[0]!.querySelector("a")!.getAttribute("href")).toBe(`/r/${room.id}/m/${kept.id}`);
  });

  it("says when there is nothing", async () => {
    await mount();
    expect(rows()).toEqual([]);
    expect(root.querySelector(".inbox-status")!.textContent).toContain("Nothing here yet.");
  });
});
