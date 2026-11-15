// The user-facing text of views/inbox.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const MESSAGE_DELETED = "Message deleted";
export const ATTACHMENT = "Attachment";
export const LOADING = "Loading…";
export const SHOW_OLDER = "Show older";
export const BACK_TO_ROOMS = "Back to rooms";
export const MENTIONS_REPLIES = "Mentions & replies";
export const NOTHING_HERE_YET_WHEN_SOMEONE_MENTIONS =
  "Nothing here yet. When someone mentions you, replies to you or reacts to your message, it shows here.";
export const COULDNT_LOAD_YOUR_MENTIONS_AND_REPLIES = "Couldn't load your mentions and replies. Check your connection.";
export const inRoom = (room: string | number) => ` in ${room}`;
export const reactedToYourMessage = (emoji: string | number, where: string | number) => ` reacted ${emoji} to your message${where}`;
export const repliedToYou = (where: string | number) => ` replied to you${where}`;
export const mentionedYou = (where: string | number) => ` mentioned you${where}`;
export const attachments = (files: string | number) => `${files} attachments`;
