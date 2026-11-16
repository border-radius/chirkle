package main

import (
	"net/http"
	"time"
)

// Outgoing requests (the JS hooks' $http.send and $filesystem.fileFromURL, the Telegram bridge's among them, §26.7)
// go through http.DefaultClient, which keeps idle connections for 90 s and never checks an HTTP/2 one. A connection a
// network path drops without a word (a NAT or middlebox forgetting it) is then reused, and its request waits out its
// whole timeout ("context deadline exceeded") though the server would answer a new one at once.
const (
	// idleConnTimeout: an idle connection is closed after this, so few outlive a path's own idle limit.
	idleConnTimeout = 30 * time.Second
	// sendPingTimeout: an HTTP/2 connection that has received nothing for this long is pinged…
	sendPingTimeout = 15 * time.Second
	// pingTimeout: …and closed when no answer comes in this, failing its requests at once rather than at their timeout.
	pingTimeout = 10 * time.Second
)

// tuneOutgoing sets these on http.DefaultTransport. Before any request: the transport reads its HTTP/2 settings once.
func tuneOutgoing() {
	t, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return
	}
	t.IdleConnTimeout = idleConnTimeout
	if t.HTTP2 == nil {
		t.HTTP2 = &http.HTTP2Config{}
	}
	t.HTTP2.SendPingTimeout = sendPingTimeout
	t.HTTP2.PingTimeout = pingTimeout
}
