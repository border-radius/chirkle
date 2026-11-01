// Selecting messages (§21.1): which ones are selected, and the bar shown instead of the composer meanwhile: how many,
// Forward, Delete (only when every one is yours, with a confirm step) and Cancel. Up to MAX_SELECTED at a time.

import { h } from "../../dom.ts";
import { MAX_SELECTED } from "../../lib/limits.ts";
import type { Message } from "../../lib/types.ts";
import type { Notice } from "./notice.ts";

const LIMIT_NOTICE = `You can select up to ${MAX_SELECTED} messages at a time.`;

export interface Selection {
  /** The bar to show in place of the composer while selecting. */
  readonly bar: HTMLElement;
  /** The selected messages, or null when not selecting. */
  readonly ids: ReadonlySet<string> | null;
  /** Select or unselect message `id`: the first one starts selecting, unselecting the last one stops. */
  toggle(id: string): void;
  /** Stop selecting; `focus`: put the caret back in the composer. */
  end(focus?: boolean): void;
  /**
   * Unselect messages that left the window or can't be selected any more (deleted meanwhile), and bring the bar up to
   * date. Called before each render of the list; with nothing left selected, selecting stops.
   */
  prune(): void;
  /** Bring the bar's count and buttons up to date. */
  refresh(): void;
  /** Escape: step back out of the delete confirm, or stop selecting. False when not selecting. */
  escape(): boolean;
}

export function createSelection(opts: {
  find: (id: string) => Message | undefined;
  selectable: (m: Message) => boolean;
  deletable: (m: Message) => boolean;
  /** Selecting started at message `id`. */
  onStart: (id: string) => void;
  /** Selecting started, changed or stopped: redraw the footer, and with `list`, the messages. */
  onChange: (list: boolean) => void;
  focusComposer: () => void;
  onForward: (ids: string[]) => void;
  /** Delete these messages (selecting has stopped by then). */
  onDelete: (ids: string[]) => void;
  notice: Notice;
  signal: AbortSignal;
}): Selection {
  const { notice, signal } = opts;
  let selected: Set<string> | null = null;
  /** The bar asks "Delete these messages?". */
  let confirming = false;

  const bar = h("div", { class: "selection-bar", role: "toolbar", "aria-label": "Selected messages" });
  const button = (label: string, run: () => void, cls = "") =>
    h("button", { type: "button", class: cls, on: { click: run }, signal }, label);
  const count = h("span", { class: "sel-count", role: "status" });
  const deleteBtn = button("Delete", () => setConfirm(true), "danger ic i-trash");
  const actions = [
    count,
    button("Forward", () => opts.onForward([...(selected ?? [])]), "primary ic i-fwd"),
    deleteBtn,
    button("Cancel", () => end(true)),
  ];
  const confirmText = h("span");
  const confirmActions = [
    confirmText,
    button(
      "Delete",
      () => {
        const ids = [...(selected ?? [])];
        end(true);
        opts.onDelete(ids);
      },
      "danger confirm-delete",
    ),
    button("Cancel", () => setConfirm(false), "cancel"),
  ];

  /** Every selected message is mine (and may still be deleted). */
  const allMine = () => !!selected?.size && [...selected].every((id) => opts.deletable(opts.find(id)!));

  function update() {
    const n = selected?.size ?? 0;
    if (confirming && allMine()) {
      confirmText.textContent = n === 1 ? "Delete this message? " : `Delete these ${n} messages? `;
      if (bar.firstChild !== confirmText) bar.replaceChildren(...confirmActions);
      return;
    }
    confirming = false;
    count.textContent = `${n} selected`;
    deleteBtn.hidden = !allMine();
    if (bar.firstChild !== count) bar.replaceChildren(...actions);
  }

  function setConfirm(on: boolean) {
    confirming = on;
    update();
    bar.querySelector<HTMLElement>(on ? ".cancel" : ".danger")?.focus();
  }

  function end(focus = false) {
    if (!selected) return;
    selected = null;
    confirming = false;
    notice.unsay(LIMIT_NOTICE);
    opts.onChange(true);
    if (focus) opts.focusComposer();
  }

  return {
    bar,
    get ids() {
      return selected;
    },
    toggle(id) {
      const m = opts.find(id);
      if (!m || !opts.selectable(m)) return;
      if (!selected) {
        selected = new Set();
        opts.onStart(id);
      }
      if (selected.has(id)) selected.delete(id);
      else if (selected.size >= MAX_SELECTED) return notice.say(LIMIT_NOTICE);
      else selected.add(id);
      confirming = false;
      if (!selected.size) return end(true);
      opts.onChange(true);
    },
    end,
    refresh: update,
    prune() {
      if (!selected) return;
      for (const id of selected) {
        const m = opts.find(id);
        if (!m || !opts.selectable(m)) selected.delete(id);
      }
      if (selected.size) return update();
      selected = null;
      opts.onChange(false);
    },
    escape() {
      if (!selected) return false;
      if (confirming) setConfirm(false);
      else end(true);
      return true;
    },
  };
}
