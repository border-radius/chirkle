// Production build: web/ → pb_public/ (hashed assets + index.html), then enforce the size budget (DESIGN.md §7.7).

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
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
  latinFont,
  MEDIA,
  OUTDIR,
  outputOf,
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

const result = await esbuild.build({
  ...BASE_OPTIONS,
  ...shared,
  define: viewerDefine(viewerCssPath, mediaCssPath, collCssPath, accessCssPath, emojiCssPath, inboxCssPath),
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

const gz = async (/** @type {string} */ path) => gzipSync(await readFile(`${OUTDIR}/${path}`), { level: 9 }).length;
/** @type {Record<string, string>} */
const cssOf = {
  [VIEWER.css]: viewerCssPath,
  [MEDIA.css]: mediaCssPath,
  [COLLECTIONS.css]: collCssPath,
  [ACCESS.css]: accessCssPath,
  [EMOJI.css]: emojiCssPath,
  [INBOX.css]: inboxCssPath,
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
