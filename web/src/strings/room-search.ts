// The user-facing text of views/room/search.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const SEARCH_MESSAGES = "Search messages";
export const search = (label: string | number) => `Search ${label}`;
export const CLOSE_SEARCH = "Close search";
export const SEARCH_RESULTS = "Search results";
export const SHOW_OLDER_RESULTS = "Show older results";
export const SEARCHING = "Searching…";
export const NO_MESSAGES_FOUND = "No messages found.";
export const COULDNT_SEARCH_CHECK_YOUR_CONNECTION = "Couldn't search. Check your connection.";
export const TOO_MANY_SEARCHES = "Too many attempts. Wait a few seconds and try again.";
export const found = (n: number, more: boolean) => `${n}${more ? "+" : ""} ${n === 1 ? "message" : "messages"} found.`;
