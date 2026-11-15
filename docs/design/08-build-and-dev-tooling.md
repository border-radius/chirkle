# §8. Build and dev tooling

Part of the design document: [index](../DESIGN.md).

## 8.1 Dependencies

| Package | Kind | Purpose |
|---|---|---|
| `pocketbase` | dev | JS SDK, only for tests (admin and raw-API clients); the app uses `web/src/pb.ts` |
| `esbuild` | dev | bundling and minification |
| `typescript` | dev | type checking only (`tsc --noEmit`) |
| `vitest`, `happy-dom` | dev | unit, component and integration tests |
| `@playwright/test` | dev | e2e tests |

Nothing else. The server **binary** is not an npm dependency: `scripts/build-server.mjs` builds it from `server/` with Go (the version `server/go.mod` names) into `bin/chirkle-server`, PocketBase pinned by `go.sum`. The npm package ships it built for each platform it supports (`bin/release/<os>-<arch>/`, by `prepack`), so `npx chirkle` needs no Go.

## 8.2 `scripts/build.mjs`

```js
await esbuild.build({
  entryPoints: { app: "web/src/main.ts", "app.css": "web/styles/app.css" },
  bundle: true, minify: true, sourcemap: "linked",
  format: "esm", target: "es2022",
  entryNames: "assets/[name]-[hash]", outdir: "pb_public",
  metafile: true, legalComments: "none",
});
// (plus code splitting for lazy chunks, and web/styles/viewer.css built first: its hashed name is defined
//  into the app's build as VIEWER_CSS, §17.7 — see scripts/lib/build-utils.mjs)
// then: read metafile → rewrite web/index.html with hashed names → pb_public/index.html
// then: the chunks app.js imports → <link rel="modulepreload"> in index.html (§7.7)
// then: print gzipped sizes (the critical path, each lazy feature's first use, the stats page); exit 1 if over budget (§7.7)
```

## 8.3 npm scripts

| Script | Does |
|---|---|
| `setup` | `scripts/build-server.mjs` (needs Go) |
| `dev` | esbuild in watch mode (unminified, inline sourcemaps) writing to `pb_public/`, plus `bin/chirkle-server serve --dev`. Reload the browser by hand (live reload is not part of the MVP). |
| `build` | production build (§8.2) |
| `typecheck` | `tsc --noEmit` (`strict`, `noUncheckedIndexedAccess`) |
| `test` | unit tests |
| `test:int` | integration tests |
| `test:e2e` | build, then run Playwright |
| `check` | typecheck + test + test:int + build (what CI runs before e2e) |
