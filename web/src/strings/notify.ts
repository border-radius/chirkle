// The user-facing text of notify.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const sentAttachments = (filesCount: string | number) => `Sent ${filesCount} attachments`;
export const SENT_AN_ATTACHMENT = "Sent an attachment";
export const FORWARDED_A_MESSAGE = "Forwarded a message";
export const SOMEONE = "Someone";
export const YOUR_BROWSER_BLOCKS_NOTIFICATIONS_FROM_THIS =
  "Your browser blocks notifications from this site. Allow them in its settings for this site.";
export const THIS_BROWSER_CANT_SHOW_NOTIFICATIONS_HERE = "This browser can't show notifications here: choose the sound.";
export const DIRECT_MESSAGES = "Direct messages";
export const MENTIONS_AND_REPLIES = "Mentions and replies";
export const SHOW_A_POP_UP = "Show a pop-up";
export const PLAY_A_SOUND = "Play a sound";
export const NOTIFICATIONS = "Notifications";
export const FOR_DMS_REPLIES_TO_YOU_AND =
  "For DMs, replies to you and the rooms you choose in their menu, while this app is open in a tab, even in the background. Saved on this device.";
/** A notification's heading: the author and what they did where (a DM's is the author alone). */
export const heading = (author: string, did: "in" | "replied" | "mentioned", room: string) =>
  `${author} ${did === "in" ? "in" : did === "replied" ? "replied in" : "mentioned you in"} ${room}`;
