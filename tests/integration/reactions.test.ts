// Reactions (§20): POST /api/chat/reactions adds or removes the caller's emoji on a message the caller can see.
// They are stored on the message, so they come back (and live) wherever messages do; clients can't write them.

import type { RecordModel } from "pocketbase";
import { describe, expect, it } from "vitest";
import { MSG_FIELDS } from "../../web/src/api.ts";
import type { Reaction } from "../../web/src/lib/types.ts";
import {
  adminClient,
  collect,
  eventually,
  expectRejected,
  newRoom,
  newUser,
  openDm,
  post,
  rawDb,
  status,
  type TestUser,
} from "./helpers.ts";

interface Reacted {
  id: string;
  reactions: Reaction[];
  updated: string;
}

const react = (u: TestUser, message: string, emoji: string, on = true) =>
  u.pb.send<Reacted>("/api/chat/reactions", { method: "POST", body: { message, emoji, on } });

const reactionsOf = async (u: TestUser, id: string) => ((await u.pb.collection("messages").getOne(id)).reactions ?? []) as Reaction[];

describe("reactions: route (§20.2)", () => {
  it("adds and removes the caller's reactions, several different emoji per user", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    expect(msg.reactions).toEqual([]);

    await react(b, msg.id, "👍");
    await react(a, msg.id, "👍");
    await react(b, msg.id, "🎉");
    const res = await react(b, msg.id, "❤️");
    expect(res).toMatchObject({
      id: msg.id,
      reactions: [
        { emoji: "👍", users: [b.user.id, a.user.id] },
        { emoji: "🎉", users: [b.user.id] },
        { emoji: "❤️", users: [b.user.id] },
      ],
    });
    expect(await reactionsOf(a, msg.id)).toEqual(res.reactions);

    // Removing: the emoji goes when nobody uses it any more; the order of the rest stays.
    await react(b, msg.id, "🎉", false);
    await react(b, msg.id, "👍", false);
    expect(await reactionsOf(a, msg.id)).toEqual([
      { emoji: "👍", users: [a.user.id] },
      { emoji: "❤️", users: [b.user.id] },
    ]);
  });

  it("is idempotent: adding twice or removing what isn't there changes nothing", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const first = await react(a, msg.id, "😂");
    const again = await react(a, msg.id, "😂");
    expect(again).toEqual(first); // not even `updated`
    const off = await react(a, msg.id, "🔥", false);
    expect(off.reactions).toEqual([{ emoji: "😂", users: [a.user.id] }]);
    expect(off.updated).toBe(first.updated);
  });

  it("does not touch the text or the edit stamp, but bumps `updated` (the reconnect refetch goes by it, §7.5)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const res = await react(a, msg.id, "👀");
    const got = await a.pb.collection("messages").getOne(msg.id);
    expect(got).toMatchObject({ text: "hello", edited_at: "", deleted: false });
    expect(res.updated > msg.updated).toBe(true);
    expect(got.updated).toBe(res.updated);
  });

  it("two people reacting at the same moment both count", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "race");
    const users = [a, ...(await Promise.all([1, 2, 3, 4, 5].map(() => newUser())))];
    await Promise.all(users.map((u) => react(u, msg.id, "👍")));
    const [r] = await reactionsOf(a, msg.id);
    expect(new Set(r!.users)).toEqual(new Set(users.map((u) => u.user.id)));
  });

  it("an edit at the same moment doesn't lose reactions (edits keep the stored ones)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const users = await Promise.all([1, 2, 3, 4, 5, 6].map(() => newUser()));
    for (let round = 0; round < 3; round++) {
      const msg = await post(a, room.id, `race ${round}`);
      await Promise.all([
        ...users.map((_, i) => a.pb.collection("messages").update(msg.id, { text: `edit ${round} ${i}` })),
        ...users.map((u) => react(u, msg.id, "👍")),
      ]);
      const [r] = await reactionsOf(a, msg.id);
      expect(new Set(r?.users)).toEqual(new Set(users.map((u) => u.user.id)));
    }
  });

  it("answers with the whole message, expanded like a read of it", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const res = await b.pb.send<RecordModel>("/api/chat/reactions", {
      method: "POST",
      body: { message: msg.id, emoji: "👍", on: true },
      query: { expand: "author", fields: MSG_FIELDS },
    });
    const read = await b.pb.collection("messages").getOne(msg.id, { expand: "author", fields: MSG_FIELDS });
    expect(res).toEqual(read);
    expect(res.expand?.author).toEqual({ id: a.user.id, name: a.user.name, avatar: "", no_dms: false, instance: "" });
    expect(res).not.toHaveProperty("expand.author.email");
  });

  it("only takes the picker's emoji (web/src/lib/emoji.ts), and `on` as a boolean", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    for (const emoji of ["", "x", "👍👍", " 👍", "<b>", "🫠", 1, null]) {
      expect(await status(react(a, msg.id, emoji as string))).toBe(400);
    }
    for (const on of ["true", 1, null, undefined]) {
      const body = { message: msg.id, emoji: "👍", on };
      expect(await status(a.pb.send("/api/chat/reactions", { method: "POST", body }))).toBe(400);
    }
    expect(await reactionsOf(a, msg.id)).toEqual([]);
  });

  it("is 404 for unknown messages and someone else's DM; 401 when logged out", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    const secret = await post(a, dm.id, "secret");
    expect(await status(react(c, secret.id, "👍"))).toBe(404);
    expect(await status(react(c, "nosuchmessage00", "👍"))).toBe(404);
    expect(await status(react(c, "", "👍"))).toBe(404);
    // members can
    expect((await react(b, secret.id, "👍")).reactions).toEqual([{ emoji: "👍", users: [b.user.id] }]);

    a.pb.authStore.clear();
    expect(await status(react(a, secret.id, "👍"))).toBe(401);
  });

  it("refuses deleted messages and archived rooms (and the reactions stay as they were)", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    await react(b, msg.id, "👍");

    await a.pb.collection("rooms").update(room.id, { archived: true });
    expect(await status(react(b, msg.id, "🎉"))).toBe(400);
    expect(await status(react(b, msg.id, "👍", false))).toBe(400);
    expect(await reactionsOf(b, msg.id)).toEqual([{ emoji: "👍", users: [b.user.id] }]);
    await a.pb.collection("rooms").update(room.id, { archived: false });

    const gone = await post(a, room.id, "soon gone");
    await a.pb.collection("messages").update(gone.id, { deleted: true });
    expect(await status(react(b, gone.id, "👍"))).toBe(400);
  });

  it("takes at most 20 different emoji on a message, all of them from one person if they like (QA BUG-258)", async () => {
    const [a, b] = [await newUser(), await newUser()];
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const emoji = [
      "👍",
      "❤️",
      "😂",
      "🎉",
      "😮",
      "😢",
      "🙏",
      "🔥",
      "👀",
      "💯",
      "👏",
      "🤔",
      "😍",
      "😎",
      "🙌",
      "💪",
      "✅",
      "😅",
      "🥳",
      "🤝",
      "😴",
    ];
    for (const e of emoji.slice(0, 20)) await react(b, msg.id, e);
    const refused = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: { status: number; response: { data: Record<string, { message: string }> } }) => [
          err.status,
          err.response.data.emoji?.message,
        ],
      );
    expect((await reactionsOf(a, msg.id)).length).toBe(20);
    expect(await refused(react(a, msg.id, emoji[20]!))).toEqual([400, "A message can have at most 20 different reactions."]);
    await react(a, msg.id, emoji[1]!); // one of the 20
    expect((await reactionsOf(a, msg.id)).length).toBe(20);
    // Taking one back makes room.
    await react(b, msg.id, emoji[0]!, false);
    await react(a, msg.id, emoji[20]!);
    expect((await reactionsOf(a, msg.id)).length).toBe(20);
  });

  it("a soft delete wipes the reactions", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    await react(b, msg.id, "👍");
    const deleted = await a.pb.collection("messages").update(msg.id, { deleted: true });
    expect(deleted.reactions).toEqual([]);
    const row = rawDb().prepare("SELECT reactions FROM messages WHERE id = ?").get(msg.id) as { reactions: string };
    expect(JSON.parse(row.reactions)).toEqual([]);
  });

  it("an edit keeps the reactions", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "helo");
    await react(a, msg.id, "👍");
    const edited = await a.pb.collection("messages").update(msg.id, { text: "hello" });
    expect(edited.reactions).toEqual([{ emoji: "👍", users: [a.user.id] }]);
  });

  it("is rate limited (30 per 10 s per IP)", async () => {
    const admin = await adminClient();
    const settings = await admin.settings.getAll();
    expect(settings.rateLimits.rules).toContainEqual(
      expect.objectContaining({ label: "POST /api/chat/reactions", duration: 10, maxRequests: 30 }),
    );
  });
});

describe("reactions: clients can't write them (§20.1)", () => {
  it("not on create, not on update, not by the author", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const forged = [{ emoji: "👍", users: [b.user.id] }];
    await expectRejected(post(a, room.id, "x", { reactions: forged }));
    const msg = await post(a, room.id, "hello");
    await react(b, msg.id, "🎉");
    await expectRejected(a.pb.collection("messages").update(msg.id, { reactions: forged }));
    await expectRejected(a.pb.collection("messages").update(msg.id, { reactions: [] }));
    await expectRejected(a.pb.collection("messages").update(msg.id, { text: "edit", reactions: forged }));
    expect(await reactionsOf(a, msg.id)).toEqual([{ emoji: "🎉", users: [b.user.id] }]);
  });

  it("the update hook backs up the rule (superusers skip rules, not hooks)", async () => {
    const a = await newUser();
    const admin = await adminClient();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    await expectRejected(admin.collection("messages").update(msg.id, { reactions: [{ emoji: "👍", users: [a.user.id] }] }));
    expect(await reactionsOf(a, msg.id)).toEqual([]);
  });
});

describe("reactions: reach clients with the message (§20.2)", () => {
  it("come back in the fields the app asks for, and live as a message update", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const msg = await post(a, room.id, "hello");
    const sub = await collect(b.pb, "messages", { filter: `room = "${room.id}"`, expand: "author,reply_to.author", fields: MSG_FIELDS });
    try {
      await react(a, msg.id, "🚀");
      await eventually(() =>
        expect(sub.events.map((e) => [e.action, (e.record as RecordModel).reactions])).toContainEqual([
          "update",
          [{ emoji: "🚀", users: [a.user.id] }],
        ]),
      );
    } finally {
      await sub.stop();
    }
    const page = await b.pb.collection("messages").getList(1, 50, { filter: `room = "${room.id}"`, fields: MSG_FIELDS });
    expect(page.items[0]!.reactions).toEqual([{ emoji: "🚀", users: [a.user.id] }]);
  });
});
