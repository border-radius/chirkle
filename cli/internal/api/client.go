// Package api talks to a Chirkle server: PocketBase's records API, the /api/chat/* routes and the realtime stream
// (docs/API.md). It has no PocketBase dependency, so the console client stays a small static binary (docs/CLI.md §1).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Version is set by main from the build's ldflags; it goes into the User-Agent (API.md: /stats counts clients by it).
var Version = "dev"

// UserAgent names this client to the server.
func UserAgent() string {
	return fmt.Sprintf("chirkle-cli/%s (%s/%s)", Version, runtime.GOOS, runtime.GOARCH)
}

// Client is one server and, once logged in, one account's session. Safe for concurrent use.
type Client struct {
	Base string // https://chat.example.com, no trailing slash
	HTTP *http.Client

	mu    sync.RWMutex
	token string
	me    *User
}

// New returns a client for a server address as people type it: "chat.example.com" means https, a bare
// "localhost:8090" or "127.0.0.1:…" means http.
func New(address string) (*Client, error) {
	base, err := NormalizeBase(address)
	if err != nil {
		return nil, err
	}
	return &Client{Base: base, HTTP: &http.Client{Timeout: 30 * time.Second}}, nil
}

// NormalizeBase turns what someone typed into the server's base URL.
func NormalizeBase(address string) (string, error) {
	a := strings.TrimSpace(address)
	if a == "" {
		return "", errors.New("no server address")
	}
	if !strings.Contains(a, "://") {
		host := a
		if i := strings.IndexAny(host, "/"); i >= 0 {
			host = host[:i]
		}
		if strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.") || strings.HasPrefix(host, "[::1]") {
			a = "http://" + a
		} else {
			a = "https://" + a
		}
	}
	u, err := url.Parse(a)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("not a server address: %q", address)
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/"), nil
}

// SetSession sets the token (and who it is) after a login or from the saved accounts.
func (c *Client) SetSession(token string, me *User) {
	c.mu.Lock()
	c.token, c.me = token, me
	c.mu.Unlock()
}

// Token is the session's token, "" for a guest.
func (c *Client) Token() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}

// Me is the logged-in user, nil for a guest.
func (c *Client) Me() *User {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.me
}

// Error is a server's refusal: PocketBase's { status, message, data: { field: { code, message } } }.
type Error struct {
	Status  int
	Message string
	Fields  map[string]string // field → message
	Codes   map[string]string // field → code
}

func (e *Error) Error() string {
	if len(e.Fields) == 0 {
		return e.Message
	}
	keys := make([]string, 0, len(e.Fields))
	for k := range e.Fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+": "+e.Fields[k])
	}
	return strings.Join(parts, "; ")
}

// IsStatus says whether err is a server answer with this status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

func decodeError(status int, body []byte) error {
	var raw struct {
		Message string `json:"message"`
		Data    map[string]struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"data"`
	}
	e := &Error{Status: status, Fields: map[string]string{}, Codes: map[string]string{}}
	if json.Unmarshal(body, &raw) == nil && raw.Message != "" {
		e.Message = raw.Message
		for k, v := range raw.Data {
			if v.Message != "" {
				e.Fields[k] = v.Message
			}
			if v.Code != "" {
				e.Codes[k] = v.Code
			}
		}
	} else {
		e.Message = http.StatusText(status)
	}
	if status == http.StatusTooManyRequests && e.Message == "" {
		e.Message = "Too many requests, wait a moment"
	}
	return e
}

// do sends a request with the session's token and decodes a JSON answer into out (nil: none expected).
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, out any) error {
	u := c.Base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent())
	if t := c.Token(); t != "" {
		req.Header.Set("Authorization", t)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return decodeError(res.StatusCode, data)
	}
	if out == nil || len(data) == 0 || res.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.Unmarshal(data, out)
}

// FileURL is a message's file by URL alone (API.md, DESIGN.md §37.3): a plain link that works without a session.
func (c *Client) FileURL(messageID, file string) string {
	return c.Base + "/api/files/messages/" + url.PathEscape(messageID) + "/" + url.PathEscape(file)
}
