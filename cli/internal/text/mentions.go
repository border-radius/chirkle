// Package text holds the text rules every client shares, checked by shared/vectors (docs/API.md).
package text

import "strings"

// Part is a piece of message text: plain (Handle "") or a mention, Handle in lower case without the "@".
type Part struct {
	Text   string
	Handle string
}

func handleChar(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

// SplitMentions splits text into plain strings and "@handle"s (DESIGN.md §41), as web/src/lib/mentions.ts does: an
// "@" at the start or after anything but a letter, digit, "_", "@", "." or "/", then 3–24 of [A-Za-z0-9_], not
// followed by one of those or "@". Only ASCII letters count, as in the web's regex.
func SplitMentions(s string) []Part {
	var out []Part
	at := 0
	for i := 0; i < len(s); i++ {
		if s[i] != '@' {
			continue
		}
		if i > 0 {
			p := s[i-1]
			if handleChar(p) || p == '@' || p == '.' || p == '/' {
				continue
			}
		}
		j := i + 1
		for j < len(s) && handleChar(s[j]) {
			j++
		}
		n := j - i - 1
		if n < 3 || n > 24 || j < len(s) && s[j] == '@' {
			continue
		}
		if i > at {
			out = append(out, Part{Text: s[at:i]})
		}
		out = append(out, Part{Text: s[i:j], Handle: strings.ToLower(s[i+1 : j])})
		at = j
		i = j - 1
	}
	if at < len(s) {
		out = append(out, Part{Text: s[at:]})
	}
	return out
}

// Mentions is the handles mentioned, in lower case, each once, in order.
func Mentions(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range SplitMentions(s) {
		if p.Handle != "" && !seen[p.Handle] {
			seen[p.Handle] = true
			out = append(out, p.Handle)
		}
	}
	return out
}

// MentionToken is the "@an" being typed at the end of s: where it starts and what follows the "@" so far
// (possibly empty), or start -1.
func MentionToken(s string) (start int, query string) {
	i := strings.LastIndexByte(s, '@')
	if i < 0 {
		return -1, ""
	}
	if i > 0 {
		p := s[i-1]
		if handleChar(p) || p == '@' || p == '.' || p == '/' {
			return -1, ""
		}
	}
	q := s[i+1:]
	for k := 0; k < len(q); k++ {
		if !handleChar(q[k]) {
			return -1, ""
		}
	}
	if len(q) > 24 {
		return -1, ""
	}
	return i, q
}
