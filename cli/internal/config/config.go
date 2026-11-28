// Package config keeps the saved accounts: $XDG_CONFIG_HOME/chirkle/accounts.json, readable by its owner only.
package config

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/border-radius/chirkle/cli/internal/api"
)

// Account is a session on one server.
type Account struct {
	Server string   `json:"server"`
	Token  string   `json:"token"`
	User   api.User `json:"user"`
}

// File is the accounts file. Current indexes Accounts; -1 for none.
type File struct {
	Current  int       `json:"current"`
	Accounts []Account `json:"accounts"`
}

// Path is where the file is ($CHIRKLE_CONFIG overrides, for tests).
func Path() (string, error) {
	if p := os.Getenv("CHIRKLE_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "chirkle", "accounts.json"), nil
}

// Load reads the file; a missing one is empty.
func Load() (*File, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return &File{Current: -1}, nil
	}
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	if f.Current >= len(f.Accounts) {
		f.Current = len(f.Accounts) - 1
	}
	return &f, nil
}

// Save writes the file atomically with mode 0600: it holds session tokens.
func (f *File) Save() error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".accounts-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

// CurrentAccount is the account in use, or nil.
func (f *File) CurrentAccount() *Account {
	if f.Current < 0 || f.Current >= len(f.Accounts) {
		return nil
	}
	return &f.Accounts[f.Current]
}

// Put adds or replaces the account (same server and user) and makes it current.
func (f *File) Put(a Account) {
	for i, old := range f.Accounts {
		if old.Server == a.Server && old.User.ID == a.User.ID {
			f.Accounts[i] = a
			f.Current = i
			return
		}
	}
	f.Accounts = append(f.Accounts, a)
	f.Current = len(f.Accounts) - 1
}

// Remove drops the current account.
func (f *File) Remove() {
	if f.CurrentAccount() == nil {
		return
	}
	f.Accounts = append(f.Accounts[:f.Current], f.Accounts[f.Current+1:]...)
	f.Current = len(f.Accounts) - 1
}
