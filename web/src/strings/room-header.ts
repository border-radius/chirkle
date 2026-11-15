// The user-facing text of views/room/header.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const ROOM_ACTIONS = "Room actions";
export const SEARCH_MESSAGES = "Search messages";
export const MEDIA = "Media";
export const BACK_TO_ROOMS = "Back to rooms";
export const THIS_BROWSER_BLOCKS_NOTIFICATIONS_HERE_ALLOW =
  "This browser blocks notifications here: allow them, or choose the sound in your profile.";
export const thatDidntWork = (why: string | number) => `That didn't work. ${why}`;
export const REOPEN_CONVERSATION = "Reopen conversation";
export const CLOSE_CONVERSATION = "Close conversation";
export const JUMP_TO_BEGINNING = "Jump to beginning";
export const membersMenu = (n: string | number) => `Members (${n})`;
export const ROOM_ACCESS = "Room access…";
export const UNHIDE_ROOM = "Unhide room";
export const HIDE_ROOM = "Hide room";
export const UNARCHIVE_ROOM = "Unarchive room";
export const ARCHIVE_ROOM = "Archive room";
export const ARCHIVE = "Archive";
export const archiveItBecomesReadOnlyFor = (name: string | number) => `Archive “${name}”? It becomes read-only for everyone.`;
export const NOTIFY_OF_EVERY_MESSAGE = "Notify of every message";
export const OFF_ONLY_MENTIONS_AND_REPLIES_TO = "Off — only mentions and replies to you";
export const ON_YOU_HEAR_ABOUT_EVERYTHING_HERE = "On — you hear about everything here";
export const membersCount = (peopleCount: string | number) => `Members, ${peopleCount}`;
