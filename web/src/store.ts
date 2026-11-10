// Tiny observable app state (§7.4). Message lists are owned by the room view, not stored here.

import { type Collections, DEFAULT_SITE, type Room, type Site, type User } from "./lib/types.ts";

type Listener<S> = (state: S, prev: S) => void;

export interface Store<S extends object> {
  get(): S;
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void;
  subscribe(fn: Listener<S>): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === "function" ? patch(state) : patch;
      if (!(Object.keys(p) as (keyof S)[]).some((k) => p[k] !== state[k])) return;
      const prev = state;
      state = { ...state, ...p };
      for (const fn of [...listeners]) fn(state, prev);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Where the room list is in its load cycle (owned by sync.ts). "error" keeps whatever was loaded before. */
export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface AppState {
  user: User | null;
  rooms: Map<string, Room>;
  /** roomId → hidden_rooms row id (needed to unhide). */
  hidden: Map<string, string>;
  /** roomId → unread messages (§18); rooms without any are absent. UNCOUNTED until the counts are first in. */
  unread: Map<string, number>;
  /** roomId → its unread mentions of you and replies to you (§41); rooms without any are absent. */
  mentions: Map<string, number>;
  /** Rows of your "Mentions & replies" inbox you haven't seen (§41), at most 100. */
  inbox: number;
  roomsStatus: LoadStatus;
  /** Room list requests out now (the rooms and hidden rows, the unread counts): a line shows over the list (§7.9). */
  listLoads: number;
  activeRoomId: string | null;
  /** Your collections and those you follow (§31); null until loaded (and for guests). */
  collections: Collections | null;
  /** The collection whose page is open. */
  activeCollectionId: string | null;
  /** The tab isn't visible (§22.4): nobody is reading the open room, so its new messages count too. */
  away: boolean;
  /** Branding and signup policy (§24): not the session's, so it stays when the session ends. */
  site: Site;
}

/** `unread` before the counts are in (just after a reload): a room opened then asks where its unread messages start (QA BUG-93). */
export const UNCOUNTED: Map<string, number> = new Map();

export const initialState = (): AppState => ({
  user: null,
  rooms: new Map(),
  hidden: new Map(),
  unread: UNCOUNTED,
  mentions: new Map(),
  inbox: 0,
  roomsStatus: "idle",
  listLoads: 0,
  activeRoomId: null,
  collections: null,
  activeCollectionId: null,
  away: false,
  site: DEFAULT_SITE,
});

// ---- updates: pass to store.set(). Maps are replaced, never mutated, so listeners can compare by identity.

type Update = (s: AppState) => Partial<AppState>;

/** A room list request went out (1) or is back (-1). */
export const listLoad =
  (d: 1 | -1): Update =>
  (s) => ({ listLoads: s.listLoads + d });

export function upsertRoom(r: Room): Update {
  return (s) => ({ rooms: new Map(s.rooms).set(r.id, r) });
}

export function removeRoom(roomId: string): Update {
  return (s) => {
    const rooms = new Map(s.rooms);
    rooms.delete(roomId);
    return { rooms };
  };
}

export function markHidden(roomId: string, rowId: string): Update {
  return (s) => ({ hidden: new Map(s.hidden).set(roomId, rowId) });
}

/** The room is no longer hidden (e.g. a DM reopened by POST /api/chat/dms, which deleted the row). */
export function unmarkHiddenRoom(roomId: string): Update {
  return (s) => {
    if (!s.hidden.has(roomId)) return {};
    const hidden = new Map(s.hidden);
    hidden.delete(roomId);
    return { hidden };
  };
}

/** Forget a hidden_rooms row (realtime deletes only carry the row id, not the room). */
export function unmarkHidden(rowId: string): Update {
  return (s) => ({ hidden: new Map([...s.hidden].filter(([, row]) => row !== rowId)) });
}

/** One more unread message in the room (a live event, §18.3). */
export function bumpUnread(roomId: string): Update {
  return (s) => ({ unread: new Map(s.unread).set(roomId, (s.unread.get(roomId) ?? 0) + 1) });
}

/** The room has been read (§18.3). */
export function clearUnread(roomId: string): Update {
  return (s) => {
    if (!s.unread.has(roomId) && !s.mentions.has(roomId)) return {};
    const unread = new Map(s.unread);
    const mentions = new Map(s.mentions);
    unread.delete(roomId);
    mentions.delete(roomId);
    return { unread, mentions };
  };
}

// ---- selectors

/**
 * The badge for a room (§18.4): none for hidden or archived rooms, which stay silent (§13). The room you are in keeps
 * its badge (and its place among the unread) until you have scrolled down to its newest messages (2026-11-02).
 */
export function unreadCount(s: AppState, room: Room): number {
  if (room.archived || s.hidden.has(room.id)) return 0;
  return s.unread.get(room.id) ?? 0;
}

/** A room's "@" (§41): it has unread messages that mention you or reply to you. */
export const mentioned = (s: AppState, room: Room): boolean => !!unreadCount(s, room) && !!s.mentions.get(room.id);

/** One collator for every sort: `localeCompare` with options builds a new one per comparison, which is slow. */
const collator = new Intl.Collator(undefined, { sensitivity: "base" });
const byName = (a: Room, b: Room) => collator.compare(a.name, b.name);

/** Most recent activity first: the latest message, or creation for a DM without one yet. */
const byActivity = (a: Room, b: Room) => {
  const at = a.last_message_at || a.created || "";
  const bt = b.last_message_at || b.created || "";
  return at < bt ? 1 : at > bt ? -1 : a.id.localeCompare(b.id);
};

/**
 * Room list sections (§7.1, §16.5). Archived wins over hidden. Open DMs are listed by activity; closed
 * (hidden) DMs are left out entirely, and a DM is never archived. A DM nobody has written in yet is listed only for
 * the member who opened it, so just opening one doesn't show up for the other person (QA BUG-29), and while it is
 * open: the other member may have opened it too, and their DM must not be missing from their own list (QA BUG-37).
 * Rooms and DMs with unread messages are listed first.
 */
export function roomSections(s: AppState): { rooms: Room[]; dms: Room[]; hidden: Room[]; archived: Room[] } {
  const rooms: Room[] = [];
  const dms: Room[] = [];
  const hidden: Room[] = [];
  const archived: Room[] = [];
  for (const r of s.rooms.values()) {
    if (r.kind === "dm") {
      const started = !!r.last_message_at || r.created_by === s.user?.id || r.id === s.activeRoomId;
      if (started && !s.hidden.has(r.id)) dms.push(r);
    } else if (r.archived) archived.push(r);
    else if (s.hidden.has(r.id)) hidden.push(r);
    else rooms.push(r);
  }
  // Rooms and DMs with unread messages first, each group in its usual order.
  const unreadFirst = (by: (a: Room, b: Room) => number) => (a: Room, b: Room) =>
    Number(!unreadCount(s, a)) - Number(!unreadCount(s, b)) || by(a, b);
  return {
    rooms: rooms.sort(unreadFirst(byName)),
    dms: dms.sort(unreadFirst(byActivity)),
    hidden: hidden.sort(byName),
    archived: archived.sort(byName),
  };
}
