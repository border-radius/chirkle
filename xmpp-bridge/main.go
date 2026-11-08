// The XMPP bridge's child (DESIGN.md §38): PocketBase starts it, it holds the bot's XMPP connection and joins the
// conferences PocketBase asks for, and it passes messages both ways over HTTP on localhost. It keeps nothing: what it
// knows (the conferences, the newest message seen) PocketBase tells it again after a restart.
//
// Its standard input is a pipe PocketBase keeps open and never writes to: once it closes (PocketBase stopped, even
// killed), the child exits.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"mellium.im/xmpp/jid"
)

// protocol is the version of what the child and the hooks say to each other: the hooks refuse a child that speaks
// another one (they are built from the same commit, so this is only a check).
const protocol = 1

// version is set at build time (-ldflags "-X main.version=…").
var version = "dev"

const statusEvery = 10 * time.Second

func main() {
	log.SetFlags(0)
	log.SetPrefix("xmpp-bridge: ")
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	cfg, in, inAddr, secret, err := fromEnv()
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		io.Copy(io.Discard, os.Stdin)
		log.Printf("stdin closed: exiting")
		stop()
	}()

	pb := newPocketBase(in, inAddr, secret)
	b := newBridge(cfg, pb)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: b.api(secret), ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(ln)

	boot := randomID()
	pb.send(event{Type: "hello", Protocol: protocol, Version: version, Port: ln.Addr().(*net.TCPAddr).Port, Boot: boot})
	go pb.run(ctx)
	go b.run(ctx)
	go func() {
		tick := time.NewTicker(statusEvery)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			case <-b.changed:
				time.Sleep(200 * time.Millisecond) // a burst of changes, one status
			}
			pb.postNow(ctx, b.status(boot))
		}
	}()

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(shutdown)
	b.mu.Lock()
	if b.sess != nil {
		b.sess.Close()
	}
	b.mu.Unlock()
}

func fromEnv() (cfg settings, in, inAddr, secret string, err error) {
	get := func(k string) string { return strings.TrimSpace(os.Getenv(k)) }
	cfg.jid, err = jid.Parse(get("XMPP_JID"))
	if err != nil || cfg.jid.Localpart() == "" {
		return cfg, "", "", "", fmt.Errorf("XMPP_JID: not an account address: %q", get("XMPP_JID"))
	}
	cfg.jid = cfg.jid.Bare()
	cfg.password = os.Getenv("XMPP_PASSWORD")
	cfg.nick = get("XMPP_NICK")
	if cfg.nick == "" {
		cfg.nick = "Chirkle"
	}
	cfg.server = get("XMPP_SERVER")
	in, inAddr, secret = get("CHIRKLE_XMPP_IN"), get("CHIRKLE_XMPP_IN_ADDR"), os.Getenv("CHIRKLE_XMPP_SECRET")
	if cfg.password == "" || in == "" || secret == "" {
		return cfg, "", "", "", fmt.Errorf("XMPP_PASSWORD, CHIRKLE_XMPP_IN and CHIRKLE_XMPP_SECRET are required (PocketBase sets the last two)")
	}
	return cfg, in, inAddr, secret, nil
}

func randomID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
