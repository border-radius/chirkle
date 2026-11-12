package main

// Anonymous rooms (DESIGN.md §35), the parts the Go paths need: hiding a message's author in an answer or a live event
// (hide), and refusing every filter, sort or expand that would group messages by author (bindProbes): the records API's,
// realtime subscriptions' and every /api/chat/* route's, JS ones included. pb_hooks/lib/anonymous.js keeps the rest.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

type anonRoom struct {
	name    string
	private bool
}

// anonRooms: what the messages of an anonymous room show as, kept until the room is saved again (bindAnonymous).
var anonRooms sync.Map

func anonRoomOf(app core.App, roomID string) anonRoom {
	if v, ok := anonRooms.Load(roomID); ok {
		return v.(anonRoom)
	}
	rec, err := app.FindRecordById("rooms", roomID)
	if err != nil {
		return anonRoom{name: "Anonymous", private: true} // being removed
	}
	room := anonRoom{name: rec.GetString("name"), private: rec.GetString("visibility") == "private"}
	if room.name == "" {
		room.name = "Anonymous"
	}
	anonRooms.Store(roomID, room)
	return room
}

// bindAnonymous forgets a room's name and visibility once it is saved or deleted.
func bindAnonymous(app core.App) {
	forget := func(e *core.RecordEvent) error {
		err := e.Next()
		anonRooms.Delete(e.Record.Id)
		return err
	}
	app.OnRecordUpdate("rooms").BindFunc(forget)
	app.OnRecordDelete("rooms").BindFunc(forget)
}

// standIn is who an anonymous message shows as: a users record that is never saved, with the room's id and name. It
// takes no DMs, so the clients offer none.
func standIn(app core.App, id, name string) *core.Record {
	users, err := app.FindCachedCollectionByNameOrId("users")
	if err != nil {
		return nil
	}
	user := core.NewRecord(users)
	user.Id = id
	user.Set("id", id)
	user.Set("name", name)
	user.Set("no_dms", true)
	return user
}

// setExpanded puts user in the message's expand under field, in place of what is there (or also when nothing is, add):
// a new map, as the expanded author may be the one other messages of theirs show too.
func setExpanded(rec *core.Record, field string, user *core.Record, add bool) {
	if user == nil {
		return
	}
	expand := rec.Expand()
	if expand[field] == nil && !add {
		return
	}
	next := make(map[string]any, len(expand)+1)
	for k, v := range expand {
		next[k] = v
	}
	next[field] = user
	rec.SetExpand(next)
}

// hide: to anyone but its author (me) and superusers, an anonymous message's author is its room, and a forward is from
// the original's room. Only in the answer. Called once the record is expanded.
func hide(app core.App, rec *core.Record, me string, superuser bool) {
	if rec == nil || superuser {
		return
	}
	// The quoted message hid its author when it was fetched, before its own expand (reply_to.author) looked for them.
	if quoted := rec.ExpandedOne("reply_to"); quoted != nil && quoted.GetBool("anonymous") && quoted.GetString("author") == quoted.GetString("room") {
		room := quoted.GetString("room")
		setExpanded(quoted, "author", standIn(app, room, anonRoomOf(app, room).name), true)
	}
	if author := rec.GetString("author"); rec.GetBool("anonymous") && author != "" && author != me {
		room := rec.GetString("room")
		rec.Set("author", room)
		setExpanded(rec, "author", standIn(app, room, anonRoomOf(app, room).name), false)
	}
	if from := rec.GetString("forwarded_from"); rec.GetBool("forwarded_anonymous") && from != "" && from != me {
		room := ""
		if id := rec.GetString("forward_of"); id != "" {
			if original, err := app.FindRecordById("messages", id); err == nil {
				room = original.GetString("room")
			}
		}
		id, name := rec.Id, "Anonymous"
		if room != "" {
			id = room
			if r := anonRoomOf(app, room); !r.private {
				name = r.name
			}
		}
		rec.Set("forwarded_from", id)
		setExpanded(rec, "forwarded_from", standIn(app, id, name), false)
	}
}

// isAnonymous: is anything about this message's author kept to themselves, or the author of the message it replies to?
func isAnonymous(rec *core.Record) bool {
	return rec != nil && (rec.GetBool("anonymous") || rec.GetBool("forwarded_anonymous") || rec.ExpandedOne("reply_to") != nil)
}

var (
	// authorField: fields whose value says who wrote a message (lib/anonymous.js AUTHOR_FIELD; RE2 has no lookahead).
	authorField = regexp.MustCompile(`(?i)(^|[^a-z0-9])(author|forwarded_from)([^a-z0-9]|$)`)
	// authorBackRelation: a back-relation from users to the messages they wrote.
	authorBackRelation = regexp.MustCompile(`(?i)_via_(author|forwarded_from)([^a-z0-9_]|$)`)
	quoted             = regexp.MustCompile(`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'`)
	notIDChar          = regexp.MustCompile(`(?i)[^a-z0-9]`)
	mentionsAuthor     = regexp.MustCompile(`(?i)author|forwarded_from`)
)

const probeRefusal = "Messages can't be filtered, sorted or grouped by who wrote them."

// probes: does a filter, sort or expand say who wrote a message? An author compared with the caller only says which
// messages are the caller's own (lib/anonymous.js OWN_AUTHOR). Quoted text is a value, not a field.
func probes(filter, sort, expand, me string) bool {
	id := notIDChar.ReplaceAllString(me, "")
	if id == "" {
		id = "@"
	}
	own := regexp.MustCompile(`(?i)\b(author|forwarded_from)\s*(=|!=|\?=|\?!=)\s*(@request\.auth\.id\b|"` + id + `"|'` + id + `')`)
	fields := quoted.ReplaceAllString(own.ReplaceAllString(filter+" "+sort, ""), "''")
	return authorField.MatchString(fields) || authorBackRelation.MatchString(expand)
}

// refuseProbes: a request whose ?filter, ?sort or ?expand groups messages by author is refused, unless a superuser
// asks. The query as the request has it (decoded: %61uthor is "author"); a batch request's own requests each have theirs.
func refuseProbes(e *core.RequestEvent) error {
	q := e.Request.URL.Query()
	f, s, x := q.Get("filter"), q.Get("sort"), q.Get("expand")
	if !mentionsAuthor.MatchString(strings.Join([]string{f, s, x}, " ")) {
		return nil
	}
	me := ""
	if e.Auth != nil {
		me = e.Auth.Id
	}
	if !probes(f, s, x, me) || e.HasSuperuserAuth() {
		return nil
	}
	return e.BadRequestError(probeRefusal, nil)
}

// refuseSubscriptionProbes: the same, for the filter, sort and expand in a realtime subscription's options.
func refuseSubscriptionProbes(e *core.RealtimeSubscribeRequestEvent) error {
	if e.HasSuperuserAuth() {
		return nil
	}
	me := ""
	if e.Auth != nil {
		me = e.Auth.Id
	}
	str := func(v any) string {
		if v == nil {
			return ""
		}
		return fmt.Sprint(v)
	}
	for _, topic := range e.Subscriptions {
		at := strings.Index(topic, "?options=")
		if at < 0 {
			continue
		}
		var options struct {
			Query map[string]any `json:"query"`
		}
		raw, err := url.QueryUnescape(topic[at+len("?options="):])
		if err != nil || json.Unmarshal([]byte(raw), &options) != nil {
			continue // PocketBase ignores options it can't read
		}
		q := options.Query
		if probes(str(q["filter"]), str(q["sort"]), str(q["expand"]), me) {
			return e.BadRequestError(probeRefusal, nil)
		}
	}
	return nil
}

// bindProbes: nobody but superusers finds out who wrote a message in an anonymous room by filtering, sorting or
// expanding (§35). In Go, so none of these requests takes a JS runtime (docs/REFACTOR.md item 61): the records API's
// request hooks (any collection: a relation or back-relation reaches messages from any of them; an auth answer has the
// record too), realtime subscriptions, and a middleware for /api/chat/*, whose routes (Go or JS) answer with records.
func bindProbes(app core.App) {
	// Each calls its own event's Next: the embedded RequestEvent's is the router's chain, not the hook's.
	app.OnRecordsListRequest().BindFunc(func(e *core.RecordsListRequestEvent) error {
		if err := refuseProbes(e.RequestEvent); err != nil {
			return err
		}
		return e.Next()
	})
	record := func(e *core.RecordRequestEvent) error {
		if err := refuseProbes(e.RequestEvent); err != nil {
			return err
		}
		return e.Next()
	}
	app.OnRecordViewRequest().BindFunc(record)
	app.OnRecordCreateRequest().BindFunc(record)
	app.OnRecordUpdateRequest().BindFunc(record)
	app.OnRecordAuthRequest().BindFunc(func(e *core.RecordAuthRequestEvent) error {
		if err := refuseProbes(e.RequestEvent); err != nil {
			return err
		}
		return e.Next()
	})
	app.OnRealtimeSubscribeRequest().BindFunc(func(e *core.RealtimeSubscribeRequestEvent) error {
		if err := refuseSubscriptionProbes(e); err != nil {
			return err
		}
		return e.Next()
	})
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		se.Router.Bind(&hook.Handler[*core.RequestEvent]{
			Id: "chirkleProbes",
			// Once the session is known, before the admission's wait (admission.go): a refused request doesn't wait.
			Priority: apis.DefaultRateLimitMiddlewarePriority + 15,
			Func: func(e *core.RequestEvent) error {
				if strings.HasPrefix(e.Request.URL.Path, "/api/chat/") {
					if err := refuseProbes(e); err != nil {
						return err
					}
				}
				return e.Next()
			},
		})
		return se.Next()
	})
}
