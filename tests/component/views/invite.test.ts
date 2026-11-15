// The invite page (DESIGN.md §44.2, views/invite.ts): where a link goes, joining by it, a guest asked to log in, a
// member taken to the room, and a link that doesn't work.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "../../../web/src/lib/types.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState } from "../../../web/src/store.ts";
import { createInviteView } from "../../../web/src/views/invite.ts";
import { newApi, type SignedUp, signedUp, uniq, viewContext } from "../../support/api.ts";

describe("invite page (§44.2)", () => {
  let root: HTMLElement;
  let owner: SignedUp;
  let room: Room;
  let token: string;
  let views: View[];

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    owner = await signedUp(`Owner ${uniq()}`);
    room = await owner.api.createRoom(`club-${uniq()}`, "private");
    token = (await (await owner.api.invites()).make(room.id, 7)).token;
    views = [];
  });
  afterEach(() => {
    for (const v of views) v.unmount();
    root.remove();
  });

  function mount(who: SignedUp | null, t = token) {
    const api = who?.api ?? newApi();
    const store = createStore<AppState>({ ...initialState(), user: who?.user ?? null });
    const navigate = vi.fn();
    const ctx = viewContext(api, store, navigate);
    const view = createInviteView(ctx);
    views.push(view);
    const el = document.createElement("div");
    root.append(el);
    view.mount(el, { token: t });
    return { el, navigate, store };
  }
  const heading = (el: Element) => el.querySelector("h1")?.textContent;

  it("someone signed in sees the room and who invited them, joins, and goes to it", async () => {
    const cat = await signedUp(`Cat ${uniq()}`);
    const { el, navigate } = mount(cat);
    await vi.waitFor(() => expect(heading(el)).toBe(`Join #${room.name}`));
    expect(el.textContent).toContain(`${owner.user.name} invited you to this private room. 1 member`);
    el.querySelector<HTMLButtonElement>("button.primary")!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/r/${room.id}`));
    expect((await owner.api.listRooms()).find((r) => r.id === room.id)?.members).toEqual([owner.user.id, cat.user.id]);
  });

  it("a guest is asked to log in or sign up", async () => {
    const { el } = mount(null);
    await vi.waitFor(() => expect(heading(el)).toBe(`Join #${room.name}`));
    expect([...el.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/login", "/signup"]);
    expect(el.querySelector("button")).toBeNull();
  });

  it("a member is taken to the room", async () => {
    const { el } = mount(owner);
    await vi.waitFor(() => expect(el.textContent).toContain("You're in this room already."));
    expect(el.querySelector("a")!.getAttribute("href")).toBe(`/r/${room.id}`);
  });

  it("a link that doesn't work says so, also when it stops working before you join", async () => {
    const { el } = mount(null, "x".repeat(24));
    await vi.waitFor(() => expect(heading(el)).toBe("This invite link doesn't work"));

    const cat = await signedUp(`Cat ${uniq()}`);
    const page = mount(cat);
    await vi.waitFor(() => expect(page.el.querySelector("button.primary")).not.toBeNull());
    await (await owner.api.invites()).revoke(room.id);
    page.el.querySelector<HTMLButtonElement>("button.primary")!.click();
    await vi.waitFor(() => expect(heading(page.el)).toBe("This invite link doesn't work"));
    expect(page.navigate).not.toHaveBeenCalled();
  });
});
