/// <reference path="../types/pocketbase.d.ts" />
// Usage statistics (DESIGN.md §40): what the /stats page shows moderators and superusers, as counts only.
// - `stats_samples`: every 5 minutes, how many were online (people, guests, on the web, on Android). No ids.
// - `stats_activity`: one row per account and (UTC) day it was online, with when it last was: who was active in the
//   last day, week and month is counted from it. Nobody reads it through the API; it goes after 90 days, the
//   samples after a year (pb_hooks/lib/stats.js prune).
// - `site.no_stats`: ticked by a superuser, nothing more is recorded (what there is still ages out).
// - An index on messages.created: the page counts the last 30 days' messages.

/** @param {Record<string, unknown>} data */
const statsCollection = (data) => new Collection(/** @type {any} */ (data));
const NO_ACCESS = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
const MESSAGES_INDEX = "CREATE INDEX idx_messages_created ON messages (created)";

migrate(
  (app) => {
    const site = app.findCollectionByNameOrId("site");
    site.fields.add(new BoolField({ name: "no_stats", hidden: true }));
    app.save(site);

    const users = app.findCollectionByNameOrId("users");
    app.save(
      statsCollection({
        type: "base",
        name: "stats_samples",
        ...NO_ACCESS,
        fields: [
          { type: "date", name: "at", required: true },
          { type: "number", name: "online", onlyInt: true, min: 0 },
          { type: "number", name: "guests", onlyInt: true, min: 0 },
          { type: "number", name: "web", onlyInt: true, min: 0 },
          { type: "number", name: "android", onlyInt: true, min: 0 },
        ],
        indexes: ["CREATE INDEX idx_stats_samples_at ON stats_samples (at)"],
      }),
    );
    app.save(
      statsCollection({
        type: "base",
        name: "stats_activity",
        ...NO_ACCESS,
        fields: [
          { type: "relation", name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true },
          { type: "text", name: "day", required: true, max: 10 },
          { type: "date", name: "last_at", required: true },
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_stats_activity_user_day ON stats_activity (user, day)",
          "CREATE INDEX idx_stats_activity_last ON stats_activity (last_at)",
          "CREATE INDEX idx_stats_activity_day ON stats_activity (day)",
        ],
      }),
    );

    const messages = app.findCollectionByNameOrId("messages");
    /** @type {any} */ (messages).indexes = [.../** @type {string[]} */ (/** @type {any} */ (messages).indexes), MESSAGES_INDEX];
    app.save(messages);
  },
  (app) => {
    for (const name of ["stats_activity", "stats_samples"]) app.delete(app.findCollectionByNameOrId(name));
    const site = app.findCollectionByNameOrId("site");
    site.fields.removeByName("no_stats");
    app.save(site);
    const messages = app.findCollectionByNameOrId("messages");
    /** @type {any} */ (messages).indexes = /** @type {string[]} */ (/** @type {any} */ (messages).indexes).filter(
      (i) => i !== MESSAGES_INDEX,
    );
    app.save(messages);
  },
);
