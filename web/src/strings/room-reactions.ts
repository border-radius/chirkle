// The user-facing text of views/room/reactions.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const ADD_REACTION = "Add reaction";
export const REACTIONS = "Reactions";
export const reactedWith = (who: string | number, emoji: string | number) => `${who} reacted with ${emoji}`;
