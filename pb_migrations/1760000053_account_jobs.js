/// <reference path="../types/pocketbase.d.ts" />
// Account jobs (DESIGN.md §43.5): the work of "Your data" and "Delete account" that can be long on a big server, done
// by a worker (pb_hooks/lib/account.js) instead of in the request.
// - kind "export": a person's data, written a page at a time into `file` (a protected file, served only to them by
//   GET /api/chat/export/file); kept 7 days.
// - kind "erase": a deleted account's collections, deleted a batch of items at a time, then with `messages` its
//   messages, soft-deleted a batch at a time.
// No API rules: only the hooks read and write it.

const JOBS_ACCESS = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "account_jobs",
          ...JOBS_ACCESS,
          fields: [
            { type: "relation", name: "user", collectionId: users.id, cascadeDelete: true, maxSelect: 1, required: true },
            { type: "select", name: "kind", values: ["export", "erase"], maxSelect: 1, required: true },
            { type: "select", name: "state", values: ["queued", "done", "failed"], maxSelect: 1, required: true },
            { type: "file", name: "file", maxSelect: 1, maxSize: 4 * 1024 * 1024 * 1024, protected: true },
            { type: "number", name: "size", onlyInt: true, min: 0 },
            { type: "bool", name: "messages" },
            { type: "number", name: "tries", onlyInt: true, min: 0 },
            { type: "text", name: "error", max: 500 },
            { type: "date", name: "finished" },
            { type: "autodate", name: "created", onCreate: true },
            { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
          ],
          indexes: [
            "CREATE INDEX idx_account_jobs_state ON account_jobs (state, updated)",
            "CREATE INDEX idx_account_jobs_user ON account_jobs (user, kind, created)",
          ],
        }),
      ),
    );
  },
  (app) => {
    app.delete(app.findCollectionByNameOrId("account_jobs"));
  },
);
