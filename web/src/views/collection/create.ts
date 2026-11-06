// A new collection (§31): the sidebar's "+".

import { calls } from "./calls.ts";
import { type Base, icon, loadStylesheet, reason } from "./shared.ts";

export interface CreateOptions extends Base {
  opener: HTMLElement;
  /** Made: e.g. go to its page. */
  onCreated: (id: string) => void;
}

/** The sidebar's "+" (§31): a name, and whether anyone may see it. */
export async function openCreate(o: CreateOptions): Promise<void> {
  const { h } = o;
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => close(), { signal });
  const title = h("h2", { id: "coll-create-title" }, [icon(h), " New collection"]);
  const input = h("input", { required: true, autocomplete: "off", "aria-label": "Name", placeholder: "Name" });
  // A switch, as Settings' choices are.
  const pub = h("input", { type: "checkbox", role: "switch", class: "switch" });
  const err = h("p", { class: "coll-status", role: "alert" });
  const submit = h("button", { type: "submit", class: "primary" }, "Create");
  const form = h(
    "form",
    {
      class: "coll-body",
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (submit.disabled) return;
          submit.disabled = true;
          err.textContent = "";
          try {
            const { id } = await calls(o.api).create(o.me()?.id ?? "", input.value, pub.checked);
            o.service.refresh();
            close(false);
            o.onCreated(id);
          } catch (e) {
            err.textContent = reason(e);
          } finally {
            submit.disabled = false;
          }
        },
      },
      signal,
    },
    [
      h("p", { class: "coll-new-form" }, [input, submit]),
      h("label", { class: "coll-public" }, [pub, "Public: anyone can see it and subscribe"]),
      err,
    ],
  );
  const dialog = h("dialog", { class: "coll-dialog coll-create", "aria-labelledby": title.id }, [
    h("header", { class: "media-bar" }, [
      title,
      h("button", { type: "button", class: "icon-button ic i-x", "aria-label": "Close", on: { click: () => close() }, signal }),
    ]),
    form,
  ]);
  function close(refocus = true) {
    if (signal.aborted) return;
    scope.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    if (refocus) o.opener.focus();
  }
  dialog.addEventListener("close", () => close(), { signal });
  await loadStylesheet(h);
  if (signal.aborted) return;
  document.body.append(dialog);
  dialog.showModal();
  input.focus();
}
