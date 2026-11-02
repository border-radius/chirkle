// The app shell's services. Each view takes the part of it that it uses (a Pick of Ctx), so its tests pass only that.

import type { RoomActions } from "./actions.ts";
import type { Api } from "./api.ts";
import type { Cache } from "./cache.ts";
import type { CollectionsService } from "./collections.ts";
import type { Drafts } from "./drafts.ts";
import type { Prefetch } from "./prefetch.ts";
import type { AppState, Store } from "./store.ts";
import type { Sync } from "./sync.ts";
import type { Unread } from "./unread.ts";

export interface Ctx {
  api: Api;
  store: Store<AppState>;
  sync: Sync;
  unread: Unread;
  /** Your collections and those you follow (§31). */
  collections: CollectionsService;
  actions: RoomActions;
  navigate: (hash: string) => void;
  /** Start the current page over, with the same route (a room you can see again, §23.4). */
  reopen: () => void;
  /** Unsent composer text by room id, kept across rooms (QA BUG-50) and reloads (§22.3). Cleared when the session ends. */
  drafts: Drafts;
  /** Each room's latest messages, kept between visits and reloads (§7.5). Cleared when the session ends. */
  cache: Cache;
  /** End the session and go to the login screen (the profile page's Log out, §22.2). */
  logOut: () => void;
  /** The notification settings changed (§34): follow them, if not yet. */
  notify: () => void;
  /** Rooms' latest pages asked for as their links are pressed or pointed at, for the room to start with (prefetch.ts). */
  early?: Pick<Prefetch, "hint" | "take">;
}
