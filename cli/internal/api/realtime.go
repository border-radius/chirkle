package api

import (
	"bufio"
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Event is one realtime message: its topic (without options) and JSON data.
type Event struct {
	Topic string
	Data  json.RawMessage
}

// RecordEvent is the data of a records topic and of chat/messages: { action, record }.
type RecordEvent[T any] struct {
	Action string `json:"action"` // create | update | delete
	Record T      `json:"record"`
}

// Status is a change of the connection: Connected after each (re)connect, with Reconnect true when events may
// have been missed while it was down (the caller fills the gap), or Down with the error.
type Status struct {
	Connected bool
	Reconnect bool
	Err       error
}

// Subscription is a topic and the query PocketBase applies to its records (expand, fields).
type Subscription struct {
	Topic string
	Query url.Values
}

func (s Subscription) key() string {
	if len(s.Query) == 0 {
		return s.Topic
	}
	q := map[string]string{}
	for k := range s.Query {
		q[k] = s.Query.Get(k)
	}
	opts, _ := json.Marshal(map[string]any{"query": q})
	return s.Topic + "?options=" + url.QueryEscape(string(opts))
}

// Realtime keeps /api/realtime connected, subscribes on every connect and sends what comes in to Events, until
// ctx ends. Reconnects with jittered backoff.
func (c *Client) Realtime(ctx context.Context, subs []Subscription, events chan<- Event, status chan<- Status) {
	backoff := time.Second
	first := true
	for ctx.Err() == nil {
		err := c.stream(ctx, subs, events, func() {
			status <- Status{Connected: true, Reconnect: !first}
			first = false
			backoff = time.Second
		})
		if ctx.Err() != nil {
			return
		}
		status <- Status{Err: err}
		wait := backoff + time.Duration(rand.Int64N(int64(backoff/2)+1))
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

func (c *Client) stream(ctx context.Context, subs []Subscription, events chan<- Event, connected func()) error {
	req, err := http.NewRequestWithContext(ctx, "GET", c.Base+"/api/realtime", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("User-Agent", UserAgent())
	// No timeout: the stream stays open; keepalives come every 3 minutes (chat/keepalive), so a 5-minute silence
	// means the connection is dead.
	res, err := (&http.Client{Transport: c.HTTP.Transport}).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return &Error{Status: res.StatusCode, Message: "realtime: " + res.Status}
	}

	keys := map[string]string{} // subscription key → topic
	names := make([]string, 0, len(subs))
	for _, s := range subs {
		keys[s.key()] = s.Topic
		names = append(names, s.key())
	}

	lines := make(chan string)
	readErr := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(res.Body)
		sc.Buffer(make([]byte, 64<<10), 8<<20)
		for sc.Scan() {
			select {
			case lines <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
		readErr <- sc.Err()
	}()

	var name string
	var data strings.Builder
	idle := time.NewTimer(5 * time.Minute)
	defer idle.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			if err == nil {
				err = &Error{Message: "realtime: the server closed the connection"}
			}
			return err
		case <-idle.C:
			return &Error{Message: "realtime: no keepalive"}
		case line := <-lines:
			idle.Reset(5 * time.Minute)
			switch {
			case line == "":
				if name == "" {
					data.Reset()
					continue
				}
				payload := json.RawMessage(data.String())
				ev := name
				name = ""
				data.Reset()
				if ev == "PB_CONNECT" {
					var hello struct {
						ClientID string `json:"clientId"`
					}
					if err := json.Unmarshal(payload, &hello); err != nil {
						return err
					}
					body := map[string]any{"clientId": hello.ClientID, "subscriptions": names}
					if err := c.do(ctx, "POST", "/api/realtime", nil, body, nil); err != nil {
						return err
					}
					connected()
					continue
				}
				topic, ok := keys[ev]
				if !ok {
					topic, _, _ = strings.Cut(ev, "?")
				}
				if topic == "chat/keepalive" {
					continue
				}
				select {
				case events <- Event{Topic: topic, Data: payload}:
				case <-ctx.Done():
					return ctx.Err()
				}
			case strings.HasPrefix(line, "event:"):
				name = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
	}
}
