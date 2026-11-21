// Production build: web/ → pb_public/ (hashed assets + index.html), then enforce the size budget (DESIGN.md §7.7).

import { readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { brotliCompressSync, gzipSync, constants as zlib } from "node:zlib";
import * as esbuild from "esbuild";
import {
  ACCESS,
  BASE_OPTIONS,
  COLLECTIONS,
  checkBudget,
  EMOJI,
  ENTRIES,
  eagerChunks,
  entryOutputs,
  FEATURES,
  formatSizes,
  INBOX,
  injectAssets,
  inlineStringsPlugin,
  latinFont,
  MEDIA,
  OUTDIR,
  outputOf,
  PROFILE,
  STATIC_DIR,
  STATS,
  STATS_OPTIONS,
  SW_OPTIONS,
  VIEWER,
  viewerDefine,
} from "./lib/build-utils.mjs";

await rm(OUTDIR, { recursive: true, force: true });
await mkdir(OUTDIR, { recursive: true });

/** @satisfies {import("esbuild").BuildOptions} */
const shared = {
  minify: true,
  sourcemap: "linked",
  entryNames: "assets/[name]-[hash]",
  metafile: true,
  legalComments: "none",
  logLevel: "warning",
  // The text constants inlined where they are used (web/src/strings/, docs/REFACTOR.md item 56).
  plugins: [inlineStringsPlugin((p) => readFileSync(p, "utf8"))],
};

// The viewer's and the media grid's stylesheets first: the app's build needs their hashed names.
const viewerCss = await esbuild.build({
  ...shared,
  entryPoints: [
    { in: VIEWER.css, out: "viewer" },
    { in: MEDIA.css, out: "media" },
    { in: COLLECTIONS.css, out: "collections" },
    { in: ACCESS.css, out: "access" },
    { in: EMOJI.css, out: "emoji" },
    { in: INBOX.css, out: "inbox" },
    { in: PROFILE.css, out: "account" },
  ],
  bundle: true,
  outdir: OUTDIR,
});
const viewerCssPath = outputOf(viewerCss.metafile, OUTDIR, VIEWER.css);
const mediaCssPath = outputOf(viewerCss.metafile, OUTDIR, MEDIA.css);
const collCssPath = outputOf(viewerCss.metafile, OUTDIR, COLLECTIONS.css);
const accessCssPath = outputOf(viewerCss.metafile, OUTDIR, ACCESS.css);
const emojiCssPath = outputOf(viewerCss.metafile, OUTDIR, EMOJI.css);
const inboxCssPath = outputOf(viewerCss.metafile, OUTDIR, INBOX.css);
const accountCssPath = outputOf(viewerCss.metafile, OUTDIR, PROFILE.css);

const result = await esbuild.build({
  ...BASE_OPTIONS,
  ...shared,
  define: viewerDefine(viewerCssPath, mediaCssPath, collCssPath, accessCssPath, emojiCssPath, inboxCssPath, accountCssPath),
});

const assets = entryOutputs(result.metafile, OUTDIR, ENTRIES);
// The chunks of code app.js shares with lazy features: loaded with it, side by side (modulepreload).
const chunks = eagerChunks(result.metafile, OUTDIR, assets.js);
await esbuild.build({ ...SW_OPTIONS, minify: true, legalComments: "none", logLevel: "warning" });
await cp(STATIC_DIR, OUTDIR, { recursive: true });

const html = injectAssets(await readFile("web/index.html", "utf8"), { ...assets, chunks, font: latinFont(result.metafile, OUTDIR) });
await writeFile(`${OUTDIR}/index.html`, html);

// The statistics page (§40), built on its own.
const stats = await esbuild.build({ ...STATS_OPTIONS, ...shared });
const statsAssets = entryOutputs(stats.metafile, OUTDIR, STATS);
await writeFile(
  `${OUTDIR}/stats.html`,
  injectAssets(await readFile(STATS.html, "utf8"), { ...statsAssets, font: latinFont(stats.metafile, OUTDIR) }),
);

// Each script and stylesheet compressed once, here, at the best levels: the server sends the .br or .gz the browser
// takes in place of the file (server/compress.go, PERF.md §15), spending no CPU on them. Not the source maps (devtools
// only; the server gzips them if asked).
for (const name of await readdir(`${OUTDIR}/assets`)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const path = `${OUTDIR}/assets/${name}`;
  const data = await readFile(path);
  await writeFile(`${path}.gz`, gzipSync(data, { level: 9 }));
  await writeFile(
    `${path}.br`,
    brotliCompressSync(data, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: 11,
        [zlib.BROTLI_PARAM_SIZE_HINT]: data.length,
        [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
      },
    }),
  );
}

const gz = async (/** @type {string} */ path) => gzipSync(await readFile(`${OUTDIR}/${path}`), { level: 9 }).length;
/** @type {Record<string, string>} */
const cssOf = {
  [VIEWER.css]: viewerCssPath,
  [MEDIA.css]: mediaCssPath,
  [COLLECTIONS.css]: collCssPath,
  [ACCESS.css]: accessCssPath,
  [EMOJI.css]: emojiCssPath,
  [INBOX.css]: inboxCssPath,
  [PROFILE.css]: accountCssPath,
};

/** @type {Record<string, number>} */
const files = { "index.html": gzipSync(html, { level: 9 }).length };
for (const f of [assets.js, ...chunks, assets.css]) files[f] = await gz(f);
const critical = new Set([assets.js, ...chunks]);
/** @type {Record<string, number>} */
const features = {};
for (const [name, feature] of Object.entries(FEATURES)) {
  const js = outputOf(result.metafile, OUTDIR, feature.js);
  let n = 0;
  for (const f of [js, ...eagerChunks(result.metafile, OUTDIR, js)]) if (!critical.has(f)) n += await gz(f);
  if (feature.css) n += await gz(cssOf[feature.css] ?? "");
  features[name] = n;
}
const sizes = {
  critical: Object.values(files).reduce((a, n) => a + n, 0),
  files,
  features,
  stats: gzipSync(await readFile(`${OUTDIR}/stats.html`), { level: 9 }).length + (await gz(statsAssets.js)) + (await gz(statsAssets.css)),
};

console.log(`built ${OUTDIR}/ (gzipped):\n${formatSizes(sizes)}`);
const over = checkBudget(sizes);
if (over.length) {
  console.error(`\nsize budget exceeded: ${over.join(", ")} (DESIGN.md §7.7)`);
  process.exit(1);
}
