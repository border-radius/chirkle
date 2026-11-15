// The user-facing text of views/room/selection.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const youCanSelectUpToMessages = (MAX_SELECTED: string | number) => `You can select up to ${MAX_SELECTED} messages at a time.`;
export const SELECTED_MESSAGES = "Selected messages";
export const DELETE = "Delete";
export const FORWARD = "Forward";
export const CANCEL = "Cancel";
export const deleteTheseMessages = (n: string | number) => `Delete these ${n} messages? `;
export const DELETE_THIS_MESSAGE = "Delete this message? ";
export const selected = (n: string | number) => `${n} selected`;
