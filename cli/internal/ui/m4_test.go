package ui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
)

func TestNotifySeq(t *testing.T) {
	t.Setenv("TMUX", "")
	if got := notifySeq("osc9", "Ada", "hi\x1b]0;x\a there"); got != "\x1b]9;Ada: hi]0,x there\a" {
		t.Errorf("osc9: %q", got)
	}
	if got := notifySeq("osc777", "Ada; in #a", "b"); got != "\x1b]777;notify;Ada, in #a;b\a" {
		t.Errorf("osc777: %q", got)
	}
	if notifySeq("bell", "a", "b") != "\a" || notifySeq("off", "a", "b") != "" {
		t.Error("bell / off")
	}
	t.Setenv("TMUX", "/tmp/tmux-1/default,1,0")
	if got := notifySeq("osc9", "A", "b"); got != "\x1bPtmux;\x1b\x1b]9;A: b\a\x1b\\" {
		t.Errorf("in tmux: %q", got)
	}
}

func TestPaths(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "holiday photo.jpg"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(dir, "holiday video.mp4"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(dir, "docs"), 0o755)
	if got := completePath(filepath.Join(dir, "hol")); got != filepath.Join(dir, "holiday ") {
		t.Errorf("common part: %q", got)
	}
	if got := completePath(filepath.Join(dir, "holiday p")); got != filepath.Join(dir, "holiday photo.jpg") {
		t.Errorf("one: %q", got)
	}
	if got := completePath(filepath.Join(dir, "do")); got != filepath.Join(dir, "docs")+"/" {
		t.Errorf("a directory: %q", got)
	}
	photo := filepath.Join(dir, "holiday photo.jpg")
	for _, in := range []string{photo, "'" + photo + "'", strings.ReplaceAll(photo, " ", `\ `), "file://" + photo + "\n"} {
		if got := pastedFile(in); got != photo {
			t.Errorf("pastedFile(%q) = %q", in, got)
		}
	}
	for _, in := range []string{"just words", dir, photo + "\nmore", "holiday photo.jpg"} {
		if got := pastedFile(in); got != "" {
			t.Errorf("pastedFile(%q) = %q, want none", in, got)
		}
	}
}

// Milestone 4 (docs/CLI.md §8): a file from disk, a notification of a DM, a moderator's ban, switching accounts.
func TestFilesNotifyBanAccounts(t *testing.T) {
	base := os.Getenv("CHIRKLE_TEST_SERVER")
	admin := os.Getenv("CHIRKLE_TEST_ADMIN")
	if base == "" || admin == "" {
		t.Skip("CHIRKLE_TEST_SERVER and CHIRKLE_TEST_ADMIN not set")
	}
	t.Setenv("CHIRKLE_CONFIG", filepath.Join(t.TempDir(), "accounts.json"))
	t.Setenv("CHIRKLE_NOTIFY", "osc9")
	t.Setenv("TMUX", "")
	ctx := context.Background()
	tag := fmt.Sprint(time.Now().UnixNano() % 1e9)
	signUp := func(name string) *api.Client {
		c, _ := api.New(base)
		if _, err := c.SignUp(ctx, api.SignUpInput{Name: name + tag, Email: strings.ToLower(name) + tag + "@example.com", Password: "correct horse"}); err != nil {
			t.Fatal(err)
		}
		return c
	}
	ada, bob, cat := signUp("Ada"), signUp("Bob"), signUp("Cat")
	// Bob is a moderator.
	makeModerator(t, base, admin, bob.Me().ID)
	if _, err := bob.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	room, err := ada.CreateRoom(ctx, "m4-"+tag, "public")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ada.Send(ctx, api.NewID(), room.ID, "ada was here", ""); err != nil {
		t.Fatal(err)
	}

	// Bob and Cat are both saved; Bob is the current one.
	cfg, _ := config.Load()
	cfg.Put(config.Account{Server: cat.Base, Token: cat.Token(), User: *cat.Me()})
	cfg.Put(config.Account{Server: bob.Base, Token: bob.Token(), User: *bob.Me()})
	cfg.Save()
	site, _ := bob.Site(ctx)
	d := newDriver(t, New(bob, cfg, site))
	d.listed(room.ID)
	d.key('k', tea.ModCtrl)
	d.keys("m4-" + tag)
	d.key(tea.KeyEnter, 0)
	d.until("ada was here")

	// A file: its path completed with Tab, added with Enter, sent with the text.
	dir := t.TempDir()
	file := filepath.Join(dir, "report-"+tag+".txt")
	os.WriteFile(file, []byte("the numbers"), 0o644)
	d.key('o', tea.ModCtrl)
	d.until("Send files")
	d.send(tea.PasteMsg{Content: filepath.Join(dir, "rep")})
	d.key(tea.KeyTab, 0)
	if v := d.app.list.in.Value(); v != file {
		t.Fatalf("completed to %q", v)
	}
	d.key(tea.KeyEnter, 0)
	d.until("📎 " + file)
	d.key(tea.KeyEscape, 0)
	d.until("📎 report-" + tag + ".txt · ctrl+o files")
	d.keys("see attached")
	d.key(tea.KeyEnter, 0)
	d.while("sending…")
	d.until("[file] report-" + tag + ".txt")
	p, _ := ada.Page(ctx, room.ID, api.Latest, nil, "", 1)
	if len(p) != 1 || p[0].Text != "see attached" || len(p[0].Files) != 1 {
		t.Fatalf("on the server: %+v", p)
	}
	// A file dropped on the terminal (its path pasted) is attached too.
	d.send(tea.PasteMsg{Content: "'" + file + "'"})
	d.until("Attached report-" + tag + ".txt")
	d.key('o', tea.ModCtrl)
	d.key(tea.KeyEnter, 0) // on the one listed: taken off
	d.key(tea.KeyEscape, 0)
	if len(d.app.attach) != 0 {
		t.Fatalf("still attached: %v", d.app.attach)
	}

	// A DM while the terminal isn't looked at: a notification.
	d.send(tea.BlurMsg{})
	dm, err := ada.OpenDM(ctx, bob.Me().ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ada.Send(ctx, api.NewID(), dm.ID, "psst bob", ""); err != nil {
		t.Fatal(err)
	}
	d.poll("a notification", func() bool { return len(d.raw) > 0 })
	if want := "\x1b]9;Ada" + tag + ": psst bob\a"; d.raw[0] != want {
		t.Errorf("notification %q, want %q", d.raw[0], want)
	}
	// A message in a room, not for Bob: none.
	if _, err := ada.Send(ctx, api.NewID(), room.ID, "just chatting", ""); err != nil {
		t.Fatal(err)
	}
	d.until("just chatting")
	if len(d.raw) != 1 {
		t.Errorf("notified of a plain message: %q", d.raw)
	}
	d.send(tea.FocusMsg{})

	// A moderator bans Ada from her message.
	d.key(tea.KeyEscape, 0)
	d.keys("k") // select the last message (Ada's)
	d.keys("b")
	d.until("Ban Ada" + tag + "? They can't sign in until unbanned. y/n")
	d.keys("y")
	d.until("Ada" + tag + " is banned")
	if _, err := ada.Refresh(ctx); !api.IsStatus(err, 401) {
		t.Errorf("banned, ada's session: %v", err)
	}

	// Switching to Cat: her name in the corner, her rooms.
	d.keys("U")
	d.until("Cat" + tag)
	// The saved accounts come first, in the order saved: Cat, then Bob (this one).
	if !strings.Contains(d.app.list.items[0].label, "Cat"+tag) || !strings.Contains(d.app.list.items[1].label, "(this one)") {
		t.Fatalf("the accounts listed: %q, %q", d.app.list.items[0].label, d.app.list.items[1].label)
	}
	d.key(tea.KeyEnter, 0)
	d.until("Now Cat" + tag)
	if d.app.me() != cat.Me().ID || d.app.open != "" && d.app.room(d.app.open) == nil {
		t.Fatalf("after switching: me %s", d.app.me())
	}
	d.listed(room.ID) // the rooms, as Cat
	saved, _ := config.Load()
	if a := saved.CurrentAccount(); a == nil || a.User.ID != cat.Me().ID {
		t.Fatalf("the current account saved: %+v", a)
	}
}

// makeModerator makes a user a moderator, as a superuser (PocketBase's API).
func makeModerator(t *testing.T, base, admin, user string) {
	t.Helper()
	email, pw, _ := strings.Cut(admin, ":")
	body, _ := json.Marshal(map[string]string{"identity": email, "password": pw})
	res, err := http.Post(base+"/api/collections/_superusers/auth-with-password", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	var auth struct{ Token string }
	json.NewDecoder(res.Body).Decode(&auth)
	res.Body.Close()
	req, _ := http.NewRequest("PATCH", base+"/api/collections/users/records/"+user, strings.NewReader(`{"moderator":true}`))
	req.Header.Set("Authorization", auth.Token)
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("making a moderator: %v %v", res.Status, err)
	}
	res.Body.Close()
}
