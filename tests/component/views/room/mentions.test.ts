// Room view: mentions (§41): "@handle" marked in messages, a mention of you highlighted, people offered as "@" is typed.

import { describe, expect, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import { signedUp } from "../../../support/api.ts";
import { composer, key, me, mount, msgEl, msgEls, newRoom, store, useRoomView } from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("mentions (§41)", () => {
    it("marks @handles, yours more, and highlights a message that mentions you", async () => {
      const other = await signedUp("Other");
      const room = await newRoom();
      const mine = me.user.handle!;
      const theirs = other.user.handle!;
      const toMe = await other.api.send({ id: newId(), room: room.id, text: `hey @${mine.toUpperCase()}, see x@${mine}` });
      const toThem = await me.api.send({ id: newId(), room: room.id, text: `and @${theirs}` });
      const plain = await other.api.send({ id: newId(), room: room.id, text: "nobody" });
      expect(toMe.mentions).toEqual([me.user.id]);
      await mount(room);
      const marks = (id: string) => [...msgEl(id)!.querySelectorAll(".body .mention")].map((m) => [m.textContent, m.className]);
      expect(marks(toMe.id)).toEqual([[`@${mine.toUpperCase()}`, "mention me"]]);
      expect(marks(toThem.id)).toEqual([[`@${theirs}`, "mention"]]);
      expect(msgEl(toMe.id)!.classList.contains("to-me")).toBe(true);
      // Your own message mentioning someone else, and a plain one: not highlighted.
      expect([toThem, plain].map((m) => msgEl(m.id)!.classList.contains("to-me"))).toEqual([false, false]);
    });

    it("a handle you took since someone gave it up is theirs in older messages, not yours (QA BUG-265)", async () => {
      const [other, third] = [await signedUp("Other"), await signedUp(`Third ${newId().slice(0, 5)}`)];
      const room = await newRoom();
      const old = third.user.handle!;
      const toThird = await other.api.send({ id: newId(), room: room.id, text: `hey @${old}` });
      expect(toThird.mentions).toEqual([third.user.id]);
      await third.api.setHandle(`${old.slice(0, 20)}_x`);
      store.set({ user: await me.api.setHandle(old) });
      await mount(room);
      const mark = msgEl(toThird.id)!.querySelector(".body .mention")!;
      expect([mark.textContent, mark.className]).toEqual([`@${old}`, "mention"]);
      expect(msgEl(toThird.id)!.classList.contains("to-me")).toBe(false);
    });

    it("offers the room's people as @ is typed; Enter puts in their handle", async () => {
      const other = await signedUp(`Mentionee ${newId().slice(0, 5)}`);
      const room = await newRoom();
      await other.api.send({ id: newId(), room: room.id, text: "I was here" });
      await mount(room);
      const t = composer()!;
      t.focus();
      t.value = "hi @";
      t.setSelectionRange(4, 4);
      t.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      const list = () => document.querySelector<HTMLElement>('ul.emoji-suggest[aria-label="People"]');
      await vi.waitFor(() => expect(list()?.hidden).toBe(false), { timeout: 3000 });
      expect(list()!.textContent).toContain(`@${other.user.handle}`);
      expect(t.getAttribute("aria-activedescendant")).toBe(`${t.id}-people-0`);
      key(t, "Enter");
      expect(t.value).toBe(`hi @${other.user.handle} `);
      expect(list()!.hidden).toBe(true);
      // Enter picked; it didn't send.
      expect(msgEls().filter((m) => m.textContent?.includes("hi @"))).toEqual([]);
    });
  });
});
