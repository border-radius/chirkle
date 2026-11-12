package main

// Read positions (DESIGN.md §18.2): POST /api/chat/reads { room, at? }. (pb_hooks/lib/reads.js until 2026-11-12.)
//
// The most frequent write, so it is group-committed (docs/PERF.md §12): a mark that doesn't move the position forward
// is answered from a read, without the write connection; the others join a queue, and one goroutine saves whatever has
// queued in one transaction, answering each request once that has committed. Nobody's answer comes before their row is
// stored (read-your-writes, nothing lost on a crash), the saves are PocketBase's (the realtime events to the caller's
// other tabs are sent after the commit, as before), and N marks take the write connection once instead of N times.

import (
	"errors"
	"net/http"

	"github.com/pocketbase/dbx"
	validation "github.com/pocketbase/ozzo-validation/v4"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

// readsBatch: at most this many marks in one transaction (a few ms of work; more wait for the next one).
const readsBatch = 256

type readMark struct {
	user, room string
	at         types.DateTime
	done       chan readDone
}

type readDone struct {
	at  string // the stored last_read_at
	err error
}

type readKey struct{ user, room string }

type reads struct {
	app   core.App
	queue chan *readMark
}

func newReads(app core.App) *reads {
	r := &reads{app: app, queue: make(chan *readMark, 4096)}
	go r.loop()
	return r
}

func (r *reads) loop() {
	for first := range r.queue {
		batch := []*readMark{first}
	more:
		for len(batch) < readsBatch {
			select {
			case m := <-r.queue:
				batch = append(batch, m)
			default:
				break more
			}
		}
		r.save(batch)
	}
}

// save stores the latest of each (user, room)'s marks in batch, never moving a stored position back, and answers each.
func (r *reads) save(batch []*readMark) {
	latest := map[readKey]types.DateTime{}
	for _, m := range batch {
		k := readKey{m.user, m.room}
		if at, ok := latest[k]; !ok || m.at.After(at) {
			latest[k] = m.at
		}
	}
	stored := map[readKey]string{}
	err := r.app.RunInTransaction(func(tx core.App) error {
		col, err := tx.FindCachedCollectionByNameOrId("room_reads")
		if err != nil {
			return err
		}
		for k, at := range latest {
			row, _ := findRead(tx, k.user, k.room)
			if row == nil {
				row = core.NewRecord(col)
				row.Set("user", k.user)
				row.Set("room", k.room)
				row.Set("last_read_at", at)
			} else if at.After(row.GetDateTime("last_read_at")) {
				row.Set("last_read_at", at)
			} else {
				stored[k] = row.GetString("last_read_at")
				continue
			}
			if err := tx.Save(row); err != nil {
				return err
			}
			stored[k] = row.GetString("last_read_at")
		}
		return nil
	})
	for _, m := range batch {
		if err != nil {
			m.done <- readDone{err: err}
		} else {
			m.done <- readDone{at: stored[readKey{m.user, m.room}]}
		}
	}
}

func findRead(app core.App, user, room string) (*core.Record, error) {
	return app.FindFirstRecordByFilter("room_reads", "user = {:user} && room = {:room}", dbx.Params{"user": user, "room": room})
}

// route: POST /api/chat/reads { room, at? }: the caller has read `room` up to `at` (a message's `created`; default
// now). Never moves the read position back, and never past now. Idempotent. → { room, last_read_at }.
func (r *reads) route(e *core.RequestEvent) error {
	user := e.Auth
	info, err := e.RequestInfo()
	if err != nil {
		return err
	}
	roomID, _ := info.Body["room"].(string)
	// Someone else's DM (or private room) gets the same answer as a room that doesn't exist.
	if roomID == "" || visibleRoom(e.App, roomID, user.Id) == nil {
		return e.NotFoundError("The room doesn't exist.", nil)
	}
	now := types.NowDateTime()
	at := now
	if raw, given := info.Body["at"]; given {
		bad := e.BadRequestError("Failed to mark the room as read.",
			validation.Errors{"at": validation.NewError("validation_invalid_value", "Must be a date.")})
		// "" too: it would be now, which a client sending a message's `created` never means.
		s, ok := raw.(string)
		if !ok || s == "" {
			return bad
		}
		if at, err = types.ParseDateTime(s); err != nil || at.IsZero() {
			return bad
		}
		if at.After(now) {
			at = now
		}
	}
	// Already read that far: nothing to write.
	if row, _ := findRead(e.App, user.Id, roomID); row != nil && !at.After(row.GetDateTime("last_read_at")) {
		return e.JSON(http.StatusOK, map[string]string{"room": roomID, "last_read_at": row.GetString("last_read_at")})
	}
	m := &readMark{user: user.Id, room: roomID, at: at, done: make(chan readDone, 1)}
	select {
	case r.queue <- m:
	case <-e.Request.Context().Done():
		return e.Request.Context().Err()
	}
	// Waited for even when the client goes: the mark is queued and is answered once saved.
	d := <-m.done
	if d.err != nil {
		return errors.Join(errors.New("marking a room read"), d.err)
	}
	return e.JSON(http.StatusOK, map[string]string{"room": roomID, "last_read_at": d.at})
}
