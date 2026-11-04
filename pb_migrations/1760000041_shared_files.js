/// <reference path="../types/pocketbase.d.ts" />
// Shared files (DESIGN.md §37): every stored file once, as a row of `files`, which messages and collection items name.
// Saving to a collection or attaching from one adds a name instead of a copy; the file goes once nothing names it.
//
// - files: the file (not protected: no file token, §37.3) with the thumbnails messages had, its original name, whether
//   it is a video, its shape (§17.5), and the media worker's state (ready: thumbnails or poster made; sized: shape read;
//   poster). `refs`: how many messages and items name it. No API access: messages and items serve it (lib/files.js).
// - messages.files and collection_items.file become plain names (json, text): the same values the clients read now.
// - The files there are move into it: each message's own, and each item's, except an item saved from a message file
//   (or another item) that is still there, which names that file and whose copy goes. Only the database here: nothing
//   stored is read or copied, so the server starts in seconds whatever the storage (on S3, a copy each file took
//   minutes for a few hundred messages, with nothing served meanwhile). Each row's `src` says where its file still is;
//   the media worker moves it to the row's folder afterwards, and it is served from where it is until then (§37.5).
//   The item copies that go are left to the worker too (storage_cleanup), once this is committed.
// - The media index and collection items no longer keep the worker's state: the file's row does.
// - Going down copies every file back to each message and item that names it.

// In a function of its own: these names stay this file's.
(() => {
  const C_THUMBS = ["800x480f", "480x240f", "240x240"];
  const C_MAX_SIZE = 20 * 1024 * 1024;
  const C_NO_FILES = "@request.body.files:isset = false";
  /**
   * The JSON field `files` takes as much as 10 files of 20 MB did: PocketBase holds a create's body to the sum of its
   * fields' sizes, and the uploads come in its request (lib/messages.js setRequestFiles), not in a file field of its own.
   * The value saved is only the names.
   */
  const C_FILES_BODY = 10 * C_MAX_SIZE;

  /** @typedef {Parameters<Parameters<typeof migrate>[0]>[0]} MigrationApp */

  const newId = () => $security.randomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789");

  /** @param {string} s @param {any} fallback */
  function parse(s, fallback) {
    try {
      const v = JSON.parse(s || "null");
      return v === null || v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  }

  /** @param {string} name */
  function isVideo(name) {
    const dot = name.lastIndexOf(".");
    return ["mp4", "m4v", "webm", "mov", "ogv"].includes(dot < 0 ? "" : name.slice(dot + 1).toLowerCase());
  }

  /**
   * Copy a stored file (key `from`) to `to`, with what PocketBase and the media worker keep next to it (thumbs_{name}/:
   * thumbnails, poster) when the name stays. Whether the file was there. Going down only.
   * @param {filesystem.System} fs
   * @param {string} from
   * @param {string} to
   */
  function copyKey(fs, from, to) {
    if (from === to || !fs.exists(from)) return from === to;
    fs.copy(from, to);
    const name = (/** @type {string} */ k) => k.slice(k.lastIndexOf("/") + 1);
    if (name(from) !== name(to)) return true;
    const dir = (/** @type {string} */ k) => `${k.slice(0, k.lastIndexOf("/"))}/thumbs_${name(k)}/`;
    const thumbs = dir(from);
    for (const obj of fs.list(thumbs)) {
      if (!obj || obj.key.endsWith(".attrs")) continue;
      fs.copy(obj.key, `${dir(to)}${obj.key.slice(thumbs.length)}`);
    }
    return true;
  }

  /**
   * A stored name not taken yet in `files` (PocketBase's names are random, but two records could have had the same).
   * @param {MigrationApp} app
   * @param {string} name
   */
  function freeName(app, name) {
    const taken = (/** @type {string} */ n) => count(app, "SELECT COUNT(*) AS n FROM files WHERE file = {:n}", { n }) > 0;
    if (!taken(name)) return name;
    for (;;) {
      const dot = name.lastIndexOf(".");
      const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/_[a-z0-9]{10}$/, "");
      const next = `${stem}_${$security.randomStringWithAlphabet(10, "abcdefghijklmnopqrstuvwxyz0123456789")}${dot > 0 ? name.slice(dot) : ""}`;
      if (!taken(next)) return next;
    }
  }

  /** @param {MigrationApp} app @param {string} sql @param {Record<string, any>} params */
  function count(app, sql, params) {
    const row = new DynamicModel({ n: 0 });
    app.db().newQuery(sql).bind(params).one(row);
    return row.n;
  }

  /**
   * A new `files` row for the stored file `name` of folder `from` (`as` in `files`), which stays where it is
   * (`src`) until the media worker moves it. `done`: what the worker had made of it (thumbnails, poster), as the old
   * columns say.
   * @param {MigrationApp} app
   * @param {{ from: string, name: string, as: string, original: string, dims: any, created: string, done: { ready: boolean, poster: boolean } }} f
   */
  function addRow(app, f) {
    const id = newId();
    const video = isVideo(f.as);
    // Renamed: its thumbnails carry the old name, and are made again once it is moved.
    const kept = f.as === f.name;
    const poster = kept && video && f.done.poster;
    const dims = Array.isArray(f.dims) && f.dims.length === 2 ? JSON.stringify(f.dims) : "null";
    app
      .db()
      .newQuery(
        `INSERT INTO files (id, file, name, video, dims, poster, ready, sized, refs, src, created)
       VALUES ({:id}, {:file}, {:name}, {:video}, {:dims}, {:poster}, {:ready}, {:sized}, 0, {:src}, {:created})`,
      )
      .bind({
        id,
        file: f.as,
        name: String(f.original || f.as).slice(0, 200),
        video,
        dims,
        poster,
        // What the worker had made stays: a video without its poster, or a file renamed, gets another look.
        ready: kept && f.done.ready && (!video || poster),
        sized: dims !== "null" || !video,
        src: `${f.from}/${f.name}`,
        created: f.created,
      })
      .execute();
    return id;
  }

  /**
   * What the worker had made of a message's file (the media index's columns); a file not in the index has nothing to make.
   * @param {MigrationApp} app
   * @param {string} message
   * @param {string} name
   */
  function doneOfMessage(app, message, name) {
    const row = new DynamicModel({ ready: false, poster: false });
    try {
      app
        .db()
        .newQuery("SELECT ready, poster FROM media WHERE source = {:m} AND file = {:f} LIMIT 1")
        .bind({ m: message, f: name })
        .one(row);
      return { ready: !!row.ready, poster: !!row.poster };
    } catch {
      return { ready: true, poster: false };
    }
  }

  /** @param {MigrationApp} app @param {string} id */
  function ref(app, id) {
    app.db().newQuery("UPDATE files SET refs = refs + 1 WHERE id = {:id}").bind({ id }).execute();
  }

  /** @param {MigrationApp} app @param {string} prefix */
  function cleanupLater(app, prefix) {
    app.db().newQuery("INSERT INTO storage_cleanup (id, prefix) VALUES ({:id}, {:prefix})").bind({ id: newId(), prefix }).execute();
  }

  /**
   * Replace field `name` of `collection` by `field` (another type), keeping its values: the new one is added under a
   * temporary name, the values copied by SQL, the old one removed and the new one renamed.
   * @param {MigrationApp} app
   * @param {string} collection
   * @param {string} name
   * @param {any} field
   * @param {string} copy SQL expression of the old column (`{old}`) for the new one
   */
  function retype(app, collection, name, field, copy) {
    const tmp = `${name}_new`;
    let c = app.findCollectionByNameOrId(collection);
    field.name = tmp;
    c.fields.add(field);
    app.save(c);
    app
      .db()
      .newQuery(`UPDATE ${collection} SET ${tmp} = ${copy.split("{old}").join(`[[${name}]]`)}`)
      .execute();
    c = app.findCollectionByNameOrId(collection);
    c.fields.removeByName(name);
    app.save(c);
    c = app.findCollectionByNameOrId(collection);
    c.fields.getByName(tmp).name = name;
    app.save(c);
  }

  migrate(
    (app) => {
      app.save(
        new Collection(
          /** @type {any} */ ({
            type: "base",
            name: "files",
            listRule: null,
            viewRule: null,
            createRule: null,
            updateRule: null,
            deleteRule: null,
            fields: [
              { type: "file", name: "file", required: true, maxSelect: 1, maxSize: C_MAX_SIZE, protected: false, thumbs: C_THUMBS },
              { type: "text", name: "name", max: 200 },
              { type: "bool", name: "video" },
              { type: "json", name: "dims", maxSize: 64 },
              { type: "bool", name: "poster" },
              { type: "bool", name: "ready" },
              { type: "bool", name: "sized" },
              { type: "number", name: "refs", onlyInt: true },
              // Where the file still is (collection/record/name) until the media worker moves it into this row's folder.
              { type: "text", name: "src", max: 255 },
              { type: "autodate", name: "created", onCreate: true, onUpdate: false },
            ],
            indexes: [
              "CREATE UNIQUE INDEX idx_files_file ON files (file)",
              "CREATE INDEX idx_files_pending ON files (created) WHERE ready = FALSE",
              "CREATE INDEX idx_files_unsized ON files (created) WHERE sized = FALSE",
              "CREATE INDEX idx_files_unmoved ON files (created) WHERE src != ''",
            ],
          }),
        ),
      );
      app.save(
        new Collection(
          /** @type {any} */ ({
            type: "base",
            name: "storage_cleanup",
            listRule: null,
            viewRule: null,
            createRule: null,
            updateRule: null,
            deleteRule: null,
            fields: [{ type: "text", name: "prefix", required: true, max: 255 }],
          }),
        ),
      );

      const messagesDir = app.findCollectionByNameOrId("messages").id;
      const itemsDir = app.findCollectionByNameOrId("collection_items").id;
      // Each message's files, with their names, shapes and where they came from under the new names when renamed.
      /** @type {Map<string, string>} "message/name" → files row id */
      const ofMessage = new Map();
      const msgs = arrayOf(new DynamicModel({ id: "", files: "", file_names: "", file_dims: "", file_sources: "", created: "" }));
      app
        .db()
        .newQuery(
          `SELECT id, COALESCE(files, '') AS files, COALESCE(file_names, '') AS file_names, COALESCE(file_dims, '') AS file_dims,
                COALESCE(file_sources, '') AS file_sources, created
         FROM messages WHERE files != '' AND files != '[]' AND files IS NOT NULL`,
        )
        .all(msgs);
      for (const m of msgs) {
        const list = parse(m.files, []);
        if (!Array.isArray(list) || !list.length) continue;
        const names = parse(m.file_names, {});
        const dims = parse(m.file_dims, {});
        const sources = parse(m.file_sources, {});
        /** @type {string[]} */
        const out = [];
        let renamed = false;
        /** @type {Record<string, any>} */
        const outNames = {};
        /** @type {Record<string, any>} */
        const outDims = {};
        /** @type {Record<string, any>} */
        const outSources = {};
        for (const name of list) {
          if (typeof name !== "string" || !name) continue;
          const as = freeName(app, name);
          if (as !== name) renamed = true;
          const id = addRow(app, {
            from: `${messagesDir}/${m.id}`,
            name,
            as,
            original: typeof names[name] === "string" ? names[name] : "",
            dims: dims[name],
            created: m.created,
            done: doneOfMessage(app, m.id, name),
          });
          ref(app, id);
          ofMessage.set(`${m.id}/${name}`, id);
          out.push(as);
          if (names[name] !== undefined) outNames[as] = names[name];
          if (dims[name] !== undefined) outDims[as] = dims[name];
          if (sources[name] !== undefined) outSources[as] = sources[name];
        }
        if (renamed) {
          app
            .db()
            .newQuery("UPDATE messages SET files = {:f}, file_names = {:n}, file_dims = {:d}, file_sources = {:s} WHERE id = {:id}")
            .bind({
              id: m.id,
              f: JSON.stringify(out),
              n: JSON.stringify(outNames),
              d: JSON.stringify(outDims),
              s: JSON.stringify(outSources),
            })
            .execute();
          // The media index names the new ones.
          for (let i = 0; i < list.length; i++) {
            if (list[i] !== out[i]) {
              app
                .db()
                .newQuery("UPDATE media SET file = {:to} WHERE source = {:m} AND file = {:from}")
                .bind({ m: m.id, from: list[i], to: out[i] })
                .execute();
            }
          }
        }
      }

      // Each item, oldest first: one saved from a message file or an item still there names that file instead.
      /** @type {Map<string, string>} item id → files row id */
      const ofItem = new Map();
      const savedItems = arrayOf(
        new DynamicModel({ id: "", collection: "", file: "", name: "", origin: "", created: "", ready: false, poster: false }),
      );
      app
        .db()
        .newQuery(
          `SELECT id, collection, COALESCE(file, '') AS file, COALESCE(name, '') AS name, COALESCE(origin, '') AS origin, created,
                  COALESCE(ready, FALSE) AS ready, COALESCE(poster, FALSE) AS poster
           FROM collection_items ORDER BY created, id`,
        )
        .all(savedItems);
      for (const it of savedItems) {
        let id = "";
        const m = /^m:([a-z0-9]+)\/(.+)$/.exec(it.origin);
        const i = /^i:([a-z0-9]+)$/.exec(it.origin);
        if (m) id = ofMessage.get(`${m[1]}/${m[2]}`) ?? "";
        else if (i) id = ofItem.get(i[1]) ?? "";
        // The same file in this collection already (one saved twice, by two ways): this one goes.
        if (
          id &&
          count(app, "SELECT COUNT(*) AS n FROM collection_items WHERE collection = {:c} AND origin = {:o} AND id != {:id}", {
            c: it.collection,
            o: id,
            id: it.id,
          })
        ) {
          app.db().newQuery("DELETE FROM collection_items WHERE id = {:id}").bind({ id: it.id }).execute();
          app.db().newQuery("UPDATE collections SET items = MAX(0, items - 1) WHERE id = {:c}").bind({ c: it.collection }).execute();
          cleanupLater(app, `${itemsDir}/${it.id}`);
          continue;
        }
        let name = it.file;
        if (id) {
          name = count(app, "SELECT COUNT(*) AS n FROM files WHERE id = {:id}", { id }) ? fileOf(app, id) : "";
        }
        const own = !id || !name;
        if (own) {
          const as = freeName(app, it.file);
          id = addRow(app, {
            from: `${itemsDir}/${it.id}`,
            name: it.file,
            as,
            original: it.name,
            dims: null,
            created: it.created,
            done: { ready: !!it.ready, poster: !!it.poster },
          });
          name = as;
        }
        ref(app, id);
        ofItem.set(it.id, id);
        const poster = count(app, "SELECT COUNT(*) AS n FROM files WHERE id = {:id} AND poster = TRUE", { id }) > 0;
        app
          .db()
          .newQuery("UPDATE collection_items SET file = {:file}, origin = {:origin}, poster = {:poster} WHERE id = {:id}")
          .bind({ id: it.id, file: name, origin: id, poster })
          .execute();
        // Its own copy, no longer named: the file it was saved from is.
        if (!own) cleanupLater(app, `${itemsDir}/${it.id}`);
      }

      // The fields: plain names now.
      let messages = app.findCollectionByNameOrId("messages");
      messages.updateRule = (messages.updateRule ?? "").replace(` && ${C_NO_FILES}`, "");
      app.save(messages);
      retype(
        app,
        "messages",
        "files",
        new JSONField({ maxSize: C_FILES_BODY }),
        "CASE WHEN json_valid({old}) AND json_type({old}) = 'array' THEN {old} ELSE '[]' END",
      );
      messages = app.findCollectionByNameOrId("messages");
      messages.updateRule = `${messages.updateRule} && ${C_NO_FILES}`;
      app.save(messages);
      // A message never has null for none (lib/messages.js beforeMessageCreate): the ones without files say so.
      app.db().newQuery("UPDATE messages SET files = '[]' WHERE files IS NULL OR files = '' OR files = 'null'").execute();

      const items = app.findCollectionByNameOrId("collection_items");
      items.removeIndex("idx_collection_items_pending");
      items.fields.removeByName("ready");
      app.save(items);
      retype(app, "collection_items", "file", new TextField({ required: true, max: 255 }), "COALESCE({old}, '')");

      const media = app.findCollectionByNameOrId("media");
      media.removeIndex("idx_media_pending");
      media.removeIndex("idx_media_unsized");
      for (const f of ["ready", "sized", "poster"]) media.fields.removeByName(f);
      media.addIndex("idx_media_file", false, "file", "");
      app.save(media);
    },
    (app) => {
      const filesDir = app.findCollectionByNameOrId("files").id;
      const messagesDir = app.findCollectionByNameOrId("messages").id;
      const itemsDir = app.findCollectionByNameOrId("collection_items").id;

      const media = app.findCollectionByNameOrId("media");
      media.removeIndex("idx_media_file");
      media.fields.add(new BoolField({ name: "ready" }));
      media.fields.add(new BoolField({ name: "poster" }));
      media.fields.add(new BoolField({ name: "sized" }));
      media.addIndex("idx_media_pending", false, "sent", "ready = FALSE");
      media.addIndex("idx_media_unsized", false, "sent", "sized = FALSE");
      app.save(media);
      app
        .db()
        .newQuery(
          "UPDATE media SET ready = TRUE, sized = TRUE, poster = COALESCE((SELECT poster FROM files f WHERE f.file = media.file), FALSE)",
        )
        .execute();

      // Every file back in each message's and item's own folder.
      const fs = app.newFilesystem();
      try {
        // A file the worker hasn't moved yet is still where it was (src): perhaps the very place it goes back to.
        const at = (/** @type {string} */ name) => {
          const row = rowOf(app, name);
          return row ? row.src || `${filesDir}/${row.id}/${name}` : "";
        };
        const rows = arrayOf(new DynamicModel({ id: "", files: "" }));
        app.db().newQuery("SELECT id, files FROM messages WHERE files != '[]' AND files != '' AND files IS NOT NULL").all(rows);
        for (const m of rows) {
          for (const name of parse(m.files, [])) {
            const from = at(name);
            if (from) copyKey(fs, from, `${messagesDir}/${m.id}/${name}`);
          }
        }
        const items = arrayOf(new DynamicModel({ id: "", file: "" }));
        app.db().newQuery("SELECT id, file FROM collection_items").all(items);
        for (const it of items) {
          const from = at(it.file);
          if (from) copyKey(fs, from, `${itemsDir}/${it.id}/${it.file}`);
        }
      } finally {
        fs.close();
      }

      let messages = app.findCollectionByNameOrId("messages");
      messages.updateRule = (messages.updateRule ?? "").replace(` && ${C_NO_FILES}`, "");
      app.save(messages);
      retype(
        app,
        "messages",
        "files",
        new FileField(/** @type {any} */ ({ maxSelect: 10, maxSize: C_MAX_SIZE, protected: true, thumbs: C_THUMBS })),
        "{old}",
      );
      messages = app.findCollectionByNameOrId("messages");
      messages.updateRule = `${messages.updateRule} && ${C_NO_FILES}`;
      app.save(messages);

      retype(
        app,
        "collection_items",
        "file",
        new FileField(/** @type {any} */ ({ required: true, maxSelect: 1, maxSize: C_MAX_SIZE, protected: true, thumbs: C_THUMBS })),
        "{old}",
      );
      const items = app.findCollectionByNameOrId("collection_items");
      items.fields.add(new BoolField({ name: "ready", hidden: true }));
      items.addIndex("idx_collection_items_pending", false, "created", "ready = FALSE");
      app.save(items);
      app.db().newQuery("UPDATE collection_items SET ready = TRUE").execute();

      app.delete(app.findCollectionByNameOrId("storage_cleanup"));
      app.delete(app.findCollectionByNameOrId("files"));
    },
  );

  /** @param {MigrationApp} app @param {string} id */
  function fileOf(app, id) {
    const row = new DynamicModel({ file: "" });
    app.db().newQuery("SELECT file FROM files WHERE id = {:id}").bind({ id }).one(row);
    return row.file;
  }

  /** @param {MigrationApp} app @param {string} name @returns {{ id: string, src: string } | null} */
  function rowOf(app, name) {
    const row = new DynamicModel({ id: "", src: "" });
    try {
      app.db().newQuery("SELECT id, COALESCE(src, '') AS src FROM files WHERE file = {:name}").bind({ name }).one(row);
    } catch {
      return null;
    }
    return { id: row.id, src: row.src };
  }
})();
