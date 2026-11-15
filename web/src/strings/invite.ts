// The user-facing text of views/invite.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const LOADING = "Loading…";
export const THIS_LINK_DOESNT_WORK = "This invite link doesn't work";
export const IT_HAS_EXPIRED_OR_WAS_REVOKED = "It has expired or was revoked. Ask whoever sent it for a new one.";
export const BACK_TO_ROOMS = "Back to the rooms";
export const joinRoom = (name: string) => `Join #${name}`;
export const about = (by: string, members: number, until: string) =>
  `${by ? `${by} invited you to this private room. ` : "You're invited to this private room. "}${members === 1 ? "1 member" : `${members} members`} · the link works until ${until}.`;
export const YOURE_IN_THIS_ROOM_ALREADY = "You're in this room already.";
export const OPEN_THE_ROOM = "Open the room";
export const TO_JOIN = "To join, ";
export const LOG_IN = "log in";
export const OR = " or ";
export const SIGN_UP = "sign up";
export const FIRST = " first.";
export const JOIN = "Join the room";
export const couldntJoin = (why: string) => `Couldn't join: ${why}`;
export const couldntOpen = (why: string) => `Couldn't open this invite: ${why}`;
