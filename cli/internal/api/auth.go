package api

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/border-radius/chirkle/cli/internal/contract"
)

type authAnswer struct {
	Token  string `json:"token"`
	Record User   `json:"record"`
}

// Site reads the site record: title and signup policy. A server without one has the defaults.
func (c *Client) Site(ctx context.Context) (Site, error) {
	var out struct {
		Items []Site `json:"items"`
	}
	q := url.Values{"page": {"1"}, "perPage": {"1"}, "sort": {"created"}, "skipTotal": {"1"},
		"fields": {"id,title,logo,invite_only,password_reset"}}
	if err := c.do(ctx, "GET", "/api/collections/site/records", q, nil, &out); err != nil {
		return Site{}, err
	}
	if len(out.Items) == 0 {
		return Site{Title: "Chirkle"}, nil
	}
	s := out.Items[0]
	if s.Title == "" {
		s.Title = "Chirkle"
	}
	return s, nil
}

// LogIn signs in with an email and password and keeps the session.
func (c *Client) LogIn(ctx context.Context, email, password string) (*User, error) {
	var a authAnswer
	body := map[string]string{"identity": strings.TrimSpace(email), "password": password}
	q := url.Values{"fields": {"token,record." + strings.ReplaceAll(UserFields, ",", ",record.")}}
	if err := c.do(ctx, "POST", "/api/collections/users/auth-with-password", q, body, &a); err != nil {
		return nil, err
	}
	c.SetSession(a.Token, &a.Record)
	return &a.Record, nil
}

// Refresh renews the session's token. A 401 means the session is over (logged out elsewhere, banned).
func (c *Client) Refresh(ctx context.Context) (*User, error) {
	var a authAnswer
	if err := c.do(ctx, "POST", "/api/collections/users/auth-refresh", nil, nil, &a); err != nil {
		return nil, err
	}
	c.SetSession(a.Token, &a.Record)
	return &a.Record, nil
}

// SignUpInput is a new account. InviteCode is needed while the site is invite-only (DESIGN.md §24).
type SignUpInput struct {
	Name, Email, Password, InviteCode string
}

// Validate checks what the server would refuse, with the server's limits (shared/contract.json), so the form can
// say so before sending. Field → message.
func (in SignUpInput) Validate() map[string]string {
	bad := map[string]string{}
	name := strings.TrimSpace(in.Name)
	switch {
	case name == "":
		bad["name"] = "Enter a name"
	case utf8.RuneCountInString(name) > contract.Limits.UserName:
		bad["name"] = "At most " + itoa(contract.Limits.UserName) + " characters"
	}
	if e := strings.TrimSpace(in.Email); e == "" || !strings.Contains(e, "@") {
		bad["email"] = "Enter an email address"
	}
	switch {
	case utf8.RuneCountInString(in.Password) < contract.Limits.PasswordMin:
		bad["password"] = "At least " + itoa(contract.Limits.PasswordMin) + " characters"
	case len(in.Password) > contract.Limits.PasswordMaxBytes:
		bad["password"] = "Too long: at most " + itoa(contract.Limits.PasswordMaxBytes) + " bytes"
	}
	return bad
}

// ErrSignupLoginFailed: the account was made but logging in after failed (network, rate limit). Signing up again
// would only say the email is taken: log in instead (the web's SIGNUP_LOGIN_FAILED).
var ErrSignupLoginFailed = errors.New("your account was created, but logging in failed: log in")

// SignUp creates the account, then logs in to it.
func (c *Client) SignUp(ctx context.Context, in SignUpInput) (*User, error) {
	if bad := in.Validate(); len(bad) > 0 {
		return nil, &Error{Status: 400, Message: "Check the form", Fields: bad}
	}
	body := map[string]string{
		"name": strings.TrimSpace(in.Name), "email": strings.TrimSpace(in.Email),
		"password": in.Password, "passwordConfirm": in.Password,
	}
	if code := strings.TrimSpace(in.InviteCode); code != "" {
		body["invite_code"] = code
	}
	if err := c.do(ctx, "POST", "/api/collections/users/records", url.Values{"fields": {"id"}}, body, nil); err != nil {
		return nil, err
	}
	u, err := c.LogIn(ctx, in.Email, in.Password)
	if err != nil {
		return nil, errors.Join(ErrSignupLoginFailed, err)
	}
	return u, nil
}

// RequestPasswordReset asks for the email with a reset link (§39), the address in lower case as stored.
func (c *Client) RequestPasswordReset(ctx context.Context, email string) error {
	body := map[string]string{"email": strings.ToLower(strings.TrimSpace(email))}
	return c.do(ctx, "POST", "/api/collections/users/request-password-reset", nil, body, nil)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
