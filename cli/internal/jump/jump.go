// Package jump is Jump to's matching and ordering (DESIGN.md §32), as web/src/views/switcher.ts does it:
// shared/vectors/jump.json checks both.
package jump

import (
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Max is how many are shown.
const Max = 50

// Fold drops case, accents and width: "élan" and "ＥＬＡＮ" are found by "elan".
func Fold(s string) string {
	var b strings.Builder
	for _, r := range norm.NFKD.String(s) {
		if unicode.Is(unicode.M, r) {
			continue
		}
		b.WriteString(strings.ToLower(string(r)))
	}
	return b.String()
}

func word(r rune) bool { return unicode.IsLetter(r) || unicode.IsNumber(r) }

// Score is how well name matches the folded query q, best first: 0 the whole name, 1 its start, 2 a word's start,
// 3 inside a word, 4 its letters in order ("gnrl" finds "general"); -1 not at all.
func Score(name, q string) int {
	n := Fold(name)
	if n == q {
		return 0
	}
	for i := strings.Index(n, q); i >= 0; {
		if i == 0 {
			return 1
		}
		prev := []rune(n[:i])
		if !word(prev[len(prev)-1]) {
			return 2
		}
		j := strings.Index(n[i+1:], q)
		if j < 0 {
			break
		}
		i += 1 + j
	}
	if strings.Contains(n, q) {
		return 3
	}
	letters := []rune(strings.Join(strings.Fields(q), ""))
	j := 0
	for _, c := range n {
		if j < len(letters) && c == letters[j] {
			j++
		}
	}
	if j == len(letters) {
		return 4
	}
	return -1
}

// Target is somewhere to jump to.
type Target struct {
	ID      string
	Name    string
	At      string // its last activity (a message, or when you opened it), else when it was made
	Made    bool   // no activity: only made
	Away    bool   // hidden or archived
	Current bool   // where you are
}

// Room makes a room's target: lastMessage and opened are "" when unknown.
func Room(id, name, created, lastMessage, opened string, away, current bool) Target {
	active := lastMessage
	if opened > active {
		active = opened
	}
	t := Target{ID: id, Name: name, At: active, Away: away, Current: current}
	if active == "" {
		t.At, t.Made = created, true
	}
	return t
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func recent(a, b Target) int {
	if d := b2i(a.Current) - b2i(b.Current); d != 0 {
		return d
	}
	if d := b2i(a.Made) - b2i(b.Made); d != 0 {
		return d
	}
	return strings.Compare(b.At, a.At)
}

// Matches is what to show for query: the best matches first, then those not hidden or archived, then the most
// recent. With nothing typed, everything but hidden and archived, most recent first, with where you are last. A
// leading "#" or "@" is ignored.
func Matches(all []Target, query string) []Target {
	q := strings.TrimSpace(query)
	if strings.HasPrefix(q, "#") || strings.HasPrefix(q, "@") {
		q = q[1:]
	}
	q = Fold(strings.TrimSpace(q))
	if q == "" {
		var rest, here []Target
		for _, t := range all {
			switch {
			case t.Away:
			case t.Current:
				here = append(here, t)
			default:
				rest = append(rest, t)
			}
		}
		sort.SliceStable(rest, func(i, j int) bool { return recent(rest[i], rest[j]) < 0 })
		if n := Max - len(here); len(rest) > n {
			rest = rest[:max(0, n)]
		}
		return append(rest, here...)
	}
	type scored struct {
		t Target
		n int
	}
	var s []scored
	for _, t := range all {
		if n := Score(t.Name, q); n >= 0 {
			s = append(s, scored{t, n})
		}
	}
	sort.SliceStable(s, func(i, j int) bool {
		a, b := s[i], s[j]
		if a.n != b.n {
			return a.n < b.n
		}
		if a.t.Away != b.t.Away {
			return !a.t.Away
		}
		return recent(a.t, b.t) < 0
	})
	var out []Target
	for i, x := range s {
		if i == Max {
			break
		}
		out = append(out, x.t)
	}
	return out
}
