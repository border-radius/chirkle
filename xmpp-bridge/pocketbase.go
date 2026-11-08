package main

// Talking to PocketBase (DESIGN.md §38.3): events go to POST /api/xmpp/in one at a time, in order. One that gets no
// answer, or a 5xx, is sent again after a backoff, holding back the ones after it; at most maxQueued wait, the oldest
// dropped first. PocketBase answers what it couldn't use with 200 too, so a bad event can't stop the queue. Statuses
// (the heartbeat) go straight away, next to the queue: each says all there is, so a lost one needs no retry.

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"
)

const maxQueued = 1000

// An event for PocketBase. Type says which fields mean something.
type event struct {
	Type string `json:"type"`

	// hello
	Protocol int    `json:"protocol,omitempty"`
	Version  string `json:"version,omitempty"`
	Port     int    `json:"port,omitempty"`
	Boot     string `json:"boot,omitempty"`

	// status
	Connected *bool        `json:"connected,omitempty"`
	Error     string       `json:"error,omitempty"`
	Rooms     []roomStatus `json:"rooms,omitempty"`

	// message, occupant, invite, kicked
	MUC        string `json:"muc,omitempty"`
	ID         string `json:"id,omitempty"`
	StanzaID   string `json:"stanza_id,omitempty"`
	OriginID   string `json:"origin_id,omitempty"`
	Nick       string `json:"nick,omitempty"`
	NewNick    string `json:"new_nick,omitempty"`
	OccupantID string `json:"occupant_id,omitempty"`
	JID        string `json:"jid,omitempty"`
	Body       string `json:"body,omitempty"`
	Delay      string `json:"delay,omitempty"`
	Self       bool   `json:"self,omitempty"`
	From       string `json:"from,omitempty"`
	Password   string `json:"password,omitempty"`
	Reason     string `json:"reason,omitempty"`

	// message: a reply (the stanza id it answers, its author, and the body without the quote over it), and a
	// correction (the id of the message it corrects). retraction: the message's id, and who (a moderator, or its
	// author).
	ReplyID   string `json:"reply_id,omitempty"`
	ReplyTo   string `json:"reply_to,omitempty"`
	ReplyBody string `json:"reply_body,omitempty"`
	Replace   string `json:"replace,omitempty"`
	Target    string `json:"target,omitempty"`
	Moderated bool   `json:"moderated,omitempty"`
}

type roomStatus struct {
	MUC   string `json:"muc"`
	Key   string `json:"key"`
	State string `json:"state"`
	Error string `json:"error,omitempty"`
	Nick  string `json:"nick,omitempty"`
	Title string `json:"title,omitempty"`
}

type pocketbase struct {
	url    string
	secret string
	client *http.Client

	mu     sync.Mutex
	queue  []event
	signal chan struct{}
}

// newPocketBase posts to url. With addr, it connects there whatever url's host is (PocketBase served over HTTPS for a
// domain: url names the domain, so its certificate matches, and addr is 127.0.0.1:443).
func newPocketBase(url, addr, secret string) *pocketbase {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if addr != "" {
		d := &net.Dialer{Timeout: 5 * time.Second}
		tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return d.DialContext(ctx, network, addr)
		}
		tr.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &pocketbase{
		url:    url,
		secret: secret,
		client: &http.Client{Transport: tr, Timeout: 30 * time.Second},
		signal: make(chan struct{}, 1),
	}
}

// send queues ev.
func (p *pocketbase) send(ev event) {
	p.mu.Lock()
	if len(p.queue) >= maxQueued {
		dropped := p.queue[0]
		p.queue = p.queue[1:]
		log.Printf("queue full: dropped a %s event", dropped.Type)
	}
	p.queue = append(p.queue, ev)
	p.mu.Unlock()
	select {
	case p.signal <- struct{}{}:
	default:
	}
}

// run sends the queue, in order, until ctx is done.
func (p *pocketbase) run(ctx context.Context) {
	backoff := time.Second
	for {
		p.mu.Lock()
		var next *event
		if len(p.queue) > 0 {
			next = &p.queue[0]
		}
		p.mu.Unlock()
		if next == nil {
			select {
			case <-ctx.Done():
				return
			case <-p.signal:
				continue
			}
		}
		if err := p.post(ctx, *next); err != nil {
			log.Printf("pocketbase: %v (again in %s)", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		backoff = time.Second
		p.mu.Lock()
		p.queue = p.queue[1:]
		p.mu.Unlock()
	}
}

// post sends one event. An error means it should be sent again.
func (p *pocketbase) post(ctx context.Context, ev event) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return nil // can't happen; nothing to send again
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(secretHeader, p.secret)
	res, err := p.client.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	res.Body.Close()
	switch {
	case res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden:
		// Not our PocketBase any more (it started another child, with another secret): this one is left over.
		log.Printf("pocketbase refused the secret: exiting")
		os.Exit(1)
	case res.StatusCode >= 500 || res.StatusCode == http.StatusTooManyRequests:
		return fmt.Errorf("%s: %s", ev.Type, res.Status)
	case res.StatusCode >= 300:
		log.Printf("pocketbase: %s event refused: %s", ev.Type, res.Status)
	}
	return nil
}

// postNow sends ev outside the queue, once (statuses).
func (p *pocketbase) postNow(ctx context.Context, ev event) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := p.post(ctx, ev); err != nil {
		log.Printf("pocketbase: status: %v", err)
	}
}
