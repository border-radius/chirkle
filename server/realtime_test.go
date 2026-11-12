package main

import (
	"sync"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// QA BUG-270: a client nobody reads never blocks a Send; once its buffer is full it is discarded, and its loop sees the
// closed channel.
func TestBufferedClientNeverBlocks(t *testing.T) {
	full := make(chan struct{}, 1)
	c := newBufferedClient(subscriptions.NewDefaultClient(), 4, func() { full <- struct{}{} })
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			c.Send(subscriptions.Message{Name: "chat/inbox", Data: []byte("{}")})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked on a client nobody reads")
	}
	select {
	case <-full:
	case <-time.After(2 * time.Second):
		t.Fatal("the full buffer wasn't reported")
	}
	if !c.IsDiscarded() {
		t.Fatal("a client past its buffer is discarded")
	}
	n := 0
	for range c.Channel() {
		n++
	}
	if n != 4 {
		t.Fatalf("the loop reads what was queued, then the closed channel: got %d events", n)
	}
	c.Send(subscriptions.Message{Name: "late"}) // no panic on a closed channel
	select {
	case <-full:
		t.Fatal("a client is reported dropped once")
	case <-time.After(50 * time.Millisecond):
	}
}

// The SSE loop reads in order what was sent; the client keeps PocketBase's id, store and subscriptions.
func TestBufferedClientKeepsTheClient(t *testing.T) {
	inner := subscriptions.NewDefaultClient()
	inner.Set("ip", "1.2.3.4")
	c := newBufferedClient(inner, 8, nil)
	c.Subscribe("chat/messages")
	if c.Id() != inner.Id() || c.Get("ip") != "1.2.3.4" || !c.HasSubscription("chat/messages") {
		t.Fatal("the wrapped client's state is the client's")
	}
	for _, name := range []string{"a", "b", "c"} {
		c.Send(subscriptions.Message{Name: name})
	}
	for _, want := range []string{"a", "b", "c"} {
		if got := (<-c.Channel()).Name; got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
}

// Sends racing a discard (a ban, a logout) neither panic nor block.
func TestBufferedClientSendRacingDiscard(t *testing.T) {
	for round := 0; round < 50; round++ {
		c := newBufferedClient(subscriptions.NewDefaultClient(), 2, nil)
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 20; j++ {
					c.Send(subscriptions.Message{Name: "x"})
				}
			}()
		}
		c.Discard()
		wg.Wait()
		if !c.IsDiscarded() {
			t.Fatal("discarded")
		}
	}
}
