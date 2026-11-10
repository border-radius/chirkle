// A stub Telegram Bot API for the bridge's tests (DESIGN.md §26.8): records every call, answers the way Telegram
// does, serves files for download, hands out queued updates to getUpdates, and fails calls on demand.

import { createServer, type IncomingMessage } from "node:http";

// biome-ignore lint/suspicious/noExplicitAny: Telegram's JSON, which the tests read loosely
type Json = any;

export interface StubFile {
  name: string;
  size: number;
  type: string;
  bytes: Uint8Array;
}

export interface Call {
  method: string;
  /** Fields as sent; those holding JSON (media, reply_parameters…) parsed. */
  params: Record<string, Json>;
  /** Uploaded files by field name. */
  files: Record<string, StubFile>;
}

export interface TelegramStub {
  readonly url: string;
  readonly token: string;
  readonly calls: Call[];
  /** Calls of one method, oldest first. */
  callsOf(method: string): Call[];
  /** A file the bot can download: getFile answers for `id`, and its bytes are served. */
  addFile(id: string, bytes: Uint8Array, path?: string): void;
  /** Profile pictures of a Telegram user, by file id (getUserProfilePhotos). */
  setPhoto(userId: number, fileId: string): void;
  /** The emoji a custom emoji stands for (getCustomEmojiStickers). */
  setCustomEmoji(id: string, emoji: string): void;
  /** Updates for getUpdates. */
  readonly updates: unknown[];
  /** The message_id the next message the bot sends gets. */
  nextMessageId(): number;
  /** Fail the next `times` calls of `method` with this status and body. */
  fail(method: string, status: number, body: Record<string, unknown>, times?: number): void;
  close(): Promise<void>;
}

const JSON_FIELDS = new Set(["media", "reply_parameters", "allowed_updates"]);

async function read(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function parse(req: IncomingMessage): Promise<{ params: Record<string, Json>; files: Record<string, StubFile> }> {
  const body = await read(req);
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("multipart/form-data")) return { params: body.length ? JSON.parse(body.toString()) : {}, files: {} };
  const form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
  const params: Record<string, Json> = {};
  const files: Record<string, StubFile> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") params[k] = JSON_FIELDS.has(k) ? JSON.parse(v) : v;
    else files[k] = { name: v.name, size: v.size, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) };
  }
  return { params, files };
}

export async function startTelegramStub(): Promise<TelegramStub> {
  const token = "123456:stub-token";
  const calls: Call[] = [];
  const updates: unknown[] = [];
  const files = new Map<string, { path: string; bytes: Uint8Array }>();
  const photos = new Map<number, string>();
  const customEmoji = new Map<string, string>();
  const failures = new Map<string, { status: number; body: Record<string, unknown> }[]>();
  let nextId = 1000;

  const message = (params: Record<string, Json>, extra: Record<string, unknown> = {}) => ({
    message_id: nextId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: Number(params.chat_id), type: "supergroup" },
    ...extra,
  });

  const answer = (method: string, params: Record<string, Json>): unknown => {
    switch (method) {
      case "sendMessage":
        return message(params, { text: params.text });
      case "sendPhoto":
      case "sendVideo":
      case "sendDocument":
        return message(params, { caption: params.caption });
      case "sendSticker":
        return message(params);
      case "sendMediaGroup":
        return (params.media as unknown[]).map(() => message(params));
      case "editMessageText":
      case "editMessageCaption":
        return { message_id: params.message_id };
      case "getFile": {
        const f = files.get(params.file_id);
        return f
          ? { file_id: params.file_id, file_unique_id: `u-${params.file_id}`, file_size: f.bytes.length, file_path: f.path }
          : undefined;
      }
      case "getUserProfilePhotos": {
        const id = photos.get(Number(params.user_id));
        const sizes = id ? [{ file_id: id, file_unique_id: `u-${id}`, width: 160, height: 160 }] : [];
        return { total_count: sizes.length ? 1 : 0, photos: sizes.length ? [sizes] : [] };
      }
      case "getCustomEmojiStickers":
        return (params.custom_emoji_ids as string[])
          .filter((id) => customEmoji.has(id))
          .map((id) => ({ type: "custom_emoji", custom_emoji_id: id, emoji: customEmoji.get(id) }));
      case "getUpdates":
        return updates.splice(0);
      default:
        return true;
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const file = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
    if (file) {
      const f = [...files.values()].find((x) => x.path === file[2]);
      if (file[1] !== token || !f) return send(404, { ok: false, description: "Not Found" });
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(f.bytes);
    }
    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const method = m[2]!;
    const { params, files: uploaded } = await parse(req);
    calls.push({ method, params, files: uploaded });
    const failure = failures.get(method)?.shift();
    if (failure) return send(failure.status, { ok: false, error_code: failure.status, ...failure.body });
    const result = answer(method, params);
    if (result === undefined) return send(400, { ok: false, error_code: 400, description: "Bad Request: invalid file_id" });
    send(200, { ok: true, result });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no port");

  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    calls,
    updates,
    callsOf: (method) => calls.filter((c) => c.method === method),
    addFile: (id, bytes, path = `files/${id}.bin`) => void files.set(id, { path, bytes }),
    setPhoto: (userId, fileId) => void photos.set(userId, fileId),
    setCustomEmoji: (id, emoji) => void customEmoji.set(id, emoji),
    nextMessageId: () => nextId,
    fail: (method, status, body, times = 1) => {
      const list = failures.get(method) ?? [];
      for (let i = 0; i < times; i++) list.push({ status, body });
      failures.set(method, list);
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
