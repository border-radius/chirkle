// Room view: authors, avatars and messaging them (§15.4, §16.5).

import PocketBase from "pocketbase";
import { describe, expect, inject, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import { createRoomView } from "../../../../web/src/views/room.ts";
import { signedUp, viewContext } from "../../../support/api.ts";
import { pngFile } from "../../../support/files.ts";
import {
  beginning,
  button,
  captureHandler,
  composer,
  headerMenu,
  me,
  mount,
  msgEl,
  msgEls,
  navigate,
  newRoom,
  root,
  setView,
  store,
  useRoomView,
  view,
} from "./harness.ts";

describe("room view", () => {
  useRoomView();

  describe("direct messages (§16.5)", () => {
    const menuLabels = () => [...headerMenu().querySelectorAll(".menu-items button")].map((b) => b.textContent);

    it("a DM is titled after the other member, with their avatar; the composer and beginning say who", async () => {
      const bob = await signedUp("Bob Builder");
      const dm = await me.api.openDm(bob.user.id);
      await mount(dm);
      const h1 = root.querySelector("header.room-header h1")!;
      expect(h1.querySelector("span:not(.avatar)")!.textContent).toBe("Bob Builder");
      expect(h1.querySelector(".avatar")!.textContent).toBe("BB");
      expect(composer()!.placeholder).toBe("Message Bob Builder");
      expect(beginning()!.textContent).toBe("Beginning of your conversation with Bob Builder");
    });

    it("its menu offers Close conversation and Jump to beginning, never Archive; closing goes home", async () => {
      const bob = await signedUp("Bob");
      const dm = await me.api.openDm(bob.user.id);
      await mount(dm);
      expect(menuLabels()).toEqual(["Close conversation", "Jump to beginning"]);
      button(headerMenu(), "Close conversation")!.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
      expect(store.get().hidden.has(dm.id)).toBe(true);
    });

    it("a closed DM opened by URL can be reopened", async () => {
      const bob = await signedUp("Bob");
      const dm = await me.api.openDm(bob.user.id);
      await me.api.hideRoom(dm.id);
      await mount(dm);
      await vi.waitFor(() => expect(menuLabels()[0]).toBe("Reopen conversation"));
      button(headerMenu(), "Reopen conversation")!.click();
      await vi.waitFor(() => expect(store.get().hidden.has(dm.id)).toBe(false));
    });

    it("someone else's DM is not found", async () => {
      const bob = await signedUp("Bob");
      const cat = await signedUp("Cat");
      const theirs = await bob.api.openDm(cat.user.id);
      setView(createRoomView(viewContext(me.api, store, navigate)));
      view!.mount(root, { id: theirs.id });
      await vi.waitFor(() => expect(root.textContent).toContain("This room doesn't exist."));
    });

    it("another author's name opens the DM with them, with no menu; your own name does nothing", async () => {
      const bob = await signedUp("Bob");
      const room = await newRoom();
      await bob.api.send({ id: newId(), room: room.id, text: "hi from bob" });
      await me.api.send({ id: newId(), room: room.id, text: "hi from me" });
      await mount(room);
      const [theirs, mine] = msgEls();
      expect(mine!.querySelector("button.author, details.author-menu")).toBeNull();
      expect(theirs!.querySelector("details.author-menu")).toBeNull();
      const name = theirs!.querySelector<HTMLButtonElement>("button.author")!;
      expect(name.textContent).toBe("Bob");
      name.click();
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/r\//)));
      const dmId = navigate.mock.calls.at(-1)![0].slice(3);
      expect(store.get().rooms.get(dmId)?.members).toContain(bob.user.id);
    });
  });

  describe("users who take no DMs (§16.7)", () => {
    it("their name doesn't open a DM", async () => {
      const bot = await signedUp("Bridge Person");
      const pb = new PocketBase(inject("pbUrl"));
      await pb.collection("users").authWithPassword(bot.email, bot.password);
      await pb.collection("users").update(bot.user.id, { no_dms: true });
      const room = await newRoom();
      await bot.api.send({ id: newId(), room: room.id, text: "from telegram" });
      await mount(room);
      const [theirs] = msgEls();
      expect(theirs!.querySelector("details.author-menu, button.author")).toBeNull();
      expect(theirs!.querySelector(".author")!.textContent).toBe("Bridge Person");
    });
  });

  describe("avatars (§15.4)", () => {
    const avatarOf = (el: Element) => el.querySelector(".avatar");

    it("each author group starts with the author's avatar (or initials); continuations have none", async () => {
      const other = await signedUp("Other Person");
      const pic = await other.api.setAvatar(pngFile());
      const room = await newRoom();
      await other.api.send({ id: newId(), room: room.id, text: "one" });
      await other.api.send({ id: newId(), room: room.id, text: "two" });
      await me.api.send({ id: newId(), room: room.id, text: "three" });
      await mount(room);
      const [first, second, third] = msgEls();
      const img = avatarOf(first!) as HTMLImageElement;
      expect(img.tagName).toBe("IMG");
      expect(img.getAttribute("src")).toContain(pic.avatar);
      expect(avatarOf(second!)).toBeNull();
      expect(avatarOf(third!)!.textContent).toBe("M");
    });

    it("a message whose author's avatar changed is re-rendered", async () => {
      const room = await newRoom();
      const handlers = captureHandler(me.api);
      const m = await me.api.send({ id: newId(), room: room.id, text: "hi" });
      await mount(room);
      expect(avatarOf(msgEl(m.id)!)!.tagName).toBe("SPAN");
      handlers[0]!("update", {
        ...m,
        updated: "2999-01-01 00:00:00.000Z",
        expand: { author: { ...me.user, avatar: "new_abcdefghij.png" } },
      });
      await vi.waitFor(() => expect(avatarOf(msgEl(m.id)!)!.getAttribute("src")).toContain("new_abcdefghij.png"));
    });
  });
});
