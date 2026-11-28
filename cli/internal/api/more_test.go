package api

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLinkToken(t *testing.T) {
	for _, c := range []struct{ in, seg, server, token string }{
		{"https://chat.example.com/invite/abc123", "invite", "https://chat.example.com", "abc123"},
		{"http://127.0.0.1:8090/reset-password/tok.en?x=1", "reset-password", "http://127.0.0.1:8090", "tok.en"},
		{"  abc123 ", "invite", "", "abc123"},
	} {
		s, tok, err := LinkToken(c.in, c.seg)
		if err != nil || s != c.server || tok != c.token {
			t.Errorf("LinkToken(%q) = %q, %q, %v", c.in, s, tok, err)
		}
	}
	for _, bad := range []string{"", "https://x/other/abc", "https://x/invite/"} {
		if _, _, err := LinkToken(bad, "invite"); err == nil {
			t.Errorf("LinkToken(%q): no error", bad)
		}
	}
}

// Milestone 3: invite links, DMs, search, the inbox, hide and archive.
func TestInviteDMSearchInboxHideArchive(t *testing.T) {
	base := server(t)
	ctx := context.Background()
	ada, bob := signUp(t, base, "ada"), signUp(t, base, "bob")

	// An invite link to a private room: bob sees where it goes, joins, and has it.
	room, err := ada.CreateRoom(ctx, "secret-"+ada.Me().ID, "private")
	if err != nil {
		t.Fatal(err)
	}
	var inv struct {
		Invite struct{ Token string } `json:"invite"`
	}
	if err := ada.do(ctx, "POST", "/api/chat/rooms/"+room.ID+"/invite", nil, map[string]int{"days": 1}, &inv); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.InviteInfo(ctx, "nope"+inv.Invite.Token); !IsStatus(err, 404) {
		t.Errorf("a bad token: %v, want 404", err)
	}
	info, err := bob.InviteInfo(ctx, inv.Invite.Token)
	if err != nil || info.Room.ID != room.ID || info.Member {
		t.Fatalf("invite info: %+v %v", info, err)
	}
	if _, err := bob.Join(ctx, inv.Invite.Token); err != nil {
		t.Fatal(err)
	}
	rs, _ := bob.Rooms(ctx)
	if !containsRoom(rs, room.ID) {
		t.Fatal("joined, but the room isn't listed")
	}

	// A DM, found by name.
	found, err := bob.Users(ctx, ada.Me().Name)
	if err != nil || len(found) == 0 || found[0].ID != ada.Me().ID {
		t.Fatalf("users: %+v %v", found, err)
	}
	dm, err := bob.OpenDM(ctx, ada.Me().ID)
	if err != nil || !dm.IsDM() || dm.Title(bob.Me().ID) != ada.Me().Name {
		t.Fatalf("dm: %+v %v", dm, err)
	}
	again, _ := bob.OpenDM(ctx, ada.Me().ID)
	if again.ID != dm.ID {
		t.Error("opening a DM twice made two")
	}

	// Search in the room, and a reply that reaches ada's inbox.
	q, err := ada.Send(ctx, NewID(), room.ID, "the zebra crossing", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ada.Send(ctx, NewID(), room.ID, "something else", ""); err != nil {
		t.Fatal(err)
	}
	hits, err := bob.Page(ctx, room.ID, Latest, nil, "ZEBRA", 50)
	if err != nil || len(hits) != 1 || hits[0].ID != q.ID {
		t.Fatalf("search: %v %v", texts(hits), err)
	}
	if _, err := bob.Send(ctx, NewID(), room.ID, "agreed", q.ID); err != nil {
		t.Fatal(err)
	}
	var box Inbox
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(100 * time.Millisecond) {
		if box, err = ada.Inbox(ctx, ""); err == nil && len(box.Items) > 0 {
			break
		}
	}
	if len(box.Items) == 0 || box.Items[0].Kind != "reply" || box.Items[0].Quote == nil || box.Items[0].Quote.ID != q.ID ||
		!strings.Contains(box.Items[0].Message.Text, "agreed") {
		t.Fatalf("inbox: %+v %v", box, err)
	}
	if err := ada.InboxSeen(ctx); err != nil {
		t.Fatal(err)
	}

	// Hide (for bob only) and show again.
	h, err := bob.Hide(ctx, room.ID)
	if err != nil || h.ID == "" {
		t.Fatalf("hide: %+v %v", h, err)
	}
	rows, _ := bob.HiddenRooms(ctx)
	if len(rows) != 1 || rows[0].Room != room.ID {
		t.Fatalf("hidden: %+v", rows)
	}
	if err := bob.Unhide(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if rows, _ := bob.HiddenRooms(ctx); len(rows) != 0 {
		t.Fatalf("still hidden: %+v", rows)
	}

	// Archive: the creator only.
	if _, err := bob.SetArchived(ctx, room.ID, true); err == nil {
		t.Error("bob archived ada's room")
	}
	r, err := ada.SetArchived(ctx, room.ID, true)
	if err != nil || !r.Archived {
		t.Fatalf("archive: %+v %v", r, err)
	}
	if r, err = ada.SetArchived(ctx, room.ID, false); err != nil || r.Archived {
		t.Fatalf("restore: %+v %v", r, err)
	}
}
