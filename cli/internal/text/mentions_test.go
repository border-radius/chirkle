package text

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// shared/vectors/mentions.json, as the web and the app run it.
func TestMentionVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../shared/vectors/mentions.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Mentions []struct {
			Input   string            `json:"input"`
			Handles []string          `json:"handles"`
			Parts   []json.RawMessage `json:"parts"`
		} `json:"mentions"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Mentions) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Mentions {
		var want []Part
		for _, p := range c.Parts {
			var s string
			if json.Unmarshal(p, &s) == nil {
				want = append(want, Part{Text: s})
				continue
			}
			var m struct{ Handle, Text string }
			if err := json.Unmarshal(p, &m); err != nil {
				t.Fatal(err)
			}
			want = append(want, Part{Text: m.Text, Handle: m.Handle})
		}
		if got := SplitMentions(c.Input); !reflect.DeepEqual(got, want) {
			t.Errorf("SplitMentions(%q)\n got %+v\nwant %+v", c.Input, got, want)
		}
		handles := c.Handles
		if len(handles) == 0 {
			handles = nil
		}
		if got := Mentions(c.Input); !reflect.DeepEqual(got, handles) {
			t.Errorf("Mentions(%q) = %v, want %v", c.Input, got, handles)
		}
	}
}

func TestMentionToken(t *testing.T) {
	for _, c := range []struct {
		in    string
		start int
		q     string
	}{
		{"hi @an", 3, "an"},
		{"@", 0, ""},
		{"mail a@b", -1, ""},
		{"hi @ann done", -1, ""},
		{"(@bo", 1, "bo"},
	} {
		if s, q := MentionToken(c.in); s != c.start || q != c.q {
			t.Errorf("MentionToken(%q) = %d %q, want %d %q", c.in, s, q, c.start, c.q)
		}
	}
}
