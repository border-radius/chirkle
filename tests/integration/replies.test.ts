// Replies (§19): reply_to is set on create only, to a message of the same room that isn't deleted, and comes back
// expanded (author name, text) through every way the client reads messages.

import { describe, expect, inject, it } from "vitest";
import { type Action, type Api, createApi } from "../../web/src/api.ts";
import { latest } from "../../web/src/lib/cursor.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Message } from "../../web/src/lib/types.ts";
import { createClient } from "../../web/src/pb.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { adminClient, eventually, expectRejected, newRoom, newUser, openDm, post } from "./helpers.ts";

describe("replies: rules and hooks (§19)", () => {
  it("a message can reply to another message of the same room", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const parent = await post(a, room.id, "question");
    const reply = await post(b, room.id, "answer", { reply_to: parent.id });
    expect(reply.reply_to).toBe(parent.id);
    expect((await post(a, room.id, "plain")).reply_to).toBe("");
  });

  it("refuses a reply to a message of another room, an unknown message, or a deleted one", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const other = await newRoom(a);
    const elsewhere = await post(a, other.id, "elsewhere");
    await expectRejected(post(a, room.id, "x", { reply_to: elsewhere.id }));
    await expectRejected(post(a, room.id, "x", { reply_to: "nosuchmessage00" }));
    const gone = await post(a, room.id, "gone");
    await a.pb.collection("messages").update(gone.id, { deleted: true });
    await expectRejected(post(a, room.id, "x", { reply_to: gone.id }));
  });

  it("can't reply into a DM you aren't in (its quote would leak the message)", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    const room = await newRoom(c);
    await expectRejected(post(c, room.id, "peek", { reply_to: secret.id }));
  });

  it("reply_to never changes after sending", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const p1 = await post(a, room.id, "one");
    const p2 = await post(a, room.id, "two");
    const reply = await post(a, room.id, "re", { reply_to: p1.id });
    await expectRejected(a.pb.collection("messages").update(reply.id, { reply_to: p2.id }));
    await expectRejected(a.pb.collection("messages").update(reply.id, { reply_to: "" }));
    const plain = await post(a, room.id, "plain");
    await expectRejected(a.pb.collection("messages").update(plain.id, { reply_to: p1.id }));
    expect((await a.pb.collection("messages").getOne(reply.id)).reply_to).toBe(p1.id);
    // editing and deleting the reply still work
    expect((await a.pb.collection("messages").update(reply.id, { text: "re!" })).text).toBe("re!");
    expect((await a.pb.collection("messages").update(reply.id, { deleted: true })).reply_to).toBe(p1.id);
  });

  it("deleting the original leaves the reply pointing at its placeholder", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const parent = await post(a, room.id, "soon gone");
    const reply = await post(a, room.id, "re", { reply_to: parent.id });
    await a.pb.collection("messages").update(parent.id, { deleted: true });
    const got = await a.pb.collection("messages").getOne(reply.id, { expand: "reply_to" });
    expect(got.reply_to).toBe(parent.id);
    expect(got.expand?.reply_to).toMatchObject({ id: parent.id, deleted: true, text: "" });
  });

  it("field modifiers can't set or change reply_to either", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const p1 = await post(a, room.id, "one");
    const p2 = await post(a, room.id, "two");
    const reply = await post(a, room.id, "re", { reply_to: p1.id });
    const plain = await post(a, room.id, "plain");
    await expectRejected(a.pb.collection("messages").update(reply.id, { "reply_to+": p2.id }));
    await expectRejected(a.pb.collection("messages").update(reply.id, { "reply_to-": p1.id }));
    await expectRejected(a.pb.collection("messages").update(plain.id, { "reply_to+": p1.id }));
    expect((await a.pb.collection("messages").getOne(reply.id)).reply_to).toBe(p1.id);
    expect((await a.pb.collection("messages").getOne(plain.id)).reply_to).toBe("");
  });

  it("a superuser can still delete a message that has replies, and a room holding replies", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const parent = await post(a, room.id, "parent");
    const reply = await post(a, room.id, "re", { reply_to: parent.id });
    const gone = await post(a, room.id, "re, deleted", { reply_to: parent.id });
    await a.pb.collection("messages").update(gone.id, { deleted: true });
    await post(a, room.id, "re re", { reply_to: reply.id });
    const admin = await adminClient();
    await admin.collection("messages").delete(parent.id);
    expect((await a.pb.collection("messages").getOne(reply.id)).reply_to).toBe("");
    await a.pb.collection("rooms").update(room.id, { archived: true });
    await admin.collection("rooms").delete(room.id);
    await expectRejected(a.pb.collection("messages").getOne(reply.id));
  });
});

describe("replies through the client API (§19)", () => {
  const realClient = (): Api => createApi(createClient(inject("pbUrl")));
  async function setup() {
    const a = realClient();
    const b = realClient();
    // Display names are unique (§22.1): free them if an earlier test took them.
    await withName(inject("pbUrl"), "Alice", () => a.signUp({ email: `a-${uniq()}@test.local`, password: "password-123", name: "Alice" }));
    await withName(inject("pbUrl"), "Bob", () => b.signUp({ email: `b-${uniq()}@test.local`, password: "password-123", name: "Bob" }));
    return { a, b, room: await a.createRoom(`room-${uniq()}`) };
  }

  it("send, page and getMessage carry the quoted message, without private fields; realtime only its id", async () => {
    const { a, b, room } = await setup();
    const parent = await a.send({ id: newId(), room: room.id, text: "question" });
    const events: [Action, Message][] = [];
    const off = await b.subscribeMessages(room.id, (action, rec) => events.push([action, rec]));
    try {
      const sent = await b.send({ id: newId(), room: room.id, text: "answer", replyTo: parent.id });
      const quoted = {
        id: parent.id,
        author: parent.author,
        text: "question",
        deleted: false,
        expand: { author: { id: parent.author, name: "Alice", avatar: "" } },
      };
      expect(sent.reply_to).toBe(parent.id);
      expect(sent.expand?.reply_to).toMatchObject(quoted);
      expect((await a.getMessage(sent.id)).expand?.reply_to).toMatchObject(quoted);
      const page = await a.page(latest(room.id));
      expect(page.find((m) => m.id === sent.id)?.expand?.reply_to).toMatchObject(quoted);
      expect(page.find((m) => m.id === parent.id)?.reply_to).toBe("");
      await eventually(() => expect(events).toHaveLength(1));
      // Live events leave the quote to the room (docs/PERF.md §2.3): it costs the server ~5 ms a client.
      expect(events[0]![1].reply_to).toBe(parent.id);
      expect(events[0]![1].expand?.reply_to).toBeUndefined();
      // only the fields the quote needs
      expect(Object.keys(sent.expand!.reply_to!).sort()).toEqual(["author", "deleted", "expand", "files", "id", "text"]);
      expect(Object.keys(sent.expand!.reply_to!.expand!.author!).sort()).toEqual(["avatar", "id", "name"]);
    } finally {
      await off();
    }
  });
});
