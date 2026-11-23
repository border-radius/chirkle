// The user-facing text of views/rooms.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const ROOMS = "Rooms";
export const YOUR_PROFILE = "Your profile";
export const SETTINGS = "Settings";
export const YOURE_READING_AS_A_GUEST_ONLY = "You're reading as a guest. Only Open Air rooms are listed.";
export const LOG_IN = "Log in";
export const SIGN_UP = "Sign up";
export const COULDNT_LOAD_ROOMS_CHECK_YOUR_CONNECTION = "Couldn't load rooms. Check your connection. ";
export const RETRY = "Retry";
export const couldntUnhide = (room: string, why: string) => `Couldn't unhide “${room}”. ${why}`;
export const couldntArchive = (archived: boolean, room: string, why: string) =>
  `Couldn't ${archived ? "archive" : "unarchive"} “${room}”. ${why}`;
export const COULDNT_OPEN_THE_PEOPLE_SEARCH_CHECK = "Couldn't open the people search. Check your connection.";
export const COULDNT_OPEN_COLLECTIONS_CHECK_YOUR_CONNECTION = "Couldn't open collections. Check your connection.";
export const couldntOpenTheConversationWith = (name: string | number, why: string | number) =>
  `Couldn't open the conversation with “${name}”. ${why}`;
export const UNHIDE = "Unhide";
export const UNARCHIVE = "Unarchive";
export const MENTIONS_YOU = "Mentions you";
export const HIDDEN_ARCHIVED = "Hidden & archived";
export const HIDDEN = "Hidden";
export const ARCHIVED = "Archived";
export const NEW_ROOM = "New room";
export const NEW_MESSAGE = "New message";
export const NEW_COLLECTION = "New collection";
export const DIRECT_MESSAGES = "Direct messages";
export const COLLECTIONS = "Collections";
export const MENTIONS_REPLIES = "Mentions & replies";
export const NO_OTHER_ROOMS_HIDDEN_AND_ARCHIVED = "No other rooms. Hidden and archived ones are listed below.";
export const NO_ROOMS_YET_CREATE_THE_FIRST = "No rooms yet. Create the first one.";
export const OPEN_AIR_ROOMS = "Open Air rooms";
export const NO_OPEN_AIR_ROOMS_YET_LOG = "No Open Air rooms yet. Log in to see the others.";
export const CREATE_ROOM = "Create room";
export const WHO_CAN_SEE_IT = "Who can see it";
export const mustBeNoMoreThanCharacters = (roomName: string | number) => `Must be no more than ${roomName} characters.`;
export const ROOM_NAME = "Room name";
export const CANCEL = "Cancel";
export const A_ROOM_WITH_THIS_NAME_ALREADY = "A room with this name already exists.";
export const NEW = " new";
export const ITEM = " item";
export const ITEMS = " items";
export const MENTIONS_YOU_HIDDEN = " mentions you,";
export const UNREAD = " unread";
