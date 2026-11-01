// Dev loop: esbuild watch (unminified, unhashed) → pb_public/, plus `pocketbase serve --dev`.
// Ctrl-C stops both. Reload the browser manually after changes.

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";
import {
  ACCESS,
  BASE_OPTIONS,
  COLLECTIONS,
  injectAssets,
  MEDIA,
  OUTDIR,
  STATIC_DIR,
  SW_OPTIONS,
  VIEWER,
  viewerDefine,
} from "./lib/build-utils.mjs";

const PORT = process.env.PORT ?? "8090";

await mkdir(OUTDIR, { recursive: true });

/** @type {esbuild.Plugin} */
const writeIndex = {
  name: "write-index",
  setup(build) {
    build.onEnd(async (r) => {
      if (r.errors.length) return;
      const html = injectAssets(await readFile("web/index.html", "utf8"), {
        js: "assets/app.js",
        css: "assets/app.css",
      });
      await writeFile(`${OUTDIR}/index.html`, html);
      console.log(`[esbuild] rebuilt ${new Date().toLocaleTimeString()}`);
    });
  },
};

const ctx = await esbuild.context({
  ...BASE_OPTIONS,
  // Unhashed names, so the viewer's, the media grid's, the collections' and the access dialog's stylesheets can be built
  // alongside.
  entryPoints: [
    ...BASE_OPTIONS.entryPoints,
    { in: VIEWER.css, out: "viewer" },
    { in: MEDIA.css, out: "media" },
    { in: COLLECTIONS.css, out: "collections" },
    { in: ACCESS.css, out: "access" },
  ],
  define: viewerDefine("assets/viewer.css", "assets/media.css", "assets/collections.css", "assets/access.css"),
  sourcemap: "inline",
  entryNames: "assets/[name]",
  logLevel: "info",
  plugins: [writeIndex],
});
await ctx.watch();
await cp(STATIC_DIR, OUTDIR, { recursive: true });
const swCtx = await esbuild.context({ ...SW_OPTIONS, logLevel: "info" });
await swCtx.watch();

const pb = spawn(
  "bin/pocketbase",
  [
    "serve",
    "--dev",
    `--http=127.0.0.1:${PORT}`,
    "--dir=pb_data",
    `--publicDir=${OUTDIR}`,
    "--migrationsDir=pb_migrations",
    "--hooksDir=pb_hooks",
    "--hooksPool=100", // as in the Dockerfile: room pages enrich messages in parallel
  ],
  { stdio: "inherit" },
);

let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  pb.kill("SIGTERM");
  await ctx.dispose();
  await swCtx.dispose();
  process.exit(code);
};

pb.on("exit", (code) => {
  if (!stopping) {
    console.error(`pocketbase exited (${code}). Did you run \`npm run setup\`?`);
    void stop(code ?? 1);
  }
});
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
