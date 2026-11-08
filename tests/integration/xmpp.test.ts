// XMPP bridge (§38), end to end against its own PocketBase and a stub child (tests/support/xmpp.ts): the hub plays the
// child's part, posting its events with its secret, and answers what PocketBase asks of it. The bridge's worker runs
// on a cron job and also on POST /api/xmpp/tick; checks wait for its work with `eventually`, since either may do it.

import { createServer, type Server } from "node:http";
import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG, pngFile } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { disableRateLimits, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";
import { startXmppStub, type XmppStub } from "../support/xmpp.ts";
import { status } from "./helpers.ts";

let stub: XmppStub;
let server: PocketBaseServer;
let admin: PocketBase;
/** Files people in conferences link to: an upload service's, at an address allowed for the tests. */
let files: Server;
let filesBase = "";

beforeAll(async () => {
  stub = await startXmppStub();
  files = createServer((req, res) => {
    if (req.url === "/up/k1/cat%20pic.png") {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    if (req.url === "/moved") {
      res.writeHead(302, { location: "/up/k1/cat%20pic.png" });
      return res.end();
    }
    if (req.url === "/big.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(Buffer.alloc(21 * 1024 * 1024));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => files.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${(files.address() as { port: number }).port}`;
  filesBase = `http://${host}`;
  server = await startPocketBase({
    fixtureRoute: true,
    env: {
      XMPP_JID: "bot@xmpp.example",
      XMPP_PASSWORD: "pw",
      CHIRKLE_XMPP_BIN: stub.bin,
      CHIRKLE_XMPP_STALE_MS: "3000",
      LINK_PREVIEWS_ALLOW_HOSTS: host,
    },
  });
  await disableRateLimits(server.url);
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
  await stub.waitForChild();
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await stub?.close();
  await new Promise((r) => files?.close(r));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => admin.send("/api/xmpp/tick", { method: "POST" }).catch(() => {});

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

const newMuc = () => `room-${uniq().toLowerCase()}@conference.xmpp.example`;

/** A room of `owner`, linked to a new conference, once the child has been told to join it. */
async function linkedRoom(owner: User, extra: Record<string, unknown> = {}) {
  const room = await owner.pb.collection("rooms").create({ name: `x-${uniq()}`, created_by: owner.user.id, ...extra });
  const muc = newMuc();
  const link = await admin.collection("xmpp_links").create({ muc, room: room.id, enabled: true });
  await eventually(() => expect(lastRooms().map((r) => r.muc)).toContain(muc));
  return { room, muc, link };
}

/** The conferences the child was last told to be in. */
const lastRooms = (): { muc: string; key: string; password: string; since: string }[] => stub.requestsTo("/rooms").at(-1)?.body.rooms ?? [];

let seq = 0;
/** A message in a conference, as the child posts it. */
const xmppMessage = (muc: string, fields: Record<string, unknown> = {}) =>
  stub.event({
    type: "message",
    muc,
    id: `m${++seq}`,
    stanza_id: `sid-${seq}`,
    nick: "Ann",
    occupant_id: "oid-ann",
    body: "hi",
    ...fields,
  });

/** A room's messages, but for service messages (§5.3): those are `noticesOf`. */
const messagesOf = (room: string) =>
  admin
    .collection("messages")
    .getFullList({ filter: admin.filter("room = {:room} && author != ''", { room }), sort: "created,id", expand: "author" });

const noticesOf = async (room: string) =>
  (
    await admin.collection("messages").getFullList({ filter: admin.filter("room = {:room} && author = ''", { room }), sort: "created" })
  ).map((m) => m.text);

/** What was sent to a conference, oldest first. */
const sentTo = (muc: string) => stub.requestsTo("/send").filter((r) => r.body.muc === muc);

describe("XMPP bridge (§38)", () => {
  it("starts the child, which posts to this server with its secret; a wrong secret is refused", async () => {
    const child = stub.children[0]!;
    expect(child.in).toBe(`${server.url}/api/xmpp/in`);
    expect(child.inAddr).toBe("");
    expect(child.jid).toBe("bot@xmpp.example");
    expect(await stub.event({ type: "status", connected: true, rooms: [] }, "wrong")).toBe(401);
    expect(await stub.event({ type: "status", connected: true, rooms: [] })).toBe(200);
  });

  it("links only rooms (not DMs), with an address, and only with a room; superusers only", async () => {
    const a = await signUp();
    const b = await signUp();
    const dm = await a.pb.send("/api/chat/dms", { method: "POST", body: { user: b.user.id } });
    expect(await status(admin.collection("xmpp_links").create({ muc: newMuc(), room: dm.id }))).toBe(400);
    expect(await status(admin.collection("xmpp_links").create({ muc: newMuc(), enabled: true }))).toBe(400);
    expect(await status(admin.collection("xmpp_links").create({ muc: "not an address" }))).toBe(400);
    for (const name of ["xmpp_links", "xmpp_people", "xmpp_messages", "xmpp_queue"])
      expect(await status(a.pb.collection(name).getList())).toBe(403);
  });

  it("a linked conference is joined with history since it was enabled; the room is told; statuses fill in the link", async () => {
    const owner = await signUp();
    const { room, muc, link } = await linkedRoom(owner);
    const wanted = lastRooms().find((r) => r.muc === muc)!;
    expect(new Date(wanted.since).getTime()).toBe(new Date(link.enabled_at).getTime());
    expect(await noticesOf(room.id)).toEqual([`XMPP conference "${muc}" was connected to this room.`]);

    stub.titles.set(muc, "Friends");
    const noted = await eventually(async () => {
      const l = await admin.collection("xmpp_links").getOne(link.id);
      expect(l).toMatchObject({ status: "joined as Chirkle", title: "Friends" });
      return l;
    });
    // Written without saving the record: the child isn't told to join again.
    expect(noted.updated).toBe(link.updated);
    const asked = stub.requestsTo("/rooms").length;
    await tick();
    expect(stub.requestsTo("/rooms").length).toBe(asked);

    // Saving the link (a new password) tells it again; unlinking leaves it.
    await admin.collection("xmpp_links").update(link.id, { password: "s3cret" });
    await eventually(() => expect(lastRooms().find((r) => r.muc === muc)?.password).toBe("s3cret"));
    await admin.collection("xmpp_links").update(link.id, { enabled: false });
    await eventually(() => expect(lastRooms().map((r) => r.muc)).not.toContain(muc));
    expect((await noticesOf(room.id)).at(-1)).toBe(`XMPP conference "Friends" was disconnected from this room.`);
  });

  it("a conference's message shows under its sender's stand-in, once; stand-ins take no DMs and aren't sent back", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    expect(await xmppMessage(muc, { body: "hello from xmpp", stanza_id: "dup-1" })).toBe(200);
    await xmppMessage(muc, { body: "hello from xmpp", stanza_id: "dup-1" }); // sent again
    const list = await messagesOf(room.id);
    expect(list.map((m) => m.text)).toEqual(["hello from xmpp"]);
    const author = list[0]!.expand!.author;
    expect(author.name).toBe("Ann (XMPP)");
    expect(author.no_dms).toBe(true);
    expect(author.email).toMatch(/@xmpp\.invalid$/); // nobody gets mail there, so nobody can log in as them
    expect(await status(owner.pb.send("/api/chat/dms", { method: "POST", body: { user: author.id } }))).toBe(400);

    // The same occupant id is the same person, whatever the nickname; a new nickname renames the stand-in.
    await xmppMessage(muc, { body: "again", nick: "Annie" });
    const again = await messagesOf(room.id);
    expect(again.map((m) => m.expand!.author.id)).toEqual([author.id, author.id]);
    expect(again[1]!.expand!.author.name).toBe("Annie (XMPP)");

    // Someone the conference hides (no occupant id, no address) is known by their nickname; a rename follows them.
    await xmppMessage(muc, { body: "who am I", nick: "Ghost", occupant_id: "" });
    await stub.event({ type: "occupant", muc, nick: "Ghost", new_nick: "Phantom" });
    await xmppMessage(muc, { body: "still me", nick: "Phantom", occupant_id: "" });
    const ghosts = (await messagesOf(room.id)).slice(2).map((m) => m.expand!.author);
    expect(ghosts[0]!.id).toBe(ghosts[1]!.id);
    expect(ghosts[1]!.name).toBe("Phantom (XMPP)");

    await tick();
    expect(sentTo(muc)).toEqual([]);
  });

  it("a long message comes over as several; history from before the link is left out", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    const long = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
    await xmppMessage(muc, { body: long });
    await xmppMessage(muc, { body: "from before", delay: "2020-01-01T00:00:00Z" });
    const texts = (await messagesOf(room.id)).map((m) => m.text);
    expect(texts).toEqual(["a".repeat(1500), "b".repeat(1500)]);
  });

  it("a chat message goes to the conference as the bot, 'Name: text'; its echo isn't brought back", async () => {
    const owner = await signUp(`Bob-${uniq()}`);
    const { room, muc } = await linkedRoom(owner);
    const msg = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "hi there" });
    const [sent] = await eventually(() => {
      const s = sentTo(muc);
      expect(s).toHaveLength(1);
      return s;
    });
    expect(sent!.body).toEqual({ muc, id: msg.id, body: `${owner.user.name}: hi there` });

    // The conference sends it back to everyone, the bot too: noted as ours, not posted again.
    await stub.event({
      type: "message",
      muc,
      id: msg.id,
      origin_id: msg.id,
      stanza_id: "echo-1",
      nick: "Chirkle",
      self: true,
      body: sent!.body.body,
    });
    expect((await messagesOf(room.id)).map((m) => m.id)).toEqual([msg.id]);
    const row = await admin.collection("xmpp_messages").getFirstListItem(admin.filter("message = {:m}", { m: msg.id }));
    expect(row).toMatchObject({ direction: "out", xmpp_id: `o:${msg.id}`, stanza_id: "echo-1" });
    // Ours from before (in history) isn't brought over either.
    await stub.event({ type: "message", muc, id: "old", stanza_id: "echo-0", nick: "Chirkle", self: true, body: "x: old" });
    expect(await messagesOf(room.id)).toHaveLength(1);
  });

  it("an anonymous link sends the text alone; files go as uploads, else as links at the App URL", async () => {
    const owner = await signUp();
    const { room, muc, link } = await linkedRoom(owner);
    await admin.collection("xmpp_links").update(link.id, { anonymous: true });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "no name" });
    await eventually(() => expect(sentTo(muc).map((r) => r.body.body)).toEqual(["no name"]));
    await admin.collection("xmpp_links").update(link.id, { anonymous: false });

    // Uploaded: the text, then each file as its own message, its link in OOB. The child read it from PocketBase.
    stub.uploads = "ok";
    try {
      const m = await owner.pb.collection("messages").create({
        room: room.id,
        author: owner.user.id,
        text: "look",
        files: [pngFile("cat.png"), pngFile("dog.png")],
      });
      await eventually(() => expect(sentTo(muc)).toHaveLength(4));
      const sent = sentTo(muc)
        .slice(1)
        .map((r) => r.body);
      expect(sent).toEqual([
        { muc, id: m.id, body: `${owner.user.name}: look` },
        { muc, id: `${m.id}-f1`, body: "https://upload.xmpp.example/cat.png", oob: "https://upload.xmpp.example/cat.png" },
        { muc, id: `${m.id}-f2`, body: "https://upload.xmpp.example/dog.png", oob: "https://upload.xmpp.example/dog.png" },
      ]);
      expect(stub.uploaded.get("https://upload.xmpp.example/cat.png")).toEqual(Buffer.from(PNG));
      // Deleted: each stanza retracted.
      await owner.pb.collection("messages").update(m.id, { deleted: true });
      await eventually(() =>
        expect(
          sentTo(muc)
            .filter((r) => r.body.retract)
            .map((r) => r.body.retract.origin_id)
            .sort(),
        ).toEqual([m.id, `${m.id}-f1`, `${m.id}-f2`].sort()),
      );
    } finally {
      stub.uploads = "unsupported";
    }

    // No uploads: the App URL's link. A file alone says whose it is.
    await admin.settings.update({ meta: { appURL: "https://chat.example/" } });
    try {
      const before = sentTo(muc).length;
      const m = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, files: [pngFile("cat.png")] });
      const [stored] = m.files as string[];
      const url = `https://chat.example/api/files/messages/${m.id}/${stored}`;
      await eventually(() => expect(sentTo(muc).length).toBe(before + 2));
      expect(
        sentTo(muc)
          .slice(before)
          .map((r) => r.body),
      ).toEqual([
        { muc, id: m.id, body: `${owner.user.name}: [cat.png]` },
        { muc, id: `${m.id}-f1`, body: url, oob: url },
      ]);
    } finally {
      await admin.settings.update({ meta: { appURL: "http://localhost:8090" } });
    }
  });

  it("a file's link from a conference brings the file; one that can't be fetched stays a link; encrypted ones say so", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    const link = (url: string) => xmppMessage(muc, { body: url, oob: [url] });
    await link(`${filesBase}/up/k1/cat%20pic.png`);
    await link(`${filesBase}/moved`); // a redirect, followed
    await link(`${filesBase}/big.bin`); // over 20 MB
    await link(`${filesBase}/missing`);
    await link("http://127.0.0.1:1/x.png"); // not a public address
    await xmppMessage(muc, { body: `see ${filesBase}/up/k1/cat%20pic.png`, oob: [`${filesBase}/up/k1/cat%20pic.png`] }); // text, not just the link
    await xmppMessage(muc, { body: "I sent you an OMEMO encrypted message", encrypted: true });
    const list = await messagesOf(room.id);
    expect(list.map((m) => [m.text, (m.files as string[]).length])).toEqual([
      ["", 1],
      ["", 1],
      [`${filesBase}/big.bin`, 0],
      [`${filesBase}/missing`, 0],
      ["http://127.0.0.1:1/x.png", 0],
      [`see ${filesBase}/up/k1/cat%20pic.png`, 0],
      ["🔒 An encrypted message", 0],
    ]);
    expect(JSON.parse(JSON.stringify(list[0]!.file_names))).toEqual({ [(list[0]!.files as string[])[0]!]: "cat pic.png" });
    expect((list[0]!.files as string[])[0]).toMatch(/^cat_pic_[a-z0-9]{10}\.png$/);
    const res = await fetch(`${server.url}/api/files/messages/${list[0]!.id}/${(list[0]!.files as string[])[0]}`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from(PNG));
  });

  it("a room's two conferences each get what came from the other, never their own", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    const other = newMuc();
    await admin.collection("xmpp_links").create({ muc: other, room: room.id, enabled: true });
    await eventually(() => expect(lastRooms().map((r) => r.muc)).toContain(other));
    await xmppMessage(muc, { body: "from the first" });
    // Occupant ids are per conference: this Ann is a stand-in of her own ("Ann 2 (XMPP)"…).
    await eventually(() =>
      expect(sentTo(other).map((r) => r.body.body)).toEqual([expect.stringMatching(/^Ann( \d+)? \(XMPP\): from the first$/)]),
    );
    expect(sentTo(muc)).toEqual([]);
  });

  it("a send that fails for now is tried again, in order; one refused for good is dropped", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    stub.fail("/send", 503, { error: "not in the conference", transient: true });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "one" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "two" });
    await eventually(() => expect(sentTo(muc).map((r) => r.body.body.split(": ")[1])).toEqual(["one", "one", "two"]), 15_000);

    stub.fail("/send", 400, { error: "not a linked conference", transient: false });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "three" });
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "four" });
    await eventually(() =>
      expect(
        sentTo(muc)
          .map((r) => r.body.body.split(": ")[1])
          .slice(3),
      ).toEqual(["three", "four"]),
    );
    await eventually(async () => expect(await admin.collection("xmpp_queue").getFullList()).toEqual([]));
  });

  it("kicked, the link is disabled and the room told why; an invitation makes a link to fill in", async () => {
    const owner = await signUp();
    const { room, muc, link } = await linkedRoom(owner);
    await stub.event({ type: "kicked", muc, reason: "banned" });
    await stub.event({ type: "kicked", muc, reason: "banned" }); // told twice: said once
    expect(await admin.collection("xmpp_links").getOne(link.id)).toMatchObject({ enabled: false, status: "removed: banned" });
    expect((await noticesOf(room.id)).slice(1)).toEqual([
      `XMPP conference "${muc}" was disconnected from this room: the bot was banned from the conference.`,
    ]);
    await xmppMessage(muc, { body: "after" });
    expect(await messagesOf(room.id)).toEqual([]);

    const invited = newMuc();
    await stub.event({ type: "invite", muc: invited, from: "ann@xmpp.example", password: "pw" });
    const made = await admin.collection("xmpp_links").getFirstListItem(admin.filter("muc = {:m}", { m: invited }));
    expect(made).toMatchObject({ enabled: false, room: "", password: "pw" });
  });

  it("replies, corrections and retractions come over; only their authors' (or a moderator's) count", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    await xmppMessage(muc, { id: "q1", stanza_id: "sq1", body: "what time?" });
    const [question] = await messagesOf(room.id);

    // A reply to a message the bridge knows: without the quote over it. To one it doesn't: with it.
    await xmppMessage(muc, { body: "> what time?\nnoon", reply_id: "sq1", reply_to: "Ann", reply_body: "noon" });
    await xmppMessage(muc, { body: "> who knows\nme", reply_id: "nope", reply_body: "me" });
    let list = await messagesOf(room.id);
    expect(list.slice(1).map((m) => [m.text, m.reply_to])).toEqual([
      ["noon", question!.id],
      ["> who knows\nme", ""],
    ]);

    // A correction names the sender's own id; someone else's correction does nothing.
    await xmppMessage(muc, { id: "c1", stanza_id: "sc1", replace: "q1", body: "what time, tomorrow?" });
    await xmppMessage(muc, { id: "c2", stanza_id: "sc2", replace: "q1", body: "hijacked", nick: "Eve", occupant_id: "oid-eve" });
    expect((await admin.collection("messages").getOne(question!.id)).text).toBe("what time, tomorrow?");
    // A longer correction adds parts; a shorter one takes them away.
    await xmppMessage(muc, { id: "c3", stanza_id: "sc3", replace: "q1", body: `${"x".repeat(1500)}\n${"y".repeat(1500)}` });
    list = await messagesOf(room.id);
    expect(list.map((m) => m.text)).toContain("y".repeat(1500));
    await xmppMessage(muc, { id: "c4", stanza_id: "sc4", replace: "q1", body: "short" });
    list = await messagesOf(room.id);
    expect(list.filter((m) => !m.deleted).map((m) => m.text)).toEqual(["short", "noon", "> who knows\nme"]);

    // Retractions: by someone else, nothing; by the author (by stanza id), deleted; by a moderator, deleted.
    await stub.event({ type: "retraction", muc, nick: "Eve", occupant_id: "oid-eve", target: "sq1" });
    expect((await admin.collection("messages").getOne(question!.id)).deleted).toBe(false);
    await stub.event({ type: "retraction", muc, nick: "Ann", occupant_id: "oid-ann", target: "sq1" });
    expect((await admin.collection("messages").getOne(question!.id)).deleted).toBe(true);
    await stub.event({ type: "retraction", muc, nick: "", target: "nope", moderated: true });
    const noon = list.find((m) => m.text === "noon")!;
    const row = await admin.collection("xmpp_messages").getFirstListItem(admin.filter("message = {:m}", { m: noon.id }));
    await stub.event({ type: "retraction", muc, nick: "", target: row.stanza_id, moderated: true });
    expect((await admin.collection("messages").getOne(noon.id)).deleted).toBe(true);
  });

  it("replies, edits and deletes go out: XEP-0461 with a quote, corrections, retractions; not for what came from there", async () => {
    const owner = await signUp(`Bob-${uniq()}`);
    const { room, muc } = await linkedRoom(owner);
    await xmppMessage(muc, { id: "a1", stanza_id: "sa1", body: "lunch?" });
    const [lunch] = await messagesOf(room.id);

    const answer = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: "yes", reply_to: lunch!.id });
    const [sent] = await eventually(() => {
      const s = sentTo(muc);
      expect(s).toHaveLength(1);
      return s;
    });
    const quote = "> lunch?\n";
    expect(sent!.body).toEqual({
      muc,
      id: answer.id,
      body: `${quote}${owner.user.name}: yes`,
      reply: { id: "sa1", to: "Ann", end: [...quote].length },
    });
    await stub.event({
      type: "message",
      muc,
      id: answer.id,
      origin_id: answer.id,
      stanza_id: "sb1",
      nick: "Chirkle",
      self: true,
      body: sent!.body.body,
    });

    // Edited: a correction of it, with its reply again, under an id of its own.
    await owner.pb.collection("messages").update(answer.id, { text: "yes, at noon" });
    const fix = await eventually(() => {
      const s = sentTo(muc);
      expect(s).toHaveLength(2);
      return s[1]!.body;
    });
    expect(fix).toMatchObject({ muc, replace: answer.id, body: `${quote}${owner.user.name}: yes, at noon`, reply: { id: "sa1" } });
    expect(fix.id).not.toBe(answer.id);
    // The correction's echo isn't brought back.
    await stub.event({
      type: "message",
      muc,
      id: fix.id,
      origin_id: fix.id,
      nick: "Chirkle",
      self: true,
      replace: answer.id,
      body: fix.body,
    });

    // A reply to the bot's own message names the stanza id the echo brought.
    const more = await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: "or 1pm", reply_to: answer.id });
    await eventually(() => expect(sentTo(muc).at(-1)!.body).toMatchObject({ id: more.id, reply: { id: "sb1", to: "" } }));

    // Deleted: retracted, by both ids.
    await owner.pb.collection("messages").update(answer.id, { deleted: true });
    const gone = await eventually(() => {
      const r = sentTo(muc).find((x) => x.body.retract);
      expect(r).toBeTruthy();
      return r!.body;
    });
    expect(gone.retract).toEqual({ stanza_id: "sb1", origin_id: answer.id });
    // An XMPP person's message deleted in the room (a moderator, §36) isn't retracted on their behalf.
    const before = sentTo(muc).length;
    await admin.collection("messages").update(lunch!.id, { deleted: true });
    await tick();
    await tick();
    expect(sentTo(muc).length).toBe(before);
    expect((await messagesOf(room.id)).filter((m) => !m.deleted).map((m) => m.text)).toEqual(["or 1pm"]);
  });

  it("reactions come over as each person's whole set; the bot's set goes out, without the conference's own people's", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    await xmppMessage(muc, { id: "p1", stanza_id: "sp1", body: "party?" });
    const [party] = await messagesOf(room.id);
    const reactions = async () =>
      ((await admin.collection("messages").getOne(party!.id)).reactions as { emoji: string; users: string[] }[]).map((r) => [
        r.emoji,
        r.users.length,
      ]);

    // Ann's set; Bob's, with one the picker hasn't got ("❤" is "❤️"; "🫠" has no near one).
    await stub.event({ type: "reactions", muc, nick: "Ann", occupant_id: "oid-ann", target: "sp1", emoji: ["👍", "🎉"] });
    await stub.event({ type: "reactions", muc, nick: "Bob", occupant_id: "oid-bob", target: "sp1", emoji: ["❤", "👍", "🫠"] });
    expect(await reactions()).toEqual([
      ["👍", 2],
      ["🎉", 1],
      ["❤️", 1],
    ]);
    // Ann's new set takes 🎉 back; none takes all of Bob's back. Eve's none makes no stand-in.
    await stub.event({ type: "reactions", muc, nick: "Ann", occupant_id: "oid-ann", target: "sp1", emoji: ["👍"] });
    await stub.event({ type: "reactions", muc, nick: "Bob", occupant_id: "oid-bob", target: "sp1" });
    await stub.event({ type: "reactions", muc, nick: "Eve", occupant_id: "oid-eve", target: "sp1" });
    expect(await reactions()).toEqual([["👍", 1]]);
    expect((await admin.collection("users").getFullList({ filter: 'name ~ "Eve"' })).length).toBe(0);
    // The conference's people's reactions are theirs already: the bot sends none for them.
    await tick();
    await tick();
    expect(sentTo(muc).filter((r) => r.body.react)).toEqual([]);

    // The owner reacts: the bot's set is theirs; taken back, none.
    await owner.pb.send("/api/chat/reactions", { method: "POST", body: { message: party!.id, emoji: "🔥", on: true } });
    await eventually(() =>
      expect(
        sentTo(muc)
          .filter((r) => r.body.react)
          .at(-1)?.body.react,
      ).toEqual({ id: "sp1", emoji: ["🔥"] }),
    );
    await owner.pb.send("/api/chat/reactions", { method: "POST", body: { message: party!.id, emoji: "🔥", on: false } });
    await eventually(() =>
      expect(
        sentTo(muc)
          .filter((r) => r.body.react)
          .at(-1)?.body.react,
      ).toEqual({ id: "sp1", emoji: [] }),
    );
    // The bot's own, as the conference sends them back, change nothing.
    await stub.event({ type: "reactions", muc, nick: "Chirkle", self: true, target: "sp1", emoji: ["🔥"] });
    expect(await reactions()).toEqual([["👍", 1]]);
  });

  it("a room moderator's delete of an XMPP person's message is moderated there; their own retraction isn't sent back", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    await xmppMessage(muc, { id: "s1", stanza_id: "ss1", body: "spam" });
    await xmppMessage(muc, { id: "s2", stanza_id: "ss2", body: "oops" });
    await xmppMessage(muc, { id: "s3", stanza_id: "ss3", body: "more spam" });
    const [spam, oops, more] = await messagesOf(room.id);
    const moderated = () => stub.requestsTo("/moderate").filter((r) => r.body.muc === muc);

    await admin.collection("messages").update(spam!.id, { deleted: true });
    await eventually(() => expect(moderated().map((r) => r.body.id)).toEqual(["ss1"]));

    // Retracted by its author: deleted in the room, and not moderated in turn.
    await stub.event({ type: "retraction", muc, nick: "Ann", occupant_id: "oid-ann", target: "ss2" });
    expect((await admin.collection("messages").getOne(oops!.id)).deleted).toBe(true);
    // Not a moderator there: deleted in the room only, and not tried again.
    stub.fail("/moderate", 400, { error: "the bot isn't a moderator there", transient: false });
    await admin.collection("messages").update(more!.id, { deleted: true });
    await eventually(() => expect(moderated().map((r) => r.body.id)).toEqual(["ss1", "ss3"]));
    await tick();
    await tick();
    expect(moderated().map((r) => r.body.id)).toEqual(["ss1", "ss3"]);
    expect((await admin.collection("xmpp_queue").getFullList({ filter: admin.filter("muc = {:muc}", { muc }) })).length).toBe(0);
  });

  it("a stand-in gets its vCard photo as its avatar: when made, and when the hash changes, at most once a day", async () => {
    const owner = await signUp();
    const { room, muc } = await linkedRoom(owner);
    stub.photos.set("Pat", { type: "image/png", data: PNG });
    try {
      await xmppMessage(muc, { nick: "Pat", occupant_id: "oid-pat", body: "hello" });
      const [hello] = await messagesOf(room.id);
      const user = () => admin.collection("users").getOne(hello!.author);
      await eventually(async () => expect((await user()).avatar).toMatch(/^avatar_\w+\.png$/));
      const avatarRequests = () => stub.requestsTo("/avatar").filter((r) => r.body.nick === "Pat");
      expect(avatarRequests()).toHaveLength(1);

      // A new hash within the day: not fetched again.
      await stub.event({ type: "photo", muc, nick: "Pat", occupant_id: "oid-pat", hash: "abc" });
      await tick();
      expect(avatarRequests()).toHaveLength(1);
      // A day later, it is; none takes the avatar away.
      const person = await admin.collection("xmpp_people").getFirstListItem(admin.filter("user = {:u}", { u: hello!.author }));
      await admin.collection("xmpp_people").update(person.id, { avatar_at: "2020-01-01 00:00:00.000Z" });
      await stub.event({ type: "photo", muc, nick: "Pat", occupant_id: "oid-pat", hash: "abc" });
      await eventually(() => expect(avatarRequests()).toHaveLength(2));
      expect((await admin.collection("xmpp_people").getOne(person.id)).avatar_hash).toBe("abc");
      // The same hash again: nothing to fetch, whatever the day.
      await admin.collection("xmpp_people").update(person.id, { avatar_at: "2020-01-01 00:00:00.000Z" });
      await stub.event({ type: "photo", muc, nick: "Pat", occupant_id: "oid-pat", hash: "abc" });
      await tick();
      expect(avatarRequests()).toHaveLength(2);
      await stub.event({ type: "photo", muc, nick: "Pat", occupant_id: "oid-pat", hash: "" });
      expect((await user()).avatar).toBe("");
    } finally {
      stub.photos.delete("Pat");
    }
  });

  it("names ending in (XMPP) are the stand-ins'", async () => {
    const u = await signUp();
    expect(await status(u.pb.collection("users").update(u.user.id, { name: "Mallory (xmpp)" }))).toBe(400);
  });

  it("a child that goes quiet is started again, with a new secret; the old one's is refused", async () => {
    const before = stub.children.length;
    const old = stub.children.at(-1)!;
    stub.quiet = true;
    try {
      // The worker restarts it: on its cron job, or here, ticked meanwhile.
      const fresh = await eventually(() => {
        expect(stub.children.length).toBeGreaterThan(before);
        return stub.waitForChild(before + 1, 5_000);
      }, 30_000);
      expect(fresh.secret).not.toBe(old.secret);
    } finally {
      stub.quiet = false;
    }
    expect(await stub.event({ type: "status", connected: true, rooms: [] }, old.secret)).toBe(401);
    // The new one is told the conferences again.
    const owner = await signUp();
    await linkedRoom(owner);
    expect(stub.requestsTo("/rooms").at(-1)!.pid).toBe(stub.children.at(-1)!.pid);
  }, 45_000);
});
