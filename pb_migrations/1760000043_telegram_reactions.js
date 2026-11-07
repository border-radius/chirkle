/// <reference path="../types/pocketbase.d.ts" />
// Telegram bridge (DESIGN.md §26.9): tg_queue's "react" op, which sets the bot's reaction on a Telegram message to
// what its chat message's reactions are.

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
  (app) => setOps(app, ["send", "edit", "delete", "album", "react"]),
  (app) => {
    app.db().newQuery("DELETE FROM tg_queue WHERE op = 'react'").execute();
    setOps(app, ["send", "edit", "delete", "album"]);
  },
);
