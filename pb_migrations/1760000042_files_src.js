/// <reference path="../types/pocketbase.d.ts" />
// Shared files moved in the background (DESIGN.md §37.5): `files.src`, where a file still is until the media worker
// moves it into its row's folder. 1760000041 makes it now; a server that ran that migration before it did (it copied
// every file there and then, nothing served meanwhile) gets it here, empty: its files are all moved.

migrate(
  (app) => {
    const files = app.findCollectionByNameOrId("files");
    if (files.fields.getByName("src")) return;
    files.fields.add(new TextField({ name: "src", max: 255 }));
    files.addIndex("idx_files_unmoved", false, "created", "src != ''");
    app.save(files);
  },
  () => {
    // Kept: 1760000041 made it, or going down from it removes the collection.
  },
);
