import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActivity } from "../../web/src/api.ts";
import { NOTIFY_KEY as APP_KEY } from "../../web/src/app.ts";
import { newId } from "../../web/src/lib/id.ts";
import { roomTitle } from "../../web/src/lib/rooms.ts";
import type { Room } from "../../web/src/lib/types.ts";
import {
  bodyOf,
  candidate,
  loadPrefs,
  NOTIFY_KEY,
  type NotifyPrefs,
  notifySettings,
  savePrefs,
  startNotify,
} from "../../web/src/notify.ts";
import { type AppState, createStore, initialState, type Store } from "../../web/src/store.ts";
import { type SignedUp, signedUp, subscribed, uniq } from "../support/api.ts";

const ALL: NotifyPrefs = { dms: true, replies: true, popup: true, sound: true, rooms: [] };

/** The pop-ups made (no service worker here: `new Notification`). */
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static made: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = "granted";
    return "granted" as const;
  });
  closed = false;
  onclick: (() => void) | null = null;
  readonly title: string;
  readonly opts: NotificationOptions;
  constructor(title: string, opts: NotificationOptions) {
    this.title = title;
    this.opts = opts;
    FakeNotification.made.push(this);
  }
  close() {
    this.closed = true;
  }
}

/** Chimes played: each makes two notes. */
let notes = 0;
class FakeAudio {
  currentTime = 0;
  destination = {};
  resume = async () => {};
  createOscillator() {
    notes++;
    return { frequency: {}, connect: (g: unknown) => g, start() {}, stop() {} };
  }
  createGain() {
    return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => {} };
  }
}

describe("notifications: what alerts (§34)", () => {
  const me = { id: "me", name: "Me" };
  const dm = { id: "d", name: "", kind: "dm", members: ["me", "b"] } as unknown as Room;
  const room = { id: "r", name: "general" } as Room;
  const state = (extra: Partial<AppState> = {}): AppState => ({
    ...initialState(),
    user: me,
    rooms: new Map([dm, room].map((r) => [r.id, r])),
    ...extra,
  });
  const msg = (m: Partial<MessageActivity>): MessageActivity => ({ id: "m", room: "r", author: "b", deleted: false, ...m });

  it("DMs and replies, as chosen; never your own, service or deleted messages, archived or hidden rooms", () => {
    expect(candidate(ALL, msg({ room: "d" }), state())).toBe("dm");
    expect(candidate(ALL, msg({ reply_to: "x" }), state())).toBe("reply");
    expect(candidate(ALL, msg({}), state())).toBeNull();
    expect(candidate({ ...ALL, dms: false }, msg({ room: "d" }), state())).toBeNull();
    expect(candidate({ ...ALL, replies: false }, msg({ reply_to: "x" }), state())).toBeNull();
    expect(candidate({ ...ALL, popup: false, sound: false }, msg({ room: "d" }), state())).toBeNull();
    expect(candidate(ALL, msg({ room: "d", author: "me" }), state())).toBeNull();
    expect(candidate(ALL, msg({ room: "d", author: "" }), state())).toBeNull();
    expect(candidate(ALL, msg({ room: "d", deleted: true }), state())).toBeNull();
    expect(candidate(ALL, msg({ reply_to: "x" }), state({ hidden: new Map([["r", "h"]]) }))).toBeNull();
    // A closed DM opens again with a message (§16.4).
    expect(candidate(ALL, msg({ room: "d" }), state({ hidden: new Map([["d", "h"]]) }))).toBe("dm");
    const archived = new Map([["r", { ...room, archived: true }]]);
    expect(candidate(ALL, msg({ reply_to: "x" }), state({ rooms: archived }))).toBeNull();
    // A room not loaded yet: maybe a DM just started.
    expect(candidate(ALL, msg({ room: "new" }), state())).toBe("room");
    expect(candidate({ ...ALL, dms: false }, msg({ room: "new" }), state())).toBeNull();
    expect(candidate(ALL, msg({ room: "d" }), state({ user: null }))).toBeNull();
  });

  it("§34.5: every message of a room chosen, unless hidden or archived", () => {
    const chosen = { ...ALL, replies: false, rooms: ["r", "new"] };
    expect(candidate(chosen, msg({}), state())).toBe("all");
    expect(candidate({ ...ALL, rooms: ["r"] }, msg({ reply_to: "x" }), state())).toBe("reply");
    expect(candidate(chosen, msg({}), state({ hidden: new Map([["r", "h"]]) }))).toBeNull();
    expect(candidate(chosen, msg({}), state({ rooms: new Map([["r", { ...room, archived: true }]]) }))).toBeNull();
    expect(candidate(chosen, msg({ author: "me" }), state())).toBeNull();
    expect(candidate({ ...chosen, popup: false, sound: false }, msg({}), state())).toBeNull();
    expect(candidate({ ...chosen, dms: false }, msg({ room: "new" }), state())).toBe("room");
  });

  it("says the text on one line, cut short, or what was sent instead", () => {
    expect(bodyOf({ text: " hi\n\nthere " })).toBe("hi there");
    expect(bodyOf({ text: "x".repeat(200) })).toHaveLength(140);
    expect(bodyOf({ text: "", files: ["a.png"] })).toBe("Sent an attachment");
    expect(bodyOf({ text: "", files: ["a.png", "b.png"] })).toBe("Sent 2 attachments");
    expect(bodyOf({ text: "", forward_of: "x" })).toBe("Forwarded a message");
  });

  it("keeps the choices on this device; nothing chosen leaves nothing stored", () => {
    expect(NOTIFY_KEY).toBe(APP_KEY);
    savePrefs({ ...ALL, replies: false });
    expect(loadPrefs()).toEqual({ ...ALL, replies: false });
    savePrefs({ dms: false, replies: false, popup: false, sound: false, rooms: [] });
    expect(localStorage.getItem(NOTIFY_KEY)).toBeNull();
    savePrefs({ dms: false, replies: false, popup: true, sound: false, rooms: ["r"] });
    expect(loadPrefs().rooms).toEqual(["r"]);
    localStorage.setItem(NOTIFY_KEY, JSON.stringify({ rooms: ["r", 1, null] }));
    expect(loadPrefs().rooms).toEqual(["r"]);
    localStorage.setItem(NOTIFY_KEY, "{bad");
    expect(loadPrefs().dms).toBe(false);
    localStorage.removeItem(NOTIFY_KEY);
  });
});

describe("notifications: live (§34)", () => {
  let me: SignedUp;
  let other: SignedUp;
  let store: Store<AppState>;
  let stop: (() => void) | undefined;
  let navigate: ReturnType<typeof vi.fn<(path: string) => void>>;
  let focused = false;

  beforeEach(async () => {
    [me, other] = await Promise.all([signedUp(`Me ${uniq()}`), signedUp(`Bea ${uniq()}`)]);
    store = createStore<AppState>({ ...initialState(), user: me.user });
    FakeNotification.made = [];
    FakeNotification.permission = "granted";
    notes = 0;
    focused = false;
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("AudioContext", FakeAudio);
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    savePrefs(ALL);
  });
  afterEach(async () => {
    stop?.();
    stop = undefined;
    localStorage.removeItem(NOTIFY_KEY);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await Promise.all([me.api.unsubscribeAll(), other.api.unsubscribeAll()]);
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function start(...rooms: Room[]) {
    store.set({ rooms: new Map(rooms.map((r) => [r.id, r])), roomsStatus: "ready" });
    navigate = vi.fn<(path: string) => void>();
    stop = startNotify({ api: me.api, store, title: roomTitle, navigate });
    await subscribed(me.api);
  }
  const say = (who: SignedUp, room: Room, text: string, replyTo?: string) =>
    who.api.send({ id: newId(), room: room.id, text, ...(replyTo ? { replyTo } : {}) });
  /** Wait until what was sent has had time to alert (the tab-in-front question waits 200 ms). */
  const settle = () => sleep(600);

  it("a DM: a pop-up with who wrote and what, and the chime; a click opens the message", async () => {
    const dm = await me.api.openDm(other.user.id);
    await start(dm);
    const m = await say(other, dm, "hello\nthere");
    await vi.waitFor(() => expect(FakeNotification.made).toHaveLength(1), { timeout: 3000 });
    const [n] = FakeNotification.made;
    expect(n!.title).toBe(other.user.name);
    expect(n!.opts).toMatchObject({ body: "hello there", tag: dm.id, silent: true });
    expect(notes).toBe(2);
    n!.onclick?.();
    expect(navigate).toHaveBeenCalledWith(`/r/${dm.id}/m/${m.id}`);
  });

  it("a reply to you in a room; not a plain message, nor a reply to someone else", async () => {
    const room = await me.api.createRoom(`notify-${uniq()}`);
    const mine = await say(me, room, "mine");
    const theirs = await say(other, room, "theirs");
    await start(room);
    await say(other, room, "plain");
    await say(other, room, "to themselves", theirs.id);
    await settle();
    expect(FakeNotification.made).toEqual([]);
    await say(other, room, "to you", mine.id);
    await vi.waitFor(() => expect(FakeNotification.made).toHaveLength(1), { timeout: 3000 });
    expect(FakeNotification.made[0]!.title).toBe(`${other.user.name} replied in #${room.name}`);
    expect(FakeNotification.made[0]!.opts.body).toBe("to you");
  });

  it("§41: a mention of you in a room, as Mentions and replies; not someone else's", async () => {
    const room = await me.api.createRoom(`notify-${uniq()}`);
    await start(room);
    await say(other, room, `hi @${other.user.handle}`);
    await settle();
    expect(FakeNotification.made).toEqual([]);
    await say(other, room, `hi @${me.user.handle}`);
    await vi.waitFor(() => expect(FakeNotification.made).toHaveLength(1), { timeout: 3000 });
    expect(FakeNotification.made[0]!.title).toBe(`${other.user.name} mentioned you in #${room.name}`);
  });

  it('§34.5: every message of a room chosen, "… in #room"; not another room\'s', async () => {
    const room = await me.api.createRoom(`notify-${uniq()}`);
    const elsewhere = await me.api.createRoom(`notify-${uniq()}`);
    savePrefs({ ...ALL, rooms: [room.id] });
    await start(room, elsewhere);
    await say(other, elsewhere, "not this one");
    await settle();
    expect(FakeNotification.made).toEqual([]);
    await say(other, room, "every one");
    await vi.waitFor(() => expect(FakeNotification.made).toHaveLength(1), { timeout: 3000 });
    expect(FakeNotification.made[0]!.title).toBe(`${other.user.name} in #${room.name}`);
    expect(FakeNotification.made[0]!.opts.body).toBe("every one");
  });

  it("in front: nothing for the room open there, only the chime for another", async () => {
    const dm = await me.api.openDm(other.user.id);
    const room = await me.api.createRoom(`notify-${uniq()}`);
    await start(dm, room);
    focused = true;
    store.set({ activeRoomId: dm.id });
    await say(other, dm, "seen");
    await settle();
    expect(notes).toBe(0);
    store.set({ activeRoomId: room.id });
    await say(other, dm, "heard");
    await vi.waitFor(() => expect(notes).toBe(2), { timeout: 3000 });
    expect(FakeNotification.made).toEqual([]);
  });

  it("as chosen: the sound alone; no pop-up when the browser blocks them", async () => {
    const dm = await me.api.openDm(other.user.id);
    await start(dm);
    savePrefs({ ...ALL, popup: false });
    await say(other, dm, "one");
    await vi.waitFor(() => expect(notes).toBe(2), { timeout: 3000 });
    savePrefs({ ...ALL, sound: false });
    FakeNotification.permission = "denied";
    await say(other, dm, "two");
    await settle();
    expect(FakeNotification.made).toEqual([]);
    expect(notes).toBe(2);
  });

  it("reading the room, anywhere, takes its pop-up away", async () => {
    const dm = await me.api.openDm(other.user.id);
    await start(dm);
    const m = await say(other, dm, "read me");
    await vi.waitFor(() => expect(FakeNotification.made).toHaveLength(1), { timeout: 3000 });
    await me.api.markRead(dm.id, m.created); // another tab or device
    await vi.waitFor(() => expect(FakeNotification.made[0]!.closed).toBe(true), { timeout: 3000 });
  });

  it("says on the page once it alerts (the server has its subscriptions), and no more once stopped", async () => {
    store.set({ roomsStatus: "ready" });
    stop = startNotify({ api: me.api, store, title: roomTitle, navigate: vi.fn() });
    expect(document.documentElement.dataset.notify).toBeUndefined();
    await vi.waitFor(() => expect(document.documentElement.dataset.notify).toBe("on"));
    stop();
    stop = undefined;
    expect(document.documentElement.dataset.notify).toBeUndefined();
  });

  it("stopped (logged out): silent", async () => {
    const dm = await me.api.openDm(other.user.id);
    await start(dm);
    stop?.();
    stop = undefined;
    await say(other, dm, "nobody here");
    await settle();
    expect(FakeNotification.made).toEqual([]);
  });
});

describe("notifications: the profile page's settings (§34)", () => {
  let ac: AbortController;
  beforeEach(() => {
    ac = new AbortController();
    FakeNotification.permission = "default";
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
    vi.stubGlobal("AudioContext", FakeAudio);
  });
  afterEach(() => {
    ac.abort();
    localStorage.removeItem(NOTIFY_KEY);
    vi.unstubAllGlobals();
  });

  const mount = (onChange = vi.fn()) => {
    const el = notifySettings({ id: "p", onChange, signal: ac.signal });
    document.body.append(el);
    const box = (name: string) => el.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
    return { el, box, onChange };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("choosing DMs turns the pop-up on, asks the browser, saves, and tells the app", async () => {
    const { el, box, onChange } = mount();
    expect([...el.querySelectorAll("input")].every((i) => !i.checked)).toBe(true);
    box("dms").click();
    await tick();
    expect(box("popup").checked).toBe(true);
    expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
    expect(loadPrefs()).toEqual({ dms: true, replies: false, popup: true, sound: false, rooms: [] });
    expect(onChange).toHaveBeenCalled();
    box("dms").click();
    box("popup").click();
    await tick();
    expect(localStorage.getItem(NOTIFY_KEY)).toBeNull();
    el.remove();
  });

  it("§34.5: keeps the rooms chosen in their menus", async () => {
    savePrefs({ dms: false, replies: false, popup: true, sound: false, rooms: ["r"] });
    const { el, box } = mount();
    box("sound").click();
    await tick();
    expect(loadPrefs()).toEqual({ dms: false, replies: false, popup: true, sound: true, rooms: ["r"] });
    el.remove();
  });

  it("says when the browser blocks pop-ups", async () => {
    FakeNotification.permission = "denied";
    savePrefs({ dms: true, replies: false, popup: true, sound: false, rooms: [] });
    const { el } = mount();
    expect(el.querySelector("[role=status]")!.textContent).toMatch(/blocks notifications/);
    el.remove();
  });
});
