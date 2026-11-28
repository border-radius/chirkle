// Package render turns messages into terminal lines. Everything from the server goes through Clean first: text
// that reaches a terminal raw could carry escape sequences (retitle the window, rewrite the screen, fake a prompt,
// set the clipboard), the console's counterpart of the web's xss spec (docs/CLI.md §5).
package render

import (
	"strings"
)

// Clean removes what a terminal would act on rather than show: C0 and C1 control characters (ESC, CSI, OSC, BEL,
// CR, backspace…), DEL, and the bidi controls that make text read in another order than it is written
// (U+202A–202E, U+2066–2069, U+200E/F, U+061C). Newlines are kept and tabs become spaces.
func Clean(s string) string {
	if s == "" {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteRune(r)
		case r == '\t':
			b.WriteString("    ")
		case r < 0x20, r == 0x7f, r >= 0x80 && r < 0xa0:
			// control: dropped
		case r >= 0x202a && r <= 0x202e, r >= 0x2066 && r <= 0x2069, r == 0x200e, r == 0x200f, r == 0x061c:
			// bidi control: dropped
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// OneLine is Clean with newlines turned into spaces: names, room names, titles, quotes.
func OneLine(s string) string {
	return strings.Join(strings.Fields(Clean(s)), " ")
}
