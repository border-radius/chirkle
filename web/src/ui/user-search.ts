// "New message" user search (§16.5): type a name, pick a person. Debounced, cancels stale requests.
// Keyboard: ↓ from the input moves into the results, ↑/↓ between them, Escape closes.
//
// A lazy chunk (the sidebar's New message and the room access dialog load it): it imports types only, and gets what it
// uses of app.js in `kit` (lazy.ts SEARCH_KIT).

import type { h, uniqueId } from "../dom.ts";
import type { User } from "../lib/types.ts";
import type { AvatarUrl, avatar } from "./avatar.ts";

export interface SearchKit {
  h: typeof h;
  uniqueId: typeof uniqueId;
  avatar: typeof avatar;
  /** How long typing pauses before people are searched. */
  SEARCH_DEBOUNCE_MS: number;
}

/** A search that failed for a reason to show as it is ("There's nobody called ann on b.example."). */
export class SearchError extends Error {}

export interface UserSearch {
  readonly el: HTMLElement;
  focus(): void;
  /** Show again who is picked, after a pick changed it. */
  mark(): void;
}

export function createUserSearch(opts: {
  kit: SearchKit;
  search: (query: string, signal: AbortSignal) => Promise<User[]>;
  avatarUrl: AvatarUrl;
  onPick: (user: User) => void;
  /** When given, each result is a toggle, pressed for someone already picked. */
  isPicked?: (user: User) => boolean;
  onClose: () => void;
  signal: AbortSignal;
}): UserSearch {
  const { signal } = opts;
  const { h, uniqueId, avatar, SEARCH_DEBOUNCE_MS } = opts.kit;
  const id = uniqueId("user-search");
  const input = h("input", {
    id,
    type: "search",
    autocomplete: "off",
    placeholder: "Find someone…",
    "aria-controls": `${id}-results`,
    "aria-describedby": `${id}-status`,
  });
  const status = h("p", { id: `${id}-status`, class: "search-status", role: "status" }, "Type a name.");
  const results = h("ul", { id: `${id}-results`, class: "search-results", "aria-label": "People" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;
  let shown: [User, HTMLButtonElement][] = [];

  const buttons = () => [...results.querySelectorAll<HTMLButtonElement>("button")];

  function show(users: User[]) {
    status.textContent = users.length ? `${users.length === 20 ? "20+" : users.length} found` : "No one found.";
    shown = users.map((u) => [
      u,
      h(
        "button",
        {
          type: "button",
          class: "person",
          title: u.instance ? `On ${u.instance}` : undefined,
          on: { click: () => opts.onPick(u) },
          signal,
        },
        [avatar(u, 24, opts.avatarUrl), h("span", {}, u.name)],
      ),
    ]);
    results.replaceChildren(...shown.map(([, b]) => h("li", {}, b)));
    mark();
  }

  function mark() {
    if (opts.isPicked) for (const [u, b] of shown) b.setAttribute("aria-pressed", String(opts.isPicked(u)));
  }

  async function run(query: string) {
    inflight?.abort();
    if (!query) {
      status.textContent = "Type a name.";
      shown = [];
      results.replaceChildren();
      return;
    }
    const ac = new AbortController();
    inflight = ac;
    status.textContent = "Searching…";
    try {
      const users = await opts.search(query, ac.signal);
      if (inflight === ac && !signal.aborted) show(users);
    } catch (e) {
      if (inflight !== ac || signal.aborted) return;
      status.textContent = e instanceof SearchError ? e.message : "Couldn't search. Check your connection.";
      shown = [];
      results.replaceChildren();
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

  const el = h(
    "div",
    {
      class: "user-search",
      on: {
        keydown: (e) => {
          const list = buttons();
          const at = list.indexOf(document.activeElement as HTMLButtonElement);
          if (e.key === "Escape") {
            e.preventDefault();
            opts.onClose();
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
    [h("label", { for: id, class: "visually-hidden" }, "Find someone to message"), input, status, results],
  );
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
