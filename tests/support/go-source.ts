// A string or number constant of the Go server (server/*.go), read from its source as the compiler would join it, for tests
// that check what the server runs (its SQL plans, its fields) without a Go toolchain.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(import.meta.dirname, "../../server");

/** Every non-test Go file's source, joined. */
const source = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");

/** The value of `const name = …` or `var name = …` (string literals, other such constants, strconv.Itoa of one, joined with +). */
export function goConst(name: string, src = source()): string {
  const m = new RegExp(`^(?:const|var) ${name}\\s*=\\s*([\\s\\S]*?)\\n(?=\\n|//|const |var |func |type )`, "m").exec(src);
  if (!m) throw new Error(`${name} not in server/*.go`);
  let out = "";
  for (const t of m[1]!.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"|strconv\.Itoa\((\w+)\)|(\d+)|(\w+)/g)) {
    if (t[1] !== undefined) out += t[1];
    else if (t[2] !== undefined) out += JSON.parse(`"${t[2]}"`);
    else if (t[3] !== undefined) out += goConst(t[3], src);
    else if (t[4] !== undefined) out += t[4];
    else if (t[5] !== undefined) out += goConst(t[5], src);
  }
  return out;
}
