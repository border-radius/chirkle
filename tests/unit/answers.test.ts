// shared/schema/answers.json (docs/REFACTOR.md item 54): its examples fit its schemas, the checker catches what it
// should, and every /api/chat/* route the server defines has a schema (or answers no JSON). The integration tests check
// the real answers (tests/support/answers.ts); the app's ContractTest.kt decodes the examples with its models.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { check, NOT_JSON, ROUTES, routeOf } from "../support/schema.ts";

/** "METHOD /api/chat/…" for each route the hooks (routerAdd) and the Go server (add / e.Router.GET) define. */
function serverRoutes(): string[] {
  const found = new Set<string>();
  const hooks = readdirSync("pb_hooks").filter((f) => f.endsWith(".pb.js"));
  for (const f of hooks) {
    for (const m of readFileSync(`pb_hooks/${f}`, "utf8").matchAll(/routerAdd\(\s*"(\w+)",\s*"(\/api\/chat\/[^"]+)"/g))
      found.add(`${m[1]} ${m[2]}`);
  }
  const go = readdirSync("server").filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  for (const f of go) {
    const src = readFileSync(`server/${f}`, "utf8");
    for (const m of src.matchAll(/add\(http\.Method(\w+), "(\/api\/chat\/[^"]+)"/g)) found.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    for (const m of src.matchAll(/e\.Router\.(GET|POST|DELETE)\("(\/api\/chat\/[^"]+)"/g)) found.add(`${m[1]} ${m[2]}`);
    // The file routes (posters) are a map of path → handler.
    for (const m of src.matchAll(/^\s*"(\/api\/chat\/[^"]+)":\s+\w+\(.*\),$/gm)) found.add(`GET ${m[1]}`);
  }
  return [...found].sort();
}

describe("shared/schema/answers.json", () => {
  it.each(Object.entries(ROUTES))("%s: the examples fit", (_route, { schema, examples }) => {
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) expect(check(schema, ex)).toEqual([]);
  });

  it("names every /api/chat/* route the server has, and no other", () => {
    const routes = serverRoutes();
    expect(routes.length).toBeGreaterThan(20); // the scan still finds them
    const json = routes.filter((r) => !NOT_JSON.some((re) => re.test(r)));
    expect(json.filter((r) => !ROUTES[r])).toEqual([]);
    expect(Object.keys(ROUTES).filter((r) => !routes.includes(r))).toEqual([]);
  });

  it("finds a request's route", () => {
    expect(routeOf("get", "/api/chat/rooms/abc/messages")).toBe("GET /api/chat/rooms/{room}/messages");
    expect(routeOf("GET", "/api/chat/rooms")).toBe("GET /api/chat/rooms");
    expect(routeOf("POST", "/api/chat/rooms")).toBeUndefined();
    expect(routeOf("GET", "/api/chat/unread/r1")).toBe("GET /api/chat/unread/{room}");
  });

  it("says what doesn't fit", () => {
    const unread = ROUTES["GET /api/chat/unread"]!.schema;
    const ok = { at: "", rooms: {}, ids: [], inbox: 0, mentions: {} };
    expect(check(unread, ok)).toEqual([]);
    expect(check(unread, { ...ok, inbox: "1" })).toEqual(["$.inbox: string, not integer"]);
    expect(check(unread, { ...ok, rooms: { r: -1 } })).toEqual(["$.rooms.r: -1 < 0"]);
    expect(check(unread, { ...ok, extra: 1 })).toEqual(["$.extra: not in the schema"]);
    const { ids: _, ...noIds } = ok;
    expect(check(unread, noIds)).toEqual(["$: ids is missing"]);
    expect(check(unread, { ...ok, at: "2026-11-15T10:00:00Z" })[0]).toMatch(/^\$\.at: .* doesn't match/);

    const messages = ROUTES["GET /api/chat/rooms/{room}/messages"]!.schema;
    expect(check(messages, [{ id: "m00000000000001", file_dims: { a: [1] } }])).toEqual(["$[0].file_dims.a: 1 items < 2"]);
    const badges = ROUTES["GET /api/chat/badges"]!.schema;
    expect(check(badges, { c: null, d: { private: true } })).toEqual([]);
    expect(check(badges, { c: { private: false } })[0]).toMatch(/fits none of anyOf/);
  });

  it("refuses a keyword it doesn't check", () => {
    expect(() => check({ type: "string", format: "date" }, "x")).toThrow(/format isn't supported/);
  });
});
