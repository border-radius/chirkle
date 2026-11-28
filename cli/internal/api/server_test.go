package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// Against a real server: CHIRKLE_TEST_SERVER=http://127.0.0.1:8099 go test ./internal/api/ (CI starts
// bin/chirkle-server with an empty data directory, as the app's tests do). Skipped without it.
func server(t *testing.T) string {
	s := os.Getenv("CHIRKLE_TEST_SERVER")
	if s == "" {
		t.Skip("CHIRKLE_TEST_SERVER not set")
	}
	return s
}

func signUp(t *testing.T, base, name string) *Client {
	t.Helper()
	c, err := New(base)
	if err != nil {
		t.Fatal(err)
	}
	tag := fmt.Sprintf("%s%d", name, time.Now().UnixNano()%1e9)
	u, err := c.SignUp(context.Background(), SignUpInput{Name: tag, Email: tag + "@example.com", Password: "correct horse"})
	if err != nil {
		t.Fatalf("sign up %s: %v", tag, err)
	}
	if u.ID == "" || c.Token() == "" || u.Name != tag {
		t.Fatalf("signed up as %+v", u)
	}
	return c
}

func TestSignUpLogInRefresh(t *testing.T) {
	base := server(t)
	ctx := context.Background()
	c := signUp(t, base, "ada")
	me := c.Me()

	site, err := c.Site(ctx)
	if err != nil || site.Title == "" {
		t.Fatalf("site: %+v %v", site, err)
	}

	// The same email again: the server's field error, kept by field.
	again, _ := New(base)
	_, err = again.SignUp(ctx, SignUpInput{Name: me.Name + "x", Email: me.Name + "@example.com", Password: "correct horse"})
	var e *Error
	if !errors.As(err, &e) || e.Status != 400 || e.Fields["email"] == "" {
		t.Fatalf("duplicate signup: %#v", err)
	}
	// Refused before sending.
	_, err = again.SignUp(ctx, SignUpInput{Name: "x", Email: "x@example.com", Password: "short"})
	if !errors.As(err, &e) || e.Fields["password"] == "" {
		t.Fatalf("short password: %#v", err)
	}

	l, _ := New(base)
	if _, err := l.LogIn(ctx, me.Name+"@example.com", "wrong password"); !IsStatus(err, 400) {
		t.Fatalf("wrong password: %v", err)
	}
	u, err := l.LogIn(ctx, strings.ToUpper(me.Name)+"@example.com", "correct horse")
	if err != nil || u.ID != me.ID {
		t.Fatalf("log in: %+v %v", u, err)
	}
	if _, err := l.Refresh(ctx); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	l.SetSession("not a token", u)
	if _, err := l.Refresh(ctx); !IsStatus(err, 401) {
		t.Fatalf("refresh with a bad token: %v", err)
	}
}

func TestRoomSendLiveUnreadRead(t *testing.T) {
	base := server(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ada, bob := signUp(t, base, "ada"), signUp(t, base, "bob")

	room, err := ada.CreateRoom(ctx, fmt.Sprintf("cli-%d", time.Now().UnixNano()%1e9), "public")
	if err != nil {
		t.Fatal(err)
	}

	// Bob listens.
	topic, err := bob.LiveTopic(ctx)
	if err != nil || topic != "chat/messages" {
		t.Fatalf("live topic %q %v", topic, err)
	}
	events, status := make(chan Event, 16), make(chan Status, 4)
	go bob.Realtime(ctx, []Subscription{{Topic: topic}, {Topic: "rooms/*", Query: map[string][]string{"fields": {RoomFields}}}}, events, status)
	if s := <-status; !s.Connected || s.Reconnect {
		t.Fatalf("status %+v", s)
	}

	id := NewID()
	text := "hello \x1b[31mterminal https://example.org"
	m, err := ada.Send(ctx, id, room.ID, text, "")
	if err != nil || m.ID != id || m.Expand.Author == nil || m.Expand.Author.ID != ada.Me().ID {
		t.Fatalf("send: %+v %v", m, err)
	}
	if _, err := ada.Send(ctx, id, room.ID, text, ""); err == nil {
		t.Fatal("sending the same id twice made two messages")
	}

	for {
		select {
		case e := <-events:
			if e.Topic != topic {
				continue
			}
			var ev RecordEvent[Message]
			if err := json.Unmarshal(e.Data, &ev); err != nil {
				t.Fatal(err)
			}
			if ev.Record.ID != id {
				continue
			}
			if ev.Action != "create" || !strings.Contains(ev.Record.Text, "terminal https://example.org") || ev.Record.Expand.Author == nil {
				t.Fatalf("live event %+v", ev)
			}
			goto live
		case <-ctx.Done():
			t.Fatal("no live message")
		}
	}
live:
	u, err := bob.Unread(ctx)
	if err != nil || u.Rooms[room.ID] != 1 {
		t.Fatalf("unread %+v %v", u, err)
	}
	page, err := bob.Page(ctx, room.ID, Latest, nil, "", 50)
	if err != nil || len(page) != 1 || page[0].ID != id {
		t.Fatalf("page %+v %v", page, err)
	}
	if err := bob.MarkRead(ctx, room.ID, page[0].Created); err != nil {
		t.Fatal(err)
	}
	if u, _ := bob.Unread(ctx); u.Rooms[room.ID] != 0 {
		t.Fatalf("unread after read: %+v", u)
	}

	// Paging: oldest first whatever the kind.
	for i := range 5 {
		if _, err := ada.Send(ctx, NewID(), room.ID, fmt.Sprint(i), ""); err != nil {
			t.Fatal(err)
		}
	}
	latest, _ := bob.Page(ctx, room.ID, Latest, nil, "", 3)
	if len(latest) != 3 || latest[0].Text != "2" || latest[2].Text != "4" {
		t.Fatalf("latest %v", texts(latest))
	}
	older, _ := bob.Page(ctx, room.ID, Older, &Cursor{latest[0].Created, latest[0].ID}, "", 10)
	if len(older) != 3 || older[0].ID != id || older[2].Text != "1" {
		t.Fatalf("older %v", texts(older))
	}

	// A guest reads Open Air rooms only.
	open, err := ada.CreateRoom(ctx, fmt.Sprintf("air-%d", time.Now().UnixNano()%1e9), "open")
	if err != nil {
		t.Fatal(err)
	}
	guest, _ := New(base)
	rooms, err := guest.Rooms(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rooms {
		if r.Visibility != "open" {
			t.Errorf("a guest sees %s (%s)", r.Name, r.Visibility)
		}
	}
	if !containsRoom(rooms, open.ID) || containsRoom(rooms, room.ID) {
		t.Errorf("guest rooms: %+v", rooms)
	}
}

func texts(ms []Message) []string {
	out := make([]string, len(ms))
	for i, m := range ms {
		out[i] = m.Text
	}
	return out
}

func containsRoom(rs []Room, id string) bool {
	for _, r := range rs {
		if r.ID == id {
			return true
		}
	}
	return false
}

// TestMain turns the server's rate limits off, as the web's tests do (tests/support/pocketbase.ts), with the
// superuser in CHIRKLE_TEST_ADMIN ("email:password"). Without it, PocketBase's 2 logins per 3 s fail the tests.
func TestMain(m *testing.M) {
	if base, admin := os.Getenv("CHIRKLE_TEST_SERVER"), os.Getenv("CHIRKLE_TEST_ADMIN"); base != "" && admin != "" {
		email, pw, _ := strings.Cut(admin, ":")
		c, err := New(base)
		if err == nil {
			var a struct {
				Token string `json:"token"`
			}
			ctx := context.Background()
			err = c.do(ctx, "POST", "/api/collections/_superusers/auth-with-password", nil, map[string]string{"identity": email, "password": pw}, &a)
			if err == nil {
				c.SetSession(a.Token, nil)
				err = c.do(ctx, "PATCH", "/api/settings", nil, map[string]any{"rateLimits": map[string]any{"enabled": false}}, nil)
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "turning rate limits off:", err)
			os.Exit(1)
		}
	}
	os.Exit(m.Run())
}

func TestEditDeleteReactMentionable(t *testing.T) {
	base := server(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ada, bob := signUp(t, base, "ada"), signUp(t, base, "bob")
	room, err := ada.CreateRoom(ctx, fmt.Sprintf("acts-%d", time.Now().UnixNano()%1e9), "public")
	if err != nil {
		t.Fatal(err)
	}
	first, err := ada.Send(ctx, NewID(), room.ID, "first", "")
	if err != nil {
		t.Fatal(err)
	}
	// Bob writes in the room, so "@" offers him; a reply to Ada's message, mentioning her by handle.
	reply, err := bob.Send(ctx, NewID(), room.ID, "hey @"+ada.Me().Handle, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Expand.ReplyTo == nil || reply.Expand.ReplyTo.Text != "first" || reply.Expand.ReplyTo.Expand.Author == nil {
		t.Fatalf("reply quote: %+v", reply.Expand.ReplyTo)
	}
	if len(reply.Mentions) != 1 || reply.Mentions[0] != ada.Me().ID {
		t.Fatalf("mentions %v, want Ada (handle %q)", reply.Mentions, ada.Me().Handle)
	}
	people, err := ada.Mentionable(ctx, room.ID, bob.Me().Handle[:3])
	if err != nil || len(people) == 0 || people[0].ID != bob.Me().ID || people[0].Handle == "" {
		t.Fatalf("mentionable %+v %v", people, err)
	}

	edited, err := ada.Edit(ctx, first.ID, "first, edited")
	if err != nil || edited.Text != "first, edited" || edited.EditedAt == "" {
		t.Fatalf("edit %+v %v", edited, err)
	}
	if _, err := bob.Edit(ctx, first.ID, "not yours"); err == nil {
		t.Fatal("Bob edited Ada's message")
	}

	m, err := bob.React(ctx, first.ID, "🔥", true)
	if err != nil || len(m.Reactions) != 1 || m.Reactions[0].Emoji != "🔥" || m.Reactions[0].Users[0] != bob.Me().ID {
		t.Fatalf("react %+v %v", m.Reactions, err)
	}
	m, err = bob.React(ctx, first.ID, "🔥", false)
	if err != nil || len(m.Reactions) != 0 {
		t.Fatalf("unreact %+v %v", m.Reactions, err)
	}

	if _, err := bob.Delete(ctx, first.ID); err == nil {
		t.Fatal("Bob deleted Ada's message")
	}
	gone, err := ada.Delete(ctx, first.ID)
	if err != nil || len(gone) != 1 || !gone[0].Deleted || gone[0].Text != "" {
		t.Fatalf("delete %+v %v", gone, err)
	}
}
