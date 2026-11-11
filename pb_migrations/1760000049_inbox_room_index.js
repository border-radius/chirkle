/// <reference path="../types/pocketbase.d.ts" />
// The inbox's counts per room (REFACTOR item 49, server/unread.go inboxMentionsSQL): an index on (user, room, created),
// so each room's count starts at the caller's read position there instead of going through every row of theirs. The
// list (newest first, all rooms) keeps using idx_inbox_user_created.

const INBOX_ROOM_INDEX = "CREATE INDEX idx_inbox_user_room_created ON inbox (user, room, created)";

/**
 * @param {Parameters<Parameters<typeof migrate>[0]>[0]} app
 * @param {boolean} up
 */
function apply(app, up) {
  const inbox = app.findCollectionByNameOrId("inbox");
  const indexes = /** @type {string[]} */ (/** @type {any} */ (inbox).indexes).filter((i) => i !== INBOX_ROOM_INDEX);
  /** @type {any} */ (inbox).indexes = up ? [...indexes, INBOX_ROOM_INDEX] : indexes;
  app.save(inbox);
}

migrate(
  (app) => apply(app, true),
  (app) => apply(app, false),
);
