package main

// The parts of XMPP stanzas the bridge reads and writes (DESIGN.md §38.3, §38.6): encoding/xml structs of our own, so
// a field the library doesn't model (occupant-id, stanza-id, origin-id) is just a tag here.

import (
	"encoding/xml"
	"strings"
)

const (
	nsMUC      = "http://jabber.org/protocol/muc"
	nsMUCUser  = "http://jabber.org/protocol/muc#user"
	nsMUCOwner = "http://jabber.org/protocol/muc#owner"
	nsData     = "jabber:x:data"
	nsDiscoInf = "http://jabber.org/protocol/disco#info"
	nsSID      = "urn:xmpp:sid:0"
	nsOccupant = "urn:xmpp:occupant-id:0"
	nsDelay    = "urn:xmpp:delay"
	nsPing     = "urn:xmpp:ping"
	nsConf     = "jabber:x:conference"
	nsStanzas  = "urn:ietf:params:xml:ns:xmpp-stanzas"
	nsReply    = "urn:xmpp:reply:0"
	nsFallback = "urn:xmpp:fallback:0"
	nsCorrect  = "urn:xmpp:message-correct:0"
	nsRetract  = "urn:xmpp:message-retract:1"
	nsRetract0 = "urn:xmpp:message-retract:0"
	nsModerate = "urn:xmpp:message-moderate:1"
	nsModerat0 = "urn:xmpp:message-moderate:0"
	nsFasten   = "urn:xmpp:fasten:0"
	nsHints    = "urn:xmpp:hints"
	nsReact    = "urn:xmpp:reactions:0"
	nsVCard    = "vcard-temp"
	nsVUpdate  = "vcard-temp:x:update"
)

// MUC status codes (XEP-0045 §15.6).
const (
	statusSelf       = 110
	statusCreated    = 201
	statusNickChange = 303
	statusBanned     = 301
	statusKicked     = 307
	statusAffil      = 321
	statusMembers    = 322
	statusShutdown   = 332
	statusError      = 333
)

type idAttr struct {
	ID string `xml:"id,attr"`
}

type stanzaID struct {
	ID string `xml:"id,attr"`
	By string `xml:"by,attr"`
}

type mucItem struct {
	JID         string `xml:"jid,attr"`
	Nick        string `xml:"nick,attr"`
	Role        string `xml:"role,attr"`
	Affiliation string `xml:"affiliation,attr"`
}

type mucStatus struct {
	Code int `xml:"code,attr"`
}

type mucInvite struct {
	From   string `xml:"from,attr"`
	Reason string `xml:"reason"`
}

type mucUser struct {
	Items    []mucItem   `xml:"item"`
	Statuses []mucStatus `xml:"status"`
	Invite   *mucInvite  `xml:"invite"`
	Password string      `xml:"password"`
	Destroy  *struct{}   `xml:"destroy"`
}

func (u *mucUser) has(code int) bool {
	if u == nil {
		return false
	}
	for _, s := range u.Statuses {
		if s.Code == code {
			return true
		}
	}
	return false
}

func (u *mucUser) item() mucItem {
	if u == nil || len(u.Items) == 0 {
		return mucItem{}
	}
	return u.Items[0]
}

// A stanza error: its type and its condition's name ("conflict", "forbidden"…).
type stanzaError struct {
	Type  string `xml:"type,attr"`
	Inner []struct {
		XMLName xml.Name
		Text    string `xml:",chardata"`
	} `xml:",any"`
}

func (e *stanzaError) condition() string {
	if e == nil {
		return ""
	}
	for _, c := range e.Inner {
		if c.XMLName.Space == nsStanzas && c.XMLName.Local != "text" {
			return c.XMLName.Local
		}
	}
	return "undefined-condition"
}

func (e *stanzaError) text() string {
	if e == nil {
		return ""
	}
	for _, c := range e.Inner {
		if c.XMLName.Local == "text" {
			return strings.TrimSpace(c.Text)
		}
	}
	return ""
}

type inMessage struct {
	XMLName    xml.Name     `xml:"message"`
	ID         string       `xml:"id,attr"`
	From       string       `xml:"from,attr"`
	Type       string       `xml:"type,attr"`
	Body       *string      `xml:"body"`
	Subject    *string      `xml:"subject"`
	StanzaIDs  []stanzaID   `xml:"urn:xmpp:sid:0 stanza-id"`
	OriginID   *idAttr      `xml:"urn:xmpp:sid:0 origin-id"`
	OccupantID *idAttr      `xml:"urn:xmpp:occupant-id:0 occupant-id"`
	Delay      *delay       `xml:"urn:xmpp:delay delay"`
	MUCUser    *mucUser     `xml:"http://jabber.org/protocol/muc#user x"`
	Conference *conference  `xml:"jabber:x:conference x"`
	Error      *stanzaError `xml:"error"`

	Reply     *replyTo   `xml:"urn:xmpp:reply:0 reply"`
	Fallbacks []fallback `xml:"urn:xmpp:fallback:0 fallback"`
	Replace   *idAttr    `xml:"urn:xmpp:message-correct:0 replace"`
	Retract   *retract   `xml:"urn:xmpp:message-retract:1 retract"`
	Retracted *struct{}  `xml:"urn:xmpp:message-retract:1 retracted"`
	ApplyTo   *applyTo   `xml:"urn:xmpp:fasten:0 apply-to"`

	// Files: a link to one (XEP-0066), which is how XEP-0363 uploads are sent.
	OOB []struct {
		URL string `xml:"url"`
	} `xml:"jabber:x:oob x"`
	// Encrypted: OMEMO (the old namespace and the new), OpenPGP (XEP-0373, XEP-0027). The body is only a notice.
	OMEMO   *struct{} `xml:"eu.siacs.conversations.axolotl encrypted"`
	OMEMO2  *struct{} `xml:"urn:xmpp:omemo:2 encrypted"`
	OpenPGP *struct{} `xml:"urn:xmpp:openpgp:0 openpgp"`
	PGP     *struct{} `xml:"jabber:x:encrypted x"`

	// Someone's whole set of reactions on a message (XEP-0444): in a conference, by its stanza id.
	Reactions *struct {
		ID        string   `xml:"id,attr"`
		Reactions []string `xml:"reaction"`
	} `xml:"urn:xmpp:reactions:0 reactions"`
}

// encrypted: a message the bot can't read. An aesgcm:// link is an OMEMO-encrypted file.
func (m *inMessage) encrypted() bool {
	return m.OMEMO != nil || m.OMEMO2 != nil || m.OpenPGP != nil || m.PGP != nil ||
		m.Body != nil && strings.HasPrefix(strings.TrimSpace(*m.Body), "aesgcm://")
}

// A reply (XEP-0461): to the message the conference knows by id (its stanza id), written by to (an occupant).
type replyTo struct {
	To string `xml:"to,attr"`
	ID string `xml:"id,attr"`
}

// What part of the body is there only for clients that don't know an element (XEP-0428): ranges in code points, or
// the whole body when it gives none.
type fallback struct {
	For    string `xml:"for,attr"`
	Bodies []struct {
		Start *int `xml:"start,attr"`
		End   *int `xml:"end,attr"`
	} `xml:"body"`
}

// A retraction (XEP-0424, version 1): by its author, or, from the conference itself, by a moderator (XEP-0425).
type retract struct {
	ID        string `xml:"id,attr"`
	Moderated *struct {
		By string `xml:"by,attr"`
	} `xml:"urn:xmpp:message-moderate:1 moderated"`
}

// The same in the versions before (XEP-0424 0.x, XEP-0425 0.2), which many clients and servers still send.
type applyTo struct {
	ID        string    `xml:"id,attr"`
	Retract   *struct{} `xml:"urn:xmpp:message-retract:0 retract"`
	Moderated *struct {
		By      string    `xml:"by,attr"`
		Retract *struct{} `xml:"urn:xmpp:message-retract:0 retract"`
	} `xml:"urn:xmpp:message-moderate:0 moderated"`
}

// withoutFallback is the body less the fallback for `ns` (the quote over a reply, say): what a client that knows
// the element shows.
func (m *inMessage) withoutFallback(ns string) string {
	if m.Body == nil {
		return ""
	}
	body := []rune(*m.Body)
	cut := make([]bool, len(body))
	found := false
	for _, f := range m.Fallbacks {
		if f.For != ns {
			continue
		}
		found = true
		if len(f.Bodies) == 0 {
			return ""
		}
		for _, r := range f.Bodies {
			start, end := 0, len(body)
			if r.Start != nil {
				start = *r.Start
			}
			if r.End != nil {
				end = *r.End
			}
			for i := max(start, 0); i < min(end, len(body)); i++ {
				cut[i] = true
			}
		}
	}
	if !found {
		return *m.Body
	}
	kept := make([]rune, 0, len(body))
	for i, c := range body {
		if !cut[i] {
			kept = append(kept, c)
		}
	}
	return strings.TrimSpace(string(kept))
}

// The stanza id the conference gave a message (XEP-0359: the one "by" the conference itself).
func (m *inMessage) stanzaIDBy(by string) string {
	for _, s := range m.StanzaIDs {
		if s.By == by {
			return s.ID
		}
	}
	return ""
}

type delay struct {
	Stamp string `xml:"stamp,attr"`
}

type conference struct {
	JID      string `xml:"jid,attr"`
	Password string `xml:"password,attr"`
}

type inPresence struct {
	XMLName    xml.Name     `xml:"presence"`
	From       string       `xml:"from,attr"`
	Type       string       `xml:"type,attr"`
	OccupantID *idAttr      `xml:"urn:xmpp:occupant-id:0 occupant-id"`
	MUCUser    *mucUser     `xml:"http://jabber.org/protocol/muc#user x"`
	Error      *stanzaError `xml:"error"`
	// The hash of their vCard's photo (XEP-0153): empty for none. No element: the client doesn't say.
	Photo *struct {
		Hash *string `xml:"photo"`
	} `xml:"vcard-temp:x:update x"`
}

type inIQ struct {
	XMLName xml.Name  `xml:"iq"`
	ID      string    `xml:"id,attr"`
	From    string    `xml:"from,attr"`
	Type    string    `xml:"type,attr"`
	Ping    *struct{} `xml:"urn:xmpp:ping ping"`
	Disco   *struct {
		Node string `xml:"node,attr"`
	} `xml:"http://jabber.org/protocol/disco#info query"`
}

// ---------------------------------------------------------------- what the bridge sends

type outMessage struct {
	XMLName   xml.Name      `xml:"message"`
	To        string        `xml:"to,attr"`
	ID        string        `xml:"id,attr,omitempty"`
	Type      string        `xml:"type,attr"`
	Body      string        `xml:"body,omitempty"`
	OriginID  *outID        `xml:"origin-id,omitempty"`
	Reply     *outReply     `xml:",omitempty"`
	Replace   *outReplace   `xml:",omitempty"`
	Retract   *outRetract   `xml:",omitempty"`
	ApplyTo   *outApplyTo   `xml:",omitempty"`
	Fallbacks []outFallback `xml:",omitempty"`
	Store     *outStore     `xml:",omitempty"`
	OOB       *outOOB       `xml:",omitempty"`
	Reactions *outReactions `xml:",omitempty"`
}

type outReactions struct {
	XMLName   xml.Name `xml:"urn:xmpp:reactions:0 reactions"`
	ID        string   `xml:"id,attr"`
	Reactions []string `xml:"reaction"`
}

type outOOB struct {
	XMLName xml.Name `xml:"jabber:x:oob x"`
	URL     string   `xml:"url"`
}

type outReply struct {
	XMLName xml.Name `xml:"urn:xmpp:reply:0 reply"`
	To      string   `xml:"to,attr,omitempty"`
	ID      string   `xml:"id,attr"`
}

type outReplace struct {
	XMLName xml.Name `xml:"urn:xmpp:message-correct:0 replace"`
	ID      string   `xml:"id,attr"`
}

type outRetract struct {
	XMLName xml.Name `xml:"urn:xmpp:message-retract:1 retract"`
	ID      string   `xml:"id,attr"`
}

// The retraction as before (XEP-0424 0.x): by the origin id, for the clients that only know that.
type outApplyTo struct {
	XMLName xml.Name `xml:"urn:xmpp:fasten:0 apply-to"`
	ID      string   `xml:"id,attr"`
	Retract struct {
		XMLName xml.Name `xml:"urn:xmpp:message-retract:0 retract"`
	}
}

type outFallback struct {
	XMLName xml.Name       `xml:"urn:xmpp:fallback:0 fallback"`
	For     string         `xml:"for,attr"`
	Bodies  []outFallbackR `xml:"body,omitempty"`
}

type outFallbackR struct {
	Start int `xml:"start,attr"`
	End   int `xml:"end,attr"`
}

// Keep it in the archives (XEP-0334): a retraction has a body only for old clients.
type outStore struct {
	XMLName xml.Name `xml:"urn:xmpp:hints store"`
}

type outID struct {
	XMLName xml.Name `xml:"urn:xmpp:sid:0 origin-id"`
	ID      string   `xml:"id,attr"`
}

type history struct {
	Since      string `xml:"since,attr,omitempty"`
	MaxStanzas *int   `xml:"maxstanzas,attr,omitempty"`
}

type mucJoin struct {
	XMLName  xml.Name `xml:"http://jabber.org/protocol/muc x"`
	History  history  `xml:"history"`
	Password string   `xml:"password,omitempty"`
}

type outPresence struct {
	XMLName xml.Name `xml:"presence"`
	To      string   `xml:"to,attr,omitempty"`
	Type    string   `xml:"type,attr,omitempty"`
	Join    *mucJoin `xml:",omitempty"`
}

type discoIdentity struct {
	Category string `xml:"category,attr"`
	Type     string `xml:"type,attr"`
	Name     string `xml:"name,attr,omitempty"`
}

type discoFeature struct {
	Var string `xml:"var,attr"`
}

type discoInfo struct {
	XMLName    xml.Name        `xml:"http://jabber.org/protocol/disco#info query"`
	Node       string          `xml:"node,attr,omitempty"`
	Identities []discoIdentity `xml:"identity"`
	Features   []discoFeature  `xml:"feature"`
	Forms      []dataForm      `xml:"jabber:x:data x"`
}

// The reply to an IQ: its type and, for an error, its condition.
type iqReply struct {
	XMLName xml.Name     `xml:"iq"`
	Type    string       `xml:"type,attr"`
	Error   *stanzaError `xml:"error"`
	Disco   *discoInfo   `xml:"http://jabber.org/protocol/disco#info query"`
	Items   *discoItems  `xml:"http://jabber.org/protocol/disco#items query"`
	Slot    *slot        `xml:"urn:xmpp:http:upload:0 slot"`
	VCard   *struct {
		Photo struct {
			Type   string `xml:"TYPE"`
			BinVal string `xml:"BINVAL"`
		} `xml:"PHOTO"`
	} `xml:"vcard-temp vCard"`
}
