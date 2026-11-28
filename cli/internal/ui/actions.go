package ui

import (
	"context"
	"slices"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/emoji"
	"github.com/border-radius/chirkle/cli/internal/render"
	"github.com/border-radius/chirkle/cli/internal/text"
)

// Taking part in a room (docs/CLI.md §4, milestone 2): reply, edit, delete and react on the selected message, and the
// composer's "@" and ":" lists.

type (
	// changed is a message as the server answered an edit, delete or reaction.
	changed struct {
		ms  []api.Message
		err error
		// what failed, for the status line
		what string
	}
	mentionable struct {
		room, query string
		users       []api.User
	}
)

// suggestion is one row of the list over the composer: what it shows and what replaces the token.
type suggestion struct {
	label, insert string
}

// reactPicker is the "+" box: a search by name, the quick reactions while it's empty.
type reactPicker struct {
	in  textinput.Model
	msg string // the message's id
	sel int
}

func (p *reactPicker) choices() []string {
	q := strings.TrimSpace(p.in.Value())
	if q == "" {
		return emoji.Quick
	}
	var out []string
	for _, n := range emoji.Find(q, 8) {
		out = append(out, n.Emoji)
	}
	return out
}

func (a *App) selected() *api.Message {
	if a.open == "" {
		return nil
	}
	s := a.rs(a.open)
	if s.sel < 0 || s.sel >= len(s.items) {
		return nil
	}
	return &s.items[s.sel]
}

func (a *App) mine(m *api.Message) bool { return m != nil && m.Author == a.me() && a.me() != "" }

func (a *App) canPostHere() bool {
	r := a.room(a.open)
	return r != nil && r.CanPost(a.me())
}

// startReply puts the reply bar over the composer and focuses it.
func (a *App) startReply(m *api.Message) tea.Cmd {
	if !a.canPostHere() || m.Deleted || m.Pending {
		return a.say("You can't reply here")
	}
	a.editing = nil
	cp := *m
	a.replyTo = &cp
	a.setFocus(focusComposer)
	return nil
}

// startEdit puts your message's text in the composer; Enter saves, Esc leaves it as it was.
func (a *App) startEdit(m *api.Message) tea.Cmd {
	if !a.mine(m) || m.Deleted || m.Pending || m.Failed != nil {
		return a.say("You can edit only your own messages")
	}
	if r := a.room(a.open); r != nil && r.Archived {
		return a.say("This room is archived")
	}
	if a.editing == nil {
		a.rs(a.open).draft = a.compose.Value()
	}
	cp := *m
	a.editing, a.replyTo = &cp, nil
	a.compose.SetValue(m.Text)
	a.compose.MoveToEnd()
	a.setFocus(focusComposer)
	return nil
}

func (a *App) stopEdit() {
	a.editing = nil
	a.compose.SetValue(a.rs(a.open).draft)
	a.compose.MoveToEnd()
}

// editLast is ↑ in an empty composer: your newest message in the room.
func (a *App) editLast() tea.Cmd {
	s := a.rs(a.open)
	for i := len(s.items) - 1; i >= 0; i-- {
		m := &s.items[i]
		if !a.mine(m) || m.Deleted || m.Failed != nil {
			continue
		}
		if m.Pending {
			return a.say("Your last message is still sending")
		}
		s.sel = i
		return a.startEdit(m)
	}
	return nil
}

func (a *App) saveEdit() tea.Cmd {
	m := *a.editing
	text := strings.TrimSpace(a.compose.Value())
	a.stopEdit()
	if text == "" {
		return a.askDelete(&m)
	}
	if text == m.Text {
		return nil
	}
	c := a.c
	return func() tea.Msg {
		out, err := c.Edit(context.Background(), m.ID, text)
		return changed{ms: []api.Message{out}, err: err, what: "edit"}
	}
}

// askDelete asks first: d, then y.
func (a *App) askDelete(m *api.Message) tea.Cmd {
	if m.Deleted || m.Pending {
		return nil
	}
	if !a.mine(m) && !a.moderator() {
		return a.say("You can delete only your own messages")
	}
	if m.Failed != nil { // never sent: just drop it
		s := a.rs(a.open)
		s.items = slices.DeleteFunc(s.items, func(x api.Message) bool { return x.ID == m.ID })
		s.sel = min(s.sel, len(s.items)-1)
		return nil
	}
	id := m.ID
	a.confirm = &confirmBox{text: "Delete this message? y yes · any other key no", yes: func() tea.Cmd {
		c := a.c
		return func() tea.Msg {
			out, err := c.Delete(context.Background(), id)
			return changed{ms: out, err: err, what: "delete"}
		}
	}}
	return nil
}

func (a *App) moderator() bool {
	u := a.c.Me()
	return u != nil && u.Moderator
}

func (a *App) startReact(m *api.Message) tea.Cmd {
	if a.c.Token() == "" {
		return a.say("Log in (L) or sign up (S) to react")
	}
	if m.Deleted || m.Pending || m.Failed != nil {
		return nil
	}
	if r := a.room(a.open); r != nil && r.Archived {
		return a.say("This room is archived")
	}
	in := textinput.New()
	in.Prompt = "React: "
	in.Placeholder = "name, or 1–8"
	in.Focus()
	a.react = &reactPicker{in: in, msg: m.ID}
	return nil
}

// toggleReaction puts emoji on the message, or takes it away when it's already yours.
func (a *App) toggleReaction(id, e string) tea.Cmd {
	on := true
	s := a.rs(a.open)
	for _, m := range s.items {
		if m.ID == id {
			for _, r := range m.Reactions {
				if r.Emoji == e && slices.Contains(r.Users, a.me()) {
					on = false
				}
			}
		}
	}
	c := a.c
	return func() tea.Msg {
		out, err := c.React(context.Background(), id, e, on)
		return changed{ms: []api.Message{out}, err: err, what: "reaction"}
	}
}

func (a *App) reactKey(k tea.KeyPressMsg) tea.Cmd {
	p := a.react
	choices := p.choices()
	key := k.String()
	switch key {
	case "esc":
		a.react = nil
		return nil
	case "up", "left", "ctrl+p":
		p.sel = max(0, p.sel-1)
		return nil
	case "down", "right", "ctrl+n", "tab":
		p.sel = min(len(choices)-1, p.sel+1)
		return nil
	case "enter":
		a.react = nil
		if p.sel < len(choices) {
			return a.toggleReaction(p.msg, choices[p.sel])
		}
		return nil
	}
	if len(key) == 1 && key[0] >= '1' && key[0] <= '8' && strings.TrimSpace(p.in.Value()) == "" ||
		len(key) == 1 && key[0] >= '1' && key[0] <= '8' && strings.HasSuffix(p.in.Value(), " ") {
		if i := int(key[0] - '1'); i < len(choices) {
			a.react = nil
			return a.toggleReaction(p.msg, choices[i])
		}
	}
	var cmd tea.Cmd
	p.in, cmd = p.in.Update(k)
	p.sel = 0
	return cmd
}

func (a *App) reactView() string {
	p := a.react
	var b strings.Builder
	b.WriteString(p.in.View() + "\n")
	for i, e := range p.choices() {
		cell := " " + string(rune('1'+i)) + " " + e + " "
		if i == p.sel {
			cell = a.st.Selected.Render("[" + cell[1:len(cell)-1] + "]")
		}
		b.WriteString(cell)
	}
	if len(p.choices()) == 0 {
		b.WriteString(a.st.Muted.Render("No emoji by that name"))
	}
	b.WriteString("\n" + a.st.Muted.Render("enter or 1–8 react (again: take it back) · esc close"))
	return b.String()
}

// goToQuote is Enter on a reply: select the original, if it is in the window. Backspace comes back.
func (a *App) goToQuote(m *api.Message) tea.Cmd {
	s := a.rs(a.open)
	for i := range s.items {
		if s.items[i].ID == m.ReplyToID {
			a.back = append(a.back, m.ID)
			s.sel = i
			return nil
		}
	}
	a.back = append(a.back, m.ID)
	return a.goTo(a.open, m.ReplyToID, "")
}

func (a *App) goBack() tea.Cmd {
	if len(a.back) == 0 {
		return nil
	}
	id := a.back[len(a.back)-1]
	a.back = a.back[:len(a.back)-1]
	s := a.rs(a.open)
	for i := range s.items {
		if s.items[i].ID == id {
			s.sel = i
		}
	}
	return nil
}

// ── the composer's lists ───────────────────────────────────────────────────────────────────────────────────────

// composed runs after each change of the composer's text: ":name:" becomes its emoji, and ":na" or "@an" at the end
// offers emoji or people. (The lists follow the end of the text: typing elsewhere in it offers none.)
func (a *App) composed() tea.Cmd {
	v := a.compose.Value()
	if a.compose.Line() != a.compose.LineCount()-1 || a.compose.Column() != len([]rune(lastLine(v))) {
		a.sugg = nil
		return nil
	}
	if out, ok := emoji.Whole(v); ok {
		a.compose.SetValue(out)
		a.compose.MoveToEnd()
		a.sugg = nil
		return nil
	}
	if start, q := emoji.Token(v); start >= 0 {
		a.sugg, a.suggSel, a.suggStart = nil, 0, start
		for _, n := range emoji.Find(q, 8) {
			a.sugg = append(a.sugg, suggestion{label: n.Emoji + "  :" + n.Name + ":", insert: n.Emoji})
		}
		return nil
	}
	if start, q := text.MentionToken(v); start >= 0 && a.open != "" && a.c.Token() != "" {
		if a.suggStart != start || a.suggQuery != "@"+q {
			a.suggStart, a.suggQuery = start, "@"+q
			room, c := a.open, a.c
			return func() tea.Msg {
				users, err := c.Mentionable(context.Background(), room, q)
				if err != nil {
					return nil
				}
				return mentionable{room, q, users}
			}
		}
		return nil
	}
	a.sugg, a.suggQuery = nil, ""
	return nil
}

func lastLine(s string) string {
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}

func (a *App) gotMentionable(m mentionable) {
	if m.room != a.open || a.suggQuery != "@"+m.query {
		return // typed on meanwhile
	}
	a.sugg, a.suggSel = nil, 0
	for _, u := range m.users {
		if u.Handle == "" {
			continue
		}
		a.sugg = append(a.sugg, suggestion{label: render.OneLine(u.Name) + "  @" + u.Handle, insert: "@" + u.Handle})
		if len(a.sugg) == 8 {
			break
		}
	}
}

// pick puts the chosen suggestion in place of the token being typed.
func (a *App) pick() {
	if a.suggSel >= len(a.sugg) {
		return
	}
	v := a.compose.Value()
	a.compose.SetValue(v[:a.suggStart] + a.sugg[a.suggSel].insert + " ")
	a.compose.MoveToEnd()
	a.sugg, a.suggQuery = nil, ""
}

func (a *App) suggestView(w int) []string {
	var out []string
	for i, s := range a.sugg {
		row := "  " + s.label
		if i == a.suggSel {
			row = a.st.Selected.Render("› " + s.label)
		}
		out = append(out, ansi.Truncate(row, w, "…"))
	}
	if len(out) > 0 {
		out = append(out, a.st.Muted.Render("  tab/enter pick · ↑↓ move · esc close"))
	}
	return out
}

// composerBar is the line over the composer while replying or editing.
func (a *App) composerBar(w int) string {
	switch {
	case a.editing != nil:
		return a.st.Accent.Render(ansi.Truncate("✎ Editing · enter save · esc cancel", w, "…"))
	case a.replyTo != nil:
		q := render.OneLine(a.replyTo.Text)
		if q == "" && len(a.replyTo.Files) > 0 {
			q = "[file]"
		}
		return a.st.Accent.Render(ansi.Truncate("↳ Replying to "+render.OneLine(a.replyTo.AuthorName())+": "+q+" · esc cancel", w, "…"))
	}
	return ""
}

// confirmBox is a yes/no question in the status line.
type confirmBox struct {
	text string
	yes  func() tea.Cmd
}

func (a *App) applyChanged(m changed) tea.Cmd {
	if m.err != nil {
		return a.say("The " + m.what + " didn't go through: " + render.OneLine(m.err.Error()))
	}
	for _, x := range m.ms {
		if x.ID == "" {
			continue
		}
		s := a.state[x.Room]
		if s == nil {
			continue
		}
		for i := range s.items {
			if s.items[i].ID == x.ID {
				s.items = upsert(s.items, x)
				break
			}
		}
	}
	return nil
}

func (a *App) myHandle() string {
	if u := a.c.Me(); u != nil {
		return u.Handle
	}
	return ""
}
