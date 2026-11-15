// The routes' answers (shared/schema/answers.json, docs/REFACTOR.md item 54) and a checker for the part of JSON Schema
// that file uses: type, enum, const, pattern, minimum, properties, required, additionalProperties, items, minItems,
// maxItems, anyOf, allOf and $ref to "#/$defs/…". Small on purpose (no dependency); a keyword it doesn't know fails
// loudly instead of passing.

import answers from "../../shared/schema/answers.json" with { type: "json" };

export type Schema = { [key: string]: unknown };

interface Route {
  schema: Schema;
  examples: unknown[];
}

export const ROUTES = answers.routes as unknown as Record<string, Route>;
const ROOT = answers as unknown as Schema;

const KNOWN = new Set([
  "$comment",
  "$ref",
  "type",
  "enum",
  "const",
  "pattern",
  "minimum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "anyOf",
  "allOf",
]);

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

function resolve(ref: string): Schema {
  const m = /^#\/\$defs\/([\w-]+)$/.exec(ref);
  const def = m && (ROOT.$defs as Record<string, Schema>)[m[1]!];
  if (!def) throw new Error(`schema: unknown $ref ${ref}`);
  return def;
}

/** What is wrong with `value` against `schema`, each as "path: why"; empty when it fits. */
export function check(schema: Schema, value: unknown, path = "$"): string[] {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema: keyword ${k} isn't supported (at ${path})`);
  if (typeof schema.$ref === "string") return check(resolve(schema.$ref), value, path);
  const errors: string[] = [];
  const t = typeOf(value);

  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!want.some((w) => w === t || (w === "number" && t === "integer"))) return [`${path}: ${t}, not ${want.join(" or ")}`];
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${path}: ${JSON.stringify(value)}, not ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !(schema.enum as unknown[]).some((e) => e === value)) {
    errors.push(`${path}: ${JSON.stringify(value)}, not one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof schema.pattern === "string" && typeof value === "string" && !new RegExp(schema.pattern, "u").test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} doesn't match ${schema.pattern}`);
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} < ${schema.minimum}`);
  }
  if (schema.anyOf) {
    const each = (schema.anyOf as Schema[]).map((s) => check(s, value, path));
    if (each.every((e) => e.length > 0)) {
      // "null or X" with a value that isn't null: what is wrong with it as an X.
      const real = (schema.anyOf as Schema[]).flatMap((s, i) => (s.type === "null" ? [] : [each[i]!]));
      if (real.length === 1) errors.push(...real[0]!);
      else errors.push(`${path}: fits none of anyOf (${each.map((e) => e[0]).join("; ")})`);
    }
  }
  for (const s of (schema.allOf as Schema[] | undefined) ?? []) errors.push(...check(s, value, path));

  if (t === "array") {
    const arr = value as unknown[];
    if (typeof schema.minItems === "number" && arr.length < schema.minItems)
      errors.push(`${path}: ${arr.length} items < ${schema.minItems}`);
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems)
      errors.push(`${path}: ${arr.length} items > ${schema.maxItems}`);
    if (schema.items) {
      for (const [i, v] of arr.entries()) errors.push(...check(schema.items as Schema, v, `${path}[${i}]`));
    }
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in obj)) errors.push(`${path}: ${r} is missing`);
    for (const [k, v] of Object.entries(obj)) {
      const at = `${path}.${k}`;
      if (props[k]) errors.push(...check(props[k], v, at));
      else if (schema.additionalProperties === false) errors.push(`${at}: not in the schema`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...check(schema.additionalProperties as Schema, v, at));
      }
    }
  }
  return errors;
}

const patterns = Object.keys(ROUTES).map((key) => {
  const [method, path] = key.split(" ") as [string, string];
  return { key, method, re: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`) };
});

/** The answers.json route a request is for ("GET /api/chat/rooms/{room}/messages"), or undefined. */
export function routeOf(method: string, path: string): string | undefined {
  const m = method.toUpperCase();
  return patterns.find((p) => p.method === m && p.re.test(path))?.key;
}

/** Routes under /api/chat/ that answer no JSON (a file, or 204): not in answers.json. */
export const NOT_JSON = [
  /^GET \/api\/chat\/posters\//,
  /^DELETE \/api\/chat\/items\/[^/]+$/,
  /^POST \/api\/chat\/account\/delete$/,
  /^GET \/api\/chat\/export\/file$/,
];

/**
 * Checks a 2xx JSON answer of an /api/chat/* request against its route's schema; throws with what doesn't fit, or when
 * the route has no schema (add it to shared/schema/answers.json).
 */
export function checkAnswer(method: string, path: string, body: unknown): void {
  const key = routeOf(method, path);
  if (!key) {
    if (NOT_JSON.some((re) => re.test(`${method.toUpperCase()} ${path}`))) return;
    throw new Error(`${method} ${path} answered JSON but has no schema in shared/schema/answers.json`);
  }
  const errors = check(ROUTES[key]!.schema, body);
  if (errors.length) {
    throw new Error(`${key}: the answer doesn't fit shared/schema/answers.json:\n  ${errors.slice(0, 10).join("\n  ")}`);
  }
}
