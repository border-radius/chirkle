package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

func TestAccepts(t *testing.T) {
	for _, c := range []struct {
		header, coding string
		want           bool
	}{
		{"gzip, deflate, br", "gzip", true},
		{"gzip, deflate, br", "br", true},
		{"deflate", "gzip", false},
		{"", "gzip", false},
		{"gzip;q=0, br", "gzip", false},
		{"GZIP ; q=0.5", "gzip", true},
		{"*", "br", true},
		{"*;q=0", "gzip", false},
		{"gzip, *;q=0", "gzip", true},
		{"br;q=0, *", "br", false},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.Header.Set("Accept-Encoding", c.header)
		if got := accepts(r, c.coding); got != c.want {
			t.Errorf("accepts(%q, %s) = %v, want %v", c.header, c.coding, got, c.want)
		}
	}
}

// serve passes r through the middleware to handler, as the router would, and returns what the client got.
func serve(t *testing.T, assets string, r *http.Request, handler func(*core.RequestEvent) error) *httptest.ResponseRecorder {
	t.Helper()
	h := &hook.Hook[*core.RequestEvent]{}
	h.BindFunc(func(e *core.RequestEvent) error { return compress(e, assets) })
	rec := httptest.NewRecorder()
	e := &core.RequestEvent{}
	e.Request = r
	e.Response = rec
	if err := h.Trigger(e, handler); err != nil {
		t.Fatal(err)
	}
	return rec
}

func gunzip(t *testing.T, b []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func get(path, accept string) *http.Request {
	r := httptest.NewRequest("GET", path, nil)
	if accept != "" {
		r.Header.Set("Accept-Encoding", accept)
	}
	return r
}

func blob(code int, ctype, body string) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		e.Response.Header().Set("ETag", `"tag"`)
		return e.Blob(code, ctype, []byte(body))
	}
}

func TestGzipCompressesLongText(t *testing.T) {
	body := strings.Repeat(`{"id":"abc","text":"hello"},`, 100)
	rec := serve(t, "", get("/api/chat/rooms/r/messages", "gzip, br"), blob(200, "application/json", body))
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("code %d, encoding %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
	if got := gunzip(t, rec.Body.Bytes()); got != body {
		t.Fatalf("body changed: %d bytes, want %d", len(got), len(body))
	}
	if rec.Body.Len() >= len(body)/4 {
		t.Errorf("compressed to %d of %d bytes", rec.Body.Len(), len(body))
	}
	if rec.Header().Get("ETag") != `"tag"` || !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("headers: %v", rec.Header())
	}
	if rec.Header().Get("Content-Length") != "" {
		t.Errorf("Content-Length %q kept", rec.Header().Get("Content-Length"))
	}
}

func TestGzipLeavesAlone(t *testing.T) {
	long := strings.Repeat("x", 4096)
	ranged := get("/api/chat/rooms/r/messages", "gzip")
	ranged.Header.Set("Range", "bytes=0-10")
	head := get("/assets/app.js", "gzip")
	head.Method = http.MethodHead
	for name, c := range map[string]struct {
		r *http.Request
		h func(*core.RequestEvent) error
	}{
		"short":        {get("/api/health", "gzip"), blob(200, "application/json", `{"ok":true}`)},
		"not accepted": {get("/api/x", "br;q=1, gzip;q=0"), blob(200, "application/json", long)},
		"no header":    {get("/api/x", ""), blob(200, "application/json", long)},
		"an image":     {get("/api/x", "gzip"), blob(200, "image/png", long)},
		"a font":       {get("/assets/a.woff2", "gzip"), blob(200, "font/woff2", long)},
		"an error":     {get("/api/x", "gzip"), blob(404, "application/json", long)},
		"not modified": {get("/api/x", "gzip"), func(e *core.RequestEvent) error { return e.NoContent(304) }},
		"a range":      {ranged, blob(200, "application/json", long)},
		"realtime":     {get("/api/realtime", "gzip"), blob(200, "text/event-stream", long)},
		"a file":       {get("/api/files/messages/m/a.txt", "gzip"), blob(200, "text/plain", long)},
		"a head":       {head, blob(200, "text/javascript", "")},
		"encoded": {get("/api/x", "gzip"), func(e *core.RequestEvent) error {
			e.Response.Header().Set("Content-Encoding", "br")
			return e.Blob(200, "text/plain", []byte(long))
		}},
		"nothing at all": {get("/api/x", "gzip"), func(e *core.RequestEvent) error { return nil }},
	} {
		rec := serve(t, "", c.r, c.h)
		if enc := rec.Header().Get("Content-Encoding"); enc == "gzip" {
			t.Errorf("%s: compressed", name)
		}
		var want string
		if c.r.Method != http.MethodHead {
			probe := httptest.NewRecorder()
			pe := &core.RequestEvent{}
			pe.Request = c.r
			pe.Response = probe
			_ = c.h(pe)
			want = probe.Body.String()
			if rec.Code != probe.Code {
				t.Errorf("%s: code %d, want %d", name, rec.Code, probe.Code)
			}
		}
		if rec.Body.String() != want {
			t.Errorf("%s: body changed (%d bytes, want %d)", name, rec.Body.Len(), len(want))
		}
	}
}

// A body written in pieces without a length: held until minLength, then compressed whole.
func TestGzipPieces(t *testing.T) {
	var sb strings.Builder
	rec := serve(t, "", get("/", "gzip"), func(e *core.RequestEvent) error {
		e.Response.Header().Set("Content-Type", "text/html; charset=utf-8")
		for i := range 300 {
			s := fmt.Sprintf("<p>%d</p>", i)
			sb.WriteString(s)
			if _, err := e.Response.Write([]byte(s)); err != nil {
				return err
			}
		}
		return nil
	})
	if rec.Header().Get("Content-Encoding") != "gzip" || gunzip(t, rec.Body.Bytes()) != sb.String() {
		t.Fatalf("encoding %q", rec.Header().Get("Content-Encoding"))
	}
}

func TestPrecompressedAssets(t *testing.T) {
	dir := t.TempDir()
	js := strings.Repeat("console.log(1);", 200)
	write := func(name, s string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("app-AAAAAAAA.js", js)
	write("app-AAAAAAAA.js.br", "BROTLI")
	write("app-AAAAAAAA.js.gz", "GZIP")
	write("old.js", js)
	write("old.js.gz", "STALE")
	past := time.Now().Add(-time.Hour)
	_ = os.Chtimes(filepath.Join(dir, "old.js.gz"), past, past)

	static := func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "immutable")
		http.ServeFile(e.Response, e.Request, filepath.Join(dir, strings.TrimPrefix(e.Request.URL.Path, "/assets/")))
		return nil
	}
	for _, c := range []struct {
		path, accept, encoding, body string
	}{
		{"/assets/app-AAAAAAAA.js", "gzip, deflate, br", "br", "BROTLI"},
		{"/assets/app-AAAAAAAA.js", "gzip", "gzip", "GZIP"},
		{"/assets/old.js", "gzip", "gzip", js}, // the .gz is older than the file: compressed on the fly
		{"/assets/app-AAAAAAAA.js", "", "", js},
	} {
		rec := serve(t, dir, get(c.path, c.accept), static)
		body := rec.Body.String()
		if c.encoding == "gzip" && c.body == js {
			body = gunzip(t, rec.Body.Bytes())
		}
		if rec.Code != 200 || rec.Header().Get("Content-Encoding") != c.encoding || body != c.body {
			t.Errorf("%s (%q): code %d, encoding %q, body %.20q", c.path, c.accept, rec.Code, rec.Header().Get("Content-Encoding"), body)
		}
		if rec.Header().Get("Cache-Control") != "immutable" || rec.Header().Get("Content-Type") != "text/javascript; charset=utf-8" {
			t.Errorf("%s: route's headers lost: %v", c.path, rec.Header())
		}
		if c.body != js && rec.Header().Get("Content-Length") != fmt.Sprint(len(c.body)) {
			t.Errorf("%s: Content-Length %q", c.path, rec.Header().Get("Content-Length"))
		}
	}

	// Conditional requests and 404s are the route's.
	r := get("/assets/app-AAAAAAAA.js", "br")
	r.Header.Set("If-Modified-Since", time.Now().Add(time.Hour).UTC().Format(http.TimeFormat))
	if rec := serve(t, dir, r, static); rec.Code != 304 || rec.Body.Len() != 0 {
		t.Errorf("If-Modified-Since: %d, %d bytes", rec.Code, rec.Body.Len())
	}
	if rec := serve(t, dir, get("/assets/missing.js", "br"), static); rec.Code != 404 || rec.Header().Get("Content-Encoding") != "" {
		t.Errorf("missing: %d %q", rec.Code, rec.Header().Get("Content-Encoding"))
	}
}

// What gzipLevel costs and saves on a page of 50 messages as the web asks for it (go test -run XXX -bench Gzip).
func BenchmarkGzipPage(b *testing.B) {
	msgs := make([]map[string]any, 50)
	for i := range msgs {
		msgs[i] = map[string]any{
			"id": fmt.Sprintf("m%014d", i), "room": "r00000000000001", "author": fmt.Sprintf("u%014d", i%20),
			"text":    fmt.Sprintf("Message number %d, saying something about the thing we talked about earlier today.", i),
			"created": "2026-11-21 10:00:00.000Z", "updated": "2026-11-21 10:00:00.000Z", "files": []string{},
			"reactions": map[string][]string{"👍": {"u00000000000001"}},
			"expand":    map[string]any{"author": map[string]any{"id": fmt.Sprintf("u%014d", i%20), "name": fmt.Sprintf("Person %d", i%20), "avatar": ""}},
		}
	}
	page, _ := json.Marshal(map[string]any{"items": msgs, "page": 1, "perPage": 50})
	for _, level := range []int{1, 4, 6} {
		b.Run(fmt.Sprintf("level%d", level), func(b *testing.B) {
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, level)
			for b.Loop() {
				buf.Reset()
				zw.Reset(&buf)
				_, _ = zw.Write(page)
				_ = zw.Close()
			}
			b.ReportMetric(float64(len(page))/float64(buf.Len()), "ratio")
			b.ReportMetric(float64(len(page)), "bytes")
		})
	}
}
