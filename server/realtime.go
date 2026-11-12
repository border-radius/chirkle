package main

// Realtime connections that can't hold the server up (QA BUG-270, docs/QA.md "Security audit — internal, 2026-11-12").
// PocketBase's client has an unbuffered channel, read by the connection's SSE loop, and the connection has no write
// deadline: a client that stops reading (a stalled phone, or on purpose) blocks its loop in the write, and from then
// on every Send to it blocks too. PocketBase's own record events send in goroutines (which then leak), but the JS
// hooks send inline (lib/inbox.js tell, lib/collections.js tellBadges, lib/access.js dropLostAccess,
// lib/keepalive.js): a message mentioning that person, any collection's badge change, a keepalive pass would wait for
// ever, each holding its request and a JS runtime of the pool.
//
// So every client gets a buffered channel (bufferedClient): Send never waits, and a client too far behind is
// discarded (its app reconnects and loads what it missed, as after any drop; live.go's queues did this for live
// messages already). And each SSE write has a deadline (realtimeWriteTimeout): a connection that takes no data for
// that long fails the write, which ends its loop and unregisters it.

import (
	"net/http"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// realtimeBuffer: events waiting for one connection, at most (as liveQueue). Past that, the client is discarded.
const realtimeBuffer = 512

// realtimeWriteTimeout: the longest one SSE write may take. A phone on a slow network takes a 4 KB event in well
// under a second; one that takes nothing for this long isn't reading.
const realtimeWriteTimeout = 30 * time.Second

// bufferedClient is PocketBase's client (its id, store and subscriptions) with a buffered channel of its own that
// Send never blocks on.
type bufferedClient struct {
	*subscriptions.DefaultClient
	mu        sync.RWMutex
	ch        chan subscriptions.Message
	discarded bool
	// full: called (in a goroutine) when a Send found the buffer full, before the client is discarded.
	full func()
}

func newBufferedClient(c *subscriptions.DefaultClient, size int, full func()) *bufferedClient {
	return &bufferedClient{DefaultClient: c, ch: make(chan subscriptions.Message, size), full: full}
}

// Channel is what the connection's SSE loop reads.
func (c *bufferedClient) Channel() chan subscriptions.Message { return c.ch }

// Send queues m, or, with the buffer full, discards the client: it never waits for the connection.
func (c *bufferedClient) Send(m subscriptions.Message) {
	c.mu.RLock()
	if c.discarded {
		c.mu.RUnlock()
		return
	}
	select {
	case c.ch <- m:
		c.mu.RUnlock()
	default:
		c.mu.RUnlock()
		if c.discard() && c.full != nil {
			go c.full() // once, by the Send that discarded it
		}
	}
}

// Discard closes the channel (the SSE loop then ends the connection); Sends after it do nothing.
func (c *bufferedClient) Discard() { c.discard() }

// discard is Discard, telling whether this call did it.
func (c *bufferedClient) discard() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.discarded {
		return false
	}
	c.discarded = true
	close(c.ch)
	return true
}

func (c *bufferedClient) IsDiscarded() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.discarded
}

// bindRealtime makes every new realtime connection's client a bufferedClient, and gives each SSE write a deadline.
// dropped is called for each client discarded for falling behind.
func bindRealtime(app core.App, dropped func()) {
	app.OnRealtimeConnectRequest().BindFunc(func(e *core.RealtimeConnectRequestEvent) error {
		if c, ok := e.Client.(*subscriptions.DefaultClient); ok {
			id := c.Id()
			e.Client = newBufferedClient(c, realtimeBuffer, func() {
				dropped()
				app.Logger().Warn("realtime: a client is too far behind, disconnected", "client", id)
			})
		}
		return e.Next()
	})
	app.OnRealtimeMessageSend().BindFunc(func(e *core.RealtimeMessageEvent) error {
		// Not supported (a test recorder): PocketBase's own server timeouts apply, as before.
		_ = http.NewResponseController(e.Response).SetWriteDeadline(time.Now().Add(realtimeWriteTimeout))
		return e.Next()
	})
}
