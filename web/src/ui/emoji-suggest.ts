// Emoji by name while typing (§20.6): ":th" in the composer offers 👍 🤔 … in a list over it; ↑/↓ choose, Enter or Tab
// puts the emoji in place of ":th", Escape closes the list (until another ":name" is typed). A complete ":fire:"
// becomes 🔥 as the second colon is typed.
//
// Part of the emoji picker's lazy chunk: the composer (in app.js) only spots ":" and two letters before the caret and
// has the room view load this; from then on it follows the textarea itself. Its keys are caught on the form, in the
// capture phase, so the composer's own Enter (send) doesn't see the ones it uses.

import { h } from "../dom.ts";
import { rememberEmoji } from "../lib/emoji.ts";
import { emojiNamed, findEmoji, type NamedEmoji } from "../lib/emoji-names.ts";

/** How many emoji the list offers at most. */
export const SUGGEST_MAX = 8;

/** ":name" just before the caret, at the start or after a space or "(" (not "12:30" or "http://"). */
const TOKEN = /(?<=^|[\s(]):([\w+-]{2,})$/;
/** ":name:" just before the caret. */
const WHOLE = /(?<=^|[\s(]):([\w+-]+):$/;

/** Where ":name" starts before `caret` in `text`, and the name typed so far; null when there is none. */
export function emojiToken(text: string, caret: number): { start: number; query: string } | null {
  const m = TOKEN.exec(text.slice(0, caret));
  return m ? { start: m.index, query: m[1]!.toLowerCase() } : null;
}

export interface EmojiSuggest {
  readonly el: HTMLElement;
  /** Look at the text before the caret again (the textarea's input does this by itself). */
  update(typed?: boolean): void;
  close(): void;
  readonly isOpen: boolean;
}

export function createEmojiSuggest(opts: { textarea: HTMLTextAreaElement; signal: AbortSignal }): EmojiSuggest {
  const { textarea, signal } = opts;
  const id = `${textarea.id}-emoji`;
  const el = h("ul", { class: "emoji-suggest", id, role: "listbox", "aria-label": "Emoji", hidden: true });
  document.body.append(el);
  signal.addEventListener("abort", () => el.remove(), { once: true });

  let hits: NamedEmoji[] = [];
  let sel = 0;
  /** Where the ":name" shown starts. */
  let start = -1;
  /** Where the ":name" closed with Escape starts: not offered again until another one is typed. */
  let dismissed = -1;

  /** `typed`: text was just put in (not the caret moving, not our own replacing), so a whole ":name:" may become its emoji. */
  function update(typed = false) {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return close();
    const whole = typed ? WHOLE.exec(textarea.value.slice(0, caret)) : null;
    const named = whole && emojiNamed(whole[1]!);
    if (whole && named) return replace(whole.index, caret, named, "");
    const t = emojiToken(textarea.value, caret);
    if (!t) dismissed = -1;
    if (!t || t.start === dismissed) return close();
    hits = findEmoji(t.query, SUGGEST_MAX);
    if (!hits.length) return close();
    if (t.start !== start) sel = 0;
    start = t.start;
    sel = Math.min(sel, hits.length - 1);
    render();
  }

  function render() {
    el.replaceChildren(
      ...hits.map((n, i) =>
        h(
          "li",
          {
            id: `${id}-${i}`,
            role: "option",
            // Named by its short name, with the emoji for those who don't know it by that.
            "aria-label": `${n.emoji} ${n.name}`,
            "aria-selected": String(i === sel),
            on: {
              // Keep the focus (and the keyboard) in the textarea.
              pointerdown: (e) => e.preventDefault(),
              click: () => pick(i),
            },
            signal,
          },
          [h("span", { class: "emoji", "aria-hidden": "true" }, n.emoji), `:${n.name}:`],
        ),
      ),
    );
    textarea.setAttribute("aria-autocomplete", "list");
    textarea.setAttribute("aria-controls", id);
    textarea.setAttribute("aria-activedescendant", `${id}-${sel}`);
    el.hidden = false;
    place();
  }

  /** Over the composer's row, from the textarea's left edge. */
  function place() {
    const row = (textarea.parentElement ?? textarea).getBoundingClientRect();
    const r = textarea.getBoundingClientRect();
    el.style.setProperty("--x", `${Math.round(Math.max(8, r.left))}px`);
    el.style.setProperty("--b", `${Math.round(innerHeight - row.top + 6)}px`);
  }

  function select(i: number) {
    sel = (i + hits.length) % hits.length;
    for (const [k, li] of [...el.children].entries()) li.setAttribute("aria-selected", String(k === sel));
    textarea.setAttribute("aria-activedescendant", `${id}-${sel}`);
    el.children[sel]?.scrollIntoView?.({ block: "nearest" });
  }

  function pick(i: number) {
    const n = hits[i];
    if (!n) return;
    const caret = textarea.selectionStart;
    // A space after it when it ends the text, to type on.
    replace(start, caret, n.emoji, caret === textarea.value.length ? " " : "");
  }

  function replace(from: number, to: number, emoji: string, after: string) {
    close();
    textarea.focus();
    textarea.setRangeText(emoji + after, from, to, "end");
    rememberEmoji(emoji);
    // The composer counts, sizes and keeps the draft on input.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function close() {
    start = -1;
    if (el.hidden) return;
    el.hidden = true;
    el.replaceChildren();
    for (const a of ["aria-autocomplete", "aria-controls", "aria-activedescendant"]) textarea.removeAttribute(a);
  }

  textarea.addEventListener("input", (e) => update(e instanceof InputEvent && e.inputType.startsWith("insert")), { signal });
  textarea.addEventListener("click", () => update(), { signal });
  // The caret moved out of the name (or along it).
  textarea.addEventListener(
    "keyup",
    (e) => {
      if (!el.hidden && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) update();
    },
    { signal },
  );
  textarea.addEventListener("blur", close, { signal });
  addEventListener("resize", () => el.hidden || place(), { signal });
  (textarea.form ?? textarea.parentElement)?.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== textarea || el.hidden || e.isComposing || e.keyCode === 229) return;
      const plain = !(e.shiftKey || e.ctrlKey || e.altKey || e.metaKey);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!plain) return;
        select(sel + (e.key === "ArrowDown" ? 1 : -1));
      } else if ((e.key === "Enter" || e.key === "Tab") && plain) pick(sel);
      else if (e.key === "Escape") {
        dismissed = start;
        close();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true, signal },
  );

  return {
    el,
    update,
    close,
    get isOpen() {
      return !el.hidden;
    },
  };
}
