// Room view: selecting, deleting and forwarding several messages (§21).

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { first } from "../../../../web/src/lib/cursor.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { NOTICE_MS } from "../../../../web/src/views/room/notice.ts";
import { instrument, seedMessages, signedUp, uniq } from "../../../support/api.ts";
import { bodyOf, button, composer, key, me, mount, msgEl, msgEls, navigate, newRoom, root, store, type, useRoomView } from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("selecting, deleting and forwarding several messages (§21)", () => {
    const bar = () => root.querySelector<HTMLElement>(".selection-bar");
    const box = (id: string) => msgEl(id)?.querySelector<HTMLInputElement>("input.select") ?? null;
    const dialog = () => root.querySelector<HTMLDialogElement>("dialog.forward")!;
    const targetEls = () => [...dialog().querySelectorAll<HTMLButtonElement>(".forward-list button")];
    const targets = () => targetEls().map((b) => b.lastElementChild!.textContent);
    const target = (label: string) => targetEls().find((b) => b.lastElementChild!.textContent === label)!;
    const select = (id: string) => button(msgEl(id), "Select")!.click();
    /** Forward pressed: the dialog is a lazy chunk, open once it has loaded. */
    const forward = async (el: HTMLElement | null) => {
      button(el!, "Forward")!.click();
      await vi.waitFor(() => expect(root.querySelector<HTMLDialogElement>("dialog.forward")?.open).toBe(true));
    };

    it("Select starts selecting: checkboxes on every message, a bar instead of the composer", async () => {
      const room = await newRoom();
      const [a, b] = await seedMessages(room.id, me.user.id, 2);
      await mount(room);
      expect(bar()).toBeNull();
      select(a!.id);
      expect(box(a!.id)!.checked).toBe(true);
      expect(box(b!.id)!.checked).toBe(false);
      expect(document.activeElement).toBe(box(a!.id));
      expect(composer()).toBeNull();
      expect(bar()!.textContent).toContain("1 selected");
      expect(msgEl(a!.id)!.querySelector(".actions")).toBeNull(); // no single-message actions meanwhile
      // A click anywhere on a message toggles it, as does its checkbox.
      msgEl(b!.id)!.querySelector<HTMLElement>(".body")!.click();
      expect(bar()!.textContent).toContain("2 selected");
      // Focus goes to its checkbox: left on the page (the message isn't focusable), it was out of Escape's reach.
      expect(document.activeElement).toBe(box(b!.id));
      expect(msgEl(b!.id)!.classList.contains("selected")).toBe(true);
      box(a!.id)!.click();
      expect(bar()!.textContent).toContain("1 selected");
      // Unselecting the last one, Cancel or Escape stops selecting; the composer and its text come back.
      box(b!.id)!.click();
      expect(bar()).toBeNull();
      expect(box(a!.id)).toBeNull();
      type("draft");
      select(a!.id);
      key(box(a!.id)!, "Escape");
      expect(bar()).toBeNull();
      expect(composer()!.value).toBe("draft");
      expect(document.activeElement).toBe(composer());
      select(a!.id);
      button(bar(), "Cancel")!.click();
      expect(bar()).toBeNull();
    });

    it("deleted and unsent messages can't be selected; one deleted meanwhile is unselected", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.softDelete(gone.id);
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      await mount(room);
      expect(button(msgEl(gone.id), "Select")).toBeNull();
      select(theirs.id);
      expect(box(gone.id)).toBeNull();
      msgEl(mine.id)!.click();
      expect(bar()!.textContent).toContain("2 selected");
      await other.api.softDelete(theirs.id);
      await vi.waitFor(() => expect(bar()!.textContent).toContain("1 selected"));
      expect(box(theirs.id)).toBeNull();
    });

    it("at most 50 messages at a time", async () => {
      const room = await newRoom();
      const seeded = await seedMessages(room.id, me.user.id, 50);
      await mount(room);
      const extra = await me.api.send({ id: newId(), room: room.id, text: "one more" });
      await vi.waitFor(() => expect(msgEl(extra.id)).not.toBeNull());
      select(seeded[0]!.id);
      for (const m of seeded.slice(1)) box(m.id)!.click();
      expect(bar()!.textContent).toContain("50 selected");
      box(extra.id)!.click();
      expect(bar()!.textContent).toContain("50 selected");
      expect(box(extra.id)!.checked).toBe(false);
      expect(root.querySelector(".room-notice")!.textContent).toBe("You can select up to 50 messages at a time.");
      button(bar(), "Cancel")!.click();
      expect(root.querySelector(".room-notice")!.textContent).toBe("");
    });

    it("forwarding can't be cancelled halfway: a failure is always seen", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      const ctl = instrument(me.api);
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(room.id)).toBe(true));
      const release = ctl.hold("forward");
      ctl.failNext("forward", new ApiError("Failed to fetch", 0));
      await forward(msgEl(m.id));
      target(room.name).click();
      expect(button(dialog(), "Cancel")!.disabled).toBe(true);
      const cancel = new Event("cancel", { cancelable: true });
      dialog().dispatchEvent(cancel); // Escape
      expect(cancel.defaultPrevented).toBe(true);
      dialog().close(); // closed anyway (a browser lets a second Escape through)
      release();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward."));
      expect(dialog().open).toBe(true);
      expect(button(dialog(), "Cancel")!.disabled).toBe(false);
    });

    it("the dialog says it is searching for people, not that nothing was found, until it knows", async () => {
      const name = `Quinn ${uniq()}`;
      await signedUp(name);
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      await forward(msgEl(m.id));
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      const status = () => dialog().querySelector(".search-status")!.textContent;
      search.value = name;
      search.dispatchEvent(new Event("input"));
      expect(status()).toBe("Searching…");
      await vi.waitFor(() => expect(targets()).toEqual([name]));
      expect(status()).toBe("");
      search.value = `nobody-${uniq()}`;
      search.dispatchEvent(new Event("input"));
      expect(status()).toBe("Searching…");
      await vi.waitFor(() => expect(status()).toBe("Nothing found."));
    });

    it("Delete is offered only when every selected message is mine; it asks, then deletes them all in one request", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m1 = await me.api.send({ id: newId(), room: room.id, text: "one" });
      const m2 = await me.api.send({ id: newId(), room: room.id, text: "two" });
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const ctl = instrument(me.api);
      await mount(room);
      select(m1.id);
      box(theirs.id)!.click();
      expect(button(bar(), "Delete")!.hidden).toBe(true);
      box(theirs.id)!.click();
      box(m2.id)!.click();
      expect(button(bar(), "Delete")!.hidden).toBe(false);
      button(bar(), "Delete")!.click();
      expect(bar()!.textContent).toContain("Delete these 2 messages?");
      expect(document.activeElement).toBe(button(bar(), "Cancel"));
      key(document.activeElement!, "Escape"); // back to the bar, still selecting
      expect(bar()!.textContent).toContain("2 selected");
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      expect(bar()).toBeNull();
      expect([bodyOf(m1.id), bodyOf(m2.id), bodyOf(theirs.id)]).toEqual(["Message deleted", "Message deleted", "theirs"]);
      await vi.waitFor(() => expect(ctl.calls("deleteMany")).toBe(1));
      expect(ctl.calls("softDelete")).toBe(0);
      await vi.waitFor(async () => expect((await other.api.getMessage(m2.id)).deleted).toBe(true));
    });

    it("a failed delete puts the messages back and says why (QA BUG-58: not always “Check your connection”)", async () => {
      const room = await newRoom();
      const m1 = await me.api.send({ id: newId(), room: room.id, text: "one" });
      const ctl = instrument(me.api);
      ctl.failNext("deleteMany", new ApiError("Failed to fetch", 0));
      ctl.failNext("deleteMany", new ApiError("Too Many Requests.", 429));
      await mount(room);
      const notice = () => root.querySelector(".room-notice")!.textContent;
      select(m1.id);
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      await vi.waitFor(() => expect(notice()).toBe("Couldn't delete those messages. Can't reach the server. Check your connection."));
      expect(bodyOf(m1.id)).toBe("one");
      select(m1.id);
      button(bar(), "Delete")!.click();
      button(bar(), "Delete")!.click();
      await vi.waitFor(() => expect(notice()).toBe("Couldn't delete those messages. Too many attempts. Wait a few seconds and try again."));
      expect(bodyOf(m1.id)).toBe("one");
    });

    it("Forward offers your rooms and DMs; picking one forwards the selection there, in order, and goes there", async () => {
      const bob = await signedUp("Bob");
      const room = await newRoom();
      const elsewhere = await newRoom();
      const dm = await me.api.openDm(bob.user.id);
      const m1 = await bob.api.send({ id: newId(), room: room.id, text: "first" });
      const m2 = await me.api.send({ id: newId(), room: room.id, text: "second" });
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(elsewhere.id)).toBe(true));
      select(m2.id);
      box(m1.id)!.click();
      await forward(bar());
      expect(dialog().open).toBe(true);
      expect(dialog().querySelector("h2")!.textContent).toBe("Forward 2 messages");
      expect(targets()).toEqual(expect.arrayContaining(["Bob", room.name, elsewhere.name]));
      // The "#" is the room's icon, not part of its name too (it showed "# #name").
      expect(target(elsewhere.name).textContent).toBe(`#${elsewhere.name}`);
      expect(targets()[0]).toBe("Bob"); // conversations first
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      expect(document.activeElement).toBe(search);
      search.value = elsewhere.name.slice(-6);
      search.dispatchEvent(new Event("input"));
      expect(targets()).toEqual([elsewhere.name]);
      target(elsewhere.name).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/r/${elsewhere.id}`));
      expect(dialog().open).toBe(false);
      const page = await me.api.page(first(elsewhere.id));
      expect(page.map((m) => [m.text, m.author, m.expand?.forwarded_from?.name])).toEqual([
        ["first", me.user.id, "Bob"],
        ["second", me.user.id, "Me"],
      ]);
      void dm;
    });

    it("Forward on a single message; to someone you have no DM with yet, found by name", async () => {
      const name = `Zed ${uniq()}`;
      const zed = await signedUp(name);
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "psst" });
      await mount(room);
      await forward(msgEl(m.id));
      expect(dialog().querySelector("h2")!.textContent).toBe("Forward message");
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      search.value = name;
      search.dispatchEvent(new Event("input"));
      await vi.waitFor(() => expect(targets()).toEqual([name]));
      target(name).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/r\//)));
      const dmId = navigate.mock.calls.at(-1)![0].slice(3);
      expect(store.get().rooms.get(dmId)?.members).toContain(zed.user.id);
      const [copy] = await zed.api.page(first(dmId));
      expect(copy).toMatchObject({ text: "psst", forwarded_from: me.user.id });
    });

    it("someone you share a private room with, but have no DM with, can be found (QA BUG-73)", async () => {
      const name = `Pat ${uniq()}`;
      const pat = await signedUp(name);
      const room = await newRoom();
      const team = await me.api.setAccess(room.id, "private", [me.user.id, pat.user.id]);
      const m = await me.api.send({ id: newId(), room: room.id, text: "for Pat alone" });
      await mount(team);
      await vi.waitFor(() => expect(store.get().rooms.get(team.id)?.members).toContain(pat.user.id));
      await forward(msgEl(m.id));
      const search = dialog().querySelector<HTMLInputElement>("input")!;
      search.value = name;
      search.dispatchEvent(new Event("input"));
      await vi.waitFor(() => expect(targets()).toEqual([name]));
    });

    it("a forward that fails says why in the dialog and can be tried again; forwarding here stays here", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "again" });
      const ctl = instrument(me.api);
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(room.id)).toBe(true));
      ctl.failNext("forward", new ApiError("Failed to fetch", 0));
      await forward(msgEl(m.id));
      target(room.name).click();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward. Can't reach the server."));
      expect(dialog().open).toBe(true);
      target(room.name).click();
      await vi.waitFor(() => expect(dialog().open).toBe(false));
      expect(navigate).not.toHaveBeenCalled();
      expect(root.querySelector(".room-notice")!.textContent).toBe("Message forwarded.");
      await vi.waitFor(() => expect(msgEls().at(-1)!.querySelector(".forwarded")?.textContent).toBe("Forwarded from Me"));
      // A confirmation, not a state: it goes away by itself (§22.6).
      await vi.waitFor(() => expect(root.querySelector(".room-notice")!.textContent).toBe(""), { timeout: NOTICE_MS + 2000 });
    });

    it("a message deleted while the dialog is open is left out, not failing the rest; a refusal says why", async () => {
      const bob = await signedUp("Bob");
      const room = await newRoom();
      const elsewhere = await newRoom();
      const theirs = await bob.api.send({ id: newId(), room: room.id, text: "soon gone" });
      const mine = await me.api.send({ id: newId(), room: room.id, text: "stays" });
      const ctl = instrument(me.api);
      await mount(room);
      await vi.waitFor(() => expect(store.get().rooms.has(elsewhere.id)).toBe(true));
      select(mine.id);
      box(theirs.id)!.click();
      await forward(bar());
      await bob.api.softDelete(theirs.id);
      await vi.waitFor(() => expect(bodyOf(theirs.id)).toBe("Message deleted"));
      target(elsewhere.name).click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/r/${elsewhere.id}`));
      const page = await me.api.page(first(elsewhere.id));
      expect(page.map((m) => m.text)).toEqual(["stays"]);

      // What the server says is wrong is shown, not just "Failed to forward the messages.".
      ctl.failNext("forward", new ApiError("Failed to forward the messages.", 400, { room: "This room is archived and read-only." }));
      await forward(msgEl(mine.id));
      target(elsewhere.name).click();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward. This room is archived and read-only."));
      // Deleted before you pick where: nothing is sent.
      dialog().querySelector<HTMLButtonElement>("button.cancel")!.click();
      await forward(msgEl(mine.id));
      await me.api.softDelete(mine.id);
      await vi.waitFor(() => expect(bodyOf(mine.id)).toBe("Message deleted"));
      const sent = ctl.calls("forward");
      target(elsewhere.name).click();
      await vi.waitFor(() => expect(dialog().textContent).toContain("Couldn't forward. A message was deleted."));
      expect(ctl.calls("forward")).toBe(sent);
    });

    it("a forward shows its original as it is now: an edit, then that it was deleted (§21.3)", async () => {
      const from = await newRoom();
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: from.id, text: "first take" });
      const [copy] = await me.api.forward([m.id], room.id);
      await mount(room);
      await vi.waitFor(() => expect(bodyOf(copy!.id)).toBe("first take"));
      await me.api.edit(m.id, "second take");
      await vi.waitFor(() => expect(bodyOf(copy!.id)).toBe("second take"));
      await me.api.softDelete(m.id);
      await vi.waitFor(() => expect(bodyOf(copy!.id)).toBe("The original message was deleted"));
      expect(msgEl(copy!.id)!.querySelector(".forwarded")?.textContent).toBe("Forwarded from Me");
      // Nothing left to forward on (the server would refuse it), but it can still be deleted.
      expect(button(msgEl(copy!.id), "Forward")).toBeNull();
      expect(button(msgEl(copy!.id), "Delete")).not.toBeNull();
    });

    it("archived rooms: forwarding still works, deleting doesn't", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "kept" });
      await me.api.setArchived(room.id, true);
      await mount(room);
      expect(button(msgEl(m.id), "Forward")).not.toBeNull();
      select(m.id);
      expect(button(bar(), "Forward")).not.toBeNull();
      expect(button(bar(), "Delete")!.hidden).toBe(true);
      expect(root.querySelector(".archived-banner")).toBeNull();
      button(bar(), "Cancel")!.click();
      expect(root.querySelector(".archived-banner")).not.toBeNull();
    });
  });
});
