package main

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestSearchLimiter(t *testing.T) {
	l := newSearchLimiter()
	t0 := time.Unix(1_000_000, 0)
	for i := 0; i < searchBurst; i++ {
		if !l.allow("ip:a", t0) {
			t.Fatalf("search %d refused within the burst", i+1)
		}
	}
	if l.allow("ip:a", t0) {
		t.Fatal("a search past the burst was allowed")
	}
	if !l.allow("ip:b", t0) {
		t.Fatal("another caller shares the first one's bucket")
	}
	if l.allow("ip:a", t0.Add(searchRefill/2)) {
		t.Fatal("refilled before searchRefill")
	}
	if !l.allow("ip:a", t0.Add(searchRefill)) {
		t.Fatal("not refilled after searchRefill")
	}
	// Idle for long: full again, and swept from the map.
	later := t0.Add(time.Hour)
	if !l.allow("ip:c", later) {
		t.Fatal("a new caller refused")
	}
	if _, ok := l.buckets["ip:b"]; ok {
		t.Fatal("an idle caller's full bucket was kept")
	}
	for i := 0; i < searchBurst-1; i++ {
		if !l.allow("ip:a", later) {
			t.Fatalf("after an hour, search %d refused", i+1)
		}
	}
}

func TestIsSearch(t *testing.T) {
	for url, want := range map[string]bool{
		"/api/chat/rooms/r1/messages?kind=latest&q=hello":                       true,
		"/api/chat/rooms/r1/messages?kind=latest&q=%20%20":                      false, // no words: a plain page
		"/api/chat/rooms/r1/messages?kind=latest":                               false,
		"/api/collections/messages/records?filter=room%3D'r'%26%26text_key~'x'": true,
		"/api/collections/messages/records?filter=room%3D'r'":                   false,
		"/api/collections/rooms/records?filter=text_key~'x'":                    false,
	} {
		if got := isSearch(httptest.NewRequest("GET", url, nil)); got != want {
			t.Errorf("%s: %v, want %v", url, got, want)
		}
	}
	if isSearch(httptest.NewRequest("POST", "/api/chat/rooms/r1/messages?q=hello", nil)) {
		t.Error("a POST counted as a search")
	}
}
