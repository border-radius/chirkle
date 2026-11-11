/// <reference path="../types/pocketbase.d.ts" />
// Server-side hooks (DESIGN.md §5.6, §16, §18, §20, §21, §22, §23, §24, §28, §30, §31, §36, §37, §40; docs/ANDROID.md §9.4). Logic lives in lib/, one module per collection
// or route: PocketBase hook handlers can't see top-level variables, so each handler require()s its module.

onBootstrap((e) => {
  e.next(); // the settings are loaded once bootstrapped
  require(`${__hooks}/lib/http.js`).trustProxy(e.app);
});

// No routerUse with a JS handler here: it holds a JS runtime of the pool (--hooksPool) for the whole request, so every
// open realtime connection and every file on its way from S3 would keep some, and room pages, whose enrich hooks need
// one each, would make new ones (docs/PERF.md §6). What one would do for every request is done by the routes and hooks
// it concerns: the headers by the routes that serve pages (lib/http.js), the body limit by PocketBase (it sizes each
// collection's create and update by its fields, DESIGN.md §17.1), the files and the anonymous rooms' checks below.

// Nobody but superusers finds out who wrote a message in an anonymous room by filtering, sorting or expanding (§35):
// checked by everything that takes a filter, sort or expand (the routes here that enrich records do too).
onRecordsListRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  e.next();
});
onRecordViewRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  e.next();
});
onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  e.next();
});
onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  e.next();
});
// Every auth answer (password, OAuth2, OTP, refresh, impersonation) has the record, expanded as asked.
onRecordAuthRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseProbes(e);
  e.next();
});
onRealtimeSubscribeRequest((e) => {
  require(`${__hooks}/lib/anonymous.js`).refuseSubscriptionProbes(e);
  // Which app the connection is, and its account active today, for the statistics (§40).
  require(`${__hooks}/lib/stats.js`).subscribed(e);
  e.next();
});

// A message's or collection item's file is its shared `files` row's (§37): served without a file token, by routes more
// specific than PocketBase's /api/files/{collection}/… (lib/files.js serve). The rows themselves never directly.
routerAdd("GET", "/api/files/messages/{recordId}/{filename}", (e) => require(`${__hooks}/lib/files.js`).serve(e, "messages"));
routerAdd("GET", "/api/files/collection_items/{recordId}/{filename}", (e) =>
  require(`${__hooks}/lib/files.js`).serve(e, "collection_items"),
);
onFileDownloadRequest(() => {
  throw new NotFoundError();
}, "files");

// The app's pages (index.html at any path that isn't a file, §7.1) and its files, with their headers (§5.6).
routerAdd("GET", "/{path...}", (e) => require(`${__hooks}/lib/http.js`).page(e));
// Not the app's index.html for a missing asset or API.
routerAdd("GET", "/stats", (e) => require(`${__hooks}/lib/http.js`).statsPage(e));
routerAdd("GET", "/assets/{path...}", (e) => require(`${__hooks}/lib/http.js`).asset(e));
routerAdd("GET", "/manifest.webmanifest", (e) => {
  require(`${__hooks}/lib/http.js`).headers(e);
  return require(`${__hooks}/lib/site.js`).manifest(e);
});
routerAdd("GET", "/.well-known/assetlinks.json", (e) => {
  require(`${__hooks}/lib/http.js`).headers(e);
  return require(`${__hooks}/lib/site.js`).assetLinks(e);
});
routerAdd("GET", "/api/{path...}", () => {
  throw new NotFoundError();
});
routerAdd("POST", "/api/previews/tick", (e) => require(`${__hooks}/lib/previews.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("GET", "/api/chat/rooms", (e) => require(`${__hooks}/lib/lists.js`).rooms(e));
routerAdd("GET", "/api/chat/rooms/{room}/messages", (e) => require(`${__hooks}/lib/lists.js`).messages(e));
routerAdd("GET", "/api/chat/notifiable", (e) => require(`${__hooks}/lib/lists.js`).notifiable(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/dms", (e) => require(`${__hooks}/lib/dms.js`).openDm(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/live", (e) => require(`${__hooks}/lib/live.js`).info(e));
routerAdd("GET", "/api/chat/unread", (e) => require(`${__hooks}/lib/reads.js`).unread(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/unread/{room}", (e) => require(`${__hooks}/lib/reads.js`).firstUnread(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/reads", (e) => require(`${__hooks}/lib/reads.js`).markRead(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/reactions", (e) => require(`${__hooks}/lib/reactions.js`).react(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/delete", (e) => require(`${__hooks}/lib/bulk.js`).deleteMessages(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/ban", (e) => require(`${__hooks}/lib/moderation.js`).ban(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/forward", (e) => require(`${__hooks}/lib/bulk.js`).forward(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/media/{room}", (e) => require(`${__hooks}/lib/media.js`).list(e));
routerAdd("GET", "/api/chat/posters/{message}/{file}", (e) => require(`${__hooks}/lib/media.js`).poster(e));
routerAdd("GET", "/api/chat/posters/items/{item}/{file}", (e) => require(`${__hooks}/lib/media.js`).itemPoster(e));
routerAdd("GET", "/api/chat/collections", (e) => require(`${__hooks}/lib/collections.js`).list(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/badges", (e) => require(`${__hooks}/lib/collections.js`).badges(e));
routerAdd("POST", "/api/chat/items", (e) => require(`${__hooks}/lib/collections.js`).saveItem(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/saved", (e) => require(`${__hooks}/lib/collections.js`).saved(e), $apis.requireAuth("users"));
routerAdd("DELETE", "/api/chat/items/{id}", (e) => require(`${__hooks}/lib/collections.js`).removeItem(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/subs", (e) => require(`${__hooks}/lib/collections.js`).subscribe(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/subs/seen", (e) => require(`${__hooks}/lib/collections.js`).markSeen(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/keepalive/tick", (e) => require(`${__hooks}/lib/keepalive.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("GET", "/api/chat/stats", (e) => require(`${__hooks}/lib/stats.js`).get(e));
routerAdd("POST", "/api/stats/tick", (e) => require(`${__hooks}/lib/stats.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("POST", "/api/media/tick", (e) => require(`${__hooks}/lib/media.js`).tick(e), $apis.requireSuperuserAuth());
routerAdd("GET", "/api/chat/users", (e) => require(`${__hooks}/lib/users.js`).searchUsers(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/mentionable", (e) => require(`${__hooks}/lib/handles.js`).mentionable(e), $apis.requireAuth("users"));
routerAdd("GET", "/api/chat/inbox", (e) => require(`${__hooks}/lib/inbox.js`).list(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/inbox/seen", (e) => require(`${__hooks}/lib/inbox.js`).markSeen(e), $apis.requireAuth("users"));
routerAdd("POST", "/api/chat/password", (e) => require(`${__hooks}/lib/account.js`).changePassword(e), $apis.requireAuth("users"));

// The core collections' hooks (messages, rooms, users) are all here, with the optional features' parts (lib/features.js)
// called in order: the federation's first, then the core's, then the Telegram bridge's; after the save, the other way
// round.

onRecordCreate((e) => {
  require(`${__hooks}/lib/users.js`).beforeUserSave(e);
  e.next();
}, "users");

onRecordUpdate((e) => {
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  // A changed profile goes to the peers that know it (§33).
  const profile = fed && e.record ? fed.people.profileKey(e.record.original()) : "";
  require(`${__hooks}/lib/users.js`).beforeUserSave(e);
  // A ban ends their sessions (§36).
  const moderation = require(`${__hooks}/lib/moderation.js`);
  const banned = !!e.record && moderation.beforeBan(e.record);
  e.next();
  if (banned && e.record) moderation.afterBan(e.app, e.record.id);
  if (fed && e.record) fed.people.userChanged(e.app, e.record, profile);
}, "users");

// Names ending in a peer's label are its people's (§33), and a Telegram stand-in's are the bridge's (§26).
onRecordUpdateRequest((e) => {
  const features = require(`${__hooks}/lib/features.js`);
  features.federation(e.app)?.people.refuseLabelName(e);
  features.telegram()?.people.refuseStandInName(e);
  e.next();
}, "users");

onRecordDelete((e) => {
  require(`${__hooks}/lib/messages.js`).beforeUserDelete(e);
  e.next();
}, "users");

onRecordCreateRequest((e) => {
  const features = require(`${__hooks}/lib/features.js`);
  features.federation(e.app)?.people.refuseLabelName(e);
  require(`${__hooks}/lib/site.js`).checkInvite(e);
  features.telegram()?.people.refuseStandInName(e);
  require(`${__hooks}/lib/users.js`).checkPasswordLength(e.requestInfo().body.password);
  e.next();
}, "users");

onRecordAuthWithOAuth2Request((e) => {
  require(`${__hooks}/lib/site.js`).checkOAuth2Signup(e);
  require(`${__hooks}/lib/moderation.js`).refuseBanned(e.record, null);
  e.next();
}, "users");

onRecordAuthWithPasswordRequest((e) => {
  require(`${__hooks}/lib/users.js`).findLoginByEmail(e);
  // A banned account is told so (§36).
  require(`${__hooks}/lib/moderation.js`).refuseBanned(e.record, e.password);
  e.next();
}, "users");

onRecordRequestPasswordResetRequest((e) => require(`${__hooks}/lib/users.js`).skipStandInReset(e), "users");
onRecordConfirmPasswordResetRequest((e) => {
  require(`${__hooks}/lib/users.js`).checkPasswordLength(e.requestInfo().body.password);
  e.next();
}, "users");

onRecordEnrich((e) => {
  require(`${__hooks}/lib/site.js`).showPasswordReset(e);
  e.next();
}, "site");

onRecordCreateRequest((e) => {
  require(`${__hooks}/lib/rooms.js`).beforeRoomCreateRequest(e);
  e.next();
}, "rooms");

onRecordUpdateRequest((e) => {
  // A shared room's members (§33.5): checked against what each side may change, and sent once saved.
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  if (fed) fed.rooms.checkHomeMembers(e);
  const members = fed ? fed.mirror.checkMirrorEdit(e) : null;
  require(`${__hooks}/lib/rooms.js`).beforeRoomUpdateRequest(e);
  e.next();
  if (fed && members && e.record) fed.mirror.sendMembers(e.app, e.record, members);
}, "rooms");

onRecordCreate((e) => {
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  require(`${__hooks}/lib/rooms.js`).beforeRoomCreate(e);
  e.next();
  // A DM opened with someone on a peer is shared with it (§33).
  if (fed && e.record) fed.rooms.roomCreated(e.app, e.record);
}, "rooms");

onRecordUpdate((e) => {
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  const state = fed && e.record ? fed.rooms.stateOf(e.record.original()) : "";
  require(`${__hooks}/lib/rooms.js`).beforeRoomUpdate(e);
  const access = require(`${__hooks}/lib/access.js`);
  const before = access.accessOf(e.record?.original() ?? e.record);
  e.next();
  // Saved: whoever can't see it any more is told (§23.4).
  if (e.record) access.dropLostAccess(e.app, before, e.record);
  // Its anonymous messages show its new name (§35).
  if (e.record) require(`${__hooks}/lib/anonymous.js`).forget(e.app, e.record.id);
  // A home room's changes go to its mirrors (§33).
  if (fed && e.record) fed.rooms.roomChanged(e.app, e.record, state);
}, "rooms");

onRecordDelete((e) => {
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  const room = e.record;
  const peers = fed && room ? fed.rooms.peersToTell(e.app, room) : [];
  e.next();
  if (room) require(`${__hooks}/lib/anonymous.js`).forget(e.app, room.id);
  if (fed && room) fed.rooms.tellDeleted(e.app, room, peers);
}, "rooms");

onRecordCreateRequest((e) => {
  const messages = require(`${__hooks}/lib/messages.js`);
  messages.beforeMessageCreateRequest(e);
  // One transaction for the attachments' `files` rows (uploads, and files attached from collections, §31, §37) and
  // the message: refused, nothing is left stored.
  e.app.runInTransaction((tx) => {
    e.app = tx;
    messages.setRequestFiles(e);
    e.next();
  });
}, "messages");

onRecordCreate((e) => {
  require(`${__hooks}/lib/collections.js`).beforeCollectionSave(e);
  e.next();
}, "collections");

onRecordUpdate((e) => {
  const collections = require(`${__hooks}/lib/collections.js`);
  collections.beforeCollectionSave(e);
  const wasPublic = !!e.record && e.record.original().getBool("public");
  e.next();
  if (e.record) collections.afterCollectionUpdate(e.app, e.record, wasPublic);
}, "collections");

// What its files' badges say may have changed (§31). Once it is saved: told earlier, a client asking at once could
// still read it as it was.
onRecordAfterUpdateSuccess((e) => {
  if (e.record) require(`${__hooks}/lib/collections.js`).afterCollectionSaved(e.app, e.record);
  e.next();
}, "collections");

onRecordAfterDeleteSuccess((e) => {
  if (e.record) require(`${__hooks}/lib/collections.js`).tellBadges(e.app, e.record.id);
  e.next();
}, "collections");

// An item taken out (or its collection, or its owner, deleted): its file is named once less (§37).
onRecordDelete((e) => {
  const files = require(`${__hooks}/lib/files.js`);
  const names = e.record ? files.namedBy(e.app, "collection_items", e.record.id) : [];
  e.next();
  files.unlink(e.app, names);
}, "collection_items");

// A message deleted for good (a superuser, its room): its files are named once less (§37). A deleted one has none.
onRecordDelete((e) => {
  const files = require(`${__hooks}/lib/files.js`);
  const names = e.record ? files.namedBy(e.app, "messages", e.record.id) : [];
  e.next();
  files.unlink(e.app, names);
}, "messages");

onRecordCreate((e) => {
  const messages = require(`${__hooks}/lib/messages.js`);
  messages.beforeMessageCreate(e);
  const features = require(`${__hooks}/lib/features.js`);
  if (e.record) {
    messages.setTextKey(e.record);
    // Who it mentions (§41): from its text, or as the linked instance it comes from says.
    const fed = features.federation(e.app);
    require(`${__hooks}/lib/handles.js`).setMentions(e.app, e.record, !!fed && fed.messages.isFromPeer(e.app, e.record));
  }
  e.next();
  const rec = e.record;
  if (!rec) return;
  // Saved: whom it tells (§41), and what each feature does with a new message is queued, in the save's transaction.
  require(`${__hooks}/lib/inbox.js`).messageCreated(e.app, rec);
  features.telegram()?.outbound.queueCreate(e.app, rec);
  require(`${__hooks}/lib/previews.js`).queue(e.app, rec);
  require(`${__hooks}/lib/media.js`).add(e.app, rec);
  features.federation(e.app)?.messages.messageCreated(e.app, rec);
}, "messages");

onRecordAfterCreateSuccess((e) => {
  require(`${__hooks}/lib/messages.js`).afterMessageCreate(e);
  e.next();
}, "messages");

// Live (lib/live.js): each message once to everyone listening who can see its room, once committed. A failure to send
// is logged, never the save's: the apps load what they missed when they reconnect.
onRecordAfterCreateSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/live.js`).sendSafely(e.app, e.record, "create");
}, "messages");
onRecordAfterUpdateSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/live.js`).sendSafely(e.app, e.record, "update");
}, "messages");
onRecordAfterDeleteSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/live.js`).sendSafely(e.app, e.record, "delete");
}, "messages");

// The inbox (§41): each row added or removed, once committed, to its person's apps.
onRecordAfterCreateSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/inbox.js`).tell(e.app, e.record, "create");
}, "inbox");
onRecordAfterDeleteSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/inbox.js`).tell(e.app, e.record, "delete");
}, "inbox");

// Committed (with the message that queued it): the workers look at it now, not on their next look round.
onRecordAfterCreateSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/previews.js`).wake(e.app);
}, "link_queue");

// A new file (an attachment, an upload into a collection) is committed: the media worker looks at it now
// (lib/worker.js wake).
onRecordAfterCreateSuccess((e) => {
  e.next();
  require(`${__hooks}/lib/media.js`).wake(e.app);
}, "files");

onRecordUpdate((e) => {
  const rec = e.record;
  if (!rec) return e.next();
  const features = require(`${__hooks}/lib/features.js`);
  // Messages in shared rooms (§33.5): what it was, and a mirror's message changed only as its home allows.
  const fed = features.federation(e.app);
  const was = fed ? fed.messages.before(rec) : null;
  if (fed) fed.messages.checkMirrorChange(e.app, rec);
  const messages = require(`${__hooks}/lib/messages.js`);
  const inbox = require(`${__hooks}/lib/inbox.js`);
  const told = inbox.before(rec);
  messages.beforeMessageUpdate(e);
  messages.setTextKey(rec);
  require(`${__hooks}/lib/handles.js`).setMentions(e.app, rec, !!fed && fed.messages.isFromPeer(e.app, rec));
  const touch = messages.changesForwards(rec);
  const edited = rec.getString("text") !== rec.original().getString("text");
  const deleted = rec.getBool("deleted") && !rec.original().getBool("deleted");
  // As stored, not as loaded: another delete of it may have been committed since (QA BUG-223).
  const files = deleted ? require(`${__hooks}/lib/files.js`).namedBy(e.app, "messages", rec.id) : [];
  const tg = features.telegram();
  const change = tg ? tg.outbound.changeOf(e.app, rec) : "";
  e.next();
  // Saved: mentions, replies and reactions told or taken back (§41).
  inbox.messageChanged(e.app, rec, told);
  if (tg) tg.outbound.queueUpdate(e.app, rec, change);
  // Saved: a deleted message's media leave the grid, its forwards' too (§30.1), and its files are named once less (§37).
  if (deleted) require(`${__hooks}/lib/media.js`).drop(e.app, rec.id);
  if (deleted) require(`${__hooks}/lib/files.js`).unlink(e.app, files);
  // Saved: forwards of it tell their readers (§21.3).
  if (touch) messages.touchForwards(e.app, rec);
  if (edited) require(`${__hooks}/lib/previews.js`).queue(e.app, rec);
  if (fed && was) fed.messages.messageChanged(e.app, rec, was);
}, "messages");

onRecordEnrich((e) => {
  const enrich = require(`${__hooks}/lib/enrich.js`);
  // lib/messages.js only for the messages that need it: loading it costs more than the rest (lib/enrich.js).
  if (enrich.needsWork(e)) {
    const messages = require(`${__hooks}/lib/messages.js`);
    messages.keepToRoom(e);
    messages.showOriginal(e);
  }
  e.next();
  // An anonymous room's message shows the room, not its author (§35): once expanded (in next()), by the real author.
  if (enrich.isAnonymous(e)) require(`${__hooks}/lib/anonymous.js`).hide(e);
}, "messages");

onRecordUpdateRequest((e) => {
  require(`${__hooks}/lib/messages.js`).beforeMessageUpdateRequest(e);
  // One transaction for the save, so beforeMessageUpdate reads the reactions it keeps right before writing (§20.2).
  e.app.runInTransaction((tx) => {
    e.app = tx;
    e.next();
  });
}, "messages");

// Link previews (§28): fetched by a worker, a minute's run at a time.
if (require(`${__hooks}/lib/previews.js`).enabled()) {
  cronAdd("previews", "* * * * *", () => require(`${__hooks}/lib/previews.js`).run($app));
}

// Quiet realtime connections kept open: PocketBase closes them after 5 minutes, and clients then load everything again
// (lib/keepalive.js).
cronAdd("keepalive", "*/3 * * * *", () => require(`${__hooks}/lib/keepalive.js`).run($app));

// Usage statistics (§40): a sample of who is online every 5 minutes (unless site.no_stats), old rows dropped daily.
// STATS_CRON=off leaves them to POST /api/stats/tick (tests).
if ($os.getenv("STATS_CRON").trim().toLowerCase() !== "off") {
  cronAdd("stats", "*/5 * * * *", () => require(`${__hooks}/lib/stats.js`).run($app));
  cronAdd("stats-prune", "23 3 * * *", () => require(`${__hooks}/lib/stats.js`).prune($app));
}

// The media grid's thumbnails and video posters (§30.1): made by a worker, a minute's run at a time. MEDIA_CRON=off
// leaves them to POST /api/media/tick (tests).
if ($os.getenv("MEDIA_CRON").trim().toLowerCase() !== "off") {
  cronAdd("media", "* * * * *", () => require(`${__hooks}/lib/media.js`).run($app));
}
