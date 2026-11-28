// chirk is the Chirkle console client (docs/CLI.md): read rooms and take part from a terminal, and make an
// account there too. One static binary from the release page.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"golang.org/x/term"

	"github.com/border-radius/chirkle/cli/internal/api"
	"github.com/border-radius/chirkle/cli/internal/config"
	"github.com/border-radius/chirkle/cli/internal/ui"
)

var version = "dev" // -ldflags "-X main.version=…"

const usage = `chirk: the Chirkle console client

  chirk [server]                     open the client (the saved account, or log in / sign up / read as a guest)
  chirk login  [--server S] [--email E] [--password-stdin]
  chirk signup [--server S] [--name N] [--email E] [--invite CODE] [--password-stdin]
  chirk join <invite link>           join a private room by its invite link (logged in on that server)
  chirk reset-password <link>        set a new password from the emailed link [--password-stdin]
  chirk export [-o FILE]             download your data (asks the server to make it, then waits)
  chirk delete-account --messages keep|delete [--password-stdin]
  chirk update [--check]             replace this binary with the latest release (checksum-verified)
  chirk logout
  chirk version

The password is read from the terminal without echo, or from stdin with --password-stdin.
Sessions are kept in %s (mode 0600).
`

func main() {
	api.Version = version
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "chirk:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		switch args[0] {
		case "login", "signup", "logout", "version", "help", "join", "reset-password", "export", "delete-account", "update":
			cmd, args = args[0], args[1:]
		}
	}
	switch cmd {
	case "version":
		fmt.Println("chirk", version)
		return nil
	case "help":
		p, _ := config.Path()
		fmt.Printf(usage, p)
		return nil
	case "logout":
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		a := cfg.CurrentAccount()
		if a == nil {
			fmt.Println("Not logged in.")
			return nil
		}
		fmt.Printf("Logged out of %s as %s.\n", a.Server, a.User.Name)
		drafts := config.LoadDrafts()
		drafts.Forget(a.Server, a.User.ID)
		_ = drafts.Save()
		cfg.Remove()
		return cfg.Save()
	case "login", "signup":
		return authCommand(cmd, args)
	case "join":
		return joinCommand(args)
	case "reset-password":
		return resetCommand(args)
	case "export":
		return exportCommand(args)
	case "delete-account":
		return deleteAccountCommand(args)
	case "update":
		return updateCommand(args)
	}

	fs := flag.NewFlagSet("chirk", flag.ContinueOnError)
	fs.Usage = func() { p, _ := config.Path(); fmt.Fprintf(fs.Output(), usage, p) }
	if err := fs.Parse(args); err != nil {
		return err
	}
	return tui(fs.Arg(0))
}

// tui opens the client on the saved account, or on a server as a guest with the login form up.
func tui(server string) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	acct := cfg.CurrentAccount()
	if server != "" {
		base, err := api.NormalizeBase(server)
		if err != nil {
			return err
		}
		acct = nil
		for i, a := range cfg.Accounts {
			if a.Server == base {
				cfg.Current, acct = i, &cfg.Accounts[i]
			}
		}
		server = base
	} else if acct != nil {
		server = acct.Server
	} else {
		if server, err = prompt("Server address (e.g. chat.example.com): "); err != nil {
			return err
		}
	}
	c, err := api.New(server)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	site, err := c.Site(ctx)
	if err != nil {
		return fmt.Errorf("%s doesn't answer as a Chirkle server: %w", c.Base, err)
	}
	if acct != nil {
		c.SetSession(acct.Token, &acct.User)
		u, err := c.Refresh(ctx)
		switch {
		case err == nil:
			acct.Token, acct.User = c.Token(), *u
			_ = cfg.Save()
		case api.IsStatus(err, 401) || api.IsStatus(err, 403) || api.IsStatus(err, 404):
			c.SetSession("", nil) // the session is over: the login form comes up
			cfg.Remove()
			_ = cfg.Save()
		default:
			return fmt.Errorf("couldn't renew the session: %w", err)
		}
	}
	_, err = tea.NewProgram(ui.New(c, cfg, site)).Run()
	return err
}

func authCommand(cmd string, args []string) error {
	fs := flag.NewFlagSet("chirk "+cmd, flag.ContinueOnError)
	server := fs.String("server", "", "server address")
	email := fs.String("email", "", "email")
	name := fs.String("name", "", "display name (signup)")
	invite := fs.String("invite", "", "invite code, for an invite-only server (signup)")
	stdin := fs.Bool("password-stdin", false, "read the password from stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	var err error
	ask := func(v *string, label string) {
		if err == nil && *v == "" {
			*v, err = prompt(label)
		}
	}
	ask(server, "Server address: ")
	c, e := api.New(*server)
	if e != nil {
		return e
	}
	ctx := context.Background()
	site, e := c.Site(ctx)
	if e != nil {
		return fmt.Errorf("%s doesn't answer as a Chirkle server: %w", c.Base, e)
	}
	if cmd == "signup" {
		ask(name, "Name: ")
	}
	ask(email, "Email: ")
	if cmd == "signup" && site.InviteOnly {
		ask(invite, "Invite code (this server is invite-only): ")
	}
	if err != nil {
		return err
	}
	password, err := readPassword(*stdin, cmd == "signup")
	if err != nil {
		return err
	}
	var u *api.User
	if cmd == "signup" {
		u, err = c.SignUp(ctx, api.SignUpInput{Name: *name, Email: *email, Password: password, InviteCode: *invite})
	} else {
		u, err = c.LogIn(ctx, *email, password)
	}
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	cfg.Put(config.Account{Server: c.Base, Token: c.Token(), User: *u})
	if err := cfg.Save(); err != nil {
		return err
	}
	verb := "Logged in"
	if cmd == "signup" {
		verb = "Signed up"
	}
	fmt.Printf("%s to %s as %s. Run chirk to open it.\n", verb, site.Title, u.Name)
	return nil
}

var stdinReader = bufio.NewReader(os.Stdin)

func prompt(label string) (string, error) {
	fmt.Fprint(os.Stderr, label)
	s, err := stdinReader.ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && s != "") {
		return "", err
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("nothing entered")
	}
	return s, nil
}

func readPassword(fromStdin, confirm bool) (string, error) {
	if fromStdin || !term.IsTerminal(int(os.Stdin.Fd())) {
		s, err := stdinReader.ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", err
		}
		return strings.TrimRight(s, "\r\n"), nil
	}
	read := func(label string) (string, error) {
		fmt.Fprint(os.Stderr, label)
		b, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Fprintln(os.Stderr)
		return string(b), err
	}
	p, err := read("Password: ")
	if err != nil || !confirm {
		return p, err
	}
	again, err := read("Again: ")
	if err != nil {
		return "", err
	}
	if again != p {
		return "", errors.New("the passwords differ")
	}
	return p, nil
}

// linkClient takes a link's server (or the saved one, or asks), and the saved session there if any.
func linkClient(link, segment string) (*api.Client, *config.Account, string, error) {
	server, token, err := api.LinkToken(link, segment)
	if err != nil {
		return nil, nil, "", err
	}
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, "", err
	}
	if server == "" {
		if a := cfg.CurrentAccount(); a != nil {
			server = a.Server
		} else if server, err = prompt("Server address: "); err != nil {
			return nil, nil, "", err
		}
	}
	c, err := api.New(server)
	if err != nil {
		return nil, nil, "", err
	}
	var acct *config.Account
	for i := range cfg.Accounts {
		if cfg.Accounts[i].Server == c.Base {
			acct = &cfg.Accounts[i]
		}
	}
	return c, acct, token, nil
}

var errBadInvite = errors.New("this invite link doesn't work (expired, revoked or not for you)")

func joinCommand(args []string) error {
	if len(args) != 1 {
		return errors.New("usage: chirk join <invite link>")
	}
	c, acct, token, err := linkClient(args[0], "invite")
	if err != nil {
		return err
	}
	ctx := context.Background()
	if acct == nil {
		return fmt.Errorf("log in to %s first (chirk login --server %s), then run this again", c.Base, c.Base)
	}
	c.SetSession(acct.Token, &acct.User)
	inv, err := c.InviteInfo(ctx, token)
	if api.IsStatus(err, 404) {
		return errBadInvite
	} else if err != nil {
		return err
	}
	if inv.Member {
		fmt.Printf("You're already in %s.\n", inv.Room.Name)
		return nil
	}
	if _, err := c.Join(ctx, token); err != nil {
		if api.IsStatus(err, 404) {
			return errBadInvite
		}
		return err
	}
	fmt.Printf("Joined %s. Run chirk to open it.\n", inv.Room.Name)
	return nil
}

func resetCommand(args []string) error {
	fs := flag.NewFlagSet("chirk reset-password", flag.ContinueOnError)
	stdin := fs.Bool("password-stdin", false, "read the new password from stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return errors.New("usage: chirk reset-password [--password-stdin] <link from the email>")
	}
	c, _, token, err := linkClient(fs.Arg(0), "reset-password")
	if err != nil {
		return err
	}
	password, err := readPassword(*stdin, true)
	if err != nil {
		return err
	}
	if n := len(password); n < 8 || n > 71 {
		return errors.New("the password needs 8 characters to 71 bytes")
	}
	if err := c.ConfirmPasswordReset(context.Background(), token, password); err != nil {
		if api.IsStatus(err, 400) {
			return fmt.Errorf("the link has expired or was used: ask for a new one (%w)", err)
		}
		return err
	}
	fmt.Println("Password set. Log in with it: chirk login --server", c.Base)
	return nil
}
