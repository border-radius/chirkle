// A collection's page (/c/:id, §31): its items as a grid like the media grid's, newest first under month headings, what
// is new since you last looked highlighted.

import type { CollectionItem, Message } from "../../lib/types.ts";
import type { ViewerImage } from "../room/viewer.ts";
import { calls, type Meta } from "./calls.ts";
import { openSave } from "./save.ts";
import {
  ACCEPT,
  asMessage,
  type Base,
  changed,
  dateOf,
  icon,
  lists,
  loadStylesheet,
  MAX_BYTES,
  MEDIA,
  monthOf,
  pager,
  picture,
  reason,
} from "./shared.ts";

export interface PageOptions extends Base {
  id: string;
  navigate: (path: string) => void;
}

export async function mountCollection(root: HTMLElement, o: PageOptions): Promise<void> {
  const { h, api, signal, id } = o;
  const call = calls(api);
  const [, meta] = await Promise.all([
    loadStylesheet(h),
    call.get(id, signal).catch(() => null),
    (async () => {
      // Your subscription's `seen_at` decides what is new: wait for the store to have it (just after a reload).
      if (o.me() && !o.list()) {
        await changed(o, 2000);
      }
    })(),
  ]);
  if (signal.aborted) return;
  /** Not there (any more), or not yours to see. */
  function gone() {
    root.replaceChildren(
      h("section", { class: "collection not-found" }, [
        h("h1", {}, [icon(h), " This collection doesn't exist."]),
        h("p", {}, ["It may be private, or deleted. ", h("a", { href: "/" }, "Back to rooms")]),
      ]),
    );
  }
  if (!meta) return gone();
  let info: Meta = meta;
  const me = o.me();
  const mine = !!me && info.owner === me.id;
  const ownerName = meta.expand?.owner?.name ?? "";
  const seenAt = lists(o).subs.find((c) => c.id === id)?.seen_at ?? "";
  let pages = pager(o, id, signal);

  const heading = h("h1", { id: "coll-title" });
  const metaLine = h("p", { class: "coll-meta" });
  const actions = h("div", { class: "coll-actions" });
  const notice = h("p", { class: "coll-notice", role: "status" });
  const newLine = h("p", { class: "coll-new", hidden: true });
  const grid = h("div", { class: "media-grid coll-grid" });
  const status = h("p", { class: "media-status", role: "status" });
  root.replaceChildren(
    h("section", { class: "collection", "aria-labelledby": "coll-title" }, [
      h("header", { class: "coll-head" }, [
        h("a", { href: "/", class: "back", "aria-label": "Back to rooms" }, "← Rooms"),
        heading,
        metaLine,
        actions,
        notice,
      ]),
      newLine,
      grid,
      status,
    ]),
  );

  const fail = (what: string, e: unknown) => {
    notice.textContent = `Couldn't ${what}. ${reason(e)}`;
  };
  const btn = (label: string, run: () => unknown, cls = "") =>
    h("button", { type: "button", class: cls, on: { click: () => void run() }, signal }, label);
  const count = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
  const empty = () => (mine ? "Nothing here yet. Upload images and videos, or save them from the chat." : "Nothing here yet.");

  /** Files waiting to be uploaded (the owner's), one at a time; each comes in at the top once the store hears of it. */
  const queue: File[] = [];
  let sent = 0;
  let busy = false;
  let failed: string[] = [];
  const picker = h("input", {
    type: "file",
    multiple: true,
    accept: ACCEPT,
    hidden: true,
    on: {
      change: () => {
        upload([...(picker.files ?? [])]);
        picker.value = "";
      },
    },
    signal,
  });
  function upload(files: File[]) {
    for (const f of files) {
      if (!MEDIA.test(f.name)) failed.push(`${f.name}: not an image or video`);
      else if (f.size > MAX_BYTES) failed.push(`${f.name}: larger than 20 MB`);
      else queue.push(f);
    }
    if (busy) return;
    if (!queue.length) return report();
    busy = true;
    void (async () => {
      while (queue.length && !signal.aborted) {
        const f = queue[0]!;
        const at = `Uploading ${sent + 1} of ${sent + queue.length}…`;
        notice.textContent = at;
        try {
          await call.upload(id, f, (x) => (notice.textContent = `${at} ${Math.round(x * 100)}%`));
        } catch (e) {
          // Too many at once (the server's rate limit): wait, then the same one again.
          if ((e as { status?: number }).status === 429) {
            notice.textContent = "Waiting for the server…";
            await new Promise((r) => setTimeout(r, 10_000));
            continue;
          }
          failed.push(`${f.name}: ${reason(e)}`);
        }
        queue.shift();
        sent++;
        o.service.refresh();
      }
      sent = 0;
      busy = false;
      report();
    })();
  }
  /** After an upload: what didn't go, or nothing. */
  function report() {
    notice.textContent = failed.length ? `Couldn't upload ${failed.join("; ")}` : "";
    failed = [];
  }

  /** Renaming or confirming a delete: the actions stay as they are while the store changes. */
  let editing = false;
  /** The button that was pressed to edit (Rename or Delete): it gets focus back. */
  let back = "";
  /** What the actions were drawn for: they are drawn again only when that changes, so focus stays. */
  let drawn = "";
  function doneEditing() {
    editing = false;
    drawn = "";
    renderHead();
  }

  /** Saved: true. Refused: the reason is shown, and whatever was being edited stays. */
  async function change(patch: { name?: string; public?: boolean }): Promise<boolean> {
    try {
      info = { ...info, ...(await call.update(id, patch)) };
      notice.textContent = "";
      o.service.refresh();
      doneEditing();
      return true;
    } catch (e) {
      fail("save", e);
      return false;
    }
  }

  function renameForm() {
    editing = true;
    back = "Rename";
    const input = h("input", { value: info.name, "aria-label": "Collection name", autocomplete: "off" });
    const form = h(
      "form",
      {
        class: "coll-rename",
        on: {
          submit: (e) => {
            e.preventDefault();
            void change({ name: input.value });
          },
          keydown: (e) => e.key === "Escape" && doneEditing(),
        },
        signal,
      },
      [input, h("button", { type: "submit" }, "Save"), btn("Cancel", doneEditing, "link")],
    );
    actions.replaceChildren(form);
    input.focus();
    input.select();
  }

  function confirmDelete() {
    editing = true;
    back = "Delete";
    actions.replaceChildren(
      h("span", {}, `Delete “${info.name}”${info.items ? ` and its ${count(info.items)}` : ""}? This can't be undone.`),
      btn(
        "Delete collection",
        async () => {
          try {
            await call.remove(id);
            o.service.refresh();
            o.navigate("/");
          } catch (e) {
            fail("delete it", e);
          }
        },
        "danger",
      ),
      btn("Cancel", doneEditing, "link"),
    );
    actions.querySelector("button")?.focus();
  }

  function renderHead() {
    if (signal.aborted) return;
    heading.replaceChildren(icon(h), " ", info.name);
    metaLine.textContent = [mine ? "Yours" : ownerName && `By ${ownerName}`, info.public ? "Public" : "Private", count(info.items)]
      .filter(Boolean)
      .join(" · ");
    const following = lists(o).subs.some((c) => c.id === id);
    const key = [info.public, following].join();
    if (editing || key === drawn) return;
    drawn = key;
    const focused = [...actions.children].findIndex((c) => c.contains(document.activeElement));
    if (mine) {
      actions.replaceChildren(
        btn("Upload", () => picker.click()),
        btn("Rename", renameForm),
        btn(info.public ? "Make private" : "Make public", () => change({ public: !info.public })),
        btn("Delete", confirmDelete, "danger"),
      );
    } else if (me && (info.public || following)) {
      const b = btn(following ? "Unsubscribe" : "Subscribe", async () => {
        b.disabled = true;
        try {
          await call.follow(id, !following);
          o.service.refresh();
          await changed(o, 1000);
        } catch (e) {
          fail(following ? "unsubscribe" : "subscribe", e);
        }
        drawn = "";
        renderHead();
      });
      b.setAttribute("aria-pressed", String(following));
      actions.replaceChildren(b);
    } else actions.replaceChildren();
    const kids = [...actions.children] as HTMLElement[];
    if (focused >= 0) (kids.find((c) => back && c.textContent === back) ?? kids[focused])?.focus();
    back = "";
  }
  renderHead();
  if (mine) {
    root.firstElementChild!.append(picker);
    const files = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    root.addEventListener("dragover", (e) => files(e) && e.preventDefault(), { signal });
    root.addEventListener(
      "drop",
      (e) => {
        if (!files(e)) return;
        e.preventDefault();
        upload([...(e.dataTransfer?.files ?? [])]);
      },
      { signal },
    );
    // Pasted (Ctrl+V) anywhere on the page, unless a dialog (the viewer, a menu's) is open over it.
    document.addEventListener(
      "paste",
      (e) => {
        const pasted = [...(e.clipboardData?.files ?? [])];
        if (!pasted.length || document.querySelector("dialog[open]")) return;
        e.preventDefault();
        upload(pasted);
      },
      { signal },
    );
  }

  /** The newest item's `created` (or the collection's last_added), to send as seen once the tab is visible. */
  let unseen = "";
  function markSeen() {
    if (!unseen || document.visibilityState !== "visible" || !lists(o).subs.some((c) => c.id === id)) return;
    const at = unseen;
    unseen = "";
    // Not while the store is telling its listeners of a change: the badge goes with the next one.
    queueMicrotask(() => signal.aborted || o.service.seen(id, at));
  }
  document.addEventListener("visibilitychange", markSeen, { signal });

  /** The collection as the store has it (yours, or followed), last time: what changed since. */
  const listed = () => [...lists(o).mine, ...lists(o).subs].find((c) => c.id === id);
  let last = listed();
  function follow() {
    const c = listed();
    if (c) {
      info = { ...info, name: c.name, public: c.public, items: c.items };
      if (last && c.last_added !== last.last_added) void newer();
      // Some may have been taken out (the save menu, another tab): the gone ones leave the grid.
      if (last && c.items < last.items + (c.last_added !== last.last_added ? 1 : 0)) void prune();
      if (c.new) {
        unseen = c.last_added;
        markSeen();
      }
    } else if (last) {
      // Gone from the list: made private, deleted, or no longer followed.
      void call.get(id, signal).then(
        (m) => {
          info = { ...info, ...m };
          renderHead();
        },
        (e: { status?: number }) => e.status === 404 && gone(),
      );
    }
    last = c;
    renderHead();
  }
  signal.addEventListener("abort", o.watch(follow), { once: true });

  let month = "";
  let fresh = 0;
  /** An item's cell, at the end (a page of older ones) or at the top (`added`: new while the page is open). */
  function add(it: CollectionItem, added = false) {
    const mo = monthOf.format(dateOf(it.created));
    const isNew = added || (!!seenAt && it.created > seenAt);
    if (isNew && !added) fresh++;
    const label = `${it.name}${it.video ? ", video" : ""}${isNew ? ", new" : ""}`;
    const tile = h(
      "button",
      {
        type: "button",
        class: "media-tile",
        "aria-label": label,
        title: it.name,
        on: { click: () => void open(it, tile) },
        signal,
      },
      [picture(o, it, signal), it.video && h("span", { "aria-hidden": "true" }, "▶")],
    );
    const cell = h("div", { class: `coll-cell${isNew ? " new" : ""}`, dataset: { item: it.id } }, [tile]);
    if (me) {
      const save: HTMLButtonElement = h(
        "button",
        {
          type: "button",
          class: "att-save",
          "aria-label": `Save ${it.name} to collection`,
          title: "Save to collection",
          on: { click: () => openSave({ ...o, from: { item: it.id }, opener: save }) },
          signal,
        },
        icon(h),
      );
      cell.append(save);
    }
    if (mine) {
      cell.append(
        h(
          "button",
          {
            type: "button",
            class: "coll-remove",
            "aria-label": `Remove ${it.name} from the collection`,
            title: "Remove from collection",
            on: { click: () => void remove(it, cell) },
            signal,
          },
          "×",
        ),
      );
    }
    if (!added) {
      if (mo !== month) grid.append(h("h3", {}, mo));
      month = mo;
      grid.append(cell);
    } else if (grid.firstElementChild?.textContent === mo) grid.firstElementChild.after(cell);
    else {
      grid.prepend(h("h3", {}, mo), cell);
      month ||= mo;
    }
  }

  async function remove(it: CollectionItem, cell: HTMLElement) {
    try {
      await call.unsave(it.id);
    } catch (e) {
      return fail("remove it", e);
    }
    const cells = [...grid.querySelectorAll(".coll-cell")];
    const at = cells.indexOf(cell);
    const to = cells[at + 1] ?? cells[at - 1];
    drop(it);
    info = { ...info, items: Math.max(0, info.items - 1) };
    renderHead();
    // Focus stays in the grid (the next one's Remove), or goes to the actions once it is empty.
    (to?.querySelector<HTMLElement>(".coll-remove") ?? actions.querySelector("button"))?.focus();
    o.service.refresh();
  }

  /** An item no longer in the collection: its cell goes, and its month's heading when it was the last of it. */
  function drop(it: CollectionItem) {
    const at = pages.items.indexOf(it);
    if (at < 0) return;
    pages.items.splice(at, 1);
    const cell = [...grid.querySelectorAll<HTMLElement>(".coll-cell")].find((c) => c.dataset.item === it.id);
    if (cell) {
      const [before, after] = [cell.previousElementSibling, cell.nextElementSibling];
      if (cell.contains(document.activeElement)) (after?.querySelector<HTMLElement>("button") ?? actions.querySelector("button"))?.focus();
      cell.remove();
      if (before?.tagName === "H3" && (!after || after.tagName === "H3")) {
        before.remove();
        if (!after) month = "";
      }
    }
    if (pages.done && !pages.items.length) status.textContent = empty();
  }

  /** Taken out elsewhere (the save menu, another tab): those shown that are gone go from the grid. */
  let pruned = 0;
  async function prune() {
    const seq = ++pruned;
    const shown = [...pages.items];
    const oldest = shown.at(-1);
    const ids = oldest && (await call.idsSince(id, oldest, signal).catch(() => null));
    if (!ids || seq !== pruned || signal.aborted) return;
    for (const it of shown.filter((x) => !ids.has(x.id))) drop(it);
  }

  async function more() {
    const p = pages;
    if (p.done) return;
    status.textContent = "Loading…";
    try {
      const page = await p.next();
      if (signal.aborted || p !== pages) return;
      for (const it of page) add(it);
      status.textContent = p.done && !p.items.length ? empty() : "";
    } catch {
      if (signal.aborted || p !== pages) return;
      seen.unobserve(status);
      status.replaceChildren(
        "Couldn't load the collection. ",
        btn("Retry", () => void more(), "link"),
      );
      return;
    }
    seen.unobserve(status);
    if (!p.done) seen.observe(status);
  }

  /** From the start again (the page was empty, or more was added than a page holds). */
  function reset() {
    pages = pager(o, id, signal);
    grid.replaceChildren();
    month = "";
    return more();
  }

  /** Items added while the page is open: at the top, marked new. */
  async function newer() {
    const top = pages.items[0];
    if (!top) return reset();
    const got = await call.items(id, top, signal, true).catch(() => null);
    if (!got || signal.aborted) return;
    if (got.more) return reset();
    const shown = new Set(pages.items.map((x) => x.id));
    const added = got.items.filter((x) => !shown.has(x.id));
    pages.items.unshift(...added);
    for (const it of added.reverse()) add(it, true);
    if (added.length) status.textContent = "";
  }

  async function open(it: CollectionItem, opener: HTMLElement) {
    const images = (): ViewerImage[] => [...pages.items].reverse().map((x) => ({ message: asMessage(x), file: x.file, video: x.video }));
    const all = images();
    const p = pages;
    try {
      const { openViewer } = await import("../room/viewer.ts");
      if (signal.aborted) return;
      await openViewer({
        images: all,
        start: all.findIndex((x) => x.message.id === it.id),
        more: [!p.done, false],
        page: async (older) => {
          const got = older ? await p.next() : [];
          return { messages: got.map(asMessage).reverse(), done: !older || p.done };
        },
        media: (m) => [{ message: m, file: m.files![0]!, video: p.items.find((x) => x.id === m.id)?.video ?? false }],
        h,
        name: (m, f) => m.file_names?.[f] ?? f,
        when: (m) => `Added ${o.when(m.created)}`,
        fileUrl: (m, f) => api.itemUrl({ id: m.id, file: f }),
        refreshFileToken: () => api.fileToken(true),
        ...(me ? { onSave: (m: Message, _f: string, b: HTMLElement) => openSave({ ...o, from: { item: m.id }, opener: b }) } : {}),
        opener,
        follow: () => {},
        signal,
      });
    } catch {
      window.open(api.itemUrl(it), "_blank", "noopener");
    }
  }

  const seen = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && void more(), { rootMargin: "400px" });
  signal.addEventListener("abort", () => seen.disconnect(), { once: true });
  await more();
  if (signal.aborted) return;
  if (fresh) {
    newLine.hidden = false;
    newLine.textContent = `${fresh >= 60 ? "60+" : fresh} new since your last visit`;
  }
  // Seen once it is on screen in a visible tab: the sidebar's count goes.
  unseen = pages.items[0]?.created ?? "";
  markSeen();
}
