/// <reference path="../types/pocketbase.d.ts" />
// QA BUG-257: a Telegram group that became a supergroup had its tg_messages moved to the new chat id, but the new group
// numbers its messages afresh. Its new messages then took the old ones' ids: what Telegram sent was dropped as brought
// over already, and what the room sent failed on the unique (chat_id, tg_message_id, part) after going out, so the
// worker sent it again, up to 8 times. The code no longer moves them (links.js moveLink); this drops the rows it moved.
//
// Which rows were moved isn't recorded, so only a chat with the evidence in the logs is repaired: a "telegram: send"
// that failed on that unique index. Its rows from before the move go: from before the link was last saved (the move
// saves it) or the first such failure, whichever came first. They stood for the old group's messages, which can't be
// edited or deleted any more, so nothing that works is lost.

migrate(
  (app) => {
    /** @type {{ chat: string, first: string }[]} */
    let chats = [];
    try {
      const rows = arrayOf(new DynamicModel({ chat: "", first: "" }));
      app
        .auxDB()
        .newQuery(
          `SELECT json_extract(data, '$.chat') AS chat, MIN(created) AS first FROM _logs
           WHERE message = 'telegram: send' AND json_extract(data, '$.error') LIKE '%tg_message_id: Value must be unique%'
           GROUP BY chat`,
        )
        .all(rows);
      chats = rows.map((r) => ({ chat: String(r.chat || ""), first: String(r.first || "") })).filter((r) => r.chat && r.first);
    } catch (err) {
      app.logger().warn("migration 1760000047: no logs to read", "error", String(err));
      return;
    }
    for (const { chat, first } of chats) {
      let link;
      try {
        link = app.findFirstRecordByFilter("tg_links", "chat_id = {:chat}", { chat });
      } catch {
        continue;
      }
      const saved = link.getDateTime("updated").string();
      const cutoff = saved && saved < first ? saved : first;
      const res = app
        .db()
        .newQuery("DELETE FROM tg_messages WHERE chat_id = {:chat} AND created < {:cutoff}")
        .bind({ chat, cutoff })
        .execute();
      app
        .logger()
        .info("migration 1760000047: stale Telegram mappings dropped", "chat", chat, "before", cutoff, "rows", res.rowsAffected());
    }
  },
  () => {},
);
