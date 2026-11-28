package ui

import (
	"context"
	"errors"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/render"
)

// The login / signup / forgot-password form (docs/CLI.md §3): no browser needed to get an account.

type authMode int

const (
	modeLogin authMode = iota
	modeSignup
	modeForgot
)

var modeNames = []string{"Log in", "Sign up", "Forgot password"}

type field struct {
	key   string // the server's field name, for its errors
	label string
	in    textinput.Model
}

type authForm struct {
	mode   authMode
	site   api.Site
	fields []field
	focus  int
	errs   map[string]string
	note   string // a line under the form: the server's message, or what happened
	busy   bool
}

func newInput(password bool) textinput.Model {
	in := textinput.New()
	in.Prompt = ""
	in.CharLimit = 256
	if password {
		in.EchoMode = textinput.EchoPassword
		in.EchoCharacter = '•'
	}
	return in
}

func newAuthForm(site api.Site, mode authMode) authForm {
	f := authForm{mode: mode, site: site, errs: map[string]string{}}
	add := func(key, label string, password bool) {
		f.fields = append(f.fields, field{key: key, label: label, in: newInput(password)})
	}
	switch mode {
	case modeLogin:
		add("identity", "Email", false)
		add("password", "Password", true)
	case modeSignup:
		add("name", "Name", false)
		add("email", "Email", false)
		add("password", "Password", true)
		add("passwordConfirm", "Confirm", true)
		if site.InviteOnly {
			add("invite_code", "Invite code", false)
		}
	case modeForgot:
		add("email", "Email", false)
	}
	f.fields[0].in.Focus()
	return f
}

func (f *authForm) value(key string) string {
	for _, fl := range f.fields {
		if fl.key == key {
			return fl.in.Value()
		}
	}
	return ""
}

func (f *authForm) setFocus(i int) {
	f.fields[f.focus].in.Blur()
	f.focus = (i + len(f.fields)) % len(f.fields)
	f.fields[f.focus].in.Focus()
}

// authDone is a login or signup that worked; authFailed one the server refused.
type (
	authDone   struct{ user *api.User }
	authFailed struct{ err error }
	resetSent  struct{ email string }
)

func (f *authForm) submit(c *api.Client) tea.Cmd {
	f.errs = map[string]string{}
	f.note = ""
	switch f.mode {
	case modeLogin:
		email, pw := f.value("identity"), f.value("password")
		return func() tea.Msg {
			u, err := c.LogIn(context.Background(), email, pw)
			if err != nil {
				return authFailed{err}
			}
			return authDone{u}
		}
	case modeSignup:
		in := api.SignUpInput{Name: f.value("name"), Email: f.value("email"), Password: f.value("password"), InviteCode: f.value("invite_code")}
		bad := in.Validate()
		if f.value("passwordConfirm") != in.Password {
			bad["passwordConfirm"] = "The passwords differ"
		}
		if f.site.InviteOnly && strings.TrimSpace(in.InviteCode) == "" {
			bad["invite_code"] = "Signups need an invite code here"
		}
		if len(bad) > 0 {
			f.errs = bad
			return nil
		}
		return func() tea.Msg {
			u, err := c.SignUp(context.Background(), in)
			if err != nil {
				return authFailed{err}
			}
			return authDone{u}
		}
	case modeForgot:
		email := f.value("email")
		return func() tea.Msg {
			if err := c.RequestPasswordReset(context.Background(), email); err != nil {
				return authFailed{err}
			}
			return resetSent{email}
		}
	}
	return nil
}

// update handles a key; submit is true when Enter on the last field asks to send.
func (f *authForm) update(msg tea.Msg, c *api.Client) tea.Cmd {
	if k, ok := msg.(tea.KeyPressMsg); ok && !f.busy {
		switch k.String() {
		case "tab", "down":
			f.setFocus(f.focus + 1)
			return nil
		case "shift+tab", "up":
			f.setFocus(f.focus - 1)
			return nil
		case "ctrl+right", "ctrl+left", "f2":
			modes := []authMode{modeLogin, modeSignup}
			if f.site.PasswordReset {
				modes = append(modes, modeForgot)
			}
			next := 0
			for i, m := range modes {
				if m == f.mode {
					next = i + 1
					if k.String() == "ctrl+left" {
						next = i - 1 + len(modes)
					}
				}
			}
			*f = newAuthForm(f.site, modes[next%len(modes)])
			return nil
		case "enter":
			if f.focus < len(f.fields)-1 {
				f.setFocus(f.focus + 1)
				return nil
			}
			cmd := f.submit(c)
			f.busy = cmd != nil
			return cmd
		}
	}
	var cmd tea.Cmd
	f.fields[f.focus].in, cmd = f.fields[f.focus].in.Update(msg)
	return cmd
}

func (f *authForm) failed(err error) {
	f.busy = false
	var e *api.Error
	if errors.As(err, &e) {
		for k, v := range e.Fields {
			if k == "identity" || k == "email" && f.mode == modeLogin {
				k = "identity"
			}
			f.errs[k] = v
		}
		f.note = e.Message
		if e.Status == 400 && f.mode == modeLogin {
			f.note = "Wrong email or password"
		}
	} else {
		f.note = err.Error()
	}
	if errors.Is(err, api.ErrSignupLoginFailed) {
		f.note = api.ErrSignupLoginFailed.Error()
	}
}

func (f *authForm) view(st render.Styles, server string, width int) string {
	var b strings.Builder
	b.WriteString(st.Bold.Render(render.OneLine(f.site.Title)) + st.Muted.Render("  "+server) + "\n\n")
	for i, name := range modeNames {
		if authMode(i) == modeForgot && !f.site.PasswordReset {
			continue
		}
		if authMode(i) == f.mode {
			b.WriteString(st.Selected.Render("[" + name + "]"))
		} else {
			b.WriteString(st.Muted.Render(" " + name + " "))
		}
		b.WriteString("  ")
	}
	b.WriteString("\n\n")
	for i, fl := range f.fields {
		mark := "  "
		if i == f.focus {
			mark = st.Accent.Render("› ")
		}
		in := fl.in
		in.SetWidth(max(10, min(width-18, 50)))
		b.WriteString(mark + st.Muted.Render(padRight(fl.label, 12)) + in.View() + "\n")
		if e := f.errs[fl.key]; e != "" {
			b.WriteString("  " + padRight("", 12) + st.Error.Render(render.OneLine(e)) + "\n")
		}
	}
	b.WriteString("\n")
	switch {
	case f.busy:
		b.WriteString(st.Muted.Render("…") + "\n")
	case f.note != "":
		b.WriteString(st.Error.Render(render.OneLine(f.note)) + "\n")
	}
	if f.mode == modeSignup && f.site.InviteOnly {
		b.WriteString(st.Muted.Render("This server is invite-only: ask its admin for the code.") + "\n")
	}
	b.WriteString("\n" + st.Muted.Render("enter next/submit · tab move · ctrl+→ switch form · esc read as a guest · ctrl+c quit"))
	return b.String()
}

func padRight(s string, n int) string {
	if len([]rune(s)) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len([]rune(s)))
}
