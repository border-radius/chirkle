// Forward dialog (§21.3): choose where messages go — a room, a DM, or someone you have no DM with yet (found by name).
// A modal <dialog>: it keeps focus inside, Escape closes it, and focus goes back to where it was.
//
// A lazy chunk: the room view loads it when Forward is first chosen. It imports types only, and gets what it uses of
// app.js in `kit` (lazy.ts FORWARD_KIT).

import type { h, uniqueId } from "../../dom.ts";
import type { otherMember, roomTitle } from "../../lib/rooms.ts";
import type { Room, User } from "../../lib/types.ts";
import type { AvatarUrl, avatar } from "../../ui/avatar.ts";

export interface ForwardKit {
  h: typeof h;
  uniqueId: typeof uniqueId;
  avatar: typeof avatar;
  otherMember: typeof otherMember;
  roomTitle: typeof roomTitle;
  /** How long typing pauses before people are searched (the people search's). */
  SEARCH_DEBOUNCE_MS: number;
}

export type ForwardTo = { room: Room } | { user: User };

export interface ForwardDialog {
  readonly el: HTMLDialogElement;
  /** Open it for `count` messages. */
  open(count: number): void;
  close(): void;
}

export function createForwardDialog(opts: {
  kit: ForwardKit;
  /** Where messages can go, in the order to offer them. */
  rooms: () => Room[];
  me: () => User | null;
  searchUsers: (query: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: AvatarUrl;
  /** Forward there. Resolves to what went wrong, or null once it is done (the dialog then closes). */
  onPick: (to: ForwardTo) => Promise<string | null>;
  signal: AbortSignal;
}): ForwardDialog {
  const { signal } = opts;
  const { h, uniqueId, avatar, otherMember, roomTitle, SEARCH_DEBOUNCE_MS } = opts.kit;
  const id = uniqueId("forward");
  const title = h("h2", { id: `${id}-title` });
  const input = h("input", {
    type: "search",
    autocomplete: "off",
    placeholder: "Search rooms and people",
    "aria-label": "Search rooms and people",
    "aria-controls": `${id}-list`,
  });
  const status = h("p", { class: "search-status", role: "status" });
  const list = h("ul", { id: `${id}-list`, class: "search-results forward-list", "aria-label": "Forward to" });
  const cancel = h("button", { type: "button", class: "cancel", on: { click: () => close() }, signal }, "Cancel");
  const el = h("dialog", { class: "forward", "aria-labelledby": title.id }, [title, input, status, list, cancel]);

  let people: User[] = [];
  /** A people search is waiting for its debounce or its answer. */
  let searching = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;

  function target(label: string, icon: HTMLElement, to: ForwardTo): HTMLElement {
    return h(
      "li",
      {},
      h("button", { type: "button", class: "person", on: { click: () => void pick(to) }, signal }, [icon, h("span", {}, label)]),
    );
  }

  function show() {
    const q = input.value.trim().toLowerCase();
    const me = opts.me();
    const rooms = opts.rooms().filter((r) => roomTitle(r, me).toLowerCase().includes(q));
    // Someone you already have a DM with is offered as that DM. Only DMs: sharing a private room with someone is no
    // way to reach them alone.
    const inDms = new Set(opts.rooms().map((r) => otherMember(r, me)?.id));
    const items = [
      ...rooms.map((r) => {
        const other = otherMember(r, me);
        // A room's name after its "#" icon: its title, "#name", would say "#" twice.
        return target(other ? roomTitle(r, me) : r.name, other ? avatar(other, 24, opts.avatarUrl) : h("span", { class: "hash" }, "#"), {
          room: r,
        });
      }),
      // (Found for an earlier query, until this one's answer comes: only those that still match.)
      ...(q ? people.filter((u) => !inDms.has(u.id) && u.name.toLowerCase().includes(q)) : []).map((u) =>
        target(u.name, avatar(u, 24, opts.avatarUrl), { user: u }),
      ),
    ];
    list.replaceChildren(...items);
    if (!busy) status.textContent = items.length ? "" : searching ? "Searching…" : "Nothing found.";
  }

  async function search(q: string) {
    inflight?.abort();
    people = [];
    if (!q) {
      searching = false;
      return show();
    }
    const ac = new AbortController();
    inflight = ac;
    try {
      const found = await opts.searchUsers(q, ac.signal);
      if (inflight === ac && !signal.aborted) people = found.filter((u) => !u.no_dms); // no DM with them (§16.7)
    } catch {
      /* rooms still show; people are a bonus */
    }
    if (inflight !== ac || signal.aborted) return;
    searching = false;
    show();
  }

  function setBusy(on: boolean) {
    busy = on;
    el.classList.toggle("busy", on);
    cancel.disabled = on; // what happens to the forward must be seen: it can't be called off once sent
  }

  async function pick(to: ForwardTo) {
    if (busy) return;
    setBusy(true);
    status.textContent = "Forwarding…";
    const problem = await opts.onPick(to);
    setBusy(false);
    if (signal.aborted) return;
    if (problem === null) return close();
    status.textContent = problem;
    if (!el.open) el.showModal(); // closed anyway meanwhile (a second Escape can't be refused): say what went wrong
  }

  function close() {
    clearTimeout(timer);
    inflight?.abort();
    if (el.open) el.close();
  }

  // Escape while forwarding: stay open until it is done.
  el.addEventListener("cancel", (e) => busy && e.preventDefault(), { signal });
  input.addEventListener(
    "input",
    () => {
      searching = input.value.trim() !== "";
      show();
      clearTimeout(timer);
      timer = setTimeout(() => void search(input.value.trim()), SEARCH_DEBOUNCE_MS);
    },
    { signal },
  );
  signal.addEventListener("abort", close, { once: true });

  return {
    el,
    open(count) {
      title.textContent = count === 1 ? "Forward message" : `Forward ${count} messages`;
      input.value = "";
      people = [];
      searching = false;
      status.textContent = "";
      show();
      if (!el.open) el.showModal();
      input.focus();
    },
    close,
  };
}
