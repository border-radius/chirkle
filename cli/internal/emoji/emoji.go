// Package emoji finds emoji by name (DESIGN.md §20.6): ":name" in the composer and the reaction picker. names.txt is
// web/src/lib/emoji-names.ts's NAMES, copied by `go generate` (emoji_test.go fails when they differ).
package emoji

//go:generate go run ./gen

import (
	_ "embed"
	"sort"
	"strings"
)

//go:embed names.txt
var names string

// Named is an emoji, its short name (as in ":thumbsup:") and every word it is found by.
type Named struct {
	Emoji, Name string
	Words       []string
}

var all = func() []Named {
	var out []Named
	for _, line := range strings.Split(strings.TrimSpace(names), "\n") {
		f := strings.Split(line, " ")
		if len(f) < 2 {
			continue
		}
		seen := map[string]bool{}
		var words []string
		add := func(w string) {
			if w != "" && !seen[w] {
				seen[w] = true
				words = append(words, w)
			}
		}
		add(f[1])
		for _, w := range f[1:] {
			for _, p := range strings.Split(w, "_") {
				add(p)
			}
		}
		out = append(out, Named{Emoji: f[0], Name: f[1], Words: words})
	}
	return out
}()

var byName = func() map[string]string {
	m := map[string]string{}
	for _, n := range all {
		m[n.Name] = n.Emoji
	}
	return m
}()

// All is every emoji, in the picker's order.
func All() []Named { return all }

// ByName is the emoji called exactly name (":fire:" → 🔥), or "".
func ByName(name string) string { return byName[strings.ToLower(name)] }

// Find is what query finds, as the web's findEmoji: each of its words begins one of an emoji's words; the exact name
// first, then names beginning with it (shorter first), then the rest in the picker's order.
func Find(query string, max int) []Named {
	parts := strings.FieldsFunc(strings.ToLower(strings.TrimSpace(query)), func(r rune) bool { return r == ' ' || r == '_' || r == '\t' })
	if len(parts) == 0 {
		return nil
	}
	joined := strings.Join(parts, "_")
	type hit struct {
		n       Named
		i, rank int
	}
	var hits []hit
	for i, n := range all {
		ok := true
		for _, p := range parts {
			found := false
			for _, w := range n.Words {
				if strings.HasPrefix(w, p) {
					found = true
					break
				}
			}
			if !found {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		r := 2
		switch {
		case n.Name == joined:
			r = 0
		case strings.HasPrefix(n.Name, joined):
			r = 1
		}
		hits = append(hits, hit{n, i, r})
	}
	sort.SliceStable(hits, func(a, b int) bool {
		x, y := hits[a], hits[b]
		if x.rank != y.rank {
			return x.rank < y.rank
		}
		if x.rank == 1 && len(x.n.Name) != len(y.n.Name) {
			return len(x.n.Name) < len(y.n.Name)
		}
		return x.i < y.i
	})
	if max > 0 && len(hits) > max {
		hits = hits[:max]
	}
	out := make([]Named, len(hits))
	for i, h := range hits {
		out[i] = h.n
	}
	return out
}

// Token is the ":name" being typed at the end of s (at the start or after a space or "(", two characters at least,
// of [\w+-]): where it starts and the name in lower case, or start -1. Not "12:30" nor "http://".
func Token(s string) (start int, query string) {
	i := strings.LastIndexByte(s, ':')
	if i < 0 || len(s)-i-1 < 2 {
		return -1, ""
	}
	if i > 0 && !strings.ContainsRune(" \t\n(", rune(s[i-1])) {
		return -1, ""
	}
	for _, c := range s[i+1:] {
		if !(c == '_' || c == '+' || c == '-' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9') {
			return -1, ""
		}
	}
	return i, strings.ToLower(s[i+1:])
}

// Whole turns a complete ":name:" at the end of s into its emoji, as typing the second colon does on the web.
func Whole(s string) (string, bool) {
	if !strings.HasSuffix(s, ":") {
		return s, false
	}
	start, q := Token(s[:len(s)-1])
	if start < 0 {
		return s, false
	}
	e := ByName(q)
	if e == "" {
		return s, false
	}
	return s[:start] + e, true
}

// Quick are the reactions offered before anything is typed.
var Quick = []string{"👍", "❤️", "😂", "🎉", "😮", "😢", "🔥", "👀"}
