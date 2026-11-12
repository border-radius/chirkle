/// <reference path="../types/pocketbase.d.ts" />
// What kind of account a user is (REFACTOR item 50, DESIGN.md §5.1): `users.kind`, "person" (signs in here),
// "telegram" (a Telegram sender's stand-in, §26.3) or "peer" (a linked instance's person, §33.4). Set by the hooks that
// make the account (lib/users.js for people, the bridges for their stand-ins), never by a client; hidden from the API.
// Until now the hooks told them apart by the made-up e-mail's domain, by tg_people or by `peer`; the backfill uses all
// of those.

const C_NO_KIND = "@request.body.kind:isset = false";

const BACKFILL = `UPDATE users SET kind = CASE
  WHEN id IN (SELECT user FROM tg_people) OR email LIKE '%@telegram.invalid' THEN 'telegram'
  WHEN peer != '' OR email LIKE '%@federation.invalid' THEN 'peer'
  ELSE 'person' END`;

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new SelectField({ name: "kind", values: ["person", "telegram", "peer"], maxSelect: 1, hidden: true }));
    users.createRule = `${users.createRule} && ${C_NO_KIND}`;
    users.updateRule = `${users.updateRule} && ${C_NO_KIND}`;
    app.save(users);
    app.db().newQuery(BACKFILL).execute();
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("kind");
    users.createRule = (users.createRule ?? "").replace(` && ${C_NO_KIND}`, "");
    users.updateRule = (users.updateRule ?? "").replace(` && ${C_NO_KIND}`, "");
    app.save(users);
  },
);
