/// <reference path="../types/pocketbase.d.ts" />
// Reactions seen in their room (DESIGN.md §41.4, 2026-11-22, user: "when reading room, new reactions should be marked
// as seen in mentions & replies"): room_reads.reactions_seen_at, when the caller last read the room (wall clock, set by
// POST /api/chat/reads). A reaction to a message read there that came before it is not new in the inbox.

migrate(
  (app) => {
    const reads = app.findCollectionByNameOrId("room_reads");
    reads.fields.add(new DateField({ name: "reactions_seen_at" }));
    app.save(reads);
  },
  (app) => {
    const reads = app.findCollectionByNameOrId("room_reads");
    reads.fields.removeByName("reactions_seen_at");
    app.save(reads);
  },
);
