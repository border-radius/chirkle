// Keeps the room list and the user's hidden rows in the store (§7.4): one load, one set of realtime
// subscriptions and a reload after every reconnect, for as long as the app runs: for a guest too, who only gets the
// Open Air rooms and has nothing hidden (§23.3). Restarted whenever someone logs in or out. Views only read.
// Unread counts have their own service (unread.ts).

import type { Api } from "./api.ts";
import { createScope, type Scope } from "./scope.ts";
import { type AppState, listLoad, markHidden, removeRoom, type Store, unmarkHidden, upsertRoom } from "./store.ts";

type Update = ReturnType<typeof upsertRoom>;

export interface Sync {
  /** Load and subscribe, as whoever is logged in now (or as a guest). */
  start(): void;
  /** Unsubscribe and ignore anything still in flight. Leaves the store as it is. */
  stop(): void;
  /** Refetch both lists (also runs on every realtime reconnect, since events may have been missed). */
  reload(): Promise<void>;
}

export function createSync({ api, store }: { api: Api; store: Store<AppState> }): Sync {
  /** The current run; callbacks hold on to theirs, so a restart can't revive them. */
  let scope: Scope | null = null;

  /** The current run is a guest's (§23.3). */
  let guest = true;

  /** Loads are numbered; an answer older than the one in the store is dropped. */
  let issued = 0;
  let applied = 0;

  function apply(s: Scope, update: Update) {
    if (s.active) store.set(update);
  }

  /** Loads out now. */
  let inFlight = 0;
  /**
   * The rooms whose entry in `rooms`, and those whose entry in `hidden`, changed in the store while a load was out,
   * however: a live event, or this tab itself (a room created, a DM opened, a room hidden or shown), which may have no
   * event yet. A load's answer is older, so these are taken from the store as it is then, or left out if gone from it:
   * a room you were just taken out of isn't listed again (§23.4), an archive isn't undone (QA BUG-69), a DM just
   * opened doesn't vanish (QA BUG-107).
   */
  let changed = { rooms: new Set<string>(), hidden: new Set<string>() };
  const track = (st: AppState, prev: AppState) => {
    if (inFlight)
      for (const k of ["rooms", "hidden"] as const)
        for (const id of new Set([...st[k].keys(), ...prev[k].keys()])) if (st[k].get(id) !== prev[k].get(id)) changed[k].add(id);
  };
  /** `answer` with the entries in `ids` as they are in `now`. */
  function settle<V>(answer: Map<string, V>, now: Map<string, V>, ids: Set<string>): Map<string, V> {
    for (const id of ids) now.has(id) ? answer.set(id, now.get(id)!) : answer.delete(id);
    return answer;
  }

  async function load(s: Scope) {
    const seq = ++issued;
    if (!inFlight++) changed = { rooms: new Set<string>(), hidden: new Set<string>() };
    if (store.get().roomsStatus !== "ready") store.set({ roomsStatus: "loading" });
    store.set(listLoad(1));
    try {
      const [rooms, hidden] = await Promise.all([api.listRooms(s.signal), guest ? [] : api.listHidden(s.signal)]);
      if (!s.active || seq < applied) return;
      applied = seq;
      // One store update: one by one, a room the answer lacks would vanish and come back, which views see as a room
      // returning (§23.4).
      const now = store.get();
      store.set({
        rooms: settle(new Map(rooms.map((x) => [x.id, x])), now.rooms, changed.rooms),
        hidden: settle(new Map(hidden.map((x) => [x.room, x.id])), now.hidden, changed.hidden),
        roomsStatus: "ready",
      });
    } catch {
      if (s.active && seq >= applied) store.set({ roomsStatus: "error" });
    } finally {
      inFlight--;
      store.set(listLoad(-1));
    }
  }

  return {
    start() {
      if (scope) return;
      const s = createScope();
      scope = s;
      guest = !api.currentUser();
      s.defer(store.subscribe(track));
      s.sub(api.subscribeRooms((action, room) => apply(s, action === "delete" ? removeRoom(room.id) : upsertRoom(room))));
      if (!guest) {
        s.sub(api.subscribeHidden((action, row) => apply(s, action === "delete" ? unmarkHidden(row.id) : markHidden(row.room, row.id))));
      }
      s.defer(
        api.onConnect((reconnect) => {
          if (reconnect && s.active) void load(s);
        }),
      );
      void load(s);
    },
    stop() {
      scope?.dispose();
      scope = null;
    },
    async reload() {
      if (scope) await load(scope);
    },
  };
}
