package render

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
)

func opts() Options {
	return Options{
		Me: "u1", Width: 40, Header: true, Styles: NewStyles(true),
		FileURL: func(m, f string) string { return "https://h/api/files/messages/" + m + "/" + f },
	}
}

func plain(lines []string) string { return ansi.Strip(strings.Join(lines, "\n")) }

func TestFilesAreLinks(t *testing.T) {
	m := api.Message{ID: "m1", Author: "u2", Created: "2026-11-15 10:43:04.516Z",
		Files: []string{"cat_x.png", "v_y.mp4"}, FileNames: map[string]string{"cat_x.png": "cat.png"},
		FileDims: map[string][2]int{"cat_x.png": {640, 480}}, FileSources: map[string]string{"v_y.mp4": "m0"}}
	got := plain(Lines(opts(), m))
	for _, want := range []string{"[image] cat.png 640×480", "https://h/api/files/messages/m1/cat_x.png",
		"[video] v_y.mp4", "https://h/api/files/messages/m0/v_y.mp4"} {
		if !strings.Contains(strings.ReplaceAll(got, "\n", ""), want) {
			t.Errorf("missing %q in\n%s", want, got)
		}
	}
	links := Links(m, opts().FileURL)
	if len(links) != 2 || links[1] != "https://h/api/files/messages/m0/v_y.mp4" {
		t.Errorf("Links = %v", links)
	}
}

func TestEscapesNeverReachTheTerminal(t *testing.T) {
	m := api.Message{ID: "m1", Author: "u2", Text: "hi\x1b]0;owned\x07\x1b[2J",
		Previews: []api.Preview{{URL: "https://x.org", Title: "\x1b[31mred"}}}
	m.Expand.Author = &api.User{Name: "Eve\x1b[5m"}
	for _, l := range Lines(opts(), m) {
		if strings.Contains(ansi.Strip(l), "\x1b") {
			t.Errorf("escape left in %q", l)
		}
	}
}

func TestDeletedReplyAndWrap(t *testing.T) {
	m := api.Message{Deleted: true, Text: "secret"}
	if got := plain(Lines(opts(), m)); strings.Contains(got, "secret") || !strings.Contains(got, "Message deleted") {
		t.Errorf("deleted: %q", got)
	}
	r := api.Message{Text: strings.Repeat("word ", 30), ReplyToID: "m0"}
	r.Expand.ReplyTo = &api.ReplyTo{Text: "the original"}
	lines := Lines(opts(), r)
	for _, l := range lines {
		if w := ansi.StringWidth(l); w > 40 {
			t.Errorf("line %d cells wide: %q", w, l)
		}
	}
	if !strings.Contains(plain(lines), "↳ someone: the original") {
		t.Errorf("quote missing: %s", plain(lines))
	}
}

func TestLinksInText(t *testing.T) {
	m := api.Message{Text: "see https://example.org/a. and www.go.dev, ok"}
	got := Links(m, opts().FileURL)
	if len(got) != 2 || got[0] != "https://example.org/a" || got[1] != "https://www.go.dev" {
		t.Errorf("Links = %v", got)
	}
}
