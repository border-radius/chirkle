package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
	"time"
)

// The signature as the peers make it (pb_hooks/federation/net.js sign, tests/integration/federation.test.ts fakePeer).
func TestFedSign(t *testing.T) {
	secret := "f"
	body := `{"events":[]}`
	h := sha256.Sum256([]byte(body))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("POST\n/api/fed/inbox\n1700000000\n" + hex.EncodeToString(h[:])))
	want := hex.EncodeToString(mac.Sum(nil))
	if got := fedSign(secret, "POST", "/api/fed/inbox", "1700000000", body); got != want {
		t.Fatalf("fedSign = %s, want %s", got, want)
	}
	// A GET signs the empty body's hash.
	if fedSign(secret, "GET", "/a", "1", "") == fedSign(secret, "GET", "/b", "1", "") {
		t.Fatal("the path isn't signed")
	}
}

func TestFedDateOK(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for date, ok := range map[string]bool{
		"1700000000": true, "1700000300": true, "1699999700": true, "1700000301": false, "1699999699": false,
		"1700000000.5": true, "": false, "x": false, "NaN": false, "Inf": false,
	} {
		if fedDateOK(date, now) != ok {
			t.Errorf("fedDateOK(%q) = %v", date, !ok)
		}
	}
}

func TestFedOriginOK(t *testing.T) {
	for _, c := range []struct {
		url     string
		private bool
		ok      bool
	}{
		{"https://chat.example.org", false, true},
		{"https://Chat.Example.org/", false, true},
		{"https://chat.example.org/path", false, false},
		{"http://chat.example.org", false, false},
		{"https://localhost:8090", false, false},
		{"https://127.0.0.1", false, false},
		{"http://127.0.0.1:8090", true, true},
		{"", true, false},
	} {
		if fedOriginOK(c.url, c.private) != c.ok {
			t.Errorf("fedOriginOK(%q, %v) = %v", c.url, c.private, !c.ok)
		}
	}
}
