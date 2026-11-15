// Names of people who reacted but aren't in the window (§20.3): looked up in batches, one request for every name a
// render asks for. Looking people up needs an account (§23.3): a guest sees "3 people".

import type { User } from "../../lib/types.ts";
import * as S from "../../strings/room-names.ts";

/** Most users one request asks for (`usersById`). */
const BATCH = 50;

/** A user's name if known; otherwise undefined, and `onFound` is called once it is. */
export type NameOf = (id: string) => string | undefined;

export function createNameLookup(opts: {
  usersById: (ids: readonly string[], signal: AbortSignal) => Promise<User[]>;
  signedIn: () => boolean;
  /** New names arrived: render again. */
  onFound: () => void;
  signal: AbortSignal;
}): NameOf {
  const { signal } = opts;
  const people = new Map<string, string>();
  /** Ids to look up, or being looked up. */
  const asking = new Set<string>();
  let lookingUp = false;

  async function lookUp() {
    const ids = [...asking].filter((id) => !people.has(id)).slice(0, BATCH);
    let ok = true;
    try {
      const found = await opts.usersById(ids, signal);
      for (const u of found) people.set(u.id, u.name);
      for (const id of ids) if (!people.has(id)) people.set(id, S.UNKNOWN); // e.g. a deleted account
    } catch {
      ok = false;
      for (const id of ids) asking.delete(id); // asked again by the next render (not this one: no retry loop offline)
    }
    if (signal.aborted || !ok) {
      lookingUp = false;
      return;
    }
    if ([...asking].some((id) => !people.has(id))) return void lookUp(); // more than one batch
    lookingUp = false;
    opts.onFound();
  }

  return (id) => {
    if (!opts.signedIn()) return undefined;
    const name = people.get(id);
    if (name !== undefined || asking.has(id)) return name;
    asking.add(id);
    if (!lookingUp) {
      lookingUp = true;
      queueMicrotask(() => void lookUp());
    }
    return undefined;
  };
}
