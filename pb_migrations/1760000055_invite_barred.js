/// <reference path="../types/pocketbase.d.ts" />
// Room invite links (DESIGN.md §44.2, QA BUG-280): `room_invites.barred`, the people the room's managers took out of
// its members while the link worked. The link no longer lets them in; a new link (a new row) starts with nobody barred.

migrate(
  (app) => {
    const invites = app.findCollectionByNameOrId("room_invites");
    invites.fields.add(new JSONField({ name: "barred", maxSize: 0 }));
    app.save(invites);
  },
  (app) => {
    const invites = app.findCollectionByNameOrId("room_invites");
    invites.fields.removeByName("barred");
    app.save(invites);
  },
);
