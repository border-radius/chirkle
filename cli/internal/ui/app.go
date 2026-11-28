// Package ui is the console client's screens (docs/CLI.md §4): the room list, a room's messages and the composer,
// Jump to, the link picker and the login / signup form. Everything is reached from the keyboard.
package ui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/textarea"
	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
	"github.com/border-radius/chirkle/cli/internal/contract"
	"github.com/border-radius/chirkle/cli/internal/render"
)

type focus int

const (
	focusRooms focus = iota
	focusMessages
	focusComposer
)

const pageSize = 50

// roomState is an open (or once opened) room's message window.
type roomState struct {
	items   []api.Message // oldest first
	loaded  bool
	loading bool
	first   bool   // the room's first message is in items
	newFrom string // id of the first unread message when opened: the "New" line goes above it
	marked  string // created of the last message marked read
	sel     int    // selected message, -1 for none (following the bottom)
	offset  int    // lines scrolled up from the bottom
	atTop   bool   // the first line drawn is the window's first (set by View)
	draft   string
	newer   bool // the window doesn't reach the latest (gone to a message further back): ↓ loads more, G the latest
}

// App is the program's model.
type App struct {
	c       *api.Client
	cfg     *config.File
	site    api.Site
	st      render.Styles
	links   bool
	w, h    int
	focus   focus
	auth    *authForm // non-nil: the login / signup screen is up
	guest   bool
	rooms   []api.Room
	unread  api.Unread
	cursor  int // the room list's highlighted row (index into order())
	open    string
	state   map[string]*roomState
	compose textarea.Model
	jump    *textinput.Model
	jumpSel int
	picker  []string // the selected message's links, while choosing one (o)
	help    bool
	status  string
	online  bool
	down    time.Time

	events  chan api.Event
	conn    chan api.Status
	stopRT  context.CancelFunc
	started bool

	// Taking part (actions.go).
	replyTo   *api.Message // the message the composer answers
	editing   *api.Message // the message the composer edits
	back      []string     // replies left by going to their quotes (Backspace returns)
	react     *reactPicker
	confirm   *confirmBox
	sugg      []suggestion // the composer's "@" or ":" list
	suggSel   int
	suggStart int    // where the token being completed starts
	suggQuery string // the "@an" last asked for
	drafts    *config.Drafts

	// more.go.
	list   *listBox          // a DM, search or inbox list is up
	hidden map[string]string // room → its hidden_rooms row
	opened map[string]string // room → when it was last opened this run (Jump to's order)
}

// New makes the app for a client (logged in or a guest) and the accounts file.
func New(c *api.Client, cfg *config.File, site api.Site) *App {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.Prompt = "│ "
	ta.Placeholder = "Message"
	ta.CharLimit = contract.Limits.MessageText
	ta.SetHeight(2)
	ta.KeyMap.InsertNewline.SetKeys("alt+enter", "ctrl+j")
	a := &App{
		c: c, cfg: cfg, site: site, st: render.NewStyles(true), state: map[string]*roomState{},
		compose: ta, links: os.Getenv("TERM") != "dumb" && os.Getenv("CHIRKLE_NO_HYPERLINKS") == "",
		events: make(chan api.Event, 256), conn: make(chan api.Status, 8),
		drafts: config.LoadDrafts(), hidden: map[string]string{}, opened: map[string]string{},
	}
	if c.Token() == "" {
		f := newAuthForm(site, modeLogin)
		a.auth = &f
	}
	return a
}

// ── messages to the model ──────────────────────────────────────────────────────────────────────────────────────

type (
	roomsLoaded  struct{ rooms []api.Room }
	unreadLoaded struct{ u api.Unread }
	pageLoaded   struct {
		room  string
		kind  api.PageKind
		items []api.Message
	}
	changesLoaded struct {
		room  string
		items []api.Message
	}
	sent struct {
		id  string
		m   api.Message
		err error
	}
	rtEvent  api.Event
	rtStatus api.Status
	failed   struct {
		what string
		err  error
	}
	clearStatus struct{}
)

func (a *App) Init() tea.Cmd {
	cmds := []tea.Cmd{tea.RequestBackgroundColor, textarea.Blink}
	if a.auth == nil {
		cmds = append(cmds, a.start())
	}
	return tea.Batch(cmds...)
}

// start loads the rooms and unread counts and connects realtime, after a login or as a guest.
func (a *App) start() tea.Cmd {
	if a.stopRT != nil {
		a.stopRT()
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.stopRT = cancel
	a.started = true
	c := a.c
	go func() {
		subs := []api.Subscription{
			{Topic: "rooms/*", Query: map[string][]string{"expand": {"members,writers"}, "fields": {api.RoomFields}}},
		}
		topic, err := c.LiveTopic(ctx)
		if err == nil && topic != "" {
			subs = append(subs, api.Subscription{Topic: topic})
		}
		if c.Token() != "" {
			subs = append(subs, api.Subscription{Topic: "room_reads/*", Query: map[string][]string{"fields": {"id,room"}}})
		}
		c.Realtime(ctx, subs, a.events, a.conn)
	}()
	return tea.Batch(a.loadRooms(), a.loadUnread(), a.loadHidden(), a.waitEvent(), a.waitStatus())
}

func (a *App) waitEvent() tea.Cmd {
	return func() tea.Msg { return rtEvent(<-a.events) }
}

func (a *App) waitStatus() tea.Cmd {
	return func() tea.Msg { return rtStatus(<-a.conn) }
}

func (a *App) loadRooms() tea.Cmd {
	c := a.c
	return func() tea.Msg {
		r, err := c.Rooms(context.Background())
		if err != nil {
			return failed{"rooms", err}
		}
		return roomsLoaded{r}
	}
}

func (a *App) loadUnread() tea.Cmd {
	if a.c.Token() == "" {
		return nil
	}
	c := a.c
	return func() tea.Msg {
		u, err := c.Unread(context.Background())
		if err != nil {
			return failed{"unread", err}
		}
		return unreadLoaded{u}
	}
}

func (a *App) loadPage(room string, kind api.PageKind, at *api.Cursor, limit int) tea.Cmd {
	c := a.c
	return func() tea.Msg {
		items, err := c.Page(context.Background(), room, kind, at, "", limit)
		if err != nil {
			return failed{"messages", err}
		}
		return pageLoaded{room, kind, items}
	}
}

func (a *App) me() string {
	if u := a.c.Me(); u != nil {
		return u.ID
	}
	return ""
}

func (a *App) room(id string) *api.Room {
	for i := range a.rooms {
		if a.rooms[i].ID == id {
			return &a.rooms[i]
		}
	}
	return nil
}

// section is the room list's section a room is in.
func (a *App) section(r *api.Room) string {
	switch {
	case r.Archived:
		return "Archived"
	case a.hidden[r.ID] != "":
		return "Hidden"
	case r.IsDM():
		return "Direct messages"
	}
	return "Rooms"
}

// order is the room list as drawn: rooms by name, then DMs, newest first. Hidden, then archived rooms go last.
func (a *App) order() []*api.Room {
	var rooms, dms, hidden, archived []*api.Room
	for i := range a.rooms {
		r := &a.rooms[i]
		switch a.section(r) {
		case "Archived":
			archived = append(archived, r)
		case "Hidden":
			hidden = append(hidden, r)
		case "Direct messages":
			dms = append(dms, r)
		default:
			rooms = append(rooms, r)
		}
	}
	archived = append(hidden, archived...)
	me := a.me()
	sort.SliceStable(rooms, func(i, j int) bool {
		return strings.ToLower(rooms[i].Title(me)) < strings.ToLower(rooms[j].Title(me))
	})
	sort.SliceStable(dms, func(i, j int) bool { return dms[i].LastMessageAt > dms[j].LastMessageAt })
	return append(append(rooms, dms...), archived...)
}

func (a *App) rs(room string) *roomState {
	s := a.state[room]
	if s == nil {
		s = &roomState{sel: -1}
		a.state[room] = s
	}
	return s
}

// ── update ─────────────────────────────────────────────────────────────────────────────────────────────────────

func (a *App) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case tea.WindowSizeMsg:
		a.w, a.h = m.Width, m.Height
		a.layout()
		return a, nil
	case tea.BackgroundColorMsg:
		a.st = render.NewStyles(m.IsDark())
		a.compose.SetStyles(textarea.DefaultStyles(m.IsDark()))
		return a, nil
	case clearStatus:
		a.status = ""
		return a, nil
	case failed:
		if api.IsStatus(m.err, 401) && a.c.Token() != "" {
			return a, a.sessionEnded()
		}
		return a, a.say(fmt.Sprintf("Couldn't load %s: %s", m.what, render.OneLine(m.err.Error())))
	}

	if a.auth != nil {
		return a.updateAuth(msg)
	}

	if cmd, ok := a.moreMsg(msg); ok {
		return a, cmd
	}
	switch m := msg.(type) {
	case roomsLoaded:
		a.rooms = m.rooms
		if a.open == "" {
			if rs := a.order(); len(rs) > 0 {
				return a, a.openRoom(rs[0].ID, false)
			}
		}
		return a, nil
	case unreadLoaded:
		a.unread = m.u
		return a, nil
	case pageLoaded:
		return a, a.pageLoaded(m)
	case changesLoaded:
		s := a.rs(m.room)
		for _, x := range m.items {
			s.items = upsert(s.items, x)
		}
		return a, a.markRead()
	case sent:
		s := a.rs(a.roomOfPending(m.id))
		for i := range s.items {
			if s.items[i].ID == m.id {
				if m.err != nil {
					s.items[i].Pending, s.items[i].Failed = false, m.err
				} else {
					s.items[i] = m.m
				}
			}
		}
		return a, a.markRead()
	case changed:
		return a, a.applyChanged(m)
	case mentionable:
		a.gotMentionable(m)
		return a, nil
	case rtEvent:
		return a, tea.Batch(a.onEvent(api.Event(m)), a.waitEvent())
	case rtStatus:
		return a, tea.Batch(a.onStatus(api.Status(m)), a.waitStatus())
	case tea.PasteMsg:
		if a.focus == focusComposer {
			var cmd tea.Cmd
			a.compose, cmd = a.compose.Update(msg)
			return a, tea.Batch(cmd, a.composed())
		}
		return a, nil
	case tea.KeyPressMsg:
		return a, a.key(m)
	}
	if a.focus == focusComposer {
		var cmd tea.Cmd
		a.compose, cmd = a.compose.Update(msg)
		return a, cmd
	}
	return a, nil
}

func (a *App) updateAuth(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case authDone:
		a.cfg.Put(config.Account{Server: a.c.Base, Token: a.c.Token(), User: *m.user})
		if err := a.cfg.Save(); err != nil {
			a.status = "Couldn't save the session: " + err.Error()
		}
		a.auth, a.guest = nil, false
		a.state = map[string]*roomState{}
		a.open = ""
		return a, a.start()
	case authFailed:
		a.auth.failed(m.err)
		return a, nil
	case resetSent:
		f := newAuthForm(a.site, modeLogin)
		f.note = "If " + m.email + " has an account, a link to set a new password is on its way. Open it, then log in here."
		a.auth = &f
		return a, nil
	case tea.KeyPressMsg:
		switch m.String() {
		case "ctrl+c":
			return a, tea.Quit
		case "esc":
			a.auth, a.guest = nil, true
			if a.started {
				return a, nil
			}
			return a, a.start()
		}
	}
	if _, ok := msg.(tea.KeyPressMsg); !ok {
		if _, ok := msg.(tea.PasteMsg); !ok {
			if a.started {
				return a, nil // a guest's events while the form is up: dropped, refetched after login
			}
		}
	}
	return a, a.auth.update(msg, a.c)
}

func (a *App) sessionEnded() tea.Cmd {
	a.cfg.Remove()
	_ = a.cfg.Save()
	a.c.SetSession("", nil)
	f := newAuthForm(a.site, modeLogin)
	f.note = "Your session has ended: log in again."
	a.auth = &f
	return nil
}

func (a *App) say(s string) tea.Cmd {
	a.status = s
	return tea.Tick(6*time.Second, func(time.Time) tea.Msg { return clearStatus{} })
}

func (a *App) roomOfPending(id string) string {
	for room, s := range a.state {
		for _, m := range s.items {
			if m.ID == id {
				return room
			}
		}
	}
	return ""
}

// openRoom shows a room, loading it the first time (with its unread messages, under the "New" line).
func (a *App) openRoom(id string, toComposer bool) tea.Cmd {
	if a.open != "" {
		if a.editing != nil {
			a.stopEdit()
		}
		a.keepDraft()
	}
	a.replyTo, a.sugg, a.back = nil, nil, nil
	if a.open != "" && a.open != id {
		a.opened[a.open] = now() // left just now: Ctrl+K Enter goes back to it
	}
	a.open = id
	a.opened[id] = now()
	s := a.rs(id)
	if !s.loaded && s.draft == "" {
		s.draft = a.drafts.Get(a.c.Base, a.me(), id)
	}
	a.compose.SetValue(s.draft)
	for i, r := range a.order() {
		if r.ID == id {
			a.cursor = i
		}
	}
	if toComposer {
		a.setFocus(focusComposer)
	}
	if s.loaded || s.loading {
		return a.markRead()
	}
	s.loading = true
	n := a.unread.Rooms[id]
	return a.loadPage(id, api.Latest, nil, min(200, max(pageSize, n+10)))
}

func (a *App) pageLoaded(m pageLoaded) tea.Cmd {
	s := a.rs(m.room)
	s.loading = false
	switch m.kind {
	case api.Latest:
		keep := s.pendingOnly()
		s.items = m.items
		for _, p := range keep {
			s.items = upsert(s.items, p)
		}
		s.loaded, s.newer = true, false
		s.first = len(m.items) < pageSize && a.unread.Rooms[m.room] < pageSize
		if n := a.unread.Rooms[m.room]; n > 0 && n <= len(s.items) {
			s.newFrom = s.items[len(s.items)-n].ID
		}
	case api.Older:
		if len(m.items) < pageSize {
			s.first = true
		}
		s.items = append(slices.Clone(m.items), s.items...)
		if s.sel >= 0 {
			s.sel += len(m.items)
		}
	case api.Newer:
		for _, x := range m.items {
			s.items = upsert(s.items, x)
		}
		if s.newer {
			s.newer = len(m.items) == pageSize
			break
		}
		if len(m.items) == 200 {
			last := s.items[len(s.items)-1]
			return a.loadPage(m.room, api.Newer, &api.Cursor{Created: last.Created, ID: last.ID}, 200)
		}
	}
	return a.markRead()
}

// upsert puts a message in its place in the window (by created, id), replacing the one with its id.
func upsert(items []api.Message, m api.Message) []api.Message {
	for i := range items {
		if items[i].ID == m.ID {
			if m.Expand.ReplyTo == nil {
				m.Expand.ReplyTo = items[i].Expand.ReplyTo
			}
			items[i] = m
			return items
		}
	}
	i := sort.Search(len(items), func(i int) bool {
		return items[i].Created > m.Created || items[i].Created == m.Created && items[i].ID > m.ID
	})
	// A pending message (no created yet) sorts last: keep new ones after it only if they're newer.
	return slices.Insert(items, i, m)
}

// markRead marks the open room read when its newest message is on screen.
func (a *App) markRead() tea.Cmd {
	if a.open == "" || a.c.Token() == "" {
		return nil
	}
	s := a.rs(a.open)
	if s.offset > 0 || len(s.items) == 0 || s.newer {
		return nil
	}
	last := ""
	for _, m := range s.items {
		if !m.Pending && m.Failed == nil && m.Created > last {
			last = m.Created
		}
	}
	if last == "" || last <= s.marked {
		return nil
	}
	s.marked = last
	room := a.open
	delete(a.unread.Rooms, room)
	delete(a.unread.Mentions, room)
	c := a.c
	return func() tea.Msg {
		if err := c.MarkRead(context.Background(), room, last); err != nil {
			return failed{"read marks", err}
		}
		return nil
	}
}

func (a *App) onEvent(e api.Event) tea.Cmd {
	switch {
	case e.Topic == "rooms/*":
		var ev api.RecordEvent[api.Room]
		if json.Unmarshal(e.Data, &ev) != nil {
			return nil
		}
		i := slices.IndexFunc(a.rooms, func(r api.Room) bool { return r.ID == ev.Record.ID })
		switch {
		case ev.Action == "delete" && i >= 0:
			a.rooms = slices.Delete(a.rooms, i, i+1)
		case ev.Action != "delete" && i >= 0:
			a.rooms[i] = ev.Record
		case ev.Action != "delete":
			a.rooms = append(a.rooms, ev.Record)
		}
		return nil
	case e.Topic == "room_reads/*":
		return a.loadUnread() // read elsewhere (another device)
	case strings.HasPrefix(e.Topic, "chat/messages"):
		var ev api.RecordEvent[api.Message]
		if json.Unmarshal(e.Data, &ev) != nil {
			return nil
		}
		m := ev.Record
		if r := a.room(m.Room); r != nil && m.Created > r.LastMessageAt && ev.Action == "create" {
			r.LastMessageAt = m.Created
		}
		s := a.state[m.Room]
		if s != nil && s.loaded {
			if m.ReplyToID != "" && m.Expand.ReplyTo == nil {
				for _, o := range s.items {
					if o.ID == m.ReplyToID {
						q := &api.ReplyTo{ID: o.ID, Author: o.Author, Text: o.Text, Deleted: o.Deleted, Files: o.Files}
						q.Expand.Author = o.Expand.Author
						m.Expand.ReplyTo = q
					}
				}
			}
			if ev.Action == "delete" {
				m.Deleted = true
			}
			has := slices.ContainsFunc(s.items, func(o api.Message) bool { return o.ID == m.ID })
			if has || !s.newer { // a new message below a window that stops short comes with ↓
				s.items = upsert(s.items, m)
			}
		}
		if ev.Action == "create" && m.Author != a.me() && a.c.Token() != "" {
			if m.Room != a.open || s == nil || s.offset > 0 || s.newer {
				if a.unread.Rooms == nil {
					a.unread.Rooms = map[string]int{}
				}
				a.unread.Rooms[m.Room]++
				if slices.Contains(m.Mentions, a.me()) {
					if a.unread.Mentions == nil {
						a.unread.Mentions = map[string]int{}
					}
					a.unread.Mentions[m.Room]++
				}
				return nil
			}
		}
		return a.markRead()
	}
	return nil
}

// onStatus: after a reconnect, fill in what was missed: the list, the counts, and the open room's new messages,
// edits and deletes.
func (a *App) onStatus(s api.Status) tea.Cmd {
	if !s.Connected {
		if a.online {
			a.down = time.Now()
		}
		a.online = false
		return nil
	}
	a.online = true
	if !s.Reconnect {
		return nil
	}
	cmds := []tea.Cmd{a.loadRooms(), a.loadUnread(), a.loadHidden()}
	for room, st := range a.state {
		if !st.loaded || len(st.items) == 0 || st.newer {
			continue
		}
		var last *api.Message
		for i := len(st.items) - 1; i >= 0; i-- {
			if !st.items[i].Pending && st.items[i].Failed == nil {
				last = &st.items[i]
				break
			}
		}
		if last == nil {
			continue
		}
		cmds = append(cmds, a.loadPage(room, api.Newer, &api.Cursor{Created: last.Created, ID: last.ID}, 200))
		since := a.down.Add(-10 * time.Second).UTC().Format("2006-01-02 15:04:05.000Z")
		from, to, c, room := st.items[0].Created, last.Created, a.c, room
		cmds = append(cmds, func() tea.Msg {
			items, err := c.Changed(context.Background(), room, since, from, to)
			if err != nil {
				return failed{"changes", err}
			}
			return changesLoaded{room, items}
		})
	}
	return tea.Batch(cmds...)
}

// ── keys ───────────────────────────────────────────────────────────────────────────────────────────────────────

func (a *App) setFocus(f focus) {
	a.focus = f
	if f == focusComposer {
		a.compose.Focus()
	} else {
		a.compose.Blur()
	}
}

// quit keeps the drafts, then ends the program.
func (a *App) quit() tea.Cmd {
	if a.open != "" {
		if a.editing != nil {
			a.stopEdit()
		}
		a.keepDraft()
	}
	_ = a.drafts.Save()
	return tea.Quit
}

// keepDraft remembers what is in the composer for the open room, here and across runs.
func (a *App) keepDraft() {
	v := a.compose.Value()
	a.rs(a.open).draft = v
	if a.me() != "" {
		a.drafts.Set(a.c.Base, a.me(), a.open, strings.TrimSpace(v))
	}
}

func (a *App) key(k tea.KeyPressMsg) tea.Cmd {
	key := k.String()
	if key == "ctrl+c" {
		return a.quit()
	}
	if a.help {
		a.help = false
		return nil
	}
	if a.confirm != nil {
		c := a.confirm
		a.confirm = nil
		if key == "y" || key == "Y" {
			return c.yes()
		}
		return nil
	}
	if a.react != nil {
		return a.reactKey(k)
	}
	if a.jump != nil {
		return a.jumpKey(k)
	}
	if a.picker != nil {
		return a.pickerKey(key)
	}
	if a.list != nil {
		return a.listKey(k)
	}
	switch key {
	case "ctrl+k":
		in := textinput.New()
		in.Prompt = "Jump to: "
		in.Focus()
		a.jump, a.jumpSel = &in, 0
		return nil
	case "ctrl+_", "ctrl+/":
		a.setFocus(focusComposer)
		return nil
	case "tab":
		if a.focus == focusComposer && len(a.sugg) > 0 {
			break
		}
		a.setFocus((a.focus + 1) % 3)
		return nil
	case "shift+tab":
		a.setFocus((a.focus + 2) % 3)
		return nil
	}
	if a.focus == focusComposer {
		return a.composerKey(k)
	}
	switch key {
	case "?":
		a.help = true
		return nil
	case "q":
		return a.quit()
	case "L":
		if a.c.Token() == "" {
			f := newAuthForm(a.site, modeLogin)
			a.auth = &f
		}
		return nil
	case "S":
		if a.c.Token() == "" {
			f := newAuthForm(a.site, modeSignup)
			a.auth = &f
		}
		return nil
	case "n":
		return a.nextUnread()
	case "D":
		return a.startDM()
	case "/":
		return a.startSearch()
	case "I":
		return a.startInbox()
	case "H":
		return a.toggleHidden()
	case "A":
		return a.toggleArchived()
	case "i":
		a.setFocus(focusComposer)
		return nil
	}
	if a.focus == focusRooms {
		return a.roomsKey(key)
	}
	return a.messagesKey(key)
}

func (a *App) roomsKey(key string) tea.Cmd {
	rooms := a.order()
	switch key {
	case "up", "k":
		a.cursor = max(0, a.cursor-1)
	case "down", "j":
		a.cursor = min(len(rooms)-1, a.cursor+1)
	case "home", "g":
		a.cursor = 0
	case "end", "G":
		a.cursor = len(rooms) - 1
	case "enter", "right", "l":
		if a.cursor >= 0 && a.cursor < len(rooms) {
			r := rooms[a.cursor]
			return a.openRoom(r.ID, r.CanPost(a.me()))
		}
	}
	return nil
}

func (a *App) messagesKey(key string) tea.Cmd {
	if a.open == "" {
		return nil
	}
	s := a.rs(a.open)
	n := len(s.items)
	var cmd tea.Cmd
	sel := a.selected()
	switch key {
	case "up", "k":
		if s.sel < 0 {
			s.sel = n - 1
		} else if s.sel > 0 {
			s.sel--
		}
	case "down", "j":
		switch {
		case s.sel >= 0 && s.sel < n-1:
			s.sel++
		case s.newer:
			return a.loadNewer()
		default:
			s.sel, s.offset = -1, 0
		}
	case "pgup", "ctrl+u":
		s.sel = -1
		s.offset += max(1, a.msgHeight()-2)
	case "pgdown", "ctrl+d":
		if s.newer && s.offset == 0 {
			return a.loadNewer()
		}
		s.sel = -1
		s.offset = max(0, s.offset-max(1, a.msgHeight()-2))
	case "G", "end":
		if s.newer {
			return a.toLatest()
		}
		s.sel, s.offset = -1, 0
	case "g", "home":
		if s.first {
			s.sel = 0
		} else {
			s.offset += 1 << 20 // load older until the first; drawn clamped
		}
	case "esc", "left", "h":
		if s.sel >= 0 {
			s.sel = -1
			s.offset = 0
		} else {
			a.setFocus(focusRooms)
		}
	case "enter":
		if sel != nil && sel.ReplyToID != "" && !sel.Deleted {
			return a.goToQuote(sel)
		}
		fallthrough
	case "o":
		if sel != nil {
			links := render.Links(*sel, a.c.FileURL)
			if len(links) == 0 {
				return a.say("No links in this message")
			}
			a.picker = links
		}
	case "backspace":
		return a.goBack()
	case "r":
		switch {
		case sel != nil && sel.Failed != nil:
			m := *sel
			sel.Failed, sel.Pending = nil, true
			cmd = a.sendCmd(m.ID, m.Room, m.Text, m.ReplyToID)
		case sel != nil:
			return a.startReply(sel)
		}
	case "e":
		if sel != nil {
			return a.startEdit(sel)
		}
	case "d", "delete":
		if sel != nil {
			return a.askDelete(sel)
		}
	case "+", "=":
		if sel != nil {
			return a.startReact(sel)
		}
	}
	if s.atTop && !s.first && !s.loading && len(s.items) > 0 && (s.offset > 0 || s.sel == 0) {
		s.loading = true
		f := s.items[0]
		return tea.Batch(cmd, a.loadPage(a.open, api.Older, &api.Cursor{Created: f.Created, ID: f.ID}, pageSize))
	}
	return tea.Batch(cmd, a.markRead())
}

func (a *App) composerKey(k tea.KeyPressMsg) tea.Cmd {
	if len(a.sugg) > 0 {
		switch k.String() {
		case "up", "ctrl+p":
			a.suggSel = (a.suggSel + len(a.sugg) - 1) % len(a.sugg)
			return nil
		case "down", "ctrl+n":
			a.suggSel = (a.suggSel + 1) % len(a.sugg)
			return nil
		case "tab", "enter":
			a.pick()
			return nil
		case "esc":
			a.sugg = nil
			return nil
		}
	}
	switch k.String() {
	case "esc":
		switch {
		case a.editing != nil:
			a.stopEdit()
		case a.replyTo != nil:
			a.replyTo = nil
		default:
			a.setFocus(focusMessages)
		}
		return nil
	case "up":
		if strings.TrimSpace(a.compose.Value()) == "" && a.editing == nil {
			return a.editLast()
		}
	case "enter":
		if a.editing != nil {
			return a.saveEdit()
		}
		text := strings.TrimSpace(a.compose.Value())
		if text == "" || a.open == "" {
			return nil
		}
		r := a.room(a.open)
		if r == nil || !r.CanPost(a.me()) {
			if a.c.Token() == "" {
				return a.say("Log in (L) or sign up (S) to post")
			}
			return a.say("You can't post in this room")
		}
		id := api.NewID()
		pending := api.Message{ID: id, Room: a.open, Text: text, Author: a.me(), Pending: true,
			Created: time.Now().UTC().Format("2006-01-02 15:04:05.000Z")}
		pending.Expand.Author = a.c.Me()
		replyTo := ""
		if q := a.replyTo; q != nil {
			replyTo = q.ID
			pending.ReplyToID = q.ID
			pending.Expand.ReplyTo = &api.ReplyTo{ID: q.ID, Author: q.Author, Text: q.Text, Files: q.Files}
			pending.Expand.ReplyTo.Expand.Author = q.Expand.Author
		}
		s := a.rs(a.open)
		s.items = append(s.items, pending)
		s.sel, s.offset, s.draft = -1, 0, ""
		a.replyTo, a.sugg = nil, nil
		a.compose.Reset()
		a.drafts.Set(a.c.Base, a.me(), a.open, "")
		if s.newer { // what you send goes at the end: show it there
			return tea.Batch(a.sendCmd(id, a.open, text, replyTo), a.toLatest())
		}
		return a.sendCmd(id, a.open, text, replyTo)
	}
	var cmd tea.Cmd
	a.compose, cmd = a.compose.Update(k)
	return tea.Batch(cmd, a.composed())
}

func (a *App) sendCmd(id, room, text, replyTo string) tea.Cmd {
	c := a.c
	return func() tea.Msg {
		m, err := c.Send(context.Background(), id, room, text, replyTo)
		return sent{id, m, err}
	}
}

func (a *App) nextUnread() tea.Cmd {
	rooms := a.order()
	for i := 1; i <= len(rooms); i++ {
		r := rooms[(a.cursor+i)%len(rooms)]
		if a.unread.Rooms[r.ID] > 0 && r.ID != a.open {
			return a.openRoom(r.ID, false)
		}
	}
	return a.say("No unread rooms")
}

func (a *App) jumpKey(k tea.KeyPressMsg) tea.Cmd {
	switch k.String() {
	case "esc":
		a.jump = nil
		return nil
	case "up", "ctrl+p":
		a.jumpSel = max(0, a.jumpSel-1)
		return nil
	case "down", "ctrl+n":
		a.jumpSel = min(len(a.jumpMatches())-1, a.jumpSel+1)
		return nil
	case "enter":
		ms := a.jumpMatches()
		a.jump = nil
		if a.jumpSel < len(ms) {
			r := ms[a.jumpSel]
			return a.openRoom(r.ID, r.CanPost(a.me()))
		}
		return nil
	}
	in, cmd := a.jump.Update(k)
	a.jump = &in
	a.jumpSel = 0
	return cmd
}

func (a *App) pickerKey(key string) tea.Cmd {
	links := a.picker
	if key == "esc" || key == "q" {
		a.picker = nil
		return nil
	}
	copyIt := false
	if strings.HasPrefix(key, "alt+") { // alt+digit: copy instead of open
		copyIt, key = true, strings.TrimPrefix(key, "alt+")
	}
	if len(key) == 1 && key[0] >= '1' && key[0] <= '9' {
		i := int(key[0] - '1')
		if i < len(links) {
			a.picker = nil
			if copyIt {
				return tea.Batch(tea.SetClipboard(links[i]), a.say("Copied "+links[i]))
			}
			return a.openURL(links[i])
		}
	}
	if key == "y" && len(links) == 1 {
		a.picker = nil
		return tea.Batch(tea.SetClipboard(links[0]), a.say("Copied "+links[0]))
	}
	return nil
}

func (a *App) openURL(u string) tea.Cmd {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	if err := cmd.Start(); err != nil {
		return tea.Batch(tea.SetClipboard(u), a.say("Couldn't open a browser; copied the link: "+u))
	}
	go cmd.Wait()
	return a.say("Opened " + u)
}

// ── view ───────────────────────────────────────────────────────────────────────────────────────────────────────

const sidebarWidth = 28

func (a *App) wide() bool { return a.w >= 90 }

func (a *App) layout() {
	w := a.w
	if a.wide() {
		w = a.w - sidebarWidth - 1
	}
	a.compose.SetWidth(max(10, w))
}

func (a *App) msgHeight() int { return max(3, a.h-1-1-a.compose.Height()-1) } // header, status, composer, rule

func (a *App) View() tea.View {
	var content string
	switch {
	case a.w == 0:
		content = "…"
	case a.auth != nil:
		server := strings.TrimPrefix(strings.TrimPrefix(a.c.Base, "https://"), "http://")
		content = lipgloss.NewStyle().Padding(1, 2).Render(a.auth.view(a.st, server, a.w))
	default:
		content = a.mainView()
	}
	v := tea.NewView(content)
	v.AltScreen = true
	v.WindowTitle = render.OneLine(a.site.Title)
	return v
}

func (a *App) mainView() string {
	h := a.h - 1
	var body string
	switch {
	case a.wide():
		side := a.roomsView(sidebarWidth, h)
		rule := strings.TrimRight(strings.Repeat(a.st.Muted.Render("│")+"\n", h), "\n")
		body = lipgloss.JoinHorizontal(lipgloss.Top, side, rule, a.roomView(a.w-sidebarWidth-1, h))
	case a.focus == focusRooms:
		body = a.roomsView(a.w, h)
	default:
		body = a.roomView(a.w, h)
	}
	if a.jump != nil {
		body = a.overlay(body, a.jumpView())
	}
	if a.react != nil {
		body = a.overlay(body, a.reactView())
	}
	if a.picker != nil {
		body = a.overlay(body, a.pickerView())
	}
	if a.list != nil {
		body = a.overlay(body, a.listView())
	}
	if a.help {
		body = a.overlay(body, a.helpView())
	}
	return body + "\n" + a.statusView()
}

func (a *App) overlay(body, box string) string {
	b := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1).Render(box)
	x := max(0, (a.w-lipgloss.Width(b))/2)
	y := max(0, (a.h-lipgloss.Height(b))/3)
	return lipgloss.NewCompositor(lipgloss.NewLayer(body), lipgloss.NewLayer(b).X(x).Y(y).Z(1)).Render()
}

func (a *App) roomsView(w, h int) string {
	lines := []string{a.st.Bold.Render(ansi.Truncate(render.OneLine(a.site.Title), w, "…")), ""}
	rooms := a.order()
	me := a.me()
	section := ""
	for i, r := range rooms {
		sec := a.section(r)
		if sec != section {
			if section != "" {
				lines = append(lines, "")
			}
			lines = append(lines, a.st.Muted.Render(sec))
			section = sec
		}
		lead := "# "
		switch {
		case r.IsDM():
			lead = "@ "
		case r.Visibility == "private":
			lead = "🔒"
		case r.Visibility == "open":
			lead = "◎ "
		}
		mark := ""
		if n := a.unread.Rooms[r.ID]; n > 0 {
			mark = " •"
			if r.IsDM() || a.unread.Mentions[r.ID] > 0 {
				mark = fmt.Sprintf(" %d", n)
				if a.unread.Mentions[r.ID] > 0 {
					mark = " @" + mark[1:]
				}
			}
		}
		name := ansi.Truncate(render.OneLine(r.Title(me)), w-4-len(mark), "…")
		row := lead + name
		style := lipgloss.NewStyle()
		if a.unread.Rooms[r.ID] > 0 {
			style = a.st.Bold
		}
		if r.Archived || a.hidden[r.ID] != "" {
			style = a.st.Muted
		}
		row = style.Render(row) + a.st.Accent.Render(mark)
		switch {
		case i == a.cursor && a.focus == focusRooms:
			row = a.st.Selected.Render("›") + row
		case r.ID == a.open:
			row = a.st.Accent.Render("▏") + row
		default:
			row = " " + row
		}
		lines = append(lines, row)
	}
	if len(rooms) == 0 {
		lines = append(lines, a.st.Muted.Render("No rooms yet"))
	}
	// Keep the cursor's row on screen.
	if len(lines) > h {
		at := 0
		for i, l := range lines {
			if strings.Contains(ansi.Strip(l), "›") {
				at = i
			}
		}
		start := min(max(0, at-h/2), len(lines)-h)
		lines = lines[start : start+h]
	}
	return lipgloss.NewStyle().Width(w).Height(h).MaxHeight(h).Render(strings.Join(lines, "\n"))
}

// msgLine is a drawn line and the message it belongs to (-1 for a separator).
type msgLine struct {
	text string
	msg  int
}

func (a *App) roomView(w, h int) string {
	if a.open == "" {
		return lipgloss.NewStyle().Width(w).Height(h).Render(a.st.Muted.Render("  Pick a room (ctrl+k to jump)"))
	}
	r := a.room(a.open)
	s := a.rs(a.open)
	me := a.me()
	title := ""
	if r != nil {
		title = render.OneLine(r.Title(me))
		if !r.IsDM() {
			title = "# " + title
		}
		if r.Archived {
			title += a.st.Muted.Render("  archived, read-only")
		}
	}
	header := a.st.Bold.Render(ansi.Truncate(title, w, "…"))

	// The composer, or why there is none.
	var composer string
	switch {
	case a.c.Token() == "":
		composer = a.st.Muted.Render("Reading as a guest · L log in · S sign up")
	case r != nil && !r.CanPost(me):
		composer = a.st.Muted.Render("You can read this room but not post in it")
	default:
		var top []string
		if a.focus == focusComposer {
			top = a.suggestView(w)
		}
		if bar := a.composerBar(w); bar != "" {
			top = append(top, bar)
		}
		composer = strings.Join(append(top, a.compose.View()), "\n")
	}
	rule := a.st.Muted.Render(strings.Repeat("─", w))
	mh := max(1, h-1-1-lipgloss.Height(composer))

	lines := a.messageLines(s, w-2, me)
	// Keep the selected message on screen, then clamp the scroll.
	total := len(lines)
	if s.sel >= 0 {
		first, last := -1, -1
		for i, l := range lines {
			if l.msg == s.sel {
				if first < 0 {
					first = i
				}
				last = i
			}
		}
		if first >= 0 {
			bottom := total - s.offset // one past the last visible line
			if last >= bottom {
				s.offset = total - last - 1
			}
			if first < total-s.offset-mh {
				s.offset = total - first - mh
			}
		}
	}
	s.offset = max(0, min(s.offset, total-mh))
	end := total - s.offset
	start := max(0, end-mh)
	s.atTop = start == 0
	var out []string
	if start == 0 {
		switch {
		case s.loading:
			out = append(out, a.st.Muted.Render("  loading…"))
		case s.first && s.loaded:
			out = append(out, a.st.Muted.Render("  the start of the room"))
		}
	}
	for _, l := range lines[start:end] {
		mark := "  "
		if l.msg >= 0 && l.msg == s.sel {
			mark = a.st.Selected.Render("▌ ")
		}
		out = append(out, mark+l.text)
	}
	if len(out) > mh {
		out = out[len(out)-mh:]
	}
	for len(out) < mh {
		out = append([]string{""}, out...)
	}
	switch {
	case len(out) == 0:
	case s.offset > 0:
		out[len(out)-1] = a.st.Accent.Render("  ↓ more below · G latest")
	case s.newer && s.loading:
		out[len(out)-1] = a.st.Muted.Render("  loading…")
	case s.newer:
		out[len(out)-1] = a.st.Accent.Render("  ↓ newer messages · G latest")
	}
	return strings.Join(append([]string{header}, append(out, rule, composer)...), "\n")
}

func (a *App) messageLines(s *roomState, w int, me string) []msgLine {
	var lines []msgLine
	day := ""
	var prev *api.Message
	for i := range s.items {
		m := &s.items[i]
		if d := render.Day(m.Created); d != day && d != "" {
			day = d
			lines = append(lines, msgLine{a.st.Muted.Render(centre("── "+d+" ──", w)), -1})
			prev = nil
		}
		if m.ID == s.newFrom {
			lines = append(lines, msgLine{a.st.Error.Render(centre("── New ──", w)), -1})
			prev = nil
		}
		header := prev == nil || prev.Author != m.Author ||
			api.ParseTime(m.Created).Sub(api.ParseTime(prev.Created)) > 5*time.Minute
		if header && prev != nil {
			lines = append(lines, msgLine{"", -1})
		}
		o := render.Options{Me: me, MyHandle: a.myHandle(), Width: w, Hyperlinks: a.links, FileURL: a.c.FileURL, Styles: a.st, Header: header}
		for _, l := range render.Lines(o, *m) {
			lines = append(lines, msgLine{l, i})
		}
		prev = m
	}
	if len(s.items) == 0 && s.loaded {
		lines = append(lines, msgLine{a.st.Muted.Render("No messages yet"), -1})
	}
	return lines
}

func centre(s string, w int) string {
	pad := max(0, (w-ansi.StringWidth(s))/2)
	return strings.Repeat(" ", pad) + s
}

func (a *App) statusView() string {
	var left string
	switch {
	case a.confirm != nil:
		left = a.confirm.text
	case a.status != "":
		left = a.status
	case !a.online && a.started:
		left = "connecting…"
	default:
		switch a.focus {
		case focusRooms:
			left = "↑↓ move · enter open · n next unread · D message · I mentions · H hide · ctrl+k jump · ? help"
		case focusMessages:
			left = "↑↓ select · r reply · e edit · d delete · + react · o links · / search · i write · ? help"
		case focusComposer:
			left = "enter send · alt+enter new line · ↑ edit last · @ people · :emoji · esc back"
		}
	}
	right := "guest"
	if u := a.c.Me(); u != nil {
		right = render.OneLine(u.Name)
	}
	if !a.online && a.started {
		right = "offline · " + right
	}
	gap := max(1, a.w-ansi.StringWidth(left)-ansi.StringWidth(right)-1)
	return a.st.Muted.Render(ansi.Truncate(left, a.w-ansi.StringWidth(right)-2, "…") + strings.Repeat(" ", gap) + right)
}

func (a *App) jumpView() string {
	var b strings.Builder
	b.WriteString(a.jump.View() + "\n")
	ms := a.jumpMatches()
	for i, r := range ms {
		if i >= 12 {
			b.WriteString(a.st.Muted.Render(fmt.Sprintf("  … %d more", len(ms)-12)))
			break
		}
		row := "  " + render.OneLine(r.Title(a.me()))
		if i == a.jumpSel {
			row = a.st.Selected.Render("› " + render.OneLine(r.Title(a.me())))
		}
		b.WriteString(ansi.Truncate(row, 50, "…") + "\n")
	}
	if len(ms) == 0 {
		b.WriteString(a.st.Muted.Render("  Nothing found"))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (a *App) pickerView() string {
	var b strings.Builder
	b.WriteString(a.st.Bold.Render("Open a link") + a.st.Muted.Render("  1–9 open · alt+1–9 copy · esc close") + "\n")
	for i, l := range a.picker {
		if i >= 9 {
			break
		}
		b.WriteString(fmt.Sprintf("%d  %s\n", i+1, ansi.Truncate(render.OneLine(l), max(20, a.w-12), "…")))
	}
	return strings.TrimRight(b.String(), "\n")
}

func (a *App) helpView() string {
	rows := [][2]string{
		{"ctrl+k", "Jump to a room or DM"},
		{"tab / shift+tab", "Move between rooms, messages, composer"},
		{"ctrl+/  i", "Write a message"},
		{"n", "Next unread room"},
		{"D", "Direct message: a name, @handle or user@server"},
		{"I", "Mentions & replies (and reactions to yours)"},
		{"/", "Search in the room"},
		{"H  A", "Hide / show the room for you; archive / restore it"},
		{"↑↓  j k", "Move; in messages, select one"},
		{"pgup pgdn", "Scroll (older messages load at the top)"},
		{"g  G", "First / latest"},
		{"o", "Open the selected message's links and files"},
		{"r", "Reply (to a failed message: send it again)"},
		{"e", "Edit your message"},
		{"d", "Delete (asks first)"},
		{"+", "React: by name or 1–8; again takes it back"},
		{"enter", "On a reply: go to the original"},
		{"backspace", "Back to the reply"},
		{"↑ (composer empty)", "Edit your last message"},
		{"@  :", "Offer people / emoji: tab or enter picks"},
		{"enter", "Send (in the composer)"},
		{"alt+enter  ctrl+j", "New line"},
		{"esc", "Back"},
		{"L  S", "Log in / sign up (as a guest)"},
		{"q  ctrl+c", "Quit"},
	}
	var b strings.Builder
	b.WriteString(a.st.Bold.Render("Keys") + a.st.Muted.Render("  any key closes") + "\n")
	for _, r := range rows {
		b.WriteString(a.st.Accent.Render(padRight(r[0], 20)) + r[1] + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}
