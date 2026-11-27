/// <reference path="../types/pocketbase.d.ts" />
// Telegram media edits (DESIGN.md §26.4, §26.6): a Telegram message whose photo, video or file is replaced changes the
// chat message's attachment, and a chat message whose attachments the bridge or a linked instance replaced changes the
// Telegram messages that hold them.
// - tg_messages.files: the stored names (messages.files) a Telegram message holds, either way: which attachment an
//   album item is, and which Telegram message to edit for one.
// - tg_messages.file_ids: the file_unique_ids of what a Telegram message brought over: an edit with the same ones only
//   changes its caption.
// - tg_queue op "media": pass replaced attachments on to a group (payload.was: the stored names before).

/**
 * @param {MigrationApp} app
 * @param {string[]} values
 */
function setOps(app, values) {
  const queue = app.findCollectionByNameOrId("tg_queue");
  /** @type {any} */ (queue.fields.getByName("op")).values = values;
  app.save(queue);
}

migrate(
  (app) => {
    const tg = app.findCollectionByNameOrId("tg_messages");
    tg.fields.add(new JSONField({ name: "files", maxSize: 4000 }));
    tg.fields.add(new JSONField({ name: "file_ids", maxSize: 4000 }));
    app.save(tg);
    setOps(app, ["send", "edit", "delete", "album", "react", "fetch", "media"]);
  },
  (app) => {
    app.db().newQuery("DELETE FROM tg_queue WHERE op = 'media'").execute();
    setOps(app, ["send", "edit", "delete", "album", "react", "fetch"]);
    const tg = app.findCollectionByNameOrId("tg_messages");
    tg.fields.removeByName("files");
    tg.fields.removeByName("file_ids");
    app.save(tg);
  },
);
