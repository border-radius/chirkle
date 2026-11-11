// Room view: the header menu and archived rooms (§7.1, §5.8).

import { describe, expect, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import { seedMessages, signedUp } from "../../../support/api.ts";
import {
  button,
  composer,
  headerMenu,
  io,
  me,
  mount,
  msgEl,
  msgEls,
  newRoom,
  root,
  sentinel,
  store,
  useRoomView,
  view,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("archived rooms (5.8)", () => {
    it("show a read-only banner instead of the composer, with no message actions", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "history" });
      await me.api.setArchived(room.id, true);
      await mount(room);
      expect(composer()).toBeNull();
      expect(root.querySelector(".archived-banner")!.textContent).toBe("This room is archived. History is read-only.");
      expect(button(msgEl(m.id), "Edit")).toBeNull();
      expect(button(msgEl(m.id), "Delete")).toBeNull();
    });

    it("history in an archived room still loads older pages", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 120);
      await me.api.setArchived(room.id, true);
      await mount(room);
      io.intersect(sentinel("top"));
      await vi.waitFor(() => expect(msgEls().length).toBe(100));
    });

    it("archiving while the room is open switches it to read-only live; unarchiving restores the composer", async () => {
      const owner = await signedUp("Owner");
      const room = await newRoom(owner);
      await mount(room);
      expect(composer()).not.toBeNull();
      await owner.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(composer()).toBeNull());
      await owner.api.setArchived(room.id, false);
      await vi.waitFor(() => expect(composer()).not.toBeNull());
    });
  });

  describe("room header menu (§7.1)", () => {
    it("Hide / Unhide room", async () => {
      const room = await newRoom();
      await mount(room);
      button(headerMenu(), "Hide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(room.id)).toBe(true));
      button(headerMenu(), "Unhide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(room.id)).toBe(false));
    });

    it("Archive room asks for confirmation and is only offered to the creator", async () => {
      const room = await newRoom();
      await mount(room);
      button(headerMenu(), "Archive room")!.click();
      expect(headerMenu().textContent).toContain("read-only for everyone");
      button(headerMenu(), "Archive")!.click();
      await vi.waitFor(() => expect(composer()).toBeNull());
      button(headerMenu(), "Unarchive room")!.click();
      await vi.waitFor(() => expect(composer()).not.toBeNull());

      view!.unmount();
      const other = await signedUp("Other");
      const theirs = await newRoom(other);
      await mount(theirs);
      expect(button(headerMenu(), "Archive room")).toBeNull();
      expect(button(headerMenu(), "Hide room")).not.toBeNull();
    });

    it("BUG-17: a hidden room that was archived can still be unhidden", async () => {
      const other = await signedUp("Other");
      const theirs = await newRoom(other);
      await me.api.hideRoom(theirs.id);
      await other.api.setArchived(theirs.id, true);
      await mount(theirs);
      await vi.waitFor(() => expect(store.get().hidden.has(theirs.id)).toBe(true));
      expect(button(headerMenu(), "Hide room")).toBeNull();
      button(headerMenu(), "Unhide room")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(theirs.id)).toBe(false));
    });

    it("§34.5: Notify of every message, a switch on this device; turning it on chooses the pop-up and asks the browser", async () => {
      const ask = vi.fn(async () => "granted" as const);
      vi.stubGlobal("Notification", { permission: "default", requestPermission: ask });
      try {
        localStorage.setItem("chat.notify", JSON.stringify({ dms: true, sound: false, rooms: ["other"] }));
        const room = await newRoom();
        await mount(room);
        button(headerMenu(), "Notify of every message")!.click();
        const saved = () => JSON.parse(localStorage.getItem("chat.notify") ?? "null");
        expect(saved()).toEqual({ dms: true, sound: false, popup: true, rooms: ["other", room.id] });
        expect(ask).toHaveBeenCalledOnce();
        // A switch in the menu: on now, and a second click turns it off.
        expect(button(headerMenu(), "Notify of every message")!.getAttribute("aria-checked")).toBe("true");
        button(headerMenu(), "Notify of every message")!.click();
        expect(button(headerMenu(), "Notify of every message")!.getAttribute("aria-checked")).toBe("false");
        // Off, mentions alert too (§41), not only replies (QA BUG-264).
        expect(headerMenu().textContent).toContain("Off — only mentions and replies to you");
        expect(saved().rooms).toEqual(["other"]);
        // Nothing left chosen: nothing stored.
        localStorage.setItem("chat.notify", JSON.stringify({ rooms: [room.id] }));
        view!.unmount();
        await mount(room);
        button(headerMenu(), "Notify of every message")!.click();
        expect(localStorage.getItem("chat.notify")).toBeNull();
      } finally {
        localStorage.removeItem("chat.notify");
        vi.unstubAllGlobals();
      }
    });
  });
});
