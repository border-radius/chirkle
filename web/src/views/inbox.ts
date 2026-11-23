// "Mentions & replies" (§41), /inbox, next to the room list: the messages that mention you, the replies to your
// messages and the reactions to them, newest first, each a link to it in its room. What you hadn't seen is marked (not
// a mention or reply you have read in its room), and opening the page sees it. New ones come in at the top while it is open.
//
// A lazy chunk with its own stylesheet (styles/inbox.css), like the media grid (§30.2): app.ts import()s it for the
// route.

import type { Api } from "../api.ts";
import { h } from "../dom.ts";
import type { InboxItem, User } from "../lib/types.ts";
import type { AppState, Store } from "../store.ts";
import * as S from "../strings/inbox.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const INBOX_CSS: string;

export interface InboxOptions {
  api: Api;
  store: Store<AppState>;
  /** A user's avatar at 32 px. */
  avatar: (u: User) => HTMLElement;
  /** How a room is named: "#name", or a DM's other member. "" when it isn't one you have. */
  roomName: (id: string) => string;
  /** When, for people: "Today 10:42", "Oct 10". */
  when: (created: string) => string;
  signal: AbortSignal;
}

interface Page {
  items: InboxItem[];
  more: boolean;
  seen_at: string;
}

let sheet: Promise<void> | null = null;
function loadStylesheet(): Promise<void> {
  sheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      sheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: INBOX_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return sheet;
}

/** What a row says happened, after who did it. */
function what(item: InboxItem, room: string): string {
  const where = room ? S.inRoom(room) : "";
  if (item.kind === "reaction") return S.reactedToYourMessage(item.emoji, where);
  return item.kind === "reply" ? S.repliedToYou(where) : S.mentionedYou(where);
}

/** A message's words on one line, or what it has instead. */
const words = (m: { text: string; files: number }) =>
  m.text || (m.files ? (m.files === 1 ? S.ATTACHMENT : S.attachments(m.files)) : S.MESSAGE_DELETED);

export async function mountInbox(root: HTMLElement, o: InboxOptions): Promise<void> {
  const { api, store, signal } = o;
  await loadStylesheet();
  if (signal.aborted) return;

  const list = h("ul", { class: "inbox-list" });
  const status = h("p", { class: "inbox-status", role: "status" }, S.LOADING);
  const more = h("button", { type: "button", class: "inbox-more", hidden: true }, S.SHOW_OLDER);
  root.replaceChildren(
    h("section", { class: "inbox", "aria-labelledby": "inbox-title" }, [
      h("header", { class: "room-header" }, [
        h("a", { href: "/", class: "back ic i-back", "aria-label": S.BACK_TO_ROOMS }),
        h("h1", { id: "inbox-title" }, S.MENTIONS_REPLIES),
      ]),
      list,
      status,
      more,
    ]),
  );
  // The sidebar's row says you are here (it isn't drawn again for a page that isn't a room's).
  const rows = () => document.querySelectorAll('a[href="/inbox"]');
  for (const a of rows()) a.setAttribute("aria-current", "page");
  signal.addEventListener("abort", () => {
    for (const a of rows()) a.removeAttribute("aria-current");
  });

  /** Seen before this visit: newer ones are marked new. */
  let seenAt: string | null = null;
  let shown: InboxItem[] = [];
  let cursor = "";
  let loading = false;

  const fetchPage = (before = "") => api.request<Page>("/api/chat/inbox", { query: before ? { before } : {}, signal });

  function row(item: InboxItem): HTMLElement {
    const room = o.roomName(item.room);
    return h(
      "li",
      { class: seenAt !== null && item.created > seenAt && !item.read ? "new" : "" },
      h("a", { href: `/r/${item.room}/m/${item.message.id}` }, [
        o.avatar(item.actor),
        h("div", { class: "inbox-body" }, [
          h("p", { class: "inbox-what" }, [
            h("strong", {}, item.actor.name),
            what(item, room),
            h("time", { dateTime: item.created }, o.when(item.created)),
          ]),
          item.quote ? h("p", { class: "inbox-quote" }, words(item.quote)) : null,
          h("p", { class: "inbox-text" }, words(item.message)),
        ]),
      ]),
    );
  }

  function render() {
    list.replaceChildren(...shown.map(row));
    status.textContent = shown.length ? "" : S.NOTHING_HERE_YET_WHEN_SOMEONE_MENTIONS;
    more.hidden = !cursor;
  }

  /** You have seen everything listed: the server and the sidebar's count hear of it. */
  function seeAll() {
    const newest = shown[0]?.created;
    if (newest && (seenAt === null || newest > seenAt || store.get().inbox)) {
      store.set({ inbox: 0, inboxFrom: [] });
      void api.request("/api/chat/inbox/seen", { method: "POST", body: { at: newest } }).catch(() => {});
    }
  }

  async function load(first: boolean) {
    if (loading) return;
    loading = true;
    try {
      const page = await fetchPage(first ? "" : cursor);
      if (signal.aborted) return;
      seenAt ??= page.seen_at;
      if (first) shown = page.items;
      else shown = [...shown, ...page.items.filter((i) => !shown.some((s) => s.id === i.id))];
      // Paging from the top again keeps how far "Show older" had got.
      if (!first || !cursor || !shown.length) cursor = page.more ? (page.items.at(-1)?.cursor ?? "") : "";
      render();
      seeAll();
    } catch {
      if (!signal.aborted) status.textContent = S.COULDNT_LOAD_YOUR_MENTIONS_AND_REPLIES;
    } finally {
      loading = false;
    }
  }

  more.addEventListener("click", () => void load(false), { signal });
  // A row taken away while you look (its message deleted, the mention edited out, the reaction taken back) goes, rather
  // than leading to a message that isn't there (QA BUG-254).
  api
    .subscribeInbox((ev) => {
      if (signal.aborted || ev.action !== "delete" || !shown.some((i) => i.id === ev.id)) return;
      shown = shown.filter((i) => i.id !== ev.id);
      render();
    })
    .then(
      (stop) => {
        if (signal.aborted) void stop().catch(() => {});
        else signal.addEventListener("abort", () => void stop().catch(() => {}), { once: true });
      },
      () => {}, // offline: the list is fetched again when something new comes
    );
  // Something new (or taken back) while you look: the top again.
  signal.addEventListener(
    "abort",
    store.subscribe((s, prev) => s.inbox > prev.inbox && void load(true)),
    { once: true },
  );
  await load(true);
}
