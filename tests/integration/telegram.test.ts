// Telegram bridge (§26), end to end against its own PocketBase and a stub Bot API (tests/support/telegram.ts).
// The bridge's worker runs on a cron job and also on POST /api/telegram/tick; checks wait for its work with
// `eventually`, since either may do it.

import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { webpHeader } from "../support/images.ts";
import { withName } from "../support/names.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { startTelegramStub, type TelegramStub } from "../support/telegram.ts";
import { sleep, status } from "./helpers.ts";

const SECRET = "test-secret";

let stub: TelegramStub;
let server: PocketBaseServer;
let admin: PocketBase;

beforeAll(async () => {
  stub = await startTelegramStub();
  server = await startPocketBase({
    fixtureRoute: true,
    env: {
      TELEGRAM_BOT_TOKEN: stub.token,
      TELEGRAM_API_BASE: stub.url,
      TELEGRAM_WEBHOOK_URL: "https://chat.example/api/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET: SECRET,
    },
  });
  await disableRateLimits(server.url);
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await stub?.close();
});

/** Wait (up to `ms`) until `fn` passes, running the worker meanwhile. */
async function eventually<T>(fn: () => T | Promise<T>, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await tick();
      await sleep(100);
    }
  }
}

const tick = () => admin.send("/api/telegram/tick", { method: "POST" }).catch(() => {});

interface User {
  pb: PocketBase;
  user: RecordModel;
}

async function signUp(name = `user-${uniq()}`): Promise<User> {
  const pb = new PocketBase(server.url);
  pb.autoCancellation(false);
  const email = `${uniq()}@test.local`;
  const password = "password-123";
  await withName(server.url, name, () => pb.collection("users").create({ email, password, passwordConfirm: password, name }));
  const { record } = await pb.collection("users").authWithPassword(email, password);
  return { pb, user: record };
}

let chatSeq = 0;
/** A new Telegram group id (supergroups are negative). */
const newChat = () => -1_000_000_000_000 - ++chatSeq;

/** A room of `owner`, linked to a new Telegram group. */
async function linkedRoom(owner: User, extra: Record<string, unknown> = {}) {
  const room = await owner.pb.collection("rooms").create({ name: `tg-${uniq()}`, created_by: owner.user.id, ...extra });
  const chat = newChat();
  await admin.collection("tg_links").create({ chat_id: String(chat), title: "Group", room: room.id, enabled: true });
  return { room, chat };
}

let updateSeq = 1;
let tgMessageSeq = 1;
const ann = { id: 4242, is_bot: false, first_name: "Ann", last_name: "Lee", username: "annlee" };

/** POST an update to the webhook, as Telegram would. */
async function deliver(update: Record<string, unknown>, secret = SECRET) {
  return fetch(`${server.url}/api/telegram/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify({ update_id: updateSeq++, ...update }),
  });
}

/** A Telegram message in `chat`. */
function tgMessage(chat: number, fields: Record<string, unknown> = {}) {
  return {
    message_id: tgMessageSeq++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chat, type: "supergroup", title: "Group" },
    from: ann,
    ...fields,
  };
}

/** A room's messages, but for service messages (§5.3): those are `noticesOf`. */
const messagesOf = (room: string) =>
  admin
    .collection("messages")
    .getFullList({ filter: admin.filter("room = {:room} && author != ''", { room }), sort: "created", expand: "author" });

/** The texts of a room's service messages (§5.3). */
const noticesOf = async (room: string) =>
  (
    await admin.collection("messages").getFullList({ filter: admin.filter("room = {:room} && author = ''", { room }), sort: "created" })
  ).map((m) => m.text);

/** The bot removed from `chat` (kicked, or left). */
const removeBot = (chat: number, status = "kicked") =>
  deliver({
    my_chat_member: {
      chat: { id: chat, type: "supergroup", title: "Group" },
      from: ann,
      date: 0,
      old_chat_member: { status: "member", user: { id: 1 } },
      new_chat_member: { status, user: { id: 1 } },
    },
  });

describe("Telegram bridge (§26)", () => {
  it("tells Telegram where to send updates, signed, one at a time; a wrong secret is refused", async () => {
    const [hook] = stub.callsOf("setWebhook");
    expect(hook!.params).toMatchObject({
      url: "https://chat.example/api/telegram/webhook",
      secret_token: SECRET,
      max_connections: 1,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member", "message_reaction"],
    });
    expect((await deliver({}, "wrong")).status).toBe(401);
    expect((await deliver({})).status).toBe(200);
  });

  it("added to a group, the bot makes a disabled link for it and says the chat id; /chatid says it again", async () => {
    const chat = newChat();
    await deliver({
      my_chat_member: {
        chat: { id: chat, type: "supergroup", title: "Friends" },
        from: ann,
        date: 0,
        old_chat_member: { status: "left", user: { id: 1 } },
        new_chat_member: { status: "member", user: { id: 1 } },
      },
    });
    const link = await admin.collection("tg_links").getFirstListItem(admin.filter("chat_id = {:c}", { c: String(chat) }));
    expect(link).toMatchObject({ title: "Friends", enabled: false, room: "" });
    expect(stub.callsOf("sendMessage").at(-1)!.params.text).toContain(`Chat id: ${chat}`);
    await deliver({ message: tgMessage(chat, { text: "/chatid@stub_bot" }) });
    expect(stub.callsOf("sendMessage").at(-1)!.params.text).toContain("isn't linked");
  });

  it("links only rooms (not DMs), and only with a room", async () => {
    const a = await signUp();
    const b = await signUp();
    const dm = await a.pb.send("/api/chat/dms", { method: "POST", body: { user: b.user.id } });
    expect(await status(admin.collection("tg_links").create({ chat_id: String(newChat()), room: dm.id }))).toBe(400);
    expect(await status(admin.collection("tg_links").create({ chat_id: String(newChat()), enabled: true }))).toBe(400);
    // Only superusers see the bridge's collections.
    for (const name of ["tg_links", "tg_people", "tg_messages", "tg_queue"])
      expect(await status(a.pb.collection(name).getList())).toBe(403);
  });

  it("a Telegram message shows under its sender's stand-in, with their picture; stand-ins take no DMs", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.addFile("ann-photo", PNG, "photos/ann.jpg");
    stub.setPhoto(ann.id, "ann-photo");
    await deliver({ message: tgMessage(chat, { text: "hello from telegram" }) });
    const [m] = await eventually(async () => {
      const list = await messagesOf(room.id);
      expect(list).toHaveLength(1);
      return list;
    });
    expect(m!.text).toBe("hello from telegram");
    const author = m!.expand!.author;
    expect(author.name).toBe("Ann Lee (TG)");
    expect(author.no_dms).toBe(true);
    expect(author.avatar).toMatch(/^avatar_\w{10}\.jpg$/);
    expect(await status(owner.pb.send("/api/chat/dms", { method: "POST", body: { user: author.id } }))).toBe(400);
    // Not sent back to the group it came from.
    await tick();
    expect(stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(chat))).toEqual([]);
  });

  it("a channel's posts and their edits come over under the channel's stand-in", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const channel = { id: chat, type: "channel", title: "News" };
    const post = { message_id: tgMessageSeq++, date: Math.floor(Date.now() / 1000), chat: channel, sender_chat: channel };
    await deliver({ channel_post: { ...post, text: "first post" } });
    const [m] = await eventually(async () => {
      const list = await messagesOf(room.id);
      expect(list).toHaveLength(1);
      return list;
    });
    expect(m!.text).toBe("first post");
    expect(m!.expand!.author.name).toBe("News (TG)");
    await deliver({ edited_channel_post: { ...post, text: "first post, fixed", edit_date: post.date + 1 } });
    await eventually(async () => expect((await messagesOf(room.id)).map((x) => x.text)).toEqual(["first post, fixed"]));
  });

  it("brings files over, an album as one message, and says what it can't bring", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.addFile("p1", PNG, "photos/p1.jpg");
    stub.addFile("p2", PNG, "photos/p2.jpg");
    stub.addFile("doc", new TextEncoder().encode("%PDF-1.4"), "documents/report.pdf");
    const album = `album-${uniq()}`;
    await deliver({
      message: tgMessage(chat, { media_group_id: album, caption: "our trip", photo: [{ file_id: "p1", width: 90, height: 90 }] }),
    });
    await deliver({ message: tgMessage(chat, { media_group_id: album, photo: [{ file_id: "p2", width: 90, height: 90 }] }) });
    // Something else after the album: the album is complete, and shows first.
    await deliver({
      message: tgMessage(chat, {
        document: { file_id: "doc", file_name: "Report 2026.pdf", file_size: 8 },
        caption: "the report",
      }),
    });
    await deliver({
      message: tgMessage(chat, { video: { file_id: "huge", file_name: "film.mp4", file_size: 25 * 1024 * 1024 } }),
    });
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(3);
      return l;
    });
    expect(list.map((m) => [m.text, m.files.length])).toEqual([
      ["our trip", 2],
      ["the report", 1],
      ["[film.mp4, 25 MB: too large to bring over from Telegram]", 0],
    ]);
    expect(list[0]!.files[0]).toMatch(/\.jpg$/);
    expect(Object.values(list[1]!.file_names)).toEqual(["Report 2026.pdf"]);
  });

  it("a rich message (headings, lists, tables…) comes over as plain text, with its media as files; edits too", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.addFile("rich-photo", PNG, "photos/rich.jpg");
    const blocks = [
      { type: "heading", size: 1, text: "Trip plan" },
      {
        type: "paragraph",
        text: ["We leave ", { type: "bold", text: "Friday" }, ", see ", { type: "url", text: "the map", url: "https://example.com/m" }],
      },
      {
        type: "list",
        items: [
          { label: "1.", blocks: [{ type: "paragraph", text: "Tickets" }], has_checkbox: true, is_checked: true },
          { label: "2.", blocks: [{ type: "paragraph", text: "Hotel" }], has_checkbox: true },
        ],
      },
      { type: "heading", size: 2, text: { type: "italic", text: "Costs" } },
      {
        type: "table",
        cells: [
          [
            { text: "Item", is_header: true },
            { text: "€", is_header: true },
          ],
          [{ text: "Train" }, { text: "40" }],
        ],
      },
      { type: "blockquote", blocks: [{ type: "paragraph", text: "Pack light" }], credit: "Mum" },
      {
        type: "photo",
        photo: [
          { file_id: "small", width: 9, height: 9 },
          { file_id: "rich-photo", width: 90, height: 90 },
        ],
        caption: { text: "the view" },
      },
      { type: "divider" },
      { type: "footer", text: [{ type: "custom_emoji", custom_emoji_id: "1", alternative_text: "👋" }, " bye"] },
    ];
    const msg = tgMessage(chat, { rich_message: { blocks } });
    await deliver({ message: msg });
    const [m] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    expect(m!.text).toBe(
      [
        "Trip plan",
        "We leave Friday, see the map (https://example.com/m)",
        "1. ☑ Tickets",
        "2. ☐ Hotel",
        "",
        "Costs",
        "Item | €",
        "Train | 40",
        "> Pack light",
        "> — Mum",
        "the view",
        "———",
        "👋 bye",
      ].join("\n"),
    );
    expect(m!.files).toHaveLength(1);
    expect(m!.files[0]).toMatch(/\.jpg$/);

    await deliver({ edited_message: { ...msg, rich_message: { blocks: [{ type: "heading", text: "Trip cancelled" }] }, edit_date: 1 } });
    await eventually(async () => expect((await messagesOf(room.id)).map((x) => x.text)).toEqual(["Trip cancelled"]));
  });

  it("an album item delivered twice (a webhook retry) comes over once, with the rest of the album (QA BUG-147)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.addFile("r1", PNG, "photos/r1.jpg");
    stub.addFile("r2", PNG, "photos/r2.jpg");
    const album = `album-${uniq()}`;
    const first = tgMessage(chat, { media_group_id: album, caption: "twice", photo: [{ file_id: "r1", width: 9, height: 9 }] });
    await deliver({ message: first });
    await deliver({ message: first });
    await deliver({ message: tgMessage(chat, { media_group_id: album, photo: [{ file_id: "r2", width: 9, height: 9 }] }) });
    await deliver({ message: tgMessage(chat, { text: "after" }) });
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(2);
      return l;
    });
    expect(list.map((m) => [m.text, m.files.length])).toEqual([
      ["twice", 2],
      ["after", 0],
    ]);
  });

  it("an album that ends a conversation comes over once it is quiet", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.addFile("q1", PNG, "photos/q1.jpg");
    const album = `album-${uniq()}`;
    await deliver({ message: tgMessage(chat, { media_group_id: album, photo: [{ file_id: "q1", width: 9, height: 9 }] }) });
    expect(await messagesOf(room.id)).toHaveLength(0);
    await sleep(1600);
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    expect(list[0]!.files).toHaveLength(1);
  });

  it("replies and edits from Telegram; a delivery Telegram repeats comes over once", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const first = tgMessage(chat, { text: "first" });
    await deliver({ message: first });
    await deliver({ message: first }); // a webhook retry
    await deliver({ message: tgMessage(chat, { text: "answer", reply_to_message: first }) });
    await deliver({ edited_message: { ...first, text: "first, edited", edit_date: 1 } });
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l.map((m) => m.text)).toEqual(["first, edited", "answer"]);
      return l;
    });
    expect(list[0]!.edited_at).not.toBe("");
    expect(list[1]!.reply_to).toBe(list[0]!.id);
  });

  it("a Telegram message too long for one chat message comes over as several, in order, split at line breaks", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const other = newChat();
    await admin.collection("tg_links").create({ chat_id: String(other), title: "Other", room: room.id, enabled: true });
    const first = tgMessage(chat, { text: "first" });
    await deliver({ message: first });
    const line = "x".repeat(49); // 50 with its line break
    const text = Array.from({ length: 80 }, () => line).join("\n"); // 3999 characters
    const long = tgMessage(chat, { text, reply_to_message: first });
    await deliver({ message: long });
    await deliver({ message: long }); // a webhook retry
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(3);
      return l;
    });
    const parts = list.slice(1);
    expect(parts.map((m) => m.text.length)).toEqual([1999, 1999]);
    expect(parts.map((m) => m.text).join("\n")).toBe(text);
    expect(parts.map((m) => m.reply_to)).toEqual([list[0]!.id, ""]);
    expect(new Set(parts.map((m) => m.author)).size).toBe(1);

    // The other group gets each part; the group it came from none.
    await eventually(() => expect(stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(other))).toHaveLength(3));
    expect(stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(chat))).toEqual([]);

    // A shorter edit deletes the parts left over; a longer one adds parts. A text with no break is cut at the limit.
    await deliver({ edited_message: { ...long, text: `${line}\n${line}`, edit_date: 1 } });
    await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l.map((m) => [m.text, m.deleted])).toEqual([
        ["first", false],
        [`${line}\n${line}`, false],
        ["", true],
      ]);
    });
    await deliver({ edited_message: { ...long, text: "y".repeat(2500), edit_date: 2 } });
    await eventually(async () => {
      const l = (await messagesOf(room.id)).filter((m) => !m.deleted);
      expect(l.map((m) => m.text)).toEqual(["first", "y".repeat(2000), "y".repeat(500)]);
    });
  });

  it("deleting a later part of a long Telegram message in the room leaves the Telegram message there", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const long = tgMessage(chat, { text: `${"a".repeat(1500)} ${"b".repeat(1500)}` });
    await deliver({ message: long });
    const [head, tail] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l.map((m) => m.text)).toEqual(["a".repeat(1500), "b".repeat(1500)]);
      return l;
    });
    await admin.collection("messages").update(tail!.id, { deleted: true });
    await admin.collection("messages").update(head!.id, { deleted: true });
    // Sent in order: once the first part's delete is through, the later part's was passed over.
    await eventually(() => expect(stub.callsOf("deleteMessage").filter((c) => c.params.chat_id === String(chat))).toHaveLength(1));
    await tick();
    const deletes = stub.callsOf("deleteMessage").filter((c) => c.params.chat_id === String(chat));
    expect(deletes.map((c) => c.params.message_id)).toEqual([long.message_id]);
  });

  it("what a Telegram reply quotes shows in its text: a part of a message, a channel's post, one the room hasn't got", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const first = tgMessage(chat, { text: "line one\nline two" });
    await deliver({ message: first });
    // A quote of part of a message in the room: a reply to it, with the part over the text.
    const agreed = tgMessage(chat, { text: "agreed", reply_to_message: first, quote: { text: "line two", position: 9 } });
    await deliver({ message: agreed });
    // A post of a channel the group isn't linked with, quoted.
    await deliver({
      message: tgMessage(chat, {
        text: "see this",
        external_reply: {
          origin: { type: "channel", chat: { id: -100555, type: "channel", title: "News" }, message_id: 7, date: 1 },
          chat: { id: -100555, type: "channel", title: "News" },
          message_id: 7,
        },
        quote: { text: "big\nnews", position: 0 },
      }),
    });
    // A reply to a message from before the bridge, without a quote: no lines, as there is no quote to show.
    const old = { ...tgMessage(chat, { text: "old" }), message_id: 1 };
    await deliver({ message: tgMessage(chat, { text: "plain reply", reply_to_message: old }) });
    // The same with a quote says whom it answers.
    await deliver({ message: tgMessage(chat, { text: "quoted reply", reply_to_message: old, quote: { text: "old", position: 0 } }) });
    const list = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l.map((m) => m.text)).toEqual([
        "line one\nline two",
        "> line two\nagreed",
        "↩ In reply to News\n> big\n> news\nsee this",
        "plain reply",
        "↩ In reply to Ann Lee\n> old\nquoted reply",
      ]);
      return l;
    });
    expect(list[1]!.reply_to).toBe(list[0]!.id);
    expect(list[2]!.reply_to).toBe("");
    // An edit keeps the quote.
    await deliver({ edited_message: { ...agreed, text: "agreed, edited", edit_date: 1 } });
    await eventually(async () => expect((await messagesOf(room.id))[1]!.text).toBe("> line two\nagreed, edited"));
  });

  it("a stand-in posting in a private room becomes a member of it", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner, { visibility: "private" });
    await deliver({ message: tgMessage(chat, { text: "private hello", from: { ...ann, id: 777, first_name: "Pri" } }) });
    const [m] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    expect((await admin.collection("rooms").getOne(room.id)).members).toContain(m!.author);
  });

  it("a stand-in posting where only some people post becomes a writer (§23.6)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner, { posting: "selected" });
    await deliver({ message: tgMessage(chat, { text: "chosen hello", from: { ...ann, id: 778, first_name: "Sel" } }) });
    const [m] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    expect((await admin.collection("rooms").getOne(room.id)).writers).toEqual([owner.user.id, m!.author]);
  });

  it("a chat message goes to the group under its author's name; replies, edits and deletes follow", async () => {
    const owner = await signUp(`Bob-${uniq()}`);
    const { room, chat } = await linkedRoom(owner);
    const from = tgMessage(chat, { text: "question?" });
    await deliver({ message: from });
    const [q] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    const sent = await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: "a <b>bold</b> answer", reply_to: q!.id });
    const call = await eventually(() => {
      const c = stub.callsOf("sendMessage").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(call.params).toMatchObject({
      text: `<b>${owner.user.name}</b>\na &lt;b&gt;bold&lt;/b&gt; answer`,
      parse_mode: "HTML",
      reply_parameters: { message_id: from.message_id },
    });
    await owner.pb.collection("messages").update(sent.id, { text: "edited answer" });
    const edit = await eventually(() => {
      const c = stub.callsOf("editMessageText").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(edit.params.text).toBe(`<b>${owner.user.name}</b>\nedited answer`);
    await owner.pb.collection("messages").update(sent.id, { deleted: true });
    await eventually(() => expect(stub.callsOf("deleteMessage").find((x) => x.params.chat_id === String(chat))).toBeDefined());
  });

  it("an anonymous link's group gets only what was said: no author, nor whose a forward is", async () => {
    const owner = await signUp(`Bob-${uniq()}`);
    const room = await owner.pb.collection("rooms").create({ name: `tg-${uniq()}`, created_by: owner.user.id });
    const chat = newChat();
    await admin.collection("tg_links").create({ chat_id: String(chat), title: "Group", room: room.id, enabled: true, anonymous: true });
    const sentTo = (method: string, n = 1) =>
      eventually(() => {
        const c = stub.callsOf(method).filter((x) => x.params.chat_id === String(chat));
        expect(c).toHaveLength(n);
        return c[n - 1]!;
      });

    const sent = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "a <b>secret</b>" });
    expect((await sentTo("sendMessage")).params).toMatchObject({ text: "a &lt;b&gt;secret&lt;/b&gt;", parse_mode: "HTML" });
    await owner.pb.collection("messages").update(sent.id, { text: "edited" });
    expect((await sentTo("editMessageText")).params.text).toBe("edited");

    const elsewhere = await owner.pb.collection("rooms").create({ name: `src-${uniq()}`, created_by: owner.user.id });
    const original = await owner.pb.collection("messages").create({ room: elsewhere.id, author: owner.user.id, text: "passed on" });
    await owner.pb.send("/api/chat/forward", { method: "POST", body: { messages: [original.id], room: room.id } });
    expect((await sentTo("sendMessage", 2)).params.text).toBe("passed on");

    const pic = await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: "x".repeat(1000), files: [new File([PNG], "a.png", { type: "image/png" })] });
    expect((await sentTo("sendPhoto")).params.caption).toBe("x".repeat(1000));
    // An edit too long for a caption is cut to exactly Telegram's limit, with no header to make room for.
    await owner.pb.collection("messages").update(pic.id, { text: "y".repeat(1100) });
    expect((await sentTo("editMessageCaption")).params.caption).toBe(`${"y".repeat(1023)}…`);

    // A sticker with no text: no header either, so only the sticker (it was dropped whole).
    const webp = new File([new Uint8Array(webpHeader(512, 512))], "sticker_1.webp", { type: "image/webp" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, files: [webp] });
    expect((await sentTo("sendSticker")).params.caption).toBeUndefined();
    expect(stub.callsOf("sendMessage").filter((x) => x.params.chat_id === String(chat))).toHaveLength(2);
  });

  it("an anonymous room's messages go under the room's name, and forwards of them as from it (§35)", async () => {
    const owner = await signUp(`Ann-${uniq()}`);
    const source = await owner.pb.collection("rooms").create({ name: `anon-${uniq()}`, created_by: owner.user.id });
    await admin.collection("rooms").update(source.id, { anonymous: true });
    const { room, chat } = await linkedRoom(owner);
    const sentTo = (n: number) =>
      eventually(() => {
        const c = stub.callsOf("sendMessage").filter((x) => x.params.chat_id === String(chat));
        expect(c).toHaveLength(n);
        return c[n - 1]!;
      });

    await admin.collection("rooms").update(room.id, { anonymous: true });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "unsigned" });
    expect((await sentTo(1)).params.text).toBe(`<b>${room.name}</b>\nunsigned`);
    await admin.collection("rooms").update(room.id, { anonymous: false });
    const original = await owner.pb.collection("messages").create({ room: source.id, author: owner.user.id, text: "passed on" });
    await owner.pb.send("/api/chat/forward", { method: "POST", body: { messages: [original.id], room: room.id } });
    expect((await sentTo(2)).params.text).toBe(`<b>${owner.user.name}</b> <i>forwarded from ${source.name}</i>\npassed on`);
  });

  it("attachments go as an album of photos with the text as its caption, and documents apart", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    await owner.pb.collection("messages").create({
      room: room.id,
      author: owner.user.id,
      text: "pics",
      files: [
        new File([PNG], "a.png", { type: "image/png" }),
        new File([PNG], "b.png", { type: "image/png" }),
        new File(["%PDF"], "Notes.pdf"),
      ],
    });
    const group = await eventually(() => {
      const c = stub.callsOf("sendMediaGroup").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(group.params.media).toEqual([
      { type: "photo", media: "attach://file0", caption: `<b>${owner.user.name}</b>\npics`, parse_mode: "HTML" },
      { type: "photo", media: "attach://file1" },
    ]);
    // By the name the media refer to: PocketBase sends multipart fields in no particular order.
    expect([group.files.file0!.name, group.files.file1!.name]).toEqual(["a.png", "b.png"]);
    const doc = await eventually(() => {
      const c = stub.callsOf("sendDocument").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(doc.files.document!.name).toBe("Notes.pdf");
    expect(doc.params.caption).toBeUndefined();
  });

  it("videos go as videos that play as they load, a phone's .mov too", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    await owner.pb.collection("messages").create({
      room: room.id,
      author: owner.user.id,
      files: [new File(["mov"], "IMG_0001.MOV", { type: "video/quicktime" })],
    });
    const one = await eventually(() => {
      const c = stub.callsOf("sendVideo").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(one.params.supports_streaming).toBe("true");
    expect(one.files.video!.name).toBe("IMG_0001.MOV");
    await owner.pb.collection("messages").create({
      room: room.id,
      author: owner.user.id,
      files: [new File([PNG], "a.png", { type: "image/png" }), new File(["mp4"], "clip.mp4", { type: "video/mp4" })],
    });
    const group = await eventually(() => {
      const c = stub.callsOf("sendMediaGroup").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect(group.params.media).toMatchObject([{ type: "photo" }, { type: "video", supports_streaming: true }]);
    expect(stub.callsOf("sendDocument").find((x) => x.params.chat_id === String(chat))).toBeUndefined();
  });

  it("a lone sticker-sized WebP goes as a sticker (keeping its transparency), its text before it; others as photos", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const webp = (name: string, w: number, h: number) => new File([new Uint8Array(webpHeader(w, h))], name, { type: "image/webp" });
    const ours = (method: string) => stub.callsOf(method).filter((x) => x.params.chat_id === String(chat));
    await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: "hi", files: [webp("sticker_1.webp", 512, 480)] });
    const sticker = await eventually(() => {
      const c = ours("sendSticker");
      expect(c).toHaveLength(1);
      return c[0]!;
    });
    expect(sticker.files.sticker!.name).toBe("sticker_1.webp");
    expect(sticker.params.caption).toBeUndefined();
    expect(ours("sendMessage").map((c) => c.params.text)).toEqual([`<b>${owner.user.name}</b>\nhi`]);

    // Bigger than a sticker, or one of several: photos, as before.
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, files: [webp("big.webp", 513, 100)] });
    await eventually(() => expect(ours("sendPhoto")).toHaveLength(1));
    await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, files: [webp("a.webp", 100, 100), webp("b.webp", 100, 100)] });
    const group = await eventually(() => {
      const c = ours("sendMediaGroup");
      expect(c).toHaveLength(1);
      return c[0]!;
    });
    expect(group.params.media).toMatchObject([{ type: "photo" }, { type: "photo" }]);
    expect(ours("sendSticker")).toHaveLength(1);
  });

  it("a room linked to two groups passes each group's messages to the other", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const other = newChat();
    await admin.collection("tg_links").create({ chat_id: String(other), title: "Other", room: room.id, enabled: true });
    await deliver({ message: tgMessage(chat, { text: "to the other group" }) });
    const call = await eventually(() => {
      const c = stub.callsOf("sendMessage").find((x) => x.params.chat_id === String(other));
      expect(c).toBeDefined();
      return c!;
    });
    expect(call.params.text).toBe("<b>Ann Lee (TG)</b>\nto the other group");
    await tick();
    expect(stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(chat))).toEqual([]);
  });

  it("retries what Telegram refuses for now, in order; drops what it refuses for good", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    stub.fail("sendMessage", 429, { description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "one" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "two" });
    const texts = () =>
      stub
        .callsOf("sendMessage")
        .filter((c) => c.params.chat_id === String(chat))
        .map((c) => c.params.text.split("\n")[1]);
    await eventually(() => expect(texts()).toEqual(["one", "one", "two"]), 15_000);

    stub.fail("sendMessage", 400, { description: "Bad Request: chat not found" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "three" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "four" });
    await eventually(() => expect(texts()).toEqual(["one", "one", "two", "three", "four"]), 15_000);
    await eventually(async () =>
      expect(await admin.collection("tg_queue").getFullList({ filter: admin.filter("chat_id = {:c}", { c: String(chat) }) })).toEqual([]),
    );
  }, 30_000);

  it("a queued send claimed by another pass isn't sent again until its claim runs out (QA BUG-147)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const sent = () => stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(chat)).length;
    const m = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "claimed" });
    const [row] = await admin.collection("tg_queue").getFullList({ filter: admin.filter("message = {:m}", { m: m.id }) });
    if (!row) return; // the cron's worker sent it already: nothing to claim
    const at = (ms: number) => new Date(Date.now() + ms).toISOString().replace("T", " ");
    await admin.collection("tg_queue").update(row.id, { locked_until: at(60_000) });
    await tick();
    expect(sent()).toBe(0);
    await admin.collection("tg_queue").update(row.id, { locked_until: at(-1000) });
    await eventually(() => expect(sent()).toBe(1));
  });

  it("Telegram reactions (the bot an admin) come over as the stand-ins' own, on messages from either side (§26.9)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const from = tgMessage(chat, { text: "react to me" });
    await deliver({ message: from });
    const [m] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    const bob = { id: 4343, is_bot: false, first_name: "Bob", last_name: "Tg" };
    const reaction = (message_id: number, user: Record<string, unknown>, old_reaction: unknown[], new_reaction: unknown[]) =>
      deliver({
        message_reaction: { chat: { id: chat, type: "supergroup", title: "Group" }, message_id, user, date: 0, old_reaction, new_reaction },
      });
    const emoji = (e: string) => ({ type: "emoji", emoji: e });
    const reactionsOf = async (id: string) => (await admin.collection("messages").getOne(id)).reactions;
    const standIn = async (name: string) => (await admin.collection("users").getFirstListItem(admin.filter("name = {:n}", { n: name }))).id;

    await reaction(from.message_id, bob, [], [emoji("👍"), { type: "custom_emoji", custom_emoji_id: "1" }]);
    const bobId = await eventually(() => standIn("Bob Tg (TG)"));
    expect(await reactionsOf(m!.id)).toEqual([{ emoji: "👍", users: [bobId] }]);
    // Telegram's "❤" is the picker's "❤️"; a shrug of either gender is "🤷"; what the picker hasn't got is left out.
    await reaction(from.message_id, bob, [emoji("👍")], [emoji("❤"), emoji("🤷‍♂"), emoji("🕊")]);
    await reaction(from.message_id, ann, [], [emoji("❤")]);
    const annId = await standIn("Ann Lee (TG)");
    expect(await reactionsOf(m!.id)).toEqual([
      { emoji: "❤️", users: [bobId, annId] },
      { emoji: "🤷", users: [bobId] },
    ]);
    await reaction(from.message_id, bob, [emoji("❤"), emoji("🤷‍♂")], []);
    expect(await reactionsOf(m!.id)).toEqual([{ emoji: "❤️", users: [annId] }]);

    // A chat message sent to the group takes them too, on any of its Telegram messages.
    const mine = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "mine" });
    await eventually(() => {
      const c = stub.callsOf("sendMessage").find((x) => x.params.chat_id === String(chat) && String(x.params.text).endsWith("mine"));
      expect(c).toBeDefined();
      return c!;
    });
    const row = await admin.collection("tg_messages").getFirstListItem(admin.filter("message = {:m}", { m: mine.id }));
    await reaction(row.tg_message_id, bob, [], [emoji("🔥")]);
    expect(await reactionsOf(mine.id)).toEqual([{ emoji: "🔥", users: [bobId] }]);
    // Stand-ins' reactions are in the group already: the bot doesn't repeat them.
    await tick();
    expect(stub.callsOf("setMessageReaction").filter((c) => c.params.chat_id === String(chat))).toEqual([]);
  });

  it("the bot shows the reaction most of the room's own people gave, among those Telegram offers (§26.9)", async () => {
    const owner = await signUp();
    const [b, c] = [await signUp(), await signUp()];
    const { room, chat } = await linkedRoom(owner);
    const from = tgMessage(chat, { text: "how was it?" });
    await deliver({ message: from });
    const [m] = await eventually(async () => {
      const l = await messagesOf(room.id);
      expect(l).toHaveLength(1);
      return l;
    });
    const react = (u: User, emoji: string, on = true) =>
      u.pb.send("/api/chat/reactions", { method: "POST", body: { message: m!.id, emoji, on } });
    const last = () =>
      stub
        .callsOf("setMessageReaction")
        .filter((x) => x.params.chat_id === String(chat))
        .at(-1)?.params;
    const shows = (reaction: unknown[]) =>
      eventually(() => expect(last()).toEqual({ chat_id: String(chat), message_id: from.message_id, reaction }));

    await react(owner, "❤️");
    await shows([{ type: "emoji", emoji: "❤" }]);
    await react(b, "🎉");
    await react(c, "🎉");
    await shows([{ type: "emoji", emoji: "🎉" }]);
    // One Telegram doesn't offer changes nothing; nor does a stand-in's (Ann's, from the group).
    const calls = stub.callsOf("setMessageReaction").length;
    await react(owner, "🍕");
    await deliver({
      message_reaction: {
        chat: { id: chat, type: "supergroup", title: "Group" },
        message_id: from.message_id,
        user: ann,
        date: 0,
        old_reaction: [],
        new_reaction: [
          { type: "emoji", emoji: "❤" },
          { type: "emoji", emoji: "👍" },
        ],
      },
    });
    await tick();
    expect(stub.callsOf("setMessageReaction")).toHaveLength(calls);
    await react(b, "🎉", false);
    await react(c, "🎉", false);
    await shows([{ type: "emoji", emoji: "❤" }]);
    await react(owner, "❤️", false);
    await shows([]);
  });

  it("nothing goes either way while a link is disabled or its room archived", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const link = await admin.collection("tg_links").getFirstListItem(admin.filter("chat_id = {:c}", { c: String(chat) }));
    await admin.collection("tg_links").update(link.id, { enabled: false });
    await deliver({ message: tgMessage(chat, { text: "nobody hears" }) });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "unsent" });
    await admin.collection("tg_links").update(link.id, { enabled: true });
    await owner.pb.collection("rooms").update(room.id, { archived: true });
    await deliver({ message: tgMessage(chat, { text: "still nobody" }) });
    await tick();
    await sleep(300);
    expect((await messagesOf(room.id)).map((m) => m.text)).toEqual(["unsent"]);
    expect(stub.callsOf("sendMessage").filter((c) => c.params.chat_id === String(chat))).toEqual([]);
  });

  it('only stand-ins are named "… (TG)": a chat user can\'t pass for a Telegram person (QA BUG-86)', async () => {
    // Control and invisible characters after it are cleaned away before the name is stored (QA BUG-142).
    const tails = ["\u0001", "\u007f", "\u009f", "\u200b", "\u202e", "\t\u0085"];
    for (const name of [
      `Ann ${uniq()} (TG)`,
      `Ann ${uniq()} (tg)`,
      `Ann ${uniq()}（ＴＧ）`,
      `Ann ${uniq()}(TG)`,
      ...tails.map((t) => `Ann ${uniq()} (TG)${t}`),
    ]) {
      expect(await status(signUp(name)), name).toBe(400);
    }
    const u = await signUp();
    expect(await status(u.pb.collection("users").update(u.user.id, { name: `Ann ${uniq()} (TG)` }))).toBe(400);
    expect(await status(u.pb.collection("users").update(u.user.id, { name: `Bob ${uniq()} (TG)\u0001` }))).toBe(400);
    expect(await status(u.pb.collection("users").update(u.user.id, { name: `TG fan ${uniq()}` }))).toBe(200);
    // Superusers name anyone as they like (the admin UI).
    expect(await status(admin.collection("users").update(u.user.id, { name: `Ann ${uniq()} (TG)` }))).toBe(200);
  });

  it("an edit too long for a caption is cut to fit it, which Telegram takes (QA BUG-87)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const sent = await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: "short", files: [new File(["%PDF"], "Notes.pdf")] });
    await eventually(() => expect(stub.callsOf("sendDocument").find((x) => x.params.chat_id === String(chat))).toBeDefined());
    await owner.pb.collection("messages").update(sent.id, { text: "y".repeat(1500) });
    const edit = await eventually(() => {
      const c = stub.callsOf("editMessageCaption").find((x) => x.params.chat_id === String(chat));
      expect(c).toBeDefined();
      return c!;
    });
    expect([...String(edit.params.caption).replace(/<[^>]+>/g, "")].length).toBe(1024); // Telegram's limit
    expect(edit.params.caption).toMatch(/^<b>.+<\/b>\ny+…$/);
  });

  it("a group's service messages (a new photo, a timer, a topic) make no stand-in and no member (QA BUG-88)", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner, { visibility: "private" });
    const bea = { id: 880_001, is_bot: false, first_name: "Bea" };
    for (const fields of [
      { new_chat_photo: [{ file_id: "x", file_unique_id: "x", width: 1, height: 1 }] },
      { message_auto_delete_timer_changed: { message_auto_delete_time: 86400 } },
      { forum_topic_created: { name: "Topic", icon_color: 1 } },
    ]) {
      expect((await deliver({ message: tgMessage(chat, { from: bea, ...fields }) })).status).toBe(200);
    }
    await tick();
    expect(await admin.collection("tg_people").getList(1, 1, { filter: `tg_user_id = "${bea.id}"` })).toHaveProperty("totalItems", 0);
    expect((await admin.collection("rooms").getOne(room.id)).members).toEqual([owner.user.id]); // its creator only
    expect(await messagesOf(room.id)).toEqual([]);
  });

  it("a room says when a group is connected to it or disconnected from it, and Telegram doesn't hear of it", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    const connected = 'Telegram group "Group" was connected to this room.';
    const disconnected = 'Telegram group "Group" was disconnected from this room.';
    expect(await noticesOf(room.id)).toEqual([connected]);
    const link = await admin.collection("tg_links").getFirstListItem(admin.filter("chat_id = {:c}", { c: String(chat) }));
    await admin.collection("tg_links").update(link.id, { enabled: false });
    await admin.collection("tg_links").update(link.id, { title: "Renamed" }); // disabled: nothing to say
    await admin.collection("tg_links").update(link.id, { title: "Group", enabled: true });
    // A title change (Telegram's), and the group becoming a supergroup, say nothing.
    await deliver({ message: tgMessage(chat, { chat: { id: chat, type: "supergroup", title: "Group 2" }, text: "hi" }) });
    await admin.collection("tg_links").update(link.id, { title: "Group" });
    const neu = newChat();
    await deliver({ message: tgMessage(neu, { from: { ...ann, id: 880_003 }, migrate_from_chat_id: chat }) });
    expect(await noticesOf(room.id)).toEqual([connected, disconnected, connected]);

    // Moved to another room: both say so. Deleted: its room says so.
    const other = await owner.pb.collection("rooms").create({ name: `tg-${uniq()}`, created_by: owner.user.id });
    await admin.collection("tg_links").update(link.id, { room: other.id });
    expect(await noticesOf(room.id)).toEqual([connected, disconnected, connected, disconnected]);
    await admin.collection("tg_links").delete(link.id);
    expect(await noticesOf(other.id)).toEqual([connected, disconnected]);

    // Not to Telegram, and not to an archived room.
    await tick();
    expect(stub.callsOf("sendMessage").filter((c) => [String(chat), String(neu)].includes(String(c.params.chat_id)))).toEqual([]);
    await owner.pb.collection("rooms").update(other.id, { archived: true });
    await admin.collection("tg_links").create({ chat_id: String(newChat()), title: "Late", room: other.id, enabled: true });
    expect(await noticesOf(other.id)).toEqual([connected, disconnected]);
  });

  it("a group that removes the bot is disconnected, and its room says why", async () => {
    for (const status of ["kicked", "left"]) {
      const owner = await signUp();
      const { room, chat } = await linkedRoom(owner);
      expect((await removeBot(chat, status)).status).toBe(200);
      await removeBot(chat, status); // said twice: told once
      const link = await admin.collection("tg_links").getFirstListItem(admin.filter("chat_id = {:c}", { c: String(chat) }));
      expect(link.enabled).toBe(false);
      expect(await noticesOf(room.id)).toEqual([
        'Telegram group "Group" was connected to this room.',
        'Telegram group "Group" was disconnected from this room: the bot was removed from the group.',
      ]);
    }
  });

  it("the same news at once tells the room once: the bot removed, a link unticked", async () => {
    const owner = await signUp();
    const { room, chat } = await linkedRoom(owner);
    await Promise.all([removeBot(chat), removeBot(chat), removeBot(chat)]);
    expect(await noticesOf(room.id)).toHaveLength(2); // connected, disconnected
    const { room: other, chat: otherChat } = await linkedRoom(owner);
    const link = await admin.collection("tg_links").getFirstListItem(admin.filter("chat_id = {:c}", { c: String(otherChat) }));
    await Promise.all([1, 2, 3].map(() => admin.collection("tg_links").update(link.id, { enabled: false })));
    expect(await noticesOf(other.id)).toHaveLength(2);
  });

  it("a group's title can't break or turn around the room's line; a blank one is left out", async () => {
    const owner = await signUp();
    const room = await owner.pb.collection("rooms").create({ name: `tg-${uniq()}`, created_by: owner.user.id });
    for (const title of ["x\u202Eevil\u202C\n\nreal admin says hi", "   ", "\u200b"]) {
      await admin.collection("tg_links").create({ chat_id: String(newChat()), title, room: room.id, enabled: true });
    }
    expect(await noticesOf(room.id)).toEqual([
      'Telegram group "xevil real admin says hi" was connected to this room.',
      "A Telegram group was connected to this room.",
      "A Telegram group was connected to this room.",
    ]);
  });

  it("a service message edited by a superuser isn't passed on either", async () => {
    const owner = await signUp();
    const { room } = await linkedRoom(owner);
    const [notice] = await admin.collection("messages").getFullList({ filter: admin.filter("room = {:r} && author = ''", { r: room.id }) });
    await admin.collection("messages").update(notice!.id, { text: "edited" });
    await admin.collection("messages").update(notice!.id, { deleted: true });
    expect(await admin.collection("tg_queue").getFullList({ filter: admin.filter("message = {:m}", { m: notice!.id }) })).toEqual([]);
  });

  it("a group that becomes a supergroup keeps its room, whichever notice of it comes first (QA BUG-89)", async () => {
    for (const newFirst of [false, true]) {
      const owner = await signUp();
      const { room, chat: old } = await linkedRoom(owner);
      const neu = newChat();
      const fromOld = { from: { ...ann, id: 880_002 } }; // a service message: no stand-in either (QA BUG-88)
      const inOld = { message: tgMessage(old, { ...fromOld, chat: { id: old, type: "group", title: "Group" }, migrate_to_chat_id: neu }) };
      const inNew = { message: tgMessage(neu, { ...fromOld, migrate_from_chat_id: old }) };
      for (const u of newFirst ? [inNew, inOld] : [inOld, inNew]) await deliver(u);
      await deliver({ message: tgMessage(neu, { text: `after, new first: ${newFirst}` }) });
      await eventually(async () => expect((await messagesOf(room.id)).map((m) => m.text)).toEqual([`after, new first: ${newFirst}`]));
      const links = await admin
        .collection("tg_links")
        .getFullList({ filter: admin.filter("chat_id = {:a} || chat_id = {:b}", { a: String(old), b: String(neu) }) });
      expect(links.map((l) => [l.chat_id, l.room, l.enabled])).toEqual([[String(neu), room.id, true]]);
    }
  });
});

describe("Telegram bridge without a webhook URL: polling, for development (§26.2)", () => {
  let polling: PocketBaseServer;
  let pollStub: TelegramStub;

  beforeAll(async () => {
    pollStub = await startTelegramStub();
    polling = await startPocketBase({ env: { TELEGRAM_BOT_TOKEN: pollStub.token, TELEGRAM_API_BASE: pollStub.url } });
  }, 60_000);

  afterAll(async () => {
    await polling?.stop();
    await pollStub?.close();
  });

  it("drops any webhook on start, answers no webhook calls, and gets updates by polling", async () => {
    expect(pollStub.callsOf("deleteWebhook")).toHaveLength(1);
    expect(pollStub.callsOf("setWebhook")).toHaveLength(0);
    const chat = newChat();
    pollStub.updates.push({ update_id: 1, message: tgMessage(chat, { text: "/chatid" }) });
    const su = new PocketBase(polling.url);
    await su.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
    const deadline = Date.now() + 8_000;
    while (!pollStub.callsOf("sendMessage").length && Date.now() < deadline) {
      await su.send("/api/telegram/tick", { method: "POST" });
      await sleep(100);
    }
    expect(pollStub.callsOf("sendMessage")[0]!.params.text).toContain(`Chat id: ${chat}`);
    // The next poll confirms the update, so Telegram doesn't send it again.
    const polls = pollStub.callsOf("getUpdates").length;
    while (pollStub.callsOf("getUpdates").length === polls && Date.now() < deadline) {
      await su.send("/api/telegram/tick", { method: "POST" });
      await sleep(100);
    }
    expect(pollStub.callsOf("getUpdates").at(-1)!.params.offset).toBe(2);
  });
});
