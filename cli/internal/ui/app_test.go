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
	d.until("tui-" + tag) // the room list is up: logged in

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
