/// <reference path="../types/pocketbase.d.ts" />
// XMPP bridge (DESIGN.md §38, pb_hooks/xmpp.pb.js): its own collections, all named xmpp_*, readable and writable by
// superusers only (null rules). Nothing outside the bridge reads them, so removing the bridge can leave them, or go
// down this migration to drop them.
// - xmpp_links: an XMPP conference (MUC) and the room it is linked to. A superuser adds one in the admin UI, or the
//   bridge does (no room, disabled) when the bot is invited somewhere.
// - xmpp_people: someone in a conference and the stand-in user ("Ann (XMPP)") whose name their messages show under.
// - xmpp_messages: which XMPP messages a chat message is, both ways.
// - xmpp_queue: work for the bridge's worker: messages, edits and deletes to pass on to the conferences.
// And a rate limit for the child's posts (/api/xmpp/), above PocketBase's "/api/" one that would otherwise count them.

/** @param {Record<string, unknown>} data */
const xmppCollection = (data) =>
  new Collection(
    /** @type {any} */ ({ type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...data }),
  );

const XMPP_NAMES = ["xmpp_queue", "xmpp_messages", "xmpp_people", "xmpp_links"];
const XMPP_LIMIT = { label: "/api/xmpp/", audience: "", duration: 10, maxRequests: 3000 };

migrate(
  (app) => {
    const rooms = app.findCollectionByNameOrId("rooms");
    const users = app.findCollectionByNameOrId("users");
    const messages = app.findCollectionByNameOrId("messages");
    const stamps = [
      { type: "autodate", name: "created", onCreate: true, onUpdate: false },
      { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
    ];

    app.save(
      xmppCollection({
        name: "xmpp_links",
        fields: [
          // The conference's address, room@conference.example.org.
          { type: "text", name: "muc", required: true, max: 255 },
          { type: "text", name: "title", max: 255 },
          { type: "text", name: "password", max: 255, hidden: true },
          { type: "relation", name: "room", maxSelect: 1, collectionId: rooms.id, cascadeDelete: true },
          { type: "bool", name: "enabled" },
          { type: "bool", name: "anonymous" },
          // How the last join went ("joined as Chirkle", "error: forbidden"): the bridge writes it.
          { type: "text", name: "status", max: 1000 },
          // When it was last enabled: older history isn't brought over. And the newest message seen, for the history
          // asked for on joining again.
          { type: "date", name: "enabled_at" },
          { type: "date", name: "last_seen" },
          ...stamps,
        ],
        indexes: ["CREATE UNIQUE INDEX idx_xmpp_links_muc ON xmpp_links (muc)", "CREATE INDEX idx_xmpp_links_room ON xmpp_links (room)"],
      }),
    );

    app.save(
      xmppCollection({
        name: "xmpp_people",
        fields: [
          // Who they are, as steadily as the conference says: "oid:<muc> <occupant-id>", "jid:<address>" or
          // "nick:<muc>/<nickname>" (§38.5).
          { type: "text", name: "key", required: true, max: 600 },
          { type: "relation", name: "user", required: true, maxSelect: 1, collectionId: users.id, cascadeDelete: true },
          { type: "text", name: "muc", max: 255 },
          { type: "text", name: "nick", max: 255 },
          { type: "text", name: "jid", max: 255 },
          ...stamps,
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_xmpp_people_key ON xmpp_people (key)",
          "CREATE UNIQUE INDEX idx_xmpp_people_user ON xmpp_people (user)",
        ],
      }),
    );

    app.save(
      xmppCollection({
        name: "xmpp_messages",
        fields: [
          { type: "relation", name: "message", required: true, maxSelect: 1, collectionId: messages.id, cascadeDelete: true },
          { type: "text", name: "muc", required: true, max: 255 },
          // What the message is known by: the conference's stanza id, else "n:<nick> <id>" (in); "o:<origin-id>" (out).
          { type: "text", name: "xmpp_id", required: true, max: 600 },
          // The conference's stanza id (XEP-0359), for an outgoing one once its echo comes back: replies and
          // retractions name it. And the sender's own id (its origin-id, else its id) and nickname: corrections name
          // the id, and a reply is addressed to the nickname.
          { type: "text", name: "stanza_id", max: 255 },
          { type: "text", name: "msg_id", max: 255 },
          { type: "text", name: "nick", max: 255 },
          { type: "select", name: "direction", required: true, maxSelect: 1, values: ["in", "out"] },
          // A long message came over as several: 0, 1, 2… (lib/bridges.js split).
          { type: "number", name: "part", onlyInt: true },
          ...stamps,
        ],
        indexes: [
          "CREATE UNIQUE INDEX idx_xmpp_messages_xmpp ON xmpp_messages (muc, xmpp_id, part)",
          "CREATE INDEX idx_xmpp_messages_message ON xmpp_messages (message)",
          "CREATE INDEX idx_xmpp_messages_stanza ON xmpp_messages (muc, stanza_id)",
          "CREATE INDEX idx_xmpp_messages_msg ON xmpp_messages (muc, msg_id)",
        ],
      }),
    );

    app.save(
      xmppCollection({
        name: "xmpp_queue",
        fields: [
          { type: "select", name: "op", required: true, maxSelect: 1, values: ["send", "edit", "delete"] },
          { type: "text", name: "message", required: true, max: 15 },
          { type: "text", name: "muc", required: true, max: 255 },
          { type: "number", name: "tries", onlyInt: true },
          { type: "date", name: "next_at" },
          { type: "date", name: "locked_until" },
          { type: "text", name: "error", max: 1000 },
          ...stamps,
        ],
        indexes: ["CREATE INDEX idx_xmpp_queue_created ON xmpp_queue (created)"],
      }),
    );

    const settings = app.settings();
    const rest = settings.rateLimits.rules.filter((r) => r.label !== XMPP_LIMIT.label);
    settings.rateLimits.rules = [/** @type {any} */ (XMPP_LIMIT), ...rest];
    app.save(settings);
  },
  (app) => {
    for (const name of XMPP_NAMES) app.delete(app.findCollectionByNameOrId(name));
    const settings = app.settings();
    settings.rateLimits.rules = settings.rateLimits.rules.filter((r) => r.label !== XMPP_LIMIT.label);
    app.save(settings);
  },
);
