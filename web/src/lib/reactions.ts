// Emoji reactions (§20): pure helpers for showing them and for changing them optimistically.

import * as S from "../strings/lib-reactions.ts";
import type { Reaction } from "./types.ts";

/**
 * `list` with `user`'s `emoji` reaction added (`on`) or removed, the way the server does it
 * (pb_hooks/lib/reactions.js): a new emoji goes last, one nobody uses any more goes away. Same list when unchanged.
 */
export function setReaction(list: readonly Reaction[], emoji: string, user: string, on: boolean): readonly Reaction[] {
  const r = list.find((x) => x.emoji === emoji);
  if (r && r.users.includes(user) === on) return list;
  if (!on && !r) return list;
  if (on) return r ? list.map((x) => (x === r ? { emoji, users: [...x.users, user] } : x)) : [...list, { emoji, users: [user] }];
  return list.map((x) => (x === r ? { emoji, users: x.users.filter((u) => u !== user) } : x)).filter((x) => x.users.length > 0);
}

/** "You", "You and Ada", "Ada, Bob and 3 others": who reacted, with names where they are known. */
export function reactors(users: readonly string[], me: string, names: (id: string) => string | undefined): string {
  const known: string[] = [];
  let others = 0;
  for (const id of users) {
    const name = id === me ? S.YOU : names(id);
    if (name === undefined) others++;
    else if (id === me) known.unshift(name);
    else known.push(name);
  }
  // Long lists name the first few, then count the rest.
  const shown = known.slice(0, 5);
  others += known.length - shown.length;
  if (others) shown.push(shown.length ? S.others(others) : S.people(others));
  if (shown.length === 1) return shown[0]!;
  return S.and(shown.slice(0, -1).join(", "), shown.at(-1));
}
