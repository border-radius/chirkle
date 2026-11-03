// Moderators in the room view (§36): the header offers access and archiving in anyone's room, anyone's message can be
// deleted, and an author's menu bans and unbans. The flag is set with SQL, as a superuser would in the admin UI.

import { describe, expect, inject, it, vi } from "vitest";
import { newId } from "../../../../web/src/lib/id.ts";
import { canManage } from "../../../../web/src/lib/rooms.ts";
import type { Room, User } from "../../../../web/src/lib/types.ts";
import { signedUp } from "../../../support/api.ts";
import { runSql } from "../../../support/sql.ts";
import { button, composer, headerMenu, me, mount, msgEl, newRoom, store, useRoomView } from "./harness.ts";

const makeModerator = async () => {
  await runSql(inject("pbUrl"), [{ sql: "UPDATE users SET moderator = 1 WHERE id = {:id}", params: { id: me.user.id } }]);
  store.set({ user: { ...me.user, moderator: true } });
};

describe("moderators in the room view (§36)", () => {
  useRoomView();

  it("canManage: the creator or a moderator, never a DM or another instance's room", () => {
    const ann: User = { id: "ann", name: "Ann" };
    const mod: User = { id: "mod", name: "Mod", moderator: true };
    const room: Room = { id: "r", name: "r", archived: false, created_by: "ann" };
    expect(canManage(room, ann)).toBe(true);
    expect(canManage(room, { id: "bob", name: "Bob" })).toBe(false);
    expect(canManage(room, mod)).toBe(true);
    expect(canManage(room, null)).toBe(false);
    expect(canManage({ ...room, kind: "dm" }, mod)).toBe(false);
    expect(canManage({ ...room, shared: { home: "a.example" } }, mod)).toBe(false);
  });

  it("archive and change access in someone else's room", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    await makeModerator();
    await mount(room);
    expect(button(headerMenu(), "Room access…")).not.toBeNull();
    button(headerMenu(), "Archive room")!.click();
    button(headerMenu(), "Archive")!.click();
    await vi.waitFor(() => expect(composer()).toBeNull());
    button(headerMenu(), "Unarchive room")!.click();
    await vi.waitFor(() => expect(composer()).not.toBeNull());
  });

  it("delete someone else's message, but not edit it", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    const m = await other.api.send({ id: newId(), room: room.id, text: "spam" });
    await makeModerator();
    await mount(room);
    expect(button(msgEl(m.id), "Edit")).toBeNull();
    button(msgEl(m.id), "Delete")!.click();
    button(msgEl(m.id), "Delete message")!.click();
    await vi.waitFor(async () => expect((await other.api.getMessage(m.id)).deleted).toBe(true));
  });

  it("ban and unban from an author's menu", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    await other.api.send({ id: newId(), room: room.id, text: "hi" });
    await makeModerator();
    await mount(room);
    const menu = () => root().querySelector<HTMLDetailsElement>("details.author-menu")!;
    menu().open = true;
    await vi.waitFor(() => expect(button(menu(), "Ban…")).not.toBeNull());
    button(menu(), "Ban…")!.click();
    expect(menu().textContent).toContain("can't sign in until unbanned");
    button(menu(), "Ban")!.click();
    await vi.waitFor(async () => expect(await me.api.isBanned(other.user.id)).toBe(true));
    menu().open = false;
    menu().open = true;
    await vi.waitFor(() => expect(button(menu(), "Unban")).not.toBeNull());
    button(menu(), "Unban")!.click();
    await vi.waitFor(async () => expect(await me.api.isBanned(other.user.id)).toBe(false));
  });

  it("QA: delete their own message where they can't post (by the delete route)", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    await makeModerator();
    const mine = await me.api.send({ id: newId(), room: room.id, text: "mine" });
    await other.api.setAccess(room.id, "public", [], "selected", []);
    await mount(room);
    await vi.waitFor(() => expect(composer()).toBeNull());
    button(msgEl(mine.id), "Delete")!.click();
    button(msgEl(mine.id), "Delete message")!.click();
    await vi.waitFor(async () => expect((await other.api.getMessage(mine.id)).deleted).toBe(true));
  });

  it("QA: the access dialog names someone else's room's creator, and says who keeps a private room", async () => {
    const other = await signedUp("Other Creator");
    const room = await newRoom(other);
    await makeModerator();
    await mount(room);
    button(headerMenu(), "Room access…")!.click();
    const dialog = await vi.waitFor(() => {
      const d = document.querySelector<HTMLDialogElement>("dialog.access");
      expect(d?.open).toBe(true);
      return d!;
    });
    const priv = dialog.querySelector<HTMLInputElement>('input[value="private"]')!;
    priv.click();
    priv.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(dialog.textContent).toContain("Other Creator"));
    expect(dialog.textContent).not.toContain("Unknown");
    expect(dialog.textContent).toContain(`${me.user.name} (you)`);
    expect(dialog.querySelector(".access-warning")!.textContent).toContain("Only its creator and the people added");
  });

  it("QA: in a copy of another instance's room, no Delete on that instance's people's messages, nor room access", async () => {
    const other = await signedUp("Local");
    const remote = await signedUp("Remote (B)");
    const room = await newRoom(other);
    const local = await other.api.send({ id: newId(), room: room.id, text: "from here" });
    const far = await remote.api.send({ id: newId(), room: room.id, text: "from B" });
    await runSql(inject("pbUrl"), [
      { sql: "UPDATE users SET instance = 'b.example' WHERE id = {:id}", params: { id: remote.user.id } },
      { sql: "UPDATE rooms SET shared = {:s} WHERE id = {:id}", params: { s: JSON.stringify({ home: "b.example" }), id: room.id } },
    ]);
    await makeModerator();
    await mount(room);
    expect(button(msgEl(local.id), "Delete")).not.toBeNull();
    expect(button(msgEl(far.id), "Delete")).toBeNull();
    expect(button(headerMenu(), "Archive room")).toBeNull();
  });

  it("others get no Ban, and no Delete on others' messages", async () => {
    const other = await signedUp("Other");
    const room = await newRoom(other);
    const m = await other.api.send({ id: newId(), room: room.id, text: "hi" });
    await mount(room);
    expect(button(msgEl(m.id), "Delete")).toBeNull();
    const menu = root().querySelector<HTMLDetailsElement>("details.author-menu")!;
    menu.open = true;
    await new Promise((r) => setTimeout(r, 50));
    expect(button(menu, "Message")).not.toBeNull();
    expect(button(menu, "Ban…")).toBeNull();
  });
});

const root = () => document.body;
