package ui

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
)

// driver runs the app's commands as the program would, without a terminal: each command's message goes back into
// Update, and the commands that wait on realtime run in the background.
type driver struct {
	t    *testing.T
	app  *App
	msgs chan tea.Msg
	raw  []string // what was written to the terminal raw (notifications)
}

func newDriver(t *testing.T, app *App) *driver {
	d := &driver{t: t, app: app, msgs: make(chan tea.Msg, 256)}
	d.send(tea.WindowSizeMsg{Width: 110, Height: 30})
	d.run(app.Init())
	return d
}

func (d *driver) run(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	go func() {
		msg := cmd()
		if msg != nil {
			d.msgs <- msg
		}
	}()
}

func (d *driver) send(msg tea.Msg) {
	if r, ok := msg.(tea.RawMsg); ok {
		d.raw = append(d.raw, fmt.Sprint(r.Msg))
		return
	}
	if b, ok := msg.(tea.BatchMsg); ok {
		for _, c := range b {
			d.run(c)
		}
		return
	}
	_, cmd := d.app.Update(msg)
	d.run(cmd)
}

// until feeds messages in until the screen shows want.
func (d *driver) until(want string) string {
	d.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		screen := ansi.Strip(d.app.View().Content)
		if strings.Contains(screen, want) {
			return screen
		}
		select {
		case m := <-d.msgs:
			d.send(m)
		case <-deadline:
			d.t.Fatalf("never showed %q; the screen:\n%s", want, screen)
		}
	}
}

func (d *driver) keys(s string) {
	for _, r := range s {
		d.send(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func (d *driver) key(code rune, mod tea.KeyMod) { d.send(tea.KeyPressMsg{Code: code, Mod: mod}) }

func TestSignUpReadAndSend(t *testing.T) {
	base := os.Getenv("CHIRKLE_TEST_SERVER")
	if base == "" {
		t.Skip("CHIRKLE_TEST_SERVER not set (see internal/api/server_test.go)")
	}
	t.Setenv("CHIRKLE_CONFIG", filepath.Join(t.TempDir(), "accounts.json"))
	ctx := context.Background()

	// Someone else's room, with a message in it, a file and an escape sequence.
	other, _ := api.New(base)
	tag := fmt.Sprint(time.Now().UnixNano() % 1e9)
	if _, err := other.SignUp(ctx, api.SignUpInput{Name: "Ada" + tag, Email: "ada" + tag + "@example.com", Password: "correct horse"}); err != nil {
		t.Fatal(err)
	}
	room, err := other.CreateRoom(ctx, "tui-"+tag, "public")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := other.Send(ctx, api.NewID(), room.ID, "welcome, see https://example.org", ""); err != nil {
		t.Fatal(err)
	}

	c, _ := api.New(base)
	site, _ := c.Site(ctx)
	cfg, _ := config.Load()
	d := newDriver(t, New(c, cfg, site))

	// The signup form, from the keyboard only.
	d.until("Log in")
	d.key(tea.KeyRight, tea.ModCtrl)
	d.until("Confirm")
	for _, v := range []string{"Bob" + tag, "bob" + tag + "@example.com", "pw-long-enough", "pw-long-enough"} {
		d.keys(v)
		d.key(tea.KeyEnter, 0)
	}
	d.listed(room.ID) // logged in, the rooms loaded

	// Saved for next time.
	saved, _ := config.Load()
	if a := saved.CurrentAccount(); a == nil || a.User.Name != "Bob"+tag || a.Token == "" {
		t.Fatalf("saved account: %+v", a)
	}

	// Jump to the room and read it.
	d.key('k', tea.ModCtrl)
	d.keys("tui-" + tag)
	d.key(tea.KeyEnter, 0)
	screen := d.until("welcome, see https://example.org")
	if !strings.Contains(screen, "# tui-"+tag) {
		t.Errorf("no room header:\n%s", screen)
	}

	// Write (the composer has the focus after opening a room you can post in) and see it come back.
	d.keys("hi from the terminal")
	d.key(tea.KeyEnter, 0)
	d.until("hi from the terminal")
	d.while("sending…")
	page, _ := other.Page(ctx, room.ID, api.Latest, nil, "", 10)
	if len(page) != 2 || page[1].Text != "hi from the terminal" {
		t.Fatalf("server has %+v", page)
	}

	// A live message from someone else.
	if _, err := other.Send(ctx, api.NewID(), room.ID, "live one", ""); err != nil {
		t.Fatal(err)
	}
	screen = d.until("live one")

	// Select it, open its link picker: nothing to open, says so.
	d.key(tea.KeyEscape, 0)
	d.key(tea.KeyUp, 0)
	d.keys("o")
	d.until("No links in this message")
	d.key(tea.KeyUp, 0)
	d.key(tea.KeyUp, 0)
	d.keys("o")
	screen = d.until("Open a link")
	if !strings.Contains(screen, "1  https://example.org") {
		t.Errorf("picker:\n%s", screen)
	}
	d.key(tea.KeyEscape, 0)
	d.keys("?")
	t.Logf("the screen:\n%s", d.until("Keys"))
}

// while feeds messages in while the screen still shows s.
func (d *driver) while(s string) {
	d.t.Helper()
	deadline := time.After(10 * time.Second)
	for strings.Contains(ansi.Strip(d.app.View().Content), s) {
		select {
		case m := <-d.msgs:
			d.send(m)
		case <-deadline:
			d.t.Fatalf("still showing %q", s)
		}
	}
}

// poll asks the server until ok, feeding the program meanwhile.
func (d *driver) poll(what string, ok func() bool) {
	d.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			d.t.Fatalf("the server never had %s; the screen:\n%s", what, ansi.Strip(d.app.View().Content))
		}
		select {
		case m := <-d.msgs:
			d.send(m)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Milestone 2 (docs/CLI.md §8): "@" and ":" completion, reply, edit with ↑, react, delete, drafts kept across runs.
func TestTakingPart(t *testing.T) {
	base := os.Getenv("CHIRKLE_TEST_SERVER")
	if base == "" {
		t.Skip("CHIRKLE_TEST_SERVER not set")
	}
	t.Setenv("CHIRKLE_CONFIG", filepath.Join(t.TempDir(), "accounts.json"))
	ctx := context.Background()
	tag := fmt.Sprint(time.Now().UnixNano() % 1e9)
	ada, _ := api.New(base)
	if _, err := ada.SignUp(ctx, api.SignUpInput{Name: "Ada" + tag, Email: "ada" + tag + "@example.com", Password: "correct horse"}); err != nil {
		t.Fatal(err)
	}
	room, err := ada.CreateRoom(ctx, "part-"+tag, "public")
	if err != nil {
		t.Fatal(err)
	}
	first, err := ada.Send(ctx, api.NewID(), room.ID, "first", "")
	if err != nil {
		t.Fatal(err)
	}
	latest := func() []api.Message {
		ms, _ := ada.Page(ctx, room.ID, api.Latest, nil, "", 20)
		return ms
	}
	last := func() api.Message {
		ms := latest()
		if len(ms) == 0 {
			return api.Message{}
		}
		return ms[len(ms)-1]
	}

	bob, _ := api.New(base)
	if _, err := bob.SignUp(ctx, api.SignUpInput{Name: "Bob" + tag, Email: "bob" + tag + "@example.com", Password: "correct horse"}); err != nil {
		t.Fatal(err)
	}
	site, _ := bob.Site(ctx)
	cfg, _ := config.Load()
	open := func() *driver {
		d := newDriver(t, New(bob, cfg, site))
		d.listed(room.ID)
		d.key('k', tea.ModCtrl)
		d.keys("part-" + tag)
		d.key(tea.KeyEnter, 0)
		d.until("first")
		return d
	}
	d := open()
	handle := ada.Me().Handle

	// "@" offers Ada, tab puts her handle in; ":fire:" becomes 🔥.
	d.keys("hey @" + handle[:3])
	d.until("@" + handle)
	d.key(tea.KeyTab, 0)
	d.keys(":fire:")
	if v := d.app.compose.Value(); v != "hey @"+handle+" 🔥" {
		t.Fatalf("composer: %q", v)
	}
	d.key(tea.KeyEnter, 0)
	d.poll("the mention", func() bool {
		m := last()
		return m.Text == "hey @"+handle+" 🔥" && len(m.Mentions) == 1 && m.Mentions[0] == ada.Me().ID
	})

	// Reply to Ada's first message.
	d.key(tea.KeyEscape, 0)
	d.key(tea.KeyUp, 0)
	d.key(tea.KeyUp, 0)
	d.keys("r")
	d.until("Replying to Ada" + tag)
	d.keys("re")
	d.key(tea.KeyEnter, 0)
	d.poll("the reply", func() bool { m := last(); return m.Text == "re" && m.ReplyToID == first.ID })
	d.until("↳ Ada" + tag + ": first")
	d.while("sending…")

	// ↑ in the empty composer edits the last one.
	d.key(tea.KeyUp, 0)
	d.until("Editing")
	d.key('u', tea.ModCtrl) // clear the line
	d.keys("re, edited")
	d.key(tea.KeyEnter, 0)
	d.poll("the edit", func() bool { m := last(); return m.Text == "re, edited" && m.EditedAt != "" })
	d.until("(edited)")

	// React with the first quick reaction, on Ada's message.
	d.key(tea.KeyEscape, 0)
	for range 3 {
		d.key(tea.KeyUp, 0)
	}
	d.keys("+")
	d.until("React:")
	d.keys("fire")
	d.key(tea.KeyEnter, 0)
	d.poll("the reaction", func() bool {
		ms := latest()
		return len(ms) > 0 && len(ms[0].Reactions) == 1 && ms[0].Reactions[0].Emoji == "🔥"
	})
	d.until("🔥 1")

	// Delete my last message: asks first.
	d.keys("G")
	d.key(tea.KeyUp, 0)
	d.keys("d")
	d.until("Delete this message?")
	d.keys("n")
	d.keys("d")
	d.keys("y")
	d.poll("the delete", func() bool { return last().Deleted })
	d.until("Message deleted")

	// A draft is there next time.
	d.key(tea.KeyTab, 0)
	for d.app.focus != focusComposer {
		d.key(tea.KeyTab, 0)
	}
	d.keys("unsent words")
	d.app.quit()
	d2 := open()
	if v := d2.app.compose.Value(); v != "unsent words" {
		t.Fatalf("draft after a restart: %q", v)
	}
}

// listed waits for a room in the list (its name may be off screen when the server has many).
func (d *driver) listed(room string) {
	d.t.Helper()
	d.poll("the room "+room+" listed", func() bool { return d.app.room(room) != nil })
}
