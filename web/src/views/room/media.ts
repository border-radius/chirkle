// Media grid (§30): every image and video of a room (or DM), newest first, as square tiles under month headings, in a
// modal <dialog>, so one sent long ago is quick to find. Scrolling down fetches older ones. A tile opens the viewer
// (§17.7) over the grid, stepping through the same images; closing the viewer comes back to the grid, and "Show in
// chat" closes both. Like the viewer it adds a history entry (same URL), so Back closes it rather than leaving the room.
//
// Its pages come from GET /api/chat/media/{room} (§30.1): only the room's images and videos, from an index, not its
// messages. A video's tile is its poster frame, made by the server, or a plain tile with a play badge until there is one: never
// the video itself, which every browser would start fetching.
//
// A lazy chunk, like search (§29): the room view import()s it when the grid is first opened, and it links its own
// stylesheet (styles/media.css), so neither app.js nor app.css grows. It imports types only: what it needs from app.js
// comes in its options.

import type { Api } from "../../api.ts";
import type { h } from "../../dom.ts";
import type { MediaItem, Message, User } from "../../lib/types.ts";
import type { ViewerImage } from "./viewer.ts";

export interface MediaOptions {
  room: string;
  /** The room's name, in the title ("Media in #design"); none for a DM. */
  label?: string | undefined;
  api: Pick<Api, "media" | "fileUrl" | "posterUrl">;
  h: typeof h;
  /** What to call a file (`attachmentName`). */
  name: (m: Message, file: string) => string;
  /**
   * Show `m`'s `file` in the viewer (the room view's `viewImage`), stepping through `images` (oldest first); `more`:
   * the room has more before them (and none after). `leave` closes the grid ("Show in chat").
   */
  open: (m: Message, file: string, opener: HTMLElement, images: ViewerImage[], more: [boolean, boolean], leave: () => void) => unknown;
  /** Sets what is told of the room's messages that change or go, while it is open (the viewer's `follow`). */
  follow: (fn: ((m: Message, gone: boolean) => void) | undefined) => void;
  /** Ends it (the room view unmounts). */
  signal: AbortSignal;
}

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const MEDIA_CSS: string;

let stylesheet: Promise<void> | null = null;
/** Loaded once, like the viewer's: a failed load is tried again next time, and the grid opens anyway. */
function loadStylesheet(h: MediaOptions["h"]): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: MEDIA_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

/** Marks its history entry; new on every page load, like the viewer's. */
const ENTRY = `media-${Date.now()}-${Math.random()}`;
const onEntry = () => (history.state as { media?: unknown } | null)?.media === ENTRY;
/** A grid closed from itself went Back off its entry and the browser hasn't got there yet: a new one waits for it. */
let leaving: Promise<unknown> | null = null;
/** One grid at a time: the button again does nothing while one is open. */
let current = false;

export function openMedia(o: MediaOptions): void {
  if (current) return;
  current = true;
  const { h, api } = o;
  /** Gets focus back on close (the Media button). */
  const opener = document.activeElement as HTMLElement | null;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(false), { signal });

  const title = h("h2", { id: "media-title" }, o.label ? ["Media in ", h("span", { class: "hash" }, "#"), o.label] : "Media");
  const grid = h("div", { class: "media-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  const body = h("div", { class: "media-body" }, [grid, status]);
  const dialog = h("dialog", { class: "media", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", {
        type: "button",
        class: "icon-button ic i-x",
        "aria-label": "Close",
        autofocus: true,
        on: { click: () => close(true) },
        signal,
      }),
    ]),
    body,
  ]);

  /** What is shown, newest first, and the last one fetched (where older ones begin). */
  const items: (ViewerImage & { tile: HTMLElement })[] = [];
  let last: MediaItem | undefined;
  /** The messages they come from, as the viewer takes them, by id. */
  const messages = new Map<string, Message>();
  let done = false;
  let loading = false;
  let month = "";
  let closed = false;
  const monthOf = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

  /** The next page of older messages; scrolling near the end asks again until there are tiles below the fold. */
  async function more() {
    if (loading || done || closed) return;
    loading = true;
    status.textContent = "Loading…";
    try {
      const page = await api.media(o.room, last && { sent: last.sent, message: last.message, pos: last.pos }, signal);
      if (closed) return;
      done = !page.more;
      last = page.items.at(-1) ?? last;
      // Newest first, so a message's files last to first: reversed for the viewer, they are in their own order.
      for (const it of page.items) add(it);
      status.textContent = done ? (items.length ? "" : "No photos or videos here yet.") : "";
    } catch {
      if (closed) return;
      // Until Retry: observed again, the end (still in view) would ask again at once, over and over (QA BUG-116).
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load media. ",
        h("button", { type: "button", class: "link", on: { click: () => void more() }, signal }, "Retry"),
      );
      return;
    } finally {
      loading = false;
    }
    // Still at the end (a page with few or no media): the observer won't fire again by itself.
    seen.unobserve(status);
    if (!done && !closed) seen.observe(status);
  }

  /** The message an item comes from: what the viewer, "Show in chat" and the file's URL need of it. */
  function messageOf(it: MediaItem): Message {
    let m = messages.get(it.message);
    if (!m) {
      const { message: id, sent, author } = it;
      m = { id, room: o.room, author: author?.id ?? "", text: "", created: sent, updated: sent, edited_at: "", deleted: false };
      m.files = [];
      m.file_names = {};
      if (it.source !== id) m.forward_of = it.source; // its files are the original's (§21.3)
      if (author) m.expand = { author: author as User };
      messages.set(id, m);
    }
    m.files!.unshift(it.file);
    if (it.name) m.file_names![it.file] = it.name;
    return m;
  }

  function add(row: MediaItem) {
    const { file, video } = row;
    const m = messageOf(row);
    const d = new Date(m.created.replace(" ", "T"));
    const mo = monthOf.format(d);
    if (mo !== month) {
      month = mo;
      grid.append(h("h3", {}, mo));
    }
    const name = o.name(m, file);
    const src = () => (video ? api.posterUrl(m, file) : api.fileUrl(m, file, "240x240"));
    // A video without a poster (not made yet, or no ffmpeg on the server) is a plain tile with the play badge.
    const pic = (!video || row.poster) && h("img", { src: src(), alt: "", loading: "lazy", decoding: "async" });
    // A poster that fails leaves the plain tile.
    if (pic && video) pic.addEventListener("error", () => pic.remove(), { signal });
    const label = `${name}${video ? ", video" : ""}, ${m.expand?.author?.name ?? "Unknown"}, ${d.toLocaleDateString()}`;
    const tile: HTMLElement = h(
      "button",
      { type: "button", class: "media-tile", "aria-label": label, title: label, on: { click: () => open(item) }, signal },
      [pic, video && h("span", { class: "att-play", "aria-hidden": "true" })],
    );
    const item = { message: m, file, video, tile };
    items.push(item);
    grid.append(tile);
  }

  function open({ message, file, tile }: (typeof items)[number]) {
    const images = items.map(({ tile: _, ...i }) => i).reverse();
    o.open(message, file, tile, images, [!done, false], () => close(true, false));
  }

  /**
   * A message deleted meanwhile (or a forward whose original was): its tiles go, and a month left empty its heading.
   * Opened, they said "Couldn't load image" (QA BUG-244).
   */
  o.follow((m, gone) => {
    const has = new Set(gone || m.deleted ? [] : (m.files ?? []));
    for (const it of items.filter((i) => i.message.id === m.id && !has.has(i.file))) {
      items.splice(items.indexOf(it), 1);
      const heading = it.tile.previousElementSibling;
      it.tile.remove();
      if (heading?.tagName === "H3" && (!heading.nextElementSibling || heading.nextElementSibling.tagName === "H3")) heading.remove();
    }
    if (done && !items.length) status.textContent = "No photos or videos here yet.";
  });

  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), {
    root: body,
    rootMargin: "400px",
  });

  /**
   * `back`: closed from the grid itself (×, Escape) or from the viewer's "Show in chat": leave its history entry too.
   * Not when Back closed it, nor when leaving the room (that would undo the navigation). `refocus`: put focus back on
   * the button (not when going to a message: the viewer focuses its tile). The closed dialog stays in the page until
   * then: the router passes over a grid entry with no grid (QA BUG-118), and would go Back a second time.
   */
  function close(back: boolean, refocus = true) {
    if (closed) return;
    closed = true;
    current = false;
    scope.abort();
    seen.disconnect();
    o.follow(undefined);
    if (dialog.open) dialog.close();
    if (back) leaving = leave().finally(() => dialog.remove());
    else dialog.remove();
    if (refocus) opener?.focus();
  }

  const popped = () => new Promise((r) => window.addEventListener("popstate", r, { once: true }));
  const onViewer = () => !!(history.state as { viewer?: unknown } | null)?.viewer;

  /** Go Back off its entry; when the viewer is still on its way Back to it ("Show in chat"), once it has got there. */
  async function leave() {
    if (!onEntry() && onViewer()) await popped();
    if (!onEntry()) return;
    const gone = popped();
    history.back();
    await gone;
  }

  dialog.addEventListener("close", () => close(true), { signal });

  void (async () => {
    await Promise.all([loadStylesheet(h), leaving]);
    if (closed) return;
    if (!onEntry()) history.pushState({ media: ENTRY }, "");
    // Back left its entry (and not for the viewer's, which is pushed on top of it).
    window.addEventListener("popstate", () => !onEntry() && !onViewer() && close(false), { signal });
    document.body.append(dialog);
    dialog.showModal();
    seen.observe(status);
  })();
}
