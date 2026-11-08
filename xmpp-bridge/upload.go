package main

// Files out (DESIGN.md §38.7): a slot from the bot's server's upload service (XEP-0363), and the file PUT there,
// read from PocketBase as it is served (a file's URL is its secret, §37). The service is looked up once per
// connection: the server's disco#items, then each one's disco#info.

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"mellium.im/xmlstream"
	"mellium.im/xmpp"
	"mellium.im/xmpp/jid"
)

const (
	nsUpload  = "urn:xmpp:http:upload:0"
	nsDiscoIt = "http://jabber.org/protocol/disco#items"
	// A file's whole way, from PocketBase to the upload service.
	uploadTimeout = 5 * time.Minute
)

// Refusals that say the file can't go by upload at all: PocketBase links to it at the site instead.
const (
	codeUnsupported = "unsupported" // the server has no upload service
	codeTooLarge    = "too_large"
)

type uploadError struct {
	msg       string
	transient bool
	code      string
}

func (e *uploadError) Error() string { return e.msg }

// The server's upload service, as found for one session.
type uploadService struct {
	sess *xmpp.Session
	jid  jid.JID // zero: there is none
	max  int64   // 0: no limit given
}

type discoItems struct {
	XMLName xml.Name `xml:"http://jabber.org/protocol/disco#items query"`
	Items   []struct {
		JID string `xml:"jid,attr"`
	} `xml:"item"`
}

type dataForm struct {
	Fields []struct {
		Var    string   `xml:"var,attr"`
		Values []string `xml:"value"`
	} `xml:"field"`
}

func (f dataForm) value(name string) string {
	for _, field := range f.Fields {
		if field.Var == name && len(field.Values) > 0 {
			return strings.TrimSpace(field.Values[0])
		}
	}
	return ""
}

type slot struct {
	XMLName xml.Name `xml:"urn:xmpp:http:upload:0 slot"`
	Put     struct {
		URL     string `xml:"url,attr"`
		Headers []struct {
			Name  string `xml:"name,attr"`
			Value string `xml:",chardata"`
		} `xml:"header"`
	} `xml:"put"`
	Get struct {
		URL string `xml:"url,attr"`
	} `xml:"get"`
}

// service finds the upload service of the bot's server, once per session.
func (b *bridge) service(ctx context.Context, sess *xmpp.Session) (uploadService, error) {
	b.mu.Lock()
	known := b.uploads
	b.mu.Unlock()
	if known.sess == sess {
		return known, nil
	}
	found := uploadService{sess: sess}
	server := b.cfg.jid.Domain()
	candidates := []jid.JID{server}
	payload := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsDiscoIt, Local: "query"}})
	reply, err := b.iq(ctx, sess, server, "get", payload)
	if err != nil && !isStanzaError(err) {
		return found, err
	}
	if err == nil && reply.Items != nil {
		for _, it := range reply.Items.Items {
			if j, err := jid.Parse(it.JID); err == nil {
				candidates = append(candidates, j)
			}
		}
	}
	for _, c := range candidates {
		payload := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsDiscoInf, Local: "query"}})
		reply, err := b.iq(ctx, sess, c, "get", payload)
		if err != nil {
			if !isStanzaError(err) {
				return found, err
			}
			continue
		}
		if reply.Disco == nil || !reply.Disco.has(nsUpload) {
			continue
		}
		found.jid = c
		for _, f := range reply.Disco.Forms {
			if f.value("FORM_TYPE") == nsUpload {
				found.max, _ = strconv.ParseInt(f.value("max-file-size"), 10, 64)
			}
		}
		break
	}
	b.mu.Lock()
	b.uploads = found
	b.mu.Unlock()
	return found, nil
}

// upload puts the file PocketBase serves at path on the bot's server, and gives the URL it is got from.
func (b *bridge) upload(ctx context.Context, path, name, contentType string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	b.mu.Lock()
	sess := b.sess
	b.mu.Unlock()
	if sess == nil {
		return "", &uploadError{msg: "not connected", transient: true}
	}
	svc, err := b.service(ctx, sess)
	if err != nil {
		return "", &uploadError{msg: "looking for the upload service: " + err.Error(), transient: true}
	}
	if svc.jid.Equal(jid.JID{}) {
		return "", &uploadError{msg: "the server has no upload service", code: codeUnsupported}
	}

	res, err := b.pb.file(ctx, path)
	if err != nil {
		return "", &uploadError{msg: "reading the file: " + err.Error(), transient: true}
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		// Gone meanwhile (deleted), or never there: trying again won't help.
		return "", &uploadError{msg: "reading the file: " + res.Status, transient: res.StatusCode >= 500}
	}
	size := res.ContentLength
	var body io.Reader = res.Body
	if size < 0 {
		// No length given: read it, as far as the service would take it.
		limit := svc.max
		if limit <= 0 {
			limit = 100 << 20
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
		if err != nil {
			return "", &uploadError{msg: "reading the file: " + err.Error(), transient: true}
		}
		size, body = int64(len(data)), bytes.NewReader(data)
	}
	if svc.max > 0 && size > svc.max {
		return "", &uploadError{msg: fmt.Sprintf("%d bytes, over the server's %d", size, svc.max), code: codeTooLarge}
	}
	if contentType == "" {
		contentType = res.Header.Get("Content-Type")
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	attrs := []xml.Attr{
		{Name: xml.Name{Local: "filename"}, Value: name},
		{Name: xml.Name{Local: "size"}, Value: strconv.FormatInt(size, 10)},
		{Name: xml.Name{Local: "content-type"}, Value: contentType},
	}
	payload := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsUpload, Local: "request"}, Attr: attrs})
	reply, err := b.iq(ctx, sess, svc.jid, "get", payload)
	if err != nil {
		if se, ok := err.(*stanzaError); ok {
			if se.tooLarge() {
				return "", &uploadError{msg: "the server refused it as too large", code: codeTooLarge}
			}
			return "", &uploadError{msg: "no upload slot: " + se.Error(), transient: se.Type == "wait"}
		}
		return "", &uploadError{msg: "no upload slot: " + err.Error(), transient: true}
	}
	if reply.Slot == nil || !isHTTPS(reply.Slot.Put.URL) || !isHTTPS(reply.Slot.Get.URL) {
		return "", &uploadError{msg: "the upload service gave no usable slot"}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, reply.Slot.Put.URL, body)
	if err != nil {
		return "", &uploadError{msg: "upload: " + err.Error()}
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	for _, h := range reply.Slot.Put.Headers {
		// Only these may come from the slot (XEP-0363 §5): nothing else is sent on its say.
		switch strings.ToLower(h.Name) {
		case "authorization", "cookie", "expires":
			req.Header.Set(h.Name, strings.ReplaceAll(strings.ReplaceAll(h.Value, "\r", ""), "\n", ""))
		}
	}
	put, err := b.http.Do(req)
	if err != nil {
		return "", &uploadError{msg: "upload: " + err.Error(), transient: true}
	}
	io.Copy(io.Discard, io.LimitReader(put.Body, 64<<10))
	put.Body.Close()
	if put.StatusCode != http.StatusOK && put.StatusCode != http.StatusCreated {
		if put.StatusCode == http.StatusRequestEntityTooLarge {
			return "", &uploadError{msg: "the upload service refused it as too large", code: codeTooLarge}
		}
		return "", &uploadError{msg: "upload: " + put.Status, transient: put.StatusCode >= 500 || put.StatusCode == http.StatusTooManyRequests}
	}
	return reply.Slot.Get.URL, nil
}

// isHTTPS: XEP-0363 slots are HTTPS. Plain HTTP only in the tests (allowPlainUploads).
func isHTTPS(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Host != "" && (u.Scheme == "https" || u.Scheme == "http" && allowPlainUploads)
}

// Tests only.
var allowPlainUploads = false

func (d *discoInfo) has(feature string) bool {
	for _, f := range d.Features {
		if f.Var == feature {
			return true
		}
	}
	return false
}

// tooLarge: the upload service's own error for it (XEP-0363 §4).
func (e *stanzaError) tooLarge() bool {
	for _, c := range e.Inner {
		if c.XMLName.Space == nsUpload && c.XMLName.Local == "file-too-large" {
			return true
		}
	}
	return false
}
