// Room access (§23) as one table: every kind of room × every kind of viewer × every way in. The rule is written in four
// places (the API rules of 1760000014_room_access.js, canSee in pb_hooks/lib/access.js, the unread SQL in
// pb_hooks/lib/reads.js and the room list in lib/lists.js, and the hooks that call canSee, live messages among them); this checks they all agree with `sees` below, and lists every
// disagreement at once.

import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import { describe, expect, it } from "vitest";
import { adminClient, byName, client, eventually, newRoom, newUser, openDm, pngFile, post, status, type TestUser } from "./helpers.ts";

type Visibility = "public" | "private" | "open";
type ViewerName = "guest" | "creator" | "member" | "outsider";

interface Fixture {
  name: string;
  room: RecordModel;
  /** Written by the creator, with an attachment. */
  probe: RecordModel;
  /** Written by the member (deleted for good by a superuser for the live messages' check). */
  other: string;
  visibility: Visibility;
  archived: boolean;
}

interface Viewer {
  name: ViewerName;
  pb: PocketBase;
  user: TestUser | null;
}

/** The rule, as DESIGN §23.1 states it. */
function sees(f: Fixture, v: ViewerName): boolean {
  if (v === "guest") return f.visibility === "open" && !f.archived;
  return f.visibility !== "private" || v === "creator" || v === "member";
}

/** Writing (a message, a reaction, a forward) needs a session, the right to see the room, and an active room. */
const writes = (f: Fixture, v: ViewerName) => v !== "guest" && sees(f, v) && !f.archived;

const ok = (s: number) => s >= 200 && s < 300;

async function setUp() {
  const [creator, member, outsider] = await Promise.all([newUser(), newUser(), newUser()]);

  /** A message by the creator, with an attachment, and one by the member (unread for the creator too). */
  async function probe(roomId: string) {
    const m = await creator.pb.collection("messages").create({ room: roomId, author: creator.user.id, text: "probe", files: [pngFile()] });
    const other = await post(member, roomId, "from the member");
    return { m, other: other.id };
  }

  async function room(name: string, visibility: Visibility, archived: boolean): Promise<Fixture> {
    let r = await newRoom(creator);
    r = await creator.pb.collection("rooms").update(r.id, { visibility, members: visibility === "private" ? [member.user.id] : [] });
    const { m, other } = await probe(r.id);
    if (archived) r = await creator.pb.collection("rooms").update(r.id, { archived: true });
    return { name, room: r, probe: m, other, visibility, archived };
  }

  const fixtures = await Promise.all([
    room("public", "public", false),
    room("private", "private", false),
    room("open", "open", false),
    room("public, archived", "public", true),
    room("private, archived", "private", true),
    room("open, archived", "open", true),
  ]);
  const dm = await openDm(creator, member);
  const inDm = await probe(dm.id);
  fixtures.push({ name: "dm", room: dm, probe: inDm.m, other: inDm.other, visibility: "private", archived: false });

  const viewers: Viewer[] = [
    { name: "guest", pb: client(), user: null },
    { name: "creator", pb: creator.pb, user: creator },
    { name: "member", pb: member.pb, user: member },
    { name: "outsider", pb: outsider.pb, user: outsider },
  ];
  return { creator, fixtures, viewers };
}

describe("room access matrix (§23.1)", () => {
  it("every way in agrees on who can see and write in which room", async () => {
    const { creator, fixtures, viewers } = await setUp();
    const mismatches: string[] = [];
    const check = (f: Fixture, v: Viewer, what: string, expected: boolean, actual: boolean, detail = "") => {
      if (expected !== actual) mismatches.push(`${f.name} × ${v.name}: ${what} should ${expected ? "" : "not "}work${detail}`);
    };

    // Reads first: the writes below add messages, reads and hidden rows.
    await Promise.all(
      viewers.map(async (v) => {
        const unread = v.user ? (await v.pb.send<{ rooms: Record<string, number> }>("/api/chat/unread", {})).rooms : {};
        const listedHere = (await v.pb.send<{ id: string }[]>("/api/chat/rooms", {})).map((r) => r.id);
        await Promise.all(
          fixtures.map(async (f) => {
            const can = sees(f, v.name);
            const roomId = f.room.id;
            const viewRoom = await status(v.pb.collection("rooms").getOne(roomId));
            check(f, v, "rooms view", can, ok(viewRoom), ` (got ${viewRoom})`);
            const listed = await v.pb.collection("rooms").getFullList({ filter: v.pb.filter("id = {:id}", { id: roomId }) });
            check(f, v, "rooms list", can, listed.length === 1);
            const viewMsg = await status(v.pb.collection("messages").getOne(f.probe.id));
            check(f, v, "messages view", can, ok(viewMsg), ` (got ${viewMsg})`);
            const msgs = await v.pb.collection("messages").getFullList({ filter: v.pb.filter("room = {:id}", { id: roomId }) });
            check(f, v, "messages list", can, msgs.length > 0);
            check(f, v, "GET /api/chat/rooms", can, listedHere.includes(roomId));
            const page = await v.pb.send<unknown[]>(`/api/chat/rooms/${roomId}/messages`, {}).catch(() => null);
            check(f, v, "GET /api/chat/rooms/{room}/messages", can, !!page && page.length > 0);
            if (v.user && v.name !== "creator") {
              // The creator wrote the probe; a check notifies of other people's messages only.
              const query = { rooms: roomId, every: roomId, since: "2000-01-01 00:00:00.000Z" };
              const notifiable = await v.pb.send<unknown[]>("/api/chat/notifiable", { query });
              check(f, v, "GET /api/chat/notifiable", can, notifiable.length > 0);
            }
            // An attachment opens by its URL alone, for whoever has it (§37.3): the URL is the secret.
            const file = (await fetch(creator.pb.files.getURL(byName(f.probe), f.probe.files[0]))).status;
            check(f, v, "attachment by URL", true, ok(file), ` (got ${file})`);
            if (v.user) check(f, v, "unread count", can, (unread[roomId] ?? 0) > 0);
          }),
        );
      }),
    );

    // Live messages (pb_hooks/lib/live.js): the member's message in each room, deleted for good by a superuser (archived
    // rooms take no edits), reaches those who see its room. The open room's goes last, and every viewer sees that one:
    // once it is in, every event before it on the same connection is too.
    const admin = await adminClient();
    const live = await Promise.all(
      viewers.map(async (v) => {
        const ids: string[] = [];
        const off = await v.pb.realtime.subscribe("chat/messages", (e) => ids.push((e as { record: { id: string } }).record.id));
        return { v, ids, off };
      }),
    );
    const open = fixtures.find((f) => f.name === "open")!;
    for (const f of [...fixtures.filter((f) => f !== open), open]) await admin.collection("messages").delete(f.other);
    await eventually(() => {
      for (const l of live) expect(l.ids).toContain(open.other);
    });
    for (const l of live) {
      for (const f of fixtures) check(f, l.v, "live messages (chat/messages)", sees(f, l.v.name), l.ids.includes(f.other));
      await l.off();
    }

    // Writes. A guest is always refused; a signed-in viewer only where `writes` (or, for hiding and reads, `sees`) says.
    await Promise.all(
      viewers.map(async (v) => {
        const source = v.user ? await post(v.user, (await newRoom(v.user)).id, "to forward") : null;
        for (const f of fixtures) {
          const roomId = f.room.id;
          const body = v.user ? { room: roomId, author: v.user.user.id, text: "hi" } : { room: roomId, text: "hi" };
          const sent = await status(v.pb.collection("messages").create(body));
          check(f, v, "posting", writes(f, v.name), ok(sent), ` (got ${sent})`);
          const reacted = await status(
            v.pb.send("/api/chat/reactions", { method: "POST", body: { message: f.probe.id, emoji: "👍", on: true } }),
          );
          check(f, v, "reacting", writes(f, v.name), ok(reacted), ` (got ${reacted})`);
          if (source) {
            const forwarded = await status(
              v.pb.send("/api/chat/forward", { method: "POST", body: { messages: [source.id], room: roomId } }),
            );
            check(f, v, "forwarding into", writes(f, v.name), ok(forwarded), ` (got ${forwarded})`);
          }
          const read = await status(v.pb.send("/api/chat/reads", { method: "POST", body: { room: roomId } }));
          check(f, v, "marking read", v.user !== null && sees(f, v.name), ok(read), ` (got ${read})`);
          const hidden = await status(v.pb.collection("hidden_rooms").create({ user: v.user?.user.id ?? "", room: roomId }));
          check(f, v, "hiding", v.user !== null && sees(f, v.name), ok(hidden), ` (got ${hidden})`);
        }
      }),
    );

    expect(mismatches).toEqual([]);
  });
});
