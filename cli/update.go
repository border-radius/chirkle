package main

// chirk update (docs/CLI.md §7): the latest Release's archive for this platform, checked against the Release's
// checksums, replaces the running binary.

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/border-radius/chirkle/cli/internal/api"
)

const latestRelease = "https://api.github.com/repos/border-radius/chirkle/releases/latest"

// updateSource is the latest Release's API URL (CHIRK_RELEASE_URL overrides it, for tests and mirrors).
func updateSource() string {
	if u := os.Getenv("CHIRK_RELEASE_URL"); u != "" {
		return u
	}
	return latestRelease
}

type release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", api.UserAgent())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", url, res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = fmt.Errorf("%s: over %d bytes", url, limit)
	}
	return b, err
}

func selfUpdate(ctx context.Context, source, current, exe string, check, force bool) error {
	raw, err := fetch(ctx, source, 1<<20)
	if err != nil {
		return fmt.Errorf("couldn't read the latest release: %w", err)
	}
	var rel release
	if err := json.Unmarshal(raw, &rel); err != nil {
		return err
	}
	latest := strings.TrimPrefix(rel.Tag, "v")
	if latest == "" {
		return errors.New("the latest release has no version")
	}
	switch {
	case current == latest && !force:
		fmt.Printf("chirk %s is the latest.\n", current)
		return nil
	case check:
		fmt.Printf("chirk %s is out (this is %s): chirk update\n", latest, current)
		return nil
	case current == "dev" && !force:
		return fmt.Errorf("this is a development build; chirk update --force replaces it with %s", latest)
	}
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	base := fmt.Sprintf("chirk_%s_%s_%s", latest, runtime.GOOS, runtime.GOARCH)
	var archiveURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case base + ext:
			archiveURL = a.URL
		case "chirk_" + latest + "_checksums.txt":
			sumsURL = a.URL
		}
	}
	if archiveURL == "" || sumsURL == "" {
		return fmt.Errorf("release %s has no %s (or no checksums)", latest, base+ext)
	}
	sums, err := fetch(ctx, sumsURL, 1<<16)
	if err != nil {
		return err
	}
	want := ""
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == base+ext {
			want = f[0]
		}
	}
	if want == "" {
		return fmt.Errorf("the checksums don't list %s", base+ext)
	}
	archive, err := fetch(ctx, archiveURL, 64<<20)
	if err != nil {
		return err
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return fmt.Errorf("%s doesn't match its checksum: not installed", base+ext)
	}
	bin, err := extract(archive, ext, base)
	if err != nil {
		return err
	}
	if err := replace(exe, bin); err != nil {
		return fmt.Errorf("couldn't replace %s: %w", exe, err)
	}
	fmt.Printf("Updated chirk %s → %s (%s).\n", current, latest, exe)
	return nil
}

// extract takes <base>/chirk (chirk.exe) out of the release archive.
func extract(archive []byte, ext, base string) ([]byte, error) {
	name := "chirk"
	if ext == ".zip" {
		name = "chirk.exe"
	}
	want := path.Join(base, name)
	limit := int64(128 << 20)
	if ext == ".zip" {
		z, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range z.File {
			if path.Clean(f.Name) == want {
				r, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer r.Close()
				return io.ReadAll(io.LimitReader(r, limit))
			}
		}
		return nil, fmt.Errorf("no %s in the archive", want)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("no %s in the archive", want)
		}
		if err != nil {
			return nil, err
		}
		if path.Clean(h.Name) == want && h.Typeflag == tar.TypeReg {
			return io.ReadAll(io.LimitReader(tr, limit))
		}
	}
}

// replace swaps the binary at exe for bin: written beside it, then renamed over it (on Windows the running one is
// moved aside first, as it can't be overwritten).
func replace(exe string, bin []byte) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".chirk-new-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
	}
	return os.Rename(tmp.Name(), exe)
}
