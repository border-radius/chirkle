package main

// The child against an in-process XMPP server (TLS, SASL PLAIN, a resource, and a small conference service) and a
// stub PocketBase that records the events: joining, nicknames taken, messages both ways, the echo of our own,
// renames, invitations, being kicked, private messages, and joining again after the connection drops.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/xml"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mellium.im/sasl"
	"mellium.im/xmlstream"
	"mellium.im/xmpp"
	"mellium.im/xmpp/jid"
)

const (
	domain = "example.test"
	muc    = "room@conf.example.test"
)

// ---------------------------------------------------------------- a stub PocketBase

type stubPB struct {
	*httptest.Server
	mu     sync.Mutex
	events []event
}

func newStubPB(t *testing.T) *stubPB {
	s := &stubPB{}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/files/") {
			// A message's file, as PocketBase serves it: no secret, the URL is one.
			if strings.HasSuffix(r.URL.Path, "/big.bin") {
				w.Write(make([]byte, 2000))
				return
			}
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte("PNGDATA"))
			return
		}
		if r.Header.Get(secretHeader) != "s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var ev event
		json.NewDecoder(r.Body).Decode(&ev)
		s.mu.Lock()
		s.events = append(s.events, ev)
		s.mu.Unlock()
		w.Write([]byte("{}"))
	}))
	t.Cleanup(s.Close)
	return s
}

// waitFor returns the first event that ok takes.
func (s *stubPB) waitFor(t *testing.T, what string, ok func(event) bool) event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for _, ev := range s.events {
			if ok(ev) {
				s.mu.Unlock()
				return ev
			}
		}
		s.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no %s event", what)
	return event{}
}

func roomState(ev event, state string) bool {
	if ev.Type != "status" {
		return false
	}
	for _, r := range ev.Rooms {
		if r.MUC == muc && r.State == state {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- a stub XMPP server

type stubXMPP struct {
	t   *testing.T
	ln  net.Listener
	tls *tls.Config

	mu       sync.Mutex
	sess     *xmpp.Session
	client   string      // the bot's full address
	joins    []string    // presences to the conference, as "to|since"
	received []inMessage // what the bot sent
	sessions int

	upload    string // the upload service's HTTP base ("": the server has none)
	uploadMax int
	slots     []string // the requests, as "filename|size|content-type"

	moderations []string // the moderate IQs, as "version|id|reason"
}

func newStubXMPP(t *testing.T) *stubXMPP {
	s := &stubXMPP{t: t, tls: selfSigned(t)}
	var err error
	s.ln, err = net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.ln.Close() })
	go s.accept()
	return s
}

func (s *stubXMPP) accept() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.session(conn)
	}
}

func (s *stubXMPP) session(conn net.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sess, err := xmpp.ReceiveClientSession(ctx, jid.MustParse(domain), conn,
		xmpp.StartTLS(s.tls),
		xmpp.SASLServer(func(n *sasl.Negotiator) bool {
			user, pass, _ := n.Credentials()
			return string(user) == "bot" && string(pass) == "pw"
		}, sasl.Plain),
		xmpp.BindResource(),
	)
	if err != nil {
		s.t.Logf("stub session: %v", err)
		conn.Close()
		return
	}
	s.mu.Lock()
	s.sess, s.client = sess, sess.RemoteAddr().String()
	s.sessions++
	s.mu.Unlock()
	sess.Serve(xmpp.HandlerFunc(func(tr xmlstream.TokenReadEncoder, start *xml.StartElement) error {
		d := xml.NewTokenDecoder(xmlstream.MultiReader(xmlstream.Token(*start), tr))
		switch start.Name.Local {
		case "iq":
			// The conference's name, for disco#info.
			var iq struct {
				ID      string      `xml:"id,attr"`
				From    string      `xml:"from,attr"`
				To      string      `xml:"to,attr"`
				Type    string      `xml:"type,attr"`
				Disco   *discoInfo  `xml:"http://jabber.org/protocol/disco#info query"`
				Items   *discoItems `xml:"http://jabber.org/protocol/disco#items query"`
				Request *struct {
					Filename string `xml:"filename,attr"`
					Size     string `xml:"size,attr"`
					Type     string `xml:"content-type,attr"`
				} `xml:"urn:xmpp:http:upload:0 request"`
				Moderate *struct {
					ID     string `xml:"id,attr"`
					Reason string `xml:"reason"`
				} `xml:"urn:xmpp:message-moderate:1 moderate"`
				ApplyTo *struct {
					ID       string `xml:"id,attr"`
					Moderate *struct {
						Reason string `xml:"reason"`
					} `xml:"urn:xmpp:message-moderate:0 moderate"`
				} `xml:"urn:xmpp:fasten:0 apply-to"`
				VCard *struct{} `xml:"vcard-temp vCard"`
			}
			d.Decode(&iq)
			s.mu.Lock()
			upload, max := s.upload, s.uploadMax
			s.mu.Unlock()
			answer := func(from, inner string) error {
				_, err := xmlstream.Copy(tr, xml.NewDecoder(strings.NewReader(`<iq type='result' id='`+iq.ID+`' from='`+from+`' to='`+s.client+`'>`+inner+`</iq>`)))
				return err
			}
			const svc = "upload." + domain
			switch {
			case iq.Type == "get" && iq.To == domain && iq.Items != nil:
				items := "<item jid='conf." + domain + "'/>"
				if upload != "" {
					items += "<item jid='" + svc + "'/>"
				}
				return answer(domain, `<query xmlns='http://jabber.org/protocol/disco#items'>`+items+`</query>`)
			case iq.Type == "get" && iq.To == svc && iq.Disco != nil:
				return answer(svc, `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='store' type='file'/>`+
					`<feature var='urn:xmpp:http:upload:0'/><x xmlns='jabber:x:data' type='result'>`+
					`<field var='FORM_TYPE' type='hidden'><value>urn:xmpp:http:upload:0</value></field>`+
					`<field var='max-file-size'><value>`+strconv.Itoa(max)+`</value></field></x></query>`)
			case iq.Type == "get" && iq.To == svc && iq.Request != nil:
				s.mu.Lock()
				s.slots = append(s.slots, iq.Request.Filename+"|"+iq.Request.Size+"|"+iq.Request.Type)
				s.mu.Unlock()
				return answer(svc, `<slot xmlns='urn:xmpp:http:upload:0'><put url='`+upload+`/put/`+iq.Request.Filename+`'>`+
					`<header name='Authorization'>Bearer t0k</header><header name='X-Evil'>no</header></put>`+
					`<get url='`+upload+`/get/`+iq.Request.Filename+`'/></slot>`)
			case iq.Type == "get" && iq.Disco != nil && iq.To != muc:
				// The server itself, the conference service: no uploads.
				return answer(iq.To, `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='server' type='im'/></query>`)
			}
			if iq.Type == "get" && iq.To == muc && iq.Disco != nil {
				_, err := xmlstream.Copy(tr, xml.NewDecoder(strings.NewReader(`<iq type='result' id='`+iq.ID+`' from='`+muc+`' to='`+s.client+`'>`+
					`<query xmlns='http://jabber.org/protocol/disco#info'><identity category='conference' type='text' name='Friends'/>`+
					`<feature var='urn:xmpp:message-moderate:1'/></query></iq>`)))
				return err
			}
			if iq.Type == "set" && iq.To == muc && (iq.Moderate != nil || iq.ApplyTo != nil) {
				s.mu.Lock()
				if iq.Moderate != nil {
					s.moderations = append(s.moderations, "1|"+iq.Moderate.ID+"|"+iq.Moderate.Reason)
				} else if iq.ApplyTo.Moderate != nil {
					s.moderations = append(s.moderations, "0|"+iq.ApplyTo.ID+"|"+iq.ApplyTo.Moderate.Reason)
				}
				s.mu.Unlock()
				_, err := xmlstream.Copy(tr, xml.NewDecoder(strings.NewReader(`<iq type='result' id='`+iq.ID+`' from='`+muc+`' to='`+s.client+`'/>`)))
				return err
			}
			if iq.Type == "get" && iq.VCard != nil {
				photo := ""
				if iq.To == muc+"/Ann" {
					photo = "<PHOTO><TYPE>image/png</TYPE><BINVAL>UE5H\n REFUQQ==</BINVAL></PHOTO>" // "PNGDATA", wrapped
				}
				_, err := xmlstream.Copy(tr, xml.NewDecoder(strings.NewReader(`<iq type='result' id='`+iq.ID+`' from='`+iq.To+`' to='`+s.client+`'>`+
					`<vCard xmlns='vcard-temp'>`+photo+`</vCard></iq>`)))
				return err
			}
		case "presence":
			var p struct {
				To   string   `xml:"to,attr"`
				Type string   `xml:"type,attr"`
				Join *mucJoin `xml:"http://jabber.org/protocol/muc x"`
			}
			d.Decode(&p)
			if !strings.HasPrefix(p.To, muc+"/") {
				return nil
			}
			since := ""
			if p.Join != nil {
				since = p.Join.History.Since
				if p.Join.History.MaxStanzas != nil {
					since = "none"
				}
			}
			s.mu.Lock()
			s.joins = append(s.joins, p.To+"|"+since)
			s.mu.Unlock()
		case "message":
			var m inMessage
			d.Decode(&m)
			s.mu.Lock()
			s.received = append(s.received, m)
			s.mu.Unlock()
		}
		return nil
	}))
}

// raw sends XML to the bot as it is.
func (s *stubXMPP) raw(x string) {
	s.t.Helper()
	s.mu.Lock()
	sess := s.sess
	s.mu.Unlock()
	d := xml.NewDecoder(strings.NewReader(x))
	if err := sess.Send(context.Background(), d); err != nil {
		s.t.Fatal(err)
	}
}

func (s *stubXMPP) to() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

func (s *stubXMPP) waitJoin(t *testing.T, n int) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		if len(s.joins) >= n {
			j := s.joins[n-1]
			s.mu.Unlock()
			return j
		}
		s.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no join %d", n)
	return ""
}

func (s *stubXMPP) waitReceived(t *testing.T, n int) inMessage {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		if len(s.received) >= n {
			m := s.received[n-1]
			s.mu.Unlock()
			return m
		}
		s.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no message %d", n)
	return inMessage{}
}

func selfSigned(t *testing.T) *tls.Config {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

// ---------------------------------------------------------------- the tests

func start(t *testing.T) (*bridge, *stubPB, *stubXMPP) {
	pb := newStubPB(t)
	srv := newStubXMPP(t)
	cfg := settings{
		jid:        jid.MustParse("bot@" + domain),
		password:   "pw",
		nick:       "Chirkle",
		tls:        &tls.Config{InsecureSkipVerify: true, ServerName: domain},
		mechanisms: []sasl.Mechanism{sasl.Plain},
		dial: func(ctx context.Context) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", srv.ln.Addr().String())
		},
	}
	p := newPocketBase(pb.URL, "", "s3cret")
	b := newBridge(cfg, p)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go p.run(ctx)
	go b.run(ctx)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-b.changed:
				p.postNow(ctx, b.status("boot"))
			}
		}
	}()
	return b, pb, srv
}

// join has the bot join the conference and the stub accept it, as nick.
func join(t *testing.T, b *bridge, pb *stubPB, srv *stubXMPP, n int, nick string) {
	t.Helper()
	srv.waitJoin(t, n)
	srv.raw(`<presence from='` + muc + `/Ann' to='` + srv.to() + `'><occupant-id xmlns='urn:xmpp:occupant-id:0' id='oid-ann'/>` +
		`<x xmlns='http://jabber.org/protocol/muc#user'><item jid='ann@` + domain + `/phone' affiliation='member' role='participant'/></x></presence>`)
	srv.raw(`<presence from='` + muc + `/` + nick + `' to='` + srv.to() + `'><x xmlns='http://jabber.org/protocol/muc#user'>` +
		`<item affiliation='none' role='participant'/><status code='110'/></x></presence>`)
	pb.waitFor(t, "joined", func(ev event) bool { return roomState(ev, stateJoined) })
}

func title(ev event) string {
	for _, r := range ev.Rooms {
		if r.MUC == muc {
			return r.Title
		}
	}
	return ""
}

func TestJoinAndMessages(t *testing.T) {
	b, pb, srv := start(t)
	if err := b.setRooms([]wantedRoom{{MUC: muc, Key: "k1"}}); err != nil {
		t.Fatal(err)
	}
	if j := srv.waitJoin(t, 1); j != muc+"/Chirkle|none" {
		t.Fatalf("first join asks for no history: %q", j)
	}
	join(t, b, pb, srv, 1, "Chirkle")
	pb.waitFor(t, "title", func(ev event) bool { return ev.Type == "status" && title(ev) == "Friends" })

	// The server pings us: answered.
	srv.mu.Lock()
	sess := srv.sess
	srv.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := sess.SendIQ(ctx, xml.NewDecoder(strings.NewReader(`<iq type='get' id='p1' to='`+srv.to()+`'><ping xmlns='urn:xmpp:ping'/></iq>`)))
	if err != nil {
		t.Fatal(err)
	}
	var pong iqReply
	if err := xml.NewTokenDecoder(resp).Decode(&pong); err != nil || pong.Type != "result" {
		t.Fatalf("ping answer: %+v %v", pong, err)
	}
	resp.Close()

	// Someone writes: their occupant id, and their address (known from their presence).
	srv.raw(`<message type='groupchat' from='` + muc + `/Ann' to='` + srv.to() + `' id='m1'><body>hello</body>` +
		`<stanza-id xmlns='urn:xmpp:sid:0' by='` + muc + `' id='sid-1'/><occupant-id xmlns='urn:xmpp:occupant-id:0' id='oid-ann'/></message>`)
	ev := pb.waitFor(t, "message", func(ev event) bool { return ev.Type == "message" })
	if ev.Body != "hello" || ev.StanzaID != "sid-1" || ev.Nick != "Ann" || ev.OccupantID != "oid-ann" || ev.JID != "ann@"+domain || ev.Self {
		t.Fatalf("message: %+v", ev)
	}
	// The subject, and a typing notice, are not messages.
	srv.raw(`<message type='groupchat' from='` + muc + `/Ann' to='` + srv.to() + `'><subject>Topic</subject></message>`)

	// We write: id and origin-id are PocketBase's, and the echo says it is ours.
	if err := b.sendGroup(context.Background(), muc, "msg123", "Bob: hi", sendOptions{}); err != nil {
		t.Fatal(err)
	}
	sent := srv.waitReceived(t, 1)
	if sent.Type != "groupchat" || sent.Body == nil || *sent.Body != "Bob: hi" || sent.OriginID == nil || sent.OriginID.ID != "msg123" {
		t.Fatalf("sent: %+v", sent)
	}
	srv.raw(`<message type='groupchat' from='` + muc + `/Chirkle' to='` + srv.to() + `' id='msg123'><body>Bob: hi</body>` +
		`<origin-id xmlns='urn:xmpp:sid:0' id='msg123'/><stanza-id xmlns='urn:xmpp:sid:0' by='` + muc + `' id='sid-2'/></message>`)
	echo := pb.waitFor(t, "echo", func(ev event) bool { return ev.Type == "message" && ev.Self })
	if echo.OriginID != "msg123" || echo.StanzaID != "sid-2" {
		t.Fatalf("echo: %+v", echo)
	}

	// A rename (303).
	srv.raw(`<presence type='unavailable' from='` + muc + `/Ann' to='` + srv.to() + `'><x xmlns='http://jabber.org/protocol/muc#user'>` +
		`<item nick='Annie' affiliation='member' role='participant'/><status code='303'/></x></presence>`)
	ren := pb.waitFor(t, "occupant", func(ev event) bool { return ev.Type == "occupant" })
	if ren.Nick != "Ann" || ren.NewNick != "Annie" || ren.OccupantID != "oid-ann" {
		t.Fatalf("rename: %+v", ren)
	}

	// A conference we're not in can't be written to; one not joined yet is "for now".
	err = b.sendGroup(context.Background(), "other@conf."+domain, "x", "y", sendOptions{})
	if se, ok := err.(*sendError); !ok || se.transient {
		t.Fatalf("unlinked conference: %v", err)
	}

	// A private message is answered.
	srv.raw(`<message type='chat' from='carol@` + domain + `/pc' to='` + srv.to() + `'><body>hey bot</body></message>`)
	pm := srv.waitReceived(t, 2)
	if pm.Type != "chat" || pm.Body == nil || *pm.Body != pmReply {
		t.Fatalf("private answer: %+v", pm)
	}
}

func TestNickTakenKickedAndInvites(t *testing.T) {
	b, pb, srv := start(t)
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k1"}})
	srv.waitJoin(t, 1)
	srv.raw(`<presence type='error' from='` + muc + `/Chirkle' to='` + srv.to() + `'><error type='cancel'>` +
		`<conflict xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></presence>`)
	if j := srv.waitJoin(t, 2); !strings.HasPrefix(j, muc+"/Chirkle2|") {
		t.Fatalf("second try: %q", j)
	}
	join(t, b, pb, srv, 2, "Chirkle2")

	srv.raw(`<presence type='unavailable' from='` + muc + `/Chirkle2' to='` + srv.to() + `'><x xmlns='http://jabber.org/protocol/muc#user'>` +
		`<item affiliation='none' role='none'/><status code='307'/><status code='110'/></x></presence>`)
	k := pb.waitFor(t, "kicked", func(ev event) bool { return ev.Type == "kicked" })
	if k.MUC != muc || k.Reason != "kicked" {
		t.Fatalf("kicked: %+v", k)
	}
	pb.waitFor(t, "removed", func(ev event) bool { return roomState(ev, stateRemoved) })

	srv.raw(`<message from='` + muc + `' to='` + srv.to() + `'><x xmlns='http://jabber.org/protocol/muc#user'>` +
		`<invite from='ann@` + domain + `/phone'><reason>join us</reason></invite><password>pw</password></x></message>`)
	inv := pb.waitFor(t, "invite", func(ev event) bool { return ev.Type == "invite" && ev.MUC == muc })
	if inv.From != "ann@"+domain || inv.Password != "pw" {
		t.Fatalf("invite: %+v", inv)
	}
	srv.raw(`<message from='dan@` + domain + `/x' to='` + srv.to() + `'><x xmlns='jabber:x:conference' jid='other@conf.` + domain + `'/></message>`)
	pb.waitFor(t, "direct invite", func(ev event) bool {
		return ev.Type == "invite" && ev.MUC == "other@conf."+domain && ev.From == "dan@"+domain
	})
}

func TestRejoinAfterDrop(t *testing.T) {
	b, pb, srv := start(t)
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k1", Since: "2026-11-01T10:00:00Z"}})
	if j := srv.waitJoin(t, 1); j != muc+"/Chirkle|2026-11-01T10:00:00Z" {
		t.Fatalf("join with history since: %q", j)
	}
	join(t, b, pb, srv, 1, "Chirkle")
	srv.raw(`<message type='groupchat' from='` + muc + `/Ann' to='` + srv.to() + `'><body>old</body>` +
		`<delay xmlns='urn:xmpp:delay' stamp='2026-11-02T12:00:00Z'/></message>`)
	ev := pb.waitFor(t, "delayed message", func(ev event) bool { return ev.Type == "message" })
	if ev.Delay != "2026-11-02T12:00:00Z" {
		t.Fatalf("delay: %+v", ev)
	}

	srv.mu.Lock()
	srv.sess.Conn().Close()
	srv.mu.Unlock()
	pb.waitFor(t, "disconnected", func(ev event) bool { return ev.Type == "status" && ev.Connected != nil && !*ev.Connected })
	// Joined again, with the history since the newest message seen.
	if j := srv.waitJoin(t, 2); j != muc+"/Chirkle|2026-11-02T12:00:00Z" {
		t.Fatalf("join again: %q", j)
	}

	// Asked again while in it (the link saved): it stays in. A conference no longer wanted is left.
	join(t, b, pb, srv, 2, "Chirkle")
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k2"}})
	time.Sleep(300 * time.Millisecond)
	b.setRooms(nil)
	if j := srv.waitJoin(t, 3); j != muc+"/Chirkle|" {
		t.Fatalf("only the leave: %q", j)
	}
}

func TestAPISecret(t *testing.T) {
	b, _, _ := start(t)
	h := httptest.NewServer(b.api("s3cret"))
	defer h.Close()
	post := func(path, secret, body string) int {
		req, _ := http.NewRequest("POST", h.URL+path, strings.NewReader(body))
		req.Header.Set(secretHeader, secret)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return res.StatusCode
	}
	if c := post("/rooms", "wrong", `{"rooms":[]}`); c != 401 {
		t.Fatalf("wrong secret: %d", c)
	}
	if c := post("/rooms", "s3cret", `{"rooms":[{"muc":"not a jid@@"}]}`); c != 400 {
		t.Fatalf("bad address: %d", c)
	}
	if c := post("/rooms", "s3cret", `{"rooms":[{"muc":"`+muc+`","key":"k"}]}`); c != 200 {
		t.Fatalf("rooms: %d", c)
	}
	if c := post("/send", "s3cret", `{"muc":"`+muc+`","id":"a","body":"b"}`); c != 503 {
		t.Fatalf("not joined yet is for now: %d", c)
	}
}

// The child exits once its standard input closes: PocketBase gone.
func TestExitsOnStdinEOF(t *testing.T) {
	if os.Getenv("XB_CHILD") == "1" {
		main()
		return
	}
	pb := newStubPB(t)
	cmd := exec.Command(os.Args[0], "-test.run=TestExitsOnStdinEOF")
	cmd.Env = append(os.Environ(), "XB_CHILD=1", "XMPP_JID=bot@127.0.0.1", "XMPP_PASSWORD=pw", "XMPP_SERVER=127.0.0.1:1",
		"CHIRKLE_XMPP_IN="+pb.URL, "CHIRKLE_XMPP_SECRET=s3cret")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	hello := pb.waitFor(t, "hello", func(ev event) bool { return ev.Type == "hello" })
	if hello.Protocol != protocol || hello.Port == 0 || hello.Boot == "" {
		t.Fatalf("hello: %+v", hello)
	}
	stdin.Close()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cmd.Process.Kill()
		t.Fatal("still running after stdin closed")
	}
}

func TestRepliesCorrectionsRetractions(t *testing.T) {
	b, pb, srv := start(t)
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k1"}})
	join(t, b, pb, srv, 1, "Chirkle")
	from := `from='` + muc + `/Ann' to='` + srv.to() + `'`

	// A reply: the quote over it is the fallback, in code points ("é" is one).
	srv.raw(`<message type='groupchat' ` + from + ` id='r1'><body>&gt; Bob: café
yes!</body><reply xmlns='urn:xmpp:reply:0' to='` + muc + `/Chirkle' id='sid-9'/>` +
		`<fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:reply:0'><body start='0' end='12'/></fallback></message>`)
	r := pb.waitFor(t, "reply", func(ev event) bool { return ev.Type == "message" && ev.ID == "r1" })
	if r.ReplyID != "sid-9" || r.ReplyTo != "Chirkle" || r.ReplyBody != "yes!" || !strings.HasPrefix(r.Body, "> Bob: café") {
		t.Fatalf("reply: %+v", r)
	}

	// A correction names the message it corrects.
	srv.raw(`<message type='groupchat' ` + from + ` id='c1'><body>fixed</body><replace xmlns='urn:xmpp:message-correct:0' id='m1'/></message>`)
	c := pb.waitFor(t, "correction", func(ev event) bool { return ev.Type == "message" && ev.ID == "c1" })
	if c.Replace != "m1" || c.Body != "fixed" {
		t.Fatalf("correction: %+v", c)
	}

	// Retractions: by the author (version 1 and before), and a moderator's (from the conference itself).
	srv.raw(`<message type='groupchat' ` + from + `><retract xmlns='urn:xmpp:message-retract:1' id='sid-1'/><body>x</body>` +
		`<fallback xmlns='urn:xmpp:fallback:0' for='urn:xmpp:message-retract:1'/></message>`)
	srv.raw(`<message type='groupchat' ` + from + `><apply-to xmlns='urn:xmpp:fasten:0' id='m2'><retract xmlns='urn:xmpp:message-retract:0'/></apply-to></message>`)
	srv.raw(`<message type='groupchat' from='` + muc + `' to='` + srv.to() + `'><retract xmlns='urn:xmpp:message-retract:1' id='sid-3'>` +
		`<moderated xmlns='urn:xmpp:message-moderate:1' by='` + muc + `/Mod'/></retract></message>`)
	srv.raw(`<message type='groupchat' from='` + muc + `' to='` + srv.to() + `'><apply-to xmlns='urn:xmpp:fasten:0' id='sid-4'>` +
		`<moderated xmlns='urn:xmpp:message-moderate:0' by='` + muc + `/Mod'><retract xmlns='urn:xmpp:message-retract:0'/></moderated></apply-to></message>`)
	// A retracted message's tombstone in history is nothing.
	srv.raw(`<message type='groupchat' ` + from + `><retracted xmlns='urn:xmpp:message-retract:1' id='sid-5'/><body>gone</body></message>`)
	want := map[string]bool{"sid-1": false, "m2": false, "sid-3": true, "sid-4": true}
	for target, moderated := range want {
		ev := pb.waitFor(t, "retraction "+target, func(ev event) bool { return ev.Type == "retraction" && ev.Target == target })
		if ev.Moderated != moderated || (!moderated && (ev.Nick != "Ann" || ev.OccupantID != "oid-ann")) {
			t.Fatalf("retraction %s: %+v", target, ev)
		}
	}
	time.Sleep(100 * time.Millisecond)
	pb.mu.Lock()
	for _, ev := range pb.events {
		if ev.Type == "message" && (ev.Body == "x" || ev.Body == "gone") {
			t.Errorf("a retraction came as a message: %+v", ev)
		}
	}
	pb.mu.Unlock()

	// Out: a reply with its fallback, a correction, a retraction in both versions with its fallback and a hint.
	var opt sendOptions
	json.Unmarshal([]byte(`{"reply":{"id":"sid-1","to":"Ann","end":6}}`), &opt)
	if err := b.sendGroup(context.Background(), muc, "o1", "> hi\nBob: ok", opt); err != nil {
		t.Fatal(err)
	}
	m := srv.waitReceived(t, 1)
	if m.Reply == nil || m.Reply.ID != "sid-1" || m.Reply.To != muc+"/Ann" || len(m.Fallbacks) != 1 || *m.Fallbacks[0].Bodies[0].End != 6 {
		t.Fatalf("reply out: %+v", m)
	}
	b.sendGroup(context.Background(), muc, "o2", "Bob: ok!", sendOptions{Replace: "o1"})
	if m := srv.waitReceived(t, 2); m.Replace == nil || m.Replace.ID != "o1" {
		t.Fatalf("correction out: %+v", m)
	}
	json.Unmarshal([]byte(`{"retract":{"stanza_id":"sid-7","origin_id":"o1"}}`), &opt)
	b.sendGroup(context.Background(), muc, "o3", "retracted", sendOptions{Retract: opt.Retract})
	if m := srv.waitReceived(t, 3); m.Retract == nil || m.Retract.ID != "sid-7" || m.ApplyTo == nil || m.ApplyTo.ID != "o1" || len(m.Fallbacks) != 1 {
		t.Fatalf("retraction out: %+v", m)
	}
}

func TestFiles(t *testing.T) {
	allowPlainUploads = true
	b, pb, srv := start(t)
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k1"}})
	join(t, b, pb, srv, 1, "Chirkle")

	// In: a file's link, in the body and in OOB; an encrypted message.
	from := `from='` + muc + `/Ann' to='` + srv.to() + `'`
	srv.raw(`<message type='groupchat' ` + from + ` id='f1'><body>https://up.example.org/a/cat.jpg</body>` +
		`<x xmlns='jabber:x:oob'><url>https://up.example.org/a/cat.jpg</url></x></message>`)
	srv.raw(`<message type='groupchat' ` + from + ` id='e1'><body>I sent you an OMEMO encrypted message</body>` +
		`<encrypted xmlns='eu.siacs.conversations.axolotl'><payload>x</payload></encrypted></message>`)
	f := pb.waitFor(t, "file", func(ev event) bool { return ev.ID == "f1" })
	if len(f.OOB) != 1 || f.OOB[0] != "https://up.example.org/a/cat.jpg" || f.Encrypted {
		t.Fatalf("file: %+v", f)
	}
	if e := pb.waitFor(t, "encrypted", func(ev event) bool { return ev.ID == "e1" }); !e.Encrypted {
		t.Fatalf("encrypted: %+v", e)
	}

	// Out, with no upload service: refused for good, saying so.
	if _, err := b.upload(context.Background(), "/api/files/messages/m1/cat.png", "cat.png", ""); !isCode(err, codeUnsupported) {
		t.Fatalf("no service: %v", err)
	}

	// With one: the slot asked for with the file's size and type, the PUT with only the allowed headers.
	var mu sync.Mutex
	var puts []string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		mu.Lock()
		puts = append(puts, r.Method+" "+r.URL.Path+" "+string(data)+" "+r.Header.Get("Authorization")+" "+r.Header.Get("X-Evil")+" "+r.Header.Get("Content-Type"))
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(up.Close)
	srv.mu.Lock()
	srv.upload, srv.uploadMax = up.URL, 1000
	srv.mu.Unlock()
	// The service was looked up for this session already: a new session looks again.
	b.mu.Lock()
	b.uploads = uploadService{}
	b.mu.Unlock()
	got, err := b.upload(context.Background(), "/api/files/messages/m1/cat.png", "cat.png", "")
	if err != nil || got != up.URL+"/get/cat.png" {
		t.Fatalf("upload: %q %v", got, err)
	}
	mu.Lock()
	if len(puts) != 1 || puts[0] != "PUT /put/cat.png PNGDATA Bearer t0k  image/png" {
		t.Fatalf("puts: %q", puts)
	}
	mu.Unlock()
	srv.mu.Lock()
	if len(srv.slots) != 1 || srv.slots[0] != "cat.png|7|image/png" {
		t.Fatalf("slots: %q", srv.slots)
	}
	srv.mu.Unlock()
	// Over the service's limit: refused for good, without asking for a slot.
	if _, err := b.upload(context.Background(), "/api/files/messages/m1/big.bin", "big.bin", ""); !isCode(err, codeTooLarge) {
		t.Fatalf("too large: %v", err)
	}
	// Only PocketBase's files.
	if _, err := b.upload(context.Background(), "http://elsewhere/x", "x", ""); err == nil {
		t.Fatal("read a file not PocketBase's")
	}

	// The link goes with OOB.
	if err := b.sendGroup(context.Background(), muc, "m1-f1", got, sendOptions{OOB: got}); err != nil {
		t.Fatal(err)
	}
	if m := srv.waitReceived(t, 1); len(m.OOB) != 1 || m.OOB[0].URL != got || *m.Body != got {
		t.Fatalf("sent: %+v", m)
	}
}

func isCode(err error, code string) bool {
	ue, ok := err.(*uploadError)
	return ok && ue.code == code && !ue.transient
}

func TestReactionsModerationAvatars(t *testing.T) {
	b, pb, srv := start(t)
	b.setRooms([]wantedRoom{{MUC: muc, Key: "k1"}})
	join(t, b, pb, srv, 1, "Chirkle")
	from := `from='` + muc + `/Ann' to='` + srv.to() + `'`

	// In: someone's set of reactions, and none (all taken back).
	srv.raw(`<message type='groupchat' ` + from + `><reactions xmlns='urn:xmpp:reactions:0' id='sid-1'><reaction>👍</reaction>` +
		`<reaction>🎉</reaction></reactions><store xmlns='urn:xmpp:hints'/></message>`)
	srv.raw(`<message type='groupchat' ` + from + `><reactions xmlns='urn:xmpp:reactions:0' id='sid-2'/></message>`)
	r := pb.waitFor(t, "reactions", func(ev event) bool { return ev.Type == "reactions" && ev.Target == "sid-1" })
	if strings.Join(r.Emoji, " ") != "👍 🎉" || r.Nick != "Ann" || r.OccupantID != "oid-ann" {
		t.Fatalf("reactions: %+v", r)
	}
	if r := pb.waitFor(t, "none", func(ev event) bool { return ev.Type == "reactions" && ev.Target == "sid-2" }); len(r.Emoji) != 0 {
		t.Fatalf("none: %+v", r)
	}

	// Out: the bot's set, with no body.
	var opt sendOptions
	json.Unmarshal([]byte(`{"react":{"id":"sid-1","emoji":["❤️","👍"]}}`), &opt)
	if err := b.sendGroup(context.Background(), muc, "x1", "", opt); err != nil {
		t.Fatal(err)
	}
	m := srv.waitReceived(t, 1)
	if m.Body != nil || m.Reactions == nil || m.Reactions.ID != "sid-1" || strings.Join(m.Reactions.Reactions, " ") != "❤️ 👍" {
		t.Fatalf("reactions out: %+v", m)
	}

	// Moderation: not as a participant; as a moderator, in the version the conference has.
	if err := b.moderate(context.Background(), muc, "sid-5", ""); err == nil || err.(*sendError).transient {
		t.Fatalf("moderated as a participant: %v", err)
	}
	srv.raw(`<presence from='` + muc + `/Chirkle' to='` + srv.to() + `'><x xmlns='http://jabber.org/protocol/muc#user'>` +
		`<item affiliation='admin' role='moderator'/><status code='110'/></x></presence>`)
	deadline := time.Now().Add(5 * time.Second)
	for {
		b.mu.Lock()
		ready := b.rooms[muc].role == "moderator" && b.rooms[muc].feats[nsModerate]
		b.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no role or features")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := b.moderate(context.Background(), muc, "sid-5", "spam"); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	b.rooms[muc].feats = map[string]bool{nsModerat0: true}
	b.mu.Unlock()
	if err := b.moderate(context.Background(), muc, "sid-6", ""); err != nil {
		t.Fatal(err)
	}
	srv.mu.Lock()
	if strings.Join(srv.moderations, ",") != "1|sid-5|spam,0|sid-6|" {
		t.Fatalf("moderations: %q", srv.moderations)
	}
	srv.mu.Unlock()

	// Avatars: a photo hash told once (again when it changes), the vCard's photo held for one fetch.
	photoPresence := func(hash string) {
		srv.raw(`<presence ` + from + `><occupant-id xmlns='urn:xmpp:occupant-id:0' id='oid-ann'/>` +
			`<x xmlns='http://jabber.org/protocol/muc#user'><item affiliation='member' role='participant'/></x>` +
			`<x xmlns='vcard-temp:x:update'><photo>` + hash + `</photo></x></presence>`)
	}
	photoPresence("AB12")
	photoPresence("ab12")
	photoPresence("cd34")
	pb.waitFor(t, "second photo", func(ev event) bool { return ev.Type == "photo" && ev.Hash == "cd34" })
	pb.mu.Lock()
	n := 0
	for _, ev := range pb.events {
		if ev.Type == "photo" {
			n++
		}
	}
	pb.mu.Unlock()
	if n != 2 {
		t.Fatalf("%d photo events, not 2", n)
	}
	token, typ, err := b.avatar(context.Background(), muc, "Ann")
	if err != nil || token == "" || typ != "image/png" {
		t.Fatalf("avatar: %q %q %v", token, typ, err)
	}
	api := httptest.NewServer(b.api("s3cret"))
	defer api.Close()
	res, _ := http.Get(api.URL + "/photo/" + token)
	data, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(data) != "PNGDATA" || res.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("photo: %q %q", data, res.Header.Get("Content-Type"))
	}
	if res, _ := http.Get(api.URL + "/photo/" + token); res.StatusCode != http.StatusNotFound {
		t.Fatal("the photo was given twice")
	}
	if token, _, err := b.avatar(context.Background(), muc, "Bob"); err != nil || token != "" {
		t.Fatalf("no photo: %q %v", token, err)
	}
}
