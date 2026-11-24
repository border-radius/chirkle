// Room helpers that depend on who is looking (§16.5): a DM is titled after the other member.

import * as S from "../strings/lib-rooms.ts";
import type { Posting, Room, User, Visibility } from "./types.ts";

export const isDm = (room: Room): boolean => room.kind === "dm";

/**
 * Why a DM takes no new messages: one of the two takes no direct messages (§16.7), as a linked instance's people do once
 * it is unpaired (§33.7). "" while it takes them.
 */
export function dmClosed(room: Room, me: User | null): string {
  if (!me || !isDm(room)) return "";
  if (me.no_dms) return S.YOUVE_TURNED_OFF_DIRECT_MESSAGES;
  const other = otherMember(room, me);
  return other?.no_dms ? S.doesntTakeDirectMessages(other.name) : "";
}

/** Who can see the room (§23.1); rooms from before visibility existed are public. */
export const visibilityOf = (room: Room): Visibility => room.visibility ?? "public";

/** Who can post in the room (§23.6); rooms from before posting existed let everyone. */
export const postingOf = (room: Room): Posting => room.posting ?? "everyone";

/** Can `me` post in a room they see (§23.6)? Guests never can; the creator always can. */
export function canPost(room: Room, me: User | null): boolean {
  if (!me) return false;
  return postingOf(room) !== "selected" || room.created_by === me.id || !!room.writers?.includes(me.id);
}

/**
 * May `me` change the room's access and archive it? Its creator, or a moderator (§36); never a DM. A copy of another
 * instance's room is changed there (§33.5).
 */
export function canManage(room: Room, me: User | null): boolean {
  if (!me || isDm(room)) return false;
  return room.created_by === me.id || (!!me.moderator && !room.shared?.home);
}

/** How each visibility is called and explained (§23.1). */
export const VISIBILITY: Record<Visibility, { label: string; icon: string; hint: string }> = {
  private: { label: S.PRIVATE, icon: "🔒", hint: S.ONLY_THE_PEOPLE_YOU_ADD_CAN },
  public: { label: S.PUBLIC, icon: "#", hint: S.EVERYONE_WITH_AN_ACCOUNT_CAN_READ },
  open: {
    label: S.OPEN_AIR,
    icon: "🌐",
    hint: S.ANYONE_CAN_READ_IT_EVEN_WITHOUT,
  },
};

/**
 * Where else a shared room is held (§33.9): "Shared with b.example", "Shared with b.example · a.example can't be
 * reached right now" when its home is down (§33.7). "" for a room that isn't shared.
 */
export function sharedNote(room: Room): string {
  const hosts = room.shared?.with ?? [];
  if (!hosts.length) return "";
  const down = room.shared?.down && room.shared.home ? S.cantBeReachedRightNow(room.shared.home) : "";
  return S.sharedWith(hosts.join(", "), down);
}

/** Is this an address on another instance, "ann@b.example" (§33.5)? Its host has a dot or a port. */
export function isAddress(q: string): boolean {
  const m = /^[^@\s][^@]*@([a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?)$/i.exec(q.trim());
  return !!m && /[.:]/.test(m[1] ?? "");
}

/** The other member of a DM (as expanded by the API), if known. */
export function otherMember(room: Room, me: User | null): User | undefined {
  if (!isDm(room)) return undefined;
  const otherId = room.members?.find((id) => id !== me?.id);
  return room.expand?.members?.find((u) => u.id === otherId) ?? (otherId ? { id: otherId, name: S.UNKNOWN } : undefined);
}

/** What to call a room: "#name" for public rooms, the other member's name for a DM. */
export function roomTitle(room: Room, me: User | null): string {
  return isDm(room) ? (otherMember(room, me)?.name ?? S.UNKNOWN) : `#${room.name}`;
}

/**
 * A name as the server compares it (nameKey() and tidy() in pb_hooks/lib/text.js): spaces tidied, invisible characters
 * dropped, NFKC, case folded. With `room`, leading "#"s go too, as the server strips them from room names.
 */
export function nameKey(name: string, room = false): string {
  let s = name
    .replace(/[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are spaces in a name, as on the server
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (room) s = s.replace(/^[#\s]+/, "");
  return s.normalize("NFKC").toUpperCase().toLowerCase();
}
