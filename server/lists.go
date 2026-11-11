package main

// The room list and a room's message pages, as routes (docs/API.md): the clients say which page they want and the
// server writes the filter. They answer as the records API does (the same ?expand and ?fields, the enrich hooks), as a
// plain array, and see what the API rules let the caller see. Apps from before these routes still list `rooms` and
// `messages` through the records API, which stays as it was. (pb_hooks/lib/lists.js until 2026-11-11.)

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const (
	pageSize = 50  // messages in a page unless `limit` says otherwise (web/src/lib/cursor.ts PAGE_SIZE)
	maxLimit = 200 // most messages in a page
	maxWords = 5   // words of a search that count (web/src/views/room/search.ts MAX_WORDS)
	maxRooms = 50  // rooms in one notification check, at most (ANDROID.md §21.2 asks for 40)
)

type pageKind struct {
	where  string
	params []string
	sort   string
}

// pageKinds: a room's pages (DESIGN.md §7.5), keyset by (created, id), and the edits and deletes missed while offline
// (`changed`). `latest` and `older` come newest first, the others oldest first.
var pageKinds = map[string]pageKind{
	"latest":  {sort: "-created,-id"},
	"first":   {sort: "created,id"},
	"older":   {where: "(created < {:created} || (created = {:created} && id < {:id}))", params: []string{"created", "id"}, sort: "-created,-id"},
	"newer":   {where: "(created > {:created} || (created = {:created} && id > {:id}))", params: []string{"created", "id"}, sort: "created,id"},
	"changed": {where: "updated > {:since} && created >= {:from} && created <= {:to}", params: []string{"since", "from", "to"}, sort: "updated,id"},
}

// roomsRoute: GET /api/chat/rooms → every room the caller can see, by name. Guests: the Open Air rooms (§23.3).
func roomsRoute(e *core.RequestEvent) error {
	// As the records API's: this page's ?expand mustn't group messages by author (§35).
	if err := refuseProbes(e); err != nil {
		return err
	}
	me := callerID(e.Auth)
	where := "r.visibility = 'open' AND NOT r.archived"
	if e.HasSuperuserAuth() {
		where = "1"
	} else if me != "" {
		where = seesSQL
	}
	var ids []string
	if err := e.App.DB().NewQuery("SELECT r.id FROM rooms r WHERE " + where + " ORDER BY r.name, r.id").Bind(dbx.Params{"me": me}).Column(&ids); err != nil {
		return err
	}
	found, err := e.App.FindRecordsByIds("rooms", ids)
	if err != nil {
		return err
	}
	byID := make(map[string]*core.Record, len(found))
	for _, r := range found {
		byID[r.Id] = r
	}
	items := make([]*core.Record, 0, len(ids))
	for _, id := range ids {
		if r := byID[id]; r != nil {
			items = append(items, r)
		}
	}
	if err := apis.EnrichRecords(e, items); err != nil {
		return err
	}
	return e.JSON(http.StatusOK, items)
}

// messagesRoute: GET /api/chat/rooms/{room}/messages?kind=latest|first|older|newer|changed → the messages. `older` and
// `newer` take the cursor (`created`, `id`); `changed` takes `since` (an `updated` value) and `from`, `to` (`created`
// values). `files=1`: only messages that may have attachments (§17.7). `q`: only messages with every word of it (search,
// §29; with `latest` and `older`). `limit` (at most 200) and `page` (from 1) as the records API has them. A room the
// caller can't see has no messages. Answered with an ETag: asked again with it, an unchanged page is a 304 (PERF.md §5).
func messagesRoute(e *core.RequestEvent) error {
	if err := refuseProbes(e); err != nil {
		return err
	}
	roomID := e.Request.PathValue("room")
	info, err := e.RequestInfo()
	if err != nil {
		return err
	}
	q := info.Query
	name := q["kind"]
	if name == "" {
		name = "latest"
	}
	kind, ok := pageKinds[name]
	if !ok {
		return e.BadRequestError("Unknown page kind.", nil)
	}
	if !e.HasSuperuserAuth() && visibleRoom(e.App, roomID, callerID(e.Auth)) == nil {
		return e.JSON(http.StatusOK, []any{})
	}
	params := dbx.Params{"room": roomID}
	for _, p := range kind.params {
		// An empty id is a cursor too: `newer` than (created, "") starts at `created` itself (around a message, §7.5).
		v, ok := q[p]
		if !ok || (p != "id" && v == "") {
			return e.BadRequestError("Missing "+p+".", nil)
		}
		params[p] = v
	}
	where := append([]string{"room = {:room}"}, searchWhere(q["q"], params)...)
	where = append(where, kind.where)
	if q["files"] == "1" {
		// `files` is JSON (§37): every message has at least [].
		where = append(where, `(files != "[]" || forward_of != "")`)
	}
	items, err := listMessages(e, where, kind.sort, q, params, []string{roomID})
	if err != nil {
		return err
	}
	return tagged(e, q, items)
}

// tagged answers with body and an ETag of it, or 304 when the client has that one already. The tag is a hash of the
// records as they serialize with their expands and what the enrich hooks added. `no-store`: nothing keeps a page but
// the app itself, and it sends the tag it kept.
func tagged(e *core.RequestEvent, q map[string]string, body []*core.Record) error {
	raw, err := json.Marshal([]any{q["fields"], q["expand"], body})
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	tag := `"` + hex.EncodeToString(sum[:])[:32] + `"`
	h := e.Response.Header()
	h.Set("ETag", tag)
	h.Set("Cache-Control", "no-store")
	for _, t := range strings.Split(e.Request.Header.Get("If-None-Match"), ",") {
		if strings.TrimSpace(t) == tag {
			return e.NoContent(http.StatusNotModified)
		}
	}
	return e.JSON(http.StatusOK, body)
}

// searchWords: a search's words (§29), folded as the server stores text_key, each once, the first maxWords.
func searchWords(text string) []string {
	words := []string{}
	for _, w := range strings.Fields(searchKey(text)) {
		if !slices.Contains(words, w) {
			words = append(words, w)
		}
	}
	if len(words) > maxWords {
		words = words[:maxWords]
	}
	return words
}

// searchWhere: the conditions for a search's words, matched on text_key. `~` treats a % in the value as a wildcard, so
// it is escaped (QA BUG-34); `_` already is. So is the escape character itself (QA BUG-112).
func searchWhere(text string, params dbx.Params) []string {
	var out []string
	for i, w := range searchWords(text) {
		key := "w" + strconv.Itoa(i)
		params[key] = strings.NewReplacer(`\`, `\\`, `%`, `\%`).Replace(w)
		out = append(out, "text_key ~ {:"+key+"}")
	}
	return out
}

// notifiableRoute: GET /api/chat/notifiable?rooms=a,b&since=…[&every=a] → other people's messages in `rooms` since
// `since` that are DMs, replies to you or mentions of you (DESIGN.md §41), or any message in an `every` room
// (ANDROID.md §21.2, §24): newest first, `limit` of them. The rooms you can't see are left out.
func notifiableRoute(e *core.RequestEvent) error {
	if err := refuseProbes(e); err != nil {
		return err
	}
	info, err := e.RequestInfo()
	if err != nil {
		return err
	}
	q := info.Query
	if q["since"] == "" {
		return e.BadRequestError("Missing since.", nil)
	}
	me := ""
	if e.Auth != nil {
		me = e.Auth.Id
	}
	ids := func(s string) []string {
		var out []string
		for _, x := range strings.Split(s, ",") {
			if x != "" {
				out = append(out, x)
			}
		}
		return out
	}
	asked := ids(q["rooms"])
	if len(asked) > maxRooms {
		asked = asked[:maxRooms]
	}
	var rooms []string
	for _, r := range asked {
		if visibleRoom(e.App, r, me) != nil {
			rooms = append(rooms, r)
		}
	}
	if len(rooms) == 0 {
		return e.JSON(http.StatusOK, []any{})
	}
	every := ids(q["every"])
	params := dbx.Params{"me": me, "since": q["since"]}
	in := make([]string, len(rooms))
	all := ""
	for i, r := range rooms {
		key := "r" + strconv.Itoa(i)
		params[key] = r
		in[i] = "room = {:" + key + "}"
		if slices.Contains(every, r) {
			all += " || room = {:" + key + "}"
		}
	}
	where := []string{
		"(" + strings.Join(in, " || ") + ")",
		"created > {:since}",
		"author != {:me}",
		"deleted = false",
		`(room.kind = "dm" || reply_to.author = {:me} || mentions.id ?= {:me}` + all + ")",
	}
	items, err := listMessages(e, where, "-created,-id", q, params, rooms)
	if err != nil {
		return err
	}
	return e.JSON(http.StatusOK, items)
}

// listMessages: the messages matching every condition in where, a page of them as q's `limit` and `page` say,
// enriched. They are all in rooms, which the caller can see.
func listMessages(e *core.RequestEvent, where []string, sort string, q map[string]string, params dbx.Params, rooms []string) ([]*core.Record, error) {
	limit := min(max(leadingInt(q["limit"], pageSize), 1), maxLimit)
	page := max(leadingInt(q["page"], 1), 1)
	var conds []string
	for _, w := range where {
		if w != "" {
			conds = append(conds, w)
		}
	}
	items, err := e.App.FindRecordsByFilter("messages", strings.Join(conds, " && "), sort, limit, (page-1)*limit, params)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []*core.Record{}
	}
	if err := enrichInRooms(e, rooms, items); err != nil {
		return nil, err
	}
	return items, nil
}

// leadingInt reads a number as JS parseInt(s, 10) does (leading spaces, a sign, then digits), and def for none or 0.
func leadingInt(s string, def int) int {
	s = strings.TrimLeft(s, " \t\n\r")
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	n, digits := 0, 0
	for _, c := range s {
		if c < '0' || c > '9' || n > 1_000_000 {
			break
		}
		n = n*10 + int(c-'0')
		digits++
	}
	if digits == 0 || n == 0 {
		return def
	}
	if neg {
		return -n
	}
	return n
}
