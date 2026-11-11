/// <reference path="../types/pocketbase.d.ts" />
// One inbox row for all of someone's reactions to a message (2026-11-11, user: "make all reactions from one user to
// one message a single notification"): before, each emoji was a row. Keeps the newest row of each person's reactions to
// a message, with `emoji` "" (GET /api/chat/inbox names their emoji from the message, pb_hooks/lib/inbox.js).

migrate(
  (app) => {
    app
      .db()
      .newQuery(
        `DELETE FROM inbox WHERE kind = 'reaction' AND id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY user, message, actor ORDER BY created DESC, id DESC) AS n
             FROM inbox WHERE kind = 'reaction'
           ) WHERE n = 1
         )`,
      )
      .execute();
    app.db().newQuery("UPDATE inbox SET emoji = '' WHERE kind = 'reaction'").execute();
  },
  () => {
    // Nothing to undo: one row per emoji can't be told apart again, and one per person still works.
  },
);
