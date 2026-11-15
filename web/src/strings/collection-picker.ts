// The user-facing text of views/collection/picker.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const COLLECTION = "Collection";
export const ATTACH = "Attach";
export const CLOSE = "Close";
export const THE_MESSAGE_HAS_ALL_THE_FILES = "The message has all the files it can take.";
export const attach = (pickedSize: string | number) => `Attach ${pickedSize}`;
export const LOADING = "Loading…";
export const NOTHING_IN_THIS_COLLECTION_YET = "Nothing in this collection yet.";
export const COULDNT_LOAD_THE_COLLECTION = "Couldn't load the collection. ";
export const RETRY = "Retry";
export const YOU_HAVE_NO_COLLECTIONS_YET_SAVE = "You have no collections yet. Save images and videos from the chat to one first.";
export const ATTACH_FROM_COLLECTIONS = " Attach from collections";
export const picked = (n: number, full: boolean) => `${n} picked${full ? " (the most a message takes)" : ""}`;
export const tile = (name: string, video: boolean) => `${name}${video ? ", video" : ""}`;
