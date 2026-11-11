// People by handle while typing (§41): "@an" in the composer offers the people of the room whose handle or name starts
// so (GET /api/chat/mentionable; just "@", those who wrote there lately) in a list over it, as ":name" offers emoji
// (§20.6) and looking the same; ↑/↓ choose, Enter or Tab puts "@handle " in place of "@an", Escape closes the list
// (until another "@" is typed).
//
// A lazy chunk: the composer (in app.js) only spots an "@" being typed and has the room view load this; from then on it
// follows the textarea itself. It imports types only, and links the emoji picker's stylesheet for the list's looks.

import type { Api } from "../api.ts";
import type { h as H } from "../dom.ts";
import type { User } from "../lib/types.ts";

/** The emoji picker's stylesheet, which styles .emoji-suggest (scripts/lib/build-utils.mjs). */
declare const EMOJI_CSS: string;

/** "@ann" being typed just before `caret`: where its "@" is, and what follows it so far (maybe nothing). */
export function mentionToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{0,24})$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null;
}

/** How long typing pauses before the server is asked. */
const WAIT_MS = 120;

export interface MentionSuggest {
  update(): void;
  close(): void;
  readonly isOpen: boolean;
}

export function createMentionSuggest(opts: {
  h: typeof H;
  api: Api;
  textarea: HTMLTextAreaElement;
  /** The room whose people to offer. */
  room: () => string;
  /** A user's avatar at 24 px. */
  avatar: (u: User) => HTMLElement;
  signal: AbortSignal;
}): MentionSuggest {
  const { h, api, textarea, signal } = opts;
  if (!document.querySelector(`link[href="${EMOJI_CSS}"]`)) document.head.append(h("link", { rel: "stylesheet", href: EMOJI_CSS }));
  const id = `${textarea.id}-people`;
  const el = h("ul", { class: "emoji-suggest", id, role: "listbox", "aria-label": "People", hidden: true });
  document.body.append(el);
  signal.addEventListener("abort", () => el.remove(), { once: true });

  let hits: (User & { handle: string })[] = [];
  let sel = 0;
  /** Where the "@" shown starts. */
  let start = -1;
  /** Where the "@" closed with Escape starts: not offered again until another one is typed. */
  let dismissed = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking: AbortController | null = null;
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    asking?.abort();
  });

  function update() {
    const caret = textarea.selectionStart;
    const t = caret === textarea.selectionEnd ? mentionToken(textarea.value, caret) : null;
    if (!t) dismissed = -1;
    if (!t || t.start === dismissed) return close();
    clearTimeout(timer);
    timer = setTimeout(() => void ask(t.start, t.query), WAIT_MS);
  }

  async function ask(at: number, q: string) {
    asking?.abort();
    const mine = new AbortController();
    asking = mine;
    let found: (User & { handle: string })[];
    try {
      found = await api.request("/api/chat/mentionable", { query: { room: opts.room(), q }, signal: mine.signal });
    } catch {
      return; // offline, or gone: no list
    }
    // The text may have moved on meanwhile.
    const now = mentionToken(textarea.value, textarea.selectionStart);
    if (mine.signal.aborted || signal.aborted || now?.start !== at || now.query !== q) return;
    hits = found;
    if (!hits.length) return close();
    if (at !== start) sel = 0;
    start = at;
    sel = Math.min(sel, hits.length - 1);
    render();
  }

  function render() {
    el.replaceChildren(
      ...hits.map((u, i) =>
        h(
          "li",
          {
            id: `${id}-${i}`,
            role: "option",
            "aria-selected": String(i === sel),
            on: {
              // Keep the focus (and the keyboard) in the textarea.
              pointerdown: (e) => e.preventDefault(),
              click: () => pick(i),
            },
            signal,
          },
          [opts.avatar(u), h("span", { class: "who" }, u.name), h("span", { class: "handle" }, `@${u.handle}`)],
        ),
      ),
    );
    textarea.setAttribute("aria-autocomplete", "list");
    textarea.setAttribute("aria-controls", id);
    textarea.setAttribute("aria-activedescendant", `${id}-${sel}`);
    el.hidden = false;
    const row = (textarea.parentElement ?? textarea).getBoundingClientRect();
    el.style.setProperty("--x", `${Math.round(Math.max(8, textarea.getBoundingClientRect().left))}px`);
    el.style.setProperty("--b", `${Math.round(innerHeight - row.top + 6)}px`);
  }

  function select(i: number) {
    sel = (i + hits.length) % hits.length;
    for (const [k, li] of [...el.children].entries()) li.setAttribute("aria-selected", String(k === sel));
    textarea.setAttribute("aria-activedescendant", `${id}-${sel}`);
    el.children[sel]?.scrollIntoView?.({ block: "nearest" });
  }

  function pick(i: number) {
    const u = hits[i];
    if (!u || start < 0) return;
    const from = start;
    close();
    textarea.focus();
    const caret = textarea.selectionStart;
    // The rest of a handle typed after the caret goes too.
    const tail = /^\w*/.exec(textarea.value.slice(caret))?.[0].length ?? 0;
    textarea.setRangeText(`@${u.handle} `, from, caret + tail, "end");
    // The composer counts, sizes and keeps the draft on input.
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function close() {
    start = -1;
    clearTimeout(timer);
    asking?.abort();
    if (el.hidden) return;
    el.hidden = true;
    el.replaceChildren();
    for (const a of ["aria-autocomplete", "aria-controls", "aria-activedescendant"]) textarea.removeAttribute(a);
  }

  textarea.addEventListener("input", update, { signal });
  textarea.addEventListener("click", update, { signal });
  textarea.addEventListener(
    "keyup",
    (e) => {
      if (!el.hidden && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) update();
    },
    { signal },
  );
  textarea.addEventListener("blur", close, { signal });
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
    update,
    close,
    get isOpen() {
      return !el.hidden;
    },
  };
}
