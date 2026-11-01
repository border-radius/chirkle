// Room header (§7.1, §16.5): back link, room title, a private room's members (opening the access dialog), the search
// (§29) and media (§30) buttons and the room actions menu (room access, hide, archive, notify of every message (§34.5),
// jump to beginning). A DM shows the other member's avatar and name, and can be closed but never archived. A private or Open
// Air room says so next to its name (§23.1); a guest only gets "Jump to beginning" (§23.3). A room shared with other
// instances says where else it is held, and when its home can't be reached (§33.9, §33.7).

import type { RoomActions } from "../../actions.ts";
import { errorMessage } from "../../api.ts";
import { h } from "../../dom.ts";
import { otherMember, roomTitle, sharedNote, VISIBILITY, visibilityOf } from "../../lib/rooms.ts";
import type { Room, User } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createActionMenu, type MenuItem } from "../../ui/menu.ts";

export interface RoomHeader {
  readonly el: HTMLElement;
  update(state: { room: Room | undefined; hidden: boolean; me: User | null }): void;
}

export function createRoomHeader(opts: {
  titleId: string;
  actions: RoomActions;
  avatarUrl: AvatarUrl;
  onJumpToBeginning: () => void;
  /** Search the room's messages (§29). */
  onSearch: () => void;
  /** Show the room's images and videos as a grid (§30). */
  onMedia: () => void;
  /** "Room access…" (the creator) or "Members" (the others, in a private room): open the access dialog (§23.2). */
  onAccess: () => void;
  /** A DM was closed from this menu. */
  onClosed: () => void;
  /** The notification choices changed (§34.5): app.ts follows them, if it doesn't yet. */
  onNotify: () => void;
  signal: AbortSignal;
}): RoomHeader {
  const { actions, signal } = opts;
  const title = h("h1", { id: opts.titleId });
  const error = h("p", { class: "room-error", role: "alert" });
  const shared = h("p", { class: "room-shared", hidden: true });
  const menu = createActionMenu({ label: "Room actions", signal });
  const search = h("button", {
    type: "button",
    class: "icon-button search-toggle ic i-search",
    "aria-label": "Search messages",
    "aria-expanded": "false",
    title: "Search messages",
    on: { click: opts.onSearch },
    signal,
  });
  // Has the search button's class too, but comes after it: closing search focuses the first `.search-toggle`.
  const media = h("button", {
    type: "button",
    class: "icon-button search-toggle ic i-media",
    "aria-label": "Media",
    title: "Media",
    on: { click: opts.onMedia },
    signal,
  });
  // A private room's members (§23.2): a few faces and how many, opening the access dialog.
  const members = h("button", { type: "button", class: "room-members", hidden: true, on: { click: opts.onAccess }, signal });
  const el = h("header", { class: "room-header" }, [
    h("a", { href: "/", class: "back ic i-back", "aria-label": "Back to rooms" }),
    title,
    members,
    search,
    media,
    menu.el,
    shared,
    error,
  ]);
  /** What the title shows, to rebuild it only when that changes (the avatar is an image). */
  let shown = "";
  let last: Parameters<RoomHeader["update"]>[0] | undefined;

  /** Notify of every message here (§34.5): flip it in notify.ts's choices (chat.notify), without loading notify.ts. */
  async function setNotifyAll(id: string, on: boolean) {
    const p = notifyPrefs();
    const rooms = (Array.isArray(p.rooms) ? p.rooms : []).filter((r) => r !== id);
    if (on) rooms.push(id);
    p.rooms = rooms;
    // Nothing chosen yet to alert with: a pop-up, as ticking DMs on the profile page does.
    if (on && !p.popup && !p.sound) p.popup = true;
    try {
      if (rooms.length || Object.values(p).some((v) => v === true)) localStorage.setItem(NOTIFY_KEY, JSON.stringify(p));
      else localStorage.removeItem(NOTIFY_KEY);
    } catch {}
    if (last) update(last);
    opts.onNotify();
    if (!on || !p.popup || p.sound) return;
    const perm = globalThis.Notification?.permission;
    if (perm === "default") await Notification.requestPermission().catch(() => {});
    if (!signal.aborted && globalThis.Notification?.permission !== "granted")
      error.textContent = "This browser blocks notifications here: allow them, or choose the sound in your profile.";
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      error.textContent = "";
      return true;
    } catch (e) {
      // Say why: network trouble, rate limiting or the server's reason (QA BUG-39).
      if (!signal.aborted) error.textContent = `That didn't work. ${errorMessage(e)}`;
      return false;
    }
  }

  function dmItems(room: Room, hidden: boolean): MenuItem[] {
    return [
      hidden
        ? { label: "Reopen conversation", run: () => void act(() => actions.unhide(room.id)) }
        : {
            label: "Close conversation",
            run: () =>
              void act(() => actions.hide(room.id)).then((ok) => {
                if (ok) opts.onClosed();
              }),
          },
      { label: "Jump to beginning", run: opts.onJumpToBeginning, icon: "i-top", sep: true },
    ];
  }

  function items(room: Room | undefined, hidden: boolean, mine: boolean, guest: boolean): MenuItem[] {
    if (room?.kind === "dm") return dmItems(room, hidden);
    const out: MenuItem[] = [];
    if (guest) return [{ label: "Jump to beginning", run: opts.onJumpToBeginning, icon: "i-top" }];
    if (room && (mine || visibilityOf(room) === "private")) {
      out.push({
        label: mine ? "Room access…" : `Members (${room.members?.length ?? 0})`,
        run: opts.onAccess,
        icon: "i-users",
        ...(mine ? { value: VISIBILITY[visibilityOf(room)].label } : {}),
      });
    }
    // Hiding an archived room is pointless (it is listed under Archived), but one hidden before it was
    // archived must still be unhidable, or it would silently come back hidden after an unarchive.
    if (room && (!room.archived || hidden)) {
      out.push(
        hidden
          ? { label: "Unhide room", run: () => void act(() => actions.unhide(room.id)), icon: "i-eyeoff" }
          : { label: "Hide room", run: () => void act(() => actions.hide(room.id)), icon: "i-eyeoff" },
      );
    }
    if (room && mine) {
      out.push(
        room.archived
          ? { label: "Unarchive room", run: () => void act(() => actions.setArchived(room.id, false)), icon: "i-archive" }
          : {
              label: "Archive room",
              confirm: { text: `Archive “${room.name}”? It becomes read-only for everyone.`, action: "Archive" },
              run: () => void act(() => actions.setArchived(room.id, true)),
              icon: "i-archive",
            },
      );
    }
    if (room && (!room.archived || notifyAll(room.id))) {
      const on = notifyAll(room.id);
      out.push({
        label: "Notify of every message",
        hint: on ? "On — you hear about everything here" : "Off — only replies to you",
        run: () => void setNotifyAll(room.id, !on),
        icon: "i-bell",
        checked: on,
        sep: true,
      });
    }
    out.push({ label: "Jump to beginning", run: opts.onJumpToBeginning, icon: "i-top", sep: out.length > 0 });
    return out;
  }

  function update(state: Parameters<RoomHeader["update"]>[0]) {
    last = state;
    const { room, hidden, me } = state;
    const other = room ? otherMember(room, me) : undefined;
    const text = room ? roomTitle(room, me) : "";
    const vis = room && !other ? visibilityOf(room) : "public";
    const key = JSON.stringify([text, other?.avatar ?? null, vis]);
    if (key !== shown) {
      shown = key;
      const badge =
        vis === "public"
          ? null
          : h(
              "span",
              { class: `vis-badge ic ${vis === "open" ? "i-globe" : "i-lock"}`, title: VISIBILITY[vis].hint },
              VISIBILITY[vis].label,
            );
      title.replaceChildren(
        ...(other
          ? [avatar(other, 24, opts.avatarUrl), h("span", {}, text)]
          : [h("span", { class: "name" }, [h("span", { class: "hash" }, "#"), text.slice(1)]), badge ?? ""]),
      );
    }
    title.classList.toggle("dm-title", !!other);
    const people = room && !other && vis === "private" ? (room.expand?.members ?? []) : [];
    members.hidden = !people.length;
    const faces = people
      .slice(0, 3)
      .map((u) => u.id + (u.avatar ?? ""))
      .join();
    if (people.length && members.dataset.shown !== `${faces}|${people.length}`) {
      members.dataset.shown = `${faces}|${people.length}`;
      members.setAttribute("aria-label", `Members, ${people.length}`);
      members.replaceChildren(
        h(
          "span",
          { class: "faces" },
          people.slice(0, 3).map((u) => avatar(u, 24, opts.avatarUrl)),
        ),
        String(people.length),
      );
    }
    const note = room ? sharedNote(room) : "";
    if (shared.textContent !== note) shared.textContent = note;
    shared.hidden = !note;
    menu.update(items(room, hidden, !!room && room.created_by === me?.id, !me));
  }

  return { el, update };
}

/** notify.ts's NOTIFY_KEY. */
const NOTIFY_KEY = "chat.notify";

function notifyPrefs(): { rooms?: unknown; popup?: unknown; sound?: unknown } {
  try {
    const p: unknown = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? "null");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

/** Is every message of this room notified on this device (§34.5)? */
function notifyAll(id: string): boolean {
  const { rooms } = notifyPrefs();
  return Array.isArray(rooms) && rooms.includes(id);
}
