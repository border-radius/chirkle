// Message attachments (§17): rules, hooks, access by URL (§37.3), serving headers.

import { describe, expect, inject, it } from "vitest";
import { gifHeader, jpegHeader, pngOf, webpHeader } from "../support/images.ts";
import { adminClient, expectRejected, newRoom, newUser, openDm, pngFile, post, rawDb, type TestUser } from "./helpers.ts";

const utf8 = (s: string) => new TextEncoder().encode(s).length;

const textFile = (name: string) => new File(["hello"], name, { type: "text/plain" });

const file = (name: string, type: string, bytes: number | string = "x") =>
  new File([typeof bytes === "number" ? new Uint8Array(bytes) : bytes], name, { type });

async function withFiles(u: TestUser, room: string, files: File[], text = "") {
  return u.pb.collection("messages").create({ room, author: u.user.id, text, files });
}

/** A file download by its URL alone, as anyone (§37.3): no session, no file token unless `token` (ignored). */
async function fetchFile(record: { id: string }, name: string, thumb?: string, token?: string) {
  const q = new URLSearchParams({ ...(thumb ? { thumb } : {}), ...(token ? { token } : {}) }).toString();
  return fetch(`${inject("pbUrl")}/api/files/messages/${record.id}/${encodeURIComponent(name)}${q ? `?${q}` : ""}`);
}

describe("attachments (§17.1)", () => {
  it("a message may carry files and no text; text-less and file-less is still rejected", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile("photo.png"), file("notes.txt", "text/plain")], "  ");
    expect(m.text).toBe("");
    expect(m.files).toHaveLength(2);
    expect(m.files[0]).toMatch(/^photo_\w{10}\.png$/);
    await expectRejected(post(a, room.id, "   "));
    await expectRejected(withFiles(a, room.id, [], " ​ "));
  });

  it("rejects an 11th file and files over 20 MB", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await expectRejected(
      withFiles(
        a,
        room.id,
        Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, "text/plain")),
      ),
    );
    await expectRejected(withFiles(a, room.id, [file("big.bin", "application/octet-stream", 20 * 1024 * 1024 + 1)]));
  });

  it("leaves no upload stored when the message is refused after its uploads were (docs/PERF.md §12)", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const tag = `left${Date.now().toString(36)}`;
    const stored = () => {
      const db = rawDb();
      try {
        return db.prepare("SELECT COUNT(*) AS n FROM files WHERE name LIKE ?").get(`${tag}%`);
      } finally {
        db.close();
      }
    };
    // Refused by the save's own validation (text over 2000), after both uploads were stored.
    await expectRejected(withFiles(a, room.id, [pngFile(`${tag}1.png`), file(`${tag}2.txt`, "text/plain")], "x".repeat(2001)));
    // The second upload too big: the first was stored already.
    await expectRejected(
      withFiles(a, room.id, [pngFile(`${tag}3.png`), file(`${tag}4.bin`, "application/octet-stream", 20 * 1024 * 1024 + 1)]),
    );
    expect(stored()).toEqual({ n: 0 });
    // And taken, they are there, named once.
    await withFiles(a, room.id, [pngFile(`${tag}5.png`)], "ok");
    expect(stored()).toEqual({ n: 1 });
  });

  it("accepts 10 files of 20 MB in one message (the request body limit fits), and other requests keep 32 MB", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(
      a,
      room.id,
      Array.from({ length: 10 }, (_, i) => file(`b${i}.bin`, "application/octet-stream", 20 * 1024 * 1024)),
    );
    expect(m.files).toHaveLength(10);
    // An avatar is not a message: PocketBase's own limit for the users route holds (its default, 32 MB, and the avatar's
    // 2 MB: it sizes each collection's create and update by its fields).
    const big = new FormData();
    big.append("avatar", file("big.png", "image/png", 40 * 1024 * 1024));
    const res = await fetch(`${a.pb.baseURL}/api/collections/users/records/${a.user.id}`, {
      method: "PATCH",
      headers: { Authorization: a.pb.authStore.token },
      body: big,
    });
    expect(res.status).toBe(413);
  }, 60_000);

  it("holds a chunked body (no Content-Length) to 32 MB too, and takes a small one (QA BUG-143)", async () => {
    const a = await newUser();
    /** POST `body` to `path` in chunks: no Content-Length, so the limit must count what is read. */
    const chunked = (path: string, body: string, token = "") =>
      fetch(`${a.pb.baseURL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
        body: new Response(body).body,
        duplex: "half",
      } as RequestInit);
    const big = JSON.stringify({ room: "x".repeat(40 * 1024 * 1024) });
    expect((await chunked("/api/chat/reads", big, a.pb.authStore.token)).status).toBe(413);
    // As a guest, logging in.
    expect((await chunked("/api/collections/users/auth-with-password", JSON.stringify({ identity: big, password: "x" }))).status).toBe(413);
    // A small one is taken as ever (the Android app sends chunked uploads when it can't tell a file's size).
    const room = await newRoom(a);
    expect((await chunked("/api/chat/reads", JSON.stringify({ room: room.id }), a.pb.authStore.token)).status).toBe(200);
  }, 60_000);

  it("attachments can't be added, removed or replaced by an edit; a text edit keeps them", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()], "caption");
    const msgs = a.pb.collection("messages");
    await expectRejected(msgs.update(m.id, { files: [pngFile("other.png")] }));
    await expectRejected(msgs.update(m.id, { "files+": [pngFile("more.png")] }));
    await expectRejected(msgs.update(m.id, { "files-": [m.files[0]] }));
    await expectRejected(msgs.update(m.id, { files: [] }));
    const edited = await msgs.update(m.id, { text: "new caption" });
    expect(edited.files).toEqual(m.files);
    expect((await msgs.update(m.id, { text: "" })).text).toBe(""); // text optional next to an attachment
  });

  it("soft delete removes the attachments, and their URLs stop working", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()], "bye");
    expect((await fetchFile(m, m.files[0])).status).toBe(200);
    const deleted = await a.pb.collection("messages").update(m.id, { deleted: true });
    expect(deleted.files).toEqual([]);
    expect((await fetchFile(m, m.files[0])).status).toBe(404);
    expect((await fetchFile(m, m.files[0], "240x240")).status).toBe(404);
  });

  it("archived rooms take no attachments", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    await a.pb.collection("rooms").update(room.id, { archived: true });
    await expectRejected(withFiles(a, room.id, [pngFile()]));
  });
});

describe("access by URL (§37.3)", () => {
  it("opens with the URL alone, a DM's too, thumbnails as well; a token is ignored", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const dm = await openDm(a, b);
    const m = await withFiles(a, dm.id, [pngFile()], "just us");
    const name = m.files[0] as string;
    expect((await fetchFile(m, name)).status).toBe(200);
    expect((await fetchFile(m, name, "800x480f")).status).toBe(200);
    expect((await fetchFile(m, name, "240x240", "not-a-token")).status).toBe(200);
    expect((await fetchFile(m, name, undefined, await a.pb.files.getToken())).status).toBe(200);
  });

  it("only the message's own names: another message's file, a made-up one, or the files rows directly are 404", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile("one.png")]);
    const other = await withFiles(a, room.id, [pngFile("two.png")]);
    expect((await fetchFile(m, other.files[0])).status).toBe(404);
    expect((await fetchFile(m, "nope_abcdefghij.png")).status).toBe(404);
    expect((await fetchFile({ id: "aaaaaaaaaaaaaaa" }, m.files[0])).status).toBe(404);
    const admin = await adminClient();
    const [row] = await admin.collection("files").getFullList({ filter: `file = "${m.files[0]}"` });
    expect((await fetch(`${inject("pbUrl")}/api/files/files/${row!.id}/${m.files[0]}`)).status).toBe(404);
    expect((await fetch(`${inject("pbUrl")}/api/files/${row!.collectionId}/${row!.id}/${m.files[0]}`)).status).toBe(404);
  });

  it("a forward's readers open the original's URL; it goes once the original is deleted", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [pngFile()]);
    const dm = await openDm(b, a);
    await a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: dm.id } });
    const [fwd] = await b.pb.collection("messages").getFullList({ filter: `room = "${dm.id}"` });
    expect((await fetchFile(fwd!, m.files[0])).status).toBe(200);
    await a.pb.collection("messages").update(m.id, { deleted: true });
    expect((await fetchFile(fwd!, m.files[0])).status).toBe(404);
    expect((await fetchFile(m, m.files[0])).status).toBe(404);
  });

  it("an uploaded .html or .svg is served inert: sandbox CSP and nosniff", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [
      file("page.html", "text/html", "<script>window.top.__pwned=1</script>"),
      file("pic.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ]);
    for (const name of m.files as string[]) {
      const res = await fetchFile(m, name);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("original file names (QA BUG-28)", () => {
  it("the server records each upload's original name, keyed by its stored name", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [file("Quarterly Report (final).pdf", "application/pdf"), pngFile("Ünïcødé photo.png")]);
    expect(m.files[0]).toMatch(/^quarterly_report_final_\w{10}\.pdf$/);
    expect(m.file_names).toEqual({ [m.files[0]]: "Quarterly Report (final).pdf", [m.files[1]]: "Ünïcødé photo.png" });
  });

  it("clients can't forge or change the names; spoofing characters are dropped; a delete clears them", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const forged = await a.pb.collection("messages").create({
      room: room.id,
      author: a.user.id,
      text: "",
      files: [file("invoice‮fdp.exe", "application/octet-stream")],
      file_names: { x: "y" },
    });
    expect(Object.values(forged.file_names)).toEqual(["invoicefdp.exe"]);
    const edited = await a.pb.collection("messages").update(forged.id, { text: "now", file_names: { [forged.files[0]]: "nice.pdf" } });
    expect(edited.file_names).toEqual(forged.file_names);
    expect((await a.pb.collection("messages").update(forged.id, { deleted: true })).file_names).toEqual({});
  });

  it("messages without files have no names", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    expect((await post(a, room.id, "plain")).file_names).toEqual({});
  });
});

describe("attachment shapes (§17.5)", () => {
  const bin = (name: string, type: string, b: Buffer) => new File([new Uint8Array(b)], name, { type });

  it("records each image's shape as shown, a quarter-turned JPEG's turned; not other files'", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [
      bin("wide.png", "image/png", pngOf(64, 48)),
      bin("plain.jpg", "image/jpeg", jpegHeader(400, 300)),
      bin("turned.jpg", "image/jpeg", jpegHeader(400, 300, 0, 6)),
      bin("turned-mm.jpg", "image/jpeg", jpegHeader(400, 300, 0, 8, true)),
      bin("flipped.jpg", "image/jpeg", jpegHeader(400, 300, 0, 3)),
      bin("anim.gif", "image/gif", gifHeader(30, 20)),
      bin("pic.webp", "image/webp", webpHeader(50, 100)),
      file("notes.pdf", "application/pdf"),
    ]);
    const f = m.files as string[];
    expect(m.file_dims).toEqual({
      [f[0]!]: [64, 48],
      [f[1]!]: [400, 300],
      [f[2]!]: [300, 400],
      [f[3]!]: [300, 400],
      [f[4]!]: [400, 300],
      [f[5]!]: [30, 20],
      [f[6]!]: [50, 100],
    });
    expect((await a.pb.collection("messages").getOne(m.id)).file_dims).toEqual(m.file_dims);
  });

  it("clients can't set or change them; a forward shows its original's; a delete clears them", async () => {
    const a = await newUser();
    const b = await newUser();
    const room = await newRoom(a);
    const forged = a.pb.collection("messages").create({ room: room.id, author: a.user.id, text: "x", file_dims: { x: [1, 2] } });
    await expectRejected(forged);
    const m = await withFiles(a, room.id, [bin("wide.png", "image/png", pngOf(64, 48))]);
    await expectRejected(a.pb.collection("messages").update(m.id, { file_dims: { [m.files[0]]: [1, 1] } }));
    expect((await a.pb.collection("messages").update(m.id, { text: "edited" })).file_dims).toEqual({ [m.files[0]]: [64, 48] });

    const dm = await openDm(b, a);
    await a.pb.send("/api/chat/forward", { method: "POST", body: { messages: [m.id], room: dm.id } });
    const [fwd] = await b.pb.collection("messages").getFullList({ filter: `room = "${dm.id}"` });
    expect(fwd!.file_dims).toEqual({ [m.files[0]]: [64, 48] });

    expect((await a.pb.collection("messages").update(m.id, { deleted: true })).file_dims).toEqual({});
  });
});

describe("long upload names (BUG-35, BUG-36)", () => {
  it("accepts a file whose non-Latin name is over 255 bytes, keeping a shortened name with its extension", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const long = `${"Протокол совещания ".repeat(8)}.pdf`; // 152 characters, 291 bytes: PocketBase used to fail it
    const m = await withFiles(a, room.id, [textFile(long), textFile(`${"😀".repeat(70)}.txt`)]);
    // In upload order: file_names is keyed by the stored (randomly suffixed) name, so its own order is arbitrary.
    const names = (m.files as string[]).map((f) => (m.file_names as Record<string, string>)[f] ?? "");
    expect(names).toHaveLength(2);
    for (const n of names) expect(utf8(n)).toBeLessThanOrEqual(200);
    expect(names[0]).toMatch(/^Протокол совещания .+\.pdf$/);
    expect(names[1]).toMatch(/^😀+\.txt$/u);
  });

  it("keeps the extension of a name cut at the length limit", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const m = await withFiles(a, room.id, [textFile(`${"報告書".repeat(70)}.xlsx`)]);
    expect(Object.values(m.file_names as Record<string, string>)[0]).toMatch(/^(報告書)+報?告?\.xlsx$/);
  });
});

describe("attachment names keep their double quotes (BUG-54)", () => {
  it('stores "Q&A "v2".txt", which browsers send as "Q&A %22v2%22.txt"', async () => {
    const u = await newUser();
    const room = await newRoom(u);
    const name = 'Q&A "v2" notes.txt';
    const m = await u.pb.collection("messages").create({ room: room.id, author: u.user.id, text: "", files: [new File(["x"], name)] });
    expect(Object.values(m.file_names as Record<string, string>)).toEqual([name]);
  });
});
