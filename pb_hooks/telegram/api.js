/// <reference path="../../types/pocketbase.d.ts" />
// Telegram Bot API client and the bridge's settings, all from the environment (DESIGN.md §26.2):
// - TELEGRAM_BOT_TOKEN: the bot's token from @BotFather. Unset, the bridge does nothing (telegram.pb.js).
// - TELEGRAM_WEBHOOK_URL: this server's public https URL of POST /api/telegram/webhook. Unset, the bridge polls
//   Telegram instead (getUpdates), which is meant for development.
// - TELEGRAM_WEBHOOK_SECRET: what Telegram sends with each webhook call; derived from the token when unset.
// - TELEGRAM_API_BASE: the Bot API server (tests point it at a stub).

const { storedName } = require(`${__hooks}/lib/bridges.js`);

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
}

/**
 * The error as a TelegramError, or null for anything else (a bug).
 * @param {unknown} err
 * @returns {TelegramError | null}
 */
const asTelegram = (err) => (err instanceof TelegramError ? err : null);

/**
 * Call a Bot API method. Files (filesystem.File by field name) go as multipart, the other params as fields (objects
 * as JSON); without files the params are a JSON body.
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {Record<string, any>} [files]
 * @param {number} [timeout] seconds
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
      res = $http.send({ url, method: "POST", body: form, timeout: Math.max(timeout, 300) });
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
 * Download a file the bot can see (at most 20 MB, the Bot API's limit), named `name`.
 * @param {string} fileId
 * @param {string} name
 */
function download(fileId, name) {
  const { token, base } = config();
  const info = call("getFile", { file_id: fileId });
  if (!info?.file_path) throw new TelegramError(400, "getFile: no file_path");
  let file;
  try {
    file = $filesystem.fileFromURL(`${base}/file/bot${token}/${info.file_path}`, 120);
  } catch (err) {
    throw new TelegramError(0, `download: ${String(err).replace(token, "<token>")}`);
  }
  file.originalName = name;
  file.name = storedName(name, info.file_path);
  return file;
}

module.exports = { config, call, download, asTelegram, TelegramError, UPDATES };
