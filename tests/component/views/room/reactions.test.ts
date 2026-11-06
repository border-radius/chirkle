// Room view: reactions and the emoji picker (§20).

import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { instrument, signedUp } from "../../../support/api.ts";
import {
  bodyOf,
  button,
  composer,
  ids,
  key,
  me,
  mount,
  msgEl,
  msgEls,
  newRoom,
  root,
  send,
  sendButton,
  sleep,
  type,
  useRoomView,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("reactions and the emoji picker (§20)", () => {
    const picker = () => root.querySelector<HTMLElement>(".emoji-picker")!;
    const pickerOpen = () => !!picker() && !picker().hidden;
    /** Click what opens the picker, a lazy chunk: it opens once that is loaded. */
    const open = async (b: HTMLElement) => {
      b.click();
      await vi.waitFor(() => expect(pickerOpen()).toBe(true));
    };
    const pick = (emoji: string) => picker().querySelector<HTMLButtonElement>(`button.emoji[data-emoji="${emoji}"]`)!.click();
    const chips = (id: string) =>
      [...(msgEl(id)?.querySelectorAll<HTMLElement>(".reactions .reaction") ?? [])].map((c) => {
        const pressed = c.getAttribute("aria-pressed");
        return `${c.textContent}${pressed === "true" ? " (mine)" : ""}`;
      });
    const chip = (id: string, emoji: string) => msgEl(id)!.querySelector<HTMLElement>(`.reactions .reaction[data-emoji="${emoji}"]`)!;
    const serverReactions = async (id: string) => (await me.api.getMessage(id)).reactions;

    it("React opens the picker; picking adds my reaction at once, and it is saved", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "ship it" });
      await mount(room);
      const react = button(msgEl(m.id), "Add reaction")!;
      expect(react.getAttribute("aria-label")).toBe("Add reaction");
      expect(pickerOpen()).toBe(false);
      await open(react);
      expect(picker().getAttribute("aria-label")).toBe("Add reaction");
      pick("🚀");
      expect(pickerOpen()).toBe(false);
      expect(chips(m.id)).toEqual(["🚀1 (mine)"]);
      expect(chip(m.id, "🚀").getAttribute("aria-label")).toBe("🚀 1 reaction");
      expect(chip(m.id, "🚀").title).toBe("You reacted with 🚀");
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([{ emoji: "🚀", users: [me.user.id] }]));
    });

    it("any number of different reactions; a chip adds mine or takes it back", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await other.api.send({ id: newId(), room: room.id, text: "news" });
      await other.api.react(m.id, "🎉", true);
      await mount(room);
      expect(chips(m.id)).toEqual(["🎉1"]);
      expect(chip(m.id, "🎉").title).toBe("Other reacted with 🎉");
      chip(m.id, "🎉").click();
      expect(chips(m.id)).toEqual(["🎉2 (mine)"]);
      for (const e of ["👍", "❤️", "😂"]) {
        await open(button(msgEl(m.id), "Add reaction")!);
        pick(e);
      }
      expect(chips(m.id)).toEqual(["🎉2 (mine)", "👍1 (mine)", "❤️1 (mine)", "😂1 (mine)"]);
      await vi.waitFor(async () => expect((await serverReactions(m.id))?.length).toBe(4));
      chip(m.id, "🎉").click();
      chip(m.id, "👍").click();
      expect(chips(m.id)).toEqual(["🎉1", "❤️1 (mine)", "😂1 (mine)"]);
      expect(chip(m.id, "🎉").title).toBe("Other reacted with 🎉");
      await vi.waitFor(async () =>
        expect(await serverReactions(m.id)).toEqual([
          { emoji: "🎉", users: [other.user.id] },
          { emoji: "❤️", users: [me.user.id] },
          { emoji: "😂", users: [me.user.id] },
        ]),
      );
    });

    it("other people's reactions show live", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hello" });
      await mount(room);
      expect(msgEl(m.id)!.querySelector(".reactions")).toBeNull();
      await other.api.react(m.id, "👋", true);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1"]));
      // Other hasn't written here: their name is looked up.
      await vi.waitFor(() => expect(chip(m.id, "👋").title).toBe("Other reacted with 👋"));
      await other.api.react(m.id, "👋", false);
      await vi.waitFor(() => expect(msgEl(m.id)!.querySelector(".reactions")).toBeNull());
    });

    it("focus on a reaction or a message's button stays when someone else's reaction redraws the message", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hello" });
      await other.api.react(m.id, "👋", true);
      await mount(room);
      chip(m.id, "👋").focus();
      await other.api.react(m.id, "🎉", true);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1", "🎉1"]));
      expect(document.activeElement).toBe(chip(m.id, "👋"));
      button(msgEl(m.id), "Reply")!.focus();
      await other.api.react(m.id, "🎉", false);
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["👋1"]));
      expect(document.activeElement).toBe(button(msgEl(m.id), "Reply"));
    });

    it("picking an emoji I already reacted with takes it back", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await me.api.react(m.id, "👍", true);
      await mount(room);
      await open(button(msgEl(m.id), "Add reaction")!);
      expect(picker().querySelector(`button.emoji[data-emoji="👍"]`)!.getAttribute("aria-pressed")).toBe("true");
      pick("👍");
      expect(chips(m.id)).toEqual([]);
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([]));
    });

    it("a failed reaction goes back to how it was and offers Retry", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      const ctl = instrument(me.api);
      ctl.failNext("react", new ApiError("Failed to fetch", 0));
      await mount(room);
      await open(button(msgEl(m.id), "Add reaction")!);
      pick("🔥");
      expect(chips(m.id)).toEqual(["🔥1 (mine)"]);
      await vi.waitFor(() => expect(msgEl(m.id)!.textContent).toContain("Couldn't add your 🔥 reaction."));
      expect(chips(m.id)).toEqual([]);
      // The reaction it was on is gone: focus goes to React, not to the page.
      expect(document.activeElement).toBe(msgEl(m.id)!.querySelector(".actions .react"));
      button(msgEl(m.id), "Retry")!.click();
      await vi.waitFor(() => expect(chips(m.id)).toEqual(["🔥1 (mine)"]));
      expect(msgEl(m.id)!.textContent).not.toContain("Couldn't");
      await vi.waitFor(async () => expect(await serverReactions(m.id)).toEqual([{ emoji: "🔥", users: [me.user.id] }]));
      expect(chips(m.id)).toEqual(["🔥1 (mine)"]);
    });

    it("changed again before the server answered: what shows and what is saved is the last choice", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      const ctl = instrument(me.api);
      await mount(room);
      const release = ctl.hold("react");
      await open(button(msgEl(m.id), "Add reaction")!);
      pick("👍");
      await vi.waitFor(() => expect(ctl.calls("react")).toBe(1)); // on its way, unanswered
      chip(m.id, "👍").click(); // off
      expect(chips(m.id)).toEqual([]);
      await open(button(msgEl(m.id), "Add reaction")!);
      pick("👍"); // on again
      chip(m.id, "👍").click(); // and off
      expect(chips(m.id)).toEqual([]);
      release();
      await vi.waitFor(() => expect(ctl.calls("react")).toBe(2)); // the first, then only the last (others superseded)
      await sleep(100);
      expect(chips(m.id)).toEqual([]);
      expect(await serverReactions(m.id)).toEqual([]);
    });

    it("keeps focus on the reaction it changed; Escape in the picker goes back to React", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await mount(room);
      await open(button(msgEl(m.id), "Add reaction")!);
      key(document.activeElement!, "Escape");
      expect(pickerOpen()).toBe(false);
      expect(document.activeElement).toBe(button(msgEl(m.id), "Add reaction"));
      await open(button(msgEl(m.id), "Add reaction")!);
      pick("👀");
      expect(document.activeElement).toBe(chip(m.id, "👀"));
      chip(m.id, "👀").click();
      expect(document.activeElement).toBe(button(msgEl(m.id), "Add reaction"));
    });

    it("no React on a message still sending, deleted, or in an archived room, where reactions only show", async () => {
      const room = await newRoom();
      const m = await me.api.send({ id: newId(), room: room.id, text: "kept" });
      const gone = await me.api.send({ id: newId(), room: room.id, text: "gone" });
      await me.api.react(m.id, "👍", true);
      await me.api.react(gone.id, "👍", true);
      const ctl = instrument(me.api);
      await mount(room);
      expect(chips(gone.id)).toEqual(["👍1 (mine)"]);
      await me.api.softDelete(gone.id);
      await vi.waitFor(() => expect(msgEl(gone.id)!.querySelector(".reactions")).toBeNull());
      expect(button(msgEl(gone.id), "Add reaction")).toBeNull();

      const release = ctl.hold("send");
      send("on its way");
      expect(button(msgEls().at(-1)!, "Add reaction")).toBeNull();
      release();

      await me.api.setArchived(room.id, true);
      await vi.waitFor(() => expect(button(msgEl(m.id), "Add reaction")).toBeNull());
      expect(chip(m.id, "👍").tagName).toBe("SPAN");
      expect(chips(m.id)).toEqual(["👍1"]);
      expect(button(msgEl(m.id), "Add reaction")).toBeNull();
    });

    it("the picker closes when its message is deleted meanwhile; the composer's stays open (QA BUG-121)", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const theirs = await other.api.send({ id: newId(), room: room.id, text: "soon gone" });
      const also = await other.api.send({ id: newId(), room: room.id, text: "also gone" });
      await mount(room);
      await open(button(msgEl(theirs.id), "Add reaction")!);
      await other.api.softDelete(theirs.id);
      await vi.waitFor(() => expect(msgEl(theirs.id)!.textContent).toContain("Message deleted"));
      expect(pickerOpen()).toBe(false);
      await open(root.querySelector<HTMLButtonElement>("form.composer .emoji-button")!);
      await other.api.softDelete(also.id);
      await vi.waitFor(() => expect(msgEl(also.id)!.textContent).toContain("Message deleted"));
      expect(pickerOpen()).toBe(true);
    });

    it("the composer's emoji button inserts at the caret, replacing a selection", async () => {
      const room = await newRoom();
      await mount(room);
      type("hello world");
      composer()!.setSelectionRange(6, 11); // "world"
      const emoji = root.querySelector<HTMLButtonElement>("form.composer .emoji-button")!;
      expect(emoji.getAttribute("aria-label")).toBe("Emoji");
      await open(emoji);
      expect(picker().getAttribute("aria-label")).toBe("Insert emoji");
      pick("🌎");
      expect(composer()!.value).toBe("hello 🌎");
      expect(document.activeElement).toBe(composer());
      expect(composer()!.selectionStart).toBe("hello 🌎".length);
      expect(sendButton().disabled).toBe(false);
      await open(emoji);
      key(document.activeElement!, "Escape");
      expect(document.activeElement).toBe(composer());
      expect(composer()!.value).toBe("hello 🌎");
    });

    it("typing :name offers emoji by name (§20.6); Enter puts one in rather than sending", async () => {
      const room = await newRoom();
      await mount(room);
      const list = () => document.querySelector<HTMLElement>(".emoji-suggest");
      type("well :tad"); // the chunk loads on the first ":ta"
      await vi.waitFor(() => expect(list()?.hidden).toBe(false));
      expect(list()!.querySelector("[aria-selected=true]")!.textContent).toBe("🎉:tada:");
      expect(composer()!.getAttribute("aria-activedescendant")).toBe(list()!.querySelector("[aria-selected=true]")!.id);
      key(composer()!, "Enter");
      expect(composer()!.value).toBe("well 🎉 ");
      expect(list()!.hidden).toBe(true);
      expect(sendButton().disabled).toBe(false);
      key(composer()!, "Enter");
      expect(composer()!.value).toBe("");
      await vi.waitFor(() => expect(ids().map(bodyOf)).toContain("well 🎉"));
    });
  });
});
