// The user-facing text of lib/rooms.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const YOUVE_TURNED_OFF_DIRECT_MESSAGES = "You've turned off direct messages.";
export const doesntTakeDirectMessages = (name: string | number) => `${name} doesn't take direct messages.`;
export const ONLY_THE_PEOPLE_YOU_ADD_CAN = "Only the people you add can read and post.";
export const PRIVATE = "Private";
export const EVERYONE_WITH_AN_ACCOUNT_CAN_READ = "Everyone with an account can read and post.";
export const PUBLIC = "Public";
export const OPEN_AIR = "Open Air";
export const ANYONE_CAN_READ_IT_EVEN_WITHOUT = "Anyone can read it, even without an account. Everyone with an account can post.";
export const sharedWith = (hosts: string | number, down: string | number) => `Shared with ${hosts}${down}`;
export const UNKNOWN = "Unknown";
export const cantBeReachedRightNow = (home: string | number) => ` · ${home} can't be reached right now`;
