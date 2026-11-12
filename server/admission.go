package main

// Admission (PERF.md §14): at most `slots` API requests run at once; the rest wait here, a goroutine each.
//
// A request's JS hooks take a runtime from the --hooksPool pool, and with all of them busy PocketBase builds a one-off
// runtime with every hook file loaded: megabytes and milliseconds of CPU each. When the CPU fell behind (3,000 users on
// one core), hundreds of requests were in flight, and their one-off runtimes were 1 GB of a 1.4 GB heap, while building
// them took CPU the backlog needed. Waiting here costs a few KB and nothing while it waits; one core runs no faster
// with 80 requests in flight than with 8.
//
// Not counted: the routes in Go (main.go's register unbinds this middleware from them): they run no JS in the request,
// and a read mark waiting for its group commit, or a page waiting for nothing, held a slot that a hook needed; with
// them counted, 2,000 users' sends went from 1.4 s to 17 s, the slots full of requests waiting for the one write
// connection. Nor the realtime stream (open for as long as the tab is), file and poster downloads (as long as the client
// takes to read them; no hooks run while they stream), health checks, pages outside /api/, and requests whose body is a multipart upload or longer than preread (an upload's hooks run
// once its body has arrived; a slow sender must not hold a slot). A counted request's body is read before it takes a
// slot, for the same reason.

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
)

// preread: the longest body read before a request takes a slot. JSON bodies are far shorter.
const preread = 64 << 10

// admissionID: the middleware's id, for a route to unbind it.
const admissionID = "chirkleAdmission"

type admission struct {
	slots   chan struct{}
	waiting atomic.Int64
	waits   atomic.Int64 // requests that found every slot taken
}

// admissionSlots: most of the hooks pool, leaving runtimes for crons, workers and hooks run outside a request.
func admissionSlots(hooksPool int) int { return max(2, hooksPool*4/5) }

func newAdmission(slots int) *admission {
	return &admission{slots: make(chan struct{}, slots)}
}

// counted: whether r waits for a slot.
func counted(r *http.Request) bool {
	p := r.URL.Path
	if !strings.HasPrefix(p, "/api/") || p == "/api/health" {
		return false
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return p != "/api/realtime" && !strings.HasPrefix(p, "/api/files/") && !strings.HasPrefix(p, "/api/chat/posters/")
	}
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		return false
	}
	return r.ContentLength >= 0 && r.ContentLength <= preread
}

// bind adds the middleware: after the rate limit and the session's loading, so a refused request doesn't wait.
func (a *admission) bind(app core.App) {
	if os.Getenv("CHIRKLE_ADMISSION") == "off" {
		return // a way out, should it ever hold up more than it saves
	}
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(se *core.ServeEvent) error {
			se.Router.Bind(&hook.Handler[*core.RequestEvent]{
				Id:       admissionID,
				Priority: apis.DefaultRateLimitMiddlewarePriority + 20,
				Func:     a.handle,
			})
			return se.Next()
		},
	})
}

func (a *admission) handle(e *core.RequestEvent) error {
	if !counted(e.Request) {
		return e.Next()
	}
	if e.Request.ContentLength > 0 {
		// Read whole (at most preread: net/http stops at Content-Length), through the body limit, which answers a body
		// too long with its own error. The handler gets a copy it can read more than once, as the router's body is.
		body, err := io.ReadAll(e.Request.Body)
		if err != nil {
			var apiErr *router.ApiError
			if errors.As(err, &apiErr) {
				return err
			}
			return e.BadRequestError("Failed to read the request body.", err)
		}
		e.Request.Body = &router.RereadableReadCloser{ReadCloser: io.NopCloser(bytes.NewReader(body))}
	}
	select {
	case a.slots <- struct{}{}:
	default:
		a.waits.Add(1)
		a.waiting.Add(1)
		select {
		case a.slots <- struct{}{}:
			a.waiting.Add(-1)
		case <-e.Request.Context().Done():
			a.waiting.Add(-1)
			return e.Request.Context().Err() // the client gave up; nobody reads an answer
		}
	}
	defer func() { <-a.slots }()
	return e.Next()
}

// admissionStats for /api/chat/metrics.
type admissionStats struct {
	Slots   int   `json:"slots"`
	Running int   `json:"running"`
	Waiting int64 `json:"waiting"`
	Waits   int64 `json:"waits"`
}

func (a *admission) stats() admissionStats {
	return admissionStats{Slots: cap(a.slots), Running: len(a.slots), Waiting: a.waiting.Load(), Waits: a.waits.Load()}
}
