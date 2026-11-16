/// <reference path="../../types/pocketbase.d.ts" />
// Telegram Bot API client and the bridge's settings, all from the environment (DESIGN.md §26.2):
// - TELEGRAM_BOT_TOKEN: the bot's token from @BotFather. Unset, the bridge does nothing (telegram.pb.js).
// - TELEGRAM_WEBHOOK_URL: this server's public https URL of POST /api/telegram/webhook. Unset, the bridge polls
//   Telegram instead (getUpdates), which is meant for development.
// - TELEGRAM_WEBHOOK_SECRET: what Telegram sends with each webhook call; derived from the token when unset.
// - TELEGRAM_API_BASE: the Bot API server (tests point it at a stub).

const env = (/** @type {string} */ name) => $os.getenv(name).trim();

function config() {
  const token = env("TELEGRAM_BOT_TOKEN");
  return {
    token,
    base: (env("TELEGRAM_API_BASE") || "https://api.telegram.org").replace(/\/+$/, ""),
    webhookUrl: env("TELEGRAM_WEBHOOK_URL"),
    secret: env("TELEGRAM_WEBHOOK_SECRET") || $security.sha256(`chat-telegram-webhook:${token}`),
  };
}

/** The updates the bridge asks for: a channel's posts come as channel_post, not message. Telegram sends
 * message_reaction only where the bot is an admin. */
const UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member", "message_reaction"];

/**
 * What a failed request's error says when it never reached Telegram: no connection was made (no address, refused,
 * unreachable, the connection or its TLS handshake failed or timed out). Anything else (no answer in time, the
 * connection lost or reset once made) may have reached it: a send may have been made.
 */
const UNSENT = /dial tcp|no such host|connection refused|network is unreachable|no route to host|tls handshake|tls: /i;

/** A refused or failed call. `retryAfter`: seconds Telegram asks to wait (429). `status` 0: no answer. */
class TelegramError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {number} [retryAfter]
   */
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.name = "TelegramError";
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** Worth trying again later: no answer, Telegram's own trouble, or too many requests. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /**
   * It may have done what it asked though it failed: no answer came (a timeout, a connection lost or reset), after
   * the request may have reached Telegram. Not when Telegram answered (it refused), nor when no connection was made.
   */
  get maybeDone() {
    return this.status === 0 && !UNSENT.test(this.message);
  }
}

/**
 * The error as a TelegramError, or null for anything else (a bug).
 * @param {unknown} err
 * @returns {TelegramError | null}
 */
const asTelegram = (err) => (err instanceof TelegramError ? err : null);

/**
 * Seconds an upload or download of `bytes` may take: enough at 200 KB/s, from 30 s up to 300 s. A connection that
 * stops answering fails within that, not after a fixed 5 minutes, which held the worker past its lock (§26.7).
 * @param {number} bytes
 */
const transferTimeout = (bytes) => Math.min(300, 30 + Math.ceil(bytes / 200_000));

/**
 * Call a Bot API method. Files (filesystem.File by field name) go as multipart, the other params as fields (objects
 * as JSON); without files the params are a JSON body.
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {Record<string, any>} [files]
 * @param {number} [timeout] seconds (with files: the upload's, transferTimeout)
 * @returns {any} the method's result
 */
function call(method, params = {}, files, timeout = 30) {
  const { token, base } = config();
  const url = `${base}/bot${token}/${method}`;
  /** @type {any} */
  let res;
  try {
    if (files && Object.keys(files).length) {
      // @ts-expect-error PocketBase's FormData (its types declare only the interface, there is no lib.dom here)
      const form = /** @type {FormData} */ (new FormData());
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      for (const [k, f] of Object.entries(files)) form.append(k, f);
      res = $http.send({ url, method: "POST", body: form, timeout });
    } else {
      res = $http.send({ url, method: "POST", body: JSON.stringify(params), headers: { "content-type": "application/json" }, timeout });
    }
  } catch (err) {
    throw new TelegramError(0, `${method}: ${String(err).replace(token, "<token>")}`);
  }
  const json = res.json;
  if (!json?.ok) {
    const description = json?.description || `HTTP ${res.statusCode}`;
    throw new TelegramError(res.statusCode || 500, `${method}: ${description}`, json?.parameters?.retry_after || 0);
  }
  return json.result;
}

/**
 * A stored name as PocketBase makes them ("report_k3j2h1g0f9.pdf"): the client tells images and videos by its
 * extension, so it is the original's, or else that of the path Telegram serves the file at.
 * @param {string} name
 * @param {string} path
 */
function storedName(name, path) {
  const ext = (/** @type {string} */ s) => (/\.([a-z0-9]{1,8})$/i.exec(s) || ["", ""])[1].toLowerCase();
  const base =
    name
      .replace(/\.[^.]*$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "file";
  const suffix = $security.randomStringWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789");
  const e = ext(name) || ext(path);
  return `${base}_${suffix}${e ? `.${e}` : ""}`;
}

/**
 * `fn` again at once, up to `tries` times in all, while it fails for now: for what may run twice (getFile, a
 * download). A failure that has to wait longer (429 with retry_after over 5 s) is left to the caller.
 * @template T
 * @param {() => T} fn
 * @param {number} [tries]
 * @returns {T}
 */
function retrying(fn, tries = 2) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      const tg = asTelegram(err);
      if (!tg?.transient || i >= tries || tg.retryAfter > 5) throw err;
      sleep(tg.retryAfter ? tg.retryAfter * 1000 : 500 * i);
    }
  }
}

/** getFile's timeout: a small call, which a connection that answers does at once. */
const GET_FILE_TIMEOUT = 10;

/**
 * Download a file the bot can see (at most 20 MB, the Bot API's limit), named `name`. A failure that may pass is
 * tried again at once: a connection that drops now and then fails one request, rarely two (§26.4).
 * @param {string} fileId
 * @param {string} name
 * @param {number} [size] its size, when Telegram said: how long the download may take
 */
function download(fileId, name, size = 0) {
  const { token, base } = config();
  const info = retrying(() => call("getFile", { file_id: fileId }, undefined, GET_FILE_TIMEOUT));
  if (!info?.file_path) throw new TelegramError(400, "getFile: no file_path");
  const timeout = transferTimeout(size || info.file_size || 20 * 1024 * 1024);
  const file = retrying(() => {
    try {
      return $filesystem.fileFromURL(`${base}/file/bot${token}/${info.file_path}`, timeout);
    } catch (err) {
      const text = String(err).replace(token, "<token>");
      // "failed to download url … (404)": Telegram answered.
      const status = Number((/\((\d{3})\)\s*$/.exec(text) || ["", "0"])[1]);
      throw new TelegramError(status, `download: ${text}`);
    }
  });
  file.originalName = name;
  file.name = storedName(name, info.file_path);
  return file;
}

module.exports = { config, call, download, asTelegram, TelegramError, transferTimeout, UPDATES };
