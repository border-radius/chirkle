// Minimal DOM helpers (§7.3). Strings always become text nodes: there is no HTML parsing anywhere.

export type Child = Node | string | number | null | undefined | false;

type Listeners = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };

export interface Attrs {
  class?: string;
  dataset?: Record<string, string>;
  on?: Listeners;
  /** Removes every `on` listener when aborted. */
  signal?: AbortSignal;
  value?: string;
  checked?: boolean;
  [attr: string]: unknown;
}

const PROPS = new Set(["value", "checked"]);

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, children?: Child | Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, dataset, on: listeners, signal, ...rest } = attrs;
  if (cls) el.className = cls;
  if (dataset) Object.assign(el.dataset, dataset);
  for (const [name, v] of Object.entries(rest)) {
    if (v === undefined || v === null || v === false) continue;
    if (PROPS.has(name)) (el as unknown as Record<string, unknown>)[name] = v;
    else el.setAttribute(name, v === true ? "" : String(v));
  }
  if (listeners) {
    for (const [type, fn] of Object.entries(listeners)) {
      el.addEventListener(type, fn as EventListener, signal ? { signal } : undefined);
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child | Child[]): void {
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

let idSeq = 0;

/** A document-unique id for label/aria wiring, e.g. uniqueId("room") → "room-3". */
export function uniqueId(prefix: string): string {
  return `${prefix}-${++idSeq}`;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/**
 * Make `parent`'s children exactly `nodes`, in order, moving only what differs (§7.5: the message list is
 * never fully re-rendered). Nodes already in place keep their identity, focus and scroll anchoring.
 */
export function reconcile(parent: Element, nodes: readonly Node[]): void {
  // Drop what goes first: a replaced node left in place would push every node after it down one, and each of them
  // would then be moved (re-inserted, restyled) instead of left alone.
  const keep = new Set(nodes);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) c.remove();
  nodes.forEach((node, i) => {
    const at = parent.childNodes[i];
    if (at !== node) parent.insertBefore(node, at ?? null);
  });
}

/**
 * Keep what is typed while a lazy chunk loads (a search field that isn't there yet), for the field once it shows:
 * printable keys and Backspace, not shortcuts. `take()` stops holding and says what was typed (QA BUG-243, BUG-252).
 */
export function holdKeys(signal: AbortSignal): { take(): string } {
  let early = "";
  const hold = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || (e.key.length !== 1 && e.key !== "Backspace")) return;
    early = e.key === "Backspace" ? early.slice(0, -1) : early + e.key;
    e.preventDefault();
  };
  document.addEventListener("keydown", hold, { capture: true, signal });
  return {
    take() {
      document.removeEventListener("keydown", hold, true);
      return early;
    },
  };
}

/** Put `text` held by holdKeys() in `input`, as if typed there. */
export function typeInto(input: HTMLInputElement | null | undefined, text: string): void {
  if (!text || !input) return;
  input.value += text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A click on an open modal dialog's backdrop (outside its box) closes it, as Escape does: through a cancelable
 * "cancel" event, so a dialog that refuses Escape (busy saving, or closing its people search first) does the same
 * here. Both the press and the release must be outside, so a drag that selects text inside and ends outside doesn't
 * close it. One listener for every dialog, installed once by app.ts: the dialogs are in lazy chunks.
 */
export function closeDialogsOnBackdrop(): void {
  const outside = (e: MouseEvent): HTMLDialogElement | null => {
    const d = e.target;
    if (!(d instanceof HTMLDialogElement) || !d.open) return null;
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom ? d : null;
  };
  let pressed: HTMLDialogElement | null = null;
  document.addEventListener("pointerdown", (e) => (pressed = outside(e)), true);
  document.addEventListener(
    "click",
    (e) => {
      const d = outside(e);
      const was = pressed;
      pressed = null;
      if (!d || d !== was) return;
      if (d.dispatchEvent(new Event("cancel", { cancelable: true }))) d.close();
    },
    true,
  );
}
