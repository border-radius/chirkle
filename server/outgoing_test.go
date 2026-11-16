package main

import (
	"net/http"
	"testing"
)

func TestTuneOutgoing(t *testing.T) {
	tuneOutgoing()
	tr := http.DefaultTransport.(*http.Transport)
	if tr.IdleConnTimeout != idleConnTimeout {
		t.Fatalf("IdleConnTimeout = %v", tr.IdleConnTimeout)
	}
	if tr.HTTP2 == nil || tr.HTTP2.SendPingTimeout != sendPingTimeout || tr.HTTP2.PingTimeout != pingTimeout {
		t.Fatalf("HTTP2 = %+v", tr.HTTP2)
	}
}
