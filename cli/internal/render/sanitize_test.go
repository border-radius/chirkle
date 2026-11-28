package render

import "testing"

func TestClean(t *testing.T) {
	for _, tt := range []struct{ name, in, want string }{
		{"plain", "hello, мир 👍", "hello, мир 👍"},
		{"newlines kept", "a\nb", "a\nb"},
		{"tab", "a\tb", "a    b"},
		{"CSI clear screen", "x\x1b[2Jy", "x[2Jy"},
		{"OSC window title", "\x1b]0;pwned\x07hi", "]0;pwnedhi"},
		{"OSC 52 clipboard", "\x1b]52;c;ZXZpbA==\x1b\\", "]52;c;ZXZpbA==\\"},
		{"C1 CSI", "a\u009b31mb", "a31mb"},
		{"carriage return overwrite", "safe\rEVIL", "safeEVIL"},
		{"backspace", "ab\x08\x08cd", "abcd"},
		{"DEL", "a\x7fb", "ab"},
		{"bidi override", "file‮gnp.exe", "filegnp.exe"},
		{"bidi isolate", "⁦x⁩", "x"},
	} {
		if got := Clean(tt.in); got != tt.want {
			t.Errorf("%s: Clean(%q) = %q, want %q", tt.name, tt.in, got, tt.want)
		}
	}
}

func TestOneLine(t *testing.T) {
	if got := OneLine("  Ada\n\x1b[31mLovelace "); got != "Ada [31mLovelace" {
		t.Errorf("OneLine = %q", got)
	}
}
