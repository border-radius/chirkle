// Linked instances in the room view (§33.10): the header says where else a shared room is held (and when its home
// can't be reached), an author on another instance says which, and the access dialog lists people there with their
// instance and finds them by address. The test server doesn't run the module: what it would set is set with SQL, and
// the lookup on the peer is stubbed.

import { describe, expect, inject, it, vi } from "vitest";
import { ApiError } from "../../../../web/src/api.ts";
import { newId } from "../../../../web/src/lib/id.ts";
import { isAddress } from "../../../../web/src/lib/rooms.ts";
import { signedUp } from "../../../support/api.ts";
import { runSql } from "../../../support/sql.ts";
import { button, headerMenu, me, mount, msgEls, newRoom, root, useRoomView } from "./harness.ts";

const setShared = (roomId: string, shared: unknown) =>
  runSql(inject("pbUrl"), [{ sql: "UPDATE rooms SET shared = {:s} WHERE id = {:id}", params: { s: JSON.stringify(shared), id: roomId } }]);
const setInstance = (userId: string, host: string) =>
  runSql(inject("pbUrl"), [{ sql: "UPDATE users SET instance = {:h} WHERE id = {:id}", params: { h: host, id: userId } }]);

describe("linked instances in the room view (§33.10)", () => {
  useRoomView();

  it("tells an address on another instance from a name", () => {
    expect(isAddress("ann@b.example")).toBe(true);
    expect(isAddress("Ann Lee@chat.example.org")).toBe(true);
    expect(isAddress("ann@127.0.0.1:8090")).toBe(true);
    expect(isAddress("ann@b")).toBe(false);
    expect(isAddress("ann")).toBe(false);
    expect(isAddress("@b.example")).toBe(false);
  });

  it("the header says where else the room is held, and when its home is down", async () => {
    const room = await newRoom();
    await setShared(room.id, { with: ["b.example", "c.example"] });
    await mount(room);
    const note = () => root.querySelector<HTMLElement>(".room-header .room-shared")!;
    await vi.waitFor(() => expect(note().textContent).toBe("Shared with b.example, c.example"));
    expect(note().hidden).toBe(false);

    const plain = await newRoom();
    await setShared(plain.id, {});
    await setShared(room.id, { home: "a.example", with: ["a.example"], down: true });
    await me.api.setArchived(room.id, false); // a save, so the change reaches the view live
    await vi.waitFor(() => expect(note().textContent).toBe("Shared with a.example · a.example can't be reached right now"));
  });

  it("an author on another instance says which", async () => {
    const bob = await signedUp("Bob (B)");
    await setInstance(bob.user.id, "b.example");
    const room = await newRoom();
    await bob.api.send({ id: newId(), room: room.id, text: "hello from B" });
    await mount(room);
    const menu = msgEls()[0]!.querySelector<HTMLDetailsElement>("details.author-menu")!;
    menu.open = true;
    expect(menu.querySelector(".menu-items p")!.textContent).toBe("On b.example");
    expect(button(menu, "Message")).not.toBeNull();
  });

  it("the access dialog lists people there, says where the room is kept, and finds them by address", async () => {
    const room = await newRoom();
    await me.api.setAccess(room.id, "private", [me.user.id]);
    await setShared(room.id, { with: ["b.example"] });
    const ann = await signedUp("Ann (B)");
    await setInstance(ann.user.id, "b.example");
    const stub = vi
      .spyOn(me.api, "remoteUser")
      .mockResolvedValue({ id: ann.user.id, name: "Ann (B)", instance: "b.example", no_dms: true });
    await mount(room);
    const menu = headerMenu();
    menu.open = true;
    button(menu, "Room access…")!.click();
    const dialog = await vi.waitFor(() => {
      const d = root.querySelector<HTMLDialogElement>("dialog.access");
      expect(d?.open).toBe(true);
      return d!;
    });
    expect(dialog.querySelector(".access-shared")!.textContent).toBe(
      "Shared with b.example: its messages are kept there too. Add people there by their address, like ann@b.example.",
    );
    button(dialog, "Add people")!.click();
    const input = dialog.querySelector<HTMLInputElement>(".user-search input")!;
    input.value = "ann@b.example";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const found = await vi.waitFor(() => {
      const b = dialog.querySelector<HTMLButtonElement>(".search-results button.person");
      expect(b).not.toBeNull();
      return b!;
    });
    expect(stub).toHaveBeenCalledWith("ann@b.example", room.id);
    expect(found.title).toBe("On b.example");
    found.click();
    // Listed with their instance, though they take no DMs (Telegram's stand-ins aren't).
    const row = dialog.querySelector<HTMLElement>(`li.member[data-user-id="${ann.user.id}"]`)!;
    expect([...row.querySelectorAll(".member-role")].map((r) => r.textContent)).toEqual(["b.example"]);

    // A refusal says why.
    stub.mockRejectedValueOnce(new ApiError("Failed to find them.", 400, { address: "There's nobody called zed on b.example." }));
    input.value = "zed@b.example";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(dialog.querySelector(".search-status")!.textContent).toBe("There's nobody called zed on b.example."));
  });
});
