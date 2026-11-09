// Shapes of records as the frontend sees them (DESIGN.md §5, §6).

export interface User {
  id: string;
  name: string;
  /** Avatar filename (§15); "" or absent when the user has none. */
  avatar?: string;
  /** Doesn't take direct messages (§16.7), e.g. a Telegram bridge's stand-in; absent where the server doesn't say. */
  no_dms?: boolean;
  /** Someone on a linked instance (§33.4): its host, e.g. "b.example". Absent for this instance's own people. */
  instance?: string;
  /** You are a moderator (§36): only said of the signed-in user. */
  moderator?: boolean;
  /** What "@handle" names (§41), without the "@"; absent where the server doesn't say. */
  handle?: string;
}

/**
 * Who else holds a shared room (§33.10): `home`, on a copy of another instance's room (its host); `with`, the other
 * instances that have it; `down`, its home can't be reached right now. Empty for a room that isn't shared.
 */
export interface Shared {
  home?: string;
  with?: string[];
  down?: boolean;
}

export type RoomKind = "public" | "dm";

/**
 * Who can see a room (§23.1): its members only, every signed-in user, or anyone at all, even without an account
 * (Open Air). A DM is private to its two members.
 */
export type Visibility = "private" | "public" | "open";
/** Who can post in a room (§23.6): everyone who can read it, or only its writers. */
export type Posting = "everyone" | "selected";

export interface Room {
  id: string;
  /** "" for a DM: its title is the other member's name (lib/rooms.ts). */
  name: string;
  archived: boolean;
  created_by: string;
  /** Absent = "public" (§16.1). */
  kind?: RoomKind;
  /** Absent = "public" (§23.1). */
  visibility?: Visibility;
  /** A DM's two members, or a private room's (the creator and whoever they added, §23.2); empty otherwise. */
  members?: string[];
  /** Absent = "everyone" (§23.6). */
  posting?: Posting;
  /** Who can post when posting is "selected": the creator and the people they chose (§23.6); empty otherwise. */
  writers?: string[];
  /** DMs: when the latest message was sent ("" before the first). */
  last_message_at?: string;
  created?: string;
  /** Shared with other instances (§33). */
  shared?: Shared | null;
  expand?: { members?: User[]; writers?: User[] };
}

/** Client-only send state for optimistic messages (§7.5). Absent once the server has the message. */
export type SendStatus = "pending" | "failed";

export interface Message {
  id: string;
  room: string;
  /** "" for a service message (§5.3): the app's own notice in the room, e.g. a Telegram group disconnected. */
  author: string;
  text: string;
  /** PocketBase datetime, e.g. "2026-10-10 12:34:56.789Z". */
  created: string;
  updated: string;
  /** "" when never edited. */
  edited_at: string;
  deleted: boolean;
  /** Stored attachment names (§17.1); empty or absent when there are none. */
  files?: string[];
  /** Original upload names by stored name, set by the server (QA BUG-28); absent for older messages. */
  file_names?: Record<string, string>;
  /** Stored name → the collection it was attached from (§31); absent or empty for the others. */
  file_sources?: Record<string, string>;
  /** Stored image or video name → [width, height] as shown (§17.5), set by the server; absent until it knows. */
  file_dims?: Record<string, [number, number]>;
  /** The message this one replies to (§19); "" or absent when it isn't a reply. */
  reply_to?: string;
  /** Emoji reactions (§20), in the order they were first added; empty or absent when there are none. */
  reactions?: Reaction[];
  /** Who first wrote it, when it was forwarded (§21.3); "" or absent otherwise. */
  forwarded_from?: string;
  /**
   * The message a forward shows (§21.3): the server answers with its text, attachments and edit stamp, or none once
   * it is deleted. "" or absent otherwise, and for forwards made before forwards pointed at their original.
   */
  forward_of?: string;
  /** Who its "@handle"s name (§41): user ids, set by the server; empty or absent when none. */
  mentions?: string[];
  /** What its links show (§28), set by the server once it has fetched them; empty or absent until then. */
  previews?: LinkPreview[];
  expand?: { author?: User; reply_to?: Quoted; forwarded_from?: User };
  status?: SendStatus;
  /** Client-only: attachments of a message not (yet) on the server, with local preview URLs (§17.4). */
  localFiles?: LocalFile[];
}

/** A link's line under a message (§28): the page's title, and its favicon as a data: URL ("" when it has none). */
export interface LinkPreview {
  url: string;
  title: string;
  icon: string;
}

/** One image or video in a room's media grid (§30.1): a file of `source`, shown by `message` (a forward, or itself). */
export interface MediaItem {
  message: string;
  source: string;
  file: string;
  /** Its place in the source's files. */
  pos: number;
  /** The original upload name, "" when the server has none (QA BUG-28). */
  name: string;
  video: boolean;
  /** A video's poster frame is ready (GET /api/chat/posters/{source}/{file}). */
  poster: boolean;
  /** The message's `created`. */
  sent: string;
  /** Who sent the message; null for a service message. */
  author: { id: string; name: string } | null;
}

/** A page of a room's media, newest first; `more`: there are older ones. */
export interface MediaPage {
  items: MediaItem[];
  more: boolean;
}

/** One emoji on a message and who reacted with it (§20.1). */
export interface Reaction {
  emoji: string;
  /** User ids, in the order they reacted. Never empty. */
  users: string[];
}

/** What a reply shows of the message it answers (§19). */
export interface Quoted {
  id: string;
  author: string;
  text: string;
  deleted: boolean;
  files?: string[];
  expand?: { author?: User };
}

export interface LocalFile {
  /** For an item from a collection, an empty stand-in named after it. */
  file: File;
  /** Object URL for an image or video preview, "" for other files. Revoked once the message no longer needs it. */
  url: string;
  /** Attached from a collection (§31): the item's id, sent for the server to copy, and its collection's. */
  item?: { id: string; collection: string };
}

/** A collection (§31), as GET /api/chat/collections lists it. */
export interface Collection {
  id: string;
  name: string;
  public: boolean;
  items: number;
  last_added: string;
  /** Someone else's that you follow: whose it is, up to when you've seen it, and how many items are new (at most 100). */
  owner?: { id: string; name: string };
  seen_at?: string;
  new?: number;
}

/** What GET /api/chat/collections answers: yours and those you follow, by name. */
export interface Collections {
  mine: Collection[];
  subs: Collection[];
}

/** A collection item (§31): one image or video. */
export interface CollectionItem {
  id: string;
  collection: string;
  file: string;
  /** The original file name. */
  name: string;
  video: boolean;
  /** A video's poster frame is ready (GET /api/chat/posters/items/{id}/{file}). */
  poster: boolean;
  created: string;
}

/** What a "from collection" badge may say (§31): a public one's (or your own) name, "private", or null: gone. */
export type Badge = { name: string; public: boolean; mine: boolean } | { private: true } | null;

/** The site's branding and signup policy (§24), set by an admin in PocketBase. */
export interface Site {
  title: string;
  /** URL of the logo image, or "" without one. */
  logo: string;
  /** Signing up needs an invite code. */
  inviteOnly: boolean;
}

/** A row of the "Mentions & replies" inbox (§41, GET /api/chat/inbox). */
export interface InboxItem {
  id: string;
  /** Where the next page starts (`before`). */
  cursor: string;
  kind: "mention" | "reply" | "reaction";
  /** A reaction's emoji, "" otherwise. */
  emoji: string;
  created: string;
  room: string;
  /** The message: the mention, the reply, or your message reacted to. Its text cut short, how many files it has. */
  message: { id: string; text: string; files: number; created: string };
  /** A reply's: your message it answers ("" text and no files once deleted). */
  quote: { id: string; text: string; files: number } | null;
  /** Who did it; in an anonymous room (§35), the room for a mention or reply. */
  actor: User;
}

/** A row of the inbox added or taken away, told live on `chat/inbox` (§41). */
export interface InboxEvent {
  action: "create" | "delete";
  id: string;
  kind: InboxItem["kind"];
  room: string;
  message: string;
  created: string;
}

/** What the app shows before (or without) the site record. */
export const DEFAULT_SITE: Site = { title: "Chirkle", logo: "", inviteOnly: false };
