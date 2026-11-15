// The user-facing text of views/room/attachments.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const UPLOADING = "Uploading";
export const saveToCollection = (file: string | number) => `Save ${file} to collection`;
export const SAVE_TO_COLLECTION = "Save to collection";
export const PRIVATE_COLLECTION = "Private collection";
export const fromTheCollection = (name: string | number) => `From the collection “${name}”`;
export const PRIVATE = "Private";
export const couldntLoad = (video: boolean) => `Couldn't load ${video ? "video" : "image"} `;
export const RETRY = "Retry";
export const MORE = " more";
