package api

import (
	"crypto/rand"
	"strings"
	"time"

	"github.com/border-radius/chirkle/cli/internal/contract"
)

// User is a public profile (contract fields.user). Never an email.
type User struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Avatar   string `json:"avatar,omitempty"`
	Instance string `json:"instance,omitempty"`
	Handle   string `json:"handle,omitempty"`
	NoDMs    bool   `json:"no_dms,omitempty"`
	Kind     string `json:"kind,omitempty"`
}

// Room is a room or DM (contract fields.room).
type Room struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Archived      bool     `json:"archived"`
	CreatedBy     string   `json:"created_by"`
	Kind          string   `json:"kind"`       // public | dm | …
	Visibility    string   `json:"visibility"` // public | private | open
	Members       []string `json:"members"`
	Posting       string   `json:"posting"` // everyone | selected (then only Writers and the creator)
	Writers       []string `json:"writers"`
	LastMessageAt string   `json:"last_message_at"`
	Created       string   `json:"created"`
	Expand        struct {
		Members []User `json:"members"`
		Writers []User `json:"writers"`
	} `json:"expand"`
}

// IsDM says whether the room is a direct conversation.
func (r Room) IsDM() bool { return r.Kind == "dm" }

// Title is what the room is called for me: a DM by the other person's name.
func (r Room) Title(me string) string {
	if !r.IsDM() {
		return r.Name
	}
	for _, u := range r.Expand.Members {
		if u.ID != me {
			return u.Name
		}
	}
	if len(r.Expand.Members) > 0 {
		return r.Expand.Members[0].Name
	}
	return "(conversation)"
}

// CanPost says whether me may write in the room.
func (r Room) CanPost(me string) bool {
	if me == "" || r.Archived {
		return false
	}
	if r.Posting != "selected" {
		return true
	}
	for _, w := range r.Writers {
		if w == me {
			return true
		}
	}
	return r.CreatedBy == me
}

// Reaction is one emoji on a message and who put it there.
type Reaction struct {
	Emoji string   `json:"emoji"`
	Users []string `json:"users"`
}

// Preview is a link preview (DESIGN.md §22).
type Preview struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
}

// ReplyTo is the quoted message, as fields.message expands it.
type ReplyTo struct {
	ID      string   `json:"id"`
	Author  string   `json:"author"`
	Text    string   `json:"text"`
	Deleted bool     `json:"deleted"`
	Files   []string `json:"files"`
	Expand  struct {
		Author *User `json:"author"`
	} `json:"expand"`
}

// Message is a message (contract fields.message).
type Message struct {
	ID            string            `json:"id"`
	Room          string            `json:"room"`
	Text          string            `json:"text"`
	Created       string            `json:"created"`
	Updated       string            `json:"updated"`
	EditedAt      string            `json:"edited_at"`
	Deleted       bool              `json:"deleted"`
	Files         []string          `json:"files"`
	FileNames     map[string]string `json:"file_names"`
	FileSources   map[string]string `json:"file_sources"`
	FileDims      map[string][2]int `json:"file_dims"`
	Reactions     []Reaction        `json:"reactions"`
	Previews      []Preview         `json:"previews"`
	Author        string            `json:"author"`
	ReplyToID     string            `json:"reply_to"`
	ForwardedFrom string            `json:"forwarded_from"`
	ForwardOf     string            `json:"forward_of"`
	Mentions      []string          `json:"mentions"`
	Expand        struct {
		Author        *User    `json:"author"`
		ReplyTo       *ReplyTo `json:"reply_to"`
		ForwardedFrom *User    `json:"forwarded_from"`
	} `json:"expand"`

	// Pending is set on a message being sent, Failed when the send was refused (never from the server).
	Pending bool  `json:"-"`
	Failed  error `json:"-"`
}

// AuthorName is the author's name, or a placeholder for a profile not expanded.
func (m Message) AuthorName() string {
	if m.Expand.Author != nil && m.Expand.Author.Name != "" {
		return m.Expand.Author.Name
	}
	return "someone"
}

// FileURL is where the message's file is: its source message's, for a forward (file_sources).
func (m Message) FileSource(file string) string {
	if src := m.FileSources[file]; src != "" {
		return src
	}
	return m.ID
}

// FileName is the name the file was sent with.
func (m Message) FileName(file string) string {
	if n := m.FileNames[file]; n != "" {
		return n
	}
	return file
}

// Unread is GET /api/chat/unread.
type Unread struct {
	At       string         `json:"at"`
	Rooms    map[string]int `json:"rooms"`
	IDs      []string       `json:"ids"`
	Inbox    int            `json:"inbox"`
	Mentions map[string]int `json:"mentions"`
}

// Site is the site record's public part (DESIGN.md §24, §39).
type Site struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	InviteOnly    bool   `json:"invite_only"`
	PasswordReset bool   `json:"password_reset"`
}

// MessageFields and RoomFields are what the clients ask for (shared/contract.json).
var (
	MessageFields = contract.Fields.Message
	RoomFields    = contract.Fields.Room
	UserFields    = contract.Fields.User
)

const messageExpand = "author,reply_to.author,forwarded_from"

// ParseTime reads PocketBase's "2006-01-02 15:04:05.000Z".
func ParseTime(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04:05.000Z07:00", strings.TrimSpace(s))
	if err != nil {
		return time.Time{}
	}
	return t
}

// NewID makes a record id as PocketBase does (15 of [a-z0-9]): sent with a new message, so a retry can't duplicate it.
func NewID() string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 15)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}
