package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
)

func TestCounted(t *testing.T) {
	req := func(method, path, ctype, body string) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if ctype != "" {
			r.Header.Set("Content-Type", ctype)
		}
		return r
	}
	big := strings.Repeat("x", preread+1)
	for _, c := range []struct {
		r    *http.Request
		want bool
	}{
		{req("GET", "/api/collections/messages/records", "", ""), true},
		{req("GET", "/api/chat/rooms/r1/messages", "", ""), true},
		{req("POST", "/api/chat/reads", "application/json", `{"room":"r"}`), true},
		{req("GET", "/api/realtime", "", ""), false},
		{req("POST", "/api/realtime", "application/json", `{}`), true}, // subscribing: hooks run
		{req("GET", "/api/files/messages/m1/a.png", "", ""), false},
		{req("GET", "/api/chat/posters/messages/m1/a.mp4", "", ""), false},
		{req("GET", "/api/health", "", ""), false},
		{req("GET", "/", "", ""), false},
		{req("POST", "/api/collections/messages/records", "multipart/form-data; boundary=x", "--x--"), false},
		{req("POST", "/api/chat/reactions", "application/json", big), false},
	} {
		if got := counted(c.r); got != c.want {
			t.Errorf("%s %s: counted = %v, want %v", c.r.Method, c.r.URL.Path, got, c.want)
		}
	}
}

// run passes r through the middleware to next, as the router would.
func run(a *admission, r *http.Request, next func(*core.RequestEvent) error) error {
	h := &hook.Hook[*core.RequestEvent]{}
	h.BindFunc(a.handle)
	e := &core.RequestEvent{}
	e.Request = r
	e.Response = httptest.NewRecorder()
	return h.Trigger(e, next)
}

func TestAdmissionLimitsRequestsInFlight(t *testing.T) {
	a := newAdmission(3)
	var running, most atomic.Int64
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			err := run(a, httptest.NewRequest("GET", "/api/chat/unread", nil), func(*core.RequestEvent) error {
				n := running.Add(1)
				for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
				}
				time.Sleep(5 * time.Millisecond)
				running.Add(-1)
				return nil
			})
			if err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if most.Load() != 3 {
		t.Errorf("at most %d ran at once, want 3", most.Load())
	}
	if s := a.stats(); s.Running != 0 || s.Waiting != 0 || s.Waits == 0 {
		t.Errorf("stats after: %+v", s)
	}
}

func TestAdmissionKeepsTheBodyAndLetsGoneClientsLeave(t *testing.T) {
	a := newAdmission(1)
	// The body read before the slot is the handler's to read whole.
	err := run(a, httptest.NewRequest("POST", "/api/chat/reads", strings.NewReader(`{"room":"r1"}`)), func(e *core.RequestEvent) error {
		b, _ := io.ReadAll(e.Request.Body)
		if string(b) != `{"room":"r1"}` {
			t.Errorf("body %q", b)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// As the server hands it: the router's body to read again, behind the body limit (which can't be read again), read
	// twice here (hooks, then the form). A plain copy here failed every JSON login in the integration tests.
	r := httptest.NewRequest("POST", "/api/chat/reads", strings.NewReader(`{"room":"r2"}`))
	r.Body = http.MaxBytesReader(nil, &router.RereadableReadCloser{ReadCloser: r.Body}, 1<<20)
	err = run(a, r, func(e *core.RequestEvent) error {
		for range 2 {
			if b, _ := io.ReadAll(e.Request.Body); string(b) != `{"room":"r2"}` {
				t.Errorf("body %q", b)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// The one slot taken: a request whose client gives up stops waiting, and its handler never runs.
	hold, release := make(chan struct{}), make(chan struct{})
	go run(a, httptest.NewRequest("GET", "/api/chat/unread", nil), func(*core.RequestEvent) error {
		close(hold)
		<-release
		return nil
	})
	<-hold
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() {
		done <- run(a, httptest.NewRequest("GET", "/api/chat/unread", nil).WithContext(ctx), func(*core.RequestEvent) error {
			t.Error("ran without a slot")
			return nil
		})
	}()
	for a.stats().Waiting == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err := <-done; err != context.Canceled {
		t.Errorf("err = %v, want context.Canceled", err)
	}
	close(release)
	if s := a.stats(); s.Waiting != 0 {
		t.Errorf("stats after: %+v", s)
	}
}
