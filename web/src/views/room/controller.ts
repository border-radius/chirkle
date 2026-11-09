// Room controller (§7.5, §7.6): one room's message window and everything that changes it: loading, realtime and
// reconnects here, and the writes (sending, edits, deletes, reactions) in writes.ts. No DOM: every change is reported to
// `onChange` with a hint (render, keep the anchor, scroll), and the room view (views/room.ts) applies it to the list.

import { type Action, type Api, ApiError } from "../../api.ts";
import type { Cache } from "../../cache.ts";
import { type Cursor, changedIn, first, latest, newer, older, PAGE_SIZE } from "../../lib/cursor.ts";
import {
  applyPage,
  compare,
  emptyWindow,
  lastOwnEditable,
  lastSaved,
  type MessageWindow,
  merge,
  type PageKind,
  remove,
  trim,
} from "../../lib/messages.ts";
import { canPost, isDm } from "../../lib/rooms.ts";
import type { LocalFile, Message, Quoted, Reaction, Room } from "../../lib/types.ts";
import type { EarlyPage } from "../../prefetch.ts";
import type { Scope } from "../../scope.ts";
import { type AppState, type Store, UNCOUNTED, upsertRoom } from "../../store.ts";
import { createWrites, revokeLocal, stray, takeStrays } from "./writes.ts";

/** How long a message gone to (a quote, a link) stays highlighted; styles/app/messages.css fades it out over this time. */
export const HIGHLIGHT_MS = 3000;
/** How long the line over the first unread message shows; styles/app/messages.css fades it out before then. */
export const UNREAD_LINE_MS = 5000;

/** "loading" until the first page is in; "failed" offers Retry; "not-found": no such room (or not yours). */
export type Phase = "loading" | "ready" | "failed" | "not-found";
/** "below": new messages under the viewport. "history": new messages, but the window isn't at the live edge. */
export type Pill = "below" | "history" | null;

export interface RoomState {
  win: MessageWindow;
  phase: Phase;
  /** The message the route asked for, once it is in the window (highlighted). */
  targetId: string | null;
  /** The first message that was unread when the room was opened (§18.5): a line over it, for UNREAD_LINE_MS. */
  unreadId: string | null;
  pill: Pill;
  /** Showing the room as it was last time (cache.ts) until its first page is in: there may be newer messages. */
  stale: boolean;
  /**
   * The stale window shows at the bottom before the server has said where the unread messages start: nothing counts as
   * read until it has, since they may begin further up (QA BUG-102).
   */
  unsure: boolean;
}

/** What a change asks of the view. Pill and phase are read from `state()`, and every change may have changed them. */
export interface Change {
  /** The window changed. `anchor`: keep what is on screen in place (content changed above it). */
  render?: { anchor?: boolean };
  /** "target": bring `targetId` (else `unreadId`) into view. */
  scroll?: "bottom" | "top" | "target";
  /** Replace the notice above the list ("" clears it). */
  notice?: string;
}

export interface RoomController {
  /** The view is kept hidden (PERF.md §5): the first message from someone else that comes meanwhile is the first unread. */
  park(): void;
  /**
   * Shown again: a line over the first message still unread (§18.5), brought into view (true), as on opening it. The
   * count says which, as for a kept room; else the first from someone else that came while parked.
   */
  resume(): boolean;
  state(): RoomState;
  /** Subscribe and run the first load. Everything ends with the scope. */
  start(): void;
  /** Retry a failed first load. */
  retry(): void;
  /** Extend the window at one end (a sentinel came into view). One request per end at a time. */
  loadEdge(side: "top" | "bottom"): Promise<void>;
  /** Reset the window to the latest page or the first page. */
  jump(kind: "latest" | "first"): Promise<void>;
  /** Highlight and centre message `id` (a reply's quote, §19), loading the history around it when needed. */
  goTo(id: string): Promise<void>;
  /** The user is at the bottom now: hide a "new messages below" pill. */
  dismissPill(): void;
  find(id: string): Message | undefined;
  /** Can I edit this message right now? Not a forward: its words are someone else's (§21.3). */
  editable(m: Message): boolean;
  /** Can I delete this message right now? */
  deletable(m: Message): boolean;
  /** Can I reply to this message right now? (§19) */
  repliable(m: Message): boolean;
  /** My newest editable message (Up arrow in an empty composer). */
  lastEditable(): Message | undefined;
  /** Send optimistically, as a reply to `replyTo` if given (§19). False when sending isn't possible (no user, archived room, not allowed to post: §23.6). */
  send(text: string, files?: LocalFile[], replyTo?: Message): boolean;
  retrySend(id: string): Promise<void>;
  /** Drop a failed message (no request). */
  discard(id: string): void;
  /** Save validated text. null: nothing to save (unchanged, or no longer editable). Resolves false if the save failed. */
  edit(id: string, text: string): Promise<boolean> | null;
  /** Soft delete. null: not in the window. Resolves false if the delete failed. */
  remove(id: string): Promise<boolean> | null;
  /** Can this message be selected, to forward (or delete) it with others? Saved and not deleted (§21). */
  selectable(m: Message): boolean;
  /**
   * Soft-delete several messages in one request, all or none (§21.2). null: none of them deletable. Resolves to why it
   * failed (the error), or null once they are deleted.
   */
  removeMany(ids: readonly string[]): Promise<unknown> | null;
  /** Can I react to this message right now? (§20) */
  reactable(m: Message): boolean;
  /** A message's reactions as they should show: the server's, with my changes still on their way applied. */
  reactions(m: Message): readonly Reaction[];
  /**
   * Add (`on`) or remove my `emoji` reaction, shown at once. null: not possible (not in the window, not reactable).
   * Resolves false if it failed (the reaction then shows as it was).
   */
  react(id: string, emoji: string, on: boolean): Promise<boolean> | null;
}

export function createRoomController(opts: {
  api: Api;
  store: Store<AppState>;
  roomId: string;
  /** /r/:id/m/:msgId */
  msgId?: string | undefined;
  scope: Scope;
  /** Is the list scrolled to (near) the bottom? New messages are followed only then. */
  nearBottom: () => boolean;
  onChange: (change: Change) => void;
  /** A sending message's attachments are this far uploaded, 0 to 1 (§17.4). */
  onUpload?: (id: string, fraction: number) => void;
  /** Where the room's latest messages are kept between visits (§7.5). */
  cache?: Cache;
  /** The latest page, asked for as the room's link was pressed (prefetch.ts `take`): the first load uses it. */
  early?: Promise<EarlyPage> | undefined;
  /** Any of the room's messages changed or went (`gone`: deleted for good), in the window or not. */
  onEvent?: (m: Message, gone: boolean) => void;
}): RoomController {
  const { api, store, roomId, msgId, scope, nearBottom } = opts;
  const { signal } = scope;
  /** New messages scroll into view only in a visible tab at the bottom: a background tab stays put, with the pill. */
  const follows = () => nearBottom() && !store.get().away;
  /**
   * Messages changed where they are (an edit, a reaction, link previews, a delete): what is on screen stays put, but
   * at the live bottom the list stays at the bottom, or a message growing would slide under the composer.
   */
  const inPlace = (): Change => (!win.hasNewer && nearBottom() ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });

  let win: MessageWindow = emptyWindow();
  let phase: Phase = "loading";
  let targetId: string | null = null;
  let targetTimer: ReturnType<typeof setTimeout> | undefined;
  let unreadId: string | null = null;
  let pill: Pill = null;
  /** The window is the one kept from last time (cache.ts), until the first page replaces it. */
  let stale = false;
  /**
   * The kept window was shown before the server said where the unread messages start, and they turned out not to be
   * in it: the first page goes to them (unless you scrolled away from the bottom, where it was shown).
   */
  let retarget = false;
  /** Waiting for the server's first unread message while a kept window shows at the bottom (`unsure`). */
  let asking = false;
  /** An end the list asked to extend while stale: extended once the first page is in. */
  let wanted: "top" | "bottom" | null = null;
  let keepTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The ETag of the latest page as the first load got it (PERF.md §5). Kept with the window: while the server's page
   * still has that tag nothing in it changed since, so the window's newest messages, which realtime kept up, are that page.
   */
  let pageTag: string | undefined;
  /** The page asked for as the room's link was pressed, until the first load takes it. */
  let early = opts.early;
  /** Parked (`park`), and the first message from someone else since. */
  let parked = false;
  let firstNew: string | null = null;
  /** Bumped whenever the window is replaced (a jump): pages requested before that are stale. */
  let gen = 0;
  /** Realtime events that arrive before the first page (even while a stale window shows); replayed once it is in. */
  let buffer: [Action, Message][] = [];
  /**
   * Unsent (pending or failed) messages the window dropped, e.g. when a reply's quote took it back in history (§19).
   * They belong after the newest messages, so they come back once the window is at the live edge again.
   */
  const unsent = new Map<string, Message>();
  const loading = { top: false, bottom: false };
  /** The room's realtime subscription, set up by start(); "ready" once the server has it. */
  let live: Promise<unknown> = Promise.resolve();
  let liveReady = false;

  const ready = () => phase === "ready";
  const room = (): Room | undefined => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  /** Whom the window was loaded for: after a logout or a user switch, nothing of it may be kept for the next one. */
  const owner = me()?.id ?? "";
  const find = (id: string) => win.items.find((m) => m.id === id);
  /** I may post here (§23.6): signed in, the room isn't archived, and it lets me. */
  const posting = () => {
    const r = room();
    return !!r && !r.archived && canPost(r, me());
  };
  /**
   * Moderators delete anyone's messages outside DMs, even where they can't post (§36); in a copy of another instance's
   * room, not that instance's people's: its home moderates them (§33.5).
   */
  const moderates = (m: Message) => {
    const r = room();
    if (!r || r.archived || !me()?.moderator || isDm(r) || !m.author) return false;
    return !(r.shared?.home && m.expand?.author?.instance);
  };
  const deletable = (m: Message) => !m.deleted && !m.status && ((posting() && m.author === me()?.id) || moderates(m));
  const editable = (m: Message) => deletable(m) && posting() && m.author === me()?.id && !m.forwarded_from;
  /** Guests only read (§23.3): no replies, reactions or selecting. Readers who can't post still react (§23.6). */
  const reactable = (m: Message) => {
    const r = room();
    return !!me() && !!r && !r.archived && !m.deleted && !m.status;
  };
  const repliable = (m: Message) => reactable(m) && posting();
  const emit = (change: Change = {}) => {
    if (!scope.active) return;
    opts.onChange(change);
    clearTimeout(keepTimer);
    keepTimer = setTimeout(keep, 1000);
  };
  /**
   * Keep the latest page for next time: only a fresh window at the live edge, only for whom it was loaded for. A room
   * that isn't there (any more, §23.4) is forgotten, so that it doesn't show again before the server says so.
   */
  const keep = () => {
    if ((me()?.id ?? "") !== owner) return;
    if (phase === "not-found" || (!room() && store.get().roomsStatus === "ready"))
      return opts.cache?.put(owner, roomId, { items: [], hasOlder: false });
    if (stale || !ready() || win.hasNewer) return;
    const saved = win.items.filter((m) => !m.status);
    const items = saved.slice(-PAGE_SIZE);
    opts.cache?.put(owner, roomId, { items, hasOlder: win.hasOlder || items.length < saved.length, room: room(), tag: pageTag });
  };
  /** Local optimistic change that must win regardless of `updated` (edit/delete/revert). */
  const patchLocal = (id: string, patch: Partial<Message>) => {
    win = { ...win, items: win.items.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
  };
  /**
   * Replace the window by one that may have dropped messages (a jump, a page that trimmed the other end). Unsent
   * messages it dropped are kept aside, and put back once the window is at the live edge.
   */
  const setWin = (next: MessageWindow) => {
    const kept = new Set(next.items.map((m) => m.id));
    for (const m of win.items) if (m.status && !kept.has(m.id)) unsent.set(m.id, m);
    win = next;
    if (win.hasNewer || !unsent.size) return;
    win = merge(win, [...unsent.values()]);
    unsent.clear();
  };
  /** Highlight message `id` (or nothing) for HIGHLIGHT_MS: long enough to spot it, then it fades (styles/app/messages.css). */
  const setTarget = (id: string | null) => {
    targetId = id;
    clearTimeout(targetTimer);
    if (!id) return;
    targetTimer = setTimeout(() => {
      if (targetId !== id) return;
      targetId = null;
      emit({ render: { anchor: true } });
    }, HIGHLIGHT_MS);
  };
  /** Show the line over message `id` (§18.5) until UNREAD_LINE_MS from now. */
  const setUnread = (id?: string) => {
    if (!id || id === unreadId) return;
    unreadId = id;
    setTimeout(() => {
      if (unreadId !== id) return;
      unreadId = null;
      emit({ render: { anchor: true } });
    }, UNREAD_LINE_MS);
  };
  // ---------------------------------------------------------------- loading

  /** Apply a page fetched under generation `g`, unless a jump (or the end of the scope) has made it stale. */
  function applyLoaded(kind: PageKind, page: Message[], g: number): boolean {
    if (g !== gen || !scope.active) return false;
    setWin(applyPage(win, page, kind).win);
    return true;
  }

  async function loadEdge(side: "top" | "bottom") {
    const more = side === "top" ? win.hasOlder : win.hasNewer;
    if (stale) wanted = side; // the window is about to be replaced: what it would load now could be out of date
    if (!ready() || stale || !more || loading[side] || !win.items.length) return;
    loading[side] = true;
    const g = gen;
    try {
      const page =
        side === "top" ? await api.page(older(roomId, win.items[0]!), signal) : await api.page(newer(roomId, win.items.at(-1)!), signal);
      if (applyLoaded(side === "top" ? "older" : "newer", page, g)) emit({ render: { anchor: true } });
    } catch {
      /* the sentinel will trigger again */
    } finally {
      if (g === gen) loading[side] = false;
    }
  }

  async function jump(kind: "latest" | "first") {
    const g = ++gen;
    loading.top = loading.bottom = false;
    pill = null;
    emit();
    const page = await api.page(kind === "latest" ? latest(roomId) : first(roomId), signal).catch(() => null);
    if (!page || !applyLoaded(kind, page, g)) return;
    setTarget(null);
    emit({ render: {}, notice: "", scroll: kind === "latest" ? "bottom" : "top" });
  }

  async function goTo(id: string) {
    const m = find(id);
    if (m && !m.status) {
      setTarget(id);
      return emit({ render: {}, scroll: "target", notice: "" });
    }
    // The current window stays until the new one is in; a jump meanwhile wins.
    const g = gen;
    const around = await windowAround(id).catch(() => undefined);
    if (g !== gen || !scope.active) return;
    if (!around) {
      return emit({
        notice: around === null ? "That message isn't available any more." : "Couldn't load that message. Check your connection.",
      });
    }
    gen++; // pages requested for the old window are stale now
    loading.top = loading.bottom = false;
    setWin(around.win);
    setTarget(around.target);
    pill = null;
    emit({ render: {}, scroll: "target", notice: "" });
  }

  /** The window around message `id`, or null when it isn't in this room. Rejects if a page fails. */
  async function windowAround(id: string): Promise<{ win: MessageWindow; target: string } | null> {
    // A missing message falls back to the latest page; any other failure fails the load (and offers Retry).
    const target = await api.getMessage(id, signal).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    if (!target || target.room !== roomId) return null;
    return { win: await windowAt(target), target: target.id };
  }

  /** The page before message `c`, and `c` with the page after it. */
  async function windowAt(c: Cursor): Promise<MessageWindow> {
    const [before, after] = await Promise.all([api.page(older(roomId, c), signal), api.page(newer(roomId, { ...c, id: "" }), signal)]);
    return merge({ items: [], hasOlder: before.length >= PAGE_SIZE, hasNewer: after.length >= PAGE_SIZE }, [...before, ...after]);
  }

  async function open() {
    const g = ++gen;
    const roomP = api.getRoom(roomId, signal).then((r) => store.set(upsertRoom(r)));
    // With unread messages (the room list showed a badge), the room opens at the first of them (§18.5). Before the
    // counts are in (a reload), only the server knows.
    const { unread } = store.get();
    const firstP =
      msgId || !me() || (unread !== UNCOUNTED && !unread.get(roomId)) ? null : api.firstUnread(roomId, signal).catch(() => null);
    // Loaders only return a window; it is committed below, and only if nothing (a jump) replaced it meanwhile.
    const pageP = (async (): Promise<{ win: MessageWindow; target: string | null; unread?: string | undefined }> => {
      const around = msgId ? await windowAround(msgId) : null;
      if (around) return around;
      // The latest page is asked for at once, beside the first unread message: with only a few unread, it has them.
      // With the tag of the copy kept in memory, an unchanged page comes back without a body, and that copy is it.
      const kept = opts.cache?.peek(owner, roomId);
      const asked = early;
      early = undefined; // a retry asks again
      const latestP = asked
        ? asked.then((p) => {
            pageTag = p.tag;
            return p.items;
          })
        : api.page(latest(roomId), signal, {
            tag: kept?.tag,
            items: kept ? [...kept.items].sort(compare).reverse() : [],
            got: (t) => (pageTag = t),
          });
      latestP.catch(() => {});
      const f = (firstP && (await firstP))?.id;
      const page = await (f ? latestP.catch(() => []) : latestP);
      if (f && !page.some((m) => m.id === f)) return { win: await windowAt((await firstP)!), target: null, unread: f };
      return { win: applyPage(emptyWindow(), page, "latest").win, target: null, unread: f };
    })();
    pageP.catch(() => {}); // handled below; but we may return early (room not found) without awaiting it
    if (!msgId) void showKept(g, roomP, firstP);
    try {
      await roomP;
    } catch (e) {
      if (!scope.active) return;
      phase = e instanceof ApiError && e.status === 404 ? "not-found" : "failed";
      stale = false;
      return emit({ render: {} });
    }
    const loaded = await pageP.catch(() => null);
    if (!scope.active) return;
    const current = g === gen;
    // Never show a failed load as an empty room ("Beginning of #room"): say so and offer Retry.
    if (current && !loaded) {
      phase = "failed";
      stale = false;
      return emit({ render: {} });
    }
    const change: Change = { render: {} };
    if (current && loaded) {
      // The page was asked for before what was sent, edited or reacted to while the kept window showed (QA BUG-100), and
      // realtime may not have told it: the newer copies stay. Of the same age, the page's (an author's new name or
      // avatar comes with it). Pending sends are kept by setWin.
      const [a, z] = [loaded.win.items[0], loaded.win.items.at(-1)];
      const meanwhile = win.items.filter((m) => !m.status && (!a || compare(m, a) >= 0) && (!loaded.win.hasNewer || compare(m, z!) <= 0));
      setWin(merge(merge(loaded.win, meanwhile), loaded.win.items));
      setTarget(loaded.target);
      setUnread(loaded.unread);
      change.notice = msgId && !loaded.target ? "That message isn't in this room. Showing the latest messages instead." : "";
      // Otherwise the jump has positioned the list. A stale window was already shown at the first unread message, or
      // you scrolled it: stay there (QA BUG-96), unless it was at the bottom and there is nothing unread.
      if (targetId || !stale || retarget) change.scroll = targetId || loaded.unread ? "target" : "bottom";
      else if (nearBottom() && !loaded.unread) change.scroll = "bottom";
      else change.render = { anchor: true };
    }
    // Ready either way: a jump made during the load already owns the window, but still needs the view live.
    phase = "ready";
    stale = false;
    emit(change);
    if (wanted) void loadEdge(wanted);
    const pending = buffer;
    buffer = [];
    for (const [action, m] of pending) onMessage(action, m);
    // The page and the subscription are set up side by side. A message sent after the page was read but before the
    // server had the subscription reaches neither (QA BUG-61): once the subscription is there, fetch what is newer.
    if (!liveReady) void live.then(catchUp);
  }

  /**
   * Show the room as it was last time while its first page loads, if that is still to come. Nothing is waited for:
   * just after a reload, the kept room stands in for the room list. A room the list lacks waits for the server to say
   * it is yours to see.
   */
  async function showKept(g: number, roomP: Promise<unknown>, firstP: Promise<Cursor | null> | null) {
    const kept = await opts.cache?.get(owner, roomId);
    if (!room() && kept?.room && store.get().roomsStatus !== "ready") store.set(upsertRoom(kept.room));
    if (!room()) await roomP.catch(() => {});
    if (!kept?.items.length || g !== gen || phase !== "loading" || !room() || !scope.active) return;
    const shown = merge({ items: [], hasOlder: kept.hasOlder, hasNewer: false }, kept.items);
    // Opening at the first unread message (§18.5): the count says which one, by the server's rule (reads.js), if they
    // were all prefetched with that count; else the first page opens there. Before the counts are in (a reload), the
    // server says.
    const { unread } = store.get();
    const n = firstP && unread !== UNCOUNTED ? (unread.get(roomId) ?? 0) : 0;
    const theirs = shown.items.filter((m) => m.author !== owner && !m.deleted);
    const guess = n ? theirs[theirs.length - n] : undefined;
    if (n && (!guess || kept.unread !== n)) return;
    setWin(shown);
    setUnread(guess?.id);
    asking = !!firstP && !guess;
    stale = true;
    phase = "ready";
    emit({ render: {}, scroll: guess ? "target" : "bottom" });
    const f = (await firstP)?.id;
    const asked = asking;
    asking = false;
    if (g !== gen || !stale || !scope.active) return;
    if (!f || f === unreadId) return void (asked && emit({ render: { anchor: true } })); // read now
    // Shown at the bottom (or the count was out of step): go where the server says, unless you scrolled away.
    const follow = !!guess || nearBottom();
    if (!find(f)) retarget = follow;
    else {
      setUnread(f);
      emit(follow ? { render: {}, scroll: "target" } : { render: { anchor: true } });
    }
  }

  /** Messages newer than the window's that realtime may have missed while it was being set up (QA BUG-61). */
  async function catchUp() {
    if (!scope.active || !ready() || win.hasNewer) return;
    const g = gen;
    const last = lastSaved(win);
    const page = await api.page(last ? newer(roomId, last) : latest(roomId), signal).catch(() => null);
    if (!page || g !== gen || !scope.active || win.hasNewer) return;
    const missed = page.filter((m) => !find(m.id));
    if (!missed.length) return;
    const follow = follows();
    setWin(applyPage(win, page, last ? "newer" : "latest").win);
    if (!follow) pill = "below";
    emit(follow ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  function retry() {
    if (phase !== "failed" || !scope.active) return;
    phase = "loading";
    emit({ render: {} });
    void open();
  }

  /**
   * After a reconnect: re-fetch the messages in the window that changed while realtime was down, so edits and
   * deletes missed meanwhile apply (a deleted message must not keep showing its text). Newer messages are
   * gapFill's job.
   */
  async function refreshWindow() {
    const g = gen;
    const known = win.items.filter((m) => !m.status);
    const oldest = known[0];
    const newest = known.at(-1);
    if (!oldest || !newest) return;
    // Any change made after the newest `updated` we have was made by the server later: it is newer than that.
    const since = known.reduce((max, m) => (m.updated > max ? m.updated : max), "");
    const changed = await api.changes(changedIn(roomId, since, oldest, newest), signal).catch(() => null);
    if (!changed || g !== gen || !scope.active) return;
    const inWindow = changed.filter((m) => find(m.id));
    if (!inWindow.length) return;
    win = merge(win, inWindow);
    emit(inPlace());
  }

  /** At the live edge after a reconnect: fetch everything newer than what we have (§7.5). */
  async function gapFill() {
    const g = gen;
    const wasNear = follows();
    for (;;) {
      const last = lastSaved(win);
      const page = await api.page(last ? newer(roomId, last) : latest(roomId), signal).catch(() => null);
      if (!page || g !== gen || !scope.active) return;
      setWin(applyPage(win, page, last ? "newer" : "latest").win);
      if (page.length < PAGE_SIZE) break;
    }
    setWin({ ...win, hasNewer: false });
    emit(wasNear ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  function onReconnect() {
    if (!scope.active) return;
    if (phase === "failed") return retry(); // back online: try the first load again
    if (!ready() || stale) return; // the first page is on its way
    void refreshWindow();
    if (!win.hasNewer) void gapFill();
  }

  // ---------------------------------------------------------------- realtime

  /** What a reply shows of `q` (§19). */
  const quoteOf = ({ id, author, text, deleted, files = [], expand }: Quoted): Quoted => ({
    id,
    author,
    text,
    deleted,
    files,
    ...(expand?.author && { expand: { author: expand.author } }),
  });
  const withQuote = (m: Message, q: Quoted): Message => ({ ...m, expand: { ...m.expand, reply_to: quoteOf(q) } });

  /**
   * Live events come without the message a reply answers (api.ts LIVE_TOPIC): the quote is the copy in the window, or
   * the one the message had there; failing both (a reply to a message far back), it is fetched.
   */
  function quoted(m: Message): Message {
    const id = m.reply_to;
    if (!id || m.expand?.reply_to) return m;
    const q = find(id) ?? find(m.id)?.expand?.reply_to;
    if (q) return withQuote(m, q);
    api.getMessage(id).then(
      (q) => {
        if (!scope.active) return;
        win = { ...win, items: win.items.map((x) => (x.reply_to === id && !x.expand?.reply_to ? withQuote(x, q) : x)) };
        emit(inPlace());
      },
      () => {},
    );
    return m;
  }

  function onMessage(action: Action, event: Message) {
    if (!scope.active || event.room !== roomId) return;
    if (action !== "create") opts.onEvent?.(event, action === "delete");
    if (!ready() || stale) buffer.push([action, event]); // the first page may be older than this event
    if (!ready()) return;
    const m = action === "delete" ? event : quoted(event);
    if (action === "delete") {
      win = remove(win, m.id);
      return emit(inPlace());
    }
    if (action === "update") {
      if (!find(m.id)) return;
      win = merge(win, [m]);
      return emit(inPlace());
    }
    // create
    if (find(m.id)) {
      win = merge(win, [m]);
      return emit({ render: {} });
    }
    if (win.hasNewer) {
      pill = "history";
      return emit();
    }
    if (parked && !firstNew && m.author !== me()?.id) firstNew = m.id;
    const follow = !store.get().away && (nearBottom() || m.author === me()?.id);
    win = trim(merge(win, [m]), "top").win;
    if (!follow && pill !== "history") pill = "below";
    emit(follow ? { render: {}, scroll: "bottom" } : { render: { anchor: true } });
  }

  const writes = createWrites({
    api,
    roomId,
    scope,
    me,
    posting,
    editable,
    deletable,
    win: () => win,
    put: (next) => {
      win = next;
    },
    find,
    patchLocal,
    emit,
    inPlace,
    toLatest: () => jump("latest"),
    clearPill: () => {
      pill = null;
    },
    unsent,
    onUpload: opts.onUpload,
  });

  // ---------------------------------------------------------------- lifecycle

  return {
    state: () => ({ win, phase, targetId, unreadId, pill, stale, unsure: stale && asking }),
    park() {
      parked = true;
    },
    resume() {
      parked = false;
      const { unread } = store.get();
      const n = unread === UNCOUNTED || win.hasNewer ? 0 : (unread.get(roomId) ?? 0);
      const theirs = n ? win.items.filter((m) => m.author !== me()?.id && !m.deleted && !m.status) : [];
      const id = (n && theirs[theirs.length - n]?.id) || firstNew;
      firstNew = null;
      if (!id || !find(id)) return false;
      setUnread(id);
      emit({ render: {}, scroll: "target" });
      return true;
    },
    start() {
      scope.defer(() => {
        clearTimeout(keepTimer);
        keep();
        for (const m of [...win.items, ...unsent.values()]) {
          if (m.status === "failed") stray(m);
          revokeLocal(m);
        }
      });
      // Leaving the page (a reload, the tab closed) before the timer: kept now.
      addEventListener("pagehide", keep, { signal });
      // Back online: a first load that failed tries again, even if realtime never noticed (QA BUG-123).
      addEventListener("online", retry, { signal });
      scope.defer(() => clearTimeout(targetTimer));
      for (const m of takeStrays(roomId)) if (m.author === me()?.id) unsent.set(m.id, m); // not from before a logout
      // Room record changes (archive etc.) arrive through the store, kept live by sync.ts.
      const sub = api.subscribeMessages(roomId, onMessage);
      scope.sub(sub);
      live = sub.then(
        () => (liveReady = true),
        () => {},
      );
      scope.defer(api.onConnect((reconnect) => reconnect && onReconnect()));
      void open();
    },
    retry,
    loadEdge,
    jump,
    goTo,
    dismissPill() {
      if (pill !== "below") return;
      pill = null;
      emit();
    },
    find,
    editable,
    deletable,
    repliable,
    lastEditable() {
      const mine = lastOwnEditable(win, me()?.id ?? "");
      return mine && editable(mine) ? mine : undefined;
    },
    send: writes.send,
    retrySend: writes.retrySend,
    discard: writes.discard,
    edit: writes.edit,
    remove: writes.remove,
    selectable: (m) => !!me() && !m.deleted && !m.status,
    removeMany: writes.removeMany,
    reactable,
    reactions: writes.reactions,
    react(id, emoji, on) {
      const m = find(id);
      return m && reactable(m) ? writes.react(id, emoji, on) : null;
    },
  };
}
