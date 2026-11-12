package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/picker"
	"github.com/pocketbase/pocketbase/tools/types"
)

func testRecords() []*core.Record {
	users := core.NewBaseCollection("users")
	users.Fields.Add(
		&core.TextField{Name: "name"},
		&core.TextField{Name: "avatar"},
		&core.BoolField{Name: "no_dms"},
		&core.TextField{Name: "instance"},
		&core.TextField{Name: "secret", Hidden: true},
	)
	messages := core.NewBaseCollection("messages")
	messages.Fields.Add(
		&core.TextField{Name: "room"},
		&core.TextField{Name: "text"},
		&core.TextField{Name: "author"},
		&core.TextField{Name: "reply_to"},
		&core.BoolField{Name: "deleted"},
		&core.JSONField{Name: "files"},
		&core.JSONField{Name: "file_names"},
		&core.JSONField{Name: "reactions"},
		&core.AutodateField{Name: "created", OnCreate: true},
	)
	user := func(id, name string) *core.Record {
		u := core.NewRecord(users)
		u.Id = id
		u.Set("name", name)
		u.Set("avatar", "a.png")
		u.Set("secret", "never shown")
		return u
	}
	ann, bob := user("ann", "Ann <&>"), user("bob", "Bob")
	parent := core.NewRecord(messages)
	parent.Id = "parent"
	parent.Set("text", "first")
	parent.Set("author", "bob")
	parent.Set("files", []string{"a.png"})
	parent.SetExpand(map[string]any{"author": bob})
	m := core.NewRecord(messages)
	m.Id = "m1"
	m.Set("room", "r1")
	m.Set("text", "hi \u2028 there")
	m.Set("author", "ann")
	m.Set("reply_to", "parent")
	m.Set("file_names", map[string]any{"a.png": "Photo"})
	m.Set("reactions", []any{map[string]any{"emoji": "👍", "users": []string{"bob"}}})
	created, _ := types.ParseDateTime("2026-11-12 10:00:00.123Z")
	m.Set("created", created)
	m.SetExpand(map[string]any{"author": ann, "reply_to": parent, "people": []*core.Record{ann, bob}})
	plain := core.NewRecord(messages)
	plain.Id = "m2"
	plain.Set("text", "no expand")
	return []*core.Record{m, plain}
}

func asJSON(t *testing.T, v any) any {
	t.Helper()
	raw, err := marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPickMatchesPocketBase(t *testing.T) {
	raw, err := os.ReadFile("../shared/contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var c struct{ Fields map[string]string }
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	cases := []string{
		c.Fields["message"],
		liveFields,
		"id,text",
		"id,expand.author.name,expand.people.name,expand.reply_to.expand.author.name",
		"id,expand", // a whole expand
		"id,missing,expand.missing.x",
		"id,text:excerpt(3)",   // a modifier: the picker's
		"*,expand.author.name", // `*`: the picker's
		"file_names.a.png",     // into a JSON field: the picker's
		"id,expand.author,expand.author.name",
	}
	for _, fields := range cases {
		recs := testRecords()
		want, err := picker.Pick(recs, fields)
		if err != nil {
			t.Fatalf("%q: picker: %v", fields, err)
		}
		got, err := pick(testRecords(), fields)
		if err != nil {
			t.Fatalf("%q: pick: %v", fields, err)
		}
		if g, w := asJSON(t, got), asJSON(t, want); !reflect.DeepEqual(g, w) {
			t.Errorf("%q:\n got %v\nwant %v", fields, g, w)
		}
	}
}

func TestPickKeepsTagsStable(t *testing.T) {
	fields := liveFields
	first, _ := pick(testRecords(), fields)
	a, _ := marshal(first)
	for range 20 {
		again, _ := pick(testRecords(), fields)
		b, _ := marshal(again)
		if string(a) != string(b) {
			t.Fatal("the same records serialized differently")
		}
	}
}
