/// <reference path="../types/pocketbase.d.ts" />
// Handles the hooks keep for what may one day mean everyone in a room ("all", "everyone", "here", "room", "channel",
// pb_hooks/lib/handles.js RESERVED) were given by 1760000045_mentions.js to accounts named so: "@all" mentioned
// whoever is called All (QA BUG-256). Each gets the first free one after it ("all2", "all3"…), as a new account would.

const RESERVED = ["all", "everyone", "here", "room", "channel"];

migrate(
  (app) => {
    const rows = arrayOf(new DynamicModel({ id: "", handle: "" }));
    app
      .db()
      .newQuery(`SELECT id, handle FROM users WHERE handle IN (${RESERVED.map((h) => `'${h}'`).join(", ")}) ORDER BY created, id`)
      .all(rows);
    for (const row of rows) {
      let handle = "";
      for (let n = 2; ; n++) {
        handle = `${row.handle}${n}`;
        const hit = new DynamicModel({ n: 0 });
        app.db().newQuery("SELECT COUNT(*) AS n FROM users WHERE handle = {:h}").bind({ h: handle }).one(hit);
        if (hit.n === 0) break;
      }
      app.db().newQuery("UPDATE users SET handle = {:h} WHERE id = {:id}").bind({ h: handle, id: row.id }).execute();
    }
  },
  () => {
    // Nothing to undo: the old handles are refused now.
  },
);
