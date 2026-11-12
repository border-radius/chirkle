package main

// Live messages (docs/PERF.md §7): each message saved or deleted is sent once to every realtime client subscribed to
// liveTopic that can see its room, as the apps' rooms and activity need it. Not by PocketBase's own `messages/*`
// subscriptions, which check the list rule and run the enrich hook once per subscriber. The message is expanded once, a
// forward shows its original once, and an anonymous room's message is hidden once per way of seeing it.
//
// The event is what a `messages/*` subscription with the apps' live options sent: { action, record }, the record with
// the contract's message fields (liveFields, tests/unit/contract.test.ts), expanded with `author` and `forwarded_from`.
// Who gets it is who that subscription's list rule lets see the message: anyone who can see its room
// (tests/integration/access.matrix.test.ts).
//
// Sending never waits on a client (PERF.md §8: a slow reader held the save's hook): each client has a queue of its own,
// sent in order by a goroutine; a client whose queue is full is disconnected, and its app loads what it missed when it
// reconnects, as after any drop. Apps ask GET /api/chat/live first; a server from before has no such route (404).

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

const liveTopic = "chat/messages"

// liveFields: what an event carries, the fields the apps ask the records API for (shared/contract.json fields.message).
const liveFields = "id,room,text,created,updated,edited_at,deleted,files,file_names,file_sources,file_dims,reactions,previews,author,expand.author.id,expand.author.name,expand.author.avatar,expand.author.no_dms,expand.author.instance,reply_to,expand.reply_to.id,expand.reply_to.author,expand.reply_to.text,expand.reply_to.deleted,expand.reply_to.files,expand.reply_to.expand.author.id,expand.reply_to.expand.author.name,forwarded_from,forward_of,expand.forwarded_from.id,expand.forwarded_from.name,mentions"

// Events waiting for one client, at most. A client this far behind is disconnected.
const liveQueue = 512

// A client's sender goroutine ends after this long with nothing to send.
const liveIdle = time.Minute

type live struct {
	app    core.App
	mu     sync.Mutex
	queues map[subscriptions.Client]chan subscriptions.Message
	// dropped: clients disconnected for being too far behind, since the start (GET /api/chat/metrics).
	dropped atomic.Int64
}

// liveStats: the senders running now, the events waiting in their queues, and the clients dropped since the start.
type liveStats struct {
	Senders int   `json:"senders"`
	Queued  int   `json:"queued"`
	Dropped int64 `json:"dropped"`
}

func (l *live) stats() liveStats {
	l.mu.Lock()
	defer l.mu.Unlock()
	st := liveStats{Senders: len(l.queues), Dropped: l.dropped.Load()}
	for _, q := range l.queues {
		st.Queued += len(q)
	}
	return st
}

func newLive(app core.App) *live {
	return &live{app: app, queues: map[subscriptions.Client]chan subscriptions.Message{}}
}

func (l *live) bind() {
	// Once committed. A failure to send is logged, never the save's.
	l.app.OnRecordAfterCreateSuccess("messages").BindFunc(func(e *core.RecordEvent) error {
		err := e.Next()
		l.sendSafely(e.Record, "create")
		return err
	})
	l.app.OnRecordAfterUpdateSuccess("messages").BindFunc(func(e *core.RecordEvent) error {
		err := e.Next()
		l.sendSafely(e.Record, "update")
		return err
	})
	l.app.OnRecordAfterDeleteSuccess("messages").BindFunc(func(e *core.RecordEvent) error {
		err := e.Next()
		l.sendSafely(e.Record, "delete")
		return err
	})
}

func (l *live) sendSafely(rec *core.Record, action string) {
	if rec == nil {
		return
	}
	defer func() {
		if r := recover(); r != nil {
			l.app.Logger().Error("live: a message event wasn't sent", "message", rec.Id, "action", action, "error", r)
		}
	}()
	if err := l.send(rec, action); err != nil {
		l.app.Logger().Error("live: a message event wasn't sent", "message", rec.Id, "action", action, "error", err.Error())
	}
}

func (l *live) send(record *core.Record, action string) error {
	var listening []subscriptions.Client
	for _, c := range l.app.SubscriptionsBroker().Clients() {
		if !c.IsDiscarded() && c.HasSubscription(liveTopic) {
			listening = append(listening, c)
		}
	}
	if len(listening) == 0 {
		return nil
	}
	room, err := l.app.FindRecordById("rooms", record.GetString("room"))
	if err != nil {
		return nil // the room is gone, and with it everyone's right to see the message
	}
	acc := accessOf(room)
	base := record.Fresh()
	l.app.ExpandRecord(base, []string{"author", "forwarded_from"}, nil)
	if action != "delete" {
		showOriginal(l.app, base)
	}
	anonymous, forwardedAnonymous := base.GetBool("anonymous"), base.GetBool("forwarded_anonymous")
	author, from := base.GetString("author"), base.GetString("forwarded_from")

	payloads := map[string][]byte{}
	// The event as userID sees it: the real author only to the author (and the forward's source only to its writer).
	payload := func(key, userID string) ([]byte, error) {
		if p, ok := payloads[key]; ok {
			return p, nil
		}
		rec := base
		if key != "real" {
			rec = base.Fresh()
			rec.SetExpand(base.Expand())
			hide(l.app, rec, userID, false)
		}
		picked, err := pick(rec, liveFields)
		if err != nil {
			return nil, err
		}
		p, err := marshal(map[string]any{"action": action, "record": picked})
		if err != nil {
			return nil, err
		}
		payloads[key] = p
		return p, nil
	}

	for _, c := range listening {
		auth, _ := c.Get(apis.RealtimeClientAuthKey).(*core.Record)
		superuser := auth != nil && auth.IsSuperuser()
		userID := callerID(auth)
		if !superuser && !canSee(acc, userID) {
			continue
		}
		hidesAuthor := anonymous && author != "" && author != userID
		hidesFrom := forwardedAnonymous && from != "" && from != userID
		key := "real"
		if !superuser && (hidesAuthor || hidesFrom) {
			key = ""
			if hidesAuthor {
				key += "a"
			}
			if hidesFrom {
				key += "f"
			}
		}
		data, err := payload(key, userID)
		if err != nil {
			return err
		}
		l.enqueue(c, subscriptions.Message{Name: liveTopic, Data: data})
	}
	return nil
}

// enqueue hands m to c's sender, starting one if c has none.
func (l *live) enqueue(c subscriptions.Client, m subscriptions.Message) {
	l.mu.Lock()
	q, ok := l.queues[c]
	if !ok {
		q = make(chan subscriptions.Message, liveQueue)
		l.queues[c] = q
		go l.drain(c, q)
	}
	select {
	case q <- m:
		l.mu.Unlock()
	default:
		l.mu.Unlock()
		l.dropped.Add(1)
		l.app.Logger().Warn("live: a client is too far behind, disconnected", "client", c.Id())
		c.Discard()
	}
}

// drain sends c's queue in order. Send waits for the connection to take each event, and returns at once for a client
// that is gone (discarded); the goroutine ends when the client is gone or idle.
func (l *live) drain(c subscriptions.Client, q chan subscriptions.Message) {
	idle := time.NewTimer(liveIdle)
	defer idle.Stop()
	for {
		select {
		case m := <-q:
			if c.IsDiscarded() {
				l.forget(c, q)
				return
			}
			c.Send(m)
			idle.Reset(liveIdle)
		case <-idle.C:
			if l.forgetIfEmpty(c, q) {
				return
			}
			idle.Reset(liveIdle)
		}
	}
}

func (l *live) forget(c subscriptions.Client, q chan subscriptions.Message) {
	l.mu.Lock()
	if l.queues[c] == q {
		delete(l.queues, c)
	}
	l.mu.Unlock()
}

func (l *live) forgetIfEmpty(c subscriptions.Client, q chan subscriptions.Message) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(q) > 0 {
		return false
	}
	if l.queues[c] == q {
		delete(l.queues, c)
	}
	return true
}

// liveInfoRoute: GET /api/chat/live, that this server sends messages on liveTopic.
func liveInfoRoute(e *core.RequestEvent) error {
	return e.JSON(200, map[string]string{"topic": liveTopic})
}
