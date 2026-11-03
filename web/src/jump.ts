// Jump to (§32): Ctrl+K or Ctrl+P (⌘ too) anywhere, or the sidebar's "Jump to…" button (a JUMP event), opens the
// switcher, a lazy chunk loaded on the first press. Also
// keeps when each room and collection was last opened, for its "most recent first" (QA BUG-134).

import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { otherMember, visibilityOf } from "./lib/rooms.ts";
import { toPb } from "./lib/time.ts";
import { type AppState, roomSections, type Store, unreadCount } from "./store.ts";
import { avatar } from "./ui/avatar.ts";
import type { Switcher } from "./views/switcher.ts";

/** Sent on document by the sidebar's "Jump to…" button. */
export const JUMP = "chirkle-jump";

/** The switcher's icon for a private and an Open Air room; "#" for a public one. */
const ICONS: Record<string, string> = { private: "ic i-lock", open: "ic i-globe" };

export function startJumpTo(o: { api: Api; store: Store<AppState>; root: HTMLElement; navigate: (path: string) => void }): () => void {
  const { api, store, root } = o;
  let switcher: Promise<Switcher> | undefined;
  const opened = new Map<string, string>();

  const onKey = (e: KeyboardEvent) => {
    // By the letter typed, or by the key's place when it types no Latin letter (a Cyrillic layout).
    const k = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || !/^(k|p|KeyK|KeyP)$/.test(k)) return;
    e.preventDefault(); // not the browser's search bar or printing
    if (!e.repeat) toggle(); // held down: not open, closed, open… (QA BUG-137)
  };

  /**
   * While the chunk loads (the first time, slow on a slow network): what is typed meanwhile, for the field once it shows,
   * not for the composer behind it, where an Enter would send it (QA BUG-205). Null: Escape, so it doesn't show.
   */
  let early: string | null | undefined;
  const hold = (e: KeyboardEvent) => {
    if (early == null || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key === "Escape") early = null;
    else if (e.key === "Backspace") early = early.slice(0, -1);
    else if (e.key.length === 1) early += e.key;
    else if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const toggle = () => {
    if (!switcher) early = "";
    switcher ??= import("./views/switcher.ts").then(
      (m) => {
        const s = m.createSwitcher({
          h,
          state: store.get,
          sections: roomSections,
          unread: unreadCount,
          other: otherMember,
          icon: (r) => ICONS[visibilityOf(r)] ?? "",
          avatar: (u) => avatar(u, 24, api.avatarUrl),
          navigate: o.navigate,
          opened: (id) => opened.get(id) ?? "",
        });
        root.append(s.el);
        return s;
      },
      (err: unknown) => {
        switcher = undefined; // tried again next time
        early = undefined;
        throw err;
      },
    );
    switcher.then(
      (s) => {
        const typed = early;
        early = undefined;
        if (typed === null) return;
        s.toggle();
        const input = s.el.querySelector("input");
        if (!typed || !input) return;
        input.value = typed;
        input.dispatchEvent(new Event("input"));
      },
      () => {},
    );
  };

  const offStore = store.subscribe((s, prev) => {
    // The page left too: the first one may have opened before this listened.
    const open = s.activeRoomId ?? s.activeCollectionId;
    const left = prev.activeRoomId ?? prev.activeCollectionId;
    if (open !== left) for (const id of [left, open]) if (id) opened.set(id, toPb(Date.now()));
    if (s.user?.id !== prev.user?.id) {
      // Someone else's rooms from here on: not the last user's list, nor where they went (QA BUG-136).
      opened.clear();
      switcher?.then(
        (x) => x.el.close(),
        () => {},
      );
    }
  });
  document.addEventListener("keydown", onKey);
  document.addEventListener("keydown", hold, true);
  document.addEventListener(JUMP, toggle);
  return () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keydown", hold, true);
    document.removeEventListener(JUMP, toggle);
    offStore();
  };
}
