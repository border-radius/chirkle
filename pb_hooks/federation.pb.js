/// <reference path="../types/pocketbase.d.ts" />
// Linked instances (DESIGN.md §33): rooms and DMs shared with other servers running this app, paired by their admins.
// Self-contained like the Telegram bridge: this file, federation/ and the fed_* collections (pb_migrations/
// 1760000032_federation.js); the core only has the fields that migration adds.
//
// On while the site record's `federation` is ticked, with this server's address taken from the Application URL
// (federation/config.js). Off, the /api/fed/ routes answer 404 and the worker sends nothing. The record hooks are
// always registered but skip at once while there is no fed_peers row (`inUse`), so an instance that never linked pays
// one cached lookup.
//
// What it does on the core collections' saves (rooms, users, messages) main.pb.js calls, through lib/features.js, in the
// order stated there: it reads a record as it was, lets the save go on, then queues what a peer needs to hear, in the
// save's transaction. Here: its routes, its worker, and the hooks of its own collections.

routerAdd("POST", "/api/fed/request", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/peers.js`).request(e);
});
routerAdd("POST", "/api/fed/verify", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/peers.js`).verifyRequest(e);
});
routerAdd("POST", "/api/fed/cancel", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/peers.js`).cancel(e);
});
routerAdd("POST", "/api/fed/pair", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/peers.js`).pair(e);
});
routerAdd("POST", "/api/fed/inbox", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/inbox.js`).inbox(e);
});
// GET /api/fed/files/{message}/{file} and /api/fed/avatars/{user} are in Go (server/federation.go).
routerAdd("GET", "/api/fed/users", (e) => {
  require(`${__hooks}/federation/config.js`).requireOn(e.app);
  return require(`${__hooks}/federation/inbox.js`).lookup(e);
});
routerAdd(
  "POST",
  "/api/fed/tick",
  (e) => {
    require(`${__hooks}/federation/config.js`).requireOn(e.app);
    return require(`${__hooks}/federation/worker.js`).tick(e);
  },
  $apis.requireSuperuserAuth(),
);
routerAdd(
  "POST",
  "/api/chat/remote-users",
  (e) => {
    require(`${__hooks}/federation/config.js`).requireOn(e.app);
    return require(`${__hooks}/federation/inbox.js`).remoteUser(e);
  },
  $apis.requireAuth("users"),
);

cronAdd("federation", "* * * * *", () => {
  if (require(`${__hooks}/federation/config.js`).enabled($app)) require(`${__hooks}/federation/worker.js`).run($app);
});

// The switch (§33.2): on only with an Application URL that can be linked with; that URL's host is in every global id
// the peers keep, so it stays while any instance is listed.
onRecordUpdateRequest((e) => {
  const rec = e.record;
  if (rec?.getBool("federation") && !rec.original().getBool("federation")) {
    const problem = require(`${__hooks}/federation/config.js`).originProblem();
    if (problem) throw require(`${__hooks}/lib/records.js`).fieldError("federation", problem);
  }
  e.next();
}, "site");

onSettingsUpdateRequest((e) => {
  const { hostOf, originProblem } = require(`${__hooks}/federation/config.js`);
  const old = e.oldSettings?.meta.appURL || "";
  const was = hostOf(old);
  const now = hostOf(e.newSettings?.meta.appURL || "");
  // An old URL that could never be linked with (PocketBase's default, say) is no one's global ids: set it freely.
  if (was !== now && !originProblem(old) && e.app.findRecordsByFilter("fed_peers", "", "", 1, 0).length) {
    const msg = `Linked instances know this server as ${was}: delete them in Collections → fed_peers before changing its address.`;
    throw new BadRequestError(msg, { meta: { appURL: new ValidationError("validation_fed_paired", msg) } });
  }
  e.next();
});

// Whether any fed_peers row exists, for the record hooks' `inUse`: asked again after every create and delete.
onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/federation/config.js`).forgetInUse(e.app);
  e.next();
}, "fed_peers");

onRecordAfterDeleteSuccess((e) => {
  require(`${__hooks}/federation/config.js`).forgetInUse(e.app);
  e.next();
}, "fed_peers");

// Pairing (§33.3): superusers, in the admin UI.
onRecordCreateRequest((e) => {
  require(`${__hooks}/federation/peers.js`).beforePeerCreate(e);
  e.next();
}, "fed_peers");

onRecordUpdateRequest((e) => {
  const peers = require(`${__hooks}/federation/peers.js`);
  const changed = peers.beforePeerEdit(e);
  e.next();
  if (e.record) peers.afterPeerEdit(e.app, e.record, changed);
}, "fed_peers");

onRecordDeleteRequest((e) => {
  if (e.record) require(`${__hooks}/federation/peers.js`).beforePeerDelete(e.app, e.record);
  e.next();
}, "fed_peers");

// Sharing rooms (§33.5): superusers on both sides, in the admin UI.
onRecordCreateRequest((e) => {
  const rooms = require(`${__hooks}/federation/rooms.js`);
  rooms.beforeOffer(e);
  e.next();
  if (e.record) rooms.afterOffer(e.app, e.record);
}, "fed_shares");

onRecordUpdateRequest((e) => {
  const rooms = require(`${__hooks}/federation/rooms.js`);
  const what = rooms.beforeShareEdit(e);
  e.next();
  if (e.record) rooms.afterShareEdit(e.app, e.record, what);
}, "fed_shares");

onRecordDeleteRequest((e) => {
  if (e.record) require(`${__hooks}/federation/rooms.js`).beforeShareDelete(e.app, e.record);
  e.next();
}, "fed_shares");
