// Room helpers that depend on who is looking (§16.5): a DM is titled after the other member.

import type { Posting, Room, User, Visibility } from "./types.ts";

export const isDm = (room: Room): boolean => room.kind === "dm";

/**
 * Why a DM takes no new messages: one of the two takes no direct messages (§16.7), as a linked instance's people do once
 * it is unpaired (§33.7). "" while it takes them.
 */
export function dmClosed(room: Room, me: User | null): string {
  if (!me || !isDm(room)) return "";
  if (me.no_dms) return "You've turned off direct messages.";
  const other = otherMember(room, me);
  return other?.no_dms ? `${other.name} doesn't take direct messages.` : "";
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
  private: { label: "Private", icon: "🔒", hint: "Only the people you add can read and post." },
  public: { label: "Public", icon: "#", hint: "Everyone with an account can read and post." },
  open: {
    label: "Open Air",
    icon: "🌐",
    hint: "Anyone can read it, even without an account. Everyone with an account can post.",
  },
};

/**
 * Where else a shared room is held (§33.9): "Shared with b.example", "Shared with b.example · a.example can't be
 * reached right now" when its home is down (§33.7). "" for a room that isn't shared.
 */
export function sharedNote(room: Room): string {
  const hosts = room.shared?.with ?? [];
  if (!hosts.length) return "";
  const down = room.shared?.down && room.shared.home ? ` · ${room.shared.home} can't be reached right now` : "";
  return `Shared with ${hosts.join(", ")}${down}`;
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
  return room.expand?.members?.find((u) => u.id === otherId) ?? (otherId ? { id: otherId, name: "Unknown" } : undefined);
}

/** What to call a room: "#name" for public rooms, the other member's name for a DM. */
export function roomTitle(room: Room, me: User | null): string {
  return isDm(room) ? (otherMember(room, me)?.name ?? "Unknown") : `#${room.name}`;
}
