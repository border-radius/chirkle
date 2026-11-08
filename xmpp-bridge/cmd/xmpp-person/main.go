// xmpp-person is a test tool, not part of the bridge: one XMPP account for the bridge's tests against a real server
// (tests/integration/xmpp.prosody.test.ts) to play someone in a conference. It logs in, then sends each line of its
// standard input as a stanza, as it is, and prints each stanza it receives on a line of its own. "online <full jid>"
// first; it exits when its standard input closes.
//
//	xmpp-person -jid ann@localhost -password pw -server localhost:5222
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/xml"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"mellium.im/sasl"
	"mellium.im/xmlstream"
	"mellium.im/xmpp"
	"mellium.im/xmpp/jid"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("xmpp-person: ")
	addr := flag.String("jid", "", "the account")
	password := flag.String("password", "", "its password")
	server := flag.String("server", "", "host:port to connect to")
	flag.Parse()
	j, err := jid.Parse(*addr)
	if err != nil {
		log.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", *server)
	if err != nil {
		log.Fatal(err)
	}
	sess, err := xmpp.NewClientSession(ctx, j, conn,
		xmpp.StartTLS(&tls.Config{ServerName: j.Domainpart(), MinVersion: tls.VersionTLS12}),
		xmpp.SASL("", *password, sasl.ScramSha256, sasl.ScramSha1, sasl.Plain),
		xmpp.BindResource(),
	)
	cancel()
	if err != nil {
		log.Fatal(err)
	}
	var out sync.Mutex
	println := func(s string) {
		out.Lock()
		defer out.Unlock()
		fmt.Println(s)
	}
	println("online " + sess.LocalAddr().String())

	go func() {
		err := sess.Serve(xmpp.HandlerFunc(func(t xmlstream.TokenReadEncoder, start *xml.StartElement) error {
			var buf bytes.Buffer
			enc := xml.NewEncoder(&buf)
			if _, err := xmlstream.Copy(enc, xmlstream.MultiReader(xmlstream.Token(*start), t)); err != nil {
				return err
			}
			if err := enc.Flush(); err != nil {
				return err
			}
			println(strings.ReplaceAll(buf.String(), "\n", "&#xA;"))
			return nil
		}))
		if err != nil {
			log.Printf("serve: %v", err)
		}
		os.Exit(1)
	}()

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 1<<20), 1<<20)
	for in.Scan() {
		line := strings.TrimSpace(in.Text())
		if line == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := sess.Send(ctx, xml.NewDecoder(strings.NewReader(line))); err != nil {
			log.Printf("send: %v", err)
		}
		cancel()
	}
	sess.Close()
}
