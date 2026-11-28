package api

import (
	"context"
	"net/url"
	"strconv"
)

// Rooms lists every room the caller can see, by name (GET /api/chat/rooms). A guest gets the Open Air rooms.
func (c *Client) Rooms(ctx context.Context) ([]Room, error) {
	var out []Room
	q := url.Values{"expand": {"members,writers"}, "fields": {RoomFields}}
	return out, c.do(ctx, "GET", "/api/chat/rooms", q, nil, &out)
}

// PageKind is a message page (server/lists.go): latest and older come newest first, the others oldest first.
type PageKind string

const (
	Latest PageKind = "latest"
	First  PageKind = "first"
	Older  PageKind = "older"
	Newer  PageKind = "newer"
)

// Cursor is a message's place in its room: keyset by (created, id).
type Cursor struct{ Created, ID string }

// Page reads a page of a room's messages, always returned oldest first. Search with q (the server folds it).
func (c *Client) Page(ctx context.Context, room string, kind PageKind, at *Cursor, q string, limit int) ([]Message, error) {
	v := url.Values{"kind": {string(kind)}, "limit": {strconv.Itoa(limit)}, "expand": {messageExpand}, "fields": {MessageFields}}
	if at != nil {
		v.Set("created", at.Created)
		v.Set("id", at.ID)
	}
	if q != "" {
		v.Set("q", q)
	}
	var out []Message
	if err := c.do(ctx, "GET", "/api/chat/rooms/"+url.PathEscape(room)+"/messages", v, nil, &out); err != nil {
		return nil, err
	}
	if kind == Latest || kind == Older {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out, nil
}

// Changed reads the edits and deletes made since `since` to messages created between from and to: what a
// reconnect missed in the open room.
func (c *Client) Changed(ctx context.Context, room, since, from, to string) ([]Message, error) {
	var all []Message
	for page := 1; ; page++ {
		v := url.Values{"kind": {"changed"}, "since": {since}, "from": {from}, "to": {to}, "limit": {"200"},
			"page": {strconv.Itoa(page)}, "expand": {messageExpand}, "fields": {MessageFields}}
		var some []Message
		if err := c.do(ctx, "GET", "/api/chat/rooms/"+url.PathEscape(room)+"/messages", v, nil, &some); err != nil {
			return nil, err
		}
		all = append(all, some...)
		if len(some) < 200 {
			return all, nil
		}
	}
}

// Unread reads the unread counts.
func (c *Client) Unread(ctx context.Context) (Unread, error) {
	var out Unread
	return out, c.do(ctx, "GET", "/api/chat/unread", nil, nil, &out)
}

// MarkRead marks a room read up to the message created at `at` (DESIGN.md §18.2).
func (c *Client) MarkRead(ctx context.Context, room, at string) error {
	return c.do(ctx, "POST", "/api/chat/reads", nil, map[string]string{"room": room, "at": at}, nil)
}

// Send posts a message. id is the client's (NewID), so sending again after a lost answer can't make a second one.
func (c *Client) Send(ctx context.Context, id, room, text, replyTo string) (Message, error) {
	me := c.Me()
	body := map[string]any{"id": id, "room": room, "text": text}
	if me != nil {
		body["author"] = me.ID
	}
	if replyTo != "" {
		body["reply_to"] = replyTo
	}
	var out Message
	q := url.Values{"expand": {messageExpand}, "fields": {MessageFields}}
	return out, c.do(ctx, "POST", "/api/collections/messages/records", q, body, &out)
}

// LiveTopic is the topic of live messages, or "" on a server from before it (GET /api/chat/live 404).
func (c *Client) LiveTopic(ctx context.Context) (string, error) {
	var out struct {
		Topic string `json:"topic"`
	}
	if err := c.do(ctx, "GET", "/api/chat/live", nil, nil, &out); err != nil {
		if IsStatus(err, 404) {
			return "", nil
		}
		return "", err
	}
	return out.Topic, nil
}

// CreateRoom makes a room ("public", "private" or "open"; "" for the server's default).
func (c *Client) CreateRoom(ctx context.Context, name, visibility string) (Room, error) {
	body := map[string]any{"name": name}
	if me := c.Me(); me != nil {
		body["created_by"] = me.ID
	}
	if visibility != "" {
		body["visibility"] = visibility
	}
	var out Room
	q := url.Values{"expand": {"members,writers"}, "fields": {RoomFields}}
	return out, c.do(ctx, "POST", "/api/collections/rooms/records", q, body, &out)
}
