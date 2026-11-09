import { describe, expect, inject, it } from "vitest";
import { type Api, createApi } from "../../web/src/api.ts";
import { createClient } from "../../web/src/pb.ts";
import { client, expectRejected, newRoom, newUser, post, uniq } from "./helpers.ts";

const realClient = (): Api => createApi(createClient(inject("pbUrl")));

describe("users rules (§5.5)", () => {
  it("anyone can sign up and use the account immediately, without verification", async () => {
    const u = await newUser();
    expect(u.user.verified).toBe(false);
    const room = await newRoom(u);
    expect((await post(u, room.id, "first!")).text).toBe("first!");
  });

  it("rejects a missing, blank or over-long name", async () => {
    const pb = client();
    const base = { password: "password-123", passwordConfirm: "password-123" };
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local` }));
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local`, name: "   " }));
    await expectRejected(pb.collection("users").create({ ...base, email: `${uniq()}@test.local`, name: "x".repeat(33) }));
  });

  it("trims names", async () => {
    const created = await client()
      .collection("users")
      .create({ email: `${uniq()}@test.local`, password: "password-123", passwordConfirm: "password-123", name: "  padded  " });
    expect(created.name).toBe("padded");
  });

  it("cannot sign up with a public email", async () => {
    const pb = client();
    await expectRejected(
      pb.collection("users").create({
        email: `${uniq()}@test.local`,
        password: "password-123",
        passwordConfirm: "password-123",
        name: "visible",
        emailVisibility: true,
      }),
    );
  });

  it("authenticated users can list others but never see their email", async () => {
    const a = await newUser();
    const b = await newUser();
    const seen = await a.pb.collection("users").getOne(b.user.id);
    expect(seen.name).toBe(b.user.name);
    expect(seen.email).toBeFalsy();
    const list = await a.pb.collection("users").getFullList({ filter: `id = "${b.user.id}"` });
    expect(list).toHaveLength(1);
    expect(list[0]!.email).toBeFalsy();
  });

  it("anonymous users cannot list users; one whose id they have shows only the public profile (§23.3)", async () => {
    const b = await newUser();
    const anon = client();
    expect((await anon.collection("users").getList(1, 50)).items).toHaveLength(0);
    const u = await anon.collection("users").getOne(b.user.id);
    expect(u.name).toBe(b.user.name);
    expect(u.email).toBeUndefined();
  });

  it("a user can update their own name but not someone else's", async () => {
    const a = await newUser();
    const b = await newUser();
    const name = `renamed-${uniq()}`;
    expect((await a.pb.collection("users").update(a.user.id, { name })).name).toBe(name);
    await expectRejected(a.pb.collection("users").update(b.user.id, { name: "hacked" }));
  });

  it("a user cannot make their email public", async () => {
    const a = await newUser();
    await expectRejected(a.pb.collection("users").update(a.user.id, { emailVisibility: true }));
  });
});

describe("user search ignores case beyond ASCII (BUG-55)", () => {
  it("finds “Иван”, “Élodie” and “Straße” however they are typed, as names are compared (§22.1)", async () => {
    const tag = uniq();
    const me = realClient();
    await me.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `searcher ${tag}` });
    for (const name of [`Иван ${tag}`, `Élodie ${tag}`, `Straße ${tag}`]) {
      await realClient().signUp({ email: `${uniq()}@test.local`, password: "password-123", name });
    }
    const names = async (q: string) => (await me.searchUsers(q)).map((u) => u.name);
    expect(await names(`иван ${tag}`)).toEqual([`Иван ${tag}`]);
    expect(await names(`ИВАН ${tag}`)).toEqual([`Иван ${tag}`]);
    expect(await names(`élodie ${tag}`)).toEqual([`Élodie ${tag}`]);
    expect(await names(`STRASSE ${tag}`)).toEqual([`Straße ${tag}`]);
    expect(await names(`searcher ${tag}`)).toEqual([]); // never yourself
    expect(await names("   ")).toEqual([]);
  });

  it("needs a session, and answers only the public profile", async () => {
    expect((await fetch(`${inject("pbUrl")}/api/chat/users?q=a`)).status).toBe(401);
    const me = realClient();
    const tag = uniq();
    await me.signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `viewer ${tag}` });
    await realClient().signUp({ email: `${uniq()}@test.local`, password: "password-123", name: `shown ${tag}` });
    const [found] = await me.searchUsers(`shown ${tag}`);
    expect(Object.keys(found!).sort()).toEqual(["avatar", "handle", "id", "name"]);
  });
});
