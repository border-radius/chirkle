/// <reference path="../types/pocketbase.d.ts" />
// Anonymous rooms (DESIGN.md §35): `rooms.anonymous`, set by a superuser in the admin UI, and on each message whether
// its author is kept to themselves (`messages.anonymous`) and whether the author of the message it forwards is
// (`forwarded_anonymous`). The hooks set the messages' two when they are made; no client sets any of the three.

const C_NO_ANONYMOUS = "@request.body.anonymous:isset = false";
const C_NO_FORWARDED_ANONYMOUS = "@request.body.forwarded_anonymous:isset = false";

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.add(new BoolField({ name: "anonymous" }));
    rooms.createRule = `${rooms.createRule} && ${C_NO_ANONYMOUS}`;
    rooms.updateRule = `${rooms.updateRule} && ${C_NO_ANONYMOUS}`;
    app.save(rooms);

    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new BoolField({ name: "anonymous" }));
    messages.fields.add(new BoolField({ name: "forwarded_anonymous" }));
    messages.createRule = `${messages.createRule} && ${C_NO_ANONYMOUS} && ${C_NO_FORWARDED_ANONYMOUS}`;
    messages.updateRule = `${messages.updateRule} && ${C_NO_ANONYMOUS} && ${C_NO_FORWARDED_ANONYMOUS}`;
    app.save(messages);
  },
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.fields.removeByName("anonymous");
    rooms.createRule = (rooms.createRule ?? "").replace(` && ${C_NO_ANONYMOUS}`, "");
    rooms.updateRule = (rooms.updateRule ?? "").replace(` && ${C_NO_ANONYMOUS}`, "");
    app.save(rooms);

    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("anonymous");
    messages.fields.removeByName("forwarded_anonymous");
    for (const c of [C_NO_ANONYMOUS, C_NO_FORWARDED_ANONYMOUS]) {
      messages.createRule = (messages.createRule ?? "").replace(` && ${c}`, "");
      messages.updateRule = (messages.updateRule ?? "").replace(` && ${c}`, "");
    }
    app.save(messages);
  },
);
