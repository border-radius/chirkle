package render

import (
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/contract"
	"github.com/border-radius/chirkle/cli/internal/text"
)

// Styles are the colours, made for the terminal's background.
type Styles struct {
	Name, Mine, Time, Muted, Link, Mention, MentionMe, Quote, Deleted, Error, Selected, Accent, Bold lipgloss.Style
}

// NewStyles picks colours that read on a dark or a light background (the web's Radix violet accent).
func NewStyles(dark bool) Styles {
	ld := lipgloss.LightDark(dark)
	accent := ld(lipgloss.Color("#5536d0"), lipgloss.Color("#baa7ff"))
	muted := ld(lipgloss.Color("#62626e"), lipgloss.Color("#8b8b96"))
	return Styles{
		Name:      lipgloss.NewStyle().Bold(true),
		Mine:      lipgloss.NewStyle().Bold(true).Foreground(accent),
		Time:      lipgloss.NewStyle().Foreground(muted),
		Muted:     lipgloss.NewStyle().Foreground(muted),
		Link:      lipgloss.NewStyle().Foreground(accent).Underline(true),
		Mention:   lipgloss.NewStyle().Foreground(accent),
		MentionMe: lipgloss.NewStyle().Foreground(accent).Bold(true).Reverse(true),
		Quote:     lipgloss.NewStyle().Foreground(muted).Italic(true),
		Deleted:   lipgloss.NewStyle().Foreground(muted).Italic(true),
		Error:     lipgloss.NewStyle().Foreground(lipgloss.Color("#e5484d")),
		Selected:  lipgloss.NewStyle().Foreground(accent).Bold(true),
		Accent:    lipgloss.NewStyle().Foreground(accent),
		Bold:      lipgloss.NewStyle().Bold(true),
	}
}

// Options say how to draw: for whom, how wide, and how to make file links.
type Options struct {
	Me         string
	MyHandle   string
	Width      int
	Hyperlinks bool // OSC 8, where the terminal supports it
	FileURL    func(message, file string) string
	Styles     Styles
	// Header: show the author and time (false for a message right after another by the same author).
	Header bool
}

var linkRe = regexp.MustCompile(`(?i)\b(?:https?://|www\.)[^\s<>"]+[^\s<>".,;:!?)\]'"]`)

// Link draws a URL, clickable with OSC 8 when enabled.
func Link(o Options, url, label string) string {
	s := o.Styles.Link.Render(label)
	if !o.Hyperlinks {
		return s
	}
	return ansi.SetHyperlink(url) + s + ansi.ResetHyperlink()
}

// Kind says how a file is shown, by its extension (shared/contract.json files).
func Kind(name string) string {
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(name)), ".")
	switch {
	case slices.Contains(contract.Files.Image, ext):
		return "image"
	case slices.Contains(contract.Files.Video, ext):
		return "video"
	case slices.Contains(contract.Files.Audio, ext):
		return "audio"
	}
	return "file"
}

// Links lists the message's links and files, in order: what `o` numbers for opening.
func Links(m api.Message, fileURL func(message, file string) string) []string {
	var out []string
	if m.Deleted {
		return nil
	}
	for _, u := range linkRe.FindAllString(m.Text, -1) {
		if strings.HasPrefix(strings.ToLower(u), "www.") {
			u = "https://" + u
		}
		out = append(out, u)
	}
	for _, f := range m.Files {
		out = append(out, fileURL(m.FileSource(f), f))
	}
	return out
}

// Text styles a message's text: links and mentions of me. Clean first.
func Text(o Options, m api.Message) string {
	text := Clean(m.Text)
	var b strings.Builder
	last := 0
	for _, loc := range linkRe.FindAllStringIndex(text, -1) {
		b.WriteString(mentions(o, m, text[last:loc[0]]))
		u := text[loc[0]:loc[1]]
		href := u
		if strings.HasPrefix(strings.ToLower(u), "www.") {
			href = "https://" + u
		}
		b.WriteString(Link(o, href, u))
		last = loc[1]
	}
	b.WriteString(mentions(o, m, text[last:]))
	return b.String()
}

// mentions marks the "@handle"s (shared/vectors/mentions.json); yours more, when the server says the message
// mentions you (its `mentions`, not the text: QA BUG-265).
func mentions(o Options, m api.Message, s string) string {
	var b strings.Builder
	mine := o.MyHandle != "" && slices.Contains(m.Mentions, o.Me)
	for _, p := range text.SplitMentions(s) {
		switch {
		case p.Handle == "":
			b.WriteString(p.Text)
		case mine && p.Handle == strings.ToLower(o.MyHandle):
			b.WriteString(o.Styles.MentionMe.Render(p.Text))
		default:
			b.WriteString(o.Styles.Mention.Render(p.Text))
		}
	}
	return b.String()
}

// Lines draws one message as terminal lines of at most o.Width cells:
//
//	Ada · 14:02 (edited)
//	↳ Bob: the quoted text…
//	The text, wrapped
//	[image] cat.png 640×480  https://host/api/files/messages/…/cat.png
//	👍 3  🎉 1
func Lines(o Options, m api.Message) []string {
	w := max(o.Width, 20)
	st := o.Styles
	var out []string
	wrap := func(s string) {
		out = append(out, strings.Split(ansi.Wrap(s, w, " -/"), "\n")...)
	}

	if o.Header {
		name := st.Name
		if m.Author == o.Me {
			name = st.Mine
		}
		h := name.Render(OneLine(m.AuthorName())) + st.Time.Render(" · "+Clock(m.Created))
		if m.EditedAt != "" && !m.Deleted {
			h += st.Muted.Render(" (edited)")
		}
		out = append(out, ansi.Truncate(h, w, "…"))
	}
	if m.Deleted {
		return append(out, st.Deleted.Render("Message deleted"))
	}
	if m.ForwardedFrom != "" {
		from := "someone"
		if m.Expand.ForwardedFrom != nil {
			from = OneLine(m.Expand.ForwardedFrom.Name)
		}
		out = append(out, st.Muted.Render(ansi.Truncate("↪ Forwarded from "+from, w, "…")))
	}
	if r := m.Expand.ReplyTo; r != nil {
		who := "someone"
		if r.Expand.Author != nil {
			who = OneLine(r.Expand.Author.Name)
		}
		q := OneLine(r.Text)
		switch {
		case r.Deleted:
			q = "message deleted"
		case q == "" && len(r.Files) > 0:
			q = fmt.Sprintf("[%d file(s)]", len(r.Files))
		}
		out = append(out, st.Quote.Render(ansi.Truncate("↳ "+who+": "+q, w, "…")))
	} else if m.ReplyToID != "" {
		out = append(out, st.Quote.Render("↳ reply"))
	}
	if strings.TrimSpace(m.Text) != "" {
		for _, para := range strings.Split(Text(o, m), "\n") {
			wrap(para)
		}
		if m.EditedAt != "" && !o.Header && len(out) > 0 {
			// A message under another's header says it was edited after its text.
			if l := out[len(out)-1]; ansi.StringWidth(l)+9 <= w {
				out[len(out)-1] = l + st.Muted.Render(" (edited)")
			} else {
				out = append(out, st.Muted.Render("(edited)"))
			}
		}
	}
	for _, f := range m.Files {
		name := OneLine(m.FileName(f))
		desc := st.Accent.Render("["+Kind(name)+"]") + " " + name
		if d, ok := m.FileDims[f]; ok && d[0] > 0 {
			desc += st.Muted.Render(fmt.Sprintf(" %d×%d", d[0], d[1]))
		}
		u := o.FileURL(m.FileSource(f), f)
		wrap(desc + "  " + Link(o, u, u))
	}
	for _, p := range m.Previews {
		title := OneLine(p.Title)
		if title == "" {
			continue
		}
		out = append(out, st.Muted.Render(ansi.Truncate("  ◦ "+host(p.URL)+" · "+title, w, "…")))
	}
	if len(m.Reactions) > 0 {
		parts := make([]string, 0, len(m.Reactions))
		for _, r := range m.Reactions {
			s := fmt.Sprintf("%s %d", OneLine(r.Emoji), len(r.Users))
			if slices.Contains(r.Users, o.Me) {
				s = st.Mine.Render(s)
			}
			parts = append(parts, s)
		}
		wrap(strings.Join(parts, "  "))
	}
	for _, p := range m.Local {
		name := OneLine(filepath.Base(p))
		out = append(out, st.Muted.Render(ansi.Truncate("["+Kind(name)+"] "+name, w, "…")))
	}
	if m.Pending {
		out = append(out, st.Muted.Render("sending…"))
	}
	if m.Failed != nil {
		out = append(out, st.Error.Render(ansi.Truncate("⚠ not sent: "+OneLine(m.Failed.Error())+" (r: retry)", w, "…")))
	}
	return out
}

func host(u string) string {
	s := u
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimPrefix(s, "www.")
}

// Clock is a message's local time, HH:MM.
func Clock(created string) string {
	t := api.ParseTime(created)
	if t.IsZero() {
		return ""
	}
	return t.Local().Format("15:04")
}

// Day is a message's local date, for day separators.
func Day(created string) string {
	t := api.ParseTime(created)
	if t.IsZero() {
		return ""
	}
	return t.Local().Format("Monday, 2 January 2006")
}
