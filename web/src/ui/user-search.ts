// "New message" user search (§16.5): type a name, pick a person. Debounced, cancels stale requests.
// Keyboard: ↓ from the input moves into the results, ↑/↓ between them, Enter in the input picks the first (searching
// at once if the debounce hasn't run yet; QA BUG-272), Escape closes.
//
// As a card (the sidebar's New message, sidebar improvements: New direct message): a search icon in the field, the
// results as a list box whose highlight ↑ ↓ move while the focus stays in the field (Enter opens the highlighted one),
// the letters that matched in bold under each name its @handle, and a hint line of the keys; nothing found says so.
//
// A lazy chunk: the sidebar's New message loads it, and the room access dialog and the forward dialog import it.

import { type Child, h, uniqueId } from "../dom.ts";
import type { User } from "../lib/types.ts";
import * as S from "../strings/ui-user-search.ts";
import { type AvatarUrl, avatar } from "./avatar.ts";

/** How long typing pauses before people are searched. */
export const SEARCH_DEBOUNCE_MS = 200;

/** A search that failed for a reason to show as it is ("There's nobody called ann on b.example."). */
export class SearchError extends Error {}

export interface UserSearch {
  readonly el: HTMLElement;
  focus(): void;
  /** Show again who is picked, after a pick changed it. */
  mark(): void;
}

export function createUserSearch(opts: {
  search: (query: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: AvatarUrl;
  onPick: (user: User) => void;
  /** When given, each result is a toggle, pressed for someone already picked. */
  isPicked?: (user: User) => boolean;
  onClose: () => void;
  /** The field's name for assistive tech: what the search is for (QA BUG-273). */
  label?: string;
  /** Set as a card, with a highlight the arrow keys move (the sidebar's New message); not with `isPicked`. */
  card?: boolean;
  signal: AbortSignal;
}): UserSearch {
  const { signal } = opts;
  const card = !!opts.card && !opts.isPicked;
  const id = uniqueId("user-search");
  const input = h("input", {
    id,
    type: "search",
    autocomplete: "off",
    placeholder: S.FIND_SOMEONE,
    "aria-controls": `${id}-results`,
    "aria-describedby": `${id}-status`,
  });
  const status = h("p", { id: `${id}-status`, class: "search-status", role: "status" }, S.TYPE_A_NAME);
  const results = h("ul", { id: `${id}-results`, class: "search-results", "aria-label": S.PEOPLE });
  /** A card's parts: nothing found, the hint line, and which result is highlighted. */
  const none = h("div", { class: "search-none", hidden: true }, [
    h("span", { class: "none-ic ic i-search", "aria-hidden": "true" }),
    h("strong", {}),
    h("span", { class: "none-tip" }, S.CHECK_THE_SPELLING),
  ]);
  const hint = h("p", { class: "search-hint", "aria-hidden": "true" }, S.TYPE_A_NAME_OR_HANDLE);
  const kbd = h("kbd", { "aria-hidden": "true" }, S.ENTER);
  let active = 0;
  if (card) {
    input.type = "text";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    results.setAttribute("role", "listbox");
  }

  /** A card's state: its hint line, nothing found, the status (shown when it is a failure). */
  function paint(state: "idle" | "searching" | "results" | "none" | "error", query = "") {
    if (!card) return;
    status.classList.toggle("visually-hidden", state !== "error");
    none.hidden = state !== "none";
    none.querySelector("strong")!.textContent = S.noOneFoundFor(query);
    hint.textContent =
      state === "idle" ? S.TYPE_A_NAME_OR_HANDLE : state === "results" || state === "searching" ? S.MOVE_OPEN_CLOSE : S.ESC_TO_CLOSE;
    hint.hidden = state === "searching" && !shown.length;
    // While the next search runs, the last one's results stay, highlighted as they were.
    const listed = state === "results" || (state === "searching" && shown.length > 0);
    input.setAttribute("aria-expanded", String(listed));
    highlight(listed ? active : -1);
  }

  /** The highlighted result (a card's): marked for assistive tech as the field's active one, with "Enter" on it. */
  function highlight(at: number) {
    active = Math.max(0, Math.min(at, shown.length - 1));
    shown.forEach(([, b], i) => {
      const on = i === active && at >= 0;
      b.setAttribute("aria-selected", String(on));
      if (on) {
        b.append(kbd);
        input.setAttribute("aria-activedescendant", b.id);
      }
    });
    if (at < 0 || !shown.length) {
      kbd.remove();
      input.removeAttribute("aria-activedescendant");
    } else shown[active]?.[1].scrollIntoView?.({ block: "nearest" });
  }

  /** `text` with the first place `query` matches it (ignoring case) in bold. */
  function marked(text: string, query: string): Child[] {
    const lower = text.toLowerCase();
    const i = query && lower.length === text.length ? lower.indexOf(query.toLowerCase()) : -1;
    if (i < 0) return [text];
    return [text.slice(0, i), h("b", {}, text.slice(i, i + query.length)), text.slice(i + query.length)];
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;
  let shown: [User, HTMLButtonElement][] = [];
  /** The query the results are for. */
  let shownFor = "";

  const buttons = () => [...results.querySelectorAll<HTMLButtonElement>("button")];

  function show(users: User[], query = "") {
    status.textContent = users.length ? S.found(users.length === 20 ? "20+" : users.length) : S.NO_ONE_FOUND;
    const handleQuery = query.replace(/^@/, "");
    shown = users.map((u, i) => {
      const sub = [u.handle ? `@${u.handle}` : "", u.instance ? S.on(u.instance) : ""].filter(Boolean).join(" · ");
      return [
        u,
        h(
          "button",
          {
            type: "button",
            class: "person",
            title: u.instance ? S.on(u.instance) : undefined,
            ...(card ? { id: `${id}-o${i}`, role: "option", tabindex: -1 } : {}),
            on: {
              click: () => opts.onPick(u),
              ...(card ? { pointermove: () => active !== i && highlight(i) } : {}),
            },
            signal,
          },
          card
            ? [
                avatar(u, 24, opts.avatarUrl),
                h("span", { class: "who" }, [
                  h("span", { class: "name" }, marked(u.name, query)),
                  sub ? h("span", { class: "handle" }, u.handle ? marked(sub, `@${handleQuery}`) : sub) : null,
                ]),
              ]
            : [avatar(u, 24, opts.avatarUrl), h("span", {}, u.name)],
        ),
      ] as [User, HTMLButtonElement];
    });
    results.replaceChildren(...shown.map(([, b]) => h("li", card ? { role: "none" } : {}, b)));
    mark();
    active = 0;
    paint(users.length ? "results" : "none", query);
  }

  function mark() {
    if (opts.isPicked) for (const [u, b] of shown) b.setAttribute("aria-pressed", String(opts.isPicked(u)));
  }

  async function run(query: string) {
    inflight?.abort();
    if (!query) {
      status.textContent = S.TYPE_A_NAME;
      shown = [];
      shownFor = "";
      results.replaceChildren();
      paint("idle");
      return;
    }
    const ac = new AbortController();
    inflight = ac;
    status.textContent = S.SEARCHING;
    paint("searching", query);
    try {
      const users = await opts.search(query, ac.signal);
      if (inflight === ac && !signal.aborted) {
        show(users, query);
        shownFor = query;
      }
    } catch (e) {
      if (inflight !== ac || signal.aborted) return;
      status.textContent = e instanceof SearchError ? e.message : S.COULDNT_SEARCH_CHECK_YOUR_CONNECTION;
      shown = [];
      results.replaceChildren();
      paint("error", query);
    }
  }

  input.addEventListener(
    "input",
    () => {
      clearTimeout(timer);
      timer = setTimeout(() => void run(input.value.trim()), SEARCH_DEBOUNCE_MS);
    },
    { signal },
  );
  // Enter picks the first person found, as Jump to opens its first match (QA BUG-272).
  input.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const pickFirst = () => {
        if (!signal.aborted && input.value.trim() === q && shownFor === q) buttons()[card ? active : 0]?.click();
      };
      if (shownFor === q) return pickFirst();
      clearTimeout(timer);
      void run(q).then(pickFirst);
    },
    { signal },
  );

  const el = h(
    "div",
    {
      class: card ? "user-search card" : "user-search",
      on: {
        keydown: (e) => {
          const list = buttons();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "Escape") {
            e.preventDefault();
            opts.onClose();
          } else if (card) {
            // The focus stays in the field; the highlight moves (and Enter opens it).
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && shown.length) {
              e.preventDefault();
              highlight(active + (e.key === "ArrowDown" ? 1 : -1));
            }
          } else if (e.key === "ArrowDown" && list.length) {
            e.preventDefault();
            list[Math.min(at + 1, list.length - 1)]!.focus();
          } else if (e.key === "ArrowUp" && at >= 0) {
            e.preventDefault();
            if (at === 0) input.focus();
            else list[at - 1]!.focus();
          }
        },
      },
      signal,
    },
    card
      ? [
          h("label", { for: id, class: "visually-hidden" }, opts.label ?? S.FIND_SOMEONE_TO_MESSAGE),
          h("div", { class: "search-field" }, [h("span", { class: "ic i-search", "aria-hidden": "true" }), input]),
          results,
          none,
          status,
          hint,
        ]
      : [h("label", { for: id, class: "visually-hidden" }, opts.label ?? S.FIND_SOMEONE_TO_MESSAGE), input, status, results],
  );
  paint("idle");
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      inflight?.abort();
    },
    { once: true },
  );

  return { el, focus: () => input.focus(), mark };
}
