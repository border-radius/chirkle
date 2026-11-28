package api

import (
	"context"
	"errors"
	"net/url"
	"strings"
)

// Invite is where a room invite link goes (GET /api/chat/invites/{token}).
type Invite struct {
	Room struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Members int    `json:"members"`
	} `json:"room"`
	By      string `json:"by"`
	Expires string `json:"expires"`
	Member  bool   `json:"member"`
}

// LinkToken takes the token out of a server link (".../invite/<t>", ".../reset-password/<t>") or a bare token,
// and the server the link names ("" for a bare token).
func LinkToken(link, segment string) (server, token string, err error) {
	link = strings.TrimSpace(link)
	i := strings.Index(link, "/"+segment+"/")
	if i < 0 {
		if link == "" || strings.ContainsAny(link, "/ ") {
			return "", "", errors.New("that isn't a /" + segment + "/ link")
		}
		return "", link, nil
	}
	server, token = link[:i], link[i+len(segment)+2:]
	if j := strings.IndexAny(token, "?#/"); j >= 0 {
		token = token[:j]
	}
	if token == "" {
		return "", "", errors.New("the link has no token")
	}
	return server, token, nil
}

// InviteInfo says where an invite link goes. A link that doesn't work is a 404, whatever the reason.
func (c *Client) InviteInfo(ctx context.Context, token string) (Invite, error) {
	var out Invite
	return out, c.do(ctx, "GET", "/api/chat/invites/"+url.PathEscape(token), nil, nil, &out)
}

// Join joins the room of an invite link, as a member; the room's id.
func (c *Client) Join(ctx context.Context, token string) (string, error) {
	var out struct {
		Room string `json:"room"`
	}
	return out.Room, c.do(ctx, "POST", "/api/chat/invites/"+url.PathEscape(token), nil, map[string]any{}, &out)
}

// ConfirmPasswordReset sets a new password with the emailed link's token (DESIGN.md §39).
func (c *Client) ConfirmPasswordReset(ctx context.Context, token, password string) error {
	return c.do(ctx, "POST", "/api/collections/users/confirm-password-reset", nil,
		map[string]string{"token": token, "password": password, "passwordConfirm": password}, nil)
}

// Users finds people by name or handle, not me (GET /api/chat/users).
func (c *Client) Users(ctx context.Context, q string) ([]User, error) {
	var out []User
	return out, c.do(ctx, "GET", "/api/chat/users", url.Values{"q": {q}}, nil, &out)
}

// RemoteUser finds someone on another server by "user@host" (federation; 404 or 400 when off or not found).
func (c *Client) RemoteUser(ctx context.Context, address string) (User, error) {
	var out User
	return out, c.do(ctx, "POST", "/api/chat/remote-users", nil, map[string]string{"address": address}, &out)
}

// OpenDM gets or makes the DM with a user (idempotent).
func (c *Client) OpenDM(ctx context.Context, user string) (Room, error) {
	var out Room
	return out, c.do(ctx, "POST", "/api/chat/dms", nil, map[string]string{"user": user}, &out)
}

// InboxItem is a mention of me, a reply to me or a reaction to mine (GET /api/chat/inbox).
type InboxItem struct {
	ID      string `json:"id"`
	Cursor  string `json:"cursor"`
	Kind    string `json:"kind"` // mention | reply | reaction
	Emoji   string `json:"emoji"`
	Created string `json:"created"`
	Read    bool   `json:"read"`
	Room    string `json:"room"`
	Message struct {
		ID      string `json:"id"`
		Text    string `json:"text"`
		Files   int    `json:"files"`
		Created string `json:"created"`
	} `json:"message"`
	Quote *struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	} `json:"quote"`
	Actor User `json:"actor"`
}

// Inbox is a page of the inbox, newest first; before is the last item's Cursor for the next.
type Inbox struct {
	Items  []InboxItem `json:"items"`
	More   bool        `json:"more"`
	SeenAt string      `json:"seen_at"`
}

func (c *Client) Inbox(ctx context.Context, before string) (Inbox, error) {
	v := url.Values{}
	if before != "" {
		v.Set("before", before)
	}
	var out Inbox
	return out, c.do(ctx, "GET", "/api/chat/inbox", v, nil, &out)
}

// InboxSeen marks the inbox looked at up to now.
func (c *Client) InboxSeen(ctx context.Context) error {
	return c.do(ctx, "POST", "/api/chat/inbox/seen", nil, map[string]any{}, nil)
}

// Hidden is one hidden room of mine (hidden_rooms; its row id is needed to unhide).
type Hidden struct {
	ID   string `json:"id"`
	Room string `json:"room"`
}

func (c *Client) HiddenRooms(ctx context.Context) ([]Hidden, error) {
	var out struct {
		Items []Hidden `json:"items"`
	}
	v := url.Values{"fields": {"id,room"}, "perPage": {"500"}, "skipTotal": {"1"}}
	return out.Items, c.do(ctx, "GET", "/api/collections/hidden_rooms/records", v, nil, &out)
}

func (c *Client) Hide(ctx context.Context, room string) (Hidden, error) {
	var out Hidden
	body := map[string]string{"room": room}
	if me := c.Me(); me != nil {
		body["user"] = me.ID
	}
	return out, c.do(ctx, "POST", "/api/collections/hidden_rooms/records", url.Values{"fields": {"id,room"}}, body, &out)
}

func (c *Client) Unhide(ctx context.Context, row string) error {
	return c.do(ctx, "DELETE", "/api/collections/hidden_rooms/records/"+url.PathEscape(row), nil, nil, nil)
}

// SetArchived archives or restores a room (its creator, or a moderator for a public one).
func (c *Client) SetArchived(ctx context.Context, room string, archived bool) (Room, error) {
	var out Room
	q := url.Values{"expand": {"members,writers"}, "fields": {RoomFields}}
	return out, c.do(ctx, "PATCH", "/api/collections/rooms/records/"+url.PathEscape(room), q, map[string]any{"archived": archived}, &out)
}
