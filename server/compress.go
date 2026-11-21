package main

// Compression (PERF.md §15). PocketBase compresses nothing. Behind nginx, Caddy or Cloudflare the proxy did it, but
// the default install (`npx chirkle chat.example.com`, the systemd service) serves HTTPS itself, and sent the app's
// 188 KB critical path where 65 KB gzipped would do, and every page of messages as raw JSON.
//
// - The built assets (pb_public/assets/*.js|css): scripts/build.mjs writes a .br and a .gz beside each. When the client
//   takes one of them it is sent instead of the file, as is: no CPU spent at runtime, brotli at its best level.
// - Everything else that is text (JSON, HTML, CSS, JS, SVG, the manifest) and at least minLength long: gzipped as it is
//   written, at a low level (cheap next to building the answer, most of the gain).
// - Not: the realtime stream, file and poster downloads (media is compressed already, and they answer ranges), range
//   requests, answers that already have an encoding, and anything else (images, fonts, archives).
//
// The routes keep their own headers (CSP, caching, ETag): this only wraps the writer they write to. A compressed
// answer keeps its ETag, so a client's If-None-Match still matches (lists.go): Vary tells caches the two apart.
// CHIRKLE_COMPRESS=off turns it off.

import (
	"bufio"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
)

const (
	// minLength: shorter answers go as they are (gzip's header and the CPU cost more than they save).
	minLength = 1024
	// gzipLevel: on a 50-message page, level 1 is already most of level 6's gain at a fraction of its CPU (compress_test.go).
	gzipLevel = 1
)

// compressible: the content types worth compressing (media and fonts are compressed already).
func compressible(contentType string) bool {
	ct, _, _ := strings.Cut(contentType, ";")
	ct = strings.TrimSpace(strings.ToLower(ct))
	switch ct {
	case "application/json", "application/javascript", "application/manifest+json", "application/xml",
		"image/svg+xml", "text/html", "text/css", "text/javascript", "text/plain", "text/xml", "text/csv":
		return true
	}
	return false
}

// accepts: whether the request's Accept-Encoding takes `coding` (and doesn't refuse it with q=0).
func accepts(r *http.Request, coding string) bool {
	named, star := -1.0, -1.0
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(part, ";")
		name = strings.TrimSpace(strings.ToLower(name))
		if name != coding && name != "*" {
			continue
		}
		q := 1.0
		for _, p := range strings.Split(params, ";") {
			if k, v, ok := strings.Cut(strings.TrimSpace(p), "="); ok && strings.TrimSpace(k) == "q" {
				if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = f
				}
			}
		}
		if name == coding {
			named = q
		} else {
			star = q
		}
	}
	if named >= 0 {
		return named > 0
	}
	return star > 0
}

// skipped: requests whose answers are never compressed.
func skipped(r *http.Request) bool {
	p := r.URL.Path
	return r.Header.Get("Range") != "" ||
		p == "/api/realtime" ||
		strings.HasPrefix(p, "/api/files/") ||
		strings.HasPrefix(p, "/api/chat/posters/")
}

var gzipWriters = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(io.Discard, gzipLevel)
	return w
}}

func bindCompress(app core.App, publicDir string) {
	if os.Getenv("CHIRKLE_COMPRESS") == "off" {
		return
	}
	assets := filepath.Join(publicDir, "assets")
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(se *core.ServeEvent) error {
			se.Router.Bind(&hook.Handler[*core.RequestEvent]{
				Id: "chirkleCompress",
				// Outermost of ours: what the others answer (admission's errors too) is compressed.
				Priority: apis.DefaultRateLimitMiddlewarePriority - 10,
				Func: func(e *core.RequestEvent) error {
					return compress(e, assets)
				},
			})
			return se.Next()
		},
	})
}

func compress(e *core.RequestEvent, assets string) error {
	r := e.Request
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost &&
		r.Method != http.MethodPatch && r.Method != http.MethodPut || skipped(r) {
		return e.Next()
	}
	e.Response.Header().Add("Vary", "Accept-Encoding")
	if p, ok := strings.CutPrefix(r.URL.Path, "/assets/"); ok && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		if file, coding := precompressed(r, assets, p); file != "" {
			pw := &precompressedWriter{ResponseWriter: e.Response, file: file, coding: coding}
			e.Response = pw
			defer func() { e.Response = pw.ResponseWriter }()
			return e.Next()
		}
	}
	if r.Method == http.MethodHead || !accepts(r, "gzip") {
		return e.Next()
	}
	gw := &gzipWriter{ResponseWriter: e.Response}
	e.Response = gw
	defer func() {
		gw.finish()
		e.Response = gw.ResponseWriter
	}()
	return e.Next()
}

// precompressed: the build's .br (preferred) or .gz of assets/p that the client takes, if there is one at least as new
// as the file itself (a dev build may have rewritten the file since).
func precompressed(r *http.Request, assets, p string) (file, coding string) {
	if strings.Contains(p, "..") || strings.HasSuffix(p, ".br") || strings.HasSuffix(p, ".gz") {
		return "", ""
	}
	src := filepath.Join(assets, filepath.FromSlash(p))
	info, err := os.Stat(src)
	if err != nil || info.IsDir() {
		return "", ""
	}
	for _, c := range [...]struct{ coding, ext string }{{"br", ".br"}, {"gzip", ".gz"}} {
		if !accepts(r, c.coding) {
			continue
		}
		if s, err := os.Stat(src + c.ext); err == nil && !s.IsDir() && !s.ModTime().Before(info.ModTime()) {
			return src + c.ext, c.coding
		}
	}
	return "", ""
}

// precompressedWriter: the route serves the asset as usual (headers, conditional requests, its 404s); a 200 sends the
// compressed file in place of what the route writes.
type precompressedWriter struct {
	http.ResponseWriter
	file, coding string
	decided      bool
	swapped      bool
}

func (w *precompressedWriter) WriteHeader(code int) {
	if w.decided {
		return
	}
	w.decided = true
	if code == http.StatusOK && w.Header().Get("Content-Encoding") == "" {
		if f, err := os.Open(w.file); err == nil {
			defer f.Close()
			if info, err := f.Stat(); err == nil {
				h := w.Header()
				h.Set("Content-Encoding", w.coding)
				h.Set("Content-Length", strconv.FormatInt(info.Size(), 10))
				w.swapped = true
				w.ResponseWriter.WriteHeader(code)
				_, _ = io.Copy(w.ResponseWriter, f) // nothing written for a HEAD: net/http drops it
				return
			}
		}
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *precompressedWriter) Write(b []byte) (int, error) {
	if !w.decided {
		w.WriteHeader(http.StatusOK)
	}
	if w.swapped {
		return len(b), nil // the original's bytes: the compressed file went instead
	}
	return w.ResponseWriter.Write(b)
}

func (w *precompressedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// gzipWriter compresses an answer as it is written, once its headers say it is worth it: a compressible type, no
// encoding yet, a status with a body, and at least minLength long (a shorter answer is held until it ends or grows).
type gzipWriter struct {
	http.ResponseWriter
	code    int
	decided bool // whether to compress is known; until then the status and up to minLength bytes are held
	gz      *gzip.Writer
	held    []byte
}

func (w *gzipWriter) WriteHeader(code int) {
	if w.decided || w.code != 0 {
		return
	}
	w.code = code
	h := w.Header()
	if code != http.StatusOK || h.Get("Content-Encoding") != "" || !compressible(h.Get("Content-Type")) {
		w.passThrough()
		return
	}
	if n, err := strconv.Atoi(h.Get("Content-Length")); err == nil {
		if n < minLength {
			w.passThrough()
		} else {
			w.start()
		}
	}
	// No length: decided by the first minLength bytes.
}

func (w *gzipWriter) passThrough() {
	w.decided = true
	if w.code != 0 {
		w.ResponseWriter.WriteHeader(w.code)
	}
}

func (w *gzipWriter) start() {
	w.decided = true
	h := w.Header()
	h.Del("Content-Length")
	h.Set("Content-Encoding", "gzip")
	w.ResponseWriter.WriteHeader(w.code)
	w.gz = gzipWriters.Get().(*gzip.Writer)
	w.gz.Reset(w.ResponseWriter)
}

func (w *gzipWriter) Write(b []byte) (int, error) {
	if w.code == 0 {
		if w.Header().Get("Content-Type") == "" {
			w.Header().Set("Content-Type", http.DetectContentType(b))
		}
		w.WriteHeader(http.StatusOK)
	}
	if !w.decided {
		w.held = append(w.held, b...)
		if len(w.held) < minLength {
			return len(b), nil
		}
		w.start()
		held := w.held
		w.held = nil
		if _, err := w.gz.Write(held); err != nil {
			return 0, err
		}
		return len(b), nil
	}
	if w.gz != nil {
		return w.gz.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

// finish: after the handler. A held answer (short, or nothing written) goes as it is; a compressed one is closed.
func (w *gzipWriter) finish() {
	if !w.decided {
		if w.code != 0 && len(w.held) > 0 && w.Header().Get("Content-Length") == "" {
			w.Header().Set("Content-Length", strconv.Itoa(len(w.held)))
		}
		w.passThrough()
		if len(w.held) > 0 {
			_, _ = w.ResponseWriter.Write(w.held)
		}
		w.held = nil
		return
	}
	if w.gz != nil {
		_ = w.gz.Close()
		w.gz.Reset(io.Discard)
		gzipWriters.Put(w.gz)
		w.gz = nil
	}
}

// Flush: whatever is held is decided now (more may come later, as in a stream).
func (w *gzipWriter) Flush() {
	if !w.decided {
		if w.code == 0 {
			w.WriteHeader(http.StatusOK)
		}
		if !w.decided {
			w.start()
			if len(w.held) > 0 {
				_, _ = w.gz.Write(w.held)
				w.held = nil
			}
		}
	}
	if w.gz != nil {
		_ = w.gz.Flush()
	}
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *gzipWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (w *gzipWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

var (
	_ router.RWUnwrapper = (*gzipWriter)(nil)
	_ router.RWUnwrapper = (*precompressedWriter)(nil)
)
