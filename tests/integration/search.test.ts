// Message search (§29): messages.text_key follows the text on every save, and a room's page with `q`
// (server/lists.go) finds its messages by it, case-insensitively beyond ASCII, as the filter apps from before the
// route send (shared/vectors/text.json's `legacy`) finds them through the list rules.

import { readFileSync } from "node:fs";
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import { pageOptions } from "../../web/src/api.ts";
import { searchQuery, searchWords } from "../../web/src/views/room/search.ts";
import { runSql } from "../support/sql.ts";
import { adminClient, client, newRoom, newUser, openDm, post, uniq } from "./helpers.ts";

type Before = { created: string; id: string };

/** A page of search results through the route. */
const page = (pb: PocketBase, room: string, words: string[], before?: Before, limit?: number) =>
  pb.send<RecordModel[]>(`/api/chat/rooms/${room}/messages`, { query: pageOptions(searchQuery(room, words, before), limit) });

/** The filter apps from before the route send for a search (Android's PageQuery.legacy()). */
function legacy(room: string, words: string[], before?: Before) {
  const params: Record<string, string> = { room };
  const parts = ["room = {:room}"];
  words.forEach((w, i) => {
    params[`w${i}`] = w.replace(/[\\%]/g, "\\$&");
    parts.push(`text_key ~ {:w${i}}`);
  });
  if (before) {
    Object.assign(params, before);
    parts.push("(created < {:created} || (created = {:created} && id < {:id}))");
  }
  return { filter: parts.join(" && "), params };
}

/** The texts of the messages `pb` finds in `room` for `q`, newest first; the old filter finds the same. */
async function search(pb: PocketBase, room: string, q: string, before?: Before) {
  const words = searchWords(q);
  const found = await page(pb, room, words, before);
  const old = legacy(room, words, before);
  const { items } = await pb
    .collection("messages")
    .getList(1, 50, { filter: pb.filter(old.filter, old.params), sort: "-created,-id", skipTotal: true });
  expect(found.map((m) => m.id)).toEqual(items.map((m) => m.id));
  return found.map((m) => m.text as string);
}

const keyOf = async (id: string) => (await (await adminClient()).collection("messages").getOne(id)).text_key;

describe("message search (§29)", () => {
  it("text_key is the folded text, whatever the client sends, and follows edits and deletes", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "Hello STRAßE Ｗｉｄｅ", { text_key: "forged" });
    expect(await keyOf(m.id)).toBe("hello strasse wide");
    await a.pb.collection("messages").update(m.id, { text: "Привет Мир" });
    expect(await keyOf(m.id)).toBe("привет мир");
    await a.pb.collection("messages").update(m.id, { text_key: "forged" });
    expect(await keyOf(m.id)).toBe("привет мир");
    await a.pb.collection("messages").update(m.id, { deleted: true });
    expect(await keyOf(m.id)).toBe("");
  });

  it("finds every word in any case, Unicode included, newest first, only in that room", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const other = await newRoom(a);
    const tag = uniq();
    await post(a, room.id, `${tag} Привет, мир`);
    await post(a, room.id, `${tag} the Straße is wide`);
    await post(a, room.id, `${tag} мир only`);
    await post(a, other.id, `${tag} Привет мир elsewhere`);
    expect(await search(a.pb, room.id, `${tag} привет МИР`)).toEqual([`${tag} Привет, мир`]);
    expect(await search(a.pb, room.id, "STRASSE")).toEqual([`${tag} the Straße is wide`]);
    expect(await search(a.pb, room.id, `  мир   ${tag} `)).toEqual([`${tag} мир only`, `${tag} Привет, мир`]);
    expect(await search(a.pb, room.id, "nothing-like-this")).toEqual([]);
    // The server folds and splits the words itself.
    const raw = await a.pb.send<RecordModel[]>(`/api/chat/rooms/${room.id}/messages`, {
      query: { q: `  ПРИВЕТ ${tag}  мир мир `, fields: "text" },
    });
    expect(raw.map((m) => m.text)).toEqual([`${tag} Привет, мир`]);
  });

  it("pages back from the last result", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    for (const n of [1, 2, 3]) await post(a, room.id, `needle ${n}`);
    const items = await page(a.pb, room.id, ["needle"], undefined, 2);
    expect(items.map((m) => m.text)).toEqual(["needle 3", "needle 2"]);
    const last = items[1]!;
    expect(await search(a.pb, room.id, "needle", { created: last.created, id: last.id })).toEqual(["needle 1"]);
  });

  it("% and _ are literal characters (QA BUG-34)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await post(a, room.id, "done 100%");
    await post(a, room.id, "done 1000");
    await post(a, room.id, "snake_case");
    await post(a, room.id, "snakeXcase");
    expect(await search(a.pb, room.id, "100%")).toEqual(["done 100%"]);
    expect(await search(a.pb, room.id, "%")).toEqual(["done 100%"]);
    expect(await search(a.pb, room.id, "snake_case")).toEqual(["snake_case"]);
  });

  it("so is \\, the escape character (QA BUG-112)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    for (const t of ["a\\%b", "\\\\server", "a\\_b", "a_b", "C:\\dir"]) await post(a, room.id, t);
    expect(await search(a.pb, room.id, "\\%")).toEqual(["a\\%b"]);
    expect(await search(a.pb, room.id, "\\_")).toEqual(["a\\_b"]);
    expect(await search(a.pb, room.id, "\\\\")).toEqual(["\\\\server"]);
    expect(await search(a.pb, room.id, "\\")).toEqual(["C:\\dir", "a\\_b", "\\\\server", "a\\%b"]);
  });

  it("finds İ as typed with i, both ways, also in keys stored before (QA BUG-113)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const tag = uniq();
    const m = await post(a, room.id, `${tag} İstanbul`);
    await post(a, room.id, `${tag} izmir`);
    expect(await keyOf(m.id)).toBe(`${tag} istanbul`);
    expect(await search(a.pb, room.id, "istanbul")).toEqual([`${tag} İstanbul`]);
    expect(await search(a.pb, room.id, "İZMİR")).toEqual([`${tag} izmir`]);
    // A key as 1760000024 stored it is fixed by the migration's statement.
    const migration = readFileSync("pb_migrations/1760000025_search_dotted_i.js", "utf8");
    const sql = /newQuery\("(UPDATE messages[^"]+)"\)/.exec(migration)![1]!;
    await runSql(inject("pbUrl"), [
      { sql: "UPDATE messages SET text_key = {:key} WHERE id = {:id}", params: { key: `${tag} i\u0307stanbul`, id: m.id } },
      { sql },
    ]);
    expect(await keyOf(m.id)).toBe(`${tag} istanbul`);
  });

  it("deleted messages aren't found", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await post(a, room.id, "secret plan");
    await a.pb.collection("messages").update(m.id, { deleted: true });
    expect(await search(a.pb, room.id, "secret")).toEqual([]);
  });

  it("finds nothing in a DM or private room you aren't in; guests search Open Air rooms only", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();
    const dm = await openDm(a, b);
    await post(a, dm.id, "dm secret");
    expect(await search(b.pb, dm.id, "secret")).toEqual(["dm secret"]);
    expect(await search(c.pb, dm.id, "secret")).toEqual([]);

    const priv = await a.pb.collection("rooms").create({ name: `private-${uniq()}`, created_by: a.user.id, visibility: "private" });
    await post(a, priv.id, "private secret");
    expect(await search(c.pb, priv.id, "secret")).toEqual([]);

    const open = await a.pb.collection("rooms").create({ name: `open-${uniq()}`, created_by: a.user.id, visibility: "open" });
    await post(a, open.id, "open words");
    const pub = await newRoom(a);
    await post(a, pub.id, "public words");
    expect(await search(client(), open.id, "words")).toEqual(["open words"]);
    expect(await search(client(), pub.id, "words")).toEqual([]);
  });
});
