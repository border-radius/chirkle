package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeRelease serves a release of version v whose archive holds bin; a wrong sum when bad.
func fakeRelease(t *testing.T, v string, bin []byte, bad bool) *httptest.Server {
	base := fmt.Sprintf("chirk_%s_%s_%s", v, runtime.GOOS, runtime.GOARCH)
	var archive bytes.Buffer
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
		z := zip.NewWriter(&archive)
		w, _ := z.Create(base + "/chirk.exe")
		w.Write(bin)
		z.Close()
	} else {
		gz := gzip.NewWriter(&archive)
		tw := tar.NewWriter(gz)
		tw.WriteHeader(&tar.Header{Name: base + "/LICENSE", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
		tw.Write([]byte("ok"))
		tw.WriteHeader(&tar.Header{Name: base + "/chirk", Mode: 0o755, Size: int64(len(bin)), Typeflag: tar.TypeReg})
		tw.Write(bin)
		tw.Close()
		gz.Close()
	}
	sum := sha256.Sum256(archive.Bytes())
	if bad {
		sum[0] ^= 1
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/latest":
			fmt.Fprintf(w, `{"tag_name":"v%s","assets":[{"name":%q,"browser_download_url":"%s/a"},{"name":"chirk_%s_checksums.txt","browser_download_url":"%s/sums"},{"name":"chirkle.apk","browser_download_url":"%s/x"}]}`,
				v, base+ext, srv.URL, v, srv.URL, srv.URL)
		case "/a":
			w.Write(archive.Bytes())
		case "/sums":
			fmt.Fprintf(w, "%s  chirk_%s_other_os.tar.gz\n%s  %s\n", strings.Repeat("0", 64), v, hex.EncodeToString(sum[:]), base+ext)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSelfUpdate(t *testing.T) {
	ctx := context.Background()
	exe := filepath.Join(t.TempDir(), "chirk")
	os.WriteFile(exe, []byte("old"), 0o755)

	srv := fakeRelease(t, "1.2.0", []byte("new binary"), false)
	if err := selfUpdate(ctx, srv.URL+"/latest", "1.1.0", exe, true, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("--check replaced it")
	}
	if err := selfUpdate(ctx, srv.URL+"/latest", "dev", exe, false, false); err == nil {
		t.Error("a dev build was replaced without --force")
	}
	if err := selfUpdate(ctx, srv.URL+"/latest", "1.1.0", exe, false, false); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new binary" {
		t.Fatalf("after the update: %q", b)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o100 == 0 {
		t.Error("not executable")
	}
	if err := selfUpdate(ctx, srv.URL+"/latest", "1.2.0", exe, false, false); err != nil {
		t.Fatal(err) // the latest already: nothing to do
	}

	os.WriteFile(exe, []byte("old"), 0o755)
	bad := fakeRelease(t, "1.3.0", []byte("evil"), true)
	if err := selfUpdate(ctx, bad.URL+"/latest", "1.2.0", exe, false, false); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("a wrong checksum: %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatal("installed despite a wrong checksum")
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".chirk-new-*")); len(left) != 0 {
		t.Errorf("left behind: %v", left)
	}
}
