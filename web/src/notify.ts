// Notifications (§34): a pop-up and/or a sound for DMs, replies to you and every message of the rooms chosen (§34.5), while the app is open in a tab, even in the
// background. No push service: the alerts come from the realtime connection the tab already holds, so nothing reaches
// Google, Mozilla or Apple, and nothing arrives once every tab is closed.
//
// A lazy chunk: app.ts import()s it for someone who turned notifications on (NOTIFY_KEY), the profile page for its
// settings.
//
// - One tab alerts: the one holding the "chat.notify" Web Lock (the others wait for it, and one takes over when it
//   closes). It asks the other tabs over a BroadcastChannel whether one of them is in front.
// - In front (a focused tab): no pop-up, the sound only, and nothing for the room open there.
// - Pop-ups go through the service worker (needed on Android, where a page can't make one), one per room: the newest
//   replaces the last. Clicking one opens its message (sw.ts). Reading the room, anywhere, closes it.

import type { Api, MessageActivity } from "./api.ts";
import { h } from "./dom.ts";
import type { Message, Room, User } from "./lib/types.ts";
import type { AppState, Store } from "./store.ts";

/** This device's choices, in localStorage; absent when everything is off. Must match app.ts's. */
export const NOTIFY_KEY = "chat.notify";

/** What alerts (DMs, replies to you, every message of `rooms`) and how (a pop-up, a sound). */
export interface NotifyPrefs {
  dms: boolean;
  replies: boolean;
  popup: boolean;
  sound: boolean;
  /** Rooms whose every message alerts, chosen in the room's menu (§34.5; views/room/header.ts writes it too). */
  rooms: string[];
}

const OFF: NotifyPrefs = { dms: false, replies: false, popup: false, sound: false, rooms: [] };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs(s: Storage | null = storage()): NotifyPrefs {
  try {
    const p = JSON.parse(s?.getItem(NOTIFY_KEY) ?? "null") as Partial<NotifyPrefs> | null;
    const rooms = Array.isArray(p?.rooms) ? p.rooms.filter((r): r is string => typeof r === "string") : [];
    return { dms: p?.dms === true, replies: p?.replies === true, popup: p?.popup === true, sound: p?.sound === true, rooms };
  } catch {
    return { ...OFF, rooms: [] };
  }
}

export function savePrefs(p: NotifyPrefs, s: Storage | null = storage()): void {
  try {
    if (p.rooms.length || Object.values(p).some((v) => v === true)) s?.setItem(NOTIFY_KEY, JSON.stringify(p));
    else s?.removeItem(NOTIFY_KEY);
  } catch {}
}

/**
 * Could this message be one to alert about? "dm", "all" (a room chosen) or "reply" (it mentions you, §41, or its quoted
 * message is still to be checked: is it yours?), "room" when its room isn't loaded yet (a DM just started), null when not.
 */
export function candidate(p: NotifyPrefs, m: MessageActivity, s: AppState): Kind | "room" | null {
  const me = s.user;
  if (!me || !m.author || m.author === me.id || m.deleted || !(p.popup || p.sound)) return null;
  const room = s.rooms.get(m.room);
  const toMe = !!m.reply_to || !!m.mentions?.includes(me.id);
  if (!room) return p.dms || (p.replies && toMe) || p.rooms.includes(m.room) ? "room" : null;
  return alertKind(p, room, s, toMe);
}

type Kind = "dm" | "reply" | "all";

/** The kind of alert for a message in `room`; `reply`: it replies to one of yours or mentions you. Hidden and archived rooms are silent (§13). */
function alertKind(p: NotifyPrefs, room: Room, s: AppState, reply: boolean): Kind | null {
  if (room.archived) return null;
  // A closed DM opens again with a message (§16.4): its hidden row goes, maybe after this event.
  if (room.kind === "dm") return p.dms ? "dm" : null;
  if (s.hidden.has(room.id)) return null;
  return reply && p.replies ? "reply" : p.rooms.includes(room.id) ? "all" : null;
}

/** What a notification says under its title: the text on one line, cut short; or what was sent instead. */
export function bodyOf(m: Pick<Message, "text" | "files" | "forward_of">): string {
  const text = m.text.replace(/\s+/g, " ").trim();
  if (text) return text.length > 140 ? `${text.slice(0, 139)}…` : text;
  if (m.files?.length) return m.files.length === 1 ? "Sent an attachment" : `Sent ${m.files.length} attachments`;
  return m.forward_of ? "Forwarded a message" : "";
}

// ---------------------------------------------------------------- the sound

let audio: AudioContext | undefined;

/** A short two-note chime, made here (no sound file). Silent until the page has been clicked or typed in once. */
export function chime(): void {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const t = audio.currentTime;
    for (const [freq, at] of [
      [880, 0],
      [1318.5, 0.11],
    ] as const) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.18, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.35);
      osc.connect(gain).connect(audio.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.36);
    }
  } catch {}
}

// ---------------------------------------------------------------- following the messages

export interface NotifyOptions {
  api: Api;
  store: Store<AppState>;
  /** A room's name as the room list shows it (lib/rooms.ts roomTitle). */
  title: (room: Room, me: User | null) => string;
  navigate: (path: string) => void;
}

/** Across this browser's tabs: "ask" who is in front, "here" (the answer), "play" the sound there. */
type Note = { t: "ask"; id: string; user: string } | { t: "here"; id: string; room: string } | { t: "play"; id: string; user: string };

/** How long to wait for a tab in front to say so. */
const ASK_MS = 200;
/** How long a room not loaded yet (a DM just started) is waited for. */
const ROOM_MS = 3000;

const front = () => document.visibilityState === "visible" && document.hasFocus();

const permitted = () => globalThis.Notification?.permission === "granted";

/** Follow the messages and alert. Returns a function that stops. */
export function startNotify({ api, store, title, navigate }: NotifyOptions): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  const me = store.get().user?.id ?? "";
  let leader = !globalThis.navigator?.locks; // without Web Locks, each tab alerts
  /** This tab alerts once it leads (another tab may hold the lock until it closes). */
  let leading: () => void = () => {};
  const leads = leader ? Promise.resolve() : new Promise<void>((resolve) => (leading = resolve));
  void navigator.locks
    ?.request("chat.notify", { signal }, () => {
      leader = true;
      leading();
      return new Promise<void>((done) => signal.addEventListener("abort", () => done()));
    })
    .catch(() => {});
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("chat.notify") : null;
  const answers = new Map<string, (room: string) => void>();
  /** Pop-ups made without the service worker, by room. */
  const shown = new Map<string, Notification>();
  const live = () => !signal.aborted && store.get().user?.id === me;

  if (channel)
    channel.onmessage = ({ data }: MessageEvent<Note>) => {
      if (!live()) return;
      if (data.t === "here") answers.get(data.id)?.(data.room);
      else if (data.user !== me) return;
      else if (data.t === "ask" && front()) channel.postMessage({ t: "here", id: data.id, room: inFront() } satisfies Note);
      else if (data.t === "play" && front()) chime();
    };
  /** The room open in this tab, "" for another page. */
  const inFront = () => (store.get().away ? "" : (store.get().activeRoomId ?? ""));

  /** The room open in the tab in front, "" for none open there, null for no tab in front. */
  function whereInFront(id: string): Promise<string | null> {
    if (front()) return Promise.resolve(inFront());
    if (!channel) return Promise.resolve(null);
    return new Promise((done) => {
      const end = (room: string | null) => {
        answers.delete(id);
        clearTimeout(timer);
        done(room);
      };
      const timer = setTimeout(() => end(null), ASK_MS);
      answers.set(id, end);
      channel.postMessage({ t: "ask", id, user: me } satisfies Note);
    });
  }

  /** The room, once the store has it (a new DM's arrives with its own event). */
  function roomOf(id: string): Promise<Room | undefined> {
    const now = store.get().rooms.get(id);
    if (now) return Promise.resolve(now);
    return new Promise((done) => {
      const end = (r: Room | undefined) => {
        off();
        clearTimeout(timer);
        done(r);
      };
      const off = store.subscribe((s) => s.rooms.has(id) && end(s.rooms.get(id)));
      const timer = setTimeout(() => end(undefined), ROOM_MS);
    });
  }

  async function popup(room: Room, m: Message, kind: Kind, sound: boolean) {
    const s = store.get();
    const author = m.expand?.author?.name ?? "Someone";
    const opts = {
      body: bodyOf(m),
      tag: room.id,
      renotify: true, // a newer message in the same room alerts again
      silent: sound, // the chime instead of the system's
      icon: "/icons/icon-192.png",
      data: { url: `/r/${room.id}/m/${m.id}` },
    } as NotificationOptions;
    const did = kind !== "reply" ? "in" : m.expand?.reply_to?.author === s.user?.id ? "replied in" : "mentioned you in";
    const head = kind === "dm" ? author : `${author} ${did} ${title(room, s.user)}`;
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    if (reg?.active) return reg.showNotification(head, opts);
    const n = new Notification(head, opts);
    n.onclick = () => {
      focus();
      navigate(`/r/${room.id}/m/${m.id}`);
      n.close();
    };
    shown.get(room.id)?.close();
    shown.set(room.id, n);
  }

  /** The room was read (here, in another tab, on another device): its pop-up goes. */
  async function dismiss(roomId: string) {
    shown.get(roomId)?.close();
    shown.delete(roomId);
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    for (const n of (await reg?.getNotifications({ tag: roomId }).catch(() => [])) ?? []) n.close();
  }

  async function onMessage(a: MessageActivity) {
    const p = loadPrefs();
    if (!leader || !live() || !candidate(p, a, store.get())) return;
    const m = await api.getMessage(a.id).catch(() => null);
    const room = m && (await roomOf(m.room));
    if (!m || !room || !live() || m.deleted) return;
    const kind = alertKind(p, room, store.get(), m.expand?.reply_to?.author === me || !!m.mentions?.includes(me));
    if (!kind) return;
    const there = await whereInFront(m.id);
    if (!live() || there === room.id) return; // being read
    if (there !== null) {
      if (!p.sound) return;
      if (front()) chime();
      else channel?.postMessage({ t: "play", id: m.id, user: me } satisfies Note);
      return;
    }
    if (p.sound) chime();
    if (p.popup && permitted()) await popup(room, m, kind, p.sound).catch(() => {});
  }

  const subs = [
    api.subscribeAllMessages((action, m) => action === "create" && void onMessage(m)),
    api.subscribeReads((_action, row) => void dismiss(row.room)),
  ];
  // Alerting from here on: the server has both subscriptions and this tab leads. Said on the page, for tests to wait on.
  void Promise.all([...subs, leads]).then(
    () => {
      if (live()) document.documentElement.dataset.notify = "on";
    },
    () => {},
  );
  const offStore = store.subscribe((s, prev) => {
    if (s.activeRoomId && !s.away && (s.activeRoomId !== prev.activeRoomId || prev.away)) void dismiss(s.activeRoomId);
  });
  // Clicked in a tab that was closed or behind (sw.ts): its message.
  navigator.serviceWorker?.addEventListener(
    "message",
    (e: MessageEvent<{ open?: unknown }>) => typeof e.data?.open === "string" && live() && navigate(e.data.open),
    { signal },
  );
  // Browsers let a page play sound only once it has been used: a click or key (with the sound on) starts the audio.
  const unlock = () => {
    if (loadPrefs().sound) {
      audio ??= new AudioContext();
      void audio.resume();
    }
  };
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, unlock, { capture: true, signal });

  return () => {
    ac.abort();
    delete document.documentElement.dataset.notify;
    channel?.close();
    offStore();
    for (const n of shown.values()) n.close();
    for (const sub of subs) void sub.then((off) => off()).catch(() => {});
  };
}

// ---------------------------------------------------------------- the profile page's settings

export interface SettingsOptions {
  id: string;
  /** The choices changed: app.ts starts following them if it isn't yet. */
  onChange: () => void;
  signal: AbortSignal;
}

const BLOCKED = "Your browser blocks notifications from this site. Allow them in its settings for this site.";
const UNSUPPORTED = "This browser can't show notifications here: choose the sound.";

/** The Notifications fieldset of the profile page (§34). */
export function notifySettings({ id, onChange, signal }: SettingsOptions): HTMLElement {
  const box = (key: Exclude<keyof NotifyPrefs, "rooms">, label: string) => {
    const input = h("input", { type: "checkbox", name: key });
    return { input, el: h("label", { class: "notify-choice" }, [input, label]) };
  };
  const boxes = {
    dms: box("dms", "Direct messages"),
    replies: box("replies", "Mentions and replies"),
    popup: box("popup", "Show a pop-up"),
    sound: box("sound", "Play a sound"),
  };
  const read = (): NotifyPrefs => ({
    rooms: loadPrefs().rooms,
    dms: boxes.dms.input.checked,
    replies: boxes.replies.input.checked,
    popup: boxes.popup.input.checked,
    sound: boxes.sound.input.checked,
  });
  const status = h("p", { id: `${id}-notify-status`, class: "field-status", role: "status" });

  const show = () => {
    const p = loadPrefs();
    for (const [k, b] of Object.entries(boxes)) b.input.checked = p[k as keyof typeof boxes];
    const perm = globalThis.Notification?.permission;
    status.textContent = !p.popup ? "" : !perm ? UNSUPPORTED : perm === "denied" ? BLOCKED : "";
    status.classList.toggle("error", !!status.textContent);
  };

  async function change(e: Event) {
    const input = e.target as HTMLInputElement;
    const p = read();
    // Something to be told about, and no way chosen yet: a pop-up.
    if (input.checked && (input === boxes.dms.input || input === boxes.replies.input) && !p.popup && !p.sound) p.popup = true;
    savePrefs(p);
    show();
    if (input === boxes.sound.input && p.sound) chime(); // what it sounds like
    if (p.popup && globalThis.Notification?.permission === "default") {
      await Notification.requestPermission().catch(() => {});
      show();
    }
    onChange();
  }

  const el = h("fieldset", { class: "profile-theme profile-notify", "aria-describedby": `${id}-notify-hint ${id}-notify-status` }, [
    h("legend", {}, "Notifications"),
    boxes.dms.el,
    boxes.replies.el,
    boxes.popup.el,
    boxes.sound.el,
    h(
      "p",
      { id: `${id}-notify-hint`, class: "field-status" },
      "For DMs, replies to you and the rooms you choose in their menu, while this app is open in a tab, even in the background. Saved on this device.",
    ),
    status,
  ]);
  el.addEventListener("change", (e) => void change(e), { signal });
  // Changed in another tab.
  addEventListener("storage", (e) => (e.key === NOTIFY_KEY || e.key === null) && show(), { signal });
  show();
  return el;
}
