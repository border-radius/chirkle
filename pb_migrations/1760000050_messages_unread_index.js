/// <reference path="../types/pocketbase.d.ts" />
// Unread counts read only an index (REFACTOR item 26, server/unread.go unreadSQL): other people's messages that aren't
// deleted, by room and time, with their author. Each room's count is then a range scan of this index from the
// caller's read position, never a read of the messages themselves. Pages keep idx_messages_room_created.

const UNREAD_INDEX = "CREATE INDEX idx_messages_unread ON messages (room, created, author) WHERE deleted = FALSE";

/**
 * @param {Parameters<Parameters<typeof migrate>[0]>[0]} app
 * @param {boolean} up
 */
function apply(app, up) {
  const messages = app.findCollectionByNameOrId("messages");
  const indexes = /** @type {string[]} */ (/** @type {any} */ (messages).indexes).filter((i) => i !== UNREAD_INDEX);
  /** @type {any} */ (messages).indexes = up ? [...indexes, UNREAD_INDEX] : indexes;
  app.save(messages);
}

migrate(
  (app) => apply(app, true),
  (app) => apply(app, false),
);
