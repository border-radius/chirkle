import { describe, expect, it } from "vitest";
import { eagerChunks, entryOutputs, injectAssets, latinFont, staticImports, viewerDefine } from "../../../scripts/lib/build-utils.mjs";

const template = `<!doctype html><head><!--CSS--></head><body><div id="app"></div><!--JS--></body>`;

describe("injectAssets", () => {
  it("replaces placeholders with absolute hashed asset paths", () => {
    const html = injectAssets(template, { js: "assets/app-AB12.js", css: "assets/app-CD34.css" });
    expect(html).toContain(`<link rel="stylesheet" href="/assets/app-CD34.css">`);
    expect(html).toContain(`<script type="module" src="/assets/app-AB12.js"></script>`);
    expect(html).not.toContain("<!--");
  });

  it("puts the stylesheet in head and the script where the placeholder was", () => {
    const html = injectAssets(template, { js: "assets/a.js", css: "assets/a.css" });
    expect(html.indexOf("a.css")).toBeLessThan(html.indexOf("</head>"));
    expect(html.indexOf("a.js")).toBeGreaterThan(html.indexOf(`<div id="app">`));
  });

  it("preloads the font before the stylesheet, which would ask for it only once in (PERF.md §5)", () => {
    const html = injectAssets(template, { js: "assets/a.js", css: "assets/a.css", font: "assets/inter-latin-EF56.woff2" });
    expect(html).toContain(`<link rel="preload" href="/assets/inter-latin-EF56.woff2" as="font" type="font/woff2" crossorigin>`);
    expect(html.indexOf("inter-latin")).toBeLessThan(html.indexOf("a.css"));
    expect(injectAssets(template, { js: "a.js", css: "a.css" })).not.toContain("preload");
  });

  it("throws when a placeholder is missing", () => {
    expect(() => injectAssets("<head><!--CSS--></head>", { js: "a.js", css: "a.css" })).toThrow(/<!--JS-->/);
    expect(() => injectAssets("<body><!--JS--></body>", { js: "a.js", css: "a.css" })).toThrow(/<!--CSS-->/);
  });
});

describe("injectAssets with chunks", () => {
  it("modulepreloads the chunks the script imports, right after it", () => {
    const html = injectAssets("<head><!--CSS--><!--JS--></head>", {
      js: "assets/app.js",
      css: "assets/app.css",
      chunks: ["assets/chunk-A.js", "assets/chunk-B.js"],
    });
    expect(html).toContain(
      '<script type="module" src="/assets/app.js"></script>\n<link rel="modulepreload" href="/assets/chunk-A.js">\n<link rel="modulepreload" href="/assets/chunk-B.js">',
    );
  });
});

describe("latinFont", () => {
  it("finds the Latin Inter, not its extended or other scripts' subsets", () => {
    const outputs = Object.fromEntries(
      ["inter-latin-ext-AB12CD34", "inter-cyrillic-EF56GH78", "inter-latin-IJ90KL12"].map((n) => [`pb_public/assets/${n}.woff2`, {}]),
    );
    expect(latinFont({ outputs }, "pb_public")).toBe("assets/inter-latin-IJ90KL12.woff2");
  });
});

describe("entryOutputs", () => {
  const metafile = {
    inputs: {},
    outputs: {
      "pb_public/assets/app-AB12.js": { entryPoint: "web/src/main.ts" },
      "pb_public/assets/app-AB12.js.map": {},
      "pb_public/assets/chunk-XY.js": {},
      "pb_public/assets/app-CD34.css": { entryPoint: "web/styles/app.css" },
    },
  };

  it("finds the js and css entry outputs relative to outdir", () => {
    expect(entryOutputs(metafile, "pb_public", { js: "web/src/main.ts", css: "web/styles/app.css" })).toEqual({
      js: "assets/app-AB12.js",
      css: "assets/app-CD34.css",
    });
  });

  it("throws when an entry has no output", () => {
    expect(() => entryOutputs(metafile, "pb_public", { js: "web/src/other.ts", css: "web/styles/app.css" })).toThrow(/web\/src\/other\.ts/);
  });
});

describe("staticImports", () => {
  const metafile = {
    outputs: {
      "pb_public/assets/app-AB12.js": {
        imports: [
          { path: "pb_public/assets/viewer-EF56.js", kind: "dynamic-import" },
          { path: "pb_public/assets/chunk-XY.js", kind: "import-statement" },
        ],
      },
      "pb_public/assets/main-GH78.js": { imports: [{ path: "pb_public/assets/viewer-EF56.js", kind: "dynamic-import" }] },
    },
  };

  it("lists the chunks an output loads up front, not the lazy ones", () => {
    expect(staticImports(metafile, "pb_public", "assets/app-AB12.js")).toEqual(["pb_public/assets/chunk-XY.js"]);
    expect(staticImports(metafile, "pb_public/", "assets/main-GH78.js")).toEqual([]);
  });
});

describe("eagerChunks", () => {
  it("lists every chunk an output loads up front, through the chunks it imports, never a lazy one", () => {
    const metafile = {
      outputs: {
        "pb_public/assets/app-AB12.js": {
          imports: [
            { path: "pb_public/assets/chunk-B.js", kind: "import-statement" },
            { path: "pb_public/assets/viewer-EF56.js", kind: "dynamic-import" },
            { path: "pb_public/assets/chunk-A.js", kind: "import-statement" },
          ],
        },
        "pb_public/assets/chunk-A.js": { imports: [{ path: "pb_public/assets/chunk-C.js", kind: "import-statement" }] },
        "pb_public/assets/chunk-B.js": { imports: [{ path: "pb_public/assets/chunk-A.js", kind: "import-statement" }] },
        "pb_public/assets/chunk-C.js": { imports: [] },
        "pb_public/assets/viewer-EF56.js": { imports: [{ path: "pb_public/assets/chunk-D.js", kind: "import-statement" }] },
      },
    };
    expect(eagerChunks(metafile, "pb_public", "assets/app-AB12.js")).toEqual([
      "assets/chunk-A.js",
      "assets/chunk-B.js",
      "assets/chunk-C.js",
    ]);
    expect(eagerChunks(metafile, "pb_public/", "assets/viewer-EF56.js")).toEqual(["assets/chunk-D.js"]);
  });
});

describe("viewerDefine", () => {
  it("defines the viewer's, the media grid's, the collections', the access dialog's, the emoji picker's and the inbox's stylesheet URLs as string literals", () => {
    expect(
      viewerDefine(
        "assets/viewer-AB12.css",
        "assets/media-CD34.css",
        "assets/collections-EF56.css",
        "assets/access-GH78.css",
        "assets/emoji-IJ90.css",
        "assets/inbox-KL12.css",
      ),
    ).toEqual({
      VIEWER_CSS: '"/assets/viewer-AB12.css"',
      MEDIA_CSS: '"/assets/media-CD34.css"',
      COLLECTIONS_CSS: '"/assets/collections-EF56.css"',
      ACCESS_CSS: '"/assets/access-GH78.css"',
      EMOJI_CSS: '"/assets/emoji-IJ90.css"',
      INBOX_CSS: '"/assets/inbox-KL12.css"',
    });
  });
});
