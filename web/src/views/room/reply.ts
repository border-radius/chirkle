// Replying (§19): the message the composer is replying to, kept in step with it. Edited, the quote shows the new text;
// deleted (or the room archived), there is nothing left to reply to.

import { quoteText } from "../../lib/messages.ts";
import type { Message } from "../../lib/types.ts";
import * as S from "../../strings/room-reply.ts";
import type { Composer } from "./composer.ts";

export interface Reply {
  /** The message being replied to, or null. */
  readonly to: Message | null;
  set(m: Message | null): void;
  /** Reply to message `id`, if it can be replied to, and put the caret in the composer. */
  start(id: string): void;
  /**
   * Ctrl+Up / Ctrl+Down: reply to the repliable message before (-1) or after (1) the current one, or to the newest
   * when not replying; after the newest, stop replying. False when there was nothing to do.
   */
  step(dir: -1 | 1): boolean;
  /** Follow the message after the list changed. Out of the window, it is checked against the room alone. */
  refresh(): void;
}

export function createReply(opts: {
  find: (id: string) => Message | undefined;
  /** The messages on screen, oldest first. */
  list: () => readonly Message[];
  repliable: (m: Message) => boolean;
  composer: Pick<Composer, "setReply" | "focus">;
  /** Bring the message now replied to into view. */
  reveal?: (id: string) => void;
}): Reply {
  const { composer } = opts;
  let to: Message | null = null;

  function set(m: Message | null) {
    to = m;
    composer.setReply(m && { name: m.expand?.author?.name ?? S.UNKNOWN, text: quoteText(m) });
  }

  return {
    get to() {
      return to;
    },
    set,
    start(id) {
      const m = opts.find(id);
      if (!m || !opts.repliable(m)) return;
      set(m);
      composer.focus();
    },
    step(dir) {
      const ms = opts.list().filter(opts.repliable);
      const at = ms.findIndex((m) => m.id === to?.id);
      const next = ms[at < 0 ? ms.length - 1 : at + dir];
      if (!to && (dir > 0 || !next)) return false;
      if (next) opts.reveal?.(next.id);
      if (next || dir > 0) set(next ?? null);
      return true;
    },
    refresh() {
      if (!to) return;
      const now = opts.find(to.id) ?? to;
      if (!opts.repliable(now)) set(null);
      else if (now !== to) set(now);
    },
  };
}
