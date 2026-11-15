// The user-facing text of lib/reactions.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const and = (first: string, last: string | undefined) => `${first} and ${last}`;
export const YOU = "You";
/** The people reacted with no name known: after names, "and 2 others"; alone, "3 people". */
export const others = (n: number) => `${n} ${n === 1 ? "other" : "others"}`;
export const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
