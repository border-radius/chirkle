package main

// The search limit (QA SEC-4): a search is a substring scan of the room's text_key for each word (lists.go
// searchWhere), so a caller repeating searches in a very large Open Air room cost the server a scan each, held back
// only by PocketBase's general per-IP limit. Each caller (a person by their account, a guest by their IP) now has a
// bucket of searchBurst searches that refills one every searchRefill. A search is a room page with `q` (§29), or, from
// apps older than the routes, a records API list of messages whose filter names text_key. Typing in the search box
// sends one request per pause (300 ms on the web), so a person searching never comes near it. It follows the
// settings' rate limit switch, as PocketBase's own rules do: off (tests, an admin's choice), nothing is counted.

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const (
	searchBurst  = 20              // searches a caller may make at once
	searchRefill = 2 * time.Second // and one more every this long (30 a minute)
)

type searchBucket struct {
	tokens float64
	at     time.Time
}

type searchLimiter struct {
	mu      sync.Mutex
	buckets map[string]*searchBucket
	swept   time.Time
}

func newSearchLimiter() *searchLimiter { return &searchLimiter{buckets: map[string]*searchBucket{}} }

// allow takes one search from key's bucket at `now`, or says it is empty.
func (l *searchLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	// A bucket full again is the same as none: forget those now and then, so the map holds only recent callers.
	full := time.Duration(searchBurst) * searchRefill
	if now.Sub(l.swept) > full {
		for k, b := range l.buckets {
			if now.Sub(b.at) >= full {
				delete(l.buckets, k)
			}
		}
		l.swept = now
	}
	b := l.buckets[key]
	if b == nil {
		b = &searchBucket{tokens: searchBurst, at: now}
		l.buckets[key] = b
	}
	b.tokens = min(searchBurst, b.tokens+float64(now.Sub(b.at))/float64(searchRefill))
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// isSearch: whether r is a message search, by the route or the records API.
func isSearch(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	p := r.URL.Path
	if strings.HasPrefix(p, "/api/chat/rooms/") && strings.HasSuffix(p, "/messages") {
		return len(searchWords(r.URL.Query().Get("q"))) > 0
	}
	if p == "/api/collections/messages/records" {
		return strings.Contains(r.URL.Query().Get("filter"), "text_key")
	}
	return false
}

func bindSearchLimit(app core.App) {
	l := newSearchLimiter()
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		se.Router.Bind(&hook.Handler[*core.RequestEvent]{
			Id: "chirkleSearchLimit",
			// Once the session is known (it names the bucket), before the admission's wait (admission.go).
			Priority: apis.DefaultRateLimitMiddlewarePriority + 10,
			Func: func(e *core.RequestEvent) error {
				if !isSearch(e.Request) || !e.App.Settings().RateLimits.Enabled || e.HasSuperuserAuth() {
					return e.Next()
				}
				key := "ip:" + e.RealIP()
				if e.Auth != nil {
					key = "user:" + e.Auth.Id
				}
				if !l.allow(key, time.Now()) {
					return e.TooManyRequestsError("Too many searches. Wait a moment and try again.", nil)
				}
				return e.Next()
			},
		})
		return se.Next()
	})
}
