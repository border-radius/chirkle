// A collection's page (§31), /c/:id, next to the room list. Only this much is in app.js: the page itself, the save
// menu and the picker are a lazy chunk (views/collection/lazy.ts), loaded when one is first wanted, with their own
// stylesheet. What they need from app.js comes in their options.

import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import { formatFull, parsePb } from "../lib/time.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import * as S from "../strings/collection.ts";
import type * as Lazy from "./collection/lazy.ts";

/** The chunk, loaded once (a failed load is tried again next time). */
let chunk: Promise<typeof Lazy> | null = null;
export function collectionChunk(): Promise<typeof Lazy> {
  chunk ??= import("./collection/lazy.ts").catch((e: unknown) => {
    chunk = null;
    throw e;
  });
  return chunk;
}

/** What the chunk's parts get from the app: the API, the DOM helper, the collections in the store and their service. */
export function chunkContext({ api, store, collections }: Pick<Ctx, "api" | "store" | "collections">) {
  return {
    api,
    h,
    service: collections,
    me: () => store.get().user,
    list: () => store.get().collections,
    watch: (fn: () => void) => store.subscribe((s, prev) => s.collections !== prev.collections && fn()),
    when: (created: string) => formatFull(parsePb(created)),
  };
}

export function createCollectionView(ctx: Pick<Ctx, "api" | "store" | "collections" | "navigate">): View {
  const scope = createScope();
  let root: HTMLElement;
  return {
    mount(el, params) {
      root = el;
      const id = params.id ?? "";
      ctx.store.set({ activeCollectionId: id });
      const status = h("p", { class: "empty", role: "status" }, S.LOADING);
      el.replaceChildren(status);
      collectionChunk().then(
        (m) => {
          if (scope.active) void m.mountCollection(el, { ...chunkContext(ctx), id, navigate: ctx.navigate, signal: scope.signal });
        },
        () => {
          if (scope.active) status.textContent = S.COULDNT_OPEN_THE_COLLECTION_CHECK_YOUR;
        },
      );
    },
    unmount() {
      scope.dispose();
      ctx.store.set({ activeCollectionId: null });
      clear(root);
    },
  };
}
