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
 * Security + cache headers (§5.6), set by the routes that serve the app (page, asset, the manifest). Not by a router
 * middleware for every request (main.pb.js): PocketBase's own already sends nosniff with every API answer.
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
    if (e.request?.method === "GET" && path !== STATS_PATH && !path.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(path)) {
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
  headers(e);
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
 * GET /{path...}: the app's files in the public directory, and index.html at any path that isn't one (§7.1), as
 * PocketBase serves them when no route of ours does, with the headers.
 * @param {core.RequestEvent} e
 */
function page(e) {
  headers(e);
  return $apis.static(publicDir(), true)(e);
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

/** The usage statistics page (§40): a page of its own, not the app's. */
const STATS_PATH = "/stats";

/**
 * GET /stats: the statistics page (stats.html, built from web/stats.html), to anyone: it asks GET /api/chat/stats, which
 * only moderators and superusers get. Not built yet (the dev build has it too): a 404.
 * @param {core.RequestEvent} e
 */
function statsPage(e) {
  headers(e);
  /** @type {string} */
  let html;
  try {
    html = toString($os.readFile($filepath.join(publicDir(), "stats.html")));
  } catch {
    throw new NotFoundError();
  }
  return e.html(200, html);
}

module.exports = { headers, page, asset, statsPage, trustProxy };
