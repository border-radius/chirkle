// Pure helpers for scripts/build.mjs. Kept side-effect free so they can be unit-tested.

/**
 * Gzipped byte sizes (DESIGN.md §7.7): what a visit loads before the app runs (`critical`: index.html, app.js, the
 * chunks app.js imports and app.css; `files` has each one's), what each lazy feature adds when first used (its chunk,
 * the chunks it imports that the critical path doesn't, and its stylesheet), and the statistics page's own files.
 * @typedef {{ critical: number, files: Record<string, number>, features: Record<string, number>, stats: number }} Sizes
 */

/** Where builds go: PocketBase serves this directory. */
export const OUTDIR = "pb_public";

/** Source entry points; both are bundled to assets/app.* (hashed in production). */
export const ENTRIES = Object.freeze({ js: "web/src/main.ts", css: "web/styles/app.css" });

/**
 * The image viewer (§17.7), kept out of the main bundle: its script is a lazy chunk (`import()`) and its stylesheet a
 * file of its own, which the script links when it first opens. It finds that file through the `VIEWER_CSS` define.
 */
export const VIEWER = Object.freeze({ js: "web/src/views/room/viewer.ts", css: "web/styles/viewer.css" });

/** Message search (§29): a lazy chunk too. Its few styles are in app.css. */
export const SEARCH = Object.freeze({ js: "web/src/views/room/search.ts" });

/** The room access dialog (§23.2, §33.10): a lazy chunk and a stylesheet it links (`ACCESS_CSS`). */
export const ACCESS = Object.freeze({ js: "web/src/views/room/access.ts", css: "web/styles/access.css" });

/** The media grid (§30): a lazy chunk and a stylesheet it links, like the viewer's (`MEDIA_CSS`). */
export const MEDIA = Object.freeze({ js: "web/src/views/room/media.ts", css: "web/styles/media.css" });

/** Media collections (§31): the page, the save menu and the picker, a lazy chunk with a stylesheet it links (`COLLECTIONS_CSS`). */
export const COLLECTIONS = Object.freeze({ js: "web/src/views/collection/lazy.ts", css: "web/styles/collections.css" });

/** Notifications (§34): following the messages and the profile page's settings, a lazy chunk. Its styles are in app.css. */
export const NOTIFY = Object.freeze({ js: "web/src/notify.ts" });

/**
 * The emoji picker (§20.4) and the composer's ":name" suggestions (§20.6), with the emoji list and their names: a lazy
 * chunk and a stylesheet it links (`EMOJI_CSS`).
 */
export const EMOJI = Object.freeze({ js: "web/src/ui/emoji-picker.ts", css: "web/styles/emoji.css" });

/** "Mentions & replies" (§41): the page, a lazy chunk with a stylesheet it links (`INBOX_CSS`). */
export const INBOX = Object.freeze({ js: "web/src/views/inbox.ts", css: "web/styles/inbox.css" });

/** The composer's "@" suggestions (§41): a lazy chunk; its list is styled by the emoji picker's stylesheet, which it links. */
export const MENTION = Object.freeze({ js: "web/src/ui/mention-suggest.ts" });

/** Pages and dialogs out of app.js (2026-11-10): settings, log in and sign up, forward, the people search. */
export const PROFILE = Object.freeze({ js: "web/src/views/profile.ts" });
export const LOGIN = Object.freeze({ js: "web/src/views/login.ts" });
export const FORWARD = Object.freeze({ js: "web/src/views/room/forward.ts" });
export const PEOPLE = Object.freeze({ js: "web/src/ui/user-search.ts" });

/** Jump to (§32): a lazy chunk. Its styles are in app.css. */
export const JUMP = Object.freeze({ js: "web/src/views/switcher.ts" });

/**
 * The lazy features, by the name the size report gives them: each one's chunk, and the stylesheet it links (if any).
 * @type {Readonly<Record<string, { js: string, css?: string }>>}
 */
export const FEATURES = Object.freeze({
  viewer: VIEWER,
  search: SEARCH,
  access: ACCESS,
  media: MEDIA,
  collections: COLLECTIONS,
  notify: NOTIFY,
  emoji: EMOJI,
  inbox: INBOX,
  mention: { js: MENTION.js, css: EMOJI.css },
  profile: PROFILE,
  login: LOGIN,
  forward: FORWARD,
  people: PEOPLE,
  jump: JUMP,
});

/**
 * The usage statistics page (§40): a page of its own, stats.html from this template, with its own script and
 * stylesheet. Built apart from the app (no chunks shared with it), so nothing of it is in app.js.
 */
export const STATS = Object.freeze({ html: "web/stats.html", js: "web/src/stats/main.ts", css: "web/styles/stats.css" });

/**
 * esbuild options for the statistics page, shared by `build` and `dev`.
 * @satisfies {import("esbuild").BuildOptions}
 */
export const STATS_OPTIONS = {
  entryPoints: [
    { in: STATS.js, out: "stats" },
    { in: STATS.css, out: "stats" },
  ],
  bundle: true,
  format: /** @type {const} */ ("esm"),
  target: "es2022",
  outdir: OUTDIR,
  loader: { ".woff2": "file" },
  assetNames: "assets/[name]-[hash]",
  external: ["/icons/*"],
};

/**
 * The service worker (§27): built on its own, unhashed, to the root of the public dir (a worker controls only the paths
 * under its own). It is a classic script, so an IIFE.
 * @satisfies {import("esbuild").BuildOptions}
 */
export const SW_OPTIONS = {
  entryPoints: ["web/src/sw.ts"],
  bundle: true,
  format: /** @type {const} */ ("iife"),
  target: "es2022",
  outfile: `${OUTDIR}/sw.js`,
};

/** Files copied as they are to the public dir: the icons the web app manifest and index.html name (§27). */
export const STATIC_DIR = "web/public";

/**
 * @param {string} cssPath the viewer stylesheet's path relative to the public dir
 * @param {string} mediaCssPath the media grid's (§30)
 * @param {string} collCssPath the collections' (§31)
 * @param {string} accessCssPath the room access dialog's (§23.2)
 * @param {string} emojiCssPath the emoji picker's (§20.4)
 * @param {string} inboxCssPath the inbox's (§41)
 */
export const viewerDefine = (cssPath, mediaCssPath, collCssPath, accessCssPath, emojiCssPath, inboxCssPath) => ({
  VIEWER_CSS: JSON.stringify(`/${cssPath}`),
  MEDIA_CSS: JSON.stringify(`/${mediaCssPath}`),
  COLLECTIONS_CSS: JSON.stringify(`/${collCssPath}`),
  ACCESS_CSS: JSON.stringify(`/${accessCssPath}`),
  EMOJI_CSS: JSON.stringify(`/${emojiCssPath}`),
  INBOX_CSS: JSON.stringify(`/${inboxCssPath}`),
});

/**
 * esbuild options shared by `build` and `dev`; each adds its own minify/sourcemap/naming.
 * @satisfies {import("esbuild").BuildOptions}
 */
export const BASE_OPTIONS = {
  entryPoints: [
    { in: ENTRIES.js, out: "app" },
    { in: ENTRIES.css, out: "app" },
  ],
  bundle: true,
  format: /** @type {const} */ ("esm"),
  target: "es2022",
  outdir: OUTDIR,
  // Lazy chunks (`import()`). Code they share with app.js becomes chunks app.js imports: index.html names them as
  // modulepreload, so they load side by side with it, and they count toward the critical path's budget.
  splitting: true,
  chunkNames: "assets/[name]-[hash]",
  // Inter (web/fonts/), referenced by web/styles/app/fonts.css: copied next to the bundles under hashed names.
  loader: { ".woff2": "file" },
  assetNames: "assets/[name]-[hash]",
  // The app icon (web/public/icons/, copied as is), which the logo in shell.css and login.css draws.
  external: ["/icons/*"],
};

/**
 * The Latin Inter's output (fonts.css's last face): the font index.html preloads.
 * @param {{ outputs: Record<string, unknown> }} metafile
 * @param {string} outdir
 */
export function latinFont(metafile, outdir) {
  const out = Object.keys(metafile.outputs).find((p) => /\/inter-latin-[A-Z0-9]+\.woff2$/.test(p));
  return out?.slice(outdir.length + 1);
}

/**
 * Gzipped size budget in bytes (DESIGN.md §7.7, REFACTOR item 52): one for what every visit loads before the app runs,
 * however it is split into files; one any lazy feature's first use stays under; one for the statistics page. Until
 * 2026-11-12 each file had its own (24 of them, app.js's raised about 40 times), and lazy chunks could share no code
 * with app.js. How fast it feels is checked by scripts/profile-web.ts (CI).
 */
export const BUDGET = Object.freeze({
  critical: 62.5 * 1024,
  feature: 16 * 1024,
  stats: 10 * 1024,
});

/**
 * @param {Sizes} sizes
 * @returns {string[]} what is over budget: "critical", "stats", or "feature <name>"
 */
export function checkBudget(sizes) {
  const over = [];
  if (sizes.critical > BUDGET.critical) over.push("critical");
  for (const [name, n] of Object.entries(sizes.features)) if (n > BUDGET.feature) over.push(`feature ${name}`);
  if (sizes.stats > BUDGET.stats) over.push("stats");
  return over;
}

/** @param {Sizes} sizes */
export function formatSizes(sizes) {
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(2)} KB`;
  const over = new Set(checkBudget(sizes));
  const flag = (/** @type {string} */ k) => (over.has(k) ? "  OVER" : "");
  const lines = [`critical path ${kb(sizes.critical).padStart(9)} / ${kb(BUDGET.critical)}${flag("critical")}`];
  for (const [file, n] of Object.entries(sizes.files)) lines.push(`  ${file.padEnd(40)}${kb(n).padStart(9)}`);
  lines.push(`lazy features (first use, each / ${kb(BUDGET.feature)}):`);
  for (const [name, n] of Object.entries(sizes.features)) lines.push(`  ${name.padEnd(40)}${kb(n).padStart(9)}${flag(`feature ${name}`)}`);
  lines.push(`stats page    ${kb(sizes.stats).padStart(9)} / ${kb(BUDGET.stats)}${flag("stats")}`);
  return lines.join("\n");
}

/**
 * Replace the `<!--CSS-->` and `<!--JS-->` placeholders in the HTML template. `font`, the Latin Inter every page
 * draws its text in, is preloaded: otherwise it is asked for only once the stylesheet is in (PERF.md §5). `chunks`,
 * the chunks the script imports (`eagerChunks`), are modulepreloaded beside it, so they don't wait for it to be
 * parsed; the server's Link header (pb_hooks/lib/http.js) and the service worker read them from here too.
 * @param {string} template
 * @param {{ js: string, css: string, font?: string | undefined, chunks?: string[] }} assets paths relative to the public dir
 */
export function injectAssets(template, assets) {
  for (const p of ["<!--CSS-->", "<!--JS-->"]) {
    if (!template.includes(p)) throw new Error(`index.html template is missing the ${p} placeholder`);
  }
  const font = assets.font ? `<link rel="preload" href="/${assets.font}" as="font" type="font/woff2" crossorigin>\n` : "";
  const chunks = (assets.chunks ?? []).map((c) => `\n<link rel="modulepreload" href="/${c}">`).join("");
  return template
    .replace("<!--CSS-->", `${font}<link rel="stylesheet" href="/${assets.css}">`)
    .replace("<!--JS-->", `<script type="module" src="/${assets.js}"></script>${chunks}`);
}

/**
 * Find the output files esbuild produced for the given entry points.
 * @param {{ outputs: Record<string, { entryPoint?: string }> }} metafile
 * @param {string} outdir
 * @param {{ js: string, css: string }} entries
 * @returns {{ js: string, css: string }} paths relative to outdir
 */
export function entryOutputs(metafile, outdir, entries) {
  return { js: outputOf(metafile, outdir, entries.js), css: outputOf(metafile, outdir, entries.css) };
}

/**
 * The output file esbuild produced for an entry point (or a lazy chunk's module, which esbuild records the same way).
 * @param {{ outputs: Record<string, { entryPoint?: string }> }} metafile
 * @param {string} outdir
 * @param {string} entry
 * @returns {string} path relative to outdir
 */
export function outputOf(metafile, outdir, entry) {
  const prefix = `${outdir.replace(/\/$/, "")}/`;
  const out = Object.entries(metafile.outputs).find(([, o]) => o.entryPoint === entry)?.[0];
  if (!out) throw new Error(`no esbuild output for entry ${entry}`);
  return out.startsWith(prefix) ? out.slice(prefix.length) : out;
}

/**
 * The files an output loads up front (static `import`s), as opposed to the lazy chunks it may `import()` later.
 * @param {{ outputs: Record<string, { imports?: { path: string, kind: string }[] }> }} metafile
 * @param {string} outdir
 * @param {string} output path relative to outdir
 * @returns {string[]}
 */
export function staticImports(metafile, outdir, output) {
  const imports = metafile.outputs[`${outdir.replace(/\/$/, "")}/${output}`]?.imports ?? [];
  return imports.filter((i) => i.kind === "import-statement").map((i) => i.path);
}

/**
 * Every chunk an output loads up front, its static imports' static imports too, in a stable order (relative to outdir).
 * @param {{ outputs: Record<string, { imports?: { path: string, kind: string }[] }> }} metafile
 * @param {string} outdir
 * @param {string} output path relative to outdir
 * @returns {string[]}
 */
export function eagerChunks(metafile, outdir, output) {
  const prefix = `${outdir.replace(/\/$/, "")}/`;
  /** @type {Set<string>} */
  const seen = new Set();
  const walk = (/** @type {string} */ out) => {
    for (const p of staticImports(metafile, outdir, out)) {
      const rel = p.startsWith(prefix) ? p.slice(prefix.length) : p;
      if (!seen.has(rel)) {
        seen.add(rel);
        walk(rel);
      }
    }
  };
  walk(output);
  return [...seen].sort();
}
