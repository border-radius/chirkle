/// <reference path="../types/pocketbase.d.ts" />
// Moderators (DESIGN.md §36): `users.moderator`, ticked by a superuser in the admin UI, and `users.banned`, set by a
// moderator (POST /api/chat/ban) or a superuser. No client sets either on a users record; a banned account can't sign
// in (authRule). A moderator changes any public room's access and archives it, as its creator does, but doesn't rename
// it.

const C_NO_MODERATOR = "@request.body.moderator:isset = false";
const C_NO_BANNED = "@request.body.banned:isset = false";
const ROOM_OWNER = "created_by = @request.auth.id";
const ROOM_OWNER_OR_MODERATOR = `(${ROOM_OWNER} || (@request.auth.moderator = true && @request.body.name:isset = false))`;

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new BoolField({ name: "moderator" }));
    users.fields.add(new BoolField({ name: "banned" }));
    users.createRule = `${users.createRule} && ${C_NO_MODERATOR} && ${C_NO_BANNED}`;
    users.updateRule = `${users.updateRule} && ${C_NO_MODERATOR} && ${C_NO_BANNED}`;
    users.authRule = "banned = false";
    app.save(users);

    const rooms = app.findCollectionByNameOrId("rooms");
    if (!(rooms.updateRule ?? "").startsWith(`${ROOM_OWNER} && `)) throw new Error("rooms.updateRule doesn't start with its owner check");
    rooms.updateRule = ROOM_OWNER_OR_MODERATOR + (rooms.updateRule ?? "").slice(ROOM_OWNER.length);
    app.save(rooms);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("moderator");
    users.fields.removeByName("banned");
    for (const c of [C_NO_MODERATOR, C_NO_BANNED]) {
      users.createRule = (users.createRule ?? "").replace(` && ${c}`, "");
      users.updateRule = (users.updateRule ?? "").replace(` && ${c}`, "");
    }
    users.authRule = "";
    app.save(users);

    const rooms = app.findCollectionByNameOrId("rooms");
    rooms.updateRule = (rooms.updateRule ?? "").replace(ROOM_OWNER_OR_MODERATOR, ROOM_OWNER);
    app.save(rooms);
  },
);
