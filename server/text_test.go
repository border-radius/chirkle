package main

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
)

// The shared text vectors (shared/vectors/text.json) every client and the server run.
func TestTextVectors(t *testing.T) {
	raw, err := os.ReadFile("../shared/vectors/text.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		FoldKey     []struct{ Input, Output string }
		SearchWords []struct {
			Input  string
			Output []string
		}
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.FoldKey) == 0 || len(v.SearchWords) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.FoldKey {
		if got := searchKey(c.Input); got != c.Output {
			t.Errorf("searchKey(%q) = %q, want %q", c.Input, got, c.Output)
		}
	}
	for _, c := range v.SearchWords {
		if got := searchWords(c.Input); !slices.Equal(got, c.Output) {
			t.Errorf("searchWords(%q) = %q, want %q", c.Input, got, c.Output)
		}
	}
}

func TestProbes(t *testing.T) {
	cases := []struct {
		filter, sort, expand, me string
		want                     bool
	}{
		{"author = 'x'", "", "", "me1", true},
		{"", "-author", "", "me1", true},
		{"", "", "messages_via_author", "me1", true},
		{"", "", "messages_via_author_x", "me1", false},
		{"text ~ 'author'", "", "", "me1", false},
		{"author != @request.auth.id", "", "", "me1", false},
		{"author = \"me1\" && room = 'r'", "", "", "me1", false},
		{"author = \"other\"", "", "", "me1", true},
		{"reply_to.author = {:x}", "", "", "", true},
		{"coauthor = 1", "", "", "", false},
		{"expand.forwarded_from.name", "", "", "", true},
	}
	for _, c := range cases {
		if got := probes(c.filter, c.sort, c.expand, c.me); got != c.want {
			t.Errorf("probes(%q, %q, %q) = %v, want %v", c.filter, c.sort, c.expand, got, c.want)
		}
	}
}

func TestLeadingInt(t *testing.T) {
	for s, want := range map[string]int{"": 50, "0": 50, "12": 12, " 12abc": 12, "-3": -3, "x": 50, "+7": 7} {
		if got := leadingInt(s, 50); got != want {
			t.Errorf("leadingInt(%q) = %d, want %d", s, got, want)
		}
	}
}
