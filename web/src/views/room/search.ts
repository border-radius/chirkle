// Message search (§29): a bar under the room header that finds the room's (or DM's) messages containing every word
// typed, newest first, a page at a time. Picking one goes to it in the room, as a reply's quote does (§19). Matched
// on `text_key`, the text case folded on the server like names are (§22.1): "привет" finds "Привет".
//
// A lazy chunk, like the viewer (§17.7): the room view import()s it when search is first opened.

import { h } from "../../dom.ts";
import type { PageQuery } from "../../lib/cursor.ts";
import type { Message, User } from "../../lib/types.ts";

export interface SearchOptions {
  room: string;
  /** What is searched, for the field's placeholder: "#general", "Bob". */
  label: string;
  /** A page of results (`api.page`): PAGE_SIZE of them, or fewer when there are no more. */
  page: (q: PageQuery, signal: AbortSignal) => Promise<Message[]>;
  pageSize: number;
  /** When a message was sent, short. */
  when: (m: Message) => string;
  /** The author's face, next to a result. */
  avatar: (u: User) => HTMLElement;
  /** Go to message `id` in the room. */
  onPick: (id: string) => void;
  /** Closed from the bar itself (Close, Escape). */
  onClose: () => void;
  /** Ends it (the room view unmounts). */
  signal: AbortSignal;
}

export interface Search {
  readonly el: HTMLElement;
  focus(): void;
}

/** Wait this long (ms) after the last key before searching. */
const DEBOUNCE_MS = 300;
/** At most this many words count; the rest are ignored. */
const MAX_WORDS = 5;
/** Text shown before the first match in a result, at most (characters). */
const LEAD = 40;

/**
 * Same as searchKey() in pb_hooks/lib/text.js: what the server stores in `text_key`. "İ" lowercases to "i" and a
 * combining dot, which "istanbul" as typed wouldn't find (QA BUG-113): the dot goes.
 */
export function foldKey(s: string): string {
  return s
    .replace(/[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/i\u0307/g, "i");
}

/** The words of a search, folded, each once. */
export function searchWords(q: string): string[] {
  return [...new Set(foldKey(q).split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);
}

/**
 * The newest messages of `room` with every word in `words`, before `before` when given (newest-first): a page of the
 * room with `q` (server/lists.go matches the words, escaping `%` and `\` as QA BUG-34 and BUG-112 found).
 */
export function searchQuery(room: string, words: readonly string[], before?: { created: string; id: string }): PageQuery {
  const q = words.join(" ");
  return before ? { room, kind: "older", args: { created: before.created, id: before.id }, q } : { room, kind: "latest", args: {}, q };
}

/**
 * `text` as runs of plain and matched (odd indexes) text, starting shortly before the first match. Matched
 * case-insensitively as typed: a match only folding finds ("strasse" in "Straße") just isn't marked.
 */
export function highlight(text: string, words: readonly string[]): string[] {
  const one = text.replace(/\s+/g, " ").trim();
  const re = words.length ? new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu") : null;
  const first = re ? one.search(re) : -1;
  const from = first > LEAD ? one.lastIndexOf(" ", first - LEAD / 2) + 1 || first - LEAD / 2 : 0;
  const shown = (from ? "…" : "") + one.slice(from);
  return re ? shown.split(new RegExp(`(${re.source})`, "giu")) : [shown];
}

export function createSearch(o: SearchOptions): Search {
  const scope = new AbortController();
  const { signal } = scope;
  o.signal.addEventListener("abort", () => scope.abort(), { signal });
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    fetching?.abort();
  });

  const input = h("input", {
    // Not type=search: browsers add a clear "×" of their own next to Close (QA BUG-114).
    type: "text",
    role: "searchbox",
    "aria-label": "Search messages",
    placeholder: `Search ${o.label}`,
    enterkeyhint: "search",
    autocomplete: "off",
    on: { input: () => schedule(), keydown: (e) => keydown(e), focus: () => (results.hidden = !results.childElementCount) },
    signal,
  });
  const close = h("button", {
    type: "button",
    class: "icon-button ic i-x",
    "aria-label": "Close search",
    on: { click: () => end() },
    signal,
  });
  const status = h("p", { class: "search-status", role: "status" });
  const results = h("ul", { class: "search-results", "aria-label": "Search results", hidden: true });
  const more = h(
    "li",
    {},
    h("button", { type: "button", class: "link", on: { click: () => void run(true) }, signal }, "Show older results"),
  );
  const el = h("div", { class: "room-search ic i-search", role: "search", on: { keydown: (e) => e.key === "Escape" && end(e) }, signal }, [
    h("div", { class: "search-bar" }, [input, close]),
    status,
    results,
  ]);

  let timer = 0;
  /** The search shown: its words, how many are found, the last one (where more begin). */
  let words: string[] = [];
  let found: Message[] = [];
  let fetching: AbortController | null = null;

  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(false), DEBOUNCE_MS);
  }

  function keydown(e: KeyboardEvent) {
    // Not the Enter confirming an IME word (as composer.ts `composing`, QA BUG-179): what it confirms is searched as typed.
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    clearTimeout(timer);
    void run(false);
  }

  /** Search for what is typed, or (`next`) the page after the results shown. */
  async function run(next: boolean) {
    const w = next ? words : searchWords(input.value);
    if (!next && w.join(" ") === words.join(" ") && (found.length || fetching)) {
      results.hidden = !found.length;
      return;
    }
    fetching?.abort();
    if (!w.length) {
      words = [];
      found = [];
      fetching = null;
      status.textContent = "";
      results.replaceChildren();
      results.hidden = true;
      return;
    }
    const f = new AbortController();
    fetching = f;
    if (!next) words = w;
    status.textContent = "Searching…";
    // "Show older results" hands focus to the first of them.
    const refocus = more.contains(document.activeElement);
    more.remove();
    try {
      const page = await o.page(searchQuery(o.room, w, next ? found.at(-1) : undefined), f.signal);
      if (f !== fetching) return;
      if (!next) {
        found = [];
        results.replaceChildren();
      }
      found.push(...page);
      const rows = page.map(row);
      results.append(...rows);
      if (refocus) rows[0]?.querySelector("button")?.focus();
      if (page.length >= o.pageSize) results.append(more);
      results.hidden = !found.length;
      const n = found.length;
      status.textContent = n
        ? `${n}${page.length >= o.pageSize ? "+" : ""} ${n === 1 ? "message" : "messages"} found.`
        : "No messages found.";
    } catch {
      if (f !== fetching) return;
      status.textContent = "Couldn't search. Check your connection.";
      if (next) results.append(more); // to try again
    } finally {
      if (f === fetching) fetching = null;
    }
  }

  function row(m: Message): HTMLElement {
    const parts = highlight(m.text, words).map((s, i) => (i % 2 ? h("mark", {}, s) : s));
    return h("li", {}, [
      h("button", { type: "button", class: "search-result", on: { click: () => pick(m.id) }, signal }, [
        m.expand?.author ? o.avatar(m.expand.author) : null,
        h("span", { class: "meta" }, [
          m.expand?.author ? h("b", { class: "author" }, m.expand.author.name) : null,
          h("time", {}, o.when(m)),
        ]),
        h("span", { class: "body" }, parts),
      ]),
    ]);
  }

  /** Go to it; the results make way for the room (focusing the field shows them again). */
  function pick(id: string) {
    results.hidden = true;
    o.onPick(id);
  }

  function end(e?: Event) {
    e?.preventDefault();
    scope.abort();
    el.remove();
    o.onClose();
  }

  return { el, focus: () => input.focus() };
}
