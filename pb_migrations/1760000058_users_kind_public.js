/// <reference path="../types/pocketbase.d.ts" />
// What kind of account a user is, said to clients (DESIGN.md §5.1, 2026-11-25, user: "clicking on telegram user names
// should do nothing, not show dropdown with "ban" as only option"): `users.kind` is no longer hidden, so the apps can
// tell a stand-in (a Telegram sender's, a deleted account) from a person who takes no DMs, and offer no Ban on it (the
// server refuses one, §36). Still set by hooks only (the create/update rules of migration 51).

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const kind = users.fields.getByName("kind");
    if (kind) kind.hidden = false;
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const kind = users.fields.getByName("kind");
    if (kind) kind.hidden = true;
    app.save(users);
  },
);
