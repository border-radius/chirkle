/// <reference path="../types/pocketbase.d.ts" />
// Handles, mentions and the "Mentions & replies" inbox (DESIGN.md §41).
// - `users.handle`: what @mentions name, unique, a–z 0–9 _ (3–24). Every account gets one here, made from its name as
//   pb_hooks/lib/handles.js makes them (keep handleFrom in sync); users change theirs on the profile page.
// - `messages.mentions`: the people a message's "@handle"s name who can see its room, set by the hooks from the text.
// - `inbox`: one row per thing to tell someone of: a mention of them, a reply to one of their messages, a reaction to
//   one. Kept by the messages hooks (pb_hooks/lib/inbox.js), read only through GET /api/chat/inbox.
// - `inbox_reads`: how far each person has looked at their inbox (POST /api/chat/inbox/seen).

const CLOSED = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
const HANDLE_INDEX = "CREATE UNIQUE INDEX idx_users_handle ON users (handle) WHERE handle != ''";
const HANDLE_MAX = 24;

/** @type {Record<string, string>} */
const CYRILLIC = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  і: "i",
  ї: "yi",
  є: "ye",
  ґ: "g",
  ў: "u",
};

/**
 * Letters NFKD leaves whole (Ł, Ø, Æ, Þ…) and Greek, spelled in Latin: "Łukasz" was "ukasz", "Ørjan" "rjan" (QA BUG-255).
 * @type {Record<string, string>}
 */
const LATIN = {
  ł: "l",
  ø: "o",
  æ: "ae",
  œ: "oe",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ħ: "h",
  ŧ: "t",
  ŋ: "ng",
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

/** pb_hooks/lib/handles.js handleFrom. @param {string} name */
function handleFrom(name) {
  let s = [...name.toLowerCase()].map((c) => CYRILLIC[c] ?? c).join("");
  if (typeof s.normalize === "function") s = s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  s = s
    .replace(/ß/g, "ss")
    .replace(/[\u0080-\uffff]/g, (c) => LATIN[c] ?? c)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/, "");
  if (s.length < 3) s = s ? `${s}_user` : "user";
  return s;
}

migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    users.fields.add(new TextField({ name: "handle", max: HANDLE_MAX }));
    /** @type {any} */ (users).indexes = [.../** @type {string[]} */ (/** @type {any} */ (users).indexes), HANDLE_INDEX];
    app.save(users);

    // Not the reserved ones ("@all" would mention whoever is called All, QA BUG-256).
    const taken = new Set(["all", "everyone", "here", "room", "channel"]);
    const rows = arrayOf(new DynamicModel({ id: "", name: "" }));
    app.db().newQuery("SELECT id, name FROM users ORDER BY created, id").all(rows);
    for (const row of rows) {
      const base = handleFrom(row.name);
      let handle = base;
      for (let n = 2; taken.has(handle); n++) handle = `${base.slice(0, HANDLE_MAX - String(n).length)}${n}`;
      taken.add(handle);
      app.db().newQuery("UPDATE users SET handle = {:h} WHERE id = {:id}").bind({ h: handle, id: row.id }).execute();
    }

    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.add(new RelationField({ name: "mentions", collectionId: users.id, maxSelect: 20, cascadeDelete: false }));
    app.save(messages);
    app.db().newQuery("UPDATE messages SET mentions = '[]'").execute();

    const rooms = app.findCollectionByNameOrId("rooms");
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "inbox",
          ...CLOSED,
          fields: [
            { type: "relation", name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true },
            { type: "select", name: "kind", required: true, maxSelect: 1, values: ["mention", "reply", "reaction"] },
            { type: "relation", name: "message", collectionId: messages.id, required: true, maxSelect: 1, cascadeDelete: true },
            { type: "relation", name: "room", collectionId: rooms.id, required: true, maxSelect: 1, cascadeDelete: true },
            { type: "relation", name: "actor", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true },
            { type: "text", name: "emoji", max: 32 },
            { type: "autodate", name: "created", onCreate: true, onUpdate: false },
          ],
          indexes: [
            "CREATE UNIQUE INDEX idx_inbox_one ON inbox (user, message, kind, actor, emoji)",
            "CREATE INDEX idx_inbox_user_created ON inbox (user, created)",
            "CREATE INDEX idx_inbox_message ON inbox (message)",
          ],
        }),
      ),
    );
    app.save(
      new Collection(
        /** @type {any} */ ({
          type: "base",
          name: "inbox_reads",
          ...CLOSED,
          fields: [
            { type: "relation", name: "user", collectionId: users.id, required: true, maxSelect: 1, cascadeDelete: true },
            { type: "date", name: "seen_at", required: true },
          ],
          indexes: ["CREATE UNIQUE INDEX idx_inbox_reads_user ON inbox_reads (user)"],
        }),
      ),
    );
  },
  (app) => {
    for (const name of ["inbox_reads", "inbox"]) app.delete(app.findCollectionByNameOrId(name));
    const messages = app.findCollectionByNameOrId("messages");
    messages.fields.removeByName("mentions");
    app.save(messages);
    const users = app.findCollectionByNameOrId("users");
    users.fields.removeByName("handle");
    /** @type {any} */ (users).indexes = /** @type {string[]} */ (/** @type {any} */ (users).indexes).filter((i) => i !== HANDLE_INDEX);
    app.save(users);
  },
);
