// Room view: replies (§19).

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { HIGHLIGHT_MS } from "../../../../web/src/views/room/controller.ts";
import { instrument, seedMessages, signedUp } from "../../../support/api.ts";
import {
  bodyOf,
  button,
  composer,
  gateRealtime,
  headerMenu,
  ids,
  key,
  me,
  mount,
  msgEl,
  msgEls,
  newRoom,
  pill,
  root,
  send,
  sentinel,
  sleep,
  useRoomView,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("replies (§19)", () => {
    const replyBar = () => root.querySelector<HTMLElement>("form.composer .replying")!;
    const quoteOf = (id: string) => msgEl(id)?.querySelector<HTMLButtonElement>("button.reply-quote") ?? null;

    it("Reply shows who you're answering above the composer; the sent message quotes it", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "lunch\nanyone?" });
      await mount(room);
      expect(replyBar().hidden).toBe(true);
      button(msgEl(parent.id), "Reply")!.click();
      expect(replyBar().hidden).toBe(false);
      expect(replyBar().textContent).toContain("Replying to Other");
      expect(replyBar().textContent).toContain("lunch anyone?");
      expect(document.activeElement).toBe(composer());
      send("yes!");
      expect(replyBar().hidden).toBe(true);
      const mine = msgEls().at(-1)!;
      expect(mine.querySelector(".reply-quote .reply-author")!.textContent).toBe("Other");
      expect(mine.querySelector(".reply-quote .reply-text")!.textContent).toBe("lunch anyone?");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      const saved = await me.api.getMessage(msgEls().at(-1)!.dataset.id!);
      expect(saved.reply_to).toBe(parent.id);
    });

    it("someone else's reply to one of your messages is highlighted; other replies aren't", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "theirs" });
      const toMe = await other.api.send({ id: newId(), room: room.id, text: "re: mine", replyTo: mine.id });
      const toThem = await other.api.send({ id: newId(), room: room.id, text: "re: theirs", replyTo: theirs.id });
      const toSelf = await me.api.send({ id: newId(), room: room.id, text: "re: mine too", replyTo: mine.id });
      await mount(room);
      const highlighted = (id: string) => msgEl(id)!.classList.contains("to-me");
      expect(highlighted(toMe.id)).toBe(true);
      expect([mine, theirs, toThem, toSelf].map((m) => highlighted(m.id))).toEqual([false, false, false, false]);
    });

    it("× or Escape cancels the reply; the next message is a plain one", async () => {
      const room = await newRoom();
      const parent = await me.api.send({ id: newId(), room: room.id, text: "first" });
      await mount(room);
      button(msgEl(parent.id), "Reply")!.click();
      button(replyBar(), "Cancel reply")!.click();
      expect(replyBar().hidden).toBe(true);
      button(msgEl(parent.id), "Reply")!.click();
      key(composer()!, "Escape");
      expect(replyBar().hidden).toBe(true);
      send("plain");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      const id = msgEls().at(-1)!.dataset.id!;
      expect(quoteOf(id)).toBeNull();
      expect((await me.api.getMessage(id)).reply_to).toBe("");
    });

    it("clicking a quote highlights the original, loading the history around it when it isn't on screen", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const near = await me.api.send({ id: newId(), room: room.id, text: "re: last", replyTo: all[299]!.id });
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      await mount(room);
      quoteOf(near.id)!.click();
      expect(msgEl(all[299]!.id)!.classList.contains("target")).toBe(true);
      expect(ids()).not.toContain(all[10]!.id);
      quoteOf(far.id)!.click();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      expect(msgEl(all[299]!.id)).toBeNull();
      expect(sentinel("bottom")).not.toBeNull();
    });

    it("after following quotes, the pill goes back to each reply in turn, then offers Jump to latest (§19.5)", async () => {
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const r1 = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      const r2 = await me.api.send({ id: newId(), room: room.id, text: "re: re", replyTo: r1.id });
      await mount(room);
      const target = (id: string) => msgEl(id)?.classList.contains("target") === true;
      quoteOf(r2.id)!.click();
      expect(target(r1.id)).toBe(true);
      expect(pill().hidden).toBe(false);
      expect(pill().textContent).toBe("Back to reply");
      quoteOf(r1.id)!.click();
      await vi.waitFor(() => expect(target(all[10]!.id)).toBe(true));
      expect(pill().textContent).toBe("Back to reply");
      pill().click();
      await vi.waitFor(() => expect(target(r1.id)).toBe(true));
      expect(pill().textContent).toBe("Back to reply");
      pill().click();
      await vi.waitFor(() => expect(target(r2.id)).toBe(true));
      expect(pill().textContent).not.toBe("Back to reply");
    });

    it("Jump to beginning forgets the replies to go back to (§19.5)", async () => {
      const room = await newRoom();
      const parent = await me.api.send({ id: newId(), room: room.id, text: "parent" });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      quoteOf(reply.id)!.click();
      expect(pill().textContent).toBe("Back to reply");
      button(headerMenu(), "Jump to beginning")!.click();
      await vi.waitFor(() => expect(pill().textContent).not.toBe("Back to reply"));
    });

    it("a live reply to a message beyond the window doesn't quote it as deleted while its quote loads (QA BUG-180)", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 120);
      await mount(room);
      const net = instrument(me.api);
      const release = net.hold("getMessage");
      const reply = await other.api.send({ id: newId(), room: room.id, text: "way back", replyTo: all[0]!.id });
      await vi.waitFor(() => expect(quoteOf(reply.id)).not.toBeNull());
      expect(quoteOf(reply.id)!.textContent).toBe("…");
      expect(quoteOf(reply.id)!.classList.contains("deleted")).toBe(false);
      release();
      await vi.waitFor(() => expect(quoteOf(reply.id)!.textContent).toBe(`Me${all[0]!.text}`));
    });

    it("the highlight goes away after a few seconds; clicking the quote again shows it again", async () => {
      const room = await newRoom();
      const parent = await me.api.send({ id: newId(), room: room.id, text: "parent" });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      const target = () => msgEl(parent.id)!.classList.contains("target");
      quoteOf(reply.id)!.click();
      expect(target()).toBe(true);
      await sleep(HIGHLIGHT_MS - 500);
      expect(target()).toBe(true);
      await vi.waitFor(() => expect(target()).toBe(false), { timeout: 1500 });
      quoteOf(reply.id)!.click();
      expect(target()).toBe(true);
    });

    it("a quote follows edits and deletes of the original; a deleted original ends the reply being written", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "draft" });
      const reply = await other.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      expect(quoteOf(reply.id)!.textContent).toBe("Otherdraft");
      button(msgEl(parent.id), "Reply")!.click();
      await other.api.edit(parent.id, "final");
      await vi.waitFor(() => expect(quoteOf(reply.id)!.textContent).toBe("Otherfinal"));
      await vi.waitFor(() => expect(replyBar().textContent).toContain("final"));
      await other.api.softDelete(parent.id);
      await vi.waitFor(() => expect(quoteOf(reply.id)!.textContent).toBe("OtherMessage deleted"));
      expect(replyBar().hidden).toBe(true);
      expect(button(msgEl(parent.id), "Reply")).toBeNull();
    });

    it("no Reply in an archived room, on a deleted message, or on one still sending", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "y" });
      await me.api.softDelete(gone.id);
      const ctl = instrument(me.api);
      const release = ctl.hold("send");
      await mount(room);
      expect(button(msgEl(m.id), "Reply")).not.toBeNull();
      expect(button(msgEl(gone.id), "Reply")).toBeNull();
      send("pending");
      expect(button(msgEls().at(-1)!, "Reply")).toBeNull();
      release();
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(button(msgEl(m.id), "Reply")).toBeNull());
    });

    it("archiving the room ends the reply being written; it doesn't come back when the room is unarchived", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      button(msgEl(m.id), "Reply")!.click();
      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(composer()).toBeNull());
      await me.api.setArchived(room.id, false);
      await vi.waitFor(() => expect(composer()).not.toBeNull());
      expect(replyBar().hidden).toBe(true);
    });

    it("Escape while an input method is composing doesn't cancel the reply", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "x" });
      await mount(room);
      button(msgEl(m.id), "Reply")!.click();
      key(composer()!, "Escape", { isComposing: true });
      expect(replyBar().hidden).toBe(false);
    });

    it("Ctrl+Up and Ctrl+Down step the reply through the messages; past the newest it ends", async () => {
      const room = await newRoom();
      await me.api.send({ id: newId(), room: room.id, text: "one" });
      await me.api.send({ id: newId(), room: room.id, text: "two" });
      await mount(room);
      const ctrl = (k: string) => key(composer()!, k, { ctrlKey: true });
      ctrl("ArrowDown");
      expect(replyBar().hidden).toBe(true);
      ctrl("ArrowUp");
      expect(replyBar().textContent).toContain("two");
      ctrl("ArrowUp");
      expect(replyBar().textContent).toContain("one");
      ctrl("ArrowUp");
      expect(replyBar().textContent).toContain("one");
      ctrl("ArrowDown");
      expect(replyBar().textContent).toContain("two");
      ctrl("ArrowDown");
      expect(replyBar().hidden).toBe(true);
      send("plain");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("pending")).toBe(false));
      expect(quoteOf(msgEls().at(-1)!.dataset.id!)).toBeNull();
    });

    it("a message sent while a quote loads history isn't put after the old messages; it is there at the latest", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      const ctl = instrument(me.api);
      await mount(room);
      const releaseLoad = ctl.hold("getMessage");
      const releaseSend = ctl.hold("send");
      quoteOf(far.id)!.click();
      send("sent meanwhile");
      const id = msgEls().at(-1)!.dataset.id!;
      releaseLoad();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      releaseSend();
      await other.api.send({ id: newId(), room: room.id, text: "after" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      expect(ids()).not.toContain(id);
      pill().click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("pending")).toBe(false));
      expect(bodyOf(id)).toBe("sent meanwhile");
    });

    it("a failed message survives going back in history through a quote, and is there again at the latest", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const all = await seedMessages(room.id, me.user.id, 300);
      const far = await me.api.send({ id: newId(), room: room.id, text: "re: old", replyTo: all[10]!.id });
      const ctl = instrument(me.api);
      await mount(room);
      ctl.failNext("send", new ApiError("offline", 0));
      send("will fail");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const id = msgEls().at(-1)!.dataset.id!;
      quoteOf(far.id)!.click();
      await vi.waitFor(() => expect(msgEl(all[10]!.id)?.classList.contains("target")).toBe(true));
      expect(msgEl(id)).toBeNull();
      await other.api.send({ id: newId(), room: room.id, text: "after" });
      await vi.waitFor(() => expect(pill().hidden).toBe(false));
      pill().click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("failed")).toBe(true));
      expect(ids().indexOf(id)).toBe(ids().length - 2); // before the newer "after"
      button(msgEl(id), "Retry")!.click();
      await vi.waitFor(() => expect(msgEl(id)?.matches(".pending, .failed")).toBe(false));
      expect((await me.api.getMessage(id)).text).toBe("will fail");
    });

    it("a reply to a message deleted unseen says why it wasn't sent, and can be sent without the quote", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: "parent" });
      const gate = gateRealtime(me.api);
      await mount(room);
      button(msgEl(parent.id), "Reply")!.click();
      gate.offline = true; // the delete is never seen
      await other.api.softDelete(parent.id);
      await vi.waitFor(() => expect(gate.dropped).toBeGreaterThan(0));
      send("answer");
      await vi.waitFor(() => expect(msgEls().at(-1)!.classList.contains("failed")).toBe(true));
      const el = msgEls().at(-1)!;
      const id = el.dataset.id!;
      expect(el.querySelector(".send-error")!.textContent).toContain("the message you replied to was deleted");
      expect(quoteOf(id)!.textContent).toContain("Message deleted");
      button(el, "Send without quote")!.click();
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("failed")).toBe(false));
      await vi.waitFor(() => expect(msgEl(id)?.classList.contains("pending")).toBe(false));
      expect(quoteOf(id)).toBeNull();
      const saved = await me.api.getMessage(id);
      expect([saved.text, saved.reply_to]).toEqual(["answer", ""]);
    });

    it("a quote's accessible name is short and isn't taken for the Reply button", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const parent = await other.api.send({ id: newId(), room: room.id, text: `long ${"word ".repeat(300)}` });
      const reply = await me.api.send({ id: newId(), room: room.id, text: "re", replyTo: parent.id });
      await mount(room);
      const label = quoteOf(reply.id)!.getAttribute("aria-label")!;
      expect(label.startsWith("Quoting Other: long word")).toBe(true);
      expect(label.length).toBeLessThan(140);
      expect(label).toContain("…. Show the original message.");
    });
  });
});
