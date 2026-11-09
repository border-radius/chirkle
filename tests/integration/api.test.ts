// createApi() against a real PocketBase (§6): the behavior every view relies on.

import { describe, expect, inject, it } from "vitest";
import { type Action, type Api, ApiError, createApi } from "../../web/src/api.ts";
import { latest, older, PAGE_SIZE } from "../../web/src/lib/cursor.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Message, User } from "../../web/src/lib/types.ts";
import { createClient } from "../../web/src/pb.ts";
import { pngFile } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";

async function eventually(fn: () => void, ms = 2_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to reject");
}

/** A real client with its own in-memory auth store (no shared localStorage). */
const realClient = (): Api => createApi(createClient(inject("pbUrl")));

/** signUp, freeing `name` first if an earlier test took it (display names are unique, §22.1). */
const signUpAs = (api: Api, input: { email: string; password: string; name: string }) =>
  withName(inject("pbUrl"), input.name, () => api.signUp(input));

/** Two fresh logged-in clients and one logged-out client. */
async function setup(): Promise<{ a: Api; b: Api; anon: Api }> {
  const a = realClient();
  const b = realClient();
  await signUpAs(a, { email: `a-${uniq()}@test.local`, password: "password-123", name: "Alice" });
  await signUpAs(b, { email: `b-${uniq()}@test.local`, password: "password-123", name: "Bob" });
  return { a, b, anon: realClient() };
}

/** A user as a message's author shows them: without the handle (§41). */
const pub = (u: User | null) => {
  const { handle: _, ...rest } = u ?? ({} as User);
  return rest;
};

describe("createApi", () => {
  describe("auth", () => {
    it("signUp logs the user in; logOut clears; logIn restores", async () => {
      const { anon } = await setup();
      const email = `c-${uniq()}@test.local`;
      const user = await signUpAs(anon, { email, password: "password-123", name: "  Ada  " });
      expect(user).toEqual({ id: expect.any(String), name: "Ada", avatar: "", handle: expect.stringMatching(/^ada\d*$/) });
      expect(anon.currentUser()).toEqual(user);
      expect(await anon.refreshAuth()).toEqual(user);

      anon.logOut();
      expect(anon.currentUser()).toBeNull();
      await expect(anon.refreshAuth()).rejects.toBeInstanceOf(ApiError);

      expect(await anon.logIn(email, "password-123")).toEqual(user);
      expect(anon.currentUser()).toEqual(user);
    });

    it("a renewal answered after a logout, or another login, doesn't bring its session back", async () => {
      const { a } = await setup();
      const renewing = a.refreshAuth();
      a.logOut();
      await renewing;
      expect(a.currentUser()).toBeNull();

      await signUpAs(a, { email: `d-${uniq()}@test.local`, password: "password-123", name: "Dora" });
      const again = a.refreshAuth();
      const eve = await signUpAs(a, { email: `e-${uniq()}@test.local`, password: "password-123", name: "Eve" });
      await again;
      expect(a.currentUser()).toEqual(eve);
    });

    it("bad credentials reject with 400", async () => {
      const { anon } = await setup();
      const err = await rejection(anon.logIn(`nobody-${uniq()}@test.local`, "wrong-password"));
      expect(err.status).toBe(400);
      expect(anon.currentUser()).toBeNull();
    });

    it("signup validation errors are reported per field", async () => {
      const { anon } = await setup();
      const err = await rejection(anon.signUp({ email: "not-an-email", password: "password-123", name: "x" }));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("email");
    });
  });

  describe("profile (§15)", () => {
    it("setAvatar uploads, removeAvatar clears; currentUser follows; avatarUrl points at a thumbnail", async () => {
      const { a, b } = await setup();
      const me = a.currentUser()!;
      expect(a.avatarUrl(me, 48)).toBe("");

      const set = await a.setAvatar(pngFile());
      expect(set).toEqual({ id: me.id, name: me.name, handle: me.handle, avatar: expect.stringMatching(/\.png$/) });
      expect(a.currentUser()).toEqual(set);
      const url = a.avatarUrl(set, 96);
      expect(url).toContain("thumb=96x96");
      expect((await fetch(url)).status).toBe(200);

      // what others see in message pages
      const room = await b.createRoom(`r-${uniq()}`);
      await a.send({ id: newId(), room: room.id, text: "hi" });
      const [m] = await b.page(latest(room.id));
      expect(m!.expand?.author).toEqual({ id: me.id, name: me.name, avatar: set.avatar, no_dms: false, instance: "" });

      const removed = await a.removeAvatar();
      expect(removed.avatar).toBe("");
      expect(a.currentUser()?.avatar).toBe("");
    });

    it("an invalid avatar rejects with an avatar field error", async () => {
      const { a } = await setup();
      const err = await rejection(a.setAvatar(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })));
      expect(err.status).toBe(400);
      expect(err.fields.avatar).toBeTruthy();
    });

    it("rename trims and validates", async () => {
      const { a } = await setup();
      const name = `New Name ${uniq()}`;
      expect((await a.rename(`  ${name} `)).name).toBe(name);
      expect(a.currentUser()?.name).toBe(name);
      const err = await rejection(a.rename("   "));
      expect(err.fields.name).toBeTruthy();
    });
  });

  describe("direct messages (§16)", () => {
    it("openDm returns the DM with both members' public profiles; listRooms and getRoom include it for members only", async () => {
      const { a, b } = await setup();
      const c = realClient();
      await signUpAs(c, { email: `c-${uniq()}@test.local`, password: "password-123", name: "Carol" });
      const bob = b.currentUser()!;
      const dm = await a.openDm(bob.id);
      expect(dm).toMatchObject({ kind: "dm", name: "", archived: false });
      expect(dm.expand?.members?.map((u) => u.name).sort()).toEqual(["Alice", "Bob"]);
      expect(JSON.stringify(dm)).not.toContain("@test.local");

      const listed = (await a.listRooms()).find((r) => r.id === dm.id)!;
      expect(listed.kind).toBe("dm");
      expect(listed.expand?.members?.find((u) => u.id === bob.id)).toEqual({
        id: bob.id,
        name: "Bob",
        avatar: "",
        no_dms: false,
        instance: "",
      });
      expect(JSON.stringify(listed)).not.toContain("@test.local");
      expect((await b.getRoom(dm.id)).id).toBe(dm.id);
      expect((await c.listRooms()).some((r) => r.id === dm.id)).toBe(false);
      expect((await rejection(c.getRoom(dm.id))).status).toBe(404);
      expect((await rejection(a.openDm(a.currentUser()!.id))).status).toBe(400);
    });

    it("public rooms come back as kind public with no members", async () => {
      const { a } = await setup();
      const r = await a.createRoom(`p-${uniq()}`);
      expect(r).toMatchObject({ kind: "public", members: [] });
    });

    it("BUG-34: % in a search is a literal character, not a wildcard", async () => {
      const { a } = await setup();
      const tag = uniq();
      for (const name of [`p${tag} 100%`, `p${tag} other`]) {
        await realClient().signUp({ email: `${uniq()}@test.local`, password: "password-123", name });
      }
      expect((await a.searchUsers(`p${tag} 100%`)).map((u) => u.name)).toEqual([`p${tag} 100%`]);
      const pct = await a.searchUsers("%");
      expect(pct.length).toBeGreaterThan(0);
      expect(pct.every((u) => u.name.includes("%"))).toBe(true);
      expect((await a.searchUsers(`p${tag}%r`)).map((u) => u.name)).toEqual([]);
    });

    it("searchUsers matches names, excludes yourself, caps at 20, binds the query safely", async () => {
      const { a } = await setup();
      const tag = uniq();
      const others = await Promise.all(
        Array.from({ length: 22 }, async (_, i) => {
          const u = realClient();
          return u.signUp({
            email: `s${i}-${uniq()}@test.local`,
            password: "password-123",
            name: `zz${tag} ${String(i).padStart(2, "0")}`,
          });
        }),
      );
      await a.rename(`zz${tag} me`);
      const found = await a.searchUsers(`zz${tag}`);
      expect(found).toHaveLength(20);
      expect(found.map((u) => u.name)).toEqual(others.slice(0, 20).map((u) => u.name));
      expect(found.every((u) => u.id !== a.currentUser()!.id)).toBe(true);
      expect(JSON.stringify(found)).not.toContain("@test.local");
      expect(await a.searchUsers(`zz${tag}" || name != "`)).toEqual([]);
    });
  });

  describe("attachments (§17)", () => {
    it("send uploads files; pages list them; fileUrl's URLs work without a file token (§37.3)", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`f-${uniq()}`);
      const sent = await a.send({
        id: newId(),
        room: room.id,
        text: "",
        files: [pngFile("pic.png"), new File(["hi"], "a.txt", { type: "text/plain" })],
      });
      expect(sent.files).toHaveLength(2);
      const [m] = await b.page(latest(room.id));
      expect(m!.files).toEqual(sent.files);

      const thumb = b.fileUrl(m!, m!.files![0]!, "800x480f");
      expect(thumb).toBe(`${inject("pbUrl")}/api/files/messages/${m!.id}/${m!.files![0]}?thumb=800x480f`);
      expect((await fetch(thumb)).status).toBe(200);
      expect((await fetch(b.fileUrl(m!, m!.files![1]!))).status).toBe(200);
      b.logOut();
      expect((await fetch(b.fileUrl(m!, m!.files![1]!))).status).toBe(200);
    });
  });

  describe("rooms", () => {
    it("create, list, get", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(` general-${uniq()} `);
      expect(room).toEqual({
        id: expect.any(String),
        name: room.name.trim(),
        archived: false,
        created_by: a.currentUser()!.id,
        kind: "public",
        visibility: "public",
        members: [],
        posting: "everyone",
        writers: [],
        last_message_at: "",
        created: expect.any(String),
        shared: null,
        expand: {},
      });
      expect(await b.getRoom(room.id)).toEqual(room);
      expect((await b.listRooms()).find((r) => r.id === room.id)).toEqual(room);
    });

    it("room access (§23.2): created private, members set with their profiles, then opened to everyone", async () => {
      const { a, b, anon } = await setup();
      const room = await a.createRoom(`priv-${uniq()}`, "private");
      expect(room.visibility).toBe("private");
      expect(room.members).toEqual([a.currentUser()!.id]);
      const shared = await a.setAccess(room.id, "private", [b.currentUser()!.id]);
      expect(shared.members).toEqual([a.currentUser()!.id, b.currentUser()!.id]);
      expect(shared.expand?.members?.map((u) => u.name)).toEqual(["Alice", "Bob"]);
      expect(Object.keys(shared.expand!.members![0]!).sort()).toEqual(["avatar", "id", "instance", "name", "no_dms"]); // never the email
      expect((await b.getRoom(room.id)).id).toBe(room.id);
      const open = await a.setAccess(room.id, "open", [b.currentUser()!.id]);
      expect(open).toMatchObject({ visibility: "open", members: [] });
      expect((await anon.listRooms()).map((r) => r.id)).toContain(room.id);
      // Only the creator: Bob is refused.
      expect([400, 403, 404]).toContain((await rejection(b.setAccess(room.id, "private", []))).status);
    });

    it("who can post (§23.6): writers set with their profiles; left out, posting is kept", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`sel-${uniq()}`);
      const sel = await a.setAccess(room.id, "public", [], "selected", [b.currentUser()!.id]);
      expect(sel).toMatchObject({ posting: "selected", writers: [a.currentUser()!.id, b.currentUser()!.id] });
      expect(sel.expand?.writers?.map((u) => u.name)).toEqual(["Alice", "Bob"]);
      expect(Object.keys(sel.expand!.writers![0]!).sort()).toEqual(["avatar", "id", "instance", "name", "no_dms"]); // never the email
      expect(await a.setAccess(room.id, "open", [])).toMatchObject({ visibility: "open", posting: "selected" });
      expect(await a.setAccess(room.id, "open", [], "everyone", [b.currentUser()!.id])).toMatchObject({ posting: "everyone", writers: [] });
    });

    it("duplicate names (any case) are rejected with a name field error", async () => {
      const { a, b } = await setup();
      const name = `Dup-${uniq()}`;
      await a.createRoom(name);
      const err = await rejection(b.createRoom(name.toLowerCase()));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("name");
      expect(err.codes.name).toBe("validation_not_unique"); // what the room list matches on
    });

    it("only the creator can archive and unarchive", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`arch-${uniq()}`);
      await rejection(b.setArchived(room.id, true));
      expect((await a.setArchived(room.id, true)).archived).toBe(true);
      expect((await a.setArchived(room.id, false)).archived).toBe(false);
    });
  });

  describe("hidden rooms", () => {
    it("hide, list (own only), unhide", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`hide-${uniq()}`);
      const row = await a.hideRoom(room.id);
      expect(row).toEqual({ id: expect.any(String), room: room.id });
      expect(await a.listHidden()).toContainEqual(row);
      expect(await b.listHidden()).not.toContainEqual(row);
      await rejection(a.hideRoom(room.id));
      await a.unhideRoom(row.id);
      expect(await a.listHidden()).not.toContainEqual(row);
    });
  });

  describe("messages", () => {
    it("send honors the client id, trims, and returns the author name", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const id = newId();
      const m = await a.send({ id, room: room.id, text: "  hello  " });
      expect(m).toMatchObject({ id, room: room.id, text: "hello", author: a.currentUser()!.id, edited_at: "", deleted: false });
      expect(m.expand?.author).toEqual({ ...pub(a.currentUser()), no_dms: false, instance: "" });
      expect(m.created).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it("resending the same id is rejected (safe retries)", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const id = newId();
      await a.send({ id, room: room.id, text: "once" });
      expect((await rejection(a.send({ id, room: room.id, text: "twice" }))).status).toBe(400);
    });

    it("blank text is rejected with a text field error", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`m-${uniq()}`);
      const err = await rejection(a.send({ id: newId(), room: room.id, text: "   " }));
      expect(err.status).toBe(400);
      expect(Object.keys(err.fields)).toContain("text");
    });

    it("pages newest-first with cursors and author names, never emails", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`p-${uniq()}`);
      const sent: Message[] = [];
      for (let i = 0; i < PAGE_SIZE + 5; i++) sent.push(await a.send({ id: newId(), room: room.id, text: `n${i}` }));

      const p1 = await b.page(latest(room.id));
      expect(p1.map((m) => m.text)).toEqual(
        sent
          .slice(5)
          .reverse()
          .map((m) => m.text),
      );
      expect(p1[0]!.expand?.author?.name).toBe(a.currentUser()!.name);
      expect(JSON.stringify(p1)).not.toContain("@test.local");

      const p2 = await b.page(older(room.id, p1[p1.length - 1]!));
      expect(p2.map((m) => m.text)).toEqual(["n4", "n3", "n2", "n1", "n0"]);
    });

    it("edit stamps edited_at; others can't edit", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`e-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "v1" });
      await rejection(b.edit(m.id, "hijack"));
      const e = await a.edit(m.id, " v2 ");
      expect(e).toMatchObject({ id: m.id, text: "v2" });
      expect(e.edited_at).not.toBe("");
      expect(e.expand?.author).toEqual({ ...pub(a.currentUser()), no_dms: false, instance: "" });
    });

    it("softDelete wipes text and freezes the message", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`d-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "bye" });
      await rejection(b.softDelete(m.id));
      const d = await a.softDelete(m.id);
      expect(d).toMatchObject({ id: m.id, text: "", deleted: true });
      await rejection(a.edit(m.id, "back"));
    });

    it("archived rooms are read-only", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`ro-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "before" });
      await a.setArchived(room.id, true);
      await rejection(a.send({ id: newId(), room: room.id, text: "after" }));
      await rejection(a.edit(m.id, "changed"));
      await rejection(a.softDelete(m.id));
      expect((await a.page(latest(room.id))).map((x) => x.text)).toEqual(["before"]);
    });

    it("getMessage returns one message with its author name; unknown ids reject with 404", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`g-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "find me" });
      expect(await b.getMessage(m.id)).toEqual(m);
      expect((await rejection(b.getMessage("doesnotexist123"))).status).toBe(404);
    });

    it("anonymous clients can't read", async () => {
      const { a, anon } = await setup();
      const room = await a.createRoom(`anon-${uniq()}`);
      await a.send({ id: newId(), room: room.id, text: "secret" });
      expect(await anon.page(latest(room.id))).toEqual([]);
    });

    it("every read accepts a signal; aborted reads reject with status 0 (network-like, never 'logged out')", async () => {
      const { a } = await setup();
      const room = await a.createRoom(`ab-${uniq()}`);
      const m = await a.send({ id: newId(), room: room.id, text: "hi" });
      const ac = new AbortController();
      ac.abort();
      const reads = [
        a.page(latest(room.id), ac.signal),
        a.listRooms(ac.signal),
        a.listHidden(ac.signal),
        a.getRoom(room.id, ac.signal),
        a.getMessage(m.id, ac.signal),
      ];
      for (const read of reads) expect((await rejection(read)).status).toBe(0);
    });
  });

  describe("realtime", () => {
    it("message subscribers get create/update events for their room only, with author names", async () => {
      const { a, b } = await setup();
      const r1 = await a.createRoom(`rt1-${uniq()}`);
      const r2 = await a.createRoom(`rt2-${uniq()}`);
      const events: [Action, Message][] = [];
      const off = await b.subscribeMessages(r1.id, (action, rec) => events.push([action, rec]));
      try {
        const m = await a.send({ id: newId(), room: r1.id, text: "live" });
        await a.send({ id: newId(), room: r2.id, text: "elsewhere" });
        await a.edit(m.id, "edited");
        await a.softDelete(m.id);
        await eventually(() => expect(events).toHaveLength(3));
        expect(events.map(([act, rec]) => [act, rec.text, rec.deleted])).toEqual([
          ["create", "live", false],
          ["update", "edited", false],
          ["update", "", true],
        ]);
        expect(events[0]![1].expand?.author).toEqual({ ...pub(a.currentUser()), no_dms: false, instance: "" });
      } finally {
        await off();
      }
    });

    it("after unsubscribing, no more events arrive", async () => {
      const { a, b } = await setup();
      const room = await a.createRoom(`unsub-${uniq()}`);
      const events: unknown[] = [];
      const off = await b.subscribeMessages(room.id, (...e) => events.push(e));
      await off();
      await a.send({ id: newId(), room: room.id, text: "unheard" });
      await new Promise((r) => setTimeout(r, 300));
      expect(events).toHaveLength(0);
    });

    it("room and hidden-room subscriptions", async () => {
      const { a, b } = await setup();
      const rooms: [Action, string, boolean][] = [];
      const hiddenA: [Action, string][] = [];
      const hiddenB: unknown[] = [];
      const offRooms = await b.subscribeRooms((act, r) => rooms.push([act, r.name, r.archived]));
      const offHa = await a.subscribeHidden((act, h) => hiddenA.push([act, h.room]));
      const offHb = await b.subscribeHidden((...e) => hiddenB.push(e));
      try {
        const room = await a.createRoom(`sub-${uniq()}`);
        await a.setArchived(room.id, true);
        const row = await a.hideRoom(room.id);
        await a.unhideRoom(row.id);
        await eventually(() => {
          expect(rooms.filter(([, n]) => n === room.name)).toEqual([
            ["create", room.name, false],
            ["update", room.name, true],
          ]);
          expect(hiddenA).toEqual([
            ["create", room.id],
            ["delete", room.id],
          ]);
        });
        await new Promise((r) => setTimeout(r, 200));
        expect(hiddenB).toHaveLength(0);
      } finally {
        await offRooms();
        await offHa();
        await offHb();
      }
    });

    it("onConnect registered while already connected reports the next connection as a reconnect", async () => {
      // Record the client's EventSources, so the test can drop the connection the way the network would.
      const sources: EventSource[] = [];
      const Real = globalThis.EventSource;
      globalThis.EventSource = class extends Real {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          sources.push(this);
        }
      };
      const pb = createClient(inject("pbUrl"));
      const api = createApi(pb);
      await signUpAs(api, { email: `r-${uniq()}@test.local`, password: "password-123", name: "R" });
      const unsub = await api.subscribeRooms(() => {});
      await eventually(() => expect(pb.realtime.isConnected).toBe(true));
      const calls: boolean[] = [];
      const off = api.onConnect((re) => calls.push(re)); // registered after the connection is up
      try {
        // The connection errors (as after a network drop): the client goes down its real reconnect path.
        sources.at(-1)!.onerror!(new Event("error"));
        await eventually(() => expect(calls).toEqual([true]), 5_000);
        expect(sources).toHaveLength(2);
      } finally {
        globalThis.EventSource = Real;
        off();
        await unsub();
        await api.unsubscribeAll();
      }
    });

    it("onConnect fires with reconnect=false for the first connection", async () => {
      const { a } = await setup();
      const calls: boolean[] = [];
      const off = a.onConnect((re) => calls.push(re));
      const unsub = await a.subscribeRooms(() => {});
      try {
        await eventually(() => expect(calls).toEqual([false]));
      } finally {
        off();
        await unsub();
      }
    });
  });
});
