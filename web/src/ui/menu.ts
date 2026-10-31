// "⋯" actions menu (§7.1) used by room rows and the room header: a <details> disclosure with an optional
// inline confirm step. It owns its open/confirm state and focus, so callers just hand it the current items.
// Keyboard: Escape closes it and returns focus to the toggle; a confirm step focuses Cancel.

import { h } from "../dom.ts";

export interface MenuItem {
  label: string;
  run: () => void;
  /** Ask first: `text` is the question, `action` the label of the button that runs the item. */
  confirm?: { text: string; action: string };
  /** An icon (an .i-* class) before the label. */
  icon?: string;
  /** A setting turned on or off: shown as a switch. */
  checked?: boolean;
  /** Set apart from the items before it by a line. */
  sep?: boolean;
}

export interface ActionMenu {
  readonly el: HTMLDetailsElement;
  /** Replace the items. Cheap when only their callbacks changed: the buttons are rebuilt only if labels did. */
  update(items: readonly MenuItem[]): void;
  close(): void;
}

/**
 * `label` names the menu for assistive tech. With `summary`, the toggle shows that text (which then is its name,
 * e.g. an author's name) instead of "⋯" (or `icon`, an .i-* class); `className` goes on the toggle.
 */
export function createActionMenu(opts: {
  label: string;
  summary?: string;
  className?: string;
  icon?: string;
  /** A line over the items, e.g. which instance an author is on (§33.4). */
  note?: string | undefined;
  signal: AbortSignal;
}): ActionMenu {
  const { signal } = opts;
  let items: readonly MenuItem[] = [];
  let shape = "";
  let confirming: string | null = null;

  const summary = opts.summary
    ? h("summary", { class: opts.className ?? "" }, opts.summary)
    : h("summary", { "aria-label": opts.label, class: `ic ${opts.icon ?? "i-dots"} ${opts.className ?? ""}`.trim() });
  const body = h("div", { class: "menu-items" });
  const el = h(
    "details",
    {
      class: "menu",
      on: {
        toggle: () => {
          if (el.open) watchOutside();
          else {
            outside?.abort();
            outside = null;
            if (confirming) setConfirming(null);
          }
        },
        keydown: (e) => {
          if (e.key !== "Escape" || !el.open) return;
          e.preventDefault();
          close();
          summary.focus();
        },
      },
      signal,
    },
    [summary, body],
  );

  /** While open: listeners that close it when you click or tab anywhere else (QA BUG-46). */
  let outside: AbortController | null = null;
  function watchOutside() {
    if (outside || signal.aborted) return;
    outside = new AbortController();
    const opts = { capture: true, signal: outside.signal };
    const away = (e: Event) => {
      if (e.target instanceof Node && !el.contains(e.target)) close();
    };
    document.addEventListener("pointerdown", away, opts);
    document.addEventListener("focusin", away, opts);
  }
  signal.addEventListener("abort", () => outside?.abort(), { once: true });

  const button = (label: string, onClick: () => void, cls?: string, item?: MenuItem) =>
    h(
      "button",
      {
        type: "button",
        ...(cls ? { class: cls } : {}),
        // A switch, not a menuitemcheckbox: the items are buttons in a disclosure, not a role=menu (QA BUG-189).
        ...(item?.checked === undefined ? {} : { role: "switch", "aria-checked": String(item.checked) }),
        on: { click: onClick },
        signal,
      },
      label,
    );
  const find = (label: string | null) => items.find((i) => i.label === label);
  /**
   * Close, then run the item's *current* callback (items may have been updated since the button was built). Closing
   * redraws the items, so the focus they had goes back to the toggle, not to the page (QA BUG-190).
   */
  const runItem = (label: string) => {
    const item = find(label);
    const focused = el.contains(document.activeElement);
    close();
    if (focused) summary.focus();
    item?.run();
  };

  function render() {
    const item = find(confirming);
    if (item?.confirm) {
      const cancel = button(
        "Cancel",
        () => {
          setConfirming(null);
          summary.focus();
        },
        "cancel",
      );
      body.replaceChildren(
        h("p", {}, item.confirm.text),
        button(item.confirm.action, () => runItem(item.label), "danger"),
        cancel,
      );
      return cancel;
    }
    body.replaceChildren(
      ...(opts.note ? [h("p", {}, opts.note)] : []),
      ...items.map((i) =>
        button(
          i.label,
          () => {
            if (find(i.label)?.confirm) setConfirming(i.label)?.focus();
            else runItem(i.label);
          },
          [i.icon ? `ic ${i.icon}` : "", i.sep ? "sep" : ""].join(" ").trim(),
          i,
        ),
      ),
    );
    return null;
  }

  /** Enter or leave the confirm step; returns the Cancel button when entering one. */
  function setConfirming(label: string | null) {
    confirming = label;
    return render();
  }

  function close() {
    el.open = false;
    outside?.abort();
    outside = null;
    confirming = null;
    render();
  }

  return {
    el,
    update(next) {
      items = next;
      const nextShape = JSON.stringify(next.map((i) => [i.label, i.confirm ?? null, i.icon, i.checked, i.sep]));
      const stale = confirming !== null && !find(confirming)?.confirm;
      if (stale) confirming = null;
      if (nextShape === shape && !stale) return; // same buttons; they look their item up when clicked
      shape = nextShape;
      render();
    },
    close,
  };
}
