package main

// The messages enrich hook (every answer and PocketBase's own realtime events that carry a message): a forward shows its
// original (showOriginal, §21.3), a message read only through a forward of it keeps its room's people to itself
// (keepToRoom), and an anonymous room's message hides its author (hide, §35). In Go since 2026-11-11 (REFACTOR item 47):
// as JS it cost a hook runtime per message, and a page beyond --hooksPool made new ones.

import (
	"sync"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// checked: per request, the rooms a list route checked the caller can see (enrichInRooms), every listed message being in
// one of them. The hook then leaves those messages to the route, and a page costs no query per message. Keyed by the
// request's info, which PocketBase keeps once per request and hands to each enrich event (expanded records' too).
var checked sync.Map // *core.RequestInfo → map[string]bool

func inCheckedRoom(info *core.RequestInfo, rec *core.Record) bool {
	if info == nil {
		return false
	}
	rooms, ok := checked.Load(info)
	return ok && rooms.(map[string]bool)[rec.GetString("room")]
}

func hasReactions(rec *core.Record) bool {
	r := rec.GetString("reactions")
	return !(r == "" || r == "[]" || r == "null")
}

func bindEnrich(app core.App) {
	app.OnRecordEnrich("messages").BindFunc(func(e *core.RecordEnrichEvent) error {
		rec, info := e.Record, e.RequestInfo
		if rec != nil && !inCheckedRoom(info, rec) {
			keepToRoom(e.App, info, rec)
			showOriginal(e.App, rec)
		}
		if err := e.Next(); err != nil {
			return err
		}
		// Once expanded (in Next), by the real author.
		if isAnonymous(rec) {
			me, superuser := "", false
			if info != nil && info.Auth != nil {
				me, superuser = info.Auth.Id, info.Auth.IsSuperuser()
			}
			hide(e.App, rec, me, superuser)
		}
		return nil
	})
}

// showOriginal: a forward that isn't deleted shows its original's text, attachments and edit stamp, or nothing once
// that is deleted. Whoever sees the forward may see those. Only in the answer: nothing is saved.
func showOriginal(app core.App, rec *core.Record) {
	id := rec.GetString("forward_of")
	if id == "" || rec.GetBool("deleted") {
		return
	}
	original, err := app.FindRecordById("messages", id)
	if err != nil {
		return // being removed for good: PocketBase is about to clear forward_of
	}
	setOriginal(rec, original)
}

func setOriginal(rec, original *core.Record) {
	if original.GetBool("deleted") {
		rec.Set("text", "")
		rec.Set("files", []string{})
		rec.Set("file_names", map[string]any{})
		rec.Set("file_sources", map[string]any{})
		rec.Set("file_dims", map[string]any{})
		rec.Set("previews", []any{})
		rec.Set("edited_at", "")
		return
	}
	rec.Set("text", original.GetString("text"))
	rec.Set("files", original.GetStringSlice("files"))
	for _, f := range []string{"file_names", "file_sources", "file_dims", "previews", "edited_at"} {
		rec.Set(f, original.Get(f))
	}
}

// keepToRoom: a message read only through a forward of it (the view rule grants that, §21.3) keeps to itself what
// would say who is in its room: its reactions and the message it replies to. Most messages have neither.
func keepToRoom(app core.App, info *core.RequestInfo, rec *core.Record) {
	if info == nil || (info.Auth != nil && info.Auth.IsSuperuser()) {
		return
	}
	if rec.GetString("reply_to") == "" && !hasReactions(rec) {
		return
	}
	if visibleRoom(app, rec.GetString("room"), callerID(info.Auth)) != nil {
		return
	}
	rec.Set("reactions", []any{})
	rec.Set("reply_to", "")
}

// enrichInRooms enriches messages of `rooms` (which the caller can see) as the hook would, with one query for every
// forward's original instead of one each.
func enrichInRooms(e *core.RequestEvent, rooms []string, items []*core.Record) error {
	info, err := e.RequestInfo()
	if err != nil {
		return err
	}
	set := make(map[string]bool, len(rooms))
	for _, r := range rooms {
		set[r] = true
	}
	checked.Store(info, set)
	err = apis.EnrichRecords(e, items)
	checked.Delete(info)
	if err != nil {
		return err
	}
	showOriginals(e.App, items, set)
	return nil
}

// showOriginals: showOriginal for every message in `rooms` among records and what they expand, to any depth.
func showOriginals(app core.App, records []*core.Record, rooms map[string]bool) {
	var forwards []*core.Record
	seen := map[*core.Record]bool{}
	var visit func(rec *core.Record)
	visit = func(rec *core.Record) {
		if rec == nil || seen[rec] {
			return
		}
		seen[rec] = true
		for _, v := range rec.Expand() {
			switch x := v.(type) {
			case *core.Record:
				visit(x)
			case []*core.Record:
				for _, r := range x {
					visit(r)
				}
			}
		}
		if rec.Collection().Name != "messages" || !rooms[rec.GetString("room")] {
			return
		}
		if rec.GetString("forward_of") != "" && !rec.GetBool("deleted") {
			forwards = append(forwards, rec)
		}
	}
	for _, rec := range records {
		visit(rec)
	}
	if len(forwards) == 0 {
		return
	}
	ids := []string{}
	have := map[string]bool{}
	for _, f := range forwards {
		if id := f.GetString("forward_of"); !have[id] {
			have[id] = true
			ids = append(ids, id)
		}
	}
	originals, err := app.FindRecordsByIds("messages", ids)
	if err != nil {
		return
	}
	byID := make(map[string]*core.Record, len(originals))
	for _, o := range originals {
		byID[o.Id] = o
	}
	for _, f := range forwards {
		if o := byID[f.GetString("forward_of")]; o != nil {
			setOriginal(f, o)
		}
	}
}
