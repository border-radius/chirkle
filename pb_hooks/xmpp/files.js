/// <reference path="../../types/pocketbase.d.ts" />
// Files from XMPP (DESIGN.md §38.6): a message that is just a link to a file, with that link in its OOB element
// (XEP-0066), as XEP-0363 uploads are sent, has the file downloaded and attached. Anyone in a conference can send any
// link, so it is fetched as link previews fetch pages (lib/outbound.js): public addresses only, curl connecting to the
// address checked and no other, each redirect checked the same way. Unlike a page, any port: upload services often
// listen on their own (Prosody's 5281).

const { addressOf, allowedHosts, parse, publicHost, resolve } = require(`${__hooks}/lib/outbound.js`);
const { storedName } = require(`${__hooks}/lib/bridges.js`);

const TIMEOUT = 60;
const MAX_REDIRECTS = 3;
const UA = "Mozilla/5.0 (compatible; Chirkle XMPP bridge)";

/**
 * The link of a message that is just a file's link: its body, when that is also its OOB URL. "" otherwise.
 * @param {any} ev
 */
function fileLink(ev) {
  const body = String(ev.body || "").trim();
  const oob = Array.isArray(ev.oob) ? ev.oob.map(String) : [];
  return /^https?:\/\/\S+$/i.test(body) && oob.includes(body) ? body : "";
}

/** The largest attachment (files.file maxSize, §17.1, §37). */
const maxSize = (/** @type {core.App} */ app) =>
  /** @type {any} */ (app.findCollectionByNameOrId("files").fields.getByName("file")).maxSize || 20 * 1024 * 1024;

/**
 * The host and port to connect to for a URL: a public host (or one allowed for tests), and its address. Null when it
 * may not be fetched.
 * @param {{ scheme: string, host: string }} u
 */
function target(u) {
  const m = /^(.*?)(?::(\d+))?$/.exec(u.host);
  const name = m?.[1] || "";
  const port = Number(m?.[2] || (u.scheme === "https" ? 443 : 80));
  if (!name || port < 1 || port > 65535) return null;
  if (allowedHosts().includes(u.host)) return { ip: "", port };
  if (!publicHost(name)) return null;
  const ip = addressOf(name);
  return ip ? { ip, port } : null;
}

/**
 * Download the file a conference message links to, as a file to attach, named as the link's last part. Null when
 * it can't be (not a public address, too large, not there): the message keeps the link then. `done` removes the
 * download once it is saved.
 * @param {core.App} app
 * @param {string} url
 * @returns {{ file: filesystem.File, done: () => void } | null}
 */
function download(app, url) {
  const max = maxSize(app);
  const path = `${$os.tempDir()}/chirkle-xmpp-${$security.randomString(16)}`;
  const until = Date.now() + TIMEOUT * 1000;
  let at = url;
  let kept = false;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const u = parse(at);
      const t = u ? target(u) : null;
      const left = (until - Date.now()) / 1000;
      if (!u || !t || left < 1) return null;
      const args = ["-q", "--silent", "--globoff", "--noproxy", "*", "--proto", "=http,https", "--max-time", left.toFixed(1)];
      if (t.ip) args.push("--connect-to", `::${t.ip}:${t.port}`);
      args.push("--user-agent", UA, "--max-filesize", String(max), "--output", path);
      args.push("--write-out", "%{http_code} %{size_download} %{redirect_url}", "--url", u.origin + u.path);
      let out;
      try {
        out = toString($os.cmd("curl", ...args).output());
      } catch {
        return null; // no answer, or over max-filesize (curl's exit 63)
      }
      const [code, size, redirect] = out.trim().split(" ");
      const status = Number(code);
      if (status === 200) {
        if (Number(size) > max || Number(size) === 0) return null;
        const file = $filesystem.fileFromPath(path);
        const name = nameOf(at);
        file.originalName = name;
        file.name = storedName(name, u.path.replace(/[?#].*$/, ""));
        kept = true;
        return { file, done: () => remove(path) };
      }
      if (![301, 302, 303, 307, 308].includes(status) || !redirect) return null;
      at = resolve(redirect, at);
    }
    return null;
  } catch (err) {
    app.logger().warn("xmpp: download", "url", url, "error", String(err));
    return null;
  } finally {
    // What is returned is removed by done(), once the message is saved.
    if (!kept) remove(path);
  }
}

/** @param {string} path */
function remove(path) {
  try {
    $os.remove(path);
  } catch {
    // never written
  }
}

/**
 * A file's name from its link: the last part of its path, decoded. Upload services put the original name there.
 * @param {string} url
 */
function nameOf(url) {
  const last =
    (parse(url)?.path || "")
      .replace(/[?#].*$/, "")
      .split("/")
      .pop() || "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // as it is
  }
  // No control characters, no slashes.
  const kept = [...name].filter((c) => c.charCodeAt(0) >= 32 && c !== "/" && c !== "\\");
  return kept.slice(0, 120).join("").trim() || "file";
}

module.exports = { fileLink, download, nameOf };
