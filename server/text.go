package main

// What message search matches (§29, messages.text_key), as pb_hooks/lib/text.js searchKey: the text without invisible
// characters, NFKC, full case folding by upper then lower (so "ß" matches "SS"), and "İ" as "i". Checked against
// shared/vectors/text.json (foldKey, searchWords) by text_test.go.

import (
	"regexp"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// invisible: zero-width spaces and joiners, bidi marks/overrides/isolates, word joiners, BOM, soft hyphen
// (lib/text.js INVISIBLE).
var invisible = regexp.MustCompile(`[\x{00ad}\x{180e}\x{200b}-\x{200f}\x{202a}-\x{202e}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{feff}]`)

func searchKey(text string) string {
	s := norm.NFKC.String(invisible.ReplaceAllString(text, ""))
	s = cases.Lower(language.Und).String(cases.Upper(language.Und).String(s))
	return strings.ReplaceAll(s, "i\u0307", "i")
}
