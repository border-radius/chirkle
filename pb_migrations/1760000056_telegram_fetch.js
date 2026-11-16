/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26.4): tg_queue's "fetch" op, Telegram messages whose files couldn't be downloaded for
// now (no answer from Telegram), which the worker brings over once they can be.

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
  (app) => setOps(app, ["send", "edit", "delete", "album", "react", "fetch"]),
  (app) => {
    app.db().newQuery("DELETE FROM tg_queue WHERE op = 'fetch'").execute();
    setOps(app, ["send", "edit", "delete", "album", "react"]);
  },
);
