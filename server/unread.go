package main

// Unread counts (DESIGN.md §18, §41): GET /api/chat/unread and GET /api/chat/unread/{room}. POST /api/chat/reads stays
// in pb_hooks/lib/reads.js. (pb_hooks/lib/reads.js and lib/inbox.js counts() until 2026-11-11.)

import (
	"net/http"
	"strconv"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// unreadCap: counts stop here (the badge shows "99+" past 99, so more is never needed).
const unreadCap = 100

// unreadSQL: unread messages per room the caller can see (§23.1): other people's, not deleted, newer than the caller's
// read position (or their signup, for a room they never opened). Hidden and archived rooms are counted too; the client
// doesn't show those (§18.4).
//
// The rooms with their read positions first (p), then one count per room (c), each a range scan from that position on
// idx_messages_unread, stopped at unreadCap. That index is partial (not deleted) and holds the author, so the count
// reads only the index, never a message (REFACTOR item 26). Both are MATERIALIZED: with a subquery instead, SQLite
// evaluated each room's count twice, once for `n > 0` and once for the value. Measured on 1,000 rooms with ≥ 100
// unread each (tests/perf/scale.ts): 283 ms before, 52 ms (DESIGN.md §25).
var unreadSQL = `
WITH p AS MATERIALIZED (
  SELECT r.id AS room,
    MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = r.id), ''), {:since}) AS pos
  FROM rooms r
  WHERE ` + seesSQL + `
), c AS MATERIALIZED (
  SELECT p.room AS room, (
    SELECT COUNT(*) FROM (
      SELECT 1 FROM messages m
      WHERE m.room = p.room AND m.created > p.pos AND m.author != {:me} AND m.deleted = FALSE
      LIMIT ` + strconv.Itoa(unreadCap) + `
    )
  ) AS n
  FROM p
)
SELECT room, n FROM c WHERE n > 0`

// accountedFor: how far back GET /api/chat/unread lists the messages its counts already account for (QA BUG-106).
const accountedFor = 30 * time.Second

// countsSQL: unreadSQL's rows (`id` "") and, in the same statement so from the same snapshot, the ids of other people's
// messages in the rooms the caller sees created since {:from} (`room` ""): whatever its read position, the counts
// account for each of them. Their live events arrive late (or during the request), so the client skips those instead of
// guessing from `created` (QA BUG-106). CROSS JOIN keeps rooms the outer loop (SQLite doesn't reorder it), so each room
// is a range scan on idx_messages_room_created, not a scan of every message (tests/integration/reads.test.ts pins the
// plan).
var countsSQL = `
SELECT room, n, '' AS id FROM (` + unreadSQL + `)
UNION ALL
SELECT * FROM (
  SELECT '' AS room, 0 AS n, m.id AS id FROM rooms r CROSS JOIN messages m ON m.room = r.id
  WHERE ` + seesSQL + `
    AND m.created > {:from}
    AND m.author != {:me}
  LIMIT 1000
)`

// firstUnreadSQL: the oldest unread message in one room, by the same rule as unreadSQL (§18.2).
const firstUnreadSQL = `
SELECT m.id, m.created FROM messages m
WHERE m.room = {:room}
  AND m.created > MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = {:room}), ''), {:since})
  AND m.author != {:me}
  AND m.deleted = FALSE
ORDER BY m.created, m.id
LIMIT 1`

// The inbox (§41), as pb_hooks/lib/inbox.js lists it: a person's rows whose message is there and in a room they see.
const inboxVisibleSQL = `FROM inbox i JOIN messages m ON m.id = i.message JOIN rooms r ON r.id = i.room
WHERE i.user = {:me} AND m.deleted = FALSE AND ` + seesSQL

// inboxReadInRoomSQL: a mention or reply whose message you have read in its room: not new in the inbox either.
const inboxReadInRoomSQL = `(i.kind != 'reaction' AND m.created <= COALESCE((SELECT rr.last_read_at FROM room_reads rr
  WHERE rr.user = {:me} AND rr.room = i.room), ''))`

// inboxCap: the inbox's "unseen" count stops here (shown as "99+"), and so does each room's count of mentions.
const inboxCap = 100

// inboxMentionsSQL: per room, the mentions of the caller and replies to them that are unread there (newer than their
// read position, or signup), at most inboxCap each; rooms with none come back as 0. Driven by the rooms the caller has
// inbox rows in (materialized with their read positions), each one a range scan of idx_inbox_user_room_created from
// the read position on (REFACTOR item 49): a row is made with or after its message, so `i.created > pos` drops no row
// `m.created > pos` keeps, and read rows are never visited. Until 2026-11-12 one GROUP BY went through every row of
// the caller's, read or not: 13 ms against 1.5 ms for 5,000 rows in 5 rooms. COUNT(DISTINCT) over the capped rows, not
// SELECT DISTINCT: that made SQLite walk idx_inbox_one in message order instead.
var inboxMentionsSQL = `
WITH p AS MATERIALIZED (
  SELECT r.id AS room,
    MAX(COALESCE((SELECT rr.last_read_at FROM room_reads rr WHERE rr.user = {:me} AND rr.room = r.id), ''), {:since}) AS pos
  FROM rooms r
  WHERE r.id IN (SELECT DISTINCT room FROM inbox WHERE user = {:me}) AND ` + seesSQL + `
)
SELECT p.room AS room, (
  SELECT COUNT(DISTINCT message) FROM (
    SELECT i.message FROM inbox i JOIN messages m ON m.id = i.message
    WHERE i.user = {:me} AND i.room = p.room AND i.created > p.pos AND i.kind != 'reaction'
      AND m.created > p.pos AND m.deleted = FALSE
    LIMIT ` + strconv.Itoa(inboxCap) + `
  )
) AS n
FROM p`

// unreadRoute: GET /api/chat/unread → { at, rooms: { "<roomId>": count }, ids, inbox, mentions } for every room with
// unread messages (at most unreadCap each). `at` is when the counts were taken. `ids` are the recent messages the counts
// account for: the client adds the live ones it gets that aren't among them (§18.3, QA BUG-106). `inbox`: the inbox's
// unseen rows; `mentions`: per room, the unread mentions of and replies to the caller (§41).
func unreadRoute(e *core.RequestEvent) error {
	user := e.Auth
	at := types.NowDateTime().String()
	var rows []struct {
		Room string `db:"room"`
		N    int    `db:"n"`
		ID   string `db:"id"`
	}
	err := e.App.DB().NewQuery(countsSQL).Bind(dbx.Params{
		"me":    user.Id,
		"since": user.GetString("created"),
		"from":  time.Now().UTC().Add(-accountedFor).Format("2006-01-02 15:04:05.000Z"),
	}).All(&rows)
	if err != nil {
		return err
	}
	rooms := map[string]int{}
	ids := []string{}
	for _, r := range rows {
		if r.ID != "" {
			ids = append(ids, r.ID)
		} else {
			rooms[r.Room] = r.N
		}
	}
	inbox, mentions, err := inboxCounts(e.App, user)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, map[string]any{"at": at, "rooms": rooms, "ids": ids, "inbox": inbox, "mentions": mentions})
}

// inboxCounts: how many inbox rows user hasn't seen (at most inboxCap): newer than when they last looked at the inbox,
// and (a mention or reply) not read in its room already; and per room the mentions of them and replies to them that
// are still unread there (newer than their read position, or signup).
func inboxCounts(app core.App, user *core.Record) (int, map[string]int, error) {
	seen := ""
	if row, err := app.FindFirstRecordByFilter("inbox_reads", "user = {:u}", dbx.Params{"u": user.Id}); err == nil {
		seen = row.GetString("seen_at")
	}
	var unseen int
	err := app.DB().NewQuery(
		"SELECT COUNT(*) FROM (SELECT 1 " + inboxVisibleSQL + " AND i.created > {:seen} AND NOT " + inboxReadInRoomSQL +
			" LIMIT " + strconv.Itoa(inboxCap) + ")",
	).Bind(dbx.Params{"me": user.Id, "seen": seen}).Row(&unseen)
	if err != nil {
		return 0, nil, err
	}
	var rows []struct {
		Room string `db:"room"`
		N    int    `db:"n"`
	}
	err = app.DB().NewQuery(inboxMentionsSQL).Bind(dbx.Params{"me": user.Id, "since": user.GetString("created")}).All(&rows)
	if err != nil {
		return 0, nil, err
	}
	mentions := map[string]int{}
	for _, r := range rows {
		if r.N > 0 {
			mentions[r.Room] = r.N
		}
	}
	return unseen, mentions, nil
}

// firstUnreadRoute: GET /api/chat/unread/{room} → { id, created } of the oldest message in room that is unread for the
// caller, or { id: "", created: "" } when there is none. The room view opens there (§18.5).
func firstUnreadRoute(e *core.RequestEvent) error {
	user := e.Auth
	roomID := e.Request.PathValue("room")
	if visibleRoom(e.App, roomID, user.Id) == nil {
		return e.NotFoundError("The room doesn't exist.", nil)
	}
	row := struct {
		ID      string `db:"id"`
		Created string `db:"created"`
	}{}
	// No rows: nothing unread.
	_ = e.App.DB().NewQuery(firstUnreadSQL).Bind(dbx.Params{"me": user.Id, "room": roomID, "since": user.GetString("created")}).One(&row)
	return e.JSON(http.StatusOK, map[string]string{"id": row.ID, "created": row.Created})
}
