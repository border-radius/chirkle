// Handles, mentions and the "Mentions & replies" inbox (§41).

import { describe, expect, it } from "vitest";
import {
  adminClient,
  client,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  post,
  rawDb,
  status,
  type TestUser,
  uniq,
} from "./helpers.ts";

interface InboxItem {
  id: string;
  cursor: string;
  kind: "mention" | "reply" | "reaction";
  emoji: string;
  emojis: string[];
  created: string;
  read: boolean;
  room: string;
  message: { id: string; text: string; files: number; created: string };
  quote: { id: string; text: string; files: number } | null;
  actor: { id: string; name: string; avatar: string; instance: string };
}
interface Inbox {
  items: InboxItem[];
  more: boolean;
  seen_at: string;
}
interface Counts {
  rooms: Record<string, number>;
  inbox: number;
  mentions: Record<string, number>;
}

const inbox = (u: TestUser, query: Record<string, string> = {}) => u.pb.send<Inbox>("/api/chat/inbox", { query });
const counts = (u: TestUser) => u.pb.send<Counts>("/api/chat/unread", {});
const handleOf = async (u: TestUser) => (await u.pb.collection("users").getOne(u.user.id)).handle as string;
const react = (u: TestUser, message: string, emoji: string, on = true) =>
  u.pb.send("/api/chat/reactions", { method: "POST", body: { message, emoji, on } });
const mentionable = (u: TestUser, room: string, q = "") =>
  u.pb.send<{ id: string; handle: string; name: string }[]>("/api/chat/mentionable", { query: { room, q } });

describe("handles (§41)", () => {
  it("every new account gets one from its name, unique, and can change it", async () => {
    const tag = uniq().slice(-6);
    const named = async (name: string): Promise<TestUser> => {
      const pb = client();
      const email = `u${uniq()}@test.local`;
      await pb.collection("users").create({ email, password: "password-123", passwordConfirm: "password-123", name });
      const { record } = await pb.collection("users").authWithPassword(email, "password-123");
      return { pb, user: record, email, password: "password-123" };
    };
    const a = await named(`Zoë Ünal ${tag}`);
    expect(await handleOf(a)).toBe(`zoe_unal_${tag}`.slice(0, 20));
    const b = await named(`Иван Пётр ${tag}`);
    expect(await handleOf(b)).toBe(`ivan_petr_${tag}`.slice(0, 20));
    // The same name again (once renamed away): the next free handle.
    await b.pb.collection("users").update(b.user.id, { name: `other ${uniq()}` });
    const b2 = await named(`Иван Пётр ${tag}`);
    expect(await handleOf(b2)).toBe(`${`ivan_petr_${tag}`.slice(0, 20)}2`);

    const mine = `h${tag}x`;
    const saved = await a.pb.collection("users").update(a.user.id, { handle: `@${mine.toUpperCase()}` });
    expect(saved.handle).toBe(mine);
    // Taken, malformed, blank or reserved: refused, with the reason on the field.
    for (const handle of [mine, "ab", "with space", "dots.no", "x".repeat(25), "", "everyone"]) {
      const err = await b.pb
        .collection("users")
        .update(b.user.id, { handle })
        .then(
          () => null,
          (e) => e,
        );
      expect(err?.status, handle).toBe(400);
      expect(err.response.data.handle, handle).toBeTruthy();
    }
    // A rename keeps the handle.
    const renamed = await a.pb.collection("users").update(a.user.id, { name: `Zoe ${uniq()}` });
    expect(renamed.handle).toBe(mine);
  });

  it("people search finds by handle", async () => {
    const a = await newUser();
    const b = await newUser();
    const h = `find${uniq().slice(-8)}`;
    await b.pb.collection("users").update(b.user.id, { handle: h });
    const found = await a.pb.send<{ id: string; handle: string }[]>("/api/chat/users", { query: { q: `@${h}` } });
    expect(found.map((u) => u.id)).toContain(b.user.id);
    expect(found.find((u) => u.id === b.user.id)?.handle).toBe(h);
  });
});

describe("mentions (§41)", () => {
  it("are resolved from the text: people who can see the room, not the author, each once", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const hb = await handleOf(b);
    const hc = await handleOf(c);
    const ha = await handleOf(a);
    const msg = await post(a, room.id, `hi @${hb}, @${hb.toUpperCase()} and @${hc}! not me @${ha}, nor mail x@${hb} or @${hb}@far.example`);
    expect([...msg.mentions].sort()).toEqual([b.user.id, c.user.id].sort());

    // In a private room, only its members.
    const priv = await a.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: a.user.id, visibility: "private" });
    await a.pb.collection("rooms").update(priv.id, { members: [a.user.id, b.user.id] });
    const inPriv = await post(a, priv.id, `@${hb} @${hc}`);
    expect(inPriv.mentions).toEqual([b.user.id]);
  });

  it("follow edits, and clients can't set them", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, `hello @${await handleOf(b)}`, { mentions: [c.user.id] });
    expect(msg.mentions).toEqual([b.user.id]);
    const edited = await a.pb.collection("messages").update(msg.id, { text: `hello @${await handleOf(c)}` });
    expect(edited.mentions).toEqual([c.user.id]);
    await expectRejected(a.pb.collection("messages").update(msg.id, { mentions: [b.user.id] }));
    await expectRejected(a.pb.collection("messages").update(msg.id, { "mentions+": b.user.id }));
  });

  it("GET /api/chat/mentionable suggests people who can see the room, recent writers first", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const room = await newRoom(a);
    await post(c, room.id, "first");
    await post(b, room.id, "second");
    const recent = await mentionable(a, room.id);
    expect(recent.map((u) => u.id)).toEqual([b.user.id, c.user.id]);
    const hc = await handleOf(c);
    expect((await mentionable(a, room.id, hc.slice(0, 6))).map((u) => u.id)).toContain(c.user.id);
    expect((await mentionable(a, room.id, `@${hc}`))[0]?.id).toBe(c.user.id);
    // Never the caller; a private room's members only; a room you can't see: 404.
    expect((await mentionable(a, room.id, await handleOf(a))).map((u) => u.id)).not.toContain(a.user.id);
    const dm = await openDm(a, b);
    expect((await mentionable(a, dm.id)).map((u) => u.id)).toEqual([b.user.id]);
    expect(await status(mentionable(c, dm.id))).toBe(404);
  });
});

describe("inbox (§41)", () => {
  it("lists mentions, replies and reactions to you, newest first; deletes and take-backs remove them", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const mine = await post(a, room.id, "my words");
    const mention = await post(b, room.id, `hey @${await handleOf(a)}`);
    const reply = await post(b, room.id, `answer @${await handleOf(a)}`, { reply_to: mine.id });
    await react(b, mine.id, "👍");
    await react(b, mine.id, "🎉"); // the same person's second: the same row
    await react(a, mine.id, "🎉"); // your own: nothing
    await post(a, room.id, `talking to myself @${await handleOf(a)}`);

    let got = await inbox(a);
    expect(got.items.map((i) => [i.kind, i.message.id, i.emoji])).toEqual([
      ["reaction", mine.id, "👍🎉"],
      ["reply", reply.id, ""],
      ["mention", mention.id, ""],
    ]);
    const r = got.items[1]!;
    expect(r.quote).toMatchObject({ id: mine.id, text: "my words" });
    expect(r.actor).toMatchObject({ id: b.user.id, name: b.user.name });
    expect(r.room).toBe(room.id);
    expect(got.items[0]!.message.text).toBe("my words");

    // Counted: unseen rows, and the room's unread mentions and replies (not reactions).
    const c = await counts(a);
    expect(c.inbox).toBe(3);
    expect(c.mentions[room.id]).toBe(2);
    await a.pb.send("/api/chat/inbox/seen", { method: "POST", body: { at: got.items[0]!.created } });
    expect((await counts(a)).inbox).toBe(0);
    await a.pb.send("/api/chat/reads", { method: "POST", body: { room: room.id } });
    expect((await counts(a)).mentions[room.id]).toBeUndefined();

    expect(got.items[0]!.emojis).toEqual(["👍", "🎉"]);

    // Taken back: one of them, still there with the other; both, gone.
    await react(b, mine.id, "👍", false);
    expect((await inbox(a)).items.map((i) => [i.kind, i.emoji])).toContainEqual(["reaction", "🎉"]);
    await react(b, mine.id, "🎉", false);
    await b.pb.collection("messages").update(reply.id, { deleted: true });
    await b.pb.collection("messages").update(mention.id, { text: "hey nobody" });
    got = await inbox(a);
    expect(got.items).toEqual([]);
    // b has nothing: their own doings aren't told to them.
    expect((await inbox(b)).items).toEqual([]);
  });

  it("one person's reactions to a message are one row, however many: the first five named, then how many more", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const mine = await post(a, room.id, "react to this");
    const emoji = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏"];
    for (const e of emoji) await react(b, mine.id, e);
    const got = await inbox(a);
    expect(got.items).toHaveLength(1);
    expect(got.items[0]).toMatchObject({ kind: "reaction", emoji: "👍❤️😂🎉😮 +2", emojis: emoji });
    expect((await counts(a)).inbox).toBe(1);
  });

  it("a mention or reply read in its room is seen in the inbox too; a reaction isn't", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const mine = await post(a, room.id, "my words");
    await post(b, room.id, `hey @${await handleOf(a)}`);
    await post(b, room.id, "answer", { reply_to: mine.id });
    await react(b, mine.id, "👍");
    let got = await inbox(a);
    expect(got.items.map((i) => [i.kind, i.read])).toEqual([
      ["reaction", false],
      ["reply", false],
      ["mention", false],
    ]);
    expect((await counts(a)).inbox).toBe(3);

    await a.pb.send("/api/chat/reads", { method: "POST", body: { room: room.id } });
    got = await inbox(a);
    expect(got.items.map((i) => [i.kind, i.read])).toEqual([
      ["reaction", false],
      ["reply", true],
      ["mention", true],
    ]);
    expect((await counts(a)).inbox).toBe(1);

    // A new mention after the read is new again.
    await post(b, room.id, `again @${await handleOf(a)}`);
    expect((await inbox(a)).items[0]).toMatchObject({ kind: "mention", read: false });
    expect((await counts(a)).inbox).toBe(2);
  });

  it("pages with a cursor", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const h = await handleOf(a);
    for (let i = 0; i < 5; i++) await post(b, room.id, `@${h} ${i}`);
    const first = await inbox(a, { limit: "3" });
    expect(first.items.map((i) => i.message.text)).toEqual([`@${h} 4`, `@${h} 3`, `@${h} 2`]);
    expect(first.more).toBe(true);
    const next = await inbox(a, { limit: "3", before: first.items[2]!.cursor });
    expect(next.items.map((i) => i.message.text)).toEqual([`@${h} 1`, `@${h} 0`]);
    expect(next.more).toBe(false);
  });

  it("leaves out rooms you can't see any more, and hides who wrote in an anonymous room", async () => {
    const a = await newUser();
    const b = await newUser();
    const h = await handleOf(a);
    const priv = await b.pb.collection("rooms").create({ name: `p-${uniq()}`, created_by: b.user.id, visibility: "private" });
    await b.pb.collection("rooms").update(priv.id, { members: [b.user.id, a.user.id] });
    await post(b, priv.id, `@${h} secret`);
    expect((await inbox(a)).items.length).toBe(1);
    await b.pb.collection("rooms").update(priv.id, { members: [b.user.id] });
    expect((await inbox(a)).items).toEqual([]);

    const admin = await adminClient();
    const anon = await newRoom(b);
    await admin.collection("rooms").update(anon.id, { anonymous: true });
    await post(b, anon.id, `@${h} who am I`);
    const [item] = (await inbox(a)).items;
    expect(item?.actor).toMatchObject({ id: anon.id, name: anon.name });
  });

  it("tells your apps live on chat/inbox", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const events: { action: string; kind: string; room: string; message: string }[] = [];
    const unsubscribe = await a.pb.realtime.subscribe("chat/inbox", (e) => events.push(e));
    try {
      const m = await post(b, room.id, `@${await handleOf(a)} live`);
      await eventually(() => expect(events).toMatchObject([{ action: "create", kind: "mention", room: room.id, message: m.id }]));
      await b.pb.collection("messages").update(m.id, { deleted: true });
      await eventually(() => expect(events.map((e) => e.action)).toEqual(["create", "delete"]));
    } finally {
      await unsubscribe();
    }
  });

  it("a DM reply tells; a mentioned account deleted for good leaves the message be", async () => {
    const a = await newUser();
    const b = await newUser();
    const dm = await openDm(a, b);
    const m = await post(a, dm.id, "hi");
    await post(b, dm.id, "hello", { reply_to: m.id });
    expect((await inbox(a)).items.map((i) => i.kind)).toEqual(["reply"]);

    const c = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, `@${await handleOf(c)} bye`);
    const admin = await adminClient();
    await admin.collection("users").delete(c.user.id);
    const left = rawDb().prepare("SELECT mentions FROM messages WHERE id = ?").get(msg.id) as { mentions: string };
    expect(JSON.parse(left.mentions)).toEqual([]);
  });
});
