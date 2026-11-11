package main

// Room access (DESIGN.md §23), as pb_hooks/lib/access.js says it: who can see a room. The rooms view rule, lib/access.js
// and this must agree: tests/integration/access.matrix.test.ts checks every way in (these routes among them).

import (
	"slices"

	"github.com/pocketbase/pocketbase/core"
)

// seesSQL is canSee for a signed-in user as an SQL condition on `rooms r`, with the user's id bound as {:me}
// (lib/access.js SEES_SQL).
const seesSQL = "(r.visibility != 'private' OR r.created_by = {:me} OR EXISTS (SELECT 1 FROM json_each(r.members) WHERE value = {:me}))"

// access is what decides who can see a room, copied out of the record.
type access struct {
	visibility string
	archived   bool
	createdBy  string
	members    []string
}

func accessOf(room *core.Record) access {
	return access{
		visibility: room.GetString("visibility"),
		archived:   room.GetBool("archived"),
		createdBy:  room.GetString("created_by"),
		members:    room.GetStringSlice("members"),
	}
}

// canSee: can userID ("" for a guest) see the room? Open Air rooms that aren't archived: anyone. Otherwise only signed
// in: any public room, or a private one (DMs too) they are a member or the creator of.
func canSee(a access, userID string) bool {
	if a.visibility == "open" && !a.archived {
		return true
	}
	if userID == "" {
		return false
	}
	return a.visibility != "private" || a.createdBy == userID || slices.Contains(a.members, userID)
}

// visibleRoom is the room if userID can see it, else nil (also for a room that doesn't exist).
func visibleRoom(app core.App, roomID, userID string) *core.Record {
	if roomID == "" {
		return nil
	}
	room, err := app.FindRecordById("rooms", roomID)
	if err != nil || !canSee(accessOf(room), userID) {
		return nil
	}
	return room
}

// callerID is the signed-in user's id, "" for guests and superusers (whom no room is hidden from).
func callerID(auth *core.Record) string {
	if auth == nil || auth.IsSuperuser() {
		return ""
	}
	return auth.Id
}
