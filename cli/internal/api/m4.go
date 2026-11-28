package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/border-radius/chirkle/cli/internal/contract"
)

// CheckFiles says why these paths can't be sent, or nil: at most contract.Limits.Attachments, each a regular file
// of at most AttachmentBytes.
func CheckFiles(paths []string) error {
	if len(paths) > contract.Limits.Attachments {
		return fmt.Errorf("at most %d files a message", contract.Limits.Attachments)
	}
	for _, p := range paths {
		st, err := os.Stat(p)
		switch {
		case err != nil:
			return err
		case !st.Mode().IsRegular():
			return fmt.Errorf("%s isn't a file", filepath.Base(p))
		case st.Size() > int64(contract.Limits.AttachmentBytes):
			return fmt.Errorf("%s is over %d MB", filepath.Base(p), contract.Limits.AttachmentBytes>>20)
		case st.Size() == 0:
			return fmt.Errorf("%s is empty", filepath.Base(p))
		}
	}
	return nil
}

// SendFiles posts a message with files from disk (multipart; the server names them by the file's name).
func (c *Client) SendFiles(ctx context.Context, id, room, text, replyTo string, paths []string) (Message, error) {
	if len(paths) == 0 {
		return c.Send(ctx, id, room, text, replyTo)
	}
	if err := CheckFiles(paths); err != nil {
		return Message{}, err
	}
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	fields := map[string]string{"id": id, "room": room, "text": text}
	if me := c.Me(); me != nil {
		fields["author"] = me.ID
	}
	if replyTo != "" {
		fields["reply_to"] = replyTo
	}
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return Message{}, err
		}
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="files"; filename=%q`, filepath.Base(p)))
		h.Set("Content-Type", "application/octet-stream")
		part, err := w.CreatePart(h)
		if err == nil {
			_, err = io.Copy(part, f)
		}
		f.Close()
		if err != nil {
			return Message{}, err
		}
	}
	if err := w.Close(); err != nil {
		return Message{}, err
	}
	q := url.Values{"expand": {messageExpand}, "fields": {MessageFields}}
	var out Message
	return out, c.raw(ctx, "POST", "/api/collections/messages/records?"+q.Encode(), w.FormDataContentType(), &buf, &out)
}

// raw is do with a body of its own type.
func (c *Client) raw(ctx context.Context, method, path, contentType string, body io.Reader, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UserAgent())
	if t := c.Token(); t != "" {
		req.Header.Set("Authorization", t)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return decodeError(res.StatusCode, data)
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// Ban bans or unbans someone (moderators only, DESIGN.md §36).
func (c *Client) Ban(ctx context.Context, user string, banned bool) error {
	return c.do(ctx, "POST", "/api/chat/ban", nil, map[string]any{"user": user, "banned": banned}, nil)
}

// Export is where your newest data export is (DESIGN.md §43.2).
type Export struct {
	ID       string `json:"id"`
	State    string `json:"state"` // none | queued | done | failed
	Created  string `json:"created"`
	Finished string `json:"finished"`
	Expires  string `json:"expires"`
	Size     int64  `json:"size"`
}

func (c *Client) ExportState(ctx context.Context) (Export, error) {
	var out Export
	return out, c.do(ctx, "GET", "/api/chat/export", nil, nil, &out)
}

// StartExport asks for one (the same one while it's being made or just made).
func (c *Client) StartExport(ctx context.Context) (Export, error) {
	var out Export
	return out, c.do(ctx, "POST", "/api/chat/export", nil, map[string]any{}, &out)
}

// DownloadExport writes the made export to w; the file's name the server gives.
func (c *Client) DownloadExport(ctx context.Context, w io.Writer) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", c.Base+"/api/chat/export/file", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", UserAgent())
	req.Header.Set("Authorization", c.Token())
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		return "", decodeError(res.StatusCode, data)
	}
	name := ""
	if _, params, err := mime.ParseMediaType(res.Header.Get("Content-Disposition")); err == nil {
		name = filepath.Base(strings.TrimSpace(params["filename"]))
	}
	_, err = io.Copy(w, res.Body)
	return name, err
}

// DeleteAccount deletes the account (DESIGN.md §43.3): messages "keep" or "delete". Every session ends.
func (c *Client) DeleteAccount(ctx context.Context, password, messages string) error {
	return c.do(ctx, "POST", "/api/chat/account/delete", nil, map[string]string{"password": password, "messages": messages}, nil)
}
