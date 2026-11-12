// Room view (§7.5, §7.6): windowed message history, optimistic send, edit, soft delete, replies (§19), reactions and
// the emoji picker (§20), selecting messages to forward or delete them (§21), archived mode, read state (§18.3).
// The message window and everything that changes it live in room/controller.ts (no DOM). This module puts the
// controller's changes on screen and wires the parts in room/: header (title + actions menu), search (§29), messages (the list),
// composer and footer (what shows instead of it), selection (the bar while selecting), reply, notice (the status line),
// names (who reacted), pickers (emoji, suggestions), reading (read state), parking (kept while away), gallery (viewer
// and media grid), badges (collections), forward dialog, access dialog (§23.2). A guest reads an Open Air room without
// a composer (§23.3). Images and videos can be saved to collections and attached from them (§31): the save menu and
// the picker are the collections' lazy chunk.

import { errorMessage, reasonOf } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, holdKeys, typeInto, uniqueId } from "../dom.ts";
import { PAGE_SIZE } from "../lib/cursor.ts";
import { emptyForward } from "../lib/messages.ts";
import { canManage, canPost, dmClosed, isDm, otherMember, roomTitle } from "../lib/rooms.ts";
import { isNearBottom } from "../lib/scroll.ts";
import { formatTime, parsePb } from "../lib/time.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import { roomSections } from "../store.ts";
import { avatar } from "../ui/avatar.ts";
import { createLoadbar } from "../ui/loadbar.ts";
import type { AccessDialog } from "./room/access.ts";
import { createRoomCollections } from "./room/badges.ts";
import { createComposer, validEdit } from "./room/composer.ts";
import { type Change, createRoomController, type Phase, type RoomController } from "./room/controller.ts";
import { createFooter } from "./room/footer.ts";
import type { ForwardDialog } from "./room/forward.ts";
import { createGallery } from "./room/gallery.ts";
import { createRoomHeader } from "./room/header.ts";
import { createMessageList } from "./room/messages.ts";
import { createNameLookup } from "./room/names.ts";
import { createNotice } from "./room/notice.ts";
import { createParking } from "./room/parking.ts";
import { createPickers } from "./room/pickers.ts";
import { reactionFocus } from "./room/reactions.ts";
import { createReading } from "./room/reading.ts";
import { createReply } from "./room/reply.ts";
import { createSelection } from "./room/selection.ts";

/**
 * Two changes as one: the later scroll and notice, and a render if either asked for one, keeping the anchor if either
 * did (content changed above what is on screen).
 */
export function mergeChanges(a: Change, b: Change): Change {
  const c = { ...a, ...b };
  if (a.render?.anchor) c.render = a.render;
  return c;
}

/** What the room view uses of the app shell's services. */
export type RoomCtx = Pick<
  Ctx,
  "api" | "store" | "unread" | "actions" | "navigate" | "reopen" | "drafts" | "cache" | "collections" | "notify" | "early"
>;

export function createRoomView({
  api,
  store,
  unread,
  actions,
  navigate,
  reopen,
  drafts,
  cache,
  collections,
  notify,
  early,
}: RoomCtx): View {
  const vid = uniqueId("room");
  const scope = createScope();
  const { signal } = scope;
  let root: HTMLElement;
  let roomId = "";
  /** Created on mount, when the room id is known. */
  let ctl: RoomController;
  /** The phase the header, footer and list were last drawn for. */
  let shown: Phase = "loading";
  /** The messages the forward dialog is open for. */
  let forwarding: string[] = [];

  const room = () => store.get().rooms.get(roomId);
  const me = () => store.get().user;
  const state = () => ctl.state();

  // ---------------------------------------------------------------- parts

  const notice = createNotice(signal);
  const say = (text: string) => notice.say(text);
  const nameOf = createNameLookup({
    usersById: (ids, sig) => api.usersById(ids, sig),
    signedIn: () => !!me(),
    onFound: () => render({ anchor: true }),
    signal,
  });
  const colls = createRoomCollections({
    api,
    store,
    collections,
    scope,
    rerender: () => render({ anchor: true }),
    addItems: (items) => composer.addItems(items),
    say,
  });
  const header = createRoomHeader({
    titleId: `${vid}-title`,
    actions,
    avatarUrl: api.avatarUrl,
    onJumpToBeginning: () => void now(() => ctl.jump("first")),
    onSearch: () => void openSearch(),
    onMedia: () => gallery.openGrid(),
    onAccess: () => void openAccess(),
    onClosed: () => navigate("/"),
    onNotify: notify,
    signal,
  });
  /** The access dialog (§23.2), once opened: a lazy chunk. */
  let accessDialog: AccessDialog | null = null;
  async function openAccess() {
    try {
      const { createAccessDialog } = await import("./room/access.ts");
      if (!scope.active) return;
      accessDialog ??= newAccessDialog(createAccessDialog);
      let r = room();
      // A moderator's in someone else's room (§36): its creator by name, who isn't expanded unless a member.
      const u = me();
      if (r && u && r.created_by !== u.id && !r.expand?.members?.some((x) => x.id === r!.created_by)) {
        const found = await api.usersById([r.created_by]).catch(() => []);
        if (!scope.active) return;
        r = room() ?? r;
        r = { ...r, expand: { ...r.expand, members: [...(r.expand?.members ?? []), ...found] } };
      }
      if (r) accessDialog.open(r, canManage(r, me()), me());
    } catch {
      if (scope.active) say("Couldn't open room access. Check your connection.");
    }
  }
  const newAccessDialog = (create: typeof import("./room/access.ts").createAccessDialog) => {
    const dialog = create({
      searchUsers: (q, sig) => api.searchUsers(q, sig),
      remoteUser: (address, room) => api.remoteUser(address, room),
      avatarUrl: api.avatarUrl,
      onSave: async (visibility, members, posting, writers) => {
        try {
          await actions.setAccess(roomId, visibility, members, posting, writers);
          return null;
        } catch (e) {
          return `Couldn't save. ${errorMessage(e)}`;
        }
      },
      signal,
    });
    shell.append(dialog.el);
    return dialog;
  };
  /** "Beginning of #general" / "Beginning of your conversation with Bob". */
  const beginningLabel = () => {
    const r = room();
    if (!r) return "Beginning of the room";
    return isDm(r) ? `Beginning of your conversation with ${otherMember(r, me())?.name ?? "Unknown"}` : `Beginning of #${r.name}`;
  };
  const messages = createMessageList({
    state: () => {
      const s = state();
      return {
        win: s.win,
        ready: s.phase === "ready",
        failed: s.phase === "failed",
        beginning: beginningLabel(),
        targetId: s.targetId,
        unreadId: s.unreadId,
        selected: selection.ids,
      };
    },
    me,
    editable: (m) => ctl.editable(m),
    deletable: (m) => ctl.deletable(m),
    repliable: (m) => ctl.repliable(m),
    onReply: (id) => reply.start(id),
    selectable: (m) => ctl.selectable(m),
    onSelect: (id) => selection.toggle(id),
    onForward: (id) => void openForward([id]),
    reactable: (m) => ctl.reactable(m),
    reactions: (m) => ctl.reactions(m),
    onReact: (id, emoji, on) => void react(id, emoji, on),
    onPickReaction: (id, opener) => pickReaction(id, opener),
    nameOf,
    onOpenQuote: (id, from) => void now(() => ctl.goTo(id, from)),
    onRetryLoad: () => now(() => ctl.retry()),
    onSaveEdit: (id, text) => void saveEdit(id, text),
    onCancelEdit: () => composer.focus(),
    onDelete: (id) => void doDelete(id),
    onRetrySend: (id) => void now(() => ctl.retrySend(id)),
    onDiscard: (id) => now(() => ctl.discard(id)),
    fileUrl: api.fileUrl,
    posterUrl: api.posterUrl,
    onOpenImage: (m, file, opener) => void gallery.view(m, file, opener),
    badge: colls.badge,
    ...(me() ? { onSave: colls.saveFile } : {}),
    avatarUrl: api.avatarUrl,
    onMessageUser: (userId) => void messageUser(userId),
    isBanned: (userId) => api.isBanned(userId),
    onBan: (userId, banned) => void setBanned(userId, banned),
    signal,
  });
  const composer = createComposer({
    id: `${vid}-text`,
    onSend: (text, files) => {
      if (!now(() => ctl.send(text, files, reply.to ?? undefined))) return false;
      reply.set(null);
      return true;
    },
    onEditLast: () => {
      const mine = ctl.lastEditable();
      if (mine) messages.startEdit(mine.id);
      return !!mine;
    },
    onStepReply: (dir) => reply.step(dir),
    onCancelReply: () => reply.set(null),
    onEmoji: (opener, insert) => void pickers.open(opener, { label: "Insert emoji", onPick: insert, restoreFocus: () => composer.focus() }),
    onEmojiName: (textarea) => pickers.suggestEmoji(textarea),
    onMention: (textarea) => pickers.suggestPeople(textarea),
    // Kept as you type, so a reload doesn't lose it (§22.3).
    onChange: (text) => {
      if (roomId) drafts.set(roomId, text);
    },
    onCollections: colls.pickItems,
    signal,
  });
  /** The forward dialog (§21.3), once Forward was chosen: a lazy chunk. */
  let forwardDialog: ForwardDialog | null = null;
  const newForwardDialog = (create: typeof import("./room/forward.ts").createForwardDialog) =>
    create({
      rooms: () => {
        const s = roomSections(store.get());
        // Only where you may post (§23.6), and not into a DM that takes no messages (§16.7).
        return [...s.dms, ...s.rooms, ...s.hidden].filter((r) => canPost(r, me()) && !dmClosed(r, me()));
      },
      me,
      searchUsers: (q, sig) => api.searchUsers(q, sig),
      avatarUrl: api.avatarUrl,
      onPick: async (to) => {
        // Not those deleted since the dialog opened: one would fail the whole forward.
        const ids = forwarding.filter((id) => {
          const m = ctl.find(id);
          return !m || !(m.deleted || emptyForward(m));
        });
        if (!ids.length) return "Couldn't forward. A message was deleted.";
        try {
          const target = "room" in to ? to.room : await actions.openDm(to.user.id);
          const n = (await api.forward(ids, target.id)).length;
          if (!scope.active) return null;
          selection.end();
          if (target.id !== roomId) navigate(`/r/${target.id}`);
          else notice.flash(n === 1 ? "Message forwarded." : `${n} messages forwarded.`);
          return null;
        } catch (e) {
          return `Couldn't forward. ${reasonOf(e)}`;
        }
      },
      signal,
    });
  const list = messages.el;
  const pill = h("button", { type: "button", class: "new-messages ic i-down", hidden: true });
  const parking = createParking(list, signal);
  const reading = createReading(list, state, scope);
  const bar = createLoadbar();
  scope.defer(() => bar.set(false));

  const reply = createReply({
    find: (id) => ctl.find(id),
    list: () => state().win.items,
    repliable: (m) => ctl.repliable(m),
    composer,
    reveal: (id) => list.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.scrollIntoView?.({ block: "nearest" }),
  });

  // ---------------------------------------------------------------- selecting (§21)

  const selection = createSelection({
    find: (id) => ctl.find(id),
    selectable: (m) => ctl.selectable(m),
    deletable: (m) => ctl.deletable(m),
    onStart: (id) => {
      pickers.close();
      messages.focusIn(id, ["input.select"], true);
    },
    onChange: (list) => {
      renderFooter();
      if (list) render({ anchor: true });
    },
    focusComposer: () => composer.focus(),
    onForward: (ids) => void openForward(ids),
    onDelete: (ids) => void deleteSelected(ids),
    notice,
    signal,
  });
  const footer = createFooter({
    composer,
    selection,
    room,
    me,
    closePicker: () => pickers.close(),
    parked: () => parking.parked,
    active: () => scope.active,
    signal,
  });
  const shell = h("section", { class: "room", "aria-labelledby": `${vid}-title` }, [
    header.el,
    notice.el,
    h("div", { class: "room-body" }, [bar.el, list, pill]),
    footer.el,
  ]);
  const pickers = createPickers({ api, roomId: () => roomId, shell, scope, say });
  const gallery = createGallery({
    api,
    roomId: () => roomId,
    room,
    win: () => state().win,
    goTo: (id) => now(() => ctl.goTo(id)),
    saveFile: colls.saveFile,
    signedIn: () => !!me(),
    screen: () => parking.screen,
    scope,
    say,
  });

  /** Render the list, then mark what it shows as read (once it is laid out). */
  function render(o?: { anchor?: boolean }) {
    selection.prune();
    messages.render(o);
    // Deleted (or gone from the list) meanwhile: nothing left to react to (QA BUG-121).
    if (pickers.reactingTo && pickers.isOpen) {
      const m = ctl.find(pickers.reactingTo);
      if (!m || !ctl.reactable(m)) pickers.close();
    }
    reading.watchRows();
    reading.readSoon();
  }

  async function deleteSelected(ids: string[]) {
    const failed = await now(() => ctl.removeMany(ids));
    // Say why: network trouble, rate limiting or the server's reason (QA BUG-58).
    if (failed && scope.active) say(`Couldn't delete those messages. ${reasonOf(failed)}`);
  }

  async function openForward(ids: string[]) {
    if (!ids.length) return;
    forwarding = ids;
    pickers.close();
    try {
      const { createForwardDialog } = await import("./room/forward.ts");
      if (!scope.active || forwarding !== ids) return;
      if (!forwardDialog) {
        forwardDialog = newForwardDialog(createForwardDialog);
        shell.append(forwardDialog.el);
      }
      forwardDialog.open(ids.length);
    } catch {
      if (scope.active) say("Couldn't open Forward. Check your connection.");
    }
  }

  /**
   * Changes are drawn at most once a frame. The first one is drawn right away (a message, a send or a click shows at
   * once); those that come in before the next frame are merged and drawn together in it. A burst of realtime events
   * then costs one render and one layout, not one each: every render ends by measuring the list (markRead,
   * renderPill), which makes the browser lay it out again.
   */
  let queued: Change | null = null;
  let frame = 0;
  /** Set while the user's own action runs: what it changes is drawn at once, never left for the next frame. */
  let direct = false;
  function apply(c: Change) {
    queued = queued ? mergeChanges(queued, c) : c;
    if (!frame || direct) flush();
  }

  /**
   * Draw what is queued, then keep merging until the next frame. Also called when the tab comes back: a hidden tab
   * has no frames.
   */
  function flush() {
    const q = queued;
    queued = null;
    if (!q || !scope.active) return;
    draw(q);
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      flush();
    });
  }

  /** Run a controller call the user made (a click, a key): its changes show right away (see apply). */
  function now<T>(fn: () => T): T {
    direct = true;
    try {
      return fn();
    } finally {
      direct = false;
    }
  }

  /** Put a controller change on screen. */
  function draw(c: Change) {
    const s = state();
    if (s.phase !== shown) {
      shown = s.phase;
      if (s.phase === "not-found") return renderNotFound();
      list.setAttribute("aria-busy", String(s.phase === "loading"));
      renderHeader();
      renderFooter();
    }
    if (c.notice !== undefined) say(c.notice);
    if (c.render) {
      render(c.render);
      reply.refresh();
    }
    if (parking.hold(c.scroll)) return;
    if (c.scroll === "bottom") scrollToBottom();
    else if (c.scroll === "top") list.scrollTop = 0;
    else if (c.scroll === "target") {
      // A message gone to is centred; the first unread one goes near the top, with what follows it below.
      const id = s.targetId ?? s.unreadId;
      const el = id && list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`);
      if (el) list.scrollTop = el.offsetTop - list.clientHeight / (s.targetId ? 2 : 4);
    }
    if (c.scroll) reading.markRead(); // what the scroll brought into view (render read where the list was before it)
    renderPill();
  }

  /**
   * The button over the bottom of the list: "Back to reply" after following quotes, one step back per click (§19.5);
   * else "New messages" when some arrived out of sight (§7.5), else "Jump to latest" whenever the newest messages
   * aren't on screen: scrolled up, or the window is back in history (§22.7).
   */
  function renderPill() {
    const s = state();
    const away = s.phase === "ready" && (s.win.hasNewer || !isNearBottom(list));
    const back = s.phase === "ready" && s.back !== null;
    pill.hidden = s.pill === null && !away && !back;
    pill.classList.toggle("jump", back || s.pill === null);
    pill.textContent = back
      ? "Back to reply"
      : s.pill === "history"
        ? "New messages · Jump to latest"
        : s.pill === "below"
          ? "New messages"
          : "Jump to latest";
  }

  function scrollToBottom() {
    list.scrollTop = list.scrollHeight;
    reading.markRead();
  }

  function renderHeader() {
    header.update({ room: room(), hidden: store.get().hidden.has(roomId), me: me() });
  }

  const renderFooter = () => footer.render(shown === "failed");

  /** "Message" on an author: open the DM with them (§16.5). */
  async function messageUser(userId: string) {
    try {
      const dm = await actions.openDm(userId);
      if (scope.active) navigate(`/r/${dm.id}`);
    } catch (e) {
      if (scope.active) say(`Couldn't open that conversation. ${errorMessage(e)}`);
    }
  }

  /** A moderator's Ban or Unban on an author (§36). */
  async function setBanned(userId: string, banned: boolean) {
    try {
      await api.setBanned(userId, banned);
      if (scope.active) say(banned ? "Banned. They can't sign in until unbanned." : "Unbanned.");
    } catch (e) {
      if (scope.active) say(`Couldn't ${banned ? "ban" : "unban"} them. ${errorMessage(e)}`);
    }
  }

  /**
   * Shown "not found" or "gone": once the room is yours to see (again), the page starts over and shows it (§23.4, QA
   * BUG-60). Clicking it in the room list couldn't: it is the same URL.
   */
  let offReturn: (() => void) | null = null;
  function awaitReturn() {
    offReturn ??= store.subscribe((s, prev) => {
      // Parked, it is made afresh when you come back (resume can't show it).
      if (s.rooms.has(roomId) && !prev.rooms.has(roomId) && s.user === prev.user && !parking.parked) reopen();
    });
  }

  /** The page's heading says it, as a room's name would (QA BUG-90). */
  const notFound = (title: string, rest: (Node | string)[]) => h("div", { class: "not-found" }, [h("h1", {}, title), h("p", {}, rest)]);

  function renderNotFound() {
    awaitReturn();
    // A guest may have followed a link to a room that needs an account (§23.3).
    const why = me() ? [] : [h("a", { href: "/login" }, "Log in"), " to see more rooms, or "];
    const back = h("a", { href: "/" }, me() ? "Back to rooms" : "go back to the Open Air rooms");
    shell.replaceChildren(notFound("This room doesn't exist.", [...why, back]));
  }

  /**
   * The room went from the list while open (§23.4): you were taken out of a private room, or it is no longer open to
   * guests. What was on screen goes too.
   */
  function renderGone() {
    shown = "not-found";
    awaitReturn();
    pickers.close();
    forwardDialog?.close();
    accessDialog?.close();
    const back = h("a", { href: "/" }, "Back to rooms");
    shell.replaceChildren(notFound("You can't see this room any more.", [back]));
    scope.dispose();
  }

  /** The search bar (§29), while open. */
  let search: { el: HTMLElement; focus(): void } | null = null;

  /**
   * Open the search bar under the header, or focus it when open. A lazy chunk, loaded the first time; if it can't be
   * (offline, or a new version was deployed), say so.
   */
  async function openSearch() {
    if (search) return search.focus();
    // While the chunk loads: what is typed meanwhile, for the field once it shows, as Jump to keeps it (QA BUG-243).
    const held = holdKeys(signal);
    try {
      const { createSearch } = await import("./room/search.ts");
      const toggle = shell.querySelector<HTMLElement>(".search-toggle");
      if (!scope.active || search) return; // opened meanwhile (it has focus)
      const r = room();
      search = createSearch({
        room: roomId,
        label: r ? roomTitle(r, me()) : "this room",
        page: (q, sig) => api.page(q, sig),
        pageSize: PAGE_SIZE,
        when: (m) => formatTime(parsePb(m.created)),
        avatar: (u) => avatar(u, 24, api.avatarUrl),
        onPick: (id) => void now(() => ctl.goTo(id)),
        onClose: () => {
          search = null;
          toggle?.setAttribute("aria-expanded", "false");
          toggle?.focus();
        },
        signal,
      });
      header.el.after(search.el);
      toggle?.setAttribute("aria-expanded", "true");
      search.focus();
      typeInto(search.el.querySelector("input"), held.take());
    } catch {
      if (scope.active) say("Couldn't open search. Check your connection.");
    } finally {
      held.take();
    }
  }

  // ---------------------------------------------------------------- edit / delete

  async function saveEdit(id: string, raw: string) {
    const m = ctl.find(id);
    const text = m ? validEdit(raw, !!m.files?.length) : null;
    if (text === null) return; // the edit box says what is wrong (messages.ts)
    messages.stopEdit();
    messages.setError(id, null);
    const saving = now(() => ctl.edit(id, text)); // renders the new text right away
    if (!saving) render(); // nothing to save: just close the box
    composer.focus();
    if ((await saving) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't save your edit.", retry: () => void saveEdit(id, text) });
    render({ anchor: true });
  }

  async function doDelete(id: string) {
    messages.setError(id, null);
    if ((await now(() => ctl.remove(id))) !== false || !scope.active) return;
    messages.setError(id, { text: "Couldn't delete this message.", retry: () => void doDelete(id) });
    render({ anchor: true });
  }

  // ---------------------------------------------------------------- reactions

  /** Add or take back my reaction; focus stays on it (its message is redrawn). Failing, say so under the message. */
  async function react(id: string, emoji: string, on: boolean) {
    messages.setError(id, null);
    messages.focusIn(id, reactionFocus(emoji), true);
    const saving = now(() => ctl.react(id, emoji, on));
    if (!saving) return render({ anchor: true });
    const done = await saving;
    if (done === true || !scope.active) return;
    messages.setError(id, {
      text: done || (on ? `Couldn't add your ${emoji} reaction.` : `Couldn't remove your ${emoji} reaction.`),
      ...(done ? {} : { retry: () => void react(id, emoji, on) }),
    });
    render({ anchor: true });
  }

  /** The picker for a reaction to message `id`: picking an emoji I already reacted with takes it back. */
  function pickReaction(id: string, opener: HTMLElement) {
    const m = ctl.find(id);
    const user = me();
    if (!m || !user || !ctl.reactable(m)) return;
    const mine = new Set(ctl.reactions(m).flatMap((r) => (r.users.includes(user.id) ? [r.emoji] : [])));
    void pickers.open(
      opener,
      {
        label: "Add reaction",
        chosen: mine,
        onPick: (emoji) => void react(id, emoji, !mine.has(emoji)),
        restoreFocus: () => messages.focusIn(id, [".actions .react", ".reactions .add-reaction"]),
      },
      id,
    );
  }

  // ---------------------------------------------------------------- lifecycle

  /** Single use: the router and the sidebar layout create a fresh view for every mount. */
  return {
    mount(el, params) {
      root = el;
      roomId = params.id!;
      ctl = createRoomController({
        api,
        store,
        roomId,
        msgId: params.msgId,
        scope,
        nearBottom: () => (parking.parked ? parking.pinned : isNearBottom(list)),
        onChange: apply,
        onUpload: (id, fraction) => messages.setUpload(id, fraction),
        onBusy: bar.set,
        cache,
        early: params.msgId ? undefined : early?.take(roomId),
        onEvent: gallery.changed,
      });

      pill.addEventListener(
        "click",
        () => {
          const s = state();
          if (s.back !== null) return void now(() => ctl.goBack());
          if (s.pill === "history" || s.win.hasNewer) return void now(() => ctl.jump("latest"));
          scrollToBottom();
          ctl.dismissPill();
          renderPill();
        },
        { signal },
      );
      list.addEventListener("scroll", () => isNearBottom(list) && ctl.dismissPill(), { signal });
      list.addEventListener("scroll", renderPill, { signal });
      // Escape stops selecting (the forward dialog handles its own Escape).
      shell.addEventListener(
        "keydown",
        (e) => {
          if (e.key !== "Escape" || e.defaultPrevented || forwardDialog?.el.open) return;
          if (selection.escape()) e.preventDefault();
        },
        { signal },
      );
      document.addEventListener(
        "visibilitychange",
        () => {
          flush();
          reading.markRead();
        },
        { signal },
      );
      footer.bind(shell);
      // When the list gets shorter (the attachment tray opens, the textarea grows, the keyboard opens) while it is
      // at the live bottom, keep it there instead of letting the newest messages slide under the composer (BUG-31).
      if (typeof ResizeObserver === "function") {
        const resizes = new ResizeObserver(() => {
          const s = state();
          if (parking.pinned && !parking.parked && s.phase === "ready" && !s.win.hasNewer) scrollToBottom();
        });
        resizes.observe(list);
        scope.defer(() => resizes.disconnect());
      }

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting || !list.contains(e.target)) continue;
            if (e.target === messages.topSentinel) void ctl.loadEdge("top");
            if (e.target === messages.bottomSentinel) void ctl.loadEdge("bottom");
          }
        },
        { root: list, rootMargin: "300px 0px" },
      );
      observer.observe(messages.topSentinel);
      observer.observe(messages.bottomSentinel);
      scope.defer(() => observer.disconnect());

      clear(root);
      root.append(shell);
      renderHeader();
      renderFooter();
      // What you were writing here before visiting another room (QA BUG-50) or reloading the page (§22.3).
      composer.setText(drafts.get(roomId));

      store.set({ activeRoomId: roomId });
      // Not if another room is open by now (this one was kept, and goes).
      scope.defer(() => store.get().activeRoomId === roomId && store.set({ activeRoomId: null }));
      reading.open(unread.open(roomId));
      scope.defer(reading.leave);
      scope.defer(
        store.subscribe((s, prev) => {
          // Lost while you were in it (§23.4). Not on logging out: the views start over then anyway.
          if (prev.rooms.has(roomId) && !s.rooms.has(roomId) && s.user === prev.user && shown !== "not-found") return renderGone();
          const roomChanged = s.rooms.get(roomId) !== prev.rooms.get(roomId);
          if (roomChanged || s.hidden !== prev.hidden || s.user !== prev.user) {
            renderHeader();
            renderFooter();
            if (roomChanged) {
              render();
              reply.refresh(); // archived: the reply bar closes
            }
          }
        }),
      );
      ctl.start();
    },
    park() {
      reading.leave();
      parking.park();
      pickers.close();
      forwardDialog?.close();
      accessDialog?.close();
      ctl.park();
    },
    resume() {
      if (!scope.active || shown === "not-found" || shown === "failed" || offReturn) return false;
      const scroll = parking.unpark();
      store.set({ activeRoomId: roomId });
      reading.open(unread.open(roomId));
      footer.focusNext();
      renderHeader();
      renderFooter();
      parking.restore(
        now(() => ctl.resume()),
        scroll,
        (s) => draw({ scroll: s }),
        scrollToBottom,
      );
      renderPill();
      reading.readSoon();
      return true;
    },
    unmount() {
      offReturn?.();
      scope.dispose();
      clear(root);
    },
  };
}
