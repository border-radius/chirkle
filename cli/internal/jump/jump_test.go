package jump

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"testing"
)

type vRoom struct {
	ID, Name, Dm, Created string
	LastMessageAt         string `json:"last_message_at"`
}

type vColl struct {
	ID, Name  string
	LastAdded string `json:"last_added"`
}

type vectors struct {
	Fold  []struct{ Input, Output string }
	Score []struct {
		Name, Query string
		Output      int
	}
	Order []struct {
		Name        string
		Sections    struct{ Rooms, Dms, Hidden, Archived []vRoom }
		Collections struct{ Mine, Subs []vColl }
		Opened      map[string]string
		Current     *string
		Query       string
		Output      []string
		Filler      *struct {
			Count   int
			Created string
		}
	}
}

func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/vectors/jump.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Fold {
		if got := Fold(c.Input); got != c.Output {
			t.Errorf("Fold(%q) = %q, want %q", c.Input, got, c.Output)
		}
	}
	for _, c := range v.Score {
		if got := Score(c.Name, Fold(c.Query)); got != c.Output {
			t.Errorf("Score(%q, %q) = %d, want %d", c.Name, c.Query, got, c.Output)
		}
	}
	for _, c := range v.Order {
		cur := ""
		if c.Current != nil {
			cur = *c.Current
		}
		var all []Target
		add := func(rs []vRoom, away bool) {
			for _, r := range rs {
				name := r.Name
				if r.Dm != "" {
					name = r.Dm
				}
				all = append(all, Room(r.ID, name, r.Created, r.LastMessageAt, c.Opened[r.ID], away, r.ID == cur))
			}
		}
		rooms := c.Sections.Rooms
		if c.Filler != nil {
			for i := range c.Filler.Count {
				rooms = append(rooms, vRoom{ID: fmt.Sprintf("f%d", i), Name: fmt.Sprintf("room %d", i), Created: c.Filler.Created})
			}
		}
		add(rooms, false)
		add(c.Sections.Dms, false)
		add(c.Sections.Hidden, true)
		add(c.Sections.Archived, true)
		for _, col := range append(c.Collections.Mine, c.Collections.Subs...) {
			at := col.LastAdded
			if o := c.Opened[col.ID]; o > at {
				at = o
			}
			all = append(all, Target{ID: col.ID, Name: col.Name, At: at, Made: at == "", Current: col.ID == cur})
		}
		var got []string
		for _, x := range Matches(all, c.Query) {
			got = append(got, x.Name)
		}
		if !slices.Equal(got, c.Output) && !(len(got) == 0 && len(c.Output) == 0) {
			t.Errorf("%s:\n got  %q\n want %q", c.Name, got, c.Output)
		}
	}
}
