// The user-facing text of views/room.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const COULDNT_OPEN_ROOM_ACCESS_CHECK_YOUR = "Couldn't open room access. Check your connection.";
export const couldntSave = (why: string | number) => `Couldn't save. ${why}`;
export const BEGINNING_OF_THE_ROOM = "Beginning of the room";
export const beginningOf = (name: string | number) => `Beginning of #${name}`;
export const beginningOfYourConversationWith = (name: string | undefined) => `Beginning of your conversation with ${name ?? "Unknown"}`;
export const INSERT_EMOJI = "Insert emoji";
export const COULDNT_FORWARD_A_MESSAGE_WAS_DELETED = "Couldn't forward. A message was deleted.";
export const MESSAGE_FORWARDED = "Message forwarded.";
export const couldntForward = (why: string | number) => `Couldn't forward. ${why}`;
export const couldntDeleteThoseMessages = (why: string | number) => `Couldn't delete those messages. ${why}`;
export const COULDNT_OPEN_FORWARD_CHECK_YOUR_CONNECTION = "Couldn't open Forward. Check your connection.";
export const BACK_TO_REPLY = "Back to reply";
export const NEW_MESSAGES_JUMP_TO_LATEST = "New messages · Jump to latest";
export const NEW_MESSAGES = "New messages";
export const JUMP_TO_LATEST = "Jump to latest";
export const couldntOpenThatConversation = (why: string | number) => `Couldn't open that conversation. ${why}`;
export const UNBANNED = "Unbanned.";
export const BANNED_THEY_CANT_SIGN_IN_UNTIL = "Banned. They can't sign in until unbanned.";
export const couldntBan = (banned: boolean, why: string | number) => `Couldn't ${banned ? "ban" : "unban"} them. ${why}`;
export const LOG_IN = "Log in";
export const BACK_TO_ROOMS = "Back to rooms";
export const THIS_ROOM_DOESNT_EXIST = "This room doesn't exist.";
export const YOU_CANT_SEE_THIS_ROOM_ANY = "You can't see this room any more.";
export const COULDNT_OPEN_SEARCH_CHECK_YOUR_CONNECTION = "Couldn't open search. Check your connection.";
export const COULDNT_SAVE_YOUR_EDIT = "Couldn't save your edit.";
export const COULDNT_DELETE_THIS_MESSAGE = "Couldn't delete this message.";
export const couldntRemoveYourReaction = (emoji: string | number) => `Couldn't remove your ${emoji} reaction.`;
export const couldntAddYourReaction = (emoji: string | number) => `Couldn't add your ${emoji} reaction.`;
export const ADD_REACTION = "Add reaction";
export const THIS_ROOM = "this room";
export const messagesForwarded = (n: string | number) => `${n} messages forwarded.`;
export const TO_SEE_MORE_ROOMS_OR = " to see more rooms, or ";
export const GO_BACK_TO_THE_OPEN_AIR = "go back to the Open Air rooms";
