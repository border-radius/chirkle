// What the collections' chunk (lazy.ts) shares between its parts: the options every part gets, the stylesheet, and the
// helpers for tiles, pages of items and errors.

import type { Api } from "../../api.ts";
import type { CollectionsService } from "../../collections.ts";
import { h } from "../../dom.ts";
import type { CollectionItem, Collections, Message, User } from "../../lib/types.ts";
import { calls } from "./calls.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const COLLECTIONS_CSS: string;

export interface Base {
  api: Api;
  service: CollectionsService;
  me: () => User | null;
  /** Yours and those you follow, as the store has them: null until they are loaded. */
  list: () => Collections | null;
  /** Call `fn` when they change; returns the unsubscribe. */
  watch: (fn: () => void) => () => void;
  /** When an item was added, for the viewer. */
  when: (created: string) => string;
  signal: AbortSignal;
}

let stylesheet: Promise<void> | null = null;
export function loadStylesheet(): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: COLLECTIONS_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

/** What can be uploaded into a collection: the images and videos of lib/files.ts (not imported: app.js has it), at most 20 MB. */
export const MEDIA = /\.(jpe?g|png|gif|webp|avif|mp4|m4v|webm|mov|ogv)$/i;
export const ACCEPT = ".jpg,.jpeg,.png,.gif,.webp,.avif,.mp4,.m4v,.webm,.mov,.ogv";
export const MAX_BYTES = 20 * 1024 * 1024;

/** Yours and those you follow (none until they are loaded). */
export const lists = (o: Base): Collections => o.list() ?? { mine: [], subs: [] };

/** The next change of the collections in the store, or `ms` without one. */
export function changed(o: Base, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = o.watch(done);
    const timer = setTimeout(done, ms);
  });
}

/** Why a request failed, in words: the server's reason for a field when it gave one. */
export function reason(e: unknown): string {
  const err = e as { fields?: Record<string, string>; message?: string; status?: number };
  if (err?.status === 0) return "Can't reach the server. Check your connection.";
  return Object.values(err?.fields ?? {})[0] || err?.message || "Something went wrong.";
}

export const icon = () => h("span", { class: "ci", "aria-hidden": "true" });
export const monthOf = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
export const dateOf = (created: string) => new Date(created.replace(" ", "T"));

/** An item as the viewer takes it: a message of its own with one file. */
export function asMessage(it: CollectionItem): Message {
  const { id, created, file, name } = it;
  return {
    id,
    room: "",
    author: "",
    text: "",
    created,
    updated: created,
    edited_at: "",
    deleted: false,
    files: [file],
    file_names: { [file]: name },
  };
}

/** A square tile's picture: the grid thumbnail, a video's poster, or nothing (a plain tile with the play badge). */
export function picture(b: Base, it: CollectionItem, signal: AbortSignal): HTMLImageElement | null {
  if (it.video && !it.poster) return null;
  const img = h("img", {
    src: it.video ? b.api.itemPosterUrl(it) : b.api.itemUrl(it, "240x240"),
    alt: "",
    loading: "lazy",
    decoding: "async",
  });
  // A poster that fails leaves the plain tile.
  if (it.video) img.addEventListener("error", () => img.remove(), { signal });
  return img;
}

/** A collection's items a page at a time, newest first. */
export function pager(b: Base, collection: string, signal: AbortSignal) {
  const items: CollectionItem[] = [];
  let done = false;
  let loading: Promise<CollectionItem[]> | null = null;
  return {
    items,
    get done() {
      return done;
    },
    /** The next page (the same one while it loads); rejects when it fails. */
    next(): Promise<CollectionItem[]> {
      if (done) return Promise.resolve([]);
      loading ??= calls(b.api)
        .items(collection, items.at(-1), signal)
        .then(
          (page: { items: CollectionItem[]; more: boolean }) => {
            loading = null;
            done = !page.more;
            items.push(...page.items);
            return page.items;
          },
          (e: unknown) => {
            loading = null;
            throw e;
          },
        );
      return loading!;
    },
  };
}
