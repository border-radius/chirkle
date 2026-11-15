// The user-facing text of views/room/media.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const MEDIA = "Media";
export const MEDIA_IN = "Media in ";
export const CLOSE = "Close";
export const LOADING = "Loading…";
export const NO_PHOTOS_OR_VIDEOS_HERE_YET = "No photos or videos here yet.";
export const COULDNT_LOAD_MEDIA = "Couldn't load media. ";
export const RETRY = "Retry";
/** A tile's label: the file, whether it is a video, who sent it and when. */
export const tileLabel = (name: string, video: boolean, author: string | undefined, date: string) =>
  `${name}${video ? ", video" : ""}, ${author ?? "Unknown"}, ${date}`;
