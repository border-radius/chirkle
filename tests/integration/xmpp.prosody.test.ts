// XMPP bridge (§38) against a real XMPP server: PocketBase runs the real child (xmpp-bridge/), and people in the
// conference are xmpp-person processes (xmpp-bridge/cmd/xmpp-person) logged in as their own accounts. Skipped unless
// XMPP_PROSODY names the server (host:port of a Prosody 13 set up as docs/DESIGN.md §38.20 says: the domain
// "localhost", conference.localhost with muc_mam and muc_moderation, upload.localhost:5281 for HTTP upload, and the
// accounts bot, ann and bob with the password "pw"), with XMPP_PROSODY_CA the CA file its certificates are signed by.

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PocketBase, { type RecordModel } from "pocketbase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG, PNG_BASE64, pngFile } from "../support/files.ts";
import { uniq } from "../support/ids.ts";
import { withName } from "../support/names.ts";
import { disableRateLimits, freePort, type PocketBaseServer, SUPERUSER, startPocketBase } from "../support/pocketbase.ts";

const SERVER = process.env.XMPP_PROSODY ?? "";
const CA = process.env.XMPP_PROSODY_CA ?? "";
/** A command that restarts the server (optional: the test of that is skipped without it). */
const RESTART = process.env.XMPP_PROSODY_RESTART ?? "";
/** A command that reads Prosody admin shell commands on its standard input (optional, as RESTART). */
const SHELL = process.env.XMPP_PROSODY_SHELL ?? "";
const DOMAIN = "localhost";
const MUCS = `conference.${DOMAIN}`;
const UPLOAD_HOST = `upload.${DOMAIN}:5281`;
const ROOT = join(import.meta.dirname, "..", "..");

let server: PocketBaseServer;
let admin: PocketBase;
let personBin = "";
/** Temp dirs of ours: the person tool's build, and PocketBase's data (kept across its restarts). */
const tempDirs: string[] = [];
/** How PocketBase is started: the same data and port each time, so a test can restart it. */
let startOpts: Parameters<typeof startPocketBase>[0];
const people: Person[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => admin.send("/api/xmpp/tick", { method: "POST" }).catch(() => {});

/** Wait (up to `ms`) until `fn` passes, running the worker meanwhile. */
async function eventually<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await tick();
      await sleep(150);
    }
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const unesc = (s: string) =>
  s
    .replace(/&#xA;/g, "\n")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");

/** An attribute of the first `el` element in a stanza (as the person printed it). */
function attr(xml: string, el: string, name: string): string {
  const m = new RegExp(`<${el}\\b[^>]*?\\s${name}="([^"]*)"`).exec(xml);
  return m ? unesc(m[1]!) : "";
}
/** The text of the first `el` element. */
function text(xml: string, el: string): string {
  const m = new RegExp(`<${el}\\b[^>]*>([\\s\\S]*?)</${el}>`).exec(xml);
  return m ? unesc(m[1]!) : "";
}

/** Someone in a conference: an XMPP account of their own, logged in. */
class Person {
  readonly lines: string[] = [];
  private buf = "";
  jid = "";
  readonly user: string;
  private readonly proc: ChildProcessWithoutNullStreams;
  private constructor(user: string, proc: ChildProcessWithoutNullStreams) {
    this.user = user;
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i = this.buf.indexOf("\n");
      while (i >= 0) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        i = this.buf.indexOf("\n");
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d: string) => process.stderr.write(`[${user}] ${d}`));
  }

  static async login(user: string): Promise<Person> {
    const proc = spawn(personBin, ["-jid", `${user}@${DOMAIN}`, "-password", "pw", "-server", SERVER], {
      env: { ...process.env, SSL_CERT_FILE: CA },
    });
    const p = new Person(user, proc);
    people.push(p);
    const online = await p.waitFor((l) => l.startsWith("online "));
    p.jid = online.slice("online ".length);
    return p;
  }

  send(xml: string) {
    this.proc.stdin.write(`${xml.replace(/\n/g, "&#xA;")}\n`);
  }

  /** The first stanza (from `from` on) that passes, waiting up to `ms` for it. */
  async waitFor(pred: (l: string) => boolean, ms = 15_000, from = 0): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.lines.slice(from).find(pred);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`${this.user}: nothing like that in ${ms} ms; last: ${this.lines.slice(-5).join("\n")}`);
      await tick();
      await sleep(100);
    }
  }

  /** Join a conference as `nick`, without history; resolves on the self-presence. */
  async join(muc: string, nick: string, extra = "") {
    const from = this.lines.length;
    this.send(
      `<presence to='${muc}/${esc(nick)}'><x xmlns='http://jabber.org/protocol/muc'><history maxstanzas='0'/>${extra}</x></presence>`,
    );
    const self = await this.waitFor(
      (l) => l.startsWith("<presence") && l.includes(`from="${muc}/${nick}"`) && l.includes('code="110"'),
      15_000,
      from,
    );
    // Made it: a new room is locked until its owner configures it; the default configuration (an instant room).
    if (self.includes('code="201"')) {
      const r = await this.iq(
        muc,
        "set",
        `<query xmlns='http://jabber.org/protocol/muc#owner'><x xmlns='jabber:x:data' type='submit'/></query>`,
      );
      expect(attr(r, "iq", "type")).toBe("result");
    }
    return self;
  }

  /** A groupchat message; returns its id. */
  say(muc: string, body: string, inner = "", id = `p-${uniq()}`) {
    this.send(`<message to='${muc}' type='groupchat' id='${id}'><body>${esc(body)}</body>${inner}</message>`);
    return id;
  }

  /** The conference's copy of a message this person sent (by its id): its stanza-id. */
  async stanzaIdOf(id: string) {
    const echo = await this.waitFor((l) => l.startsWith("<message") && attr(l, "message", "id") === id);
    return attr(echo, "stanza-id", "id");
  }

  /** A message from the bot (its nick in `muc`) whose body passes. */
  fromBot(muc: string, pred: (body: string, l: string) => boolean, ms?: number) {
    return this.waitFor((l) => l.startsWith("<message") && l.includes(`from="${muc}/Chirkle"`) && pred(text(l, "body"), l), ms);
  }

  /** An IQ, answered: the result (or error) stanza. */
  async iq(to: string, type: "get" | "set", payload: string) {
    const id = `iq-${uniq()}`;
    const from = this.lines.length;
    this.send(`<iq to='${to}' type='${type}' id='${id}'>${payload}</iq>`);
    return this.waitFor((l) => l.startsWith("<iq") && attr(l, "iq", "id") === id, 15_000, from);
  }

  close() {
    this.proc.stdin.end();
  }
}

beforeAll(async () => {
  if (!SERVER) return;
  // The child as built from this tree, and the person tool.
  execFileSync(process.execPath, ["scripts/build-xmpp.mjs"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  const bin = execFileSync(process.execPath, ["-e", 'import("./scripts/build-xmpp.mjs").then(m => console.log(m.binary()))'], { cwd: ROOT })
    .toString()
    .trim();
  const personDir = mkdtempSync(join(tmpdir(), "xmpp-person-"));
  const dataParent = mkdtempSync(join(tmpdir(), "chirkle-xmpp-real-"));
  tempDirs.push(personDir, dataParent);
  personBin = join(personDir, "xmpp-person");
  execFileSync("go", ["build", "-o", personBin, "./cmd/xmpp-person"], { cwd: join(ROOT, "xmpp-bridge"), stdio: "inherit" });
  startOpts = {
    fixtureRoute: true,
    dataDir: join(dataParent, "pb_data"),
    port: await freePort(),
    env: {
      XMPP_JID: `bot@${DOMAIN}`,
      XMPP_PASSWORD: "pw",
      XMPP_SERVER: SERVER,
      CHIRKLE_XMPP_BIN: bin,
      SSL_CERT_FILE: CA,
      LINK_PREVIEWS_ALLOW_HOSTS: UPLOAD_HOST,
    },
  };
  await startServer();
}, 180_000);

async function startServer() {
  server = await startPocketBase(startOpts);
  await disableRateLimits(server.url);
  admin = new PocketBase(server.url);
  admin.autoCancellation(false);
  await admin.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
}

afterAll(async () => {
  for (const p of people) p.close();
  await server?.stop();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

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

const newMuc = () => `r-${uniq().toLowerCase()}@${MUCS}`;

/** A conference Ann made (its owner), linked to a new room of `owner`'s, once the bot is in it. */
async function linked(owner: User, ann: Person, opts: { linkExtra?: Record<string, unknown>; botAdmin?: boolean } = {}) {
  const muc = newMuc();
  await ann.join(muc, "Ann");
  if (opts.botAdmin) await makeAdmin(ann, muc, `bot@${DOMAIN}`);
  const room = await owner.pb.collection("rooms").create({ name: `x-${uniq()}`, created_by: owner.user.id });
  const link = await admin.collection("xmpp_links").create({ muc, room: room.id, enabled: true, ...opts.linkExtra });
  await ann.waitFor((l) => l.startsWith("<presence") && l.includes(`from="${muc}/Chirkle"`), 30_000);
  await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toBe("joined as Chirkle"), 30_000);
  return { muc, room, link };
}

async function makeAdmin(owner: Person, muc: string, jid: string) {
  const r = await owner.iq(
    muc,
    "set",
    `<query xmlns='http://jabber.org/protocol/muc#admin'><item affiliation='admin' jid='${jid}'/></query>`,
  );
  expect(attr(r, "iq", "type")).toBe("result");
}

/** A room's messages, but for service messages. */
const messagesOf = (room: string) =>
  admin
    .collection("messages")
    .getFullList({ filter: admin.filter("room = {:room} && author != ''", { room }), sort: "created,id", expand: "author" });

/** The room's message whose text is `t`, once it is there. */
const messageWith = (room: string, t: string, ms?: number) =>
  eventually(async () => {
    const m = (await messagesOf(room)).find((x) => x.text === t);
    expect(m, `a message "${t}"`).toBeDefined();
    return m!;
  }, ms);

describe.skipIf(!SERVER)("XMPP bridge against Prosody (§38)", { timeout: 120_000 }, () => {
  let ann: Person;
  let bob: Person;

  beforeAll(async () => {
    if (!SERVER) return;
    ann = await Person.login("ann");
    bob = await Person.login("bob");
  }, 60_000);

  it("joins a linked conference, and messages go both ways once each, with markup kept as text", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const hello = `hello <b>&amp; "quotes" 👋\nsecond line ${uniq()}`;
    ann.say(muc, hello);
    const m = await messageWith(room.id, hello);
    expect(m.expand?.author.name).toMatch(/^Ann( \d+)? \(XMPP\)$/);
    await sleep(1500);
    expect((await messagesOf(room.id)).filter((x) => x.text === hello)).toHaveLength(1);

    const back = `from chirkle <i>&lt; ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: back });
    const got = await ann.fromBot(muc, (b) => b.includes(back));
    expect(text(got, "body")).toBe(`Olga: ${back}`);
    // The bot's own message, as the conference sends it back, isn't brought in again.
    await sleep(1500);
    expect((await messagesOf(room.id)).map((x) => x.text)).toEqual([hello, back]);
  });

  it("replies both ways: XEP-0461 with fallbacks, emoji counted in code points", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const q = `🎉🎉 party at 8? ${uniq()}`;
    const qid = ann.say(muc, q);
    const qsid = await ann.stanzaIdOf(qid);
    const question = await messageWith(room.id, q);

    // Chirkle → XMPP: a reply to Ann's message, by its stanza id, the quote marked as a fallback.
    const yes = `yes 🥳 ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: yes, reply_to: question.id });
    const reply = await ann.fromBot(muc, (b) => b.endsWith(yes));
    expect(attr(reply, "reply", "id")).toBe(qsid);
    expect(attr(reply, "reply", "to")).toBe(`${muc}/Ann`);
    const body = text(reply, "body");
    const end = Number(attr(reply, "body", "end") || attr(reply, "fallback", "end") || /<body[^>]*end="(\d+)"/.exec(reply)?.[1]);
    expect([...body].slice(0, end).join("")).toMatch(/^> .*party at 8\?.*\n$/s);
    expect([...body].slice(end).join("")).toBe(`Olga: ${yes}`);

    // XMPP → Chirkle: Bob replies to the bot's message, with a fallback quote that is cut away.
    await bob.join(muc, "Bob");
    const botMsg = await ann.fromBot(muc, (b) => b.endsWith(yes));
    const botSid = attr(botMsg, "stanza-id", "id");
    const quote = `> Olga: ${yes}\n`;
    const answer = `great 👍 ${uniq()}`;
    const fbEnd = [...quote].length;
    bob.say(
      muc,
      quote + answer,
      `<reply xmlns='urn:xmpp:reply:0' to='${muc}/Chirkle' id='${botSid}'/><fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:reply:0'><body start='0' end='${fbEnd}'/></fallback>`,
    );
    const got = await messageWith(room.id, answer);
    const mine = (await messagesOf(room.id)).find((x) => x.text === yes)!;
    expect(got.reply_to).toBe(mine.id);
    expect(got.expand?.author.name).toMatch(/^Bob( \d+)? \(XMPP\)$/);
  });

  it("corrections and retractions both ways", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    // XMPP → Chirkle: a correction (XEP-0308) by the sender's own id, then a retraction (XEP-0424).
    const typo = `teh plan ${uniq()}`;
    const id = ann.say(muc, typo);
    const m = await messageWith(room.id, typo);
    const fixed = typo.replace("teh", "the");
    ann.say(muc, fixed, `<replace xmlns='urn:xmpp:message-correct:0' id='${id}'/>`);
    await eventually(async () => expect((await admin.collection("messages").getOne(m.id)).text).toBe(fixed));
    expect((await messagesOf(room.id)).filter((x) => !x.deleted)).toHaveLength(1);
    ann.send(
      `<message to='${muc}' type='groupchat' id='rt-${uniq()}'><retract xmlns='urn:xmpp:message-retract:1' id='${id}'/><fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:message-retract:1'/><body>/me retracted a message</body><store xmlns='urn:xmpp:hints'/></message>`,
    );
    await eventually(async () => expect((await admin.collection("messages").getOne(m.id)).deleted).toBe(true));
    await sleep(1000);
    expect((await messagesOf(room.id)).filter((x) => !x.deleted)).toHaveLength(0);

    // Chirkle → XMPP: an edit is a correction of the bot's message; a delete, a retraction of it.
    const draft = `draft ${uniq()}`;
    const mine = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: draft });
    const sent = await ann.fromBot(muc, (b) => b.endsWith(draft));
    const sentId = attr(sent, "message", "id");
    const originId = attr(sent, "origin-id", "id");
    const sentSid = attr(sent, "stanza-id", "id");
    await owner.pb.collection("messages").update(mine.id, { text: `${draft} (final)` });
    const corr = await ann.fromBot(muc, (b) => b.endsWith(`${draft} (final)`));
    expect([sentId, originId]).toContain(attr(corr, "replace", "id"));
    await owner.pb.collection("messages").update(mine.id, { deleted: true });
    const retr = await ann.waitFor(
      (l) => l.includes(`from="${muc}/Chirkle"`) && l.includes("urn:xmpp:message-retract:1") && l.includes("<retract"),
    );
    // Version 1 by the conference's stanza id; the older one (apply-to) by the origin id.
    expect(attr(retr, "retract", "id")).toBe(sentSid);
    expect(attr(retr, "apply-to", "id")).toBe(originId);
    await eventually(async () => expect((await admin.collection("messages").getOne(mine.id)).deleted).toBe(true));
  });

  it("reactions both ways (XEP-0444)", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const t = `react to me ${uniq()}`;
    const id = ann.say(muc, t);
    const sid = await ann.stanzaIdOf(id);
    const m = await messageWith(room.id, t);
    // Groupchat reactions point at the stanza id.
    await bob.join(muc, "Bob");
    bob.send(
      `<message to='${muc}' type='groupchat' id='re-${uniq()}'><reactions xmlns='urn:xmpp:reactions:0' id='${sid}'><reaction>👍</reaction><reaction>❤️</reaction></reactions><store xmlns='urn:xmpp:hints'/></message>`,
    );
    const reactions = async () =>
      ((await admin.collection("messages").getOne(m.id)).reactions as { emoji: string; users: string[] }[]).map((r) => r.emoji);
    await eventually(async () => expect((await reactions()).length).toBe(2));
    expect(await reactions()).toContain("👍");

    // Chirkle → XMPP: the bot's set on Ann's message.
    await owner.pb.send("/api/chat/reactions", { method: "POST", body: { message: m.id, emoji: "🔥", on: true } });
    const r = await ann.waitFor((l) => l.includes(`from="${muc}/Chirkle"`) && l.includes("urn:xmpp:reactions:0"));
    expect(attr(r, "reactions", "id")).toBe(sid);
    expect(r).toContain("🔥");
    // Taking Bob's away.
    bob.send(
      `<message to='${muc}' type='groupchat' id='re-${uniq()}'><reactions xmlns='urn:xmpp:reactions:0' id='${sid}'/><store xmlns='urn:xmpp:hints'/></message>`,
    );
    await eventually(async () => expect(await reactions()).toEqual(["🔥"]));
  });

  it("files both ways: Chirkle's go up by HTTP upload; a conference's upload link comes in as a file", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const caption = `look ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: caption, files: [pngFile("cat.png")] });
    await ann.fromBot(muc, (b) => b.endsWith(caption));
    const file = await ann.waitFor((l) => l.includes(`from="${muc}/Chirkle"`) && l.includes("jabber:x:oob"), 30_000);
    const url = text(file, "url");
    expect(url).toMatch(new RegExp(`^https://${UPLOAD_HOST.replace(".", "\\.")}/`));
    expect(text(file, "body")).toBe(url);
    // Node's fetch doesn't read SSL_CERT_FILE: curl, with the CA.
    const body = execFileSync("curl", ["-sf", "--cacert", CA, url]);
    expect(Buffer.compare(body, Buffer.from(PNG))).toBe(0);

    // Ann uploads a file herself and links it.
    const slot = await ann.iq(
      UPLOAD_HOST.split(":")[0]!,
      "get",
      `<request xmlns='urn:xmpp:http:upload:0' filename='dog pic.png' size='${PNG.length}' content-type='image/png'/>`,
    );
    const put = attr(slot, "put", "url");
    const auth = /<header [^>]*name="Authorization"[^>]*>([^<]*)<\/header>/.exec(slot)?.[1] ?? "";
    const get = attr(slot, "get", "url");
    expect(put).toBeTruthy();
    execFileSync(
      "curl",
      ["-sf", "--cacert", CA, "-X", "PUT", "-H", "content-type: image/png", "-H", `Authorization: ${auth}`, "--data-binary", "@-", put],
      { input: Buffer.from(PNG) },
    );
    ann.say(muc, get, `<x xmlns='jabber:x:oob'><url>${esc(get)}</url></x>`);
    const m = await eventually(async () => {
      const x = (await messagesOf(room.id)).find(
        (y) => /^Ann( \d+)? \(XMPP\)$/.test(y.expand?.author.name) && (y.files as string[]).length === 1,
      );
      expect(x).toBeDefined();
      return x!;
    }, 30_000);
    expect(m.text).toBe("");
    const stored = (m.files as string[])[0]!;
    const local = await fetch(`${server.url}/api/files/messages/${m.id}/${stored}`);
    expect(Buffer.compare(Buffer.from(await local.arrayBuffer()), Buffer.from(PNG))).toBe(0);
  });

  it("a moderator's delete in the room moderates an XMPP person's message (XEP-0425), with the bot an admin", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann, { botAdmin: true });
    await bob.join(muc, "Bob");
    const spam = `buy now ${uniq()}`;
    const id = bob.say(muc, spam);
    const sid = await bob.stanzaIdOf(id);
    const m = await messageWith(room.id, spam);
    const moderator = await signUp("Mod");
    await admin.collection("users").update(moderator.user.id, { moderator: true });
    await moderator.pb.send("/api/chat/delete", { method: "POST", body: { messages: [m.id] } });
    const mod = await ann.waitFor(
      (l) => l.startsWith("<message") && l.includes("urn:xmpp:message-retract:1") && (l.includes(`id="${sid}"`) || l.includes("moderated")),
      20_000,
    );
    expect(mod).toContain(sid);
    await sleep(1500);
    expect((await admin.collection("messages").getOne(m.id)).deleted).toBe(true);
  });

  it("a stand-in gets the person's vCard photo as its avatar", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const sha = createHash("sha1").update(PNG).digest("hex");
    const set = await bob.iq(
      `bob@${DOMAIN}`,
      "set",
      `<vCard xmlns='vcard-temp'><FN>Bob</FN><PHOTO><TYPE>image/png</TYPE><BINVAL>${PNG_BASE64}</BINVAL></PHOTO></vCard>`,
    );
    expect(attr(set, "iq", "type")).toBe("result");
    bob.send(
      `<presence to='${muc}/Bob'><x xmlns='http://jabber.org/protocol/muc'><history maxstanzas='0'/></x><x xmlns='vcard-temp:x:update'><photo>${sha}</photo></x></presence>`,
    );
    await bob.waitFor((l) => l.startsWith("<presence") && l.includes(`from="${muc}/Bob"`) && l.includes('code="110"'));
    const t = `hi from bob ${uniq()}`;
    bob.say(muc, t);
    const m = await messageWith(room.id, t);
    await eventually(async () => expect((await admin.collection("users").getOne(m.author)).avatar).toMatch(/^avatar_\w+\.png$/), 30_000);
  });

  it("a conference nobody is in yet: the bot makes it, and it is open to others (not left locked)", async () => {
    const owner = await signUp("Olga");
    const muc = newMuc();
    const room = await owner.pb.collection("rooms").create({ name: `x-${uniq()}`, created_by: owner.user.id });
    const link = await admin.collection("xmpp_links").create({ muc, room: room.id, enabled: true });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toBe("joined as Chirkle"), 30_000);
    await bob.join(muc, "Bob");
    const t = `first! ${uniq()}`;
    bob.say(muc, t);
    await messageWith(room.id, t);
  });

  it("an encrypted message shows as one", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    ann.say(
      muc,
      "I sent you an OMEMO encrypted message but your client doesn't seem to support that.",
      `<encrypted xmlns='eu.siacs.conversations.axolotl'><header sid='1'><iv>AAAA</iv></header><payload>AAAA</payload></encrypted><encryption xmlns='urn:xmpp:eme:0' namespace='eu.siacs.conversations.axolotl'/>`,
    );
    await messageWith(room.id, "🔒 An encrypted message");
  });

  it("an anonymous link sends no names; a password-protected conference is joined with its password", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann, { linkExtra: { anonymous: true } });
    const t = `secret santa ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: t });
    const got = await ann.fromBot(muc, (b) => b.includes(t));
    expect(text(got, "body")).toBe(t);

    // A conference with a password: Ann sets one; a link without it says why it isn't in; with it, joins.
    const locked = newMuc();
    await ann.join(locked, "Ann");
    const form = await ann.iq(locked, "get", `<query xmlns='http://jabber.org/protocol/muc#owner'/>`);
    expect(attr(form, "iq", "type")).toBe("result");
    const cfg = await ann.iq(
      locked,
      "set",
      `<query xmlns='http://jabber.org/protocol/muc#owner'><x xmlns='jabber:x:data' type='submit'><field var='FORM_TYPE'><value>http://jabber.org/protocol/muc#roomconfig</value></field><field var='muc#roomconfig_passwordprotectedroom'><value>1</value></field><field var='muc#roomconfig_roomsecret'><value>hunter2</value></field></x></query>`,
    );
    expect(attr(cfg, "iq", "type")).toBe("result");
    const room2 = await owner.pb.collection("rooms").create({ name: `x-${uniq()}`, created_by: owner.user.id });
    const link = await admin.collection("xmpp_links").create({ muc: locked, room: room2.id, enabled: true });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toMatch(/password/i), 30_000);
    await admin.collection("xmpp_links").update(link.id, { password: "hunter2" });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toBe("joined as Chirkle"), 30_000);
  });

  it("history: messages sent while the bot was away come in when it is back, once", async () => {
    const owner = await signUp("Olga");
    const { muc, room, link } = await linked(owner, ann);
    const first = `before ${uniq()}`;
    ann.say(muc, first);
    await messageWith(room.id, first);
    await admin.collection("xmpp_links").update(link.id, { enabled: false });
    await ann.waitFor((l) => l.startsWith("<presence") && l.includes(`from="${muc}/Chirkle"`) && l.includes('type="unavailable"'), 30_000);
    const away = `while away ${uniq()}`;
    ann.say(muc, away);
    await sleep(500);
    await admin.collection("xmpp_links").update(link.id, { enabled: true });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toBe("joined as Chirkle"), 30_000);
    await messageWith(room.id, away, 30_000);
    await sleep(1500);
    const texts = (await messagesOf(room.id)).map((x) => x.text);
    expect(texts.filter((x) => x === first)).toHaveLength(1);
    expect(texts.filter((x) => x === away)).toHaveLength(1);
  });

  it("someone else in the conference with the bot's nickname: the bot still gets in", async () => {
    const owner = await signUp("Olga");
    const muc = newMuc();
    await ann.join(muc, "Ann");
    await bob.join(muc, "Chirkle");
    const room = await owner.pb.collection("rooms").create({ name: `x-${uniq()}`, created_by: owner.user.id });
    const link = await admin.collection("xmpp_links").create({ muc, room: room.id, enabled: true });
    const status = await eventually(async () => {
      const s = (await admin.collection("xmpp_links").getOne(link.id)).status;
      expect(s).toMatch(/^joined as /);
      return s;
    }, 30_000);
    expect(status).not.toBe("joined as Chirkle");
  });

  it("an invitation to a conference makes a link to fill in", async () => {
    const muc = newMuc();
    await ann.join(muc, "Ann");
    ann.send(
      `<message to='${muc}' id='inv-${uniq()}'><x xmlns='http://jabber.org/protocol/muc#user'><invite to='bot@${DOMAIN}'><reason>join us</reason></invite></x></message>`,
    );
    await eventually(async () => {
      const l = await admin.collection("xmpp_links").getFullList({ filter: admin.filter("muc = {:muc}", { muc }) });
      expect(l).toHaveLength(1);
    }, 30_000);
  });

  it("kicked out, the bot says so, and comes back once the link is saved again", async () => {
    const owner = await signUp("Olga");
    const { muc, link } = await linked(owner, ann);
    const kick = await ann.iq(
      muc,
      "set",
      `<query xmlns='http://jabber.org/protocol/muc#admin'><item nick='Chirkle' role='none'><reason>bye</reason></item></query>`,
    );
    expect(attr(kick, "iq", "type")).toBe("result");
    await eventually(
      async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).not.toBe("joined as Chirkle"),
      30_000,
    );
    const s = (await admin.collection("xmpp_links").getOne(link.id)).status;
    expect(s).toMatch(/kick/i);
  });

  // ---------------------------------------------------------------- batch 2: the edges

  it("someone can't correct, retract or react as someone else: only the sender's own count", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    await bob.join(muc, "Bob");
    const t = `ann's words ${uniq()}`;
    const id = ann.say(muc, t);
    const sid = await ann.stanzaIdOf(id);
    const m = await messageWith(room.id, t);
    bob.say(muc, "hacked", `<replace xmlns='urn:xmpp:message-correct:0' id='${id}'/>`);
    bob.send(
      `<message to='${muc}' type='groupchat' id='x-${uniq()}'><retract xmlns='urn:xmpp:message-retract:1' id='${sid}'/><body>/me retracted</body></message>`,
    );
    bob.send(
      `<message to='${muc}' type='groupchat' id='x-${uniq()}'><retract xmlns='urn:xmpp:message-retract:1' id='${id}'/><body>/me retracted</body></message>`,
    );
    const marker = `marker ${uniq()}`;
    bob.say(muc, marker);
    await messageWith(room.id, marker);
    await sleep(1000);
    const now = await admin.collection("messages").getOne(m.id);
    expect([now.text, now.deleted]).toEqual([t, false]);
    // Bob's "hacked" correction of a message that isn't his: not shown as anything either.
    expect((await messagesOf(room.id)).map((x) => x.text)).not.toContain("hacked");
  });

  it("a nickname change keeps the stand-in; leaving and coming back keeps it too (occupant id)", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const nick = `Nora${uniq().slice(-4)}`;
    const nora = await Person.login("bob");
    await nora.join(muc, nick);
    const a = `one ${uniq()}`;
    nora.say(muc, a);
    const first = await messageWith(room.id, a);
    nora.send(`<presence to='${muc}/${nick}-2'/>`);
    await nora.waitFor((l) => l.startsWith("<presence") && l.includes(`from="${muc}/${nick}-2"`));
    const b = `two ${uniq()}`;
    nora.say(muc, b);
    const second = await messageWith(room.id, b);
    expect(second.author).toBe(first.author);
    nora.send(`<presence to='${muc}/${nick}-2' type='unavailable'/>`);
    await sleep(500);
    await nora.join(muc, nick);
    const c = `three ${uniq()}`;
    nora.say(muc, c);
    const third = await messageWith(room.id, c);
    expect(third.author).toBe(first.author);
    nora.close();
  });

  it("odd nicknames: accents, spaces, right-to-left, very long (servers refuse emoji ones)", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const nicks = ["Zoë", "名前 太郎", "a  b", "مرحبا", "x".repeat(200)];
    for (const n of nicks) {
      const p = await Person.login("bob");
      await p.join(muc, n);
      const t = `from ${n.length} ${uniq()}`;
      p.say(muc, t);
      const m = await messageWith(room.id, t);
      const name = m.expand?.author.name as string;
      expect(name.endsWith("(XMPP)")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(100);
      p.close();
    }
  });

  it("long, multi-line and empty-ish messages; chat states and subjects make no messages", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const long = `${"word ".repeat(1500)}${uniq()}`.trim();
    ann.say(muc, long);
    // Over 2000 characters: in parts, cut at spaces (lib/bridges.js), which together are the whole.
    await eventually(async () => expect((await messagesOf(room.id)).map((x) => x.text).join(" ")).toBe(long));
    const parts = (await messagesOf(room.id)).length;
    expect(parts).toBe(4);
    ann.send(
      `<message to='${muc}' type='groupchat' id='cs-${uniq()}'><composing xmlns='http://jabber.org/protocol/chatstates'/></message>`,
    );
    ann.send(`<message to='${muc}' type='groupchat' id='sb-${uniq()}'><subject>new topic</subject></message>`);
    ann.say(muc, "   ");
    const marker = `marker ${uniq()}`;
    ann.say(muc, marker);
    await messageWith(room.id, marker);
    await sleep(800);
    expect((await messagesOf(room.id)).map((x) => x.text).slice(parts)).toEqual([marker]);

    // A long one from the room goes out whole.
    const out = `${"línea\n".repeat(300)}end ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: out });
    const got = await ann.fromBot(muc, (b) => b.endsWith(out.slice(-20)));
    expect(text(got, "body")).toBe(`Olga: ${out}`);
  });

  it("a private message to the bot through the conference doesn't come into the room", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const t = `psst ${uniq()}`;
    ann.send(
      `<message to='${muc}/Chirkle' type='chat' id='pm-${uniq()}'><body>${t}</body><x xmlns='http://jabber.org/protocol/muc#user'/></message>`,
    );
    ann.send(`<message to='bot@${DOMAIN}' type='chat' id='pm-${uniq()}'><body>${t}</body></message>`);
    const marker = `marker ${uniq()}`;
    ann.say(muc, marker);
    await messageWith(room.id, marker);
    await sleep(800);
    expect((await messagesOf(room.id)).map((x) => x.text)).toEqual([marker]);
  });

  it("several files with text go as the text and then each file; a file over the upload limit goes as a link", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    await admin.settings.update({ meta: { appURL: "https://chat.example" } });
    try {
      const caption = `two pics ${uniq()}`;
      const from = ann.lines.length;
      await owner.pb.collection("messages").create({
        room: room.id,
        author: owner.user.id,
        text: caption,
        files: [pngFile("a.png"), pngFile("b.png")],
      });
      await ann.fromBot(muc, (b) => b.endsWith(caption));
      await eventually(
        () =>
          expect(ann.lines.slice(from).filter((l) => l.includes(`from="${muc}/Chirkle"`) && l.includes("jabber:x:oob"))).toHaveLength(2),
        30_000,
      );
      // Over Prosody's 10 MB: the App URL's link.
      const big = new File([new Uint8Array(11 * 1024 * 1024)], "big.bin", { type: "application/octet-stream" });
      const m = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `big ${uniq()}`, files: [big] });
      const link = await ann.waitFor((l) => l.includes(`from="${muc}/Chirkle"`) && l.includes("jabber:x:oob") && l.includes(m.id), 60_000);
      expect(text(link, "url")).toMatch(/^https:\/\/chat\.example\/api\/files\/messages\//);
    } finally {
      await admin.settings.update({ meta: { appURL: "http://localhost:8090" } });
    }
  });

  it("a link that isn't the whole message stays text; a link to something that isn't there stays a link", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const url = `https://${UPLOAD_HOST}/file_share/nope/missing.png`;
    const t = `see ${url}`;
    ann.say(muc, t, `<x xmlns='jabber:x:oob'><url>${esc(url)}</url></x>`);
    await messageWith(room.id, t);
    ann.say(muc, url, `<x xmlns='jabber:x:oob'><url>${esc(url)}</url></x>`);
    const m = await messageWith(room.id, url, 30_000);
    expect(m.files).toEqual([]);
  });

  it("two conferences on one room: each gets the other's messages, named", async () => {
    const owner = await signUp("Olga");
    const { muc: m1, room } = await linked(owner, ann);
    const m2 = newMuc();
    await bob.join(m2, "Bob");
    const link2 = await admin.collection("xmpp_links").create({ muc: m2, room: room.id, enabled: true });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link2.id)).status).toBe("joined as Chirkle"), 30_000);
    const t = `across ${uniq()}`;
    ann.say(m1, t);
    const got = await bob.fromBot(m2, (b) => b.endsWith(t));
    expect(text(got, "body")).toMatch(new RegExp(`^Ann( \\d+)? \\(XMPP\\): ${t}$`));
    // And not back to where it came from.
    await sleep(1500);
    expect(ann.lines.filter((l) => l.includes(`from="${m1}/Chirkle"`) && text(l, "body").endsWith(t))).toHaveLength(0);
  });

  it("banned: the link says so; destroyed: the link says so", async () => {
    const owner = await signUp("Olga");
    const { muc, link } = await linked(owner, ann);
    const ban = await ann.iq(
      muc,
      "set",
      `<query xmlns='http://jabber.org/protocol/muc#admin'><item affiliation='outcast' jid='bot@${DOMAIN}'/></query>`,
    );
    expect(attr(ban, "iq", "type")).toBe("result");
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toMatch(/banned/), 30_000);
    // Saving the link again tries again: still banned, and says why.
    await admin.collection("xmpp_links").update(link.id, { password: "x" });
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toMatch(/banned/), 30_000);

    const { muc: muc2, link: link2 } = await linked(owner, ann);
    const d = await ann.iq(
      muc2,
      "set",
      `<query xmlns='http://jabber.org/protocol/muc#owner'><destroy><reason>done</reason></destroy></query>`,
    );
    expect(attr(d, "iq", "type")).toBe("result");
    await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link2.id)).status).toMatch(/destroyed/), 30_000);
  });

  it("unlinking and deleting the link: the bot leaves", async () => {
    const owner = await signUp("Olga");
    const { muc, link } = await linked(owner, ann);
    const from = ann.lines.length;
    await admin.collection("xmpp_links").delete(link.id);
    await ann.waitFor(
      (l) => l.startsWith("<presence") && l.includes(`from="${muc}/Chirkle"`) && l.includes('type="unavailable"'),
      30_000,
      from,
    );
  });

  it("a reply to the room's own message, an edit of a reply, and an edit after a file", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const q = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `q ${uniq()}` });
    const qSent = await ann.fromBot(muc, (b) => b.endsWith(q.text));
    const r = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `r ${uniq()}`, reply_to: q.id });
    const rSent = await ann.fromBot(muc, (b) => b.endsWith(r.text));
    expect(attr(rSent, "reply", "id")).toBe(attr(qSent, "stanza-id", "id"));
    await owner.pb.collection("messages").update(r.id, { text: `${r.text} fixed` });
    const corr = await ann.fromBot(muc, (b) => b.endsWith(`${r.text} fixed`));
    expect(attr(corr, "replace", "id")).toBe(attr(rSent, "message", "id"));
    expect(attr(corr, "reply", "id")).toBe(attr(qSent, "stanza-id", "id"));
    const f = await owner.pb
      .collection("messages")
      .create({ room: room.id, author: owner.user.id, text: `f ${uniq()}`, files: [pngFile("c.png")] });
    const fSent = await ann.fromBot(muc, (b) => b.endsWith(f.text));
    await owner.pb.collection("messages").update(f.id, { text: `${f.text} edited` });
    const fCorr = await ann.fromBot(muc, (b) => b.endsWith(`${f.text} edited`));
    expect(attr(fCorr, "replace", "id")).toBe(attr(fSent, "message", "id"));
  });

  it("the conference's owner moderates a message: it goes from the room too", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    await bob.join(muc, "Bob");
    const t = `rude ${uniq()}`;
    const id = bob.say(muc, t);
    const sid = await bob.stanzaIdOf(id);
    const m = await messageWith(room.id, t);
    const r = await ann.iq(
      muc,
      "set",
      `<moderate xmlns='urn:xmpp:message-moderate:1' id='${sid}'><retract xmlns='urn:xmpp:message-retract:1'/><reason>no</reason></moderate>`,
    );
    expect(attr(r, "iq", "type")).toBe("result");
    await eventually(async () => expect((await admin.collection("messages").getOne(m.id)).deleted).toBe(true));
  });

  it("PocketBase restarted: the child comes back, messages sent meanwhile come in once, nothing twice", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const before = `before restart ${uniq()}`;
    ann.say(muc, before);
    await messageWith(room.id, before);
    const mine = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `mine ${uniq()}` });
    await ann.fromBot(muc, (b) => b.endsWith(mine.text));
    await server.stop();
    await ann.waitFor((l) => l.startsWith("<presence") && l.includes(`from="${muc}/Chirkle"`) && l.includes('type="unavailable"'), 30_000);
    const during = `during restart ${uniq()}`;
    ann.say(muc, during);
    await sleep(300);
    await startServer();
    owner.pb = new PocketBase(server.url);
    owner.pb.autoCancellation(false);
    await messageWith(room.id, during, 60_000);
    await sleep(3000);
    const texts = (await messagesOf(room.id)).map((x) => x.text);
    expect(texts.filter((x) => x === before)).toHaveLength(1);
    expect(texts.filter((x) => x === during)).toHaveLength(1);
    expect(texts.filter((x) => x === mine.text)).toHaveLength(1);
    // And the bot didn't send the room's message again.
    expect(ann.lines.filter((l) => l.includes(`from="${muc}/Chirkle"`) && text(l, "body").endsWith(mine.text))).toHaveLength(1);
  });

  it("bursts keep their order, both ways", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    const tag = uniq();
    for (let i = 0; i < 40; i++) ann.say(muc, `in ${tag} #${i}`);
    await eventually(
      async () => expect((await messagesOf(room.id)).filter((m) => m.text.startsWith(`in ${tag}`))).toHaveLength(40),
      60_000,
    );
    expect((await messagesOf(room.id)).map((m) => m.text)).toEqual(Array.from({ length: 40 }, (_, i) => `in ${tag} #${i}`));

    const from = ann.lines.length;
    for (let i = 0; i < 25; i++)
      await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `out ${tag} #${i}` });
    await eventually(
      () =>
        expect(
          ann.lines.slice(from).filter((l) => l.includes(`from="${muc}/Chirkle"`) && text(l, "body").includes(`out ${tag}`)),
        ).toHaveLength(25),
      60_000,
    );
    const order = ann.lines
      .slice(from)
      .filter((l) => l.includes(`from="${muc}/Chirkle"`) && text(l, "body").includes(`out ${tag}`))
      .map((l) => text(l, "body"));
    expect(order).toEqual(Array.from({ length: 25 }, (_, i) => `Olga: out ${tag} #${i}`));
  });

  it.skipIf(!RESTART)(
    "the XMPP server restarted: the bot reconnects and rejoins; what was said meanwhile comes in once",
    async () => {
      const owner = await signUp("Olga");
      const { muc, room, link } = await linked(owner, ann);
      const before = `pre ${uniq()}`;
      ann.say(muc, before);
      await messageWith(room.id, before);
      // The room's message while the server is down waits, and goes once the bot is back.
      execFileSync("sh", ["-c", RESTART], { stdio: "inherit" });
      // Everyone was dropped: the people log in and join again.
      for (const p of people) p.close();
      people.length = 0;
      ann = await Person.login("ann");
      bob = await Person.login("bob");
      await ann.join(muc, "Ann");
      const queued = await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: `queued ${uniq()}` });
      await eventually(async () => expect((await admin.collection("xmpp_links").getOne(link.id)).status).toBe("joined as Chirkle"), 90_000);
      await ann.fromBot(muc, (b) => b.endsWith(queued.text), 60_000);
      const after = `post ${uniq()}`;
      ann.say(muc, after);
      await messageWith(room.id, after, 30_000);
      await sleep(2000);
      const texts = (await messagesOf(room.id)).map((x) => x.text);
      expect(texts.filter((x) => x === before)).toHaveLength(1);
      expect(ann.lines.filter((l) => l.includes(`from="${muc}/Chirkle"`) && text(l, "body").endsWith(queued.text))).toHaveLength(1);
    },
    240_000,
  );

  it("an anonymous room's messages go out as the room's, not their author's", async () => {
    const owner = await signUp("Olga");
    const { muc, room } = await linked(owner, ann);
    await admin.collection("rooms").update(room.id, { anonymous: true });
    const t = `whisper ${uniq()}`;
    await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: t });
    const got = await ann.fromBot(muc, (b) => b.endsWith(t));
    expect(text(got, "body")).toBe(`${room.name}: ${t}`);
  });

  it("a direct invitation (XEP-0249) with a password makes a link that has it", async () => {
    const muc = newMuc();
    ann.send(`<message to='bot@${DOMAIN}' id='di-${uniq()}'><x xmlns='jabber:x:conference' jid='${muc}' password='pw1'/></message>`);
    const l = await eventually(async () => {
      const [x] = await admin.collection("xmpp_links").getFullList({ filter: admin.filter("muc = {:muc}", { muc }) });
      expect(x).toBeDefined();
      return x!;
    }, 30_000);
    expect([l.enabled, l.password, l.room]).toEqual([false, "pw1", ""]);
  });

  it("invitations from anyone can't flood the links: only so many waiting at once", async () => {
    const tag = uniq().toLowerCase();
    for (let i = 0; i < 120; i++)
      ann.send(`<message to='bot@${DOMAIN}' id='fl-${i}'><x xmlns='jabber:x:conference' jid='flood-${tag}-${i}@${MUCS}'/></message>`);
    // The last one is there (or refused) once the child got this far: a direct invitation after them all.
    const last = newMuc();
    ann.send(`<message to='bot@${DOMAIN}' id='fl-last'><x xmlns='jabber:x:conference' jid='${last}'/></message>`);
    await sleep(8000);
    const waiting = await admin.collection("xmpp_links").getFullList({ filter: admin.filter("muc ~ {:t}", { t: `flood-${tag}` }) });
    // At most 20 waiting, of any (earlier tests' invitations count too).
    expect(waiting.length).toBeLessThanOrEqual(20);
    const all = await admin.collection("xmpp_links").getFullList({ filter: "room = '' && enabled = false" });
    expect(all.length).toBe(20);
    // A superuser deletes them: invitations come in again.
    for (const l of all) await admin.collection("xmpp_links").delete(l.id);
    const again = newMuc();
    ann.send(`<message to='bot@${DOMAIN}' id='fl-again'><x xmlns='jabber:x:conference' jid='${again}'/></message>`);
    await eventually(async () =>
      expect(await admin.collection("xmpp_links").getFullList({ filter: admin.filter("muc = {:m}", { m: again }) })).toHaveLength(1),
    );
  });

  it("the bot's password is wrong: the links say it isn't connected, and why", async () => {
    const other = await startPocketBase({
      env: {
        XMPP_JID: `bot@${DOMAIN}`,
        XMPP_PASSWORD: "wrong",
        XMPP_SERVER: SERVER,
        CHIRKLE_XMPP_BIN: startOpts!.env!.CHIRKLE_XMPP_BIN!,
        SSL_CERT_FILE: CA,
      },
    });
    try {
      const a = new PocketBase(other.url);
      a.autoCancellation(false);
      await a.collection("_superusers").authWithPassword(SUPERUSER.email, SUPERUSER.password);
      const u = await a
        .collection("users")
        .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name: `o-${uniq()}` });
      const room = await a.collection("rooms").create({ name: `x-${uniq()}`, created_by: u.id });
      const link = await a.collection("xmpp_links").create({ muc: newMuc(), room: room.id, enabled: true });
      const st = await eventually(async () => {
        await a.send("/api/xmpp/tick", { method: "POST" }).catch(() => {}); // this server's worker, not the other's
        const x = (await a.collection("xmpp_links").getOne(link.id)).status;
        expect(x).toMatch(/^not connected/);
        return x;
      }, 30_000);
      expect(st).toMatch(/refused the bot.s login \(XMPP_JID, XMPP_PASSWORD\)/);
    } finally {
      await other.stop();
    }
  });

  it.skipIf(!SHELL)(
    "the conference forgets the bot (its service restarted, the bot's connection didn't): it notices and joins again",
    async () => {
      const owner = await signUp("Olga");
      const { muc, room } = await linked(owner, ann);
      // The service forgets the room, as one that restarted does, without a word to anyone in it.
      const lua = `> local m = prosody.hosts["${MUCS}"].modules.muc; m.forget_room(m.get_room_from_jid("${muc}"))\n`;
      execFileSync("sh", ["-c", SHELL], { input: lua, stdio: ["pipe", "inherit", "inherit"] });
      await sleep(1000);
      await ann.join(muc, "Ann");
      const t = `after the reload ${uniq()}`;
      // Said again every 30 s: what was said before the bot is back isn't in the conference's history (it was new).
      const deadline = Date.now() + 6.5 * 60_000;
      let found: RecordModel | undefined;
      while (!found && Date.now() < deadline) {
        ann.say(muc, `${t} ${Date.now()}`);
        for (let i = 0; i < 30 && !found; i++) {
          await sleep(1000);
          found = (await messagesOf(room.id)).find((m) => m.text.startsWith(t));
        }
      }
      expect(found, "the bot came back within the self-ping interval").toBeDefined();
    },
    8 * 60_000,
  );

  it.skipIf(!SHELL)(
    "the room's message to a conference that forgot the bot: refused, the bot joins again and sends it then",
    async () => {
      const owner = await signUp("Olga");
      const { muc, room } = await linked(owner, ann);
      const lua = `> local m = prosody.hosts["${MUCS}"].modules.muc; m.forget_room(m.get_room_from_jid("${muc}"))\n`;
      execFileSync("sh", ["-c", SHELL], { input: lua, stdio: ["pipe", "ignore", "inherit"] });
      await ann.join(muc, "Ann");
      const t = `said to a ghost ${uniq()}`;
      await owner.pb.collection("messages").create({ room: room.id, author: owner.user.id, text: t });
      const got = await ann.fromBot(muc, (b) => b.endsWith(t), 60_000);
      expect(text(got, "body")).toBe(`Olga: ${t}`);
    },
    120_000,
  );
});
