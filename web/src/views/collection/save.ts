// The save menu (§31): which of your collections have a file; tick to add, untick to take out, or make a new one.

import type { Collection } from "../../lib/types.ts";
import type { From } from "./calls.ts";
import { calls } from "./calls.ts";
import { type Base, icon, lists, loadStylesheet, reason } from "./shared.ts";

export interface SaveOptions extends Base {
  from: From;
  /** Gets focus back on close. */
  opener: HTMLElement;
}

/** One save menu at a time. */
let saving: (() => void) | null = null;

export async function openSave(o: SaveOptions): Promise<void> {
  saving?.();
  const { h } = o;
  const call = calls(o.api);
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const title = h("h2", { id: "coll-save-title" }, [icon(h), " Save to collection"]);
  const list = h("ul", { class: "coll-choices" });
  const status = h("p", { class: "coll-status", role: "status" }, "Loading…");
  const input = h("input", { placeholder: "New collection", "aria-label": "New collection name", autocomplete: "off" });
  const form = h(
    "form",
    {
      class: "coll-new-form",
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          try {
            const id = (await call.create(o.me()?.id ?? "", input.value, false)).id;
            input.value = "";
            await toggle(id, true);
          } catch (err) {
            status.textContent = reason(err);
          }
        },
      },
      signal,
    },
    [input, h("button", { type: "submit" }, "Create")],
  );
  const dialog = h("dialog", { class: "coll-dialog coll-save", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "link", "aria-label": "Close", on: { click: () => close() }, signal }, "×"),
    ]),
    h("div", { class: "coll-body" }, [list, status, form]),
  ]);
  /** Collection id → the item there (ticked). */
  let saved: Record<string, string> = {};
  /** Collection id → ticked or unticked, while that is saving. */
  const busy = new Map<string, boolean>();

  async function toggle(id: string, on: boolean) {
    busy.set(id, on);
    status.textContent = on ? "Saving…" : "Removing…";
    render();
    try {
      if (on) saved[id] = (await call.save(id, o.from)).id;
      else if (saved[id]) {
        await call.unsave(saved[id]);
        delete saved[id];
      }
      status.textContent = on ? "Saved." : "Removed.";
      o.service.refresh();
    } catch (e) {
      // In there already (another tab): it is ticked.
      if ((e as { status?: number }).status === 409) saved = await call.savedIn(o.from, signal).catch(() => saved);
      else status.textContent = reason(e);
    }
    busy.delete(id);
    render();
  }

  function render() {
    const mine = lists(o).mine;
    list.replaceChildren(
      ...mine.map((c: Collection) => {
        const box = h("input", { type: "checkbox", checked: busy.get(c.id) ?? !!saved[c.id], disabled: busy.has(c.id) });
        box.addEventListener("change", () => void toggle(c.id, box.checked), { signal });
        // Saving copies the file on the server, which can take a while: a spinner on the row until it is done.
        return h(
          "li",
          { "aria-busy": busy.has(c.id) ? "true" : "false" },
          h("label", {}, [
            box,
            " ",
            c.name,
            h("span", { class: "coll-meta" }, c.public ? " · Public: anyone can see it" : " · Private"),
            busy.has(c.id) ? h("span", { class: "coll-spin", "aria-hidden": "true" }) : null,
          ]),
        );
      }),
    );
    if (!mine.length && status.textContent === "") status.textContent = "You have no collections yet. Make one:";
  }

  function close() {
    if (signal.aborted) return;
    scope.abort();
    saving = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    o.opener.setAttribute("aria-expanded", "false");
    o.opener.focus();
  }
  saving = close;
  dialog.addEventListener("close", () => close(), { signal });
  signal.addEventListener("abort", o.watch(render), { once: true });

  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  o.opener.setAttribute("aria-expanded", "true");
  try {
    saved = await call.savedIn(o.from, signal);
    status.textContent = "";
  } catch (e) {
    if (signal.aborted) return;
    status.textContent = reason(e);
  }
  render();
  (list.querySelector("input") ?? input).focus();
}
