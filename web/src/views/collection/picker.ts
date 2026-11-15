// The picker the composer opens (§31): items of your collections and those you follow, to attach.

import { h } from "../../dom.ts";
import type { CollectionItem } from "../../lib/types.ts";
import * as S from "../../strings/collection-picker.ts";
import { type Base, icon, lists, loadStylesheet, pager, picture } from "./shared.ts";

export interface PickOptions extends Base {
  /** At most this many may be picked (what the message still has room for). */
  max: number;
  /** Attach these (Attach was pressed). */
  onPick: (items: CollectionItem[]) => void;
  opener: HTMLElement;
}

export async function openPicker(o: PickOptions): Promise<void> {
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const { mine, subs } = lists(o);
  const all = [...mine, ...subs];
  const title = h("h2", { id: "coll-pick-title" }, [icon(), S.ATTACH_FROM_COLLECTIONS]);
  /** The collection shown: a row of chips, as the app's. */
  let chosen = all[0]?.id ?? "";
  const chips = all.map((c) =>
    h(
      "button",
      {
        type: "button",
        class: "coll-chip",
        "aria-pressed": String(c.id === chosen),
        on: { click: (e: Event) => choose(c.id, e.currentTarget as HTMLElement) },
        signal,
      },
      c.owner ? `${c.name} · ${c.owner.name}` : c.name,
    ),
  );
  const row = h("div", { class: "coll-chips", role: "group", "aria-label": S.COLLECTION }, chips);
  const grid = h("div", { class: "media-grid coll-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  const count = h("span", { class: "coll-count", "aria-live": "polite" });
  const attach = h("button", { type: "button", disabled: true, on: { click: () => done() }, signal }, S.ATTACH);
  const body = h("div", { class: "coll-body" }, [grid, status]);
  const dialog = h("dialog", { class: "coll-dialog coll-pick", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "icon-button ic i-x", "aria-label": S.CLOSE, on: { click: () => close() }, signal }),
    ]),
    all.length ? row : null,
    body,
    h("footer", { class: "coll-foot" }, [count, attach]),
  ]);
  /** Picked, in the order they were. */
  const picked = new Map<string, CollectionItem>();
  let pages = pager(o, "", signal);

  function update() {
    count.textContent = picked.size ? S.picked(picked.size, picked.size >= o.max) : o.max ? "" : S.THE_MESSAGE_HAS_ALL_THE_FILES;
    attach.disabled = !picked.size;
    attach.textContent = picked.size ? S.attach(picked.size) : S.ATTACH;
  }

  function tile(it: CollectionItem) {
    const b: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: "media-tile",
        "aria-label": `${it.name}${it.video ? ", video" : ""}`,
        title: it.name,
        "aria-pressed": String(picked.has(it.id)),
        on: {
          click: () => {
            if (picked.has(it.id)) picked.delete(it.id);
            else if (picked.size < o.max) picked.set(it.id, it);
            b.setAttribute("aria-pressed", String(picked.has(it.id)));
            update();
          },
        },
        signal,
      },
      [picture(o, it, signal), it.video && h("span", { class: "att-play", "aria-hidden": "true" })],
    );
    return b;
  }

  async function more() {
    if (pages.done || !chosen) return;
    const p = pages;
    status.textContent = S.LOADING;
    try {
      const got = await p.next();
      if (signal.aborted || p !== pages) return;
      grid.append(...got.map(tile));
      status.textContent = p.done && !p.items.length ? S.NOTHING_IN_THIS_COLLECTION_YET : "";
    } catch {
      if (signal.aborted || p !== pages) return;
      seen.unobserve(status);
      status.replaceChildren(
        S.COULDNT_LOAD_THE_COLLECTION,
        h("button", { type: "button", class: "link", on: { click: () => void more() }, signal }, S.RETRY),
      );
      return;
    }
    seen.unobserve(status);
    if (!p.done) seen.observe(status);
  }

  function show() {
    pages = pager(o, chosen, signal);
    grid.replaceChildren();
    void more();
  }

  function choose(id: string, chip: HTMLElement) {
    if (id === chosen) return;
    chosen = id;
    for (const c of chips) c.setAttribute("aria-pressed", String(c === chip));
    chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    show();
  }
  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { root: body, rootMargin: "400px" });

  function done() {
    const items = [...picked.values()];
    close();
    if (items.length) o.onPick(items);
  }

  function close() {
    if (signal.aborted) return;
    scope.abort();
    seen.disconnect();
    if (dialog.open) dialog.close();
    dialog.remove();
    o.opener.focus();
  }
  dialog.addEventListener("close", () => close(), { signal });

  await loadStylesheet();
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  update();
  if (!all.length) {
    status.textContent = S.YOU_HAVE_NO_COLLECTIONS_YET_SAVE;
    return;
  }
  show();
  chips[0]?.focus();
}
