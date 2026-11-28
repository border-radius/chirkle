package api

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckFiles(t *testing.T) {
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.txt")
	os.WriteFile(ok, []byte("x"), 0o644)
	big := filepath.Join(dir, "big.bin")
	f, _ := os.Create(big)
	f.Truncate(21 << 20)
	f.Close()
	empty := filepath.Join(dir, "empty")
	os.WriteFile(empty, nil, 0o644)
	if err := CheckFiles([]string{ok}); err != nil {
		t.Error(err)
	}
	for _, bad := range [][]string{{big}, {dir}, {empty}, {filepath.Join(dir, "missing")}, make([]string, 11)} {
		if err := CheckFiles(bad); err == nil {
			t.Errorf("CheckFiles(%v): no error", bad)
		}
	}
}

// Milestone 4: files from disk, banning, export, deleting the account.
func TestFilesBanExportDelete(t *testing.T) {
	base := server(t)
	if admin == nil {
		t.Skip("CHIRKLE_TEST_ADMIN not set: no moderator to make")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	ada, bob := signUp(t, base, "ada"), signUp(t, base, "bob")
	room, err := ada.CreateRoom(ctx, "files-"+ada.Me().ID, "public")
	if err != nil {
		t.Fatal(err)
	}

	// Two files from disk, named by their names.
	dir := t.TempDir()
	png := filepath.Join(dir, "cat picture.png")
	// A 1×1 PNG.
	os.WriteFile(png, []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82"), 0o644)
	txt := filepath.Join(dir, "notes.txt")
	os.WriteFile(txt, []byte("hello"), 0o644)
	m, err := ada.SendFiles(ctx, NewID(), room.ID, "look", "", []string{png, txt})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 2 || m.Text != "look" {
		t.Fatalf("sent: %+v", m)
	}
	names := strings.Join([]string{m.FileNames[m.Files[0]], m.FileNames[m.Files[1]]}, ",")
	if !strings.Contains(names, "cat picture.png") || !strings.Contains(names, "notes.txt") {
		t.Errorf("file names: %v", m.FileNames)
	}
	if _, err := ada.SendFiles(ctx, NewID(), room.ID, "", "", []string{txt}); err != nil {
		t.Errorf("files without text: %v", err)
	}

	// Banning: a moderator only; the banned one's session ends.
	if err := bob.Ban(ctx, ada.Me().ID, true); !IsStatus(err, 403) {
		t.Errorf("bob banned: %v", err)
	}
	if err := admin.do(ctx, "PATCH", "/api/collections/users/records/"+ada.Me().ID, nil, map[string]any{"moderator": true}, nil); err != nil {
		t.Fatal(err)
	}
	if u, err := ada.Refresh(ctx); err != nil || !u.Moderator {
		t.Fatalf("ada a moderator: %+v %v", u, err)
	}
	if err := ada.Ban(ctx, bob.Me().ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.Refresh(ctx); !IsStatus(err, 401) {
		t.Errorf("banned, bob's session: %v", err)
	}
	if err := ada.Ban(ctx, bob.Me().ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.LogIn(ctx, bob.Me().Name+"@example.com", "correct horse"); err != nil {
		t.Errorf("unbanned, bob can't log in: %v", err)
	}

	// Export: asked for, made, downloaded.
	ex, err := bob.StartExport(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for ex.State == "queued" {
		time.Sleep(500 * time.Millisecond)
		if ex, err = bob.ExportState(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if ex.State != "done" {
		t.Fatalf("export: %+v", ex)
	}
	var file bytes.Buffer
	name, err := bob.DownloadExport(ctx, &file)
	if err != nil || file.Len() == 0 || int64(file.Len()) != ex.Size || name == "" {
		t.Fatalf("download: %q %d bytes (want %d) %v", name, file.Len(), ex.Size, err)
	}

	// Deleting the account: the password first; then no session works.
	err = bob.DeleteAccount(ctx, "wrong password", "keep")
	if e, ok := err.(*Error); !ok || e.Fields["password"] == "" {
		t.Fatalf("a wrong password: %v", err)
	}
	if err := bob.DeleteAccount(ctx, "correct horse", "keep"); err != nil {
		t.Fatal(err)
	}
	if _, err := bob.Refresh(ctx); !IsStatus(err, 401) {
		t.Errorf("deleted, the session: %v", err)
	}
}
