package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
)

// session is the saved current account's client, its session renewed.
func session(ctx context.Context) (*api.Client, *config.File, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	a := cfg.CurrentAccount()
	if a == nil {
		return nil, nil, errors.New("not logged in: chirk login first")
	}
	c, err := api.New(a.Server)
	if err != nil {
		return nil, nil, err
	}
	c.SetSession(a.Token, &a.User)
	u, err := c.Refresh(ctx)
	if err != nil {
		if api.IsStatus(err, 401) || api.IsStatus(err, 403) || api.IsStatus(err, 404) {
			return nil, nil, errors.New("the session is over: chirk login again")
		}
		return nil, nil, err
	}
	a.Token, a.User = c.Token(), *u
	_ = cfg.Save()
	return c, cfg, nil
}

// exportCommand asks for your data as a file, waits for it to be made and downloads it (DESIGN.md §43.2).
func exportCommand(args []string) error {
	fs := flag.NewFlagSet("chirk export", flag.ContinueOnError)
	out := fs.String("o", "", "where to write it (default: the server's file name, here)")
	wait := fs.Duration("wait", 30*time.Minute, "how long to wait for it to be made")
	if err := fs.Parse(args); err != nil {
		return err
	}
	ctx := context.Background()
	c, _, err := session(ctx)
	if err != nil {
		return err
	}
	ex, err := c.StartExport(ctx)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(*wait)
	for ex.State == "queued" {
		if time.Now().After(deadline) {
			return errors.New("it isn't made yet: run chirk export again later (it carries on)")
		}
		fmt.Fprint(os.Stderr, ".")
		time.Sleep(3 * time.Second)
		if ex, err = c.ExportState(ctx); err != nil {
			return err
		}
	}
	fmt.Fprintln(os.Stderr)
	if ex.State != "done" {
		return fmt.Errorf("the export %s: try again later", ex.State)
	}
	path := *out
	tmp, err := os.CreateTemp(".", ".chirk-export-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	name, err := c.DownloadExport(ctx, tmp)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if path == "" {
		path = name
		if path == "" || path == "." || path == "/" {
			path = "chirkle-export.zip"
		}
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	_ = os.Chmod(path, 0o600)
	fmt.Printf("Saved %s (%d bytes). The server keeps it until %s.\n", path, ex.Size, ex.Expires)
	return nil
}

// deleteAccountCommand deletes the account after its password and a typed confirmation (DESIGN.md §43.3).
func deleteAccountCommand(args []string) error {
	fs := flag.NewFlagSet("chirk delete-account", flag.ContinueOnError)
	messages := fs.String("messages", "", "keep | delete: whether your messages stay (as \"Deleted account\") or go")
	stdin := fs.Bool("password-stdin", false, "read the password from stdin")
	yes := fs.Bool("yes", false, "don't ask to type the server's name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *messages != "keep" && *messages != "delete" {
		return errors.New("say what happens to your messages: --messages keep or --messages delete")
	}
	ctx := context.Background()
	c, cfg, err := session(ctx)
	if err != nil {
		return err
	}
	host := strings.TrimPrefix(strings.TrimPrefix(c.Base, "https://"), "http://")
	if !*yes {
		fmt.Fprintf(os.Stderr, "This deletes %s's account on %s for good", c.Me().Name, host)
		if *messages == "delete" {
			fmt.Fprint(os.Stderr, ", and every message in it")
		}
		fmt.Fprintln(os.Stderr, ". Export your data first if you want it (chirk export).")
		typed, err := prompt("Type " + host + " to go on: ")
		if err != nil {
			return err
		}
		if typed != host {
			return errors.New("not deleted")
		}
	}
	password, err := readPassword(*stdin, false)
	if err != nil {
		return err
	}
	if err := c.DeleteAccount(ctx, password, *messages); err != nil {
		return err
	}
	drafts := config.LoadDrafts()
	drafts.Forget(c.Base, c.Me().ID)
	_ = drafts.Save()
	cfg.Remove()
	if err := cfg.Save(); err != nil {
		return err
	}
	fmt.Println("Your account is deleted.")
	return nil
}

func updateCommand(args []string) error {
	fs := flag.NewFlagSet("chirk update", flag.ContinueOnError)
	check := fs.Bool("check", false, "only say whether there's a newer one")
	force := fs.Bool("force", false, "replace this binary even when it's the same version (or a dev build)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	return selfUpdate(context.Background(), updateSource(), version, exe, *check, *force)
}
