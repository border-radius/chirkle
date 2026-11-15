/// <reference path="../../types/pocketbase.d.ts" />
// Between servers (DESIGN.md §33.6): signed requests both ways. Every request carries X-Fed-Origin (who calls),
// X-Fed-Date (unix seconds, within 5 minutes of now) and X-Fed-Signature, an HMAC of the method, path, date and the
// body's hash with the pair's secret. Outgoing requests go out with curl as link previews do (lib/previews.js): to
// the peer's paired origin only, https on a public address (lib/outbound.js checks it, then it is connected to), no
// redirects, bodies capped, with timeouts. FEDERATION_ALLOW_PRIVATE=1 lets tests use http on 127.0.0.1.

const { addressOf, parse, publicHost } = require(`${__hooks}/lib/outbound.js`);
const { allowPrivate, isActive, origin, peerByOrigin } = require(`${__hooks}/federation/config.js`);

/** How far a request's date may be from now. */
const SKEW_S = 300;
/** Biggest inbox body (§33.6), and the most of an answer read. */
const MAX_BODY = 256 * 1024;
const MAX_ANSWER = 1 << 20;
const UA = "ChirkleFederation/1.0";

/**
 * The signature of a request: hex HMAC-SHA256 of "method\npath\ndate\nsha256(body)".
 * @param {string} secret
 * @param {string} method
 * @param {string} path with its query
 * @param {string} date
 * @param {string} body
 */
const sign = (secret, method, path, date, body) => $security.hs256(`${method}\n${path}\n${date}\n${$security.sha256(body)}`, secret);

/**
 * @param {number} status
 * @param {string} message
 */
function httpError(status, message) {
  if (status === 401) return new UnauthorizedError(message);
  if (status === 403) return new ForbiddenError(message);
  if (status === 404) return new NotFoundError(message);
  if (status === 429) return new TooManyRequestsError(message);
  if (status === 503) return new ApiError(503, message);
  return new BadRequestError(message);
}

/**
 * Check a server request (§33.6) and return its peer and body. Throws 401 for a request that isn't signed right, 403
 * for a peer that isn't paired, 503 for one suspended here (it keeps its queue and tries again later, §33.7).
 * server/federation.go fedVerify is a Go copy for the GET downloads: change both, or neither (as `sign`).
 * @param {core.RequestEvent} e
 * @param {number} [max] body bytes
 * @returns {{ peer: core.Record, body: string }}
 */
function verify(e, max = MAX_BODY) {
  const req = /** @type {any} */ (e.request);
  const from = String(req.header.get("X-Fed-Origin") || "");
  const date = String(req.header.get("X-Fed-Date") || "");
  const got = String(req.header.get("X-Fed-Signature") || "");
  if (!from || !date || !got) throw httpError(401, "Not a signed request.");
  const peer = peerByOrigin(e.app, from);
  const st = peer?.getString("status");
  if (!peer?.getString("secret") || (st !== "active" && st !== "suspended")) throw httpError(403, "Not paired.");
  const at = Number(date);
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > SKEW_S) throw httpError(401, "The request is too old.");
  let body = "";
  if (req.method !== "GET") {
    const bytes = toBytes(req.body, max + 1);
    if (bytes.length > max) throw new ApiError(413, "The request is too big.");
    body = toString(bytes);
  }
  const path = req.url.path + (req.url.rawQuery ? `?${req.url.rawQuery}` : "");
  if (!$security.equal(sign(peer.getString("secret"), req.method, path, date, body), got)) throw httpError(401, "Wrong signature.");
  if (!isActive(peer)) throw httpError(503, "Suspended.");
  return { peer, body };
}

/**
 * Where to connect for an origin: { url parts, ip }. Throws when the server may not go there.
 * @param {string} o
 */
function target(o) {
  const u = parse(o);
  if (!u) throw new Error("not an http(s) origin");
  if (allowPrivate()) return { u, ip: "" };
  if (u.scheme !== "https") throw new Error("peers are reached over https only");
  if (!publicHost(u.host)) throw new Error("not a public host");
  const ip = addressOf(u.host);
  if (!ip) throw new Error("not a public address");
  return { u, ip };
}

/**
 * @typedef {{ status: number, headers: Record<string, string>, body: string }} Answer
 */

/**
 * One request with curl. `out`: a file the body goes to (at most `max` bytes, else it fails); without it the body is
 * read, `max` bytes at most. Throws when there is no answer.
 * @param {string} url
 * @param {string} ip "" to let curl look the host up (FEDERATION_ALLOW_PRIVATE)
 * @param {{ method: string, headers: Record<string, string>, body?: string, out?: string, max: number, seconds: number }} o
 * @returns {Answer}
 */
function curl(url, ip, o) {
  const tmp = `${$os.tempDir()}/chirkle-fed-${$security.randomString(16)}`;
  const head = `${tmp}.head`;
  const data = `${tmp}.body`;
  const u = /** @type {NonNullable<ReturnType<typeof parse>>} */ (parse(url));
  const args = ["-q", "--silent", "--globoff", "--noproxy", "*", "--proto", "=http,https", "--max-time", o.seconds.toFixed(1)];
  if (ip) args.push("--connect-to", `::${ip}:${u.scheme === "https" ? 443 : 80}`);
  args.push("--user-agent", UA, "--request", o.method);
  for (const [k, v] of Object.entries(o.headers)) args.push("--header", `${k}: ${v}`);
  if (o.body !== undefined) {
    $os.writeFile(data, o.body, /** @type {any} */ (0o600));
    args.push("--data-binary", `@${data}`);
  }
  args.push("--dump-header", head);
  if (o.out) args.push("--max-filesize", String(o.max), "--output", o.out);
  else args.push("--output", "-");
  args.push("--url", url);
  try {
    const cmd = $os.cmd("curl", ...args);
    let body = "";
    if (o.out) {
      try {
        cmd.run();
      } catch {
        // the headers tell (a body over the limit has a status but no file)
      }
    } else {
      const pipe = cmd.stdoutPipe();
      cmd.start();
      try {
        body = toString(toBytes(pipe, o.max));
      } finally {
        try {
          cmd.process?.kill();
        } catch {
          // done already
        }
        try {
          cmd.wait();
        } catch {
          // killed, or failed: the headers tell
        }
      }
    }
    let status = 0;
    /** @type {Record<string, string>} */
    let headers = Object.create(null);
    let raw = "";
    try {
      raw = toString($os.readFile(head));
    } catch {
      raw = "";
    }
    for (const line of raw.split(/\r?\n/)) {
      const s = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
      if (s) {
        status = Number(s[1]);
        headers = Object.create(null);
        continue;
      }
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim().toLowerCase();
      if (colon > 0 && !(name in headers)) headers[name] = line.slice(colon + 1).trim();
    }
    if (!status) throw new Error("no answer");
    return { status, headers, body };
  } finally {
    for (const f of [head, data]) {
      try {
        $os.remove(f);
      } catch {
        // never written
      }
    }
  }
}

/**
 * A signed request to a peer: path ("/api/fed/inbox"), body (JSON, for POST). Returns the answer; throws when there
 * is none (the peer is down, or can't be reached from here).
 * @param {core.Record} peer
 * @param {string} method
 * @param {string} path with its query
 * @param {unknown} [json]
 * @param {{ out?: string, max?: number, seconds?: number }} [opts]
 * @returns {Answer}
 */
function call(peer, method, path, json, opts = {}) {
  const { u, ip } = target(peer.getString("origin"));
  const body = json === undefined ? "" : JSON.stringify(json);
  const date = String(Math.floor(Date.now() / 1000));
  /** @type {Record<string, string>} */
  const headers = {
    "X-Fed-Origin": origin(),
    "X-Fed-Date": date,
    "X-Fed-Signature": sign(peer.getString("secret"), method, path, date, body),
  };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  return curl(u.origin + path, ip, {
    method,
    headers,
    body: json === undefined ? undefined : body,
    out: opts.out,
    max: opts.max ?? MAX_ANSWER,
    seconds: opts.seconds ?? 20,
  });
}

/**
 * An unsigned POST for pairing (§33.3): there is no secret yet, the code says who it is. To `o` only, which is where
 * the code may go: it is the address its admin typed in (or the one that asked, checked by asking it back).
 * @param {string} o its origin
 * @param {"/api/fed/request" | "/api/fed/verify" | "/api/fed/pair" | "/api/fed/cancel"} path
 * @param {Record<string, unknown>} json
 * @param {number} [seconds]
 * @returns {Answer}
 */
function pairing(o, path, json, seconds = 20) {
  const { u, ip } = target(o);
  return curl(`${u.origin}${path}`, ip, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
    max: MAX_ANSWER,
    seconds,
  });
}

/**
 * An answer's JSON body, or null.
 * @param {Answer} a
 */
function jsonBody(a) {
  try {
    return JSON.parse(a.body);
  } catch {
    return null;
  }
}

/**
 * The error message of an answer that isn't 2xx: PocketBase's "message", else the status.
 * @param {Answer} a
 */
function errorOf(a) {
  const j = jsonBody(a);
  return `${a.status}${j && typeof j.message === "string" ? ` ${j.message.slice(0, 300)}` : ""}`;
}

module.exports = { MAX_BODY, sign, verify, target, call, pairing, jsonBody, errorOf, httpError };
