package emoji

import (
	"os"
	"strings"
	"testing"
)

// names.txt must be the web's list (`go generate ./internal/emoji` copies it).
func TestSameAsTheWeb(t *testing.T) {
	src, err := os.ReadFile("../../../web/src/lib/emoji-names.ts")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	i := strings.Index(s, "export const NAMES = `")
	rest := s[i+len("export const NAMES = `"):]
	web := strings.TrimSpace(rest[:strings.Index(rest, "`")])
	if web != strings.TrimSpace(names) {
		t.Fatal("names.txt differs from web/src/lib/emoji-names.ts: run go generate ./internal/emoji")
	}
}

func TestFind(t *testing.T) {
	first := func(q string) string {
		if f := Find(q, 1); len(f) > 0 {
			return f[0].Emoji
		}
		return ""
	}
	for q, want := range map[string]string{"fire": "🔥", "fir": "🔥", "thumbsup": "👍"} {
		if got := first(q); got != want {
			t.Errorf("Find(%q) first = %q, want %q", q, got, want)
		}
	}
	found := false
	for _, n := range Find("ta", 8) {
		found = found || n.Emoji == "🎉"
	}
	if !found {
		t.Error(`":ta" doesn't offer 🎉 (android/PARITY.md reactions)`)
	}
	if Find("", 5) != nil {
		t.Error("empty query finds something")
	}
}

func TestTokenAndWhole(t *testing.T) {
	for in, want := range map[string]int{"hi :fi": 3, ":th": 0, "12:30": -1, "http://": -1, "a :f": -1, "(:ok": 1} {
		if got, _ := Token(in); got != want {
			t.Errorf("Token(%q) = %d, want %d", in, got, want)
		}
	}
	if got, ok := Whole("so :fire:"); !ok || got != "so 🔥" {
		t.Errorf("Whole = %q %v", got, ok)
	}
	if _, ok := Whole("at 12:30:"); ok {
		t.Error("Whole took a time")
	}
}
