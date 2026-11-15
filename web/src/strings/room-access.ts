// The user-facing text of views/room/access.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const GUESTS_OF_AN_OPEN_AIR_ROOM = "Guests of an Open Air room only read.";
export const EVERYONE_WHO_CAN_SEE_IT = "Everyone who can see it";
export const EVERYONE_ELSE_READS_AND_REACTS_BUT = "Everyone else reads and reacts, but can't post.";
export const ONLY_PEOPLE_YOU_CHOOSE = "Only people you choose";
export const EVERYTHING_EVER_WRITTEN_HERE_AND_EVERYTHING =
  "Everything ever written here, and everything to come, becomes readable by anyone on the web.";
export const EVERYONE_WITH_AN_ACCOUNT_WILL_BE = "Everyone with an account will be able to read the whole history.";
export const onlyWillSeeThisRoomEveryone = (mine: boolean) =>
  `Only ${mine ? "you and the people you add" : "its creator and the people added"} will see this room. Everyone else loses it from their list.`;
export const PEOPLE_WITHOUT_AN_ACCOUNT_WONT_SEE = "People without an account won't see this room any more.";
export const WHO_CAN_SEE_IT = "Who can see it";
export const WHO_CAN_POST = "Who can post";
export const ADD_PEOPLE = "Add people";
export const CREATOR = "Creator";
export const remove = (name: string | number) => `Remove ${name}`;
export const REMOVE = "Remove";
export const MEMBERS = "Members";
export const CANCEL = "Cancel";
export const SAVE = "Save";
export const thisRoomsHomeIsWhoIs = (home: string | number) => `This room's home is ${home}: who is in it is decided there.`;
export const CLOSE = "Close";
export const FIND_SOMEONE_WHO_CAN_POST = "Find someone who can post";
export const FIND_SOMEONE_TO_ADD_AS_A = "Find someone to add as a member";
export const UNKNOWN = "Unknown";
export const ROOM_ACCESS = "Room access";
export const upTo = (max: number, members: boolean) => `A room can have up to ${max} ${members ? "members" : "people who post"}.`;
/** A linked room's hosts; who may add people is told how to add someone from there. */
export const sharedWith = (hosts: string[], editable: boolean) =>
  `Shared with ${hosts.join(", ")}: its messages are kept there too.${editable ? ` Add people there by their address, like ann@${hosts[0]}.` : ""}`;

// The invite link (§44).
export const INVITE_LINK = "Invite link";
export const ANYONE_WITH_THE_LINK_CAN_JOIN = "Anyone with the link who has an account here can join as a member.";
export const WORKS_FOR = "Works for";
export const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);
export const COPY_LINK = "Copy link";
export const CREATE_LINK = "Create link";
export const NEW_LINK = "New link";
export const REVOKE = "Revoke";
export const LINK_READY = "The link is ready to share.";
export const NEW_LINK_READY = "A new link is ready. The old one no longer works.";
export const LINK_REVOKED = "The link no longer works.";
export const COPIED = "Copied.";
export const PRESS_CTRL_C_TO_COPY = "Press Ctrl+C to copy it.";
export const couldntChangeLink = (why: string) => `Couldn't change the link: ${why}`;
export const couldntLoadLink = (why: string) => `Couldn't load the invite link: ${why}`;
export const expiresUsed = (when: string, uses: number) =>
  `Works until ${when} · ${uses === 0 ? "nobody has joined by it yet" : uses === 1 ? "1 person joined by it" : `${uses} people joined by it`}`;
