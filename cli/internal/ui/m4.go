package ui

// Milestone 4 (docs/CLI.md §8): files from disk, terminal notifications, banning, switching accounts.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/contract"
	"github.com/border-radius/chirkle/cli/internal/render"
)

// ── files from disk ────────────────────────────────────────────────────────────────────────────────────────────

func (a *App) attachBar(w int) string {
	if len(a.attach) == 0 {
		return ""
	}
	var names []string
	for _, p := range a.attach {
		names = append(names, render.OneLine(filepath.Base(p)))
	}
	return a.st.Accent.Render(ansi.Truncate("📎 "+strings.Join(names, ", ")+" · ctrl+o files", w, "…"))
}

// startAttach asks for a file's path: Tab completes it, Enter adds it; the files added are listed, Enter on one
// (with nothing typed) takes it off.
func (a *App) startAttach() tea.Cmd {
	if r := a.room(a.open); r == nil || !r.CanPost(a.me()) {
		return a.say("You can't post here")
	}
	in := textinput.New()
	in.Prompt = "File: "
	in.Placeholder = "a path; tab completes"
	in.CharLimit = 4096
	b := &listBox{kind: "attach", title: "Send files", in: &in, typed: true}
	a.attachItems(b)
	b.onEnter = func(p string) tea.Cmd {
		if p == "" {
			a.list = nil
			return nil
		}
		p = expandPath(p)
		if err := api.CheckFiles(append(slices.Clone(a.attach), p)); err != nil {
			b.note = render.OneLine(err.Error())
			return nil
		}
		if !slices.Contains(a.attach, p) {
			a.attach = append(a.attach, p)
		}
		b.in.SetValue("")
		a.attachItems(b)
		return nil
	}
	b.onTab = func(v string) string { return completePath(v) }
	a.openList(b)
	return nil
}

func (a *App) attachItems(b *listBox) {
	b.items, b.note = nil, fmt.Sprintf("Enter adds · up to %d files, %d MB each · esc done", contract.Limits.Attachments, contract.Limits.AttachmentBytes>>20)
	for _, p := range a.attach {
		p := p
		b.items = append(b.items, listItem{label: "📎 " + render.OneLine(p) + a.st.Muted.Render("  enter: take off"), do: func() tea.Cmd {
			a.attach = slices.DeleteFunc(a.attach, func(x string) bool { return x == p })
			a.attachItems(b)
			return nil
		}, keep: true})
	}
	b.sel = min(b.sel, max(0, len(b.items)-1))
}

func expandPath(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[1:])
		}
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

// completePath extends a path as far as the names it could be agree; a directory gets its "/".
func completePath(v string) string {
	full := expandPath(v)
	if v == "" {
		return v
	}
	if strings.HasSuffix(v, string(filepath.Separator)) {
		full += string(filepath.Separator)
	}
	dir, part := filepath.Split(full)
	ents, err := os.ReadDir(dir)
	if err != nil {
		return v
	}
	var names []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), part) && (strings.HasPrefix(part, ".") || !strings.HasPrefix(e.Name(), ".")) {
			n := e.Name()
			if e.IsDir() {
				n += string(filepath.Separator)
			}
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return v
	}
	common := names[0]
	for _, n := range names[1:] {
		for !strings.HasPrefix(n, common) {
			common = common[:len(common)-1]
		}
	}
	if len(common) <= len(part) {
		return v
	}
	return v + common[len(part):]
}

// pastedFile is a pasted text that is one existing file's path (a file dropped on the terminal), or "".
func pastedFile(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 1 && (s[0] == '\'' && s[len(s)-1] == '\'' || s[0] == '"' && s[len(s)-1] == '"') {
		s = s[1 : len(s)-1]
	} else {
		s = strings.NewReplacer(`\ `, " ", `\(`, "(", `\)`, ")", `\'`, "'").Replace(s)
	}
	s = strings.TrimPrefix(s, "file://")
	if s == "" || strings.ContainsAny(s, "\n\r") || !filepath.IsAbs(s) && !strings.HasPrefix(s, "~/") {
		return ""
	}
	p := expandPath(s)
	if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
		return p
	}
	return ""
}

// ── notifications ──────────────────────────────────────────────────────────────────────────────────────────────

// notifyMode is how to tell the terminal: CHIRKLE_NOTIFY=off|bell|osc9|osc777, else what the terminal is known for.
func notifyMode() string {
	switch m := os.Getenv("CHIRKLE_NOTIFY"); m {
	case "off", "bell", "osc9", "osc777":
		return m
	}
	switch {
	case os.Getenv("VTE_VERSION") != "", strings.HasPrefix(os.Getenv("TERM"), "foot"), strings.Contains(os.Getenv("TERM"), "rxvt"):
		return "osc777"
	}
	switch os.Getenv("TERM_PROGRAM") {
	case "iTerm.app", "WezTerm", "ghostty", "WarpTerminal":
		return "osc9"
	}
	if os.Getenv("TERM") == "xterm-ghostty" || os.Getenv("KITTY_WINDOW_ID") != "" {
		return "osc9"
	}
	return "bell"
}

// notifySeq is the escape sequence telling the terminal; inside tmux, passed through to the terminal outside.
func notifySeq(mode, title, body string) string {
	clean := func(s string, n int) string {
		s = strings.ReplaceAll(render.OneLine(s), ";", ",")
		return ansi.Truncate(s, n, "…")
	}
	var seq string
	switch mode {
	case "bell":
		return "\a"
	case "osc9":
		seq = "\x1b]9;" + clean(title+": "+body, 200) + "\a"
	case "osc777":
		seq = "\x1b]777;notify;" + clean(title, 60) + ";" + clean(body, 200) + "\a"
	default:
		return ""
	}
	if os.Getenv("TMUX") != "" {
		seq = "\x1bPtmux;" + strings.ReplaceAll(seq, "\x1b", "\x1b\x1b") + "\x1b\\"
	}
	return seq
}

// notify tells the terminal about a message for you (a DM, a mention or a reply to yours) that isn't on screen.
func (a *App) notify(m api.Message) tea.Cmd {
	if a.notifyMode == "off" || a.c.Token() == "" || m.Author == a.me() || m.Deleted {
		return nil
	}
	r := a.room(m.Room)
	if r == nil {
		return nil
	}

	switch {
	case r.IsDM():

	case slices.Contains(m.Mentions, a.me()):

	case m.Expand.ReplyTo != nil && m.Expand.ReplyTo.Author == a.me():

	default:
		return nil
	}
	s := a.state[m.Room]
	if a.focused && m.Room == a.open && s != nil && s.offset == 0 && !s.newer {
		return nil // being read
	}
	who := render.OneLine(m.AuthorName())
	title := who
	if !r.IsDM() {
		title = who + " in " + render.OneLine(r.Title(a.me()))
	}
	body := m.Text
	if body == "" && len(m.Files) > 0 {
		body = "[file]"
	}
	if seq := notifySeq(a.notifyMode, title, body); seq != "" {
		return tea.Raw(seq)
	}
	return nil
}

func (a *App) toggleNotify() tea.Cmd {
	if a.notifyMode == "off" {
		a.notifyMode = notifyMode()
		if a.notifyMode == "off" {
			a.notifyMode = "bell"
		}
		return a.say("Notifications on (" + a.notifyMode + ") for DMs, mentions and replies")
	}
	a.notifyMode = "off"
	return a.say("Notifications off")
}

// ── moderators: banning ────────────────────────────────────────────────────────────────────────────────────────

type banned struct {
	name string
	ban  bool
	err  error
}

func (a *App) askBan(m *api.Message, ban bool) tea.Cmd {
	u := a.c.Me()
	if u == nil || !u.Moderator {
		return a.say("Only moderators can ban people")
	}
	au := m.Expand.Author
	if au == nil || m.Author == a.me() || au.Kind == "deleted" || au.ID != m.Author {
		return a.say("Not someone who can be banned")
	}
	name, id, c := render.OneLine(au.Name), au.ID, a.c
	text := "Ban " + name + "? They can't sign in until unbanned. y/n"
	if !ban {
		text = "Unban " + name + "? y/n"
	}
	a.confirm = &confirmBox{text: text, yes: func() tea.Cmd {
		return func() tea.Msg { return banned{name, ban, c.Ban(context.Background(), id, ban)} }
	}}
	return nil
}

// ── accounts ───────────────────────────────────────────────────────────────────────────────────────────────────

type (
	switched struct {
		i    int
		c    *api.Client
		site api.Site
		u    *api.User
		err  error
	}
	serverFound struct {
		c    *api.Client
		site api.Site
		err  error
	}
)

func (a *App) startAccounts() tea.Cmd {
	b := &listBox{kind: "accounts", title: "Accounts"}
	for i, acct := range a.cfg.Accounts {
		i := i
		label := render.OneLine(acct.User.Name) + a.st.Muted.Render(" · "+strings.TrimPrefix(strings.TrimPrefix(acct.Server, "https://"), "http://"))
		if a.c.Token() != "" && acct.Server == a.c.Base && acct.User.ID == a.me() {
			label += a.st.Accent.Render("  (this one)")
			b.items = append(b.items, listItem{label: label})
			continue
		}
		b.items = append(b.items, listItem{label: label, do: func() tea.Cmd { return a.switchAccount(i) }})
	}
	here := strings.TrimPrefix(strings.TrimPrefix(a.c.Base, "https://"), "http://")
	b.items = append(b.items,
		listItem{label: "+ Log in to another account on " + here, do: func() tea.Cmd { return a.signIn(a.c.Base, a.site, modeLogin) }},
		listItem{label: "+ Sign up on " + here, do: func() tea.Cmd { return a.signIn(a.c.Base, a.site, modeSignup) }},
		listItem{label: "+ Another server…", do: a.askServer},
	)
	a.openList(b)
	return nil
}

func (a *App) askServer() tea.Cmd {
	in := textinput.New()
	in.Prompt = "Server: "
	in.Placeholder = "chat.example.com"
	b := &listBox{kind: "server", title: "Another server", in: &in, note: "Enter connects"}
	b.onEnter = func(s string) tea.Cmd {
		if s == "" {
			return nil
		}
		b.note = "connecting…"
		return func() tea.Msg {
			c, err := api.New(s)
			if err != nil {
				return serverFound{err: err}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			site, err := c.Site(ctx)
			return serverFound{c, site, err}
		}
	}
	a.openList(b)
	return nil
}

func (a *App) switchAccount(i int) tea.Cmd {
	acct := a.cfg.Accounts[i]
	return func() tea.Msg {
		c, err := api.New(acct.Server)
		if err != nil {
			return switched{i: i, err: err}
		}
		c.SetSession(acct.Token, &acct.User)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		site, err := c.Site(ctx)
		if err != nil {
			return switched{i: i, err: err}
		}
		u, err := c.Refresh(ctx)
		return switched{i, c, site, u, err}
	}
}

// reset leaves this account (or server) for another: what was being typed is kept, and everything loaded goes.
func (a *App) reset(c *api.Client, site api.Site) {
	if a.open != "" {
		if a.editing != nil {
			a.stopEdit()
		}
		a.keepDraft()
	}
	_ = a.drafts.Save()
	if a.stopRT != nil {
		a.stopRT()
		a.stopRT = nil
	}
	a.c, a.site = c, site
	a.events, a.conn = make(chan api.Event, 256), make(chan api.Status, 8)
	a.gen++
	a.rooms, a.unread, a.state, a.open, a.cursor = nil, api.Unread{}, map[string]*roomState{}, "", 0
	a.hidden, a.opened = map[string]string{}, map[string]string{}
	a.list, a.replyTo, a.editing, a.back, a.sugg, a.attach, a.confirm = nil, nil, nil, nil, nil, nil, nil
	a.started, a.online, a.guest = false, false, false
	a.compose.Reset()
	a.setFocus(focusRooms)
}

// signIn brings the login or signup form up for a server, leaving the account in use.
func (a *App) signIn(base string, site api.Site, mode authMode) tea.Cmd {
	c, err := api.New(base)
	if err != nil {
		return a.say(err.Error())
	}
	a.reset(c, site)
	f := newAuthForm(site, mode)
	a.auth = &f
	return nil
}

func (a *App) m4Msg(msg tea.Msg) (tea.Cmd, bool) {
	switch m := msg.(type) {
	case tea.FocusMsg:
		a.focused = true
		return a.markRead(), true
	case tea.BlurMsg:
		a.focused = false
	case banned:
		switch {
		case m.err != nil:
			return a.say("Couldn't: " + apiMessage(m.err)), true
		case m.ban:
			return a.say(m.name + " is banned"), true
		default:
			return a.say(m.name + " is unbanned"), true
		}
	case switched:
		if m.err != nil {
			if api.IsStatus(m.err, 401) || api.IsStatus(m.err, 403) || api.IsStatus(m.err, 404) {
				name := a.cfg.Accounts[m.i].User.Name
				a.cfg.Current = m.i
				a.cfg.Remove()
				_ = a.cfg.Save()
				return a.say("That session is over (" + render.OneLine(name) + "): log in again"), true
			}
			return a.say("Couldn't switch: " + apiMessage(m.err)), true
		}
		a.cfg.Current = m.i
		acct := &a.cfg.Accounts[m.i]
		acct.Token, acct.User = m.c.Token(), *m.u
		_ = a.cfg.Save()
		a.reset(m.c, m.site)
		return tea.Batch(a.start(), a.say("Now "+render.OneLine(m.u.Name)+" on "+render.OneLine(m.site.Title))), true
	case serverFound:
		if m.err != nil {
			if a.list != nil && a.list.kind == "server" {
				a.list.note = "Not a Chirkle server: " + apiMessage(m.err)
			}
			return nil, true
		}
		for i, acct := range a.cfg.Accounts {
			if acct.Server == m.c.Base {
				return a.switchAccount(i), true // logged in there already
			}
		}
		return a.signIn(m.c.Base, m.site, modeLogin), true
	default:
		return nil, false
	}
	return nil, true
}
