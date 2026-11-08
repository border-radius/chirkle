package main

// The XMPP side (DESIGN.md §38.3, §38.6): one client stream, held open and reconnected after a drop, and the
// conferences PocketBase asked for, joined on every connect. What comes in is passed to PocketBase as events.

import (
	"context"
	"crypto/tls"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"mellium.im/sasl"
	"mellium.im/xmlstream"
	"mellium.im/xmpp"
	"mellium.im/xmpp/dial"
	"mellium.im/xmpp/jid"
	"mellium.im/xmpp/stanza"
)

const (
	pingEvery     = 60 * time.Second
	selfPingEvery = 5 * time.Minute
	iqTimeout     = 30 * time.Second
	sendTimeout   = 15 * time.Second
	// How many nicknames a join tries ("Chirkle", "Chirkle2"…) when the one before is taken.
	maxNickTries = 5
	// A private message is answered once per sender in this long.
	pmReplyEvery = time.Hour
	pmReply      = "I work in conferences only."
)

// Room states, as statuses report them.
const (
	stateJoining = "joining"
	stateJoined  = "joined"
	stateError   = "error"
	stateRemoved = "removed"
)

type occupant struct {
	jid   string // bare, when the conference shows it
	id    string // occupant-id
	photo string // their vCard photo's hash, as last told
}

type room struct {
	muc      jid.JID
	key      string
	password string
	since    time.Time

	state string // "" (to join), joining, joined, error, removed
	err   string
	nick  string
	tries int
	title string
	role  string          // the bot's: "moderator" may moderate (XEP-0425)
	feats map[string]bool // the conference's features (disco#info)

	occupants map[string]occupant

	// What the bot sent lately, for a refusal to find: the conference had forgotten the bot (its service restarted),
	// and these wait in resend, in order, until it is in again (sent: newest last, sentKeep at most).
	sent   []sentStanza
	resend []outMessage
}

// A stanza the bot sent to a conference, as it was.
type sentStanza struct {
	msg outMessage
	at  time.Time
}

const (
	sentKeep = 200
	sentFor  = 2 * time.Minute
)

type settings struct {
	jid      jid.JID
	password string
	nick     string
	server   string // host[:port], else from DNS (SRV records)
	// Tests: their own TLS configuration, mechanisms and connection.
	tls        *tls.Config
	mechanisms []sasl.Mechanism
	dial       func(ctx context.Context) (net.Conn, error)
}

type bridge struct {
	cfg settings
	pb  *pocketbase

	mu        sync.Mutex
	sess      *xmpp.Session
	connected bool
	connErr   string
	rooms     map[string]*room // by the conference's bare address
	answered  map[string]time.Time
	uploads   uploadService // the server's, for sess
	http      *http.Client  // to upload services
	photos    photos        // vCard photos fetched, for PocketBase to take

	sync    chan struct{} // joins and leaves to do
	changed chan struct{} // a status to send
	in      chan any      // stanzas, decoded, in order
}

func newBridge(cfg settings, pb *pocketbase) *bridge {
	return &bridge{
		cfg:      cfg,
		pb:       pb,
		rooms:    map[string]*room{},
		answered: map[string]time.Time{},
		http:     &http.Client{},
		sync:     make(chan struct{}, 1),
		changed:  make(chan struct{}, 1),
		in:       make(chan any, 1000),
	}
}

func poke(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

// ---------------------------------------------------------------- the conferences PocketBase wants

type wantedRoom struct {
	MUC      string `json:"muc"`
	Key      string `json:"key"`
	Password string `json:"password"`
	Since    string `json:"since"`
}

// setRooms makes the conferences joined these: new ones joined, gone ones left, and one that failed tried again.
func (b *bridge) setRooms(want []wantedRoom) error {
	next := map[string]wantedRoom{}
	for _, w := range want {
		j, err := jid.Parse(w.MUC)
		if err != nil || j.Localpart() == "" || j.Resourcepart() != "" {
			return fmt.Errorf("not a conference address: %q", w.MUC)
		}
		w.MUC = j.String()
		next[w.MUC] = w
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for addr, r := range b.rooms {
		if _, ok := next[addr]; ok {
			continue
		}
		if r.state == stateJoined || r.state == stateJoining {
			b.leaveLater(r)
		}
		delete(b.rooms, addr)
	}
	for addr, w := range next {
		since, _ := time.Parse(time.RFC3339Nano, w.Since)
		r := b.rooms[addr]
		if r == nil {
			r = &room{muc: jid.MustParse(addr), occupants: map[string]occupant{}}
			b.rooms[addr] = r
		}
		if since.After(r.since) {
			r.since = since
		}
		r.key, r.password = w.Key, w.Password
		// A join that failed is tried again (asked again: the link saved, or a new child). One that is going, or done,
		// is left as it is: leaving first would race the join after it.
		if r.state == stateError || r.state == stateRemoved {
			r.state, r.err, r.tries = "", "", 0
		}
	}
	poke(b.sync)
	poke(b.changed)
	return nil
}

// leaveLater sends the conference our leaving, outside the lock.
func (b *bridge) leaveLater(r *room) {
	sess, to := b.sess, r.muc.String()+"/"+r.nick
	if sess == nil || r.nick == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
		defer cancel()
		sess.Encode(ctx, outPresence{To: to, Type: "unavailable"})
	}()
}

// ---------------------------------------------------------------- the connection

func (b *bridge) connect(ctx context.Context) (*xmpp.Session, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	var conn net.Conn
	var err error
	switch {
	case b.cfg.dial != nil:
		conn, err = b.cfg.dial(ctx)
	case b.cfg.server != "":
		// XMPP_SERVER: this host and port, no DNS records looked up; STARTTLS (not direct TLS) once connected.
		addr := b.cfg.server
		if _, _, splitErr := net.SplitHostPort(addr); splitErr != nil {
			addr = net.JoinHostPort(addr, "5222")
		}
		conn, err = (&net.Dialer{Timeout: 30 * time.Second}).DialContext(ctx, "tcp", addr)
	default:
		conn, err = (&dial.Dialer{}).Dial(ctx, "tcp", b.cfg.jid)
	}
	if err != nil {
		return nil, err
	}
	tlsCfg := b.cfg.tls
	if tlsCfg == nil {
		tlsCfg = &tls.Config{ServerName: b.cfg.jid.Domainpart(), MinVersion: tls.VersionTLS12}
	}
	mechs := b.cfg.mechanisms
	if len(mechs) == 0 {
		mechs = []sasl.Mechanism{sasl.ScramSha256Plus, sasl.ScramSha256, sasl.ScramSha1Plus, sasl.ScramSha1, sasl.Plain}
	}
	sess, err := xmpp.NewClientSession(ctx, b.cfg.jid, conn,
		xmpp.StartTLS(tlsCfg),
		loginRefusedSays(xmpp.SASL("", b.cfg.password, mechs...)),
		xmpp.BindResource(),
	)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return sess, nil
}

// loginRefusedSays has a failed login say what it is: the server's own words alone ("The response provided by the
// client doesn't match…") don't tell an admin to look at XMPP_JID and XMPP_PASSWORD. Not a connection that broke.
func loginRefusedSays(f xmpp.StreamFeature) xmpp.StreamFeature {
	negotiate := f.Negotiate
	f.Negotiate = func(ctx context.Context, s *xmpp.Session, data interface{}) (xmpp.SessionState, io.ReadWriter, error) {
		mask, rw, err := negotiate(ctx, s, data)
		var netErr net.Error
		if err != nil && ctx.Err() == nil && !errors.As(err, &netErr) && !errors.Is(err, io.EOF) {
			err = fmt.Errorf("the server refused the bot's login (XMPP_JID, XMPP_PASSWORD): %w", err)
		}
		return mask, rw, err
	}
	return f
}

// run holds the connection until ctx is done: connect, join, serve; after a drop, again, after a backoff.
func (b *bridge) run(ctx context.Context) {
	go b.process(ctx)
	backoff := time.Second
	for ctx.Err() == nil {
		sess, err := b.connect(ctx)
		if err != nil {
			b.setConnected(nil, err.Error())
			log.Printf("xmpp: connect: %v (again in %s)", err, backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, 5*time.Minute)
			continue
		}
		backoff = time.Second
		log.Printf("xmpp: connected as %s", sess.LocalAddr())
		err = b.serve(ctx, sess)
		b.setConnected(nil, errText(err))
		log.Printf("xmpp: disconnected: %v", err)
	}
}

func errText(err error) string {
	if err == nil {
		return "disconnected"
	}
	return err.Error()
}

// serve uses sess until it drops (or ctx is done).
func (b *bridge) serve(ctx context.Context, sess *xmpp.Session) error {
	done := make(chan error, 1)
	go func() { done <- sess.Serve(xmpp.HandlerFunc(b.handle)) }()
	// Available, so the server passes us invitations; no priority games.
	if err := sess.Encode(ctx, outPresence{}); err != nil {
		sess.Close()
		return err
	}
	b.setConnected(sess, "")
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	selfPing := time.NewTicker(selfPingEvery)
	defer selfPing.Stop()
	b.joinAll(ctx)
	for {
		select {
		case <-ctx.Done():
			sess.Close()
			return ctx.Err()
		case err := <-done:
			sess.Conn().Close()
			return err
		case <-b.sync:
			b.joinAll(ctx)
		case <-ping.C:
			go func() {
				if _, err := b.iq(ctx, sess, jid.JID{}, "get", pingPayload()); err != nil && !isStanzaError(err) {
					log.Printf("xmpp: ping: %v", err)
					sess.Conn().Close() // Serve returns, and the connection is made again
				}
			}()
		case <-selfPing.C:
			b.selfPingAll(ctx, sess)
		}
	}
}

func (b *bridge) setConnected(sess *xmpp.Session, why string) {
	b.mu.Lock()
	b.sess, b.connected, b.connErr = sess, sess != nil, why
	if sess == nil {
		for _, r := range b.rooms {
			if r.state == stateJoined || r.state == stateJoining {
				r.state = ""
			}
			r.occupants = map[string]occupant{}
		}
	}
	b.mu.Unlock()
	poke(b.changed)
}

// joinAll sends a join for every conference that is to be joined.
func (b *bridge) joinAll(ctx context.Context) {
	b.mu.Lock()
	sess := b.sess
	var joins []outPresence
	for _, r := range b.rooms {
		if r.state != "" || sess == nil {
			continue
		}
		if r.nick == "" || r.tries == 0 {
			r.nick = b.cfg.nick
		}
		r.state = stateJoining
		joins = append(joins, r.joinPresence())
	}
	b.mu.Unlock()
	if len(joins) > 0 {
		poke(b.changed)
	}
	for _, p := range joins {
		if err := sess.Encode(ctx, p); err != nil {
			log.Printf("xmpp: join %s: %v", p.To, err)
		}
	}
}

// The presence that joins: with the history since the newest message seen, or none at all on the first join.
func (r *room) joinPresence() outPresence {
	join := &mucJoin{Password: r.password}
	if r.since.IsZero() {
		none := 0
		join.History.MaxStanzas = &none
	} else {
		join.History.Since = r.since.UTC().Format(time.RFC3339)
	}
	return outPresence{To: r.muc.String() + "/" + r.nick, Join: join}
}

// selfPingAll checks every joined conference still has us (XEP-0410): one that doesn't is joined again.
func (b *bridge) selfPingAll(ctx context.Context, sess *xmpp.Session) {
	b.mu.Lock()
	var targets []jid.JID
	for _, r := range b.rooms {
		if r.state == stateJoined {
			if to, err := r.muc.WithResource(r.nick); err == nil {
				targets = append(targets, to)
			}
		}
	}
	b.mu.Unlock()
	for _, to := range targets {
		go func() {
			_, err := b.iq(ctx, sess, to, "get", pingPayload())
			var se *stanzaError
			if err == nil || errors.As(err, &se) && (se.condition() == "service-unavailable" || se.condition() == "feature-not-implemented") {
				return
			}
			if !isStanzaError(err) && ctx.Err() == nil {
				return // a timeout: the server ping finds a dead connection
			}
			log.Printf("xmpp: self-ping %s: %v: joining again", to.Bare(), err)
			b.mu.Lock()
			if r := b.rooms[to.Bare().String()]; r != nil && r.state == stateJoined {
				r.state = ""
			}
			b.mu.Unlock()
			poke(b.sync)
		}()
	}
}

func pingPayload() xml.TokenReader {
	return xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsPing, Local: "ping"}})
}

func isStanzaError(err error) bool {
	var se *stanzaError
	return errors.As(err, &se)
}

func (e *stanzaError) Error() string {
	if t := e.text(); t != "" {
		return e.condition() + ": " + t
	}
	return e.condition()
}

// iq sends an IQ and waits for its reply (iqTimeout at most); an error reply is a *stanzaError.
func (b *bridge) iq(ctx context.Context, sess *xmpp.Session, to jid.JID, typ string, payload xml.TokenReader) (*iqReply, error) {
	ctx, cancel := context.WithTimeout(ctx, iqTimeout)
	defer cancel()
	resp, err := sess.SendIQElement(ctx, payload, stanza.IQ{To: to, Type: stanza.IQType(typ)})
	if err != nil {
		return nil, err
	}
	defer resp.Close()
	d := xml.NewTokenDecoder(resp)
	var reply iqReply
	if err := d.Decode(&reply); err != nil {
		return nil, err
	}
	if reply.Type == "error" {
		if reply.Error == nil {
			reply.Error = &stanzaError{}
		}
		return &reply, reply.Error
	}
	return &reply, nil
}

// ---------------------------------------------------------------- what comes in

// handle decodes each stanza and hands it to process, in order. It runs under Serve's lock, so it never sends
// (except an IQ's answer, on t).
func (b *bridge) handle(t xmlstream.TokenReadEncoder, start *xml.StartElement) error {
	// t is past the start element: put it back in front, so the decoder sees the whole stanza.
	d := xml.NewTokenDecoder(xmlstream.MultiReader(xmlstream.Token(*start), t))
	switch start.Name.Local {
	case "message":
		var m inMessage
		if err := d.Decode(&m); err != nil {
			return nil
		}
		b.in <- &m
	case "presence":
		var p inPresence
		if err := d.Decode(&p); err != nil {
			return nil
		}
		b.in <- &p
	case "iq":
		var iq inIQ
		if err := d.Decode(&iq); err != nil {
			return nil
		}
		return answerIQ(t, start, &iq)
	}
	return nil
}

// answerIQ answers pings and disco#info; Serve answers anything else not answered with service-unavailable.
func answerIQ(t xmlstream.TokenReadEncoder, start *xml.StartElement, iq *inIQ) error {
	if iq.Type != "get" {
		return nil
	}
	head, err := stanza.NewIQ(*start)
	if err != nil {
		return nil
	}
	switch {
	case iq.Ping != nil:
		_, err = xmlstream.Copy(t, head.Result(nil))
	case iq.Disco != nil && iq.Disco.Node == "":
		info := discoInfo{
			Identities: []discoIdentity{{Category: "client", Type: "bot", Name: "Chirkle"}},
			Features:   []discoFeature{{Var: nsDiscoInf}, {Var: nsPing}, {Var: nsSID}},
		}
		res := stanza.IQ{ID: head.ID, To: head.From, Type: stanza.ResultIQ}
		err = t.EncodeElement(struct {
			stanza.IQ
			Info discoInfo
		}{res, info}, res.StartElement())
	}
	return err
}

// process handles what came in, one stanza at a time.
func (b *bridge) process(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case s := <-b.in:
			switch s := s.(type) {
			case *inMessage:
				b.onMessage(ctx, s)
			case *inPresence:
				b.onPresence(ctx, s)
			}
		}
	}
}

func (b *bridge) onPresence(ctx context.Context, p *inPresence) {
	from, err := jid.Parse(p.From)
	if err != nil || from.Resourcepart() == "" {
		return
	}
	nick := from.Resourcepart()
	b.mu.Lock()
	r := b.rooms[from.Bare().String()]
	if r == nil {
		b.mu.Unlock()
		return
	}
	u := p.MUCUser
	self := u.has(statusSelf) || (r.state == stateJoining && nick == r.nick && p.Type != "error")
	var ev *event
	switch {
	case p.Type == "error":
		if r.state != stateJoining {
			break
		}
		cond := p.Error.condition()
		if cond == "conflict" && r.tries+1 < maxNickTries {
			r.tries++
			r.nick = b.cfg.nick + strconv.Itoa(r.tries+1)
			r.state = ""
			poke(b.sync)
		} else {
			r.state, r.err = stateError, joinError(p.Error)
		}
		poke(b.changed)
	case self && p.Type == "unavailable":
		if u.has(statusNickChange) {
			r.nick = u.item().Nick
			break
		}
		reason := ""
		switch {
		case u != nil && u.Destroy != nil:
			reason = "destroyed"
		case u.has(statusBanned):
			reason = "banned"
		case u.has(statusKicked):
			reason = "kicked"
		case u.has(statusAffil), u.has(statusMembers):
			reason = "removed"
		}
		if reason == "" {
			// Shut down, or dropped for an error (332, 333): joined again.
			r.state = ""
			poke(b.sync)
		} else {
			r.state, r.err = stateRemoved, reason
			ev = &event{Type: "kicked", MUC: r.muc.String(), Reason: reason}
		}
		poke(b.changed)
	case self:
		first := r.state != stateJoined
		r.state, r.err, r.nick = stateJoined, "", nick
		r.role = u.item().Role
		if first {
			poke(b.changed)
			if len(r.resend) > 0 {
				go b.resendRefused(ctx, r.muc)
			}
			if u.has(statusCreated) {
				// Nobody was in it: the bot made it, and it stays locked to everyone else until configured.
				go b.unlock(ctx, r.muc)
			}
			go b.fetchTitle(ctx, r.muc)
		}
	case p.Type == "unavailable":
		o := r.occupants[nick]
		delete(r.occupants, nick)
		if u.has(statusNickChange) && u.item().Nick != "" {
			newNick := u.item().Nick
			r.occupants[newNick] = o
			ev = &event{Type: "occupant", MUC: r.muc.String(), Nick: nick, NewNick: newNick, OccupantID: o.id, JID: o.jid}
		}
	case p.Type == "":
		known := r.occupants[nick]
		o := occupant{photo: known.photo}
		if j, err := jid.Parse(u.item().JID); err == nil && u.item().JID != "" {
			o.jid = j.Bare().String()
		}
		if p.OccupantID != nil {
			o.id = p.OccupantID.ID
		}
		// A new photo, or the first told this run: PocketBase fetches it if it hasn't got that one (at most daily).
		if p.Photo != nil && p.Photo.Hash != nil {
			hash := strings.ToLower(strings.TrimSpace(*p.Photo.Hash))
			if _, seen := r.occupants[nick]; hash != o.photo || !seen && hash != "" {
				ev = &event{Type: "photo", MUC: r.muc.String(), Nick: nick, OccupantID: o.id, JID: o.jid, Hash: hash}
			}
			o.photo = hash
		}
		r.occupants[nick] = o
	}
	b.mu.Unlock()
	if ev != nil {
		b.pb.send(*ev)
	}
}

// joinError says why the conference didn't let the bot in, for the link's status.
func joinError(e *stanzaError) string {
	switch e.condition() {
	case "not-authorized":
		return "the conference has a password, and the link's isn't it"
	case "forbidden":
		return "the bot is banned from the conference"
	case "registration-required":
		return "the conference is members-only, and the bot isn't a member"
	case "service-unavailable":
		return "the conference is full"
	case "item-not-found":
		return "no such conference (or it is locked, and only its owner may come in)"
	case "not-allowed":
		return "no such conference, and the bot may not make it"
	case "conflict":
		return "every nickname the bot tried is taken"
	}
	return e.Error()
}

// unlock opens a conference the bot made: the server's default configuration, as an instant room (XEP-0045 §10.1.2).
func (b *bridge) unlock(ctx context.Context, muc jid.JID) {
	b.mu.Lock()
	sess := b.sess
	b.mu.Unlock()
	if sess == nil {
		return
	}
	form := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsData, Local: "x"}, Attr: []xml.Attr{{Name: xml.Name{Local: "type"}, Value: "submit"}}})
	if _, err := b.iq(ctx, sess, muc, "set", xmlstream.Wrap(form, xml.StartElement{Name: xml.Name{Space: nsMUCOwner, Local: "query"}})); err != nil {
		log.Printf("xmpp: %s: couldn't open the conference the bot made: %v", muc, err)
	}
}

// fetchTitle asks the conference its name (disco#info), for the link's title.
func (b *bridge) fetchTitle(ctx context.Context, muc jid.JID) {
	b.mu.Lock()
	sess := b.sess
	b.mu.Unlock()
	if sess == nil {
		return
	}
	payload := xmlstream.Wrap(nil, xml.StartElement{Name: xml.Name{Space: nsDiscoInf, Local: "query"}})
	reply, err := b.iq(ctx, sess, muc, "get", payload)
	if err != nil || reply.Disco == nil {
		return
	}
	feats := map[string]bool{}
	for _, f := range reply.Disco.Features {
		feats[f.Var] = true
	}
	b.mu.Lock()
	if r := b.rooms[muc.String()]; r != nil {
		r.feats = feats
	}
	b.mu.Unlock()
	for _, id := range reply.Disco.Identities {
		if id.Category == "conference" && strings.TrimSpace(id.Name) != "" {
			b.mu.Lock()
			if r := b.rooms[muc.String()]; r != nil {
				r.title = strings.TrimSpace(id.Name)
			}
			b.mu.Unlock()
			poke(b.changed)
			return
		}
	}
}

func (b *bridge) onMessage(ctx context.Context, m *inMessage) {
	from, err := jid.Parse(m.From)
	if err != nil {
		return
	}
	bare := from.Bare().String()

	// An invitation: through the conference (mediated), or straight from someone (XEP-0249).
	if m.MUCUser != nil && m.MUCUser.Invite != nil {
		b.pb.send(event{Type: "invite", MUC: bare, From: bareOf(m.MUCUser.Invite.From), Password: m.MUCUser.Password})
		return
	}
	if m.Conference != nil && m.Conference.JID != "" {
		if muc, err := jid.Parse(m.Conference.JID); err == nil {
			b.pb.send(event{Type: "invite", MUC: muc.Bare().String(), From: bare, Password: m.Conference.Password})
		}
		return
	}

	b.mu.Lock()
	r := b.rooms[bare]
	b.mu.Unlock()

	switch m.Type {
	case "groupchat":
		if r == nil || m.Retracted != nil {
			return // not ours; what's left of a retracted message in history
		}
		if b.retraction(r, from.Resourcepart(), m) {
			return
		}
		if m.Reactions != nil {
			b.reactions(r, from.Resourcepart(), m)
			return
		}
		if from.Resourcepart() == "" || m.Body == nil || strings.TrimSpace(*m.Body) == "" {
			return // the conference itself, a subject, a typing notice
		}
		b.groupMessage(r, from.Resourcepart(), m)
	case "error":
		// A message the conference refused: not in it any more, most likely. Joined again.
		if r != nil {
			log.Printf("xmpp: %s refused a message: %v", bare, m.Error)
			b.mu.Lock()
			if m.Error.condition() == "not-acceptable" {
				// Sent again once in: the join below, or one going already.
				r.refused(m.ID)
				if r.state == stateJoined {
					r.state = ""
					poke(b.sync)
				}
			}
			b.mu.Unlock()
		}
	case "chat", "normal", "":
		if m.Body != nil && strings.TrimSpace(*m.Body) != "" && m.Delay == nil {
			go b.answerPrivate(ctx, from) // not here: a send waits for Serve, which may be waiting for this loop
		}
	}
}

func bareOf(s string) string {
	j, err := jid.Parse(s)
	if err != nil {
		return ""
	}
	return j.Bare().String()
}

func (b *bridge) groupMessage(r *room, nick string, m *inMessage) {
	b.mu.Lock()
	if r.state == stateRemoved {
		b.mu.Unlock()
		return
	}
	at := time.Now()
	stamp := ""
	if m.Delay != nil {
		if t, err := time.Parse(time.RFC3339Nano, m.Delay.Stamp); err == nil {
			at, stamp = t, t.UTC().Format(time.RFC3339Nano)
		}
	}
	if at.After(r.since) {
		r.since = at
	}
	o := r.occupants[nick]
	ev := event{
		Type:     "message",
		MUC:      r.muc.String(),
		ID:       m.ID,
		StanzaID: m.stanzaIDBy(r.muc.String()),
		Nick:     nick,
		JID:      o.jid,
		Body:     *m.Body,
		Delay:    stamp,
		Self:     nick == r.nick,
	}
	b.mu.Unlock()
	if m.Reply != nil && m.Reply.ID != "" {
		ev.ReplyID, ev.ReplyBody = m.Reply.ID, m.withoutFallback(nsReply)
		if to, err := jid.Parse(m.Reply.To); err == nil {
			ev.ReplyTo = to.Resourcepart()
		}
	}
	if m.Replace != nil {
		ev.Replace = m.Replace.ID
	}
	for _, o := range m.OOB {
		if u := strings.TrimSpace(o.URL); u != "" {
			ev.OOB = append(ev.OOB, u)
		}
	}
	ev.Encrypted = m.encrypted()
	if m.OriginID != nil {
		ev.OriginID = m.OriginID.ID
	}
	ev.OccupantID = o.id
	if m.OccupantID != nil {
		ev.OccupantID = m.OccupantID.ID
	}
	b.pb.send(ev)
}

// retraction passes on a retraction (XEP-0424) or a moderator's (XEP-0425), in either version, and says whether m
// was one. Its body is only for clients that don't know them.
func (b *bridge) retraction(r *room, nick string, m *inMessage) bool {
	ev := event{Type: "retraction", MUC: r.muc.String(), Nick: nick}
	switch {
	case m.Retract != nil:
		ev.Target, ev.Moderated = m.Retract.ID, m.Retract.Moderated != nil
	case m.ApplyTo != nil && m.ApplyTo.Moderated != nil:
		ev.Target, ev.Moderated = m.ApplyTo.ID, true
	case m.ApplyTo != nil && m.ApplyTo.Retract != nil:
		ev.Target = m.ApplyTo.ID
	default:
		return false
	}
	// A moderator's comes from the conference itself; an author's, from them.
	if ev.Target == "" || ev.Moderated != (nick == "") {
		return true
	}
	b.mu.Lock()
	o := r.occupants[nick]
	ev.Self = nick != "" && nick == r.nick
	b.mu.Unlock()
	ev.JID, ev.OccupantID = o.jid, o.id
	if m.OccupantID != nil {
		ev.OccupantID = m.OccupantID.ID
	}
	b.pb.send(ev)
	return true
}

// reactions passes on someone's set of reactions on a message (XEP-0444): all of them, so none is the same as
// taking them all back.
func (b *bridge) reactions(r *room, nick string, m *inMessage) {
	if nick == "" || m.Reactions.ID == "" {
		return
	}
	b.mu.Lock()
	o := r.occupants[nick]
	ev := event{Type: "reactions", MUC: r.muc.String(), Nick: nick, JID: o.jid, OccupantID: o.id, Target: m.Reactions.ID, Self: nick == r.nick}
	b.mu.Unlock()
	if m.OccupantID != nil {
		ev.OccupantID = m.OccupantID.ID
	}
	ev.Emoji = []string{}
	for _, e := range m.Reactions.Reactions {
		if e = strings.TrimSpace(e); e != "" && len(ev.Emoji) < 50 {
			ev.Emoji = append(ev.Emoji, e)
		}
	}
	b.pb.send(ev)
}

// answerPrivate tells someone writing to the bot directly that it works in conferences: once an hour at most.
func (b *bridge) answerPrivate(ctx context.Context, from jid.JID) {
	key := from.String()
	b.mu.Lock()
	sess := b.sess
	last, ok := b.answered[key]
	if sess == nil || ok && time.Since(last) < pmReplyEvery {
		b.mu.Unlock()
		return
	}
	b.answered[key] = time.Now()
	b.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	sess.Encode(ctx, outMessage{To: key, Type: "chat", Body: pmReply})
}

// ---------------------------------------------------------------- what goes out

// A send that failed; transient when it may work later (not connected, not in the conference yet).
type sendError struct {
	msg       string
	transient bool
}

func (e *sendError) Error() string { return e.msg }

// What a message sent to a conference is, besides its text: a reply (with the code points of the quote over it), a
// correction of the message sent as `replace`, a retraction of one.
type sendOptions struct {
	Reply *struct {
		ID  string `json:"id"`
		To  string `json:"to"`
		End int    `json:"end"`
	} `json:"reply"`
	Replace string `json:"replace"`
	Retract *struct {
		StanzaID string `json:"stanza_id"`
		OriginID string `json:"origin_id"`
	} `json:"retract"`
	// A file's link, which is also the body: clients show it inline (XEP-0066).
	OOB string `json:"oob"`
	// The bot's whole set of reactions on the message the conference knows by id (XEP-0444); the body is ignored.
	React *struct {
		ID    string   `json:"id"`
		Emoji []string `json:"emoji"`
	} `json:"react"`
}

// sendGroup sends body to a joined conference, with id as both its id and its origin-id (XEP-0359): the conference's
// echo of it carries the id, so PocketBase knows it is ours.
func (b *bridge) sendGroup(ctx context.Context, muc, id, body string, opt sendOptions) error {
	j, err := jid.Parse(muc)
	if err != nil {
		return &sendError{msg: "not a conference address"}
	}
	b.mu.Lock()
	sess := b.sess
	r := b.rooms[j.Bare().String()]
	joined := r != nil && r.state == stateJoined
	b.mu.Unlock()
	if sess == nil {
		return &sendError{msg: "not connected", transient: true}
	}
	if r == nil {
		return &sendError{msg: "not a linked conference"}
	}
	if !joined {
		return &sendError{msg: "not in the conference", transient: true}
	}
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	msg := outMessage{To: r.muc.String(), ID: id, Type: "groupchat", Body: body, OriginID: &outID{ID: id}}
	if opt.Reply != nil && opt.Reply.ID != "" {
		msg.Reply = &outReply{ID: opt.Reply.ID}
		if opt.Reply.To != "" {
			msg.Reply.To = r.muc.String() + "/" + opt.Reply.To
		}
		if opt.Reply.End > 0 {
			msg.Fallbacks = append(msg.Fallbacks, outFallback{For: nsReply, Bodies: []outFallbackR{{Start: 0, End: opt.Reply.End}}})
		}
	}
	if opt.Replace != "" {
		msg.Replace = &outReplace{ID: opt.Replace}
	}
	if opt.Retract != nil {
		// Version 1 names the conference's stanza id; the versions before, the origin id. Both, for every client.
		if opt.Retract.StanzaID != "" {
			msg.Retract = &outRetract{ID: opt.Retract.StanzaID}
		}
		if opt.Retract.OriginID != "" {
			msg.ApplyTo = &outApplyTo{ID: opt.Retract.OriginID}
		}
		msg.Fallbacks = append(msg.Fallbacks, outFallback{For: nsRetract})
		msg.Store = &outStore{}
	}
	if opt.OOB != "" {
		msg.OOB = &outOOB{URL: opt.OOB}
	}
	if opt.React != nil {
		// No body: a reaction is only the element (XEP-0444 §3). Kept in the archives, as a retraction is.
		msg.Body = ""
		msg.Reactions = &outReactions{ID: opt.React.ID, Reactions: opt.React.Emoji}
		msg.Store = &outStore{}
	}
	if err := sess.Encode(ctx, msg); err != nil {
		return &sendError{msg: err.Error(), transient: true}
	}
	b.mu.Lock()
	r.sent = append(r.sent, sentStanza{msg: msg, at: time.Now()})
	if len(r.sent) > sentKeep {
		r.sent = r.sent[len(r.sent)-sentKeep:]
	}
	b.mu.Unlock()
	return nil
}

// refused takes a stanza the conference refused off the sent list, to send again once the bot is back in. Under b.mu.
func (r *room) refused(id string) {
	for i, s := range r.sent {
		if s.msg.ID == id {
			if time.Since(s.at) <= sentFor {
				r.resend = append(r.resend, s.msg)
			}
			r.sent = append(r.sent[:i:i], r.sent[i+1:]...)
			return
		}
	}
}

// resendRefused sends again what the conference refused while it had forgotten the bot, now that it is back in.
func (b *bridge) resendRefused(ctx context.Context, muc jid.JID) {
	b.mu.Lock()
	sess := b.sess
	r := b.rooms[muc.String()]
	if r == nil || sess == nil || r.state != stateJoined {
		b.mu.Unlock()
		return
	}
	pending := r.resend
	r.resend = nil
	b.mu.Unlock()
	for i, msg := range pending {
		sctx, cancel := context.WithTimeout(ctx, sendTimeout)
		err := sess.Encode(sctx, msg)
		cancel()
		if err != nil {
			log.Printf("xmpp: %s: sending again: %v", muc, err)
			b.mu.Lock()
			r.resend = append(pending[i:], r.resend...)
			b.mu.Unlock()
			return
		}
		b.mu.Lock()
		r.sent = append(r.sent, sentStanza{msg: msg, at: time.Now()})
		b.mu.Unlock()
	}
}

// status is everything a status event says.
func (b *bridge) status(boot string) event {
	b.mu.Lock()
	defer b.mu.Unlock()
	connected := b.connected
	ev := event{Type: "status", Boot: boot, Connected: &connected, Rooms: []roomStatus{}}
	if !connected {
		ev.Error = b.connErr
	}
	for _, r := range b.rooms {
		state := r.state
		if state == "" {
			state = stateJoining
		}
		ev.Rooms = append(ev.Rooms, roomStatus{MUC: r.muc.String(), Key: r.key, State: state, Error: r.err, Nick: r.nick, Title: r.title})
	}
	return ev
}
