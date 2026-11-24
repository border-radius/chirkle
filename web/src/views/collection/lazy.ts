// Media collections (§31), what most visits never use: a collection's page (/c/:id: its items as a grid like the media
// grid's, newest first under month headings, what is new since you last looked highlighted), the save menu (which of
// your collections have a file; tick to add, untick to take out, or make a new one), the picker the composer opens
// (items of your collections and those you follow, to attach), and making a collection (the sidebar has the form). Their requests are in
// calls.ts (through Api.request), so app.js doesn't carry them.
//
// A lazy chunk, like the media grid (§30.2): views/collection.ts import()s it, and it links its own stylesheet
// (styles/collections.css). The viewer (§17.7) is another chunk, which it import()s itself.

export { createCollection } from "./create.ts";
export { mountCollection, type PageOptions } from "./page.ts";
export { openPicker, type PickOptions } from "./picker.ts";
export { openSave, type SaveOptions } from "./save.ts";
