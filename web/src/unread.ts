// Unread counts (§18.3): keeps `unread` in the store and tells the server what has been read, for as long as someone
// is logged in. The room view only reports what it shows (`open(roomId).seen(created, caughtUp)`); this module owns the
// counting, the batching of reads, retries, and whose session a read belongs to.

import { type Api, ApiError } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, bumpUnread, clearUnread, listLoad, type Store } from "./store.ts";

export interface Unread {
  /** Load the counts and follow them live. Call once a user is logged in. */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Pending reads are dropped: flush() first to keep them. */
  stop(): void;
  /** Refetch the counts soon (several calls in a row make one request). */
  refresh(): void;
  /** Send every pending read now (before the session ends, e.g. on logout). */
  flush(): void;
  /** Start reading a room (the room view, while mounted). */
  open(roomId: string): RoomReader;
}

export interface RoomReader {
  /**
   * The messages up to `created` (a message's `created`) have been on screen: read. `caughtUp` is whether that was
   * the newest one (the room's count is then cleared). Cheap to call on every render and scroll.
   */
  seen(created: string, caughtUp: boolean): void;
  /**
   * Leaving the room: send a pending read now. `caughtUp` is whether the newest messages were on screen at the end;
   * if not, messages may have arrived unseen (they aren't counted live in the room you are in), so refetch.
   */
  close(caughtUp: boolean): void;
}

export interface UnreadTiming {
  /** How long refresh() waits for more calls before it fetches. */
  refreshMs: number;
  /** How long reads are batched before the server is told. */
  readMs: number;
  /** The first wait before a failed read is sent again; it doubles each time, up to MAX_RETRY_MS. */
  retryMs: number;
}

const TIMING: UnreadTiming = { refreshMs: 250, readMs: 1000, retryMs: 2000 };
const MAX_RETRY_MS = 60_000;

export function createUnread({ api, store, timing = TIMING }: { api: Api; store: Store<AppState>; timing?: UnreadTiming }): Unread {
  /** The current run; callbacks hold on to theirs, so a restart can't revive them. */
  let scope: Scope | null = null;
  /**
   * The live +1s received while a count request is in flight. Those its answer doesn't account for (`ids`) are added
   * back on top (never refetched: a busy room would starve the counts, QA).
   */
  let recent: { room: string; id: string }[] = [];
  /**
   * The recent messages the counts in the store account for: their live events, late, are already counted (QA BUG-106).
   * Not reset by start(): a new session's events are all of messages newer than any of these.
   */
  let accounted = new Set<string>();
  let inFlight = 0;
  /** `at` of the counts in the store: an older answer that arrives late is dropped. */
  let countedAt = "";
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The open room while its newest messages are on screen (its reader last said `caughtUp`): its count is the room
   * view's to clear, and what arrives in it is read as it comes. Scrolled up, or opened at its first unread message, it
   * keeps the server's count, badge included: the rest is still unread (2026-11-02, user).
   */
  let following: string | null = null;
  /** Readers with a read not sent yet. */
  const pending = new Set<{ send(): void }>();

  async function load(s: Scope) {
    inFlight++;
    store.set(listLoad(1));
    try {
      const res = await api.unreadCounts(s.signal).catch(() => null);
      if (!res || !s.active || res.at < countedAt) return;
      countedAt = res.at;
      accounted = new Set(res.ids);
      const unread = new Map(Object.entries(res.rooms));
      for (const b of recent) if (!accounted.has(b.id)) unread.set(b.room, (unread.get(b.room) ?? 0) + 1);
      // The room you are caught up in is the room view's to clear; the server may not have its latest read yet. Not
      // while the tab is away: then the room view reads nothing, and the server's count is the one to show.
      const mentions = new Map(Object.entries(res.mentions ?? {}));
      if (following && !store.get().away) {
        unread.delete(following);
        mentions.delete(following);
      }
      store.set({ unread, mentions, inbox: res.inbox ?? 0 });
    } finally {
      store.set(listLoad(-1));
      if (--inFlight === 0) recent = [];
    }
  }

  function refresh() {
    const s = scope;
    if (!s) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void load(s), timing.refreshMs);
  }

  function open(roomId: string): RoomReader {
    /** The session this reader belongs to: reads are never sent from another one. */
    const s = scope;
    /** Whose reads these are: the session is shared with other tabs, which may switch it to someone else. */
    const reader = store.get().user?.id ?? "";
    /** Read up to here: sent, or about to be when `timer` fires. */
    let readAt = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    /** Failed sends in a row: the next retry waits longer. */
    let failures = 0;
    /** What the last seen() said: not caught up, the count is fetched again once a read is in. */
    let caughtUpNow = false;
    const live = () => !closed && !!s?.active && s === scope;

    const self = {
      send(): Promise<void> | undefined {
        clearTimeout(timer);
        timer = undefined;
        pending.delete(self);
        if (!s?.active || api.currentUser()?.id !== reader) return; // never as someone else
        const at = readAt;
        return api.markRead(roomId, at).then(
          () => {
            failures = 0;
            // What is still unread below the screen: the server counts it.
            if (!caughtUpNow && live()) refresh();
          },
          (e: unknown) => {
            // Offline, or the server in trouble: sent again a little later. Nothing else may ask (the room on screen
            // doesn't change), and the room would stay unread everywhere (QA BUG-162). A refusal is final.
            const status = e instanceof ApiError ? e.status : 0;
            if ((status >= 400 && status < 500 && status !== 429) || !live() || timer) return;
            pending.add(self);
            timer = setTimeout(self.send, Math.min(timing.retryMs * 2 ** Math.min(failures++, 5), MAX_RETRY_MS));
          },
        );
      },
    };

    return {
      seen(created, caughtUp) {
        if (!live()) return;
        caughtUpNow = caughtUp;
        if (caughtUp) following = roomId;
        else if (following === roomId) following = null;
        // Even with nothing new: a count fetched while the tab was away may include what was already read. Not before
        // the newest message: the rest is still unread (close() refetches the count).
        if (caughtUp) store.set(clearUnread(roomId));
        if (created <= readAt) return;
        readAt = created;
        if (timer) return;
        pending.add(self);
        timer = setTimeout(self.send, timing.readMs);
      },
      close(caughtUp) {
        if (closed) return;
        if (following === roomId) following = null;
        const sent = timer ? self.send() : undefined;
        if (live()) {
          if (caughtUp) store.set(clearUnread(roomId));
          // After the read is in: counted before it, the messages just read would show as unread again.
          else if (sent) void sent.then(refresh);
          else refresh();
        }
        closed = true;
      },
    };
  }

  return {
    start() {
      if (scope) return;
      const s = createScope();
      scope = s;
      countedAt = "";
      s.defer(() => clearTimeout(refreshTimer));
      s.sub(
        api.subscribeAllMessages((action, m) => {
          if (!s.active) return;
          const { user, away, unread } = store.get();
          // The room you are caught up in is read as it arrives (the room view reports it), unless the tab is away;
          // scrolled up, it stays unread. Your own messages never count.
          if (action === "create" && m.author !== user?.id && (m.room !== following || away) && !accounted.has(m.id)) {
            if (inFlight) recent.push({ room: m.room, id: m.id });
            store.set(bumpUnread(m.room));
          } else if (action === "update" && m.deleted && unread.has(m.room)) refresh(); // was it unread?
        }),
      );
      // A mention, reply or reaction for you, or one taken back (§41): counted again.
      s.sub(api.subscribeInbox(() => s.active && refresh()));
      s.sub(
        api.subscribeReads((_action, row) => {
          // Read in another tab or on another device. The room you are caught up in is already at 0 here, unless the
          // tab is away.
          if (s.active && (row.room !== following || store.get().away)) refresh();
        }),
      );
      s.defer(
        api.onConnect((reconnect) => {
          if (reconnect && s.active) void load(s);
        }),
      );
      // A room you can now see (you were added to a private room, §23.2) may already have messages for you.
      // Leaving the tab: the open room may have messages that arrived unseen (scrolled up), which only the server
      // counts. What was read is sent first.
      s.defer(
        store.subscribe((st, prev) => {
          if (!s.active) return;
          if (prev.roomsStatus === "ready" && st.rooms !== prev.rooms && [...st.rooms.keys()].some((id) => !prev.rooms.has(id))) refresh();
          if (st.away && !prev.away && st.activeRoomId) {
            for (const r of [...pending]) r.send();
            refresh();
          }
        }),
      );
      void load(s);
    },
    stop() {
      pending.clear();
      scope?.dispose();
      scope = null;
    },
    refresh,
    flush() {
      for (const r of [...pending]) r.send();
    },
    open,
  };
}
