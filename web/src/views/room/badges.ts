// A room's collections (§31): the badges on messages sent from a collection's items, and the save menu and the picker,
// which are the collections' lazy chunk. Badges are asked for together after a render, and told live.
// (In views/room.ts until REFACTOR item 53.)

import type { Ctx } from "../../context.ts";
import type { Badge, LocalFile, Message } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import { chunkContext, collectionChunk } from "../collection.ts";

/** What the room's collections use of the room view. */
export interface RoomCollectionsHost extends Pick<Ctx, "api" | "store" | "collections"> {
  scope: Scope;
  /** Badges came in: draw the list again, keeping what is on screen where it is. */
  rerender: () => void;
  /** Items picked: they join the composer's tray. */
  addItems: (items: LocalFile[]) => void;
  /** Say something in the room's status line. */
  say: (text: string) => void;
}

export interface RoomCollections {
  /** What collection `id`'s badge says: undefined while asked (a render asks), null for none. */
  badge(id: string): Badge | undefined;
  /** The save menu for a file of `m` (a forward's is its original's, §21.3). */
  saveFile(m: Message, file: string, opener: HTMLElement): void;
  /** The picker: at most `max` items, which join the composer's tray. */
  pickItems(opener: HTMLElement, max: number): void;
}

export function createRoomCollections({ api, store, collections, scope, rerender, addItems, say }: RoomCollectionsHost): RoomCollections {
  const { signal } = scope;
  /** What each collection's badge says, by id: undefined while asked. */
  const badges = new Map<string, Badge | undefined>();
  const asking = new Set<string>();
  let listening = false;

  function badge(id: string): Badge | undefined {
    if (!badges.has(id)) {
      badges.set(id, undefined);
      ask(id);
      // Told live when one is made public or private, renamed or deleted; asked again after a reconnect (missed).
      if (!listening) {
        listening = true;
        scope.sub(api.subscribeBadges(ask));
        scope.defer(api.onConnect((re) => re && [...badges.keys()].map(ask)));
      }
    }
    return badges.get(id);
  }
  /** Asked together, at the end of the task. A badge shown says what it said until the answer. */
  function ask(id: string) {
    if (!badges.has(id) || asking.has(id)) return;
    if (!asking.size) queueMicrotask(askBadges);
    asking.add(id);
  }
  function askBadges() {
    const ids = [...asking];
    asking.clear();
    for (let i = 0; i < ids.length; i += 50) {
      const some = ids.slice(i, i + 50);
      api.badges(some, signal).then(
        (got) => {
          for (const id of some) badges.set(id, got[id] ?? null);
          rerender();
        },
        () => {
          for (const id of some) badges.delete(id); // asked again by the next render
        },
      );
    }
  }

  const lazy = () => ({ ...chunkContext({ api, store, collections }), signal });
  const failed = () => scope.active && say("Couldn't open collections. Check your connection.");

  return {
    badge,
    saveFile(m, file, opener) {
      collectionChunk().then(
        (c) => scope.active && void c.openSave({ ...lazy(), from: { message: m.forward_of || m.id, file }, opener }),
        failed,
      );
    },
    pickItems(opener, max) {
      collectionChunk().then(
        (c) =>
          scope.active &&
          void c.openPicker({
            ...lazy(),
            max,
            opener,
            onPick: (items) =>
              addItems(
                items.map((it) => ({
                  file: new File([], it.name || it.file),
                  url: it.video ? (it.poster ? api.itemPosterUrl(it) : "") : api.itemUrl(it, "800x480f"),
                  item: { id: it.id, collection: it.collection },
                })),
              ),
          }),
        failed,
      );
    },
  };
}
