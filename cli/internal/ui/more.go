package ui

// Milestone 3 (docs/CLI.md §8): DMs, search in a room, Mentions & replies, hide and archive, and going to any
// message of a room (a window that doesn't reach the latest).

import (
	"context"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/jump"
	"github.com/border-radius/chirkle/cli/internal/render"
)

// ── a list box: DMs, search, the inbox ─────────────────────────────────────────────────────────────────────────

type listItem struct {
	label string
	dim   bool
	do    func() tea.Cmd
	keep  bool // the box stays up after it
}

type listBox struct {
	kind    string // "dm", "search", "inbox": results are only taken for the box still up
	title   string
	in      *textinput.Model // nil: no input
	items   []listItem
	sel     int
	note    string               // shown under the list (nothing found, searching…)
	onInput func(string) tea.Cmd // the text changed
	onEnter func(string) tea.Cmd // Enter with nothing listed
	more    func() tea.Cmd       // ↓ at the end: the next page
	typed   bool                 // Enter with something typed goes to onEnter even with items listed
	onTab   func(string) string  // Tab completes the text
}

func (a *App) openList(b *listBox) {
	if b.in != nil {
		b.in.Focus()
	}
	a.list = b
}

func (a *App) listKey(k tea.KeyPressMsg) tea.Cmd {
	b := a.list
	switch k.String() {
	case "esc":
		a.list = nil
		return nil
	case "up", "ctrl+p":
		b.sel = max(0, b.sel-1)
		return nil
	case "down", "ctrl+n":
		if b.sel < len(b.items)-1 {
			b.sel++
		} else if b.more != nil {
			m := b.more
			b.more = nil
			return m()
		}
		return nil
	case "tab":
		if b.onTab != nil && b.in != nil {
			b.in.SetValue(b.onTab(b.in.Value()))
			b.in.CursorEnd()
		}
		return nil
	case "enter":
		if b.typed && b.in != nil && strings.TrimSpace(b.in.Value()) != "" {
			return b.onEnter(strings.TrimSpace(b.in.Value()))
		}
		if b.sel < len(b.items) && b.items[b.sel].do != nil {
			if !b.items[b.sel].keep {
				a.list = nil
			}
			return b.items[b.sel].do()
		}
		if b.onEnter != nil && b.in != nil {
			return b.onEnter(strings.TrimSpace(b.in.Value()))
		}
		return nil
	}
	if b.in == nil {
		return nil
	}
	before := b.in.Value()
	in, cmd := b.in.Update(k)
	b.in = &in
	if in.Value() != before && b.onInput != nil {
		b.sel = 0
		return tea.Batch(cmd, b.onInput(strings.TrimSpace(in.Value())))
	}
	return cmd
}

func (a *App) listView() string {
	b := a.list
	var out strings.Builder
	out.WriteString(a.st.Bold.Render(b.title) + a.st.Muted.Render("  ↑↓ choose · enter go · esc close") + "\n")
	if b.in != nil {
		out.WriteString(b.in.View() + "\n")
	}
	w := max(30, min(a.w-8, 90))
	start := max(0, min(b.sel-6, len(b.items)-12))
	for i := start; i < len(b.items) && i < start+12; i++ {
		it := b.items[i]
		row := "  " + it.label
		switch {
		case i == b.sel:
			row = a.st.Selected.Render("› " + ansi.Strip(it.label))
		case it.dim:
			row = a.st.Muted.Render(row)
		}
		out.WriteString(ansi.Truncate(row, w, "…") + "\n")
	}
	if b.note != "" {
		out.WriteString(a.st.Muted.Render("  "+b.note) + "\n")
	}
	return strings.TrimRight(out.String(), "\n")
}

type (
	usersFound struct {
		q     string
		users []api.User
		err   error
	}
	dmOpened struct {
		room api.Room
		err  error
	}
	searchFound struct {
		room, q string
		items   []api.Message
		err     error
	}
	inboxLoaded struct {
		page   api.Inbox
		append bool
		err    error
	}
	hiddenLoaded struct {
		rows []api.Hidden
		err  error
	}
	hiddenChanged struct {
		room, row string // row "" once unhidden
		err       error
	}
	archivedChanged struct {
		room api.Room
		err  error
	}
	windowLoaded struct {
		room, target string
		items        []api.Message
		older, newer bool
		err          error
	}
)

// ── DMs ────────────────────────────────────────────────────────────────────────────────────────────────────────

func (a *App) startDM() tea.Cmd {
	if a.c.Token() == "" {
		return a.say("Log in (L) or sign up (S) to message someone")
	}
	in := textinput.New()
	in.Prompt = "Message: "
	in.Placeholder = "a name, @handle or user@server"
	b := &listBox{kind: "dm", title: "Direct message", in: &in, note: "Type a name"}
	c := a.c
	b.onInput = func(q string) tea.Cmd {
		b.items = nil
		if q == "" {
			b.note = "Type a name"
			return nil
		}
		b.note = "looking…"
		return func() tea.Msg {
			us, err := c.Users(context.Background(), q)
			return usersFound{q, us, err}
		}
	}
	b.onEnter = func(q string) tea.Cmd {
		at := strings.LastIndex(q, "@")
		if at <= 0 || !strings.Contains(q[at:], ".") {
			return nil
		}
		b.note = "asking " + q[at+1:] + "…"
		return func() tea.Msg {
			u, err := c.RemoteUser(context.Background(), strings.TrimPrefix(q, "@"))
			if err != nil {
				return dmOpened{err: err}
			}
			r, err := c.OpenDM(context.Background(), u.ID)
			return dmOpened{r, err}
		}
	}
	a.openList(b)
	return nil
}

func (a *App) gotUsers(m usersFound) {
	b := a.list
	if b == nil || b.kind != "dm" || b.in == nil || strings.TrimSpace(b.in.Value()) != m.q {
		return
	}
	b.items, b.note = nil, ""
	if m.err != nil {
		b.note = "Couldn't look: " + render.OneLine(m.err.Error())
		return
	}
	c := a.c
	for _, u := range m.users {
		label := render.OneLine(u.Name)
		if u.Handle != "" {
			label += a.st.Muted.Render(" @" + render.OneLine(u.Handle))
		}
		if u.Instance != "" {
			label += a.st.Muted.Render(" · " + render.OneLine(u.Instance))
		}
		it := listItem{label: label}
		if u.NoDMs {
			it.label += a.st.Muted.Render("  doesn't take DMs")
			it.dim = true
		} else {
			id := u.ID
			it.do = func() tea.Cmd {
				return func() tea.Msg {
					r, err := c.OpenDM(context.Background(), id)
					return dmOpened{r, err}
				}
			}
		}
		b.items = append(b.items, it)
	}
	if len(b.items) == 0 {
		b.note = "Nobody by that name"
		if strings.Contains(m.q, "@") && strings.Contains(m.q[strings.LastIndex(m.q, "@"):], ".") {
			b.note = "Enter: look on that server"
		}
	}
}

func (a *App) gotDM(m dmOpened) tea.Cmd {
	if m.err != nil {
		if a.list != nil && a.list.kind == "dm" {
			a.list.note = "Couldn't: " + apiMessage(m.err)
			return nil
		}
		return a.say("Couldn't open the conversation: " + apiMessage(m.err))
	}
	a.list = nil
	if r := a.room(m.room.ID); r != nil {
		*r = m.room
	} else {
		a.rooms = append(a.rooms, m.room)
	}
	return a.openRoom(m.room.ID, m.room.CanPost(a.me()))
}

// apiMessage is the server's reason, its field's first if any.
func apiMessage(err error) string {
	if e, ok := err.(*api.Error); ok {
		for _, f := range e.Fields {
			return render.OneLine(f)
		}
		return render.OneLine(e.Message)
	}
	return render.OneLine(err.Error())
}

// ── search in a room ───────────────────────────────────────────────────────────────────────────────────────────

func (a *App) startSearch() tea.Cmd {
	if a.open == "" {
		return nil
	}
	r := a.room(a.open)
	title := "Search"
	if r != nil {
		title = "Search in " + render.OneLine(r.Title(a.me()))
	}
	in := textinput.New()
	in.Prompt = "/ "
	b := &listBox{kind: "search", title: title, in: &in, note: "Enter searches"}
	room, c := a.open, a.c
	b.onInput = func(string) tea.Cmd { b.items, b.note = nil, "Enter searches"; return nil }
	b.onEnter = func(q string) tea.Cmd {
		if q == "" {
			return nil
		}
		b.note = "searching…"
		return func() tea.Msg {
			items, err := c.Page(context.Background(), room, api.Latest, nil, q, pageSize)
			return searchFound{room, q, items, err}
		}
	}
	a.openList(b)
	return nil
}

func (a *App) gotSearch(m searchFound) {
	b := a.list
	if b == nil || b.kind != "search" || strings.TrimSpace(b.in.Value()) != m.q {
		return
	}
	switch {
	case api.IsStatus(m.err, 429):
		b.note = "Too many searches: wait a moment and press Enter again"
		return
	case m.err != nil:
		b.note = "Couldn't search: " + apiMessage(m.err)
		return
	}
	b.items, b.note = nil, ""
	for i := len(m.items) - 1; i >= 0; i-- { // newest first
		msg := m.items[i]
		who := "?"
		if u := msg.Expand.Author; u != nil {
			who = render.OneLine(u.Name)
		}
		when := render.Day(msg.Created) + " " + render.Clock(msg.Created)
		label := a.st.Muted.Render(when+" ") + a.st.Bold.Render(who) + " " + render.OneLine(msg.Text)
		room, id, created := m.room, msg.ID, msg.Created
		b.items = append(b.items, listItem{label: label, do: func() tea.Cmd { return a.goTo(room, id, created) }})
	}
	switch {
	case len(b.items) == 0:
		b.note = "Nothing found"
	case len(m.items) == pageSize:
		b.note = fmt.Sprintf("the newest %d", pageSize)
	}
}

// ── Mentions & replies ─────────────────────────────────────────────────────────────────────────────────────────

func (a *App) startInbox() tea.Cmd {
	if a.c.Token() == "" {
		return a.say("Log in (L) or sign up (S) for your mentions and replies")
	}
	a.openList(&listBox{kind: "inbox", title: "Mentions & replies", note: "loading…"})
	return tea.Batch(a.loadInbox(""), a.inboxSeen())
}

func (a *App) loadInbox(before string) tea.Cmd {
	c := a.c
	return func() tea.Msg {
		p, err := c.Inbox(context.Background(), before)
		return inboxLoaded{p, before != "", err}
	}
}

func (a *App) inboxSeen() tea.Cmd {
	a.unread.Inbox = 0
	c := a.c
	return func() tea.Msg {
		if err := c.InboxSeen(context.Background()); err != nil {
			return failed{"the inbox", err}
		}
		return nil
	}
}

func (a *App) gotInbox(m inboxLoaded) {
	b := a.list
	if b == nil || b.kind != "inbox" {
		return
	}
	if m.err != nil {
		b.note = "Couldn't load: " + apiMessage(m.err)
		return
	}
	if !m.append {
		b.items = nil
	}
	b.note = ""
	for _, it := range m.page.Items {
		who := render.OneLine(it.Actor.Name)
		where := ""
		if r := a.room(it.Room); r != nil {
			where = " in " + render.OneLine(r.Title(a.me()))
		}
		text := render.OneLine(it.Message.Text)
		if text == "" && it.Message.Files > 0 {
			text = fmt.Sprintf("[%d file(s)]", it.Message.Files)
		}
		var label string
		switch it.Kind {
		case "mention":
			label = "@ " + a.st.Bold.Render(who) + a.st.Muted.Render(where) + ": " + text
		case "reply":
			label = "↳ " + a.st.Bold.Render(who) + a.st.Muted.Render(" replied"+where) + ": " + text
		case "reaction":
			label = render.Clean(it.Emoji) + " " + a.st.Bold.Render(who) + a.st.Muted.Render(" reacted"+where) + ": " + text
		default:
			continue
		}
		if !it.Read {
			label = a.st.Accent.Render("● ") + label
		} else {
			label = "  " + label
		}
		room, id, created := it.Room, it.Message.ID, it.Message.Created
		b.items = append(b.items, listItem{label: label, dim: it.Read, do: func() tea.Cmd { return a.goTo(room, id, created) }})
	}
	if len(b.items) == 0 {
		b.note = "Nothing yet: mentions of you, replies to you and reactions to yours come here"
	}
	if m.page.More && len(m.page.Items) > 0 {
		next := m.page.Items[len(m.page.Items)-1].Cursor
		b.more = func() tea.Cmd { b.note = "loading…"; return a.loadInbox(next) }
	}
}

// ── going to a message ─────────────────────────────────────────────────────────────────────────────────────────

const around = 25

// goTo opens a room at one of its messages: selected if it's in the window, else a window around it.
func (a *App) goTo(room, id, created string) tea.Cmd {
	if a.room(room) == nil {
		return a.say("That room isn't in your list any more")
	}
	s := a.rs(room)
	for i := range s.items {
		if s.items[i].ID == id {
			cmd := a.openRoom(room, false)
			s.sel = i
			a.setFocus(focusMessages)
			return cmd
		}
	}
	s.loading = true // openRoom won't load the latest page
	cmd := a.openRoom(room, false)
	a.setFocus(focusMessages)
	c := a.c
	return tea.Batch(cmd, func() tea.Msg {
		ctx := context.Background()
		m, err := c.Message(ctx, id)
		if err != nil {
			return windowLoaded{room: room, err: err}
		}
		at := &api.Cursor{Created: m.Created, ID: m.ID}
		before, err := c.Page(ctx, room, api.Older, at, "", around)
		if err != nil {
			return windowLoaded{room: room, err: err}
		}
		after, err := c.Page(ctx, room, api.Newer, at, "", around)
		if err != nil {
			return windowLoaded{room: room, err: err}
		}
		items := append(append(before, m), after...)
		return windowLoaded{room, id, items, len(before) == around, len(after) == around, nil}
	})
}

func (a *App) gotWindow(m windowLoaded) tea.Cmd {
	s := a.rs(m.room)
	s.loading = false
	if m.err != nil {
		if api.IsStatus(m.err, 404) {
			return a.say("That message is gone")
		}
		return a.say("Couldn't go there: " + apiMessage(m.err))
	}
	s.items = append(m.items, s.pendingOnly()...)
	s.loaded, s.first, s.newer, s.newFrom, s.offset = true, !m.older, m.newer, "", 0
	s.sel = -1
	for i := range s.items {
		if s.items[i].ID == m.target {
			s.sel = i
		}
	}
	return a.markRead()
}

// pendingOnly is what is being sent (or failed) in the window: kept when the window is replaced.
func (s *roomState) pendingOnly() []api.Message {
	var out []api.Message
	for _, m := range s.items {
		if m.Pending || m.Failed != nil {
			out = append(out, m)
		}
	}
	return out
}

// toLatest replaces a window that doesn't reach the latest with the latest page.
func (a *App) toLatest() tea.Cmd {
	s := a.rs(a.open)
	if s.loading {
		return nil
	}
	s.loading, s.sel, s.offset = true, -1, 0
	return a.loadPage(a.open, api.Latest, nil, pageSize)
}

// loadNewer reads the next page down when the window doesn't reach the latest.
func (a *App) loadNewer() tea.Cmd {
	s := a.rs(a.open)
	if s.loading || len(s.items) == 0 {
		return nil
	}
	var last *api.Message
	for i := len(s.items) - 1; i >= 0; i-- {
		if !s.items[i].Pending && s.items[i].Failed == nil {
			last = &s.items[i]
			break
		}
	}
	if last == nil {
		return nil
	}
	s.loading = true
	room, c, at := a.open, a.c, api.Cursor{Created: last.Created, ID: last.ID}
	return func() tea.Msg {
		items, err := c.Page(context.Background(), room, api.Newer, &at, "", pageSize)
		if err != nil {
			return failed{"messages", err}
		}
		return pageLoaded{room, api.Newer, items}
	}
}

// ── hide and archive ───────────────────────────────────────────────────────────────────────────────────────────

func (a *App) loadHidden() tea.Cmd {
	if a.c.Token() == "" {
		return nil
	}
	c := a.c
	return func() tea.Msg {
		rows, err := c.HiddenRooms(context.Background())
		return hiddenLoaded{rows, err}
	}
}

// actionRoom is the room H and A act on: the highlighted one in the list, else the open one.
func (a *App) actionRoom() *api.Room {
	if a.focus == focusRooms {
		if rs := a.order(); a.cursor >= 0 && a.cursor < len(rs) {
			return rs[a.cursor]
		}
	}
	return a.room(a.open)
}

func (a *App) toggleHidden() tea.Cmd {
	r := a.actionRoom()
	if r == nil {
		return nil
	}
	if a.c.Token() == "" {
		return a.say("Log in to hide rooms")
	}
	c, id, row := a.c, r.ID, a.hidden[r.ID]
	return func() tea.Msg {
		if row != "" {
			err := c.Unhide(context.Background(), row)
			if api.IsStatus(err, 404) {
				err = nil
			}
			return hiddenChanged{id, "", err}
		}
		h, err := c.Hide(context.Background(), id)
		return hiddenChanged{id, h.ID, err}
	}
}

func (a *App) mayArchive(r *api.Room) bool {
	if r.IsDM() || a.me() == "" {
		return false
	}
	u := a.c.Me()
	return r.CreatedBy == a.me() || u != nil && u.Moderator && r.Visibility == "public"
}

func (a *App) toggleArchived() tea.Cmd {
	r := a.actionRoom()
	if r == nil {
		return nil
	}
	if !a.mayArchive(r) {
		return a.say("Only the room's creator (or a moderator, for a public room) can archive it")
	}
	verb := "Archive"
	if r.Archived {
		verb = "Restore"
	}
	c, id, to := a.c, r.ID, !r.Archived
	a.confirm = &confirmBox{
		text: fmt.Sprintf("%s %s for everyone? y/n", verb, render.OneLine(r.Title(a.me()))),
		yes: func() tea.Cmd {
			return func() tea.Msg {
				room, err := c.SetArchived(context.Background(), id, to)
				return archivedChanged{room, err}
			}
		},
	}
	return nil
}

func (a *App) moreMsg(msg tea.Msg) (tea.Cmd, bool) {
	switch m := msg.(type) {
	case usersFound:
		a.gotUsers(m)
	case dmOpened:
		return a.gotDM(m), true
	case searchFound:
		a.gotSearch(m)
	case inboxLoaded:
		a.gotInbox(m)
	case windowLoaded:
		return a.gotWindow(m), true
	case hiddenLoaded:
		if m.err != nil {
			return nil, true
		}
		a.hidden = map[string]string{}
		for _, r := range m.rows {
			a.hidden[r.Room] = r.ID
		}
	case hiddenChanged:
		if m.err != nil {
			return a.say("Couldn't: " + apiMessage(m.err)), true
		}
		name := m.room
		if r := a.room(m.room); r != nil {
			name = render.OneLine(r.Title(a.me()))
		}
		if m.row == "" {
			delete(a.hidden, m.room)
			a.keepCursor(m.room)
			return a.say("Shown again: " + name), true
		}
		a.hidden[m.room] = m.row
		a.keepCursor(m.room)
		return a.say("Hidden: " + name + " (H again shows it)"), true
	case archivedChanged:
		if m.err != nil {
			return a.say("Couldn't: " + apiMessage(m.err)), true
		}
		if r := a.room(m.room.ID); r != nil {
			*r = m.room
		}
		a.keepCursor(m.room.ID)
	default:
		return nil, false
	}
	return nil, true
}

// keepCursor keeps the list's highlight on a room that moved section.
func (a *App) keepCursor(id string) {
	for i, r := range a.order() {
		if r.ID == id {
			a.cursor = i
		}
	}
}

// ── Jump to (shared/vectors/jump.json) ─────────────────────────────────────────────────────────────────────────

func (a *App) jumpMatches() []*api.Room {
	me := a.me()
	byID := map[string]*api.Room{}
	var all []jump.Target
	for _, r := range a.order() {
		byID[r.ID] = r
		last := ""
		if r.IsDM() {
			last = r.LastMessageAt
		}
		away := r.Archived || a.hidden[r.ID] != ""
		all = append(all, jump.Room(r.ID, r.Title(me), r.Created, last, a.opened[r.ID], away, r.ID == a.open))
	}
	var out []*api.Room
	for _, t := range jump.Matches(all, a.jump.Value()) {
		out = append(out, byID[t.ID])
	}
	return out
}

func now() string { return time.Now().UTC().Format("2006-01-02 15:04:05.000Z") }
