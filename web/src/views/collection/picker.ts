// The picker the composer opens (§31): items of your collections and those you follow, to attach.

import type { CollectionItem } from "../../lib/types.ts";
import { type Base, icon, lists, loadStylesheet, pager, picture } from "./shared.ts";

export interface PickOptions extends Base {
  /** At most this many may be picked (what the message still has room for). */
  max: number;
  /** Attach these (Attach was pressed). */
  onPick: (items: CollectionItem[]) => void;
  opener: HTMLElement;
}

export async function openPicker(o: PickOptions): Promise<void> {
  const { h } = o;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const { mine, subs } = lists(o);
  const all = [...mine, ...subs];
  const title = h("h2", { id: "coll-pick-title" }, [icon(h), " Attach from collections"]);
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
  const row = h("div", { class: "coll-chips", role: "group", "aria-label": "Collection" }, chips);
  const grid = h("div", { class: "media-grid coll-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  const count = h("span", { class: "coll-count", "aria-live": "polite" });
  const attach = h("button", { type: "button", disabled: true, on: { click: () => done() }, signal }, "Attach");
  const body = h("div", { class: "coll-body" }, [grid, status]);
  const dialog = h("dialog", { class: "coll-dialog coll-pick", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "icon-button ic i-x", "aria-label": "Close", on: { click: () => close() }, signal }),
    ]),
    all.length ? row : null,
    body,
    h("footer", { class: "coll-foot" }, [count, attach]),
  ]);
  /** Picked, in the order they were. */
  const picked = new Map<string, CollectionItem>();
  let pages = pager(o, "", signal);

  function update() {
    count.textContent = picked.size
      ? `${picked.size} picked${picked.size >= o.max ? " (the most a message takes)" : ""}`
      : o.max
        ? ""
        : "The message has all the files it can take.";
    attach.disabled = !picked.size;
    attach.textContent = picked.size ? `Attach ${picked.size}` : "Attach";
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
      [picture(o, it, signal), it.video && h("span", { "aria-hidden": "true" }, "▶")],
    );
    return b;
  }

  async function more() {
    if (pages.done || !chosen) return;
    const p = pages;
    status.textContent = "Loading…";
    try {
      const got = await p.next();
      if (signal.aborted || p !== pages) return;
      grid.append(...got.map(tile));
      status.textContent = p.done && !p.items.length ? "Nothing in this collection yet." : "";
    } catch {
      if (signal.aborted || p !== pages) return;
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load the collection. ",
        h("button", { type: "button", class: "link", on: { click: () => void more() }, signal }, "Retry"),
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

  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  update();
  if (!all.length) {
    status.textContent = "You have no collections yet. Save images and videos from the chat to one first.";
    return;
  }
  show();
  chips[0]?.focus();
}
