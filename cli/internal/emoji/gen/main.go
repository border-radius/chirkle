// Copies web/src/lib/emoji-names.ts's NAMES into names.txt: `go generate ./internal/emoji` from cli/.
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	src, err := os.ReadFile("../../../web/src/lib/emoji-names.ts")
	if err != nil {
		fail(err)
	}
	names, err := Extract(string(src))
	if err != nil {
		fail(err)
	}
	if err := os.WriteFile("names.txt", []byte(names+"\n"), 0o644); err != nil {
		fail(err)
	}
}

// Extract is the text of `export const NAMES = `…“.
func Extract(src string) (string, error) {
	const start = "export const NAMES = `"
	i := strings.Index(src, start)
	if i < 0 {
		return "", fmt.Errorf("no NAMES in emoji-names.ts")
	}
	rest := src[i+len(start):]
	j := strings.Index(rest, "`")
	if j < 0 {
		return "", fmt.Errorf("NAMES doesn't end")
	}
	return strings.TrimSpace(rest[:j]), nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "emoji gen:", err)
	os.Exit(1)
}
