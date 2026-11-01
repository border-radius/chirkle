// Production build: web/ → pb_public/ (hashed assets + index.html), then enforce the size budget.

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import {
  ACCESS,
  BASE_OPTIONS,
  COLLECTIONS,
  checkBudget,
  ENTRIES,
  entryOutputs,
  formatSizes,
  injectAssets,
  MEDIA,
  NOTIFY,
  OUTDIR,
  outputOf,
  SEARCH,
  STATIC_DIR,
  SW_OPTIONS,
  staticImports,
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
  ],
  bundle: true,
  outdir: OUTDIR,
});
const viewerCssPath = outputOf(viewerCss.metafile, OUTDIR, VIEWER.css);
const mediaCssPath = outputOf(viewerCss.metafile, OUTDIR, MEDIA.css);
const collCssPath = outputOf(viewerCss.metafile, OUTDIR, COLLECTIONS.css);
const accessCssPath = outputOf(viewerCss.metafile, OUTDIR, ACCESS.css);

const result = await esbuild.build({
  ...BASE_OPTIONS,
  ...shared,
  define: viewerDefine(viewerCssPath, mediaCssPath, collCssPath, accessCssPath),
});

const assets = entryOutputs(result.metafile, OUTDIR, ENTRIES);
const eager = staticImports(result.metafile, OUTDIR, assets.js);
if (eager.length) {
  console.error(`${assets.js} imports shared chunks (${eager.join(", ")}): lazy modules must not import its modules (DESIGN.md §17.7)`);
  process.exit(1);
}
await esbuild.build({ ...SW_OPTIONS, minify: true, legalComments: "none", logLevel: "warning" });
await cp(STATIC_DIR, OUTDIR, { recursive: true });

const html = injectAssets(await readFile("web/index.html", "utf8"), assets);
await writeFile(`${OUTDIR}/index.html`, html);

const gz = async (/** @type {string} */ path) => gzipSync(await readFile(path), { level: 9 }).length;
const sizes = {
  js: await gz(`${OUTDIR}/${assets.js}`),
  css: await gz(`${OUTDIR}/${assets.css}`),
  html: gzipSync(html, { level: 9 }).length,
  viewerJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, VIEWER.js)}`),
  viewerCss: await gz(`${OUTDIR}/${viewerCssPath}`),
  searchJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, SEARCH.js)}`),
  accessJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, ACCESS.js)}`),
  accessCss: await gz(`${OUTDIR}/${accessCssPath}`),
  mediaJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, MEDIA.js)}`),
  mediaCss: await gz(`${OUTDIR}/${mediaCssPath}`),
  collJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, COLLECTIONS.js)}`),
  collCss: await gz(`${OUTDIR}/${collCssPath}`),
  notifyJs: await gz(`${OUTDIR}/${outputOf(result.metafile, OUTDIR, NOTIFY.js)}`),
};

console.log(`built ${OUTDIR}/ (gzipped):\n${formatSizes(sizes)}`);
const over = checkBudget(sizes);
if (over.length) {
  console.error(`\nsize budget exceeded: ${over.join(", ")} (DESIGN.md §7.7)`);
  process.exit(1);
}
