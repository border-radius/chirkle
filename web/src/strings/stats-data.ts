// The user-facing text of stats/data.ts (docs/REFACTOR.md item 56): one module per source file, so a lazy
// screen's text stays in its own chunk. Copy changes here; a translation would replace these.

export const min = (n: number) => `${n} min`;
export const hours = (n: string) => `${n} h`;
export const sec = (n: number) => `${n} s`;
export const days = (n: number) => `${n} d`;
export const ago = (span: string) => `${span} ago`;
export const NOT_SINCE_START = "not since the start";
