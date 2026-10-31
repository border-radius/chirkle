// Room list (§7.1, §16.5): the site's name and "Jump to" (§32) on top, Rooms / Direct messages / Collections (§31) /
// Hidden & archived sections, new-room form, user search, Unhide / Unarchive buttons, unread badges (§18.4) and new items in
// collections you follow, private and Open Air markers (§23.1), and who you are (or the way in) at the foot. A guest
// gets only the Open Air rooms, to read (§23.3).
// The data comes from the store, kept live by sync.ts; this view only renders it and issues commands.

import { ApiError, errorMessage, reasonOf } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, reconcile, uniqueId } from "../dom.ts";
import { brand, jumpButton } from "../header.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import { isAddress, otherMember, roomTitle, VISIBILITY, visibilityOf } from "../lib/rooms.ts";
import type { Collection, Room, User, Visibility } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope, type Scope } from "../scope.ts";
import { roomSections, unreadCount } from "../store.ts";
import { avatar } from "../ui/avatar.ts";
import { collectionIcon } from "../ui/icon.ts";
import type { MenuItem } from "../ui/menu.ts";
import { createUserSearch, SearchError, type UserSearch } from "../ui/user-search.ts";
import { chunkContext, collectionChunk } from "./collection.ts";

type Section = "rooms" | "dms" | "hidden" | "archived";

const FOLD_KEY = "chat.folded";
/** Sections folded by their heading (Rooms, Direct messages, Collections), remembered in this browser. */
const folded = new Set<string>();
try {
  for (const s of JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]")) folded.add(s);
} catch {}

function nameError(err: unknown): string {
  if (err instanceof ApiError && err.codes.name === "validation_not_unique") return "A room with this name already exists.";
  if (err instanceof ApiError && err.fields.name) return err.fields.name;
  return errorMessage(err);
}

/** A private or Open Air room's marker next to its name (public rooms have none: they are the usual kind). */
export function visibilityMark(v: Visibility): HTMLElement | null {
  if (v === "public") return null;
  const { label } = VISIBILITY[v];
  return h(
    "span",
    { class: `vis ic ${v === "open" ? "i-globe" : "i-lock"}`, title: label },
    h("span", { class: "visually-hidden" }, ` (${label})`),
  );
}

/** What the room list uses of the app shell's services. */
export type RoomsCtx = Pick<Ctx, "api" | "store" | "sync" | "unread" | "actions" | "navigate" | "collections">;

export function createRoomsView({ api, store, sync, unread, actions, navigate, collections }: RoomsCtx): View {
  const id = uniqueId("rooms");
  let root: HTMLElement;
  let scope: Scope;

  // UI state that must survive re-renders.
  let moreOpen = false;
  /** Room rows by room id, with what they were drawn from (roomRow). */
  const rows = new Map<string, { sig: unknown[]; el: HTMLElement }>();
  /** The sections, built on mount (skeleton). */
  let parts: ReturnType<typeof skeleton>;
  /** The last failed action, shown until the next action or a successful one. */
  let actionError = "";
  /** The "New message" user search, while open (kept across renders, so typing and focus survive). */
  let search: UserSearch | null = null;
  /** The new-room form, built once per mount and shown while `creating` (so a half-typed name survives). */
  let newRoom: { form: HTMLFormElement; input: HTMLInputElement; reset: () => void };
  const guest = () => !store.get().user;
  let creating = false;
  /** Collection rows by id, with what they were drawn from. */
  const collRows = new Map<string, { sig: unknown[]; el: HTMLElement }>();

  const alert = h("p", { role: "alert", class: "list-error" });
  const nav = h("nav", { "aria-label": "Rooms" });
  const shell = h("section", { class: "rooms", "aria-busy": "true" });
  const top = h("div", { class: "side-top" });
  const foot = h("div", { class: "side-foot" });
  /** What top and foot were drawn for. */
  let drawn: unknown[] = [];

  /** The site's name and Jump to; at the foot, who you are and your settings, or (a guest) the way in. */
  function renderEnds() {
    const { site, user } = store.get();
    if (drawn[0] === site && drawn[1] === user) return;
    drawn = [site, user];
    top.replaceChildren(brand(site), jumpButton(true));
    foot.replaceChildren(
      ...(user
        ? [
            h("a", { href: "/me", class: "me-link", title: "Your profile" }, [
              avatar(user, 32, api.avatarUrl),
              h("span", { class: "who" }, user.name),
            ]),
            h("a", { href: "/me", class: "icon-button ic i-gear", "aria-label": "Settings", title: "Settings" }),
          ]
        : [
            h("p", {}, "You're reading as a guest. Only Open Air rooms are listed."),
            h("a", { href: "/login", class: "button" }, "Log in"),
            h("a", { href: "/signup", class: "button primary" }, "Sign up"),
          ]),
    );
  }

  function renderAlert() {
    clear(alert);
    if (store.get().roomsStatus === "error") {
      alert.append(
        "Couldn't load rooms. Check your connection. ",
        h(
          "button",
          {
            type: "button",
            class: "link",
            on: {
              click: () => {
                void sync.reload();
                unread.refresh();
              },
            },
            signal: scope.signal,
          },
          "Retry",
        ),
      );
    } else {
      alert.append(actionError);
    }
  }

  const title = (r: Room) => roomTitle(r, store.get().user);

  async function act(label: string, room: Room, fn: () => Promise<void>) {
    try {
      await fn();
      actionError = "";
    } catch (e) {
      // Say why: network trouble, rate limiting or the server's reason (QA BUG-39).
      actionError = `Couldn't ${label} “${room.kind === "dm" ? title(room) : room.name}”. ${errorMessage(e)}`;
    }
    if (scope.active) renderAlert();
  }

  function toggleSearch(open: boolean) {
    if (open === !!search) return;
    search = open
      ? createUserSearch({
          // Not those who take no direct messages (§16.7). "ann@b.example" is someone on a linked instance (§33.5).
          search: async (q, signal) => {
            if (!isAddress(q)) return (await api.searchUsers(q, signal)).filter((u) => !u.no_dms);
            try {
              return [await api.remoteUser(q)];
            } catch (e) {
              throw new SearchError(reasonOf(e));
            }
          },
          avatarUrl: api.avatarUrl,
          onPick: (u) => void message(u),
          onClose: () => {
            toggleSearch(false);
            nav.querySelector<HTMLElement>("button.new-dm")?.focus();
          },
          signal: scope.signal,
        })
      : null;
    render();
    search?.focus();
  }

  function toggleNewRoom(open: boolean) {
    if (open === creating) return;
    creating = open;
    if (!open) newRoom.reset();
    render();
    if (open) newRoom.input.focus();
    else nav.querySelector<HTMLElement>("button.new-room-toggle")?.focus();
  }

  /** "+" in Collections (§31): the new-collection dialog, from the collections' chunk. */
  function newCollection(opener: HTMLElement) {
    collectionChunk().then(
      (c) =>
        scope.active &&
        void c.openCreate({
          ...chunkContext({ api, store, collections }),
          signal: scope.signal,
          opener,
          onCreated: (cid) => navigate(`/c/${cid}`),
        }),
      () => {
        actionError = "Couldn't open collections. Check your connection.";
        if (scope.active) renderAlert();
      },
    );
  }

  /** A collection's row (§31): yours (a lock when private), or one you follow with whose it is and what is new. */
  function collectionRow(c: Collection): HTMLElement {
    const current = store.get().activeCollectionId === c.id;
    const n = c.owner ? (c.new ?? 0) : 0;
    const sig = [c.name, c.public, c.owner?.name, n, current];
    const hit = collRows.get(c.id);
    if (hit?.sig.every((v, i) => v === sig[i])) return hit.el;
    const el = h(
      "li",
      { dataset: { collectionId: c.id } },
      h("a", { href: `/c/${c.id}`, class: n ? "unread" : "", "aria-current": current ? "page" : null }, [
        collectionIcon(),
        h("span", {}, c.name),
        c.owner ? h("span", { class: "owner" }, c.owner.name) : null,
        c.public ? null : visibilityMark("private"),
        n ? h("span", { class: "badge" }, [n > 99 ? "99+" : n, h("span", { class: "visually-hidden" }, " new")]) : null,
      ]),
    );
    collRows.set(c.id, { sig, el });
    return el;
  }

  async function message(user: User) {
    try {
      const room = await actions.openDm(user.id);
      actionError = "";
      if (!scope.active) return;
      toggleSearch(false);
      navigate(`/r/${room.id}`);
    } catch (e) {
      actionError = `Couldn't open the conversation with “${user.name}”. ${errorMessage(e)}`;
    }
    if (scope.active) renderAlert();
  }

  const unhide = (r: Room) => act("unhide", r, () => actions.unhide(r.id));
  const setArchived = (r: Room, archived: boolean) => act(archived ? "archive" : "unarchive", r, () => actions.setArchived(r.id, archived));

  // ---- rendering ----

  /**
   * A hidden or archived room's button: Unhide, else Unarchive for its owner. Everything else (Hide, Archive, Close
   * conversation) is in the room's own menu; the list has no per-row menus.
   */
  function rowAction(r: Room, section: Section): MenuItem | null {
    if (guest() || section === "rooms" || section === "dms") return null;
    // An archived room you had hidden is listed under Archived; it can still be unhidden from there.
    if (section === "hidden" || store.get().hidden.has(r.id)) return { label: "Unhide", run: () => void unhide(r) };
    if (r.created_by === store.get().user?.id) return { label: "Unarchive", run: () => void setArchived(r, false) };
    return null;
  }

  /**
   * A room's row. Rows are kept and reused while everything they show is the same (rooms are replaced, never mutated,
   * in the store): a message in some room changes one badge, not all the rows (§18.4).
   */
  function roomRow(r: Room, section: Section): HTMLElement {
    const s = store.get();
    const current = s.activeRoomId === r.id;
    const n = unreadCount(s, r);
    // What the row and its button depend on (rowAction reads the user and, when archived, hidden).
    const sig = [r, section, n, current, s.user, section === "archived" && s.hidden.has(r.id)];
    const hit = rows.get(r.id);
    if (hit?.sig.every((v, i) => v === sig[i])) return hit.el;
    const other = r.kind === "dm" ? otherMember(r, s.user) : undefined;
    const one = rowAction(r, section);
    const label = [
      other ? avatar(other, 24, api.avatarUrl) : null,
      h("span", {}, other ? other.name : r.kind === "dm" ? title(r) : r.name),
      r.kind === "dm" ? null : visibilityMark(visibilityOf(r)),
      n ? h("span", { class: "badge" }, [n > 99 ? "99+" : n, h("span", { class: "visually-hidden" }, " unread")]) : null,
    ];
    const el = h("li", { class: r.kind === "dm" ? "dm" : "", dataset: { roomId: r.id } }, [
      h("a", { href: `/r/${r.id}`, class: n ? "unread" : "", "aria-current": current ? "page" : null }, label),
      one
        ? h(
            "button",
            { type: "button", class: "row-action", "aria-label": `${one.label} ${r.name}`, on: { click: one.run }, signal: scope.signal },
            one.label,
          )
        : null,
    ]);
    rows.set(r.id, { sig, el });
    return el;
  }

  /** Hidden & archived (§7.1): folded, with how many there are; inside, a part for each. */
  function collapsible() {
    const count = h("span", { class: "count" });
    const summary = h("summary", { class: "ic i-chev" }, [h("span", {}, "Hidden & archived"), count]);
    const part = (section: "hidden" | "archived", title: string, icon: string) => {
      const list = h("ul");
      const el = h("div", { class: "more-part", dataset: { section } }, [h("h3", { class: `ic ${icon}` }, title), list]);
      return { el, list };
    };
    const hidden = part("hidden", "Hidden", "i-eyeoff");
    const archived = part("archived", "Archived", "i-archive");
    const empty = h("p", { class: "empty" }, "Nothing hidden or archived");
    const body = h("div", { class: "more-body" });
    const el = h(
      "details",
      {
        class: "room-section",
        dataset: { section: "more" },
        open: moreOpen,
        on: { toggle: (e) => (moreOpen = (e.currentTarget as HTMLDetailsElement).open) },
        signal: scope.signal,
      },
      [summary, body],
    );
    return { el, count, body, empty, hidden, archived };
  }

  /**
   * The list's sections, built once per mount and then only updated (the rows in them are reused too, see roomRow):
   * the room list is redrawn on every unread change, so for every message in any room.
   */
  function skeleton() {
    const newRoomToggle = h("button", {
      type: "button",
      class: "icon-button ic i-plus new-room-toggle",
      "aria-label": "New room",
      title: "New room",
      on: { click: () => toggleNewRoom(!creating) },
      signal: scope.signal,
    });
    const newDm = h("button", {
      type: "button",
      class: "icon-button ic i-plus new-dm",
      "aria-label": "New message",
      title: "New message",
      on: { click: () => toggleSearch(!search) },
      signal: scope.signal,
    });
    const newColl = h("button", {
      type: "button",
      class: "icon-button ic i-plus new-coll",
      "aria-label": "New collection",
      title: "New collection",
      "aria-haspopup": "dialog",
      on: { click: () => newCollection(newColl) },
      signal: scope.signal,
    });
    // A section's heading folds it: then only its unread rows and the open one stay listed.
    const head = (section: string, title: string, add: HTMLElement) =>
      h("div", { class: "section-head" }, [
        h(
          "h2",
          {},
          h(
            "button",
            {
              type: "button",
              class: "fold ic i-chev",
              dataset: { fold: section },
              on: {
                click: () => {
                  if (!folded.delete(section)) folded.add(section);
                  try {
                    localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]));
                  } catch {}
                  render();
                },
              },
              signal: scope.signal,
            },
            title,
          ),
        ),
        add,
      ]);
    return {
      newRoomToggle,
      newDm,
      main: h("div", { class: "room-section", dataset: { section: "rooms" } }),
      mainHead: head("rooms", "Rooms", newRoomToggle),
      rooms: h("ul"),
      empty: h("p", { class: "empty" }),
      direct: h("div", { class: "room-section", dataset: { section: "dms" } }),
      directHead: head("dms", "Direct messages", newDm),
      dms: h("ul"),
      newColl,
      collHead: head("collections", "Collections", newColl),
      colls: h("div", { class: "room-section", dataset: { section: "collections" } }),
      collList: h("ul"),
      more: collapsible(),
    };
  }

  function render() {
    if (!scope.active) return;
    if (guest()) return renderGuest();
    const s = store.get();
    const { rooms, dms, hidden, archived } = roomSections(s);
    const loading = s.roomsStatus === "idle" || s.roomsStatus === "loading";
    // Rows whose room changed are rebuilt; the focused control, when it is kept, gets its focus back below.
    const focused = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
    shell.setAttribute("aria-busy", String(loading));
    const p = parts;
    const keep = (r: Room) => unreadCount(s, r) || s.activeRoomId === r.id;
    const shown = <T>(section: string, list: T[], keep: (x: T) => unknown) => (folded.has(section) ? list.filter(keep) : list);
    p.newRoomToggle.setAttribute("aria-expanded", String(creating));
    reconcile(
      p.rooms,
      shown("rooms", rooms, keep).map((r) => roomRow(r, "rooms")),
    );
    // Rooms you hid (or that were archived) are still there, under their own sections (QA BUG-44).
    p.empty.textContent =
      hidden.length || archived.length
        ? "No other rooms. Hidden and archived ones are listed below."
        : "No rooms yet. Create the first one.";
    const mainList = rooms.length ? p.rooms : s.roomsStatus === "ready" ? p.empty : null;
    reconcile(
      p.main,
      [p.mainHead, creating ? newRoom.form : null, mainList].filter((n) => n !== null),
    );
    p.newDm.setAttribute("aria-expanded", String(!!search));
    reconcile(
      p.dms,
      shown("dms", dms, keep).map((r) => roomRow(r, "dms")),
    );
    reconcile(
      p.direct,
      [p.directHead, search?.el ?? null, dms.length ? p.dms : null].filter((n) => n !== null),
    );
    const c = s.collections;
    const all = c ? [...c.mine, ...c.subs] : [];
    reconcile(p.collList, shown("collections", all, (x) => (x.owner && x.new) || s.activeCollectionId === x.id).map(collectionRow));
    for (const id of collRows.keys()) if (!all.some((x) => x.id === id)) collRows.delete(id);
    reconcile(
      p.colls,
      [p.collHead, all.length ? p.collList : null].filter((n) => n !== null),
    );
    const m = p.more;
    m.count.textContent = String(hidden.length + archived.length);
    for (const [section, list] of [
      ["hidden", hidden],
      ["archived", archived],
    ] as const)
      reconcile(
        m[section].list,
        list.map((r) => roomRow(r, section)),
      );
    reconcile(
      m.body,
      [
        hidden.length ? m.hidden.el : null,
        archived.length ? m.archived.el : null,
        hidden.length || archived.length ? null : m.empty,
      ].filter((n) => n !== null),
    );
    reconcile(nav, [p.main, p.direct, p.colls, m.el]);
    for (const b of nav.querySelectorAll<HTMLElement>("[data-fold]"))
      b.setAttribute("aria-expanded", String(!folded.has(b.dataset.fold as string)));
    if (focused?.isConnected && document.activeElement !== focused) focused.focus();
    forget();
  }

  /** Drop the rows of rooms no longer listed. */
  function forget() {
    for (const [id, row] of rows) if (!nav.contains(row.el)) rows.delete(id);
  }

  /** A guest's list (§23.3): the Open Air rooms, which are all the server gives them. */
  function renderGuest() {
    const s = store.get();
    const { rooms } = roomSections(s);
    const loading = s.roomsStatus === "idle" || s.roomsStatus === "loading";
    shell.setAttribute("aria-busy", String(loading));
    nav.replaceChildren(
      h("div", { class: "room-section", dataset: { section: "rooms" } }, [
        h("div", { class: "section-head" }, h("h2", { class: "section-title" }, "Open Air rooms")),
        rooms.length
          ? h(
              "ul",
              {},
              rooms.map((r) => roomRow(r, "rooms")),
            )
          : s.roomsStatus === "ready"
            ? h("p", { class: "empty" }, "No Open Air rooms yet. Log in to see the others.")
            : null,
      ]),
    );
    forget();
  }

  function newRoomForm(): typeof newRoom {
    const inputId = `${id}-name`;
    const errId = `${inputId}-error`;
    const err = h("p", { id: errId, class: "field-error" });
    const input = h("input", {
      id: inputId,
      name: "name",
      required: true,
      // No `maxlength`: it counts UTF-16 units (an emoji is 2), the server counts characters. Checked on submit.
      autocomplete: "off",
      placeholder: "room-name",
      "aria-describedby": errId,
    });
    const submit = h("button", { type: "submit" }, "Create room");
    // Who can see it (§23.1): public unless chosen otherwise; members of a private room are added from the room.
    const hint = h("p", { class: "hint" });
    const choices = (["public", "private", "open"] as const).map((v) =>
      h("input", { type: "radio", name: "visibility", value: v, class: "visually-hidden" }),
    );
    const chosen = () => (choices.find((c) => c.checked)?.value ?? "public") as Visibility;
    const showHint = () => {
      hint.textContent = VISIBILITY[chosen()].hint;
    };
    const choose = (v: Visibility) => {
      for (const c of choices) c.checked = c.value === v;
      showHint();
    };
    const seg = h("fieldset", { class: "seg", on: { change: showHint }, signal: scope.signal }, [
      h("legend", { class: "visually-hidden" }, "Who can see it"),
      ...choices.map((c) =>
        h("label", { class: c.value === "public" ? "" : `ic ${c.value === "private" ? "i-lock" : "i-globe"}` }, [
          c,
          VISIBILITY[c.value as Visibility].label,
        ]),
      ),
    ]);
    choose("public");
    const setError = (msg: string) => {
      err.textContent = msg;
      if (msg) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
    };
    const form = h(
      "form",
      {
        class: "new-room",
        on: {
          keydown: (e) => {
            if (e.key === "Escape") toggleNewRoom(false);
          },
          submit: async (e) => {
            e.preventDefault();
            if (submit.disabled) return;
            if (textLength(input.value.trim()) > LIMITS.roomName) {
              setError(`Must be no more than ${LIMITS.roomName} characters.`);
              return;
            }
            submit.disabled = true;
            setError("");
            try {
              const room = await actions.create(input.value, chosen());
              if (!scope.active) return;
              toggleNewRoom(false);
              navigate(`/r/${room.id}`);
            } catch (e) {
              if (scope.active) setError(nameError(e));
            } finally {
              submit.disabled = false;
            }
          },
        },
        signal: scope.signal,
      },
      [
        h("label", { class: "name-field" }, [
          h("span", { "aria-hidden": "true" }, "#"),
          h("span", { class: "visually-hidden" }, "Room name"),
          input,
        ]),
        err,
        seg,
        hint,
        h("div", { class: "form-buttons" }, [
          h("button", { type: "button", class: "cancel", on: { click: () => toggleNewRoom(false) }, signal: scope.signal }, "Cancel"),
          submit,
        ]),
      ],
    );
    return {
      form,
      input,
      reset() {
        input.value = "";
        choose("public");
        setError("");
      },
    };
  }

  return {
    mount(el) {
      root = el;
      scope = createScope();
      rows.clear();
      search = null;
      creating = false;
      collRows.clear();
      newRoom = newRoomForm();
      parts = skeleton();
      drawn = [];
      renderEnds();
      shell.replaceChildren(top, alert, nav, foot);
      clear(root);
      root.append(shell);

      scope.defer(
        store.subscribe((s, prev) => {
          if (s.roomsStatus !== prev.roomsStatus) renderAlert();
          if (
            s.rooms !== prev.rooms ||
            s.hidden !== prev.hidden ||
            s.unread !== prev.unread ||
            s.activeRoomId !== prev.activeRoomId ||
            s.collections !== prev.collections ||
            s.activeCollectionId !== prev.activeCollectionId ||
            s.user !== prev.user ||
            s.roomsStatus !== prev.roomsStatus
          )
            render();
          if (s.site !== prev.site || s.user !== prev.user) renderEnds();
        }),
      );
      renderAlert();
      render();
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
