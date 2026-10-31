// Room view: the composer, optimistic send, editing, soft delete, drafts and focus (§7.6, §22).

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { createDrafts } from "../../../../web/src/drafts.ts";
import { latest } from "../../../../web/src/lib/cursor.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import type { Room } from "../../../../web/src/lib/types.ts";
import { createRoomView } from "../../../../web/src/views/room.ts";
import { instrument, intercept, seedMessages, signedUp, viewContext } from "../../../support/api.ts";
import { fakeLayout } from "../../../support/dom.ts";
import {
  atBottom,
  bodyOf,
  button,
  captureHandler,
  composer,
  deliveries,
  editBox,
  gateRealtime,
  ids,
  key,
  layout,
  list,
  loaded,
  me,
  mount,
  msgEl,
  msgEls,
  navigate,
  newRoom,
  pill,
  ROW,
  root,
  send,
  sendButton,
  setView,
  sleep,
  store,
  type,
  useRoomView,
  VIEWPORT,
  view,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("composer and optimistic send (5.2)", () => {
    it("Enter sends; the message shows immediately as pending, then confirmed, never duplicated", async () => {
      const room = await newRoom();
      const delivered = deliveries(me.api);
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("send");
      send("hello world");
      const pending = msgEls().at(-1)!;
      expect(pending.querySelector(".body")!.textContent).toBe("hello world");
      expect(pending.classList.contains("pending")).toBe(true);
      expect(composer()!.value).toBe("");
      release();
      const id = pending.dataset.id!;
      await vi.waitFor(() => expect(msgEl(id)!.classList.contains("pending")).toBe(false));
      await vi.waitFor(() => expect(delivered).toContain(id)); // the realtime echo of our own message
      expect(ids().filter((x) => x === id)).toHaveLength(1);
      expect(atBottom()).toBe(true);
    });

    it("messages go to the server one at a time, in the order they were sent: a slow one isn't overtaken (QA BUG-71)", async () => {
      const room = await newRoom();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const reached: string[] = [];
      // The first send is slow to reach the server (a large attachment, a bad network).
      intercept(me.api, "send", (original) => async (m) => {
        if (m.text === "first") await gate;
        reached.push(m.text);
        return original(m);
      });
      await mount(room);
      send("first");
      send("second");
      await sleep(100);
      expect(reached).toEqual([]); // "second" waits its turn
      release();
      await vi.waitFor(() => expect(root.querySelectorAll("li.msg.pending")).toHaveLength(0));
      expect(reached).toEqual(["first", "second"]);
      const server = await me.api.page(latest(room.id));
      expect(server.map((m) => m.text).reverse()).toEqual(["first", "second"]);
      expect(msgEls().map((el) => el.querySelector(".body")!.textContent)).toEqual(["first", "second"]);
    });

    it("a send that fails after you left the room shows there as not sent, with Retry (QA BUG-76)", async () => {
      const a = await newRoom();
      const b = await newRoom();
      const ctx = viewContext(me.api, store, navigate);
      const open = async (room: Room) => {
        view?.unmount();
        setView(createRoomView(ctx));
        view!.mount(root, { id: room.id });
        fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
        await loaded();
      };
      let fail!: () => void;
      const failed = new Promise<void>((r) => (fail = r));
      let first = true;
      intercept(me.api, "send", (original) => async (m) => {
        if (!first) return original(m);
        first = false;
        await failed;
        throw new ApiError("Failed to fetch", 0);
      });
      await open(a);
      send("words worth keeping");
      await open(b); // left while it was on its way
      fail();
      await sleep(50);
      await open(a);
      const el = msgEls().at(-1)!;
      expect(el.classList.contains("failed")).toBe(true);
      expect(el.querySelector(".body")!.textContent).toBe("words worth keeping");
      button(el, "Retry")!.click();
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(false));
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      expect((await me.api.page(latest(a.id))).map((m) => m.text)).toEqual(["words worth keeping"]);
    });

    it("a send shown as not sent is still there, with Retry, after leaving the room and coming back (QA BUG-119)", async () => {
      const a = await newRoom();
      const b = await newRoom();
      const ctx = viewContext(me.api, store, navigate);
      const open = async (room: Room) => {
        view?.unmount();
        setView(createRoomView(ctx));
        view!.mount(root, { id: room.id });
        fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
        await loaded();
      };
      instrument(me.api).failNext("send", new ApiError("Failed to fetch", 0));
      await open(a);
      send("words worth keeping");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      await open(b);
      expect(msgEls()).toHaveLength(0);
      await open(a);
      const el = msgEls().at(-1)!;
      expect(el.classList.contains("failed")).toBe(true);
      expect(el.querySelector(".body")!.textContent).toBe("words worth keeping");
      button(el, "Retry")!.click();
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      expect(msgEls().at(-1)!.classList.contains("failed")).toBe(false);
      expect((await me.api.page(latest(a.id))).map((m) => m.text)).toEqual(["words worth keeping"]);
      await open(b);
      await open(a);
      expect(msgEls().filter((li) => li.classList.contains("failed"))).toHaveLength(0); // kept once, not again
    });

    it("Enter that confirms an input method's word (Safari: keyCode 229) doesn't send (QA BUG-77)", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      type("にほんご");
      key(composer()!, "Enter", { keyCode: 229 });
      await sleep(50);
      expect(ctl.calls("send")).toBe(0);
      expect(composer()!.value).toBe("にほんご");
      key(composer()!, "Enter");
      await vi.waitFor(() => expect(ctl.calls("send")).toBe(1));
    });

    it("Shift+Enter inserts a newline instead of sending", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      type("line 1");
      const ev = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
      composer()!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(ctl.calls("send")).toBe(0);
    });

    it("blocks empty, whitespace-only and over-long messages", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      await mount(room);
      expect(sendButton().disabled).toBe(true);
      type("   \n ");
      expect(sendButton().disabled).toBe(true);
      key(composer()!, "Enter");
      type("x".repeat(2001));
      expect(sendButton().disabled).toBe(true);
      key(composer()!, "Enter");
      expect(ctl.calls("send")).toBe(0);
      type("ok");
      expect(sendButton().disabled).toBe(false);
    });

    it("shows a character counter only past 1800 characters", async () => {
      const room = await newRoom();
      await mount(room);
      const counter = () => root.querySelector("form.composer .counter")!;
      type("x".repeat(1800));
      expect(counter().textContent).toBe("");
      type("x".repeat(1900));
      expect(counter().textContent).toBe("100 left");
      type("x".repeat(2010));
      expect(counter().textContent).toBe("10 over");
    });

    it("a failed send is marked, keeps its text, and Retry resends with the same id", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("Failed to fetch", 0));
      await mount(room);
      send("try me");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const el = msgEls().at(-1)!;
      const id = el.dataset.id!;
      expect(el.querySelector(".body")!.textContent).toBe("try me");
      expect(el.textContent).toContain("Not sent.");
      button(el, "Retry")!.click();
      await vi.waitFor(() => {
        expect(msgEl(id)!.classList.contains("failed")).toBe(false);
        expect(msgEl(id)!.classList.contains("pending")).toBe(false);
      });
      const calls = vi.mocked(me.api.send).mock.calls.map(([m]) => m.id);
      expect(calls).toEqual([id, id]);
    });

    it("a retry after a send that actually reached the server is treated as sent", async () => {
      const room = await newRoom();
      // No realtime echo: otherwise the echo itself (correctly) marks the message sent before we can retry.
      gateRealtime(me.api).offline = true;
      let first = true;
      intercept(me.api, "send", (original) => async (m) => {
        const res = await original(m);
        if (first) {
          first = false;
          throw new ApiError("Failed to fetch", 0); // committed, but the response was lost
        }
        return res;
      });
      await mount(room);
      send("committed");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const id = msgEls().at(-1)!.dataset.id!;
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => {
        expect(msgEl(id)!.classList.contains("failed")).toBe(false);
        expect(msgEl(id)!.classList.contains("pending")).toBe(false);
      });
      expect(msgEl(id)!.textContent).not.toContain("Not sent.");
      expect(ids().filter((x) => x === id)).toHaveLength(1);
    });

    it("Discard removes a failed message without a request", async () => {
      const room = await newRoom();
      const ctl = instrument(me.api);
      ctl.failNext("send", new ApiError("Failed to fetch", 0));
      await mount(room);
      send("nope");
      await vi.waitFor(() => expect(msgEls().at(-1)?.classList.contains("failed")).toBe(true));
      button(msgEls().at(-1)!, "Discard")!.click();
      expect(msgEls()).toHaveLength(0);
      expect(ctl.calls("send")).toBe(1);
    });

    it("BUG-13/14: lengths count characters like the server, and the counter matches the Send button", async () => {
      const room = await newRoom();
      await mount(room);
      type("😀".repeat(1500)); // 3000 UTF-16 units, 1500 characters: the server accepts it
      expect(sendButton().disabled).toBe(false);
      type(`${"x".repeat(2000)}   `); // trailing spaces are trimmed before sending
      expect(sendButton().disabled).toBe(false);
      expect(root.querySelector(".counter")!.textContent).toBe("0 left");
      type("x".repeat(2001));
      expect(sendButton().disabled).toBe(true);
      expect(root.querySelector(".counter")!.textContent).toBe("1 over");
    });
  });

  describe("editing (5.6)", () => {
    it("Edit opens a prefilled box; Enter saves and marks the message (edited)", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "frist" });
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(editBox(m.id)!.value).toBe("frist");
      editBox(m.id)!.value = "first";
      key(editBox(m.id)!, "Enter");
      await vi.waitFor(() => expect(msgEl(m.id)!.querySelector(".edited")).not.toBeNull());
      expect(bodyOf(m.id)).toBe("first");
      expect(editBox(m.id)).toBeNull();
      expect(msgEl(m.id)!.querySelector(".edited")!.getAttribute("title")).toBeTruthy();
    });

    it("Esc cancels without a request; unchanged text saves nothing", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "same" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "changed";
      key(editBox(m.id)!, "Escape");
      expect(bodyOf(m.id)).toBe("same");
      button(msgEl(m.id), "Edit")!.click();
      key(editBox(m.id)!, "Enter");
      expect(editBox(m.id)).toBeNull();
      expect(ctl.calls("edit")).toBe(0);
    });

    it("a failed save restores the old text and offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "old" });
      const ctl = instrument(me.api);
      ctl.failNext("edit", new ApiError("Failed to fetch", 0));
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "new";
      key(editBox(m.id)!, "Enter");
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't save your edit."));
      expect(bodyOf(m.id)).toBe("old");
      button(msgEl(m.id), "Retry")!.click();
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("new"));
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't save");
    });

    it("edits of one message reach the server in order: a slow one can't overwrite a newer one (QA BUG-72)", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "original" });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      intercept(me.api, "edit", (original) => async (id, text) => {
        if (text === "edit one") await gate;
        return original(id, text);
      });
      await mount(room);
      for (const text of ["edit one", "edit two"]) {
        button(msgEl(m.id), "Edit")!.click();
        editBox(m.id)!.value = text;
        key(editBox(m.id)!, "Enter");
      }
      expect(bodyOf(m.id)).toBe("edit two");
      release();
      await vi.waitFor(async () => expect((await me.api.getMessage(m.id)).text).toBe("edit two"));
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("edit two"));
      expect(vi.mocked(me.api.edit).mock.calls.map(([, text]) => text)).toEqual(["edit one", "edit two"]);
    });

    it("Up arrow in an empty composer edits my last message, skipping deleted ones", async () => {
      const room = await newRoom();
      const keep = await me.api.send({ id: newId(), room: room.id, text: "editable" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.softDelete(gone.id);
      await mount(room);
      key(composer()!, "ArrowUp");
      expect(editBox(keep.id)).not.toBeNull();
      expect(document.activeElement).toBe(editBox(keep.id));
    });

    it("my forwards have Delete but no Edit, and Up arrow skips them (§21.3)", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const [copy] = await me.api.forward([theirs.id], room.id);
      await mount(room);
      expect(button(msgEl(copy!.id), "Edit")).toBeNull();
      expect(button(msgEl(copy!.id), "Delete")).not.toBeNull();
      key(composer()!, "ArrowUp");
      expect(editBox(mine.id)).not.toBeNull();
    });

    it("others' messages have no Edit or Delete", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      await mount(room);
      expect(button(msgEl(theirs.id), "Edit")).toBeNull();
      expect(button(msgEl(theirs.id), "Delete")).toBeNull();
    });

    it("an edit by someone else updates the message in place", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "v1" });
      await mount(room);
      await other.api.edit(m.id, "v2");
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("v2"));
      expect(msgEl(m.id)!.querySelector(".edited")).not.toBeNull();
    });

    it("BUG-09: an open edit box closes when the message is deleted elsewhere", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "editing" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      expect(editBox(m.id)).not.toBeNull();
      await me.api.softDelete(m.id); // e.g. from another tab
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("Message deleted"));
      expect(editBox(m.id)).toBeNull();
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't save");
      expect(ctl.calls("edit")).toBe(0);
    });

    it("BUG-16: saving an empty edit explains why nothing happens", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "keep" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Edit")!.click();
      editBox(m.id)!.value = "   ";
      key(editBox(m.id)!, "Enter");
      expect(msgEl(m.id)!.querySelector(".hint")!.textContent).toBe("A message can't be empty. Use Delete to remove it.");
      expect(editBox(m.id)).not.toBeNull();
      expect(ctl.calls("edit")).toBe(0);
    });

    it("BUG-43: an open edit box keeps what you typed, its focus and caret when its message is redrawn", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const quoted = await other.api.send({ id: newId(), room: room.id, text: "v1" });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "my reply", replyTo: quoted.id });
      await mount(room);
      button(msgEl(reply.id), "Edit")!.click();
      const box = editBox(reply.id)!;
      box.value = "my reply, edited";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.setSelectionRange(3, 3);
      await other.api.edit(quoted.id, "v2"); // the reply's quote changes: its element is rebuilt
      await vi.waitFor(() => expect(msgEl(reply.id)!.querySelector(".reply-text")!.textContent).toBe("v2"));
      expect(editBox(reply.id)).not.toBe(box);
      expect(editBox(reply.id)!.value).toBe("my reply, edited");
      expect(document.activeElement).toBe(editBox(reply.id));
      expect(editBox(reply.id)!.selectionStart).toBe(3);
      // Escape forgets the typing: the next edit starts from the message again.
      key(editBox(reply.id)!, "Escape");
      button(msgEl(reply.id), "Edit")!.click();
      expect(editBox(reply.id)!.value).toBe("my reply");
    });
  });

  describe("soft delete (5.7)", () => {
    it("Delete asks first; Cancel does nothing; Confirm leaves a placeholder with author and time", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "regret" });
      const ctl = instrument(me.api);
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      expect(msgEl(m.id)!.textContent).toContain("Delete this message?");
      button(msgEl(m.id), "Cancel")!.click();
      expect(ctl.calls("softDelete")).toBe(0);
      expect(bodyOf(m.id)).toBe("regret");

      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      expect(bodyOf(m.id)).toBe("Message deleted");
      await vi.waitFor(() => expect(ctl.calls("softDelete")).toBe(1));
      const el = msgEl(m.id)!;
      expect(el.classList.contains("deleted")).toBe(true);
      expect(el.querySelector(".author")!.textContent).toBe("Me");
      expect(el.querySelector("time")).not.toBeNull();
      expect(button(el, "Edit")).toBeNull();
      expect(button(el, "Delete")).toBeNull();
      expect(el.querySelector(".edited")).toBeNull();
    });

    it("a failed delete restores the message and says so", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "stay" });
      instrument(me.api).failNext("softDelete", new ApiError("Failed to fetch", 0));
      await mount(room);
      button(msgEl(m.id), "Delete")!.click();
      button(msgEl(m.id), "Delete message")!.click();
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't delete this message."));
      expect(bodyOf(m.id)).toBe("stay");
      expect(msgEl(m.id)!.classList.contains("deleted")).toBe(false);
    });

    it("a delete by someone else turns into a placeholder live", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "oops" });
      await mount(room);
      await other.api.softDelete(m.id);
      await vi.waitFor(() => expect(bodyOf(m.id)).toBe("Message deleted"));
    });

    it("a hard delete (superuser) removes the message", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "purged" });
      const handlers = captureHandler(me.api);
      await mount(room);
      handlers[0]!("delete", m);
      expect(msgEl(m.id)).toBeNull();
    });
  });

  describe("§22: drafts across reloads, focus, Jump to latest", () => {
    it("what you typed survives a reload (a new app with the same storage), and is gone once sent (§22.3)", async () => {
      const room = await newRoom();
      await mount(room);
      type("unsent thought");
      view!.unmount();
      // A reload: nothing in memory survives, only localStorage.
      setView(createRoomView({ ...viewContext(me.api, store, navigate), drafts: createDrafts(() => me.user.id) }));
      view!.mount(root, { id: room.id });
      fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
      await loaded();
      expect(composer()!.value).toBe("unsent thought");
      send("unsent thought");
      expect(createDrafts(() => me.user.id).get(room.id)).toBe("");
    });

    it("drafts are per user, and the session's end clears them", () => {
      const drafts = createDrafts(() => me.user.id);
      drafts.set("room1", "mine");
      expect(createDrafts(() => "someone-else").get("room1")).toBe("");
      expect(createDrafts(() => "").get("room1")).toBe(""); // logged out: nothing
      drafts.set("room2", "   ");
      expect(drafts.get("room2")).toBe(""); // blank is no draft
      drafts.clear(me.user.id);
      expect(drafts.get("room1")).toBe("");
    });

    it("entering a room puts the caret in the composer (§22.5)", async () => {
      const room = await newRoom();
      (document.activeElement as HTMLElement | null)?.blur();
      await mount(room);
      expect(document.activeElement).toBe(composer());
    });

    it("not on a touch screen, where it would pop up the keyboard", async () => {
      const room = await newRoom();
      vi.spyOn(window, "matchMedia").mockImplementation((q) => ({ matches: q === "(hover:none)" }) as MediaQueryList);
      (document.activeElement as HTMLElement | null)?.blur();
      await mount(room);
      expect(document.activeElement).not.toBe(composer());
    });

    it("scrolled up with nothing new, 'Jump to latest' takes you back to the bottom (§22.7)", async () => {
      const room = await newRoom();
      await seedMessages(room.id, me.user.id, 30);
      await mount(room);
      expect(pill().hidden).toBe(true);
      layout.scrollTo(0);
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("Jump to latest");
      expect(pill().classList.contains("jump")).toBe(true);
      pill().click();
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
      layout.scrollTo(0);
      layout.scrollToBottom(); // scrolling down yourself hides it too
      expect(pill().hidden).toBe(true);
    });

    it("back in history (e.g. after following a quote), it loads the latest page", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 200);
      await mount(room, { msgId: all[20]!.id });
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("Jump to latest");
      pill().click();
      await vi.waitFor(() => expect(ids().at(-1)).toBe(all.at(-1)!.id));
      expect(atBottom()).toBe(true);
      expect(pill().hidden).toBe(true);
    });

    it("BUG-50: what you were typing is still there when you come back from another room", async () => {
      const a = await newRoom();
      const b = await newRoom();
      const ctx = viewContext(me.api, store, navigate);
      const open = async (room: Room) => {
        view?.unmount();
        setView(createRoomView(ctx));
        view!.mount(root, { id: room.id });
        fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
        await loaded();
      };
      await open(a);
      type("half a thought");
      await open(b);
      expect(composer()!.value).toBe("");
      await open(a);
      expect(composer()!.value).toBe("half a thought");
      expect(sendButton().disabled).toBe(false);
      send("half a thought, finished");
      await open(b);
      await open(a);
      expect(composer()!.value).toBe(""); // sent: nothing left to keep
    });
  });
});
