// The user-facing text of views/room/messages.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const REPLY = "Reply";
export const FORWARD = "Forward";
export const SELECT = "Select";
export const EDIT = "Edit";
export const DELETE = "Delete";
export const MESSAGES = "Messages";
export const COULDNT_LOAD_THIS_ROOM_CHECK_YOUR = "Couldn't load this room. Check your connection. ";
export const RETRY = "Retry";
export const messageName = (name: string | number) => `Message ${name}`;
export const UNBAN = "Unban";
export const BAN = "Ban…";
export const banTheyAreSignedOutEverywhere = (name: string | number) =>
  `Ban ${name}? They are signed out everywhere and can't sign in until unbanned.`;
export const ENTER_TO_SAVE_ESC_TO_CANCEL = "Enter to save · Esc to cancel";
export const EDIT_MESSAGE = "Edit message";
export const UNKNOWN = "Unknown";
export const selectMessageFrom = (name: string | number, when: string | number) => `Select message from ${name}, ${when}`;
export const forwardedFrom = (name: string | undefined) => `Forwarded from ${name ?? UNKNOWN}`;
export const THE_ORIGINAL_MESSAGE_WAS_DELETED = "The original message was deleted";
export const MESSAGE_DELETED = "Message deleted";
export const edited = (when: string | number) => `Edited ${when}`;
export const NOT_SENT = "Not sent. ";
export const NOT_SENT_THE_MESSAGE_YOU_REPLIED = "Not sent: the message you replied to was deleted. ";
export const SEND_WITHOUT_QUOTE = "Send without quote";
export const DISCARD = "Discard";
export const CONFIRM_DELETE = "Confirm delete";
export const DELETE_THIS_MESSAGE = "Delete this message? ";
export const CANCEL = "Cancel";
export const SAVE = "Save";
export const DELETE_MESSAGE = "Delete message";
export const SHOW_THE_ORIGINAL_MESSAGE = "Show the original message";
export const quotingShowTheOriginalMessage = (name: string, spoken: string | number) =>
  `Quoting ${name || "a message"}: ${spoken}. Show the original message.`;
export const on = (instance: string | number) => `On ${instance}`;
export const BAN_ACTION = "Ban";
export const NEW = "New";
export const EDITED = "(edited)";
