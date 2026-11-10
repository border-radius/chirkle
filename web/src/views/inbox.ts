// "Mentions & replies" (§41), /inbox, next to the room list: the messages that mention you, the replies to your
// messages and the reactions to them, newest first, each a link to it in its room. What you hadn't seen is marked, and
// opening the page sees it. New ones come in at the top while it is open.
//
// A lazy chunk with its own stylesheet (styles/inbox.css), like the media grid (§30.2): app.ts import()s it for the
// route. It imports types only; what it needs from app.js comes in its options.

import type { Api } from "../api.ts";
import type { h as H } from "../dom.ts";
import type { InboxItem, User } from "../lib/types.ts";
import type { AppState, Store } from "../store.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const INBOX_CSS: string;

export interface InboxOptions {
  api: Api;
  h: typeof H;
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
function loadStylesheet(h: typeof H): Promise<void> {
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
  const where = room ? ` in ${room}` : "";
  if (item.kind === "reaction") return ` reacted ${item.emoji} to your message${where}`;
  return item.kind === "reply" ? ` replied to you${where}` : ` mentioned you${where}`;
}

/** A message's words on one line, or what it has instead. */
const words = (m: { text: string; files: number }) =>
  m.text || (m.files ? (m.files === 1 ? "Attachment" : `${m.files} attachments`) : "Message deleted");

export async function mountInbox(root: HTMLElement, o: InboxOptions): Promise<void> {
  const { api, h, store, signal } = o;
  await loadStylesheet(h);
  if (signal.aborted) return;

  const list = h("ul", { class: "inbox-list" });
  const status = h("p", { class: "inbox-status", role: "status" }, "Loading…");
  const more = h("button", { type: "button", class: "inbox-more", hidden: true }, "Show older");
  root.replaceChildren(
    h("section", { class: "inbox", "aria-labelledby": "inbox-title" }, [
      h("header", { class: "room-header" }, [
        h("a", { href: "/", class: "back ic i-back", "aria-label": "Back to rooms" }),
        h("h1", { id: "inbox-title" }, "Mentions & replies"),
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
      { class: seenAt !== null && item.created > seenAt ? "new" : "" },
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
    status.textContent = shown.length
      ? ""
      : "Nothing here yet. When someone mentions you, replies to you or reacts to your message, it shows here.";
    more.hidden = !cursor;
  }

  /** You have seen everything listed: the server and the sidebar's count hear of it. */
  function seeAll() {
    const newest = shown[0]?.created;
    if (newest && (seenAt === null || newest > seenAt || store.get().inbox)) {
      store.set({ inbox: 0 });
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
      if (!signal.aborted) status.textContent = "Couldn't load your mentions and replies. Check your connection.";
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
