/// <reference path="../types/pocketbase.d.ts" />
// Deleted accounts (DESIGN.md §43): `users.kind` gets "deleted", what an account is once its person deleted it
// (POST /api/chat/account/delete, pb_hooks/lib/account.js). The row stays, as "Deleted account", so that the messages
// and rooms naming it still have an author; nobody can sign in to it.

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const kind = /** @type {SelectField} */ (users.fields.getByName("kind"));
    kind.values = ["person", "telegram", "peer", "deleted"];
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const kind = /** @type {SelectField} */ (users.fields.getByName("kind"));
    kind.values = ["person", "telegram", "peer"];
    app.save(users);
  },
);
