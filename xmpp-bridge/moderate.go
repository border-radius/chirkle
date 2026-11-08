package main

// Moderation and avatars (DESIGN.md §38.5, §38.7): a message taken out of a conference by the bot as one of its
// moderators (XEP-0425), and an occupant's vCard photo (XEP-0153), held for PocketBase to fetch once.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/xml"
	"strings"
	"sync"
	"time"

	"mellium.im/xmlstream"
	"mellium.im/xmpp/jid"
)

const (
	// The largest photo taken (users.avatar's limit, §15.1).
	maxPhoto = 2 << 20
	// A photo waits this long for PocketBase to fetch it.
	photoTTL = 2 * time.Minute
)

// moderate has the conference retract a message (its stanza id) for everyone, as the bot, a moderator there. In
// the version the conference says it has (1, else 0.2), and version 1 when it says neither.
func (b *bridge) moderate(ctx context.Context, muc, id, reason string) error {
	j, err := jid.Parse(muc)
	if err != nil {
		return &sendError{msg: "not a conference address"}
	}
	b.mu.Lock()
	sess := b.sess
	r := b.rooms[j.Bare().String()]
	var joined, moderator, old bool
	if r != nil {
		joined, moderator = r.state == stateJoined, r.role == "moderator"
		old = r.feats[nsModerat0] && !r.feats[nsModerate]
	}
	b.mu.Unlock()
	switch {
	case sess == nil:
		return &sendError{msg: "not connected", transient: true}
	case r == nil:
		return &sendError{msg: "not a linked conference"}
	case !joined:
		return &sendError{msg: "not in the conference", transient: true}
	case !moderator:
		return &sendError{msg: "the bot isn't a moderator there"}
	}
	var payload xml.TokenReader
	reasonEl := func(ns string) xml.TokenReader {
		if reason == "" {
			return nil
		}
		return xmlstream.Wrap(xmlstream.Token(xml.CharData(reason)), xml.StartElement{Name: xml.Name{Space: ns, Local: "reason"}})
	}
	if old {
		inner := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsRetract0, Local: "retract"}})
		if el := reasonEl(nsModerat0); el != nil {
			inner = xmlstream.MultiReader(inner, el)
		}
		mod := xmlstream.Wrap(inner, xml.StartElement{Name: xml.Name{Space: nsModerat0, Local: "moderate"}})
		payload = xmlstream.Wrap(mod, xml.StartElement{Name: xml.Name{Space: nsFasten, Local: "apply-to"}, Attr: []xml.Attr{{Name: xml.Name{Local: "id"}, Value: id}}})
	} else {
		inner := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsRetract, Local: "retract"}})
		if el := reasonEl(nsModerate); el != nil {
			inner = xmlstream.MultiReader(inner, el)
		}
		payload = xmlstream.Wrap(inner, xml.StartElement{Name: xml.Name{Space: nsModerate, Local: "moderate"}, Attr: []xml.Attr{{Name: xml.Name{Local: "id"}, Value: id}}})
	}
	if _, err := b.iq(ctx, sess, r.muc, "set", payload); err != nil {
		if se, ok := err.(*stanzaError); ok {
			return &sendError{msg: "the conference refused: " + se.Error(), transient: se.Type == "wait"}
		}
		return &sendError{msg: err.Error(), transient: true}
	}
	return nil
}

// A photo fetched for PocketBase, by a one-time token.
type photo struct {
	data []byte
	typ  string
	at   time.Time
}

type photos struct {
	mu sync.Mutex
	m  map[string]photo
}

func (p *photos) put(ph photo) string {
	var raw [16]byte
	rand.Read(raw[:])
	token := hex.EncodeToString(raw[:])
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.m == nil {
		p.m = map[string]photo{}
	}
	for k, v := range p.m {
		if time.Since(v.at) > photoTTL {
			delete(p.m, k)
		}
	}
	ph.at = time.Now()
	p.m[token] = ph
	return token
}

// take gives the photo once.
func (p *photos) take(token string) (photo, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	ph, ok := p.m[token]
	delete(p.m, token)
	return ph, ok && time.Since(ph.at) <= photoTTL
}

// avatar fetches an occupant's vCard photo (XEP-0153, through the conference), and holds it under a token. "" with
// no error: they have none.
func (b *bridge) avatar(ctx context.Context, muc, nick string) (token, typ string, err error) {
	j, err := jid.Parse(muc)
	if err != nil {
		return "", "", &sendError{msg: "not a conference address"}
	}
	to, err := j.Bare().WithResource(nick)
	if err != nil || nick == "" {
		return "", "", &sendError{msg: "not a nickname"}
	}
	b.mu.Lock()
	sess := b.sess
	r := b.rooms[j.Bare().String()]
	joined := r != nil && r.state == stateJoined
	b.mu.Unlock()
	switch {
	case sess == nil:
		return "", "", &sendError{msg: "not connected", transient: true}
	case r == nil:
		return "", "", &sendError{msg: "not a linked conference"}
	case !joined:
		return "", "", &sendError{msg: "not in the conference", transient: true}
	}
	reply, err := b.iq(ctx, sess, to, "get", xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsVCard, Local: "vCard"}}))
	if err != nil {
		if se, ok := err.(*stanzaError); ok {
			// Gone, or no vCard: none for now.
			return "", "", &sendError{msg: "no vCard: " + se.Error(), transient: se.Type == "wait"}
		}
		return "", "", &sendError{msg: err.Error(), transient: true}
	}
	if reply.VCard == nil || strings.TrimSpace(reply.VCard.Photo.BinVal) == "" {
		return "", "", nil
	}
	clean := strings.Map(func(r rune) rune {
		if r == ' ' || r == '\n' || r == '\r' || r == '\t' {
			return -1
		}
		return r
	}, reply.VCard.Photo.BinVal)
	if base64.StdEncoding.DecodedLen(len(clean)) > maxPhoto+3 {
		return "", "", &sendError{msg: "the photo is too large"}
	}
	data, err := base64.StdEncoding.DecodeString(clean)
	if err != nil {
		return "", "", &sendError{msg: "the photo isn't base64"}
	}
	typ = strings.ToLower(strings.TrimSpace(reply.VCard.Photo.Type))
	return b.photos.put(photo{data: data, typ: typ}), typ, nil
}
