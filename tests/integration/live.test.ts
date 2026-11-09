// Live messages (pb_hooks/lib/live.js, docs/PERF.md §7): each message saved or deleted goes once, on the chat/messages
// topic, to everyone listening who can see its room: as a `messages/*` subscription would send it, author and
// forward's source expanded, a forward showing its original, an anonymous room's author hidden from all but them.

import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, client, eventually, newRoom, newUser, openDm, post, sleep } from "./helpers.ts";

const TOPIC = "chat/messages";

interface LiveEvent {
  action: "create" | "update" | "delete";
  record: RecordModel & { expand?: Record<string, RecordModel | undefined> };
}

/** Listen on the topic as `pb` (a user's client, or a guest's). */
async function listen(pb: PocketBase) {
  const events: LiveEvent[] = [];
  const off = await pb.realtime.subscribe(TOPIC, (e) => events.push(e as LiveEvent));
  return { events, off, of: (id: string) => events.filter((e) => e.record.id === id) };
}

let admin: Awaited<ReturnType<typeof adminClient>>;

beforeAll(async () => {
  admin = await adminClient();
});

describe("live messages (PERF.md §7)", () => {
  it("the server says it sends them (apps from before don't ask; a server from before is a 404)", async () => {
    const res = await fetch(`${client().baseURL}/api/chat/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ topic: TOPIC });
  });

  it("a message, its edit, a reaction and its deletion reach the room's people, author expanded", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const room = await newRoom(a);
    const live = await listen(b.pb);
    const m = await post(a, room.id, "hello");
    await a.pb.collection("messages").update(m.id, { text: "hello again" });
    await b.pb.send("/api/chat/reactions", { method: "POST", body: { message: m.id, emoji: "👍", on: true } });
    await admin.collection("messages").delete(m.id);
    await eventually(() => expect(live.of(m.id).map((e) => e.action)).toEqual(["create", "update", "update", "delete"]));
    const [created, edited, reacted] = live.of(m.id);
    expect(created!.record.text).toBe("hello");
    expect(created!.record.room).toBe(room.id);
    expect(created!.record.expand?.author?.name).toBe(a.user.name);
    expect(created!.record.expand?.author?.email).toBeUndefined();
    expect(edited!.record.text).toBe("hello again");
    expect(JSON.stringify(reacted!.record.reactions)).toContain(b.user.id);
    await live.off();
  });

  it("only those who can see the room: a private room's members, not others; Open Air rooms reach guests too", async () => {
    const [a, member, outsider] = await Promise.all([newUser(), newUser(), newUser()]);
    const closed = await newRoom(a);
    await a.pb.collection("rooms").update(closed.id, { visibility: "private", members: [a.user.id, member.user.id] });
    const dm = await openDm(a, member);
    const open = await admin.collection("rooms").create({ name: `open-${closed.id}`, created_by: a.user.id, visibility: "open" });
    const guest = client();
    const [toMember, toOutsider, toGuest] = await Promise.all([listen(member.pb), listen(outsider.pb), listen(guest)]);
    const secret = await post(a, closed.id, "members only");
    const direct = await post(a, dm.id, "just us");
    const public_ = await post(a, open.id, "everyone");
    await eventually(() => {
      expect(toMember.of(secret.id)).toHaveLength(1);
      expect(toMember.of(direct.id)).toHaveLength(1);
      expect(toOutsider.of(public_.id)).toHaveLength(1);
      expect(toGuest.of(public_.id)).toHaveLength(1);
    });
    // Events on one connection come in order, and the open room's came after: nothing else is on its way.
    expect(toOutsider.of(secret.id)).toHaveLength(0);
    expect(toOutsider.of(direct.id)).toHaveLength(0);
    expect(toGuest.of(secret.id)).toHaveLength(0);
    expect(toGuest.of(direct.id)).toHaveLength(0);
    // Taken out of the room: nothing more from it.
    await a.pb.collection("rooms").update(closed.id, { members: [a.user.id] });
    const after = await post(a, closed.id, "after you left");
    const marker = await post(a, open.id, "marker");
    await eventually(() => expect(toMember.of(marker.id)).toHaveLength(1));
    expect(toMember.of(after.id)).toHaveLength(0);
    for (const l of [toMember, toOutsider, toGuest]) await l.off();
  });

  it("an anonymous room's message shows the room to others, and its author to them", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const room = await admin.collection("rooms").update((await newRoom(a)).id, { anonymous: true });
    const [toAuthor, toOther] = await Promise.all([listen(a.pb), listen(b.pb)]);
    const m = await post(a, room.id, "who said that");
    await eventually(() => {
      expect(toAuthor.of(m.id)).toHaveLength(1);
      expect(toOther.of(m.id)).toHaveLength(1);
    });
    expect(toAuthor.of(m.id)[0]!.record.author).toBe(a.user.id);
    expect(toAuthor.of(m.id)[0]!.record.expand?.author?.id).toBe(a.user.id);
    const seen = toOther.of(m.id)[0]!.record;
    expect(seen.author).toBe(room.id);
    expect(seen.expand?.author?.id).toBe(room.id);
    expect(seen.expand?.author?.name).toBe(room.name);
    expect(JSON.stringify(seen)).not.toContain(a.user.id);
    for (const l of [toAuthor, toOther]) await l.off();
  });

  it("a forward shows its original, and follows its edit", async () => {
    const [a, b] = await Promise.all([newUser(), newUser()]);
    const from = await newRoom(a);
    const to = await newRoom(b);
    const original = await post(a, from.id, "first words");
    const live = await listen(b.pb);
    const [fwd] = await b.pb.send<RecordModel[]>("/api/chat/forward", { method: "POST", body: { messages: [original.id], room: to.id } });
    await eventually(() => expect(live.of(fwd!.id)).toHaveLength(1));
    expect(live.of(fwd!.id)[0]!.record.text).toBe("first words");
    expect(live.of(fwd!.id)[0]!.record.expand?.forwarded_from?.id).toBe(a.user.id);
    await a.pb.collection("messages").update(original.id, { text: "better words" });
    await eventually(() => expect(live.of(fwd!.id).at(-1)?.record.text).toBe("better words"));
    await live.off();
  });

  it("nothing goes to clients that don't listen; a closed connection is skipped", async () => {
    const a = await newUser();
    const room = await newRoom(a);
    const quiet = await newUser();
    const events: unknown[] = [];
    await quiet.pb.collection("rooms").subscribe("*", (e) => events.push(e));
    const gone = await listen((await newUser()).pb);
    await gone.off();
    await post(a, room.id, "to nobody in particular");
    await sleep(200);
    expect(events).toHaveLength(0);
    expect(gone.events).toHaveLength(0);
    quiet.pb.realtime.unsubscribe();
  });
});
