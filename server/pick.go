package main

// ?fields= without the round trip (docs/PERF.md §13). PocketBase's picker (tools/picker, used by e.JSON) serializes
// the records, parses that back and then drops what isn't asked for: a quarter of a small VPS's CPU at 400 busy users.
// pick takes the same fields straight from the records' public export, so each answer is serialized once. It handles
// what the apps ask for (names and dotted paths, expand.author.name); anything else (modifiers such as :excerpt(),
// `*`, a field asked for whole and in part) goes to PocketBase's picker, as does a path into a value that is neither a
// record nor an object. Same answer either way: tests/integration (the contract fields) and pick_test.go compare them.

import (
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/picker"
)

type fieldNode struct {
	whole bool
	sub   map[string]*fieldNode
}

// parseFields: the tree of a plain ?fields= list, or false for what only PocketBase's picker does.
func parseFields(raw string) (*fieldNode, bool) {
	root := &fieldNode{sub: map[string]*fieldNode{}}
	for _, f := range strings.Split(raw, ",") {
		f = strings.TrimSpace(f)
		if f == "" || strings.ContainsAny(f, ":*()'\"` \t\n") {
			return nil, false
		}
		n := root
		parts := strings.Split(f, ".")
		for i, p := range parts {
			if p == "" {
				return nil, false
			}
			child := n.sub[p]
			if child == nil {
				child = &fieldNode{sub: map[string]*fieldNode{}}
				n.sub[p] = child
			}
			if i == len(parts)-1 {
				child.whole = true
			}
			// Whole and in part: the picker's answer depends on its map order.
			if child.whole && len(child.sub) > 0 {
				return nil, false
			}
			n = child
		}
	}
	return root, true
}

var errPickFallback = errors.New("fields need the picker")

func project(v any, n *fieldNode) (any, error) {
	switch x := v.(type) {
	case *core.Record:
		if x == nil {
			return nil, nil
		}
		return projectMap(x.PublicExport(), n)
	case []*core.Record:
		if x == nil {
			return nil, nil
		}
		out := make([]any, len(x))
		for i, r := range x {
			p, err := project(r, n)
			if err != nil {
				return nil, err
			}
			out[i] = p
		}
		return out, nil
	case map[string]any:
		return projectMap(x, n)
	}
	return nil, errPickFallback
}

func projectMap(m map[string]any, n *fieldNode) (map[string]any, error) {
	out := make(map[string]any, len(n.sub))
	for k, child := range n.sub {
		v, ok := m[k]
		if !ok {
			continue
		}
		if child.whole {
			out[k] = v
			continue
		}
		p, err := project(v, child)
		if err != nil {
			return nil, err
		}
		out[k] = p
	}
	return out, nil
}

// pick: data (a record or records) with only `fields`, as PocketBase's e.JSON would answer it. "" keeps everything.
func pick(data any, fields string) (any, error) {
	if fields == "" {
		return data, nil
	}
	if tree, ok := parseFields(fields); ok {
		p, err := project(data, tree)
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, errPickFallback) {
			return nil, err
		}
	}
	picked, err := picker.Pick(data, fields)
	// As e.JSON: data a modifier can't apply to is answered as it is.
	if err != nil {
		if errors.Is(err, picker.ErrInvalidModifierData) {
			return data, nil
		}
		return nil, err
	}
	return picked, nil
}

// marshal: as Record.MarshalJSON does, keys in order (the ETags hash it).
func marshal(v any) ([]byte, error) {
	return jsonv2.Marshal(v, jsonv2.Deterministic(true), jsontext.AllowDuplicateNames(true), jsontext.AllowInvalidUTF8(true))
}

// writePicked answers 200 with data as ?fields= asks, serialized once.
func writePicked(e *core.RequestEvent, fields string, data any) error {
	p, err := pick(data, fields)
	if err != nil {
		return err
	}
	raw, err := marshal(p)
	if err != nil {
		return err
	}
	return e.Blob(200, "application/json", raw)
}
