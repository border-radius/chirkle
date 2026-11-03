/// <reference path="../../types/pocketbase.d.ts" />
// Every response's security and cache headers, the built assets, and the client IP behind a proxy (DESIGN.md §5.6, §8.2).

const CSP = [
  "default-src 'self'",
  // The hash is index.html's inline theme script (web/src/theme.ts); tests/unit/build/csp.test.ts checks it.
  "script-src 'self' 'sha256-lMI93IRRLFIlto6GZfZdfPFeIgbs3CJfe2ncDiU/aWw='",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Security + cache headers for every response (§5.6).
 * @param {core.RequestEvent} e
 */
function headers(e) {
  const path = e.request?.url?.path ?? ""; // always set for a real request; optional in the generated types
  const h = e.response.header();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "same-origin");
  // The admin UI (/_/) relies on inline scripts/styles; the API serves JSON.
  if (!path.startsWith("/_/") && !path.startsWith("/api/")) {
    h.set("Content-Security-Policy", CSP);
    // Only content-hashed names (esbuild "[name]-[hash]", 8 chars) are immutable; dev builds are unhashed.
    if (/^\/assets\/.+-[A-Z0-9]{8}\.(js|css|woff2)(\.map)?$/.test(path)) h.set("Cache-Control", "public, max-age=31536000, immutable");
    else h.set("Cache-Control", "no-cache");
    // A page (the app's index.html, at any path without a file name): what it loads first.
    if (e.request?.method === "GET" && !path.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(path)) {
      const link = preloads();
      if (link) h.set("Link", link);
    }
  }
}

/**
 * index.html's assets as a Link header, read again by each JS runtime when index.html changes: a deploy may replace
 * pb_public/ while the server runs, and the last build's assets must not be preloaded (QA BUG-206).
 */
/** @type {string} */
let links = "";
/** index.html's modification time when `links` was read. */
let linksOf = "";

/**
 * What a page loads first (index.html's stylesheet, script and preloaded font), as a Link header: a proxy in front can
 * send it ahead of the page as 103 Early Hints, so the browser asks for them while the page is still on its way
 * (PERF.md §5). None while there is no index.html (not built yet).
 */
function preloads() {
  try {
    const file = $filepath.join(publicDir(), "index.html");
    const at = String($os.stat(file).modTime().unixNano());
    if (at === linksOf) return links;
    const html = toString($os.readFile(file));
    const out = [];
    for (const m of html.matchAll(/<(link|script)\b[^>]*?(?:href|src)="(\/assets\/[^"]+)"/g)) {
      const url = m[2];
      if (url.endsWith(".css")) out.push(`<${url}>; rel=preload; as=style`);
      else if (url.endsWith(".js")) out.push(`<${url}>; rel=modulepreload`);
      else if (url.endsWith(".woff2")) out.push(`<${url}>; rel=preload; as=font; type="font/woff2"; crossorigin`);
    }
    links = out.join(", ");
    linksOf = at;
  } catch {
    links = "";
    linksOf = "";
  }
  return links;
}

/** PocketBase's own request body limit, which every request but a message create keeps. */
const DEFAULT_BODY_LIMIT = 32 << 20;

/** A message create: 10 attachments of 20 MB (DESIGN.md §17.1), and room for the rest of the form. */
const MESSAGE_BODY_LIMIT = 10 * 20 * 1024 * 1024 + (1 << 20);

/**
 * The body limit is MESSAGE_BODY_LIMIT for every route (main.pb.js replaces PocketBase's default, as one route can't
 * have its own: the records API is PocketBase's): hold a body to the default anywhere but a message create, as
 * PocketBase's limiter does, counting what is read. Not by Content-Length alone: a chunked body has none (-1), and was
 * let through to MESSAGE_BODY_LIMIT, signups and logins too (QA BUG-143). The Android app sends chunked uploads when a
 * file's size is unknown, so those are limited, not refused. Goes on with the request (e.next) when within it.
 * @param {core.RequestEvent} e
 */
function bodyLimit(e) {
  const req = e.request;
  if (req?.method === "POST" && req.url?.path === "/api/collections/messages/records") return e.next();
  return $apis.bodyLimit(DEFAULT_BODY_LIMIT).func(e);
}

/** The directory the app is served from: `--publicDir`, else PocketBase's default, pb_public beside the executable. */
function publicDir() {
  const args = $os.args;
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--publicDir=")) return args[i].slice("--publicDir=".length);
    if (args[i] === "--publicDir") return args[i + 1];
  }
  return $filepath.join($filepath.dir(args[0]), "pb_public");
}

/**
 * GET /assets/{path...}: the built JS and CSS (§8.2). A missing file is a 404, not the app's index.html, which
 * PocketBase serves for any other path (§7.1). As index.html, an old build's lazy chunk (a tab still open across a
 * deploy) would fail as a script anyway, and its content-hashed URL would keep that HTML cached for a year.
 * @param {core.RequestEvent} e
 */
function asset(e) {
  const dir = $filepath.join(publicDir(), "assets");
  const path = e.request?.pathValue("path") ?? "";
  try {
    if (path.split("/").includes("..")) throw new Error("outside assets/");
    if ($os.stat($filepath.join(dir, path)).isDir()) throw new Error("a directory");
  } catch {
    e.response.header().set("Cache-Control", "no-store");
    throw new NotFoundError();
  }
  return $apis.static(dir, false)(e);
}

/**
 * Who the client is behind a reverse proxy (Dokku, nginx, Caddy…). PocketBase rate limits per client IP, and without a
 * trusted header every request comes from the proxy: each per-IP limit would be one limit for the whole site (a script
 * failing a login every 1.5 s would lock everyone out). `TRUSTED_PROXY` names the header the proxy sets, usually
 * X-Forwarded-For. Its rightmost address is used, the one the proxy itself added, so a client can't choose its own.
 * "off" clears it; unset leaves what the admin chose (Settings → Application). Only set it with a proxy in front:
 * otherwise clients send that header themselves and pick their IP.
 * @param {core.App} app
 */
function trustProxy(app) {
  const value = $os.getenv("TRUSTED_PROXY").trim();
  if (!value) return;
  const headers = value.toLowerCase() === "off" ? [] : [value];
  const settings = app.settings();
  const now = settings.trustedProxy;
  if (now.headers.join(",") === headers.join(",") && !now.useLeftmostIP) return;
  now.headers = headers;
  now.useLeftmostIP = false;
  app.save(settings);
}

module.exports = { headers, bodyLimit, asset, trustProxy, MESSAGE_BODY_LIMIT };
