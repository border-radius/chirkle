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

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
)

// Milestone 3 (docs/CLI.md §8): search and going to a message further back, a DM, the inbox, hide and archive.
func TestFindingThings(t *testing.T) {
	base := os.Getenv("CHIRKLE_TEST_SERVER")
	if base == "" {
		t.Skip("CHIRKLE_TEST_SERVER not set")
	}
	t.Setenv("CHIRKLE_CONFIG", filepath.Join(t.TempDir(), "accounts.json"))
	ctx := context.Background()
	tag := fmt.Sprint(time.Now().UnixNano() % 1e9)
	signUp := func(name string) *api.Client {
		c, _ := api.New(base)
		if _, err := c.SignUp(ctx, api.SignUpInput{Name: name + tag, Email: strings.ToLower(name) + tag + "@example.com", Password: "correct horse"}); err != nil {
			t.Fatal(err)
		}
		return c
	}
	ada, bob := signUp("Ada"), signUp("Bob")
	room, err := ada.CreateRoom(ctx, "far-"+tag, "public")
	if err != nil {
		t.Fatal(err)
	}
	// The needle, then more than a page after it: it isn't in the window opening the room loads.
	for i, text := range append([]string{"needle in the haystack"}, make([]string, 79)...) {
		if text == "" {
			text = fmt.Sprintf("hay %d", i)
		}
		if _, err := ada.Send(ctx, api.NewID(), room.ID, text, ""); err != nil {
			t.Fatal(err)
		}
	}
	mine, err := bob.CreateRoom(ctx, "mine-"+tag, "public")
	if err != nil {
		t.Fatal(err)
	}

	site, _ := bob.Site(ctx)
	cfg, _ := config.Load()
	d := newDriver(t, New(bob, cfg, site))
	d.until("far-" + tag)

	// Search, and go to a message further back than the window.
	d.key('k', tea.ModCtrl)
	d.keys("far-" + tag)
	d.key(tea.KeyEnter, 0)
	d.until("hay 79")
	d.key(tea.KeyEscape, 0) // out of the composer
	d.keys("/needle")
	d.key(tea.KeyEnter, 0)
	d.until("› ")
	d.key(tea.KeyEnter, 0)
	screen := d.until("▌ needle in the haystack")
	if strings.Contains(screen, "hay 79") || !d.app.rs(room.ID).newer {
		t.Fatalf("not a window around the needle:\n%s", screen)
	}
	d.keys("G")
	d.until("hay 79")
	if d.app.rs(room.ID).newer {
		t.Fatal("G didn't go to the latest")
	}

	// Bob says something there; Ada answers it: it is in Bob's Mentions & replies, and Enter goes to it.
	d.keys("i")
	d.keys("bob here")
	d.key(tea.KeyEnter, 0)
	d.while("sending…")
	page, _ := ada.Page(ctx, room.ID, api.Latest, nil, "", 1)
	if len(page) != 1 || page[0].Text != "bob here" {
		t.Fatalf("latest: %v", page)
	}
	if _, err := ada.Send(ctx, api.NewID(), room.ID, "welcome bob", page[0].ID); err != nil {
		t.Fatal(err)
	}
	d.until("welcome bob")
	d.key(tea.KeyEscape, 0)
	d.keys("I")
	d.until("replied in far-" + tag)
	d.key(tea.KeyEnter, 0)
	d.while("Mentions & replies")

	// A DM, by name.
	d.keys("D")
	d.keys("Ada" + tag)
	d.until("› Ada" + tag)
	d.key(tea.KeyEnter, 0)
	d.poll("the DM open", func() bool { r := d.app.room(d.app.open); return r != nil && r.IsDM() })
	if d.app.focus != focusComposer {
		t.Fatal("a new DM doesn't open in the composer")
	}
	d.keys("hello ada")
	d.key(tea.KeyEnter, 0)
	d.until("hello ada")
	d.poll("the DM's message", func() bool {
		rs, _ := ada.Rooms(ctx)
		for _, r := range rs {
			if r.IsDM() {
				p, _ := ada.Page(ctx, r.ID, api.Latest, nil, "", 1)
				return len(p) == 1 && p[0].Text == "hello ada"
			}
		}
		return false
	})

	// Hide a room (for Bob only) and show it again; archive his own.
	d.key('k', tea.ModCtrl)
	d.keys("far-" + tag)
	d.key(tea.KeyEnter, 0)
	d.key(tea.KeyEscape, 0)
	d.keys("H")
	d.until("Hidden: far-" + tag)
	d.poll("the hidden row", func() bool { rows, _ := bob.HiddenRooms(ctx); return len(rows) == 1 })
	d.keys("H")
	d.until("Shown again")
	d.key('k', tea.ModCtrl)
	d.keys("mine-" + tag)
	d.key(tea.KeyEnter, 0)
	d.key(tea.KeyEscape, 0)
	d.keys("A")
	d.until("Archive mine-" + tag + " for everyone?")
	d.keys("y")
	d.until("archived, read-only")
	d.poll("the room archived", func() bool {
		rs, _ := bob.Rooms(ctx)
		for _, r := range rs {
			if r.ID == mine.ID {
				return r.Archived
			}
		}
		return false
	})
}
