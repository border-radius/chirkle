/// <reference path="../types/pocketbase.d.ts" />
// Room invite links (DESIGN.md §44): a private room's link, which adds whoever opens it (signed in) to its members. One
// per room at a time: a new one replaces it, and revoking deletes it. `token` is the secret in the link
// (/invite/<token>); `expires` is when it stops working; `uses` counts the people it added.
// No API rules: only the routes (pb_hooks/lib/invites.js) read and write it.

const INVITES_ACCESS = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    const users = app.findCollectionByNameOrId("users");
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "room_invites",
          ...INVITES_ACCESS,
          fields: [
            { type: "relation", name: "room", collectionId: rooms.id, cascadeDelete: true, maxSelect: 1, required: true },
            { type: "text", name: "token", min: 24, max: 24, required: true },
            { type: "relation", name: "created_by", collectionId: users.id, cascadeDelete: false, maxSelect: 1 },
            { type: "date", name: "expires", required: true },
            { type: "number", name: "uses", onlyInt: true, min: 0 },
            { type: "autodate", name: "created", onCreate: true },
          ],
          indexes: [
            "CREATE UNIQUE INDEX idx_room_invites_room ON room_invites (room)",
            "CREATE UNIQUE INDEX idx_room_invites_token ON room_invites (token)",
            "CREATE INDEX idx_room_invites_expires ON room_invites (expires)",
          ],
        }),
      ),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("room_invites"));
  },
);
