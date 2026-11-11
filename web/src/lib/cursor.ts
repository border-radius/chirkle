// Keyset pagination over a room's messages, ordered by (created, id) — DESIGN.md §6, §7.5.
// Pure: which page to ask GET /api/chat/rooms/{room}/messages for (server/lists.go writes the filter).

export const PAGE_SIZE = 50;

export interface Cursor {
  created: string;
  id: string;
}

export interface PageQuery {
  room: string;
  /** `latest` and `older` pages come back newest-first; `first` and `newer` oldest-first; `changed` oldest change first. */
  kind: "latest" | "first" | "older" | "newer" | "changed";
  /** The page's cursor: `created`, `id`; for `changed`, `since`, `from`, `to`. */
  args: Record<string, string>;
  /** Only messages that may have attachments (`withFiles`). */
  files?: true;
  /** Only messages with every word of it (search, §29; with `latest` and `older`). The server folds and escapes them. */
  q?: string;
}

/** The newest page of a room (newest-first). */
export function latest(room: string): PageQuery {
  return { room, kind: "latest", args: {} };
}

/** The oldest page of a room, i.e. "jump to beginning" (oldest-first). */
export function first(room: string): PageQuery {
  return { room, kind: "first", args: {} };
}

/** The page just before `c`, the oldest loaded message (newest-first). */
export function older(room: string, c: Cursor): PageQuery {
  return { room, kind: "older", args: { created: c.created, id: c.id } };
}

/** The page just after `c`, the newest loaded message (oldest-first). */
export function newer(room: string, c: Cursor): PageQuery {
  return { room, kind: "newer", args: { created: c.created, id: c.id } };
}

/**
 * Messages from `from` to `to` (inclusive, by `created`) changed after `since` (an `updated` value): edits and
 * deletes a client may have missed while its realtime connection was down (§7.5). Oldest change first.
 */
export function changedIn(room: string, since: string, from: Cursor, to: Cursor): PageQuery {
  return { room, kind: "changed", args: { since, from: from.created, to: to.created } };
}

/**
 * Only the messages of `q` that may have attachments (the image viewer pages through those, §17.7): with files of their
 * own, or forwards, whose files are their original's (§21.3). The server can't look at those: the original is
 * usually in a room the reader can't list.
 */
export const withFiles = (q: PageQuery): PageQuery => ({ ...q, files: true });
