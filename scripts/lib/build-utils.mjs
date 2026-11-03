// Pure helpers for scripts/build.mjs. Kept side-effect free so they can be unit-tested.

/** @typedef {{ js: number, css: number, html: number, viewerJs: number, viewerCss: number, searchJs: number, accessJs: number, accessCss: number, mediaJs: number, mediaCss: number, collJs: number, collCss: number, notifyJs: number, emojiJs: number }} Sizes gzipped byte sizes */

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

/** The emoji picker (§20.4), with the emoji list: a lazy chunk. Its styles are in app.css. */
export const EMOJI = Object.freeze({ js: "web/src/ui/emoji-picker.ts" });

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
 */
export const viewerDefine = (cssPath, mediaCssPath, collCssPath, accessCssPath) => ({
  VIEWER_CSS: JSON.stringify(`/${cssPath}`),
  MEDIA_CSS: JSON.stringify(`/${mediaCssPath}`),
  COLLECTIONS_CSS: JSON.stringify(`/${collCssPath}`),
  ACCESS_CSS: JSON.stringify(`/${accessCssPath}`),
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
  // Lazy chunks (`import()`). Code they share with app.js would become a chunk app.js imports — one more request on
  // every page load — so build.mjs fails if app.js imports any (`staticImports`).
  splitting: true,
  chunkNames: "assets/[name]-[hash]",
  // Inter (web/fonts/), referenced by web/styles/app/fonts.css: copied next to the bundles under hashed names.
  loader: { ".woff2": "file" },
  assetNames: "assets/[name]-[hash]",
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

/** Gzipped size budget in bytes (DESIGN.md §7.7). */
export const BUDGET = Object.freeze({
  js: 49.75 * 1024,
  css: 11.05 * 1024,
  html: 1536,
  viewerJs: 4 * 1024,
  viewerCss: 1.5 * 1024,
  searchJs: 2 * 1024,
  accessJs: 3.1 * 1024,
  accessCss: 1.5 * 1024,
  mediaJs: 3 * 1024,
  mediaCss: 1024,
  collJs: 6.75 * 1024,
  collCss: 2 * 1024,
  notifyJs: 3 * 1024,
  emojiJs: 4.25 * 1024,
});

/**
 * @param {Sizes} sizes
 * @returns {(keyof Sizes)[]} names of assets over budget
 */
export function checkBudget(sizes) {
  return /** @type {(keyof Sizes)[]} */ (Object.keys(BUDGET)).filter((k) => sizes[k] > BUDGET[k]);
}

/** @param {Sizes} sizes */
export function formatSizes(sizes) {
  const kb = (/** @type {number} */ n) => `${(n / 1024).toFixed(2)} KB`;
  const over = new Set(checkBudget(sizes));
  return /** @type {(keyof Sizes)[]} */ (Object.keys(BUDGET))
    .map((k) => `${k.padEnd(10)}${kb(sizes[k]).padStart(9)} / ${kb(BUDGET[k])}${over.has(k) ? "  OVER" : ""}`)
    .join("\n");
}

/**
 * Replace the `<!--CSS-->` and `<!--JS-->` placeholders in the HTML template. `font`, the Latin Inter every page
 * draws its text in, is preloaded: otherwise it is asked for only once the stylesheet is in (PERF.md §5).
 * @param {string} template
 * @param {{ js: string, css: string, font?: string | undefined }} assets paths relative to the public dir
 */
export function injectAssets(template, assets) {
  for (const p of ["<!--CSS-->", "<!--JS-->"]) {
    if (!template.includes(p)) throw new Error(`index.html template is missing the ${p} placeholder`);
  }
  const font = assets.font ? `<link rel="preload" href="/${assets.font}" as="font" type="font/woff2" crossorigin>\n` : "";
  return template
    .replace("<!--CSS-->", `${font}<link rel="stylesheet" href="/${assets.css}">`)
    .replace("<!--JS-->", `<script type="module" src="/${assets.js}"></script>`);
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
