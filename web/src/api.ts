// The only module that talks to PocketBase (§6). Views depend on the `Api` interface, never on the client.

import { type Cursor, PAGE_SIZE, type PageQuery } from "./lib/cursor.ts";
import {
  type Badge,
  type CollectionItem,
  type Collections,
  DEFAULT_SITE,
  type InboxEvent,
  type MediaPage,
  type Message,
  type Posting,
  type Room,
  type Site,
  type User,
  type Visibility,
} from "./lib/types.ts";
import { type AuthRecord, type PbClient, PbError, type Query, type RequestOptions } from "./pb.ts";

export type AvatarSize = 48 | 96;
export type Unsubscribe = () => Promise<void>;
export type Action = "create" | "update" | "delete";
export type RealtimeHandler<T> = (action: Action, record: T) => void;

export interface HiddenRow {
  id: string;
  room: string;
}

/** A room_reads row (§18.1): only which room it is about matters to the client. */
export type ReadRow = HiddenRow;

/** Unread messages per room id (rooms without any are left out), as of `at` (server time, §18.2). */
export interface UnreadCounts {
  at: string;
  rooms: Record<string, number>;
  /** The recent messages these counts account for (QA BUG-106); missing from servers before it. */
  ids?: string[];
  /** Inbox rows not seen yet, at most 100, and each room's unread mentions and replies (§41); missing from servers before. */
  inbox?: number;
  mentions?: Record<string, number>;
}

/** What the unread counter needs to know about a message event in any room (§18.3). */
export type MessageActivity = Pick<Message, "id" | "room" | "author" | "deleted" | "reply_to" | "mentions">;

export interface NewMessage {
  /** Client-generated (lib/id.ts) so retries can't duplicate (§7.5). */
  id: string;
  room: string;
  text: string;
  /** Attachments (§17.4): sent as multipart. */
  files?: File[];
  /** The message this one replies to (§19). */
  replyTo?: string;
  /** Collection items whose files it attaches, after `files` (§31). */
  items?: string[];
}

/** A request to the server (`Api.request`). */
export interface Request {
  method?: string;
  body?: Record<string, unknown>;
  query?: Query;
  signal?: AbortSignal;
  /** With files in `body`: how much has been sent, 0 to 1. */
  onUpload?: (fraction: number) => void;
}

/**
 * Reads take an optional AbortSignal: views pass their scope's, so leaving a view cancels its pending requests
 * (they then reject with status 0). Writes take none on purpose: a send or edit should still reach the server
 * if the user navigates away while it is in flight.
 */
export interface Api {
  // auth
  currentUser(): User | null;
  /** `inviteCode`: needed while the site is invite-only (§24). */
  signUp(input: { email: string; password: string; name: string; inviteCode?: string }): Promise<User>;
  logIn(email: string, password: string): Promise<User>;
  /** Re-validate the stored session with the server, which renews it. Rejects when it is no longer valid. */
  refreshAuth(): Promise<User>;
  /** When the stored session expires (epoch ms), or 0 without one. */
  sessionExpiry(): number;
  logOut(): void;
  /**
   * A stored session that ran out (the browser was closed past its expiry): forgotten, and the id of the user it was,
   * or "" when there is none. Their drafts and cached rooms are then cleared (QA BUG-145).
   */
  forgetExpired(): string;
  /**
   * Called whenever the stored session changes, including from another tab of the same browser (they share
   * it). Read `currentUser()` to see who is logged in now. Returns an unsubscribe function.
   */
  onAuthChange(fn: () => void): () => void;
  /**
   * Called when the server refuses a change sent with the session (400, 401, 403 or 404). Often a plain mistake, but
   * also what a session revoked elsewhere gets (a password change signs out every other device), which only checking
   * the session can tell. Returns an unsubscribe function.
   */
  onRejected(fn: () => void): () => void;

  /** The site's branding and signup policy (§24); the defaults when there is no site record. */
  site(signal?: AbortSignal): Promise<Site>;

  // profile (§15)
  /** Upload a new avatar (already prepared, §15.3). Resolves to the updated user. */
  setAvatar(file: File): Promise<User>;
  removeAvatar(): Promise<User>;
  rename(name: string): Promise<User>;
  /** Change your handle (§41); refused with the reason on `handle` (taken, not allowed). */
  setHandle(handle: string): Promise<User>;
  /**
   * Change your password (§22.2). The server checks the current one and signs out every other session; this one gets
   * a fresh token. Rejects with field errors on `oldPassword` or `password`.
   */
  changePassword(oldPassword: string, password: string): Promise<User>;
  /** Thumbnail URL of a user's avatar at `size` px (48 or 96), or "" when they have none. */
  avatarUrl(user: User, size: AvatarSize): string;

  // rooms
  listRooms(signal?: AbortSignal): Promise<Room[]>;
  getRoom(id: string, signal?: AbortSignal): Promise<Room>;
  createRoom(name: string, visibility?: Visibility): Promise<Room>;
  setArchived(id: string, archived: boolean): Promise<Room>;
  /**
   * Who can see the room (§23.2): its visibility, and for a private room its members (user ids; the creator is always
   * one). With `posting`, also who can post (§23.6): for "selected", its writers (the creator always is one; in a
   * private room only members count). Only the creator may. Resolves to the room as saved.
   */
  setAccess(id: string, visibility: Visibility, members: readonly string[], posting?: Posting, writers?: readonly string[]): Promise<Room>;

  // direct messages (§16)
  /** The DM with `userId`, created on first use; reopens it if you had closed it. */
  openDm(userId: string): Promise<Room>;
  /** Up to 20 other users whose name contains `query` (ignoring case, as names are compared), by name. */
  searchUsers(query: string, signal?: AbortSignal): Promise<User[]>;
  /**
   * Someone on a linked instance by their address, "ann@b.example" (§33.5), as a user here: to message them, or with
   * `room` to add them to that shared private room. Refused with the reason (no such person, not linked…).
   */
  remoteUser(address: string, room?: string): Promise<User>;
  /** The users with these ids (at most 50), e.g. to name who reacted (§20.3). Unknown ids are left out. */
  usersById(ids: readonly string[], signal?: AbortSignal): Promise<User[]>;

  // hidden rooms
  listHidden(signal?: AbortSignal): Promise<HiddenRow[]>;
  hideRoom(room: string): Promise<HiddenRow>;
  unhideRoom(rowId: string): Promise<void>;

  // unread counts (§18)
  /** Unread messages per room, at most 100 each. */
  unreadCounts(signal?: AbortSignal): Promise<UnreadCounts>;
  /** The oldest unread message in a room; its id is "" when there is none. */
  firstUnread(room: string, signal?: AbortSignal): Promise<Cursor>;
  /** You have read `room` up to `at` (a message's `created`). The server never moves it back. */
  markRead(room: string, at: string): Promise<void>;

  // messages
  /**
   * With `kept`, asked for with the ETag of a copy kept (PERF.md §5): when that copy is still the page, the server sends
   * no body, and the page is `kept.items`. Either way the page's tag goes to `kept.got`.
   */
  page(q: PageQuery, signal?: AbortSignal, kept?: KeptPage): Promise<Message[]>;
  getMessage(id: string, signal?: AbortSignal): Promise<Message>;
  /** Every message matching `q` (not just one page): used for the edits/deletes missed during a disconnect. */
  changes(q: PageQuery, signal?: AbortSignal): Promise<Message[]>;
  /** `onUpload`: how much of its attachments has been sent, 0 to 1 (§17.4). */
  send(m: NewMessage, onUpload?: (fraction: number) => void): Promise<Message>;
  edit(id: string, text: string): Promise<Message>;
  softDelete(id: string): Promise<Message>;
  /** Add (`on`) or remove your `emoji` reaction on a message (§20). Idempotent. */
  react(id: string, emoji: string, on: boolean): Promise<Message>;
  /** Soft-delete several of your messages at once, all or none (§21.2), or a moderator anyone's (§36). Resolves to them, deleted. */
  deleteMany(ids: readonly string[]): Promise<Message[]>;
  /** Is this user banned (§36)? */
  isBanned(user: string, signal?: AbortSignal): Promise<boolean>;
  /** A moderator bans or unbans someone (§36). */
  setBanned(user: string, banned: boolean): Promise<void>;
  /** Copy messages into `room` as yours, saying who first wrote them, all or none (§21.3). Resolves to the copies. */
  forward(ids: readonly string[], room: string): Promise<Message[]>;

  // attachments (§17.3, §37.3): a file's URL is all it takes to open it, no file token
  /** URL of an attachment (a thumbnail with `thumb`, e.g. "480x360"). */
  fileUrl(m: Message, filename: string, thumb?: string): string;
  /** URL of a video's poster frame (§30.1): 404 until the server has made it. */
  posterUrl(m: Message, filename: string): string;

  // media grid (§30.1)
  /** A page of the room's images and videos, newest first, older than `after` (the oldest shown) or the newest. */
  media(room: string, after?: { sent: string; message: string; pos: number }, signal?: AbortSignal): Promise<MediaPage>;

  // collections (§31): the rest of their calls are the lazy chunk's (views/collection/calls.ts), through `request`
  collections(signal?: AbortSignal): Promise<Collections>;
  /** You have seen the collection's items up to `at` (an item's `created`; default now). */
  markSeen(collection: string, at?: string): Promise<void>;
  /** What each collection's badge may say. */
  badges(ids: readonly string[], signal?: AbortSignal): Promise<Record<string, Badge>>;
  /** URL of an item's file (a thumbnail with `thumb`), as fileUrl. */
  itemUrl(item: Pick<CollectionItem, "id" | "file">, thumb?: string): string;
  /** URL of an item's video poster: 404 until there is one. */
  itemPosterUrl(item: Pick<CollectionItem, "id" | "file">): string;
  /** Changes of these collections (yours, and those you follow), and of your own subscriptions. */
  subscribeCollections(ids: readonly string[], fn: () => void): Promise<Unsubscribe>;
  /** The id of any collection whose badge may say something else now: made public or private, renamed, deleted. */
  subscribeBadges(fn: (id: string) => void): Promise<Unsubscribe>;
  /** Any request to the server, for a lazy chunk (which can't import this module); rejects with ApiError. */
  request<T>(path: string, r?: Request): Promise<T>;

  // realtime
  subscribeMessages(room: string, fn: RealtimeHandler<Message>): Promise<Unsubscribe>;
  subscribeRooms(fn: RealtimeHandler<Room>): Promise<Unsubscribe>;
  subscribeHidden(fn: RealtimeHandler<HiddenRow>): Promise<Unsubscribe>;
  /** Every message event in every room you can see, without text or files (§18.3, §34). */
  subscribeAllMessages(fn: RealtimeHandler<MessageActivity>): Promise<Unsubscribe>;
  /** Your inbox's rows as they are added and taken away (§41). */
  subscribeInbox(fn: (e: InboxEvent) => void): Promise<Unsubscribe>;
  /** Your own room_reads rows, e.g. written by another tab or device. */
  subscribeReads(fn: RealtimeHandler<ReadRow>): Promise<Unsubscribe>;
  /** Called on every realtime (re)connect; `reconnect` is false for the first one. */
  onConnect(fn: (reconnect: boolean) => void): () => void;
  unsubscribeAll(): Promise<void>;
}

/** Normalized error so views never depend on SDK error classes. */
export class ApiError extends Error {
  readonly status: number;
  /** Per-field validation messages, e.g. { email: "Must be a valid email." } */
  readonly fields: Record<string, string>;
  /** Per-field validation codes, e.g. { name: "validation_not_unique" }. Match on these, not on messages. */
  readonly codes: Record<string, string>;

  constructor(message: string, status: number, fields: Record<string, string> = {}, codes: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fields = fields;
    this.codes = codes;
  }
}

/**
 * `codes.auth` of a signUp() rejection whose account *was* created but whose automatic login failed
 * (network, rate limit). Retrying the signup would only fail with "email taken"; the user should log in.
 */
export const SIGNUP_LOGIN_FAILED = "signup_login_failed";

/** A sentence to show for a failed request: network trouble, rate limiting, or the server's own message. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Please try again.";
  if (err.status === 0) return "Can't reach the server. Check your connection.";
  // e.g. PocketBase's default `*:auth` limit (2 requests per 3 seconds) or our messages/signup limits
  if (err.status === 429) return "Too many attempts. Wait a few seconds and try again.";
  return err.message;
}

/** errorMessage, or the server's reason when it gave one (e.g. "A message was deleted." for a forward, §21). */
export const reasonOf = (err: unknown): string => (err instanceof ApiError && Object.values(err.fields)[0]) || errorMessage(err);

// ---- PocketBase implementation ----

/** Only what the UI renders; never user emails (§6). */
export const MSG_FIELDS =
  "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,file_dims,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms,expand.author.instance," +
  "reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files," +
  "expand.reply_to.expand.author.id,expand.reply_to.expand.author.name," +
  "forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name,mentions";
const MSG_OPTS = { expand: "author,reply_to.author,forwarded_from", fields: MSG_FIELDS } as const;
/**
 * Live messages (pb_hooks/lib/live.js, docs/PERF.md §7): the server sends each message once on this topic to everyone who
 * can see its room, expanded with `author` and `forwarded_from` but not the message a reply answers (the room fills the
 * quote in, views/room/controller.ts). A room's subscription and the activity of all rooms both listen to it.
 */
const LIVE_TOPIC = "chat/messages";
/** Rooms with their members' public profile (DMs, §16.5); never emails. */
export const ROOM_FIELDS =
  "id,name,archived,created_by,kind,visibility,members,posting,writers,last_message_at,created,shared," +
  "expand.members.id,expand.members.name,expand.members.avatar,expand.members.no_dms,expand.members.instance," +
  "expand.writers.id,expand.writers.name,expand.writers.avatar,expand.writers.no_dms,expand.writers.instance";
const ROOM_OPTS = { expand: "members,writers", fields: ROOM_FIELDS } as const;
export const HIDDEN_FIELDS = "id,room";
/** The site record (§24); its invite code is hidden from everyone but superusers. */
const SITE_FIELDS = "id,title,logo,invite_only";
interface SiteRow {
  id: string;
  title?: string;
  logo?: string;
  invite_only?: boolean;
}
/** reply_to: notifications (§34) look closer at replies only. */
export const ACTIVITY_FIELDS = "id,room,author,deleted,reply_to,mentions";

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof PbError) {
    const data = e.response.data ?? {};
    const pick = (key: "message" | "code") =>
      Object.fromEntries(
        Object.entries(data)
          .filter(([, v]) => v && typeof v[key] === "string")
          .map(([k, v]) => [k, v[key] as string]),
      );
    return new ApiError(e.message, e.status, pick("message"), pick("code"));
  }
  return new ApiError(e instanceof Error ? e.message : String(e), 0);
}

async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw toApiError(e);
  }
}

const toUser = (r: AuthRecord): User => ({
  id: r.id,
  name: r.name as string,
  avatar: (r.avatar as string | undefined) ?? "",
  ...(r.no_dms ? { no_dms: true } : {}),
  ...(r.instance ? { instance: r.instance as string } : {}),
  ...(r.moderator ? { moderator: true } : {}),
  ...(r.handle ? { handle: r.handle as string } : {}),
});
/** What the profile calls return: never the email, even for yourself. */
export const USER_FIELDS = "id,name,avatar,instance,handle";

/** The query for GET /api/chat/rooms/{room}/messages (pb_hooks/lib/lists.js). */
export function pageOptions(q: PageQuery, limit = PAGE_SIZE, page = 1) {
  return {
    kind: q.kind,
    ...q.args,
    ...(q.files ? { files: "1" } : {}),
    ...(q.q ? { q: q.q } : {}),
    limit,
    ...(page > 1 ? { page } : {}),
    ...MSG_OPTS,
  };
}

/** Record endpoints of one collection: the part of the SDK's RecordService we use. */
function records(pb: PbClient, collection: string) {
  const path = `/api/collections/${collection}`;
  const one = (id: string) => `${path}/records/${encodeURIComponent(id)}`;
  const list = <T>(page: number, perPage: number, query: Query, signal?: AbortSignal) =>
    pb.send<{ items: T[] }>(`${path}/records`, { query: { page, perPage, ...query }, signal });
  /** Save a fresh auth response, as the SDK does. */
  const auth = async (p: Promise<{ token: string; record: AuthRecord }>) => {
    const { token, record } = await p;
    pb.authStore.save(token, record);
    return record;
  };
  return {
    list,
    /** Every page, `batch` records at a time. */
    async fullList<T>(query: Query, signal?: AbortSignal, batch = 1000): Promise<T[]> {
      const out: T[] = [];
      for (let page = 1; ; page++) {
        const { items } = await list<T>(page, batch, { skipTotal: true, ...query }, signal);
        out.push(...items);
        if (items.length < batch) return out;
      }
    },
    get: <T>(id: string, query: Query, signal?: AbortSignal) => pb.send<T>(one(id), { query, signal }),
    create: <T>(body: Record<string, unknown>, query?: Query, onUpload?: (fraction: number) => void) =>
      pb.send<T>(`${path}/records`, { method: "POST", body, query, onUpload }),
    async update<T>(id: string, body: Record<string, unknown>, query: Query): Promise<T> {
      const item = await pb.send<AuthRecord>(one(id), { method: "PATCH", body, query });
      // Updating the logged-in user refreshes the stored record (other tabs and onAuthChange see it).
      const r = pb.authStore.record;
      if (r?.id === item.id && r.collectionName === collection) pb.authStore.save(pb.authStore.token, { ...r, ...item });
      return item as T;
    },
    delete: (id: string) => pb.send(one(id), { method: "DELETE" }),
    authWithPassword: (identity: string, password: string) =>
      auth(pb.send(`${path}/auth-with-password`, { method: "POST", body: { identity, password } })),
    // Saved only over the session it renewed: one ended (a logout) or changed meanwhile stays so.
    authRefresh: async () => {
      const sent = pb.authStore.token;
      const { token, record } = await pb.send<{ token: string; record: AuthRecord }>(`${path}/auth-refresh`, { method: "POST" });
      if (pb.authStore.token === sent) pb.authStore.save(token, record);
      return record;
    },
    /** A custom route that answers like a login. */
    authAt: (url: string, body: Record<string, unknown>) => auth(pb.send(url, { method: "POST", body })),
  };
}

/** Statuses of a refused change: invalid data, or no (valid) session. */
const REFUSED = new Set([400, 401, 403, 404]);

/** A page's copy kept by the caller, and where its tag goes (Api.page). `items` as the page has them, newest first. */
export interface KeptPage {
  tag?: string | undefined;
  items: readonly Message[];
  got?: (tag: string) => void;
}

export function createApi(client: PbClient): Api {
  const rejected = new Set<() => void>();
  /** The client, telling onRejected listeners about changes refused while the session was sent with them. */
  const pb: PbClient = {
    authStore: client.authStore,
    realtime: client.realtime,
    filter: client.filter,
    fileUrl: client.fileUrl,
    async send<T>(path: string, opts: RequestOptions = {}): Promise<T> {
      const token = client.authStore.token;
      try {
        return await client.send<T>(path, opts);
      } catch (e) {
        const write = (opts.method ?? "GET") !== "GET" && !path.includes("/auth-"); // a login or refresh says so itself
        if (e instanceof PbError && REFUSED.has(e.status) && write && token && token === client.authStore.token) {
          for (const fn of [...rejected]) fn();
        }
        throw e;
      }
    },
  };
  const users = records(pb, "users");
  const rooms = records(pb, "rooms");
  const hidden = records(pb, "hidden_rooms");
  const messages = records(pb, "messages");
  const site = records(pb, "site");
  /** Every record event of a collection, narrowed to our Action type. */
  const subscribe = <T>(collection: string, fn: RealtimeHandler<T>, query: Query) =>
    wrap(
      pb.realtime.subscribe(
        `${collection}/*`,
        (e) => {
          const { action, record } = e as { action: Action; record: T };
          fn(action, record);
        },
        query,
      ),
    );
  const live = (fn: (action: Action, m: Message) => void) =>
    wrap(
      pb.realtime.subscribe(LIVE_TOPIC, (e) => {
        const { action, record } = e as { action: Action; record: Message };
        fn(action, record);
      }),
    );
  const me = () => {
    const u = api.currentUser();
    if (!u) throw new ApiError("Not logged in.", 401);
    return u.id;
  };

  const api: Api = {
    currentUser() {
      const r = pb.authStore.record;
      return pb.authStore.isValid && r?.collectionName === "users" ? toUser(r) : null;
    },
    async signUp({ email, password, name, inviteCode }) {
      const invite = inviteCode ? { invite_code: inviteCode } : {};
      await wrap(users.create({ email, password, passwordConfirm: password, name, ...invite }));
      try {
        return await api.logIn(email, password);
      } catch (e) {
        const err = toApiError(e);
        throw new ApiError(err.message, err.status, {}, { auth: SIGNUP_LOGIN_FAILED });
      }
    },
    async logIn(email, password) {
      return toUser(await wrap(users.authWithPassword(email, password)));
    },
    async refreshAuth() {
      if (!api.currentUser()) throw new ApiError("Not logged in.", 401);
      return toUser(await wrap(users.authRefresh()));
    },
    sessionExpiry: () => pb.authStore.expiresAt,
    logOut() {
      pb.authStore.clear();
    },
    forgetExpired() {
      const r = pb.authStore.record;
      if (!r || pb.authStore.isValid) return "";
      pb.authStore.clear();
      return r.id;
    },
    onAuthChange(fn) {
      // A localStorage-backed store also fires this when another tab saves or clears the shared session.
      return pb.authStore.onChange(() => fn());
    },
    onRejected(fn) {
      rejected.add(fn);
      return () => void rejected.delete(fn);
    },

    // A body holding a File is sent as multipart; update() refreshes the stored auth record from the response.
    async site(signal) {
      const { items } = await wrap(site.list<SiteRow>(1, 1, { sort: "created", skipTotal: true, fields: SITE_FIELDS }, signal));
      const row = items[0];
      if (!row) return DEFAULT_SITE;
      return {
        title: row.title || DEFAULT_SITE.title,
        logo: row.logo ? pb.fileUrl("site", row.id, row.logo) : "",
        inviteOnly: row.invite_only === true,
      };
    },

    setAvatar: async (file) => toUser(await wrap(users.update(me(), { avatar: file }, { fields: USER_FIELDS }))),
    removeAvatar: async () => toUser(await wrap(users.update(me(), { avatar: null }, { fields: USER_FIELDS }))),
    rename: async (name) => toUser(await wrap(users.update(me(), { name }, { fields: USER_FIELDS }))),
    setHandle: async (handle) => toUser(await wrap(users.update(me(), { handle }, { fields: USER_FIELDS }))),
    async changePassword(oldPassword, password) {
      me();
      return toUser(await wrap(users.authAt("/api/chat/password", { oldPassword, password })));
    },
    avatarUrl(user, size) {
      if (!user.avatar) return "";
      return pb.fileUrl("users", user.id, user.avatar, { thumb: `${size}x${size}` });
    },

    listRooms: (signal) => wrap(pb.send<Room[]>("/api/chat/rooms", { query: ROOM_OPTS, signal })),
    getRoom: (id, signal) => wrap(rooms.get<Room>(id, ROOM_OPTS, signal)),
    createRoom: async (name, visibility) =>
      wrap(rooms.create<Room>({ name, created_by: me(), ...(visibility ? { visibility } : {}) }, ROOM_OPTS)),
    setArchived: (id, archived) => wrap(rooms.update<Room>(id, { archived }, ROOM_OPTS)),
    setAccess: (id, visibility, members, posting, writers = []) =>
      wrap(
        rooms.update<Room>(
          id,
          {
            visibility,
            members: visibility === "private" ? [...members] : [],
            ...(posting ? { posting, writers: posting === "selected" ? [...writers] : [] } : {}),
          },
          ROOM_OPTS,
        ),
      ),

    openDm: (userId) => wrap(pb.send<Room>("/api/chat/dms", { method: "POST", body: { user: userId } })),
    async searchUsers(query, signal) {
      me();
      // A route, not a filter on `name`: it matches case-insensitively beyond ASCII ("иван" finds "Иван", QA BUG-55).
      return (await wrap(pb.send<AuthRecord[]>("/api/chat/users", { query: { q: query }, signal }))).map(toUser);
    },

    remoteUser: async (address, room) =>
      toUser(await wrap(pb.send<AuthRecord>("/api/chat/remote-users", { method: "POST", body: { address, ...(room ? { room } : {}) } }))),

    async usersById(ids, signal) {
      const some = ids.slice(0, 50);
      if (!some.length) return [];
      const params = Object.fromEntries(some.map((id, i) => [`u${i}`, id]));
      const opts = { filter: pb.filter(some.map((_, i) => `id = {:u${i}}`).join(" || "), params), fields: USER_FIELDS, skipTotal: true };
      return (await wrap(users.list<AuthRecord>(1, some.length, opts, signal))).items.map(toUser);
    },

    listHidden: (signal) => wrap(hidden.fullList<HiddenRow>({ fields: HIDDEN_FIELDS }, signal)),
    hideRoom: async (room) => wrap(hidden.create<HiddenRow>({ user: me(), room }, { fields: HIDDEN_FIELDS })),
    unhideRoom: async (rowId) => {
      await wrap(hidden.delete(rowId));
    },

    unreadCounts: (signal) => wrap(pb.send<UnreadCounts>("/api/chat/unread", { signal })),
    firstUnread: (room, signal) => wrap(pb.send<Cursor>(`/api/chat/unread/${room}`, { signal })),
    markRead: async (room, at) => {
      await wrap(pb.send("/api/chat/reads", { method: "POST", body: { room, at } }));
    },

    page: async (q, signal, kept) => {
      const path = `/api/chat/rooms/${encodeURIComponent(q.room)}/messages`;
      const tag = kept && { sent: kept.items.length ? kept.tag : undefined, got: kept.got };
      return (await wrap(pb.send<Message[] | undefined>(path, { query: pageOptions(q), signal, tag }))) ?? [...(kept?.items ?? [])];
    },
    getMessage: (id, signal) => wrap(messages.get<Message>(id, MSG_OPTS, signal)),
    async changes(q, signal) {
      const out: Message[] = [];
      for (let page = 1; ; page++) {
        const path = `/api/chat/rooms/${encodeURIComponent(q.room)}/messages`;
        const some = await wrap(pb.send<Message[]>(path, { query: pageOptions(q, 200, page), signal }));
        out.push(...some);
        if (some.length < 200) return out;
      }
    },
    send: async (m, onUpload) =>
      wrap(
        messages.create<Message>(
          {
            id: m.id,
            room: m.room,
            author: me(),
            text: m.text,
            ...(m.files?.length ? { files: m.files } : {}),
            ...(m.replyTo ? { reply_to: m.replyTo } : {}),
            ...(m.items?.length ? { items: m.items } : {}),
          },
          MSG_OPTS,
          m.files?.length ? onUpload : undefined,
        ),
      ),
    edit: (id, text) => wrap(messages.update<Message>(id, { text }, MSG_OPTS)),
    softDelete: (id) => wrap(messages.update<Message>(id, { deleted: true }, MSG_OPTS)),
    react: (id, emoji, on) =>
      wrap(pb.send<Message>("/api/chat/reactions", { method: "POST", body: { message: id, emoji, on }, query: MSG_OPTS })),

    deleteMany: (ids) => wrap(pb.send<Message[]>("/api/chat/delete", { method: "POST", body: { messages: ids }, query: MSG_OPTS })),
    isBanned: async (user, signal) => !!(await wrap(users.get<AuthRecord>(user, { fields: "id,banned" }, signal))).banned,
    setBanned: async (user, banned) => void (await wrap(pb.send("/api/chat/ban", { method: "POST", body: { user, banned } }))),
    forward: (ids, room) =>
      wrap(pb.send<Message[]>("/api/chat/forward", { method: "POST", body: { messages: ids, room }, query: MSG_OPTS })),
    // A forward's attachments are its original's (§21.3).
    fileUrl: (m, filename, thumb) => pb.fileUrl("messages", m.forward_of || m.id, filename, { thumb }),
    // The file's own URL, on the poster route.
    posterUrl: (m, filename) => api.fileUrl(m, filename).replace("/api/files/messages/", "/api/chat/posters/"),
    collections: (signal) => wrap(pb.send<Collections>("/api/chat/collections", { signal })),
    markSeen: async (collection, at) => {
      await wrap(pb.send("/api/chat/subs/seen", { method: "POST", body: { collection, ...(at ? { at } : {}) } }));
    },
    badges: (ids, signal) => wrap(pb.send<Record<string, Badge>>("/api/chat/badges", { query: { ids: ids.join(",") }, signal })),
    itemUrl: (item, thumb) => pb.fileUrl("collection_items", item.id, item.file, { thumb }),
    itemPosterUrl: (item) => api.itemUrl(item).replace("/api/files/collection_items/", "/api/chat/posters/items/"),
    async subscribeCollections(ids, fn) {
      // One topic per collection followed: a filter naming them all could be longer than a topic may be.
      const offs = await Promise.all([
        subscribe("collections", fn, { fields: "id", filter: pb.filter("owner = {:me}", { me: me() }) }),
        subscribe("collection_subs", fn, { fields: "id" }),
        ...ids.map((id) => wrap(pb.realtime.subscribe(`collections/${id}`, fn, { fields: "id" }))),
      ]);
      return async () => {
        await Promise.all(offs.map((off) => off()));
      };
    },
    subscribeBadges: (fn) => wrap(pb.realtime.subscribe("chat/badges", (d) => fn((d as { id: string }).id))),
    request: (path, r) => wrap(pb.send(path, r)),
    media: (room, after, signal) => wrap(pb.send<MediaPage>(`/api/chat/media/${room}`, { query: after, signal })),

    subscribeMessages: (room, fn) => live((action, m) => m.room === room && fn(action, m)),
    subscribeRooms: (fn) => subscribe("rooms", fn, ROOM_OPTS),
    subscribeHidden: (fn) => subscribe("hidden_rooms", fn, { fields: HIDDEN_FIELDS }),
    subscribeAllMessages: (fn) =>
      live((action, m) =>
        fn(action, {
          id: m.id,
          room: m.room,
          author: m.author,
          deleted: m.deleted,
          reply_to: m.reply_to ?? "",
          mentions: m.mentions ?? [],
        }),
      ),
    subscribeInbox: (fn) => wrap(pb.realtime.subscribe("chat/inbox", (d) => fn(d as InboxEvent))),
    subscribeReads: (fn) => subscribe("room_reads", fn, { fields: HIDDEN_FIELDS }),

    onConnect(fn) {
      // PB_CONNECT only reaches listeners for connections made after they subscribe. If we are already
      // connected now, the next PB_CONNECT this listener sees is a reconnect, not the initial connect. So is one that
      // follows a failed first connect: what was loaded meanwhile may have missed events.
      let connected = pb.realtime.isConnected;
      const unsub = pb.realtime.subscribe("PB_CONNECT", () => {
        fn(connected || pb.realtime.recovered);
        connected = true;
      });
      // A failed first connect (offline, server down) rejects it, and the client keeps trying: not an error (QA BUG-85).
      unsub.catch(() => {});
      return () => void unsub.then((off) => off()).catch(() => {});
    },
    unsubscribeAll: () => wrap(pb.realtime.unsubscribe()),
  };
  return api;
}
