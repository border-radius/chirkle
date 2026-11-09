// Room view: keyboard use and accessibility.

import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../../web/src/dom.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { instrument } from "../../../support/api.ts";
import { button, composer, headerMenu, key, me, mount, msgEl, newRoom, root, useRoomView, view } from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("keyboard and accessibility (Phase 6)", () => {
    const active = () => document.activeElement as HTMLElement | null;

    it("the room is a region labelled by its name, with a link back to the room list", async () => {
      const room = await newRoom();
      await mount(room);
      const region = root.querySelector("section.room")!;
      const h1 = region.querySelector("h1")!;
      expect(region.getAttribute("aria-labelledby")).toBe(h1.id);
      const back = root.querySelector<HTMLAnchorElement>("header.room-header a.back")!;
      expect(back.getAttribute("href")).toBe("/");
      expect(back.getAttribute("aria-label")).toBe("Back to rooms");
    });

    it("message actions are real buttons in the tab order", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      await mount(room);
      for (const label of ["Edit", "Delete"]) {
        const b = button(msgEl(m.id), label)!;
        expect(b.tagName).toBe("BUTTON");
        expect(b.getAttribute("tabindex")).toBeNull();
        expect(b.hidden).toBe(false);
      }
    });

    it("the delete confirm focuses Cancel; Escape cancels and returns focus to Delete", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "keep me" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      expect(active()).toBe(button(msgEl(m.id), "Cancel"));
      key(active()!, "Escape");
      expect(msgEl(m.id)!.textContent).not.toContain("Delete this message?");
      expect(active()).toBe(button(msgEl(m.id), "Delete"));
      expect(ctl.calls("softDelete")).toBe(0);
    });

    it("Escape closes the header menu and returns focus to its toggle", async () => {
      const room = await newRoom();
      await mount(room);
      const menu = headerMenu();
      button(menu, "Jump to beginning")!.focus();
      key(active()!, "Escape");
      const details = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
      expect(details.open).toBe(false);
      expect(active()).toBe(details.querySelector("summary"));
    });

    it("the archive confirm in the header focuses Cancel; Escape cancels", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      button(headerMenu(), "Archive room")!.click();
      const details = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
      expect(active()).toBe(button(details, "Cancel"));
      key(active()!, "Escape");
      const after = root.querySelector<HTMLDetailsElement>("header.room-header details")!; // header re-rendered
      expect(after.open).toBe(false);
      expect(after.textContent).not.toContain("read-only for everyone");
      expect(active()).toBe(after.querySelector("summary"));
      expect(ctl.calls("setArchived")).toBe(0);
    });

    it("the edit box is labelled and Escape returns focus to the composer", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "edit me" });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(active()!.getAttribute("aria-label")).toBe("Edit message");
      key(active()!, "Escape");
      expect(active()).toBe(composer());
    });

    describe("focusing the window", () => {
      const refocus = () => window.dispatchEvent(new Event("focus"));
      const blur = () => (document.activeElement as HTMLElement | null)?.blur();
      afterEach(() => getSelection()?.removeAllRanges());

      it("focuses the composer when nothing (or a link) has focus", async () => {
        const room = await newRoom();
        await mount(room);
        blur();
        refocus();
        expect(active()).toBe(composer());
        const link = h("a", { href: "/" }, "a link");
        root.append(link);
        link.focus();
        refocus();
        expect(active()).toBe(composer());
      });

      it("leaves focus on an edit box, a confirm or a menu", async () => {
        const room = await newRoom();
        const m = await me.api.send({ id: newId(), room: room.id, text: "edit me" });
        await mount(room);
        button(msgEl(m.id), "Edit")!.click();
        const edit = active();
        refocus();
        expect(active()).toBe(edit);
        key(edit!, "Escape");
        button(msgEl(m.id), "Delete")!.click();
        refocus();
        expect(active()).toBe(button(msgEl(m.id), "Cancel"));
        key(active()!, "Escape");
        const toggle = headerMenu().querySelector("summary")!;
        toggle.focus();
        refocus();
        expect(active()).toBe(toggle);
      });

      it("keeps a text selection (you may be copying it)", async () => {
        const room = await newRoom();
        const m = await me.api.send({ id: newId(), room: room.id, text: "copy me" });
        await mount(room);
        blur();
        getSelection()!.selectAllChildren(msgEl(m.id)!.querySelector(".body")!);
        refocus();
        expect(active()).not.toBe(composer());
        expect(String(getSelection())).toContain("copy me");
      });

      it("does nothing in an archived room", async () => {
        const room = await newRoom();
        await me.api.setArchived(room.id, true);
        await mount(room);
        blur();
        refocus();
        expect(composer()).toBeNull();
        expect(active()).toBe(document.body);
      });

      it("stops when the room is left", async () => {
        await mount(await newRoom());
        const focus = vi.spyOn(composer()!, "focus");
        view!.unmount();
        refocus();
        expect(focus).not.toHaveBeenCalled();
      });
    });
    it("Ctrl+/ (or ⌘/, or the key's place on another layout) focuses the composer, which shows the keys", async () => {
      const room = await newRoom();
      await mount(room);
      const hint = root.querySelector(".composer kbd.focus-key")!;
      expect(hint.textContent).toBe("Ctrl /");
      expect(composer()!.getAttribute("aria-keyshortcuts")).toBe("Control+/");
      for (const opts of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, code: "Slash", k: "." }]) {
        const b = button(headerMenu(), "Jump to beginning")!;
        b.focus();
        const { k = "/", ...init } = opts;
        const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
        b.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
        expect(active()).toBe(composer());
      }
      // Plain "/" and Ctrl+Alt+/ are typing, not the shortcut.
      document.body.focus();
      for (const opts of [{}, { ctrlKey: true, altKey: true }]) {
        key(document.body, "/", opts);
        expect(active()).not.toBe(composer());
      }
    });
  });
});
