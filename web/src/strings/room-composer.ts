// The user-facing text of views/room/composer.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const tooLongCharactersOverTheLimit = (over: string | number, max: string | number) =>
  `Too long: ${over} characters over the ${max} limit.`;
export const SEND = "Send";
export const ATTACH_FILES = "Attach files";
export const ATTACH = "Attach";
export const PHOTO_VIDEO_OR_DOCUMENT = "Photo, video or document";
export const UPLOAD_FILE = "Upload file";
export const FROM_COLLECTION = "From collection";
export const PICK_FROM_YOUR_SAVED_MEDIA = "Pick from your saved media";
export const EMOJI = "Emoji";
export const ATTACHMENTS = "Attachments";
export const CANCEL_REPLY = "Cancel reply";
export const FROM_A_COLLECTION = "From a collection";
export const remove = (name: string | number) => `Remove ${name}`;
export const atMostFilesPerMessage = (attachments: string | number) => `At most ${attachments} files per message.`;
export const MESSAGE = "Message";
export const CTRL = "Ctrl /";
export const FOCUS_THE_MESSAGE_BOX = "Focus the message box";
export const REPLYING_TO = "Replying to ";
export const A_MESSAGE_CANT_BE_EMPTY_USE = "A message can't be empty. Use Delete to remove it.";
export const left = (n: string | number) => `${n} left`;
export const over = (n: string | number) => `${n} over`;
