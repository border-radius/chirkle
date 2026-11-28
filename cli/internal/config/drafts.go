package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Drafts are what was being typed in each room, kept across runs (as the web keeps them across reloads): a file
// next to the accounts, by server, user and room.
type Drafts struct {
	path string
	By   map[string]string `json:"drafts"`
}

func draftKey(server, user, room string) string { return server + " " + user + " " + room }

// LoadDrafts reads the drafts file; a missing or broken one is empty.
func LoadDrafts() *Drafts {
	d := &Drafts{By: map[string]string{}}
	p, err := Path()
	if err != nil {
		return d
	}
	d.path = filepath.Join(filepath.Dir(p), "drafts.json")
	if raw, err := os.ReadFile(d.path); err == nil {
		_ = json.Unmarshal(raw, d)
		if d.By == nil {
			d.By = map[string]string{}
		}
	}
	return d
}

// Get is a room's draft.
func (d *Drafts) Get(server, user, room string) string { return d.By[draftKey(server, user, room)] }

// Set keeps a room's draft ("" forgets it).
func (d *Drafts) Set(server, user, room, text string) {
	k := draftKey(server, user, room)
	if text == "" {
		delete(d.By, k)
	} else {
		d.By[k] = text
	}
}

// Forget drops every draft of an account (on logout).
func (d *Drafts) Forget(server, user string) {
	prefix := server + " " + user + " "
	for k := range d.By {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(d.By, k)
		}
	}
}

// Save writes the file, owner-only: drafts are private.
func (d *Drafts) Save() error {
	if d.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(d.path), 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	tmp := d.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, d.path)
}
