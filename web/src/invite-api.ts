// Room invite links (DESIGN.md §44): the part of the API (api.ts) only the access dialog and the invite page use, split
// out so it loads with them (a lazy chunk, `Api.invites()`), not on the app's critical path (§7.7).

import type { PbClient } from "./pb.ts";

/** A private room's invite link (GET /api/chat/rooms/{room}/invite). */
export interface Invite {
  /** The secret in the link: /invite/<token>. */
  token: string;
  created: string;
  /** When it stops working. */
  expires: string;
  /** How many people joined by it. */
  uses: number;
}

/** Where a link goes (GET /api/chat/invites/{token}). */
export interface InvitePreview {
  room: { id: string; name: string; members: number };
  /** Who made the link. */
  by: string;
  expires: string;
  /** Are you in the room already? */
  member: boolean;
}

/** How long a new link works: the server's choices. */
export const INVITE_DAYS = [1, 7, 30] as const;
export type InviteDays = (typeof INVITE_DAYS)[number];

export interface InviteApi {
  /** The room's working link, or null (its creator or a moderator in it). */
  get(room: string, signal?: AbortSignal): Promise<Invite | null>;
  /** A new link, replacing the room's last one. */
  make(room: string, days: InviteDays): Promise<Invite>;
  /** The link stops working. */
  revoke(room: string): Promise<void>;
  /** Where a link goes; rejects with a 404 when it doesn't work. Guests too. */
  preview(token: string, signal?: AbortSignal): Promise<InvitePreview>;
  /** Join its room (signed in); resolves to the room's id. */
  join(token: string): Promise<string>;
}

/** Built by api.ts with its client (which tells onRejected listeners) and its error wrapping. */
export function createInviteApi(pb: PbClient, wrap: <T>(p: Promise<T>) => Promise<T>): InviteApi {
  const path = (room: string) => `/api/chat/rooms/${encodeURIComponent(room)}/invite`;
  const link = (token: string) => `/api/chat/invites/${encodeURIComponent(token)}`;
  return {
    get: async (room, signal) => (await wrap(pb.send<{ invite: Invite | null }>(path(room), { signal }))).invite,
    // A POST always answers the link it made.
    make: async (room, days) => (await wrap(pb.send<{ invite: Invite }>(path(room), { method: "POST", body: { days } }))).invite,
    async revoke(room) {
      await wrap(pb.send(path(room), { method: "DELETE" }));
    },
    preview: (token, signal) => wrap(pb.send<InvitePreview>(link(token), { signal })),
    join: async (token) => (await wrap(pb.send<{ room: string }>(link(token), { method: "POST" }))).room,
  };
}
