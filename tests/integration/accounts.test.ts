import { ClientResponseError } from "pocketbase";
import { describe, expect, inject, it } from "vitest";
import { type Api, createApi } from "../../web/src/api.ts";
import { newId } from "../../web/src/lib/id.ts";
import type { Message } from "../../web/src/lib/types.ts";
import { createClient } from "../../web/src/pb.ts";
import { client, eventually, expectRejected, newRoom, newUser, post, rawDb, status, uniq } from "./helpers.ts";

const PASSWORD = "password-123";

const signUpAs = (email: string, name = `Casey ${uniq()}`) =>
  client().collection("users").create({ email, password: PASSWORD, passwordConfirm: PASSWORD, name });

const realClient = (): Api => createApi(createClient(inject("pbUrl")));

const signUp = (name: string) =>
  client()
    .collection("users")
    .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name });

/** The field codes of a rejected SDK call. */
async function codes(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof ClientResponseError)) throw e;
    return Object.fromEntries(Object.entries(e.response.data ?? {}).map(([k, v]) => [k, (v as { code: string }).code]));
  }
  throw new Error("expected a rejection");
}

describe("unique display names (§22.1)", () => {
  it("a name can't be taken twice, whatever its case, width or invisible characters", async () => {
    const n = `Ada ${uniq()}`;
    await signUp(n);
    expect(await codes(signUp(n))).toEqual({ name: "validation_not_unique" });
    await expectRejected(signUp(n.toUpperCase()));
    await expectRejected(signUp(`${n}​`));
    await expectRejected(signUp(`  ${n.replace(" ", "   ")} `));
  });

  it("renaming onto someone else's name is refused; keeping your own is fine", async () => {
    const a = await newUser();
    const b = await newUser();
    expect(await codes(b.pb.collection("users").update(b.user.id, { name: a.user.name.toUpperCase() }))).toEqual({
      name: "validation_not_unique",
    });
    expect((await a.pb.collection("users").update(a.user.id, { name: a.user.name })).name).toBe(a.user.name);
    const renamed = `renamed-${uniq()}`;
    expect((await a.pb.collection("users").update(a.user.id, { name: renamed })).name).toBe(renamed);
    // The old name is free again.
    expect((await signUp(a.user.name)).name).toBe(a.user.name);
  });

  it("the key is hidden and can't be set by a client", async () => {
    const a = await newUser();
    const me = await a.pb.collection("users").update(a.user.id, { name_key: "something else" });
    expect(me).not.toHaveProperty("name_key");
    const db = rawDb();
    try {
      expect(db.prepare("SELECT name_key FROM users WHERE id = ?").get(a.user.id)).toEqual({ name_key: a.user.name });
    } finally {
      db.close();
    }
  });

  it("accounts that shared a name before (the migration's keys) can still change everything but the name", async () => {
    const a = await newUser();
    const legacy = await newUser();
    const db = rawDb({ write: true });
    try {
      db.prepare("UPDATE users SET name = ?, name_key = ? WHERE id = ?").run(
        a.user.name,
        `${a.user.name}#${legacy.user.id}`,
        legacy.user.id,
      );
    } finally {
      db.close();
    }
    await legacy.pb.send("/api/chat/password", { method: "POST", body: { oldPassword: legacy.password, password: "another-pass-1" } });
  });
});

describe("POST /api/chat/password (§22.2)", () => {
  const change = (pb: ReturnType<typeof client>, body: Record<string, unknown>) =>
    pb.send<{ token: string; record: { id: string } }>("/api/chat/password", { method: "POST", body });

  it("needs a session", async () => {
    expect(await status(change(client(), { oldPassword: "password-123", password: "new-password-1" }))).toBe(401);
  });

  it("checks the current password and the new one", async () => {
    const a = await newUser();
    expect(await codes(change(a.pb, { oldPassword: "wrong-password", password: "new-password-1" }))).toEqual({
      oldPassword: "validation_invalid_value",
    });
    expect(await codes(change(a.pb, { oldPassword: a.password, password: "" }))).toEqual({ password: "validation_required" });
    expect(Object.keys(await codes(change(a.pb, { oldPassword: a.password, password: "short" })))).toEqual(["password"]);
    expect(Object.keys(await codes(change(a.pb, { oldPassword: a.password, password: a.password })))).toEqual(["password"]);
    // Nothing changed.
    await client().collection("users").authWithPassword(a.email, a.password);
  });

  it("changes it, answers with a fresh session, and signs out every other one", async () => {
    const a = await newUser();
    const other = client();
    await other.collection("users").authWithPassword(a.email, a.password);
    const res = await change(a.pb, { oldPassword: a.password, password: "new-password-1" });
    expect(res.record.id).toBe(a.user.id);
    expect(res.token).toBeTruthy();

    // The old password no longer works; the new one does.
    await expectRejected(client().collection("users").authWithPassword(a.email, a.password));
    await client().collection("users").authWithPassword(a.email, "new-password-1");
    // The token from the answer works; tokens issued before don't.
    a.pb.authStore.save(res.token, a.pb.authStore.record);
    await a.pb.collection("users").authRefresh();
    expect(await status(other.collection("users").authRefresh())).toBe(401);
  });
});

describe("passwords over PocketBase's 71 bytes are refused with the reason (QA BUG-267)", () => {
  /** The rejected call's message on `password`. */
  async function why(p: Promise<unknown>): Promise<string | undefined> {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof ClientResponseError)) throw e;
      return (e.response.data?.password as { message: string } | undefined)?.message;
    }
    throw new Error("expected a rejection");
  }
  const TOO_LONG = "Use at most 71 characters (fewer if some aren't plain Latin letters, digits or punctuation).";
  const create = (password: string) =>
    client()
      .collection("users")
      .create({ email: `${uniq()}@test.local`, password, passwordConfirm: password, name: `Long ${uniq()}` });

  it("on signup: 71 ASCII characters are fine; 72 bytes (36 Cyrillic letters) say why", async () => {
    await create("x".repeat(71));
    expect(await why(create("ж".repeat(36)))).toBe(TOO_LONG);
    // Past 72 bytes PocketBase refuses it while reading the request, before any hook: the apps check it first
    // (LIMITS.passwordMaxBytes, Limits.PASSWORD_MAX_BYTES).
    expect(await why(create("x".repeat(100)))).toBeUndefined();
  });

  it("on a password change", async () => {
    const a = await newUser();
    const change = a.pb.send("/api/chat/password", { method: "POST", body: { oldPassword: a.password, password: "y".repeat(100) } });
    expect(await why(change)).toBe(TOO_LONG);
    await client().collection("users").authWithPassword(a.email, a.password);
  });
});

describe("account deletion (BUG-08)", () => {
  it("is not offered through the API, for users with or without content", async () => {
    const empty = await newUser();
    await expectRejected(empty.pb.collection("users").delete(empty.user.id));
    const busy = await newUser();
    await post(busy, (await newRoom(busy)).id, "hello");
    await expectRejected(busy.pb.collection("users").delete(busy.user.id));
  });
});

describe("emails ignore capitalization (BUG-47)", () => {
  it("stores a new email in lower case and logs in however it is capitalized", async () => {
    const id = uniq();
    await signUpAs(`Casey.${id}@Example.TEST`);
    const pb = client();
    const { record } = await pb.collection("users").authWithPassword(`casey.${id}@example.test`, PASSWORD);
    expect(record.email).toBe(`casey.${id}@example.test`);
    expect(await status(client().collection("users").authWithPassword(`CASEY.${id}@EXAMPLE.TEST`, PASSWORD))).toBe(200);
    expect(await status(client().collection("users").authWithPassword(`casey.${id}@example.test`, "wrong-password"))).toBe(400);
  });

  it("refuses a second account for the same address in another case", async () => {
    const id = uniq();
    await signUpAs(`dup.${id}@test.local`);
    await expectRejected(signUpAs(`Dup.${id}@Test.Local`));
  });

  it("an update that doesn't touch the email leaves an existing one as it is", async () => {
    const u = await newUser();
    const legacy = `Legacy.${uniq()}@Test.Local`;
    rawDb({ write: true }).prepare("UPDATE users SET email = ? WHERE id = ?").run(legacy, u.user.id);
    await u.pb.collection("users").update(u.user.id, { name: `renamed-${uniq()}` });
    expect(rawDb().prepare("SELECT email FROM users WHERE id = ?").get(u.user.id)).toEqual({ email: legacy });
    // ...and logs in as typed.
    expect(await status(client().collection("users").authWithPassword(legacy, u.password))).toBe(200);
  });

  it("an unknown email still gets the usual refusal", async () => {
    expect(await status(client().collection("users").authWithPassword(`nobody.${uniq()}@test.local`, PASSWORD))).toBe(400);
  });
});

describe("passwords change only through POST /api/chat/password (BUG-53)", () => {
  it("refuses a password in a users update, which skipped the route's rate limit and checks", async () => {
    const u = await newUser();
    const update = u.pb
      .collection("users")
      .update(u.user.id, { oldPassword: u.password, password: "other-pass-1", passwordConfirm: "other-pass-1" });
    expect(await status(update)).toBe(404);
    expect(await status(client().collection("users").authWithPassword(u.email, u.password))).toBe(200);
    // The rest of the profile still saves.
    expect(await status(u.pb.collection("users").update(u.user.id, { name: `renamed-${uniq()}` }))).toBe(200);
  });
});

describe("a password change keeps realtime working where you are still logged in (BUG-52)", () => {
  it("events keep arriving after the token changes: the subscriptions are sent again with the new one", async () => {
    const ada = realClient();
    const bob = realClient();
    const tag = uniq();
    await ada.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `Ada ${tag}` });
    await bob.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `Bob ${tag}` });
    const room = await ada.createRoom(`pw-${tag}`);
    const got: Message[] = [];
    await ada.subscribeMessages(room.id, (_action, m) => got.push(m));
    try {
      await ada.changePassword("password-123", "new-password-1");
      await bob.send({ id: newId(), room: room.id, text: "after the change" });
      await eventually(() => expect(got.map((m) => m.text)).toContain("after the change"), 3_000);
    } finally {
      await ada.unsubscribeAll();
    }
  });
});
