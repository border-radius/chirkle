// The XMPP bridge's tests (DESIGN.md §38.12) run PocketBase with a stub child (xmpp-child.mjs) instead of the Go one:
// this hub hears from it when PocketBase starts it, answers what PocketBase asks it (/rooms, /send, /upload: recorded,
// and failed on demand), and posts what a child would post (hello, statuses every second, events) with its secret.

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// biome-ignore lint/suspicious/noExplicitAny: the child protocol's JSON, which the tests read loosely
type Json = any;

export interface ChildRequest {
  pid: number;
  path: string;
  body: Json;
}

export interface StubChild {
  pid: number;
  port: number;
  secret: string;
  in: string;
  inAddr: string;
  jid: string;
}

export interface XmppStub {
  /** CHIRKLE_XMPP_BIN for PocketBase. */
  readonly bin: string;
  /** Every child PocketBase started, oldest first. */
  readonly children: StubChild[];
  /** What PocketBase asked, oldest first. */
  readonly requests: ChildRequest[];
  /** Requests to one path ("/rooms", "/send"). */
  requestsTo(path: string): ChildRequest[];
  /** Answer the next `times` requests to `path` with this status and body. */
  fail(path: string, status: number, body: Json, times?: number): void;
  /** The conference titles statuses report. */
  readonly titles: Map<string, string>;
  /** While true, the current child posts no statuses: it looks stuck. */
  quiet: boolean;
  /**
   * How /upload answers: "ok" reads the file from PocketBase (as the child does) and gives
   * https://upload.xmpp.example/<name>; otherwise a refusal for good with that code. "unsupported" at first.
   */
  uploads: "ok" | "unsupported" | "too_large";
  /** The files /upload read from PocketBase, by the URL it gave. */
  readonly uploaded: Map<string, Buffer>;
  /** vCard photos /avatar gives, by nickname (anyone else has none). */
  readonly photos: Map<string, { type: string; data: Uint8Array }>;
  /** Post an event to PocketBase as the current child would. Returns the HTTP status. */
  event(ev: Json, secret?: string): Promise<number>;
  /** Wait until PocketBase has started `n` children and the last has said hello. */
  waitForChild(n?: number, ms?: number): Promise<StubChild>;
  close(): Promise<void>;
}

const childScript = join(dirname(fileURLToPath(import.meta.url)), "xmpp-child.mjs");

async function readJson(req: IncomingMessage): Promise<Json> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body || "{}");
}

export async function startXmppStub(): Promise<XmppStub> {
  const dir = await mkdtemp(join(tmpdir(), "chirkle-xmpp-"));
  const bin = join(dir, "xmpp-bridge");
  const children: StubChild[] = [];
  const requests: ChildRequest[] = [];
  const failures = new Map<string, { status: number; body: Json; times: number }>();
  const titles = new Map<string, string>();
  const helloed = new Set<number>();
  const uploaded = new Map<string, Buffer>();
  const photos = new Map<string, { type: string; data: Uint8Array }>();
  const tokens = new Map<string, { type: string; data: Uint8Array }>();
  /** The conferences the current child was last told to be in. */
  let rooms: Json[] = [];

  const post = async (child: StubChild, ev: Json, secret = child.secret) => {
    const res = await fetch(child.in, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chirkle-bridge": secret },
      body: JSON.stringify(ev),
    });
    await res.text();
    return res.status;
  };

  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/photo/")) {
      const token = req.url.slice("/photo/".length);
      const p = tokens.get(token);
      tokens.delete(token);
      res.writeHead(p ? 200 : 404, { "content-type": p?.type || "text/plain" });
      return res.end(p ? Buffer.from(p.data) : "");
    }
    const body = await readJson(req);
    const reply = (json: Json) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url === "/started") {
      const child = body as StubChild;
      children.push(child);
      rooms = [];
      reply({});
      // As the child does: again until it is heard (PocketBase starts it before it listens).
      const hello = { type: "hello", protocol: 1, version: "stub", port: child.port, boot: `boot-${child.pid}` };
      for (let i = 0; i < 200; i++) {
        if ((await post(child, hello).catch(() => 0)) === 200) {
          helloed.add(child.pid);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }
    // /request: what PocketBase asked the child.
    requests.push(body as ChildRequest);
    const f = failures.get(body.path);
    if (f && f.times > 0) {
      f.times--;
      return reply({ status: f.status, json: f.body });
    }
    if (body.path === "/rooms") rooms = body.body.rooms;
    if (body.path === "/avatar") {
      const p = photos.get(body.body.nick);
      if (!p) return reply({ status: 200, json: {} });
      const token = `t${Math.random().toString(36).slice(2)}`;
      tokens.set(token, p);
      return reply({ status: 200, json: { token, type: p.type } });
    }
    if (body.path === "/upload") {
      if (stub.uploads !== "ok") return reply({ status: 400, json: { error: "no", transient: false, code: stub.uploads } });
      const child = children[children.length - 1]!;
      const file = await fetch(new URL(body.body.path, child.in));
      if (file.status !== 200) return reply({ status: 400, json: { error: `reading the file: ${file.status}`, transient: false } });
      const url = `https://upload.xmpp.example/${encodeURIComponent(body.body.name)}`;
      uploaded.set(url, Buffer.from(await file.arrayBuffer()));
      return reply({ status: 200, json: { url } });
    }
    reply({ status: 200, json: body.path === "/send" ? { id: body.body.id } : {} });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const hub = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await writeFile(bin, `#!/bin/sh\nXMPP_STUB_HUB=${hub} exec "${process.execPath}" "${childScript}" "$@"\n`);
  await chmod(bin, 0o755);

  const stub: XmppStub = {
    bin,
    children,
    requests,
    titles,
    quiet: false,
    uploads: "unsupported",
    uploaded,
    photos,
    requestsTo: (path) => requests.filter((r) => r.path === path),
    fail: (path, status, body, times = 1) => failures.set(path, { status, body, times }),
    event: (ev, secret) => {
      const child = children[children.length - 1];
      if (!child) throw new Error("no child yet");
      return post(child, ev, secret);
    },
    async waitForChild(n = 1, ms = 20_000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const child = children[n - 1];
        if (child && helloed.has(child.pid)) return child;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`PocketBase didn't start child ${n}`);
    },
    close: async () => {
      clearInterval(beat);
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };

  // The heartbeat: a status every second, every conference joined, unless the child is to look stuck.
  const beat = setInterval(() => {
    const child = children[children.length - 1];
    if (!child || stub.quiet || !helloed.has(child.pid)) return;
    const status = {
      type: "status",
      boot: `boot-${child.pid}`,
      connected: true,
      rooms: rooms.map((r) => ({ muc: r.muc, key: r.key, state: "joined", nick: "Chirkle", title: titles.get(r.muc) || "" })),
    };
    post(child, status).catch(() => {});
  }, 1000);

  return stub;
}
