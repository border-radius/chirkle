package main

// Linked instances' downloads (DESIGN.md §33.6): GET /api/fed/files/{message}/{file} and /api/fed/avatars/{user},
// which peers call to copy a shared message's files and the pictures of people they were told of. In Go
// (docs/REFACTOR.md item 61), as the other downloads are (files.go): a JS route held a JS runtime of the pool for the
// whole download. The rest of the federation stays in JS (pb_hooks/federation/); this file has Go copies of the two
// checks the routes start with: is the module on (federation/config.js enabled) and is the request signed by an
// active peer (federation/net.js verify, for a GET: no body). Tested by tests/integration/federation.test.ts and
// federation_test.go.

import (
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
)

// fedSkew: how far a request's date may be from now (net.js SKEW_S).
const fedSkew = 300

var fedOriginRe = regexp.MustCompile(`(?i)^(https?)://([a-z0-9.-]+(?::\d+)?)/?$`)
var fedLocalRe = regexp.MustCompile(`^https://(localhost|127\.|\[?::1)`)

// fedAllowPrivate: tests and development only, peers on private addresses and plain http (config.js allowPrivate).
func fedAllowPrivate() bool { return strings.TrimSpace(os.Getenv("FEDERATION_ALLOW_PRIVATE")) == "1" }

// fedCleanOrigin: an origin as stored, scheme and host (and port) lowercased, no path; "" for anything else
// (config.js cleanOrigin).
func fedCleanOrigin(raw string) string {
	m := fedOriginRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return ""
	}
	return strings.ToLower(m[1]) + "://" + strings.ToLower(m[2])
}

// fedOriginOK: can this Application URL be linked with (config.js originProblem() == "").
func fedOriginOK(appURL string, allowPrivate bool) bool {
	c := fedCleanOrigin(appURL)
	if c == "" {
		return false
	}
	if allowPrivate {
		return true
	}
	return strings.HasPrefix(c, "https://") && !fedLocalRe.MatchString(c)
}

// fedEnabled: the site record's `federation` ticked, and an Application URL that can be linked with (config.js enabled).
func fedEnabled(app core.App) bool {
	if !fedOriginOK(app.Settings().Meta.AppURL, fedAllowPrivate()) {
		return false
	}
	found, err := app.FindRecordsByFilter("site", "", "created", 1, 0)
	return err == nil && len(found) > 0 && found[0].GetBool("federation")
}

// fedSign: hex HMAC-SHA256 of "method\npath\ndate\nsha256(body)" with the pair's secret (net.js sign).
func fedSign(secret, method, path, date, body string) string {
	return security.HS256(method+"\n"+path+"\n"+date+"\n"+security.SHA256(body), secret)
}

// fedDateOK: a request's X-Fed-Date (unix seconds, as JS's Number reads it) within fedSkew of now.
func fedDateOK(date string, now time.Time) bool {
	at, err := strconv.ParseFloat(strings.TrimSpace(date), 64)
	if err != nil || math.IsNaN(at) || math.IsInf(at, 0) {
		return false
	}
	return math.Abs(float64(now.UnixMilli())/1000-at) <= fedSkew
}

// fedVerify: the active peer that signed this GET request, or the error to answer with: 401 for a request that isn't
// signed right, 403 for a peer that isn't paired, 503 for one suspended here (net.js verify).
func fedVerify(e *core.RequestEvent) (*core.Record, error) {
	h := e.Request.Header
	from, date, got := h.Get("X-Fed-Origin"), h.Get("X-Fed-Date"), h.Get("X-Fed-Signature")
	if from == "" || date == "" || got == "" {
		return nil, e.UnauthorizedError("Not a signed request.", nil)
	}
	peer, err := e.App.FindFirstRecordByFilter("fed_peers", "origin = {:o}", dbx.Params{"o": strings.TrimRight(from, "/")})
	st := ""
	if err == nil {
		st = peer.GetString("status")
	}
	if err != nil || peer.GetString("secret") == "" || (st != "active" && st != "suspended") {
		return nil, e.ForbiddenError("Not paired.", nil)
	}
	if !fedDateOK(date, time.Now()) {
		return nil, e.UnauthorizedError("The request is too old.", nil)
	}
	path := e.Request.URL.Path
	if q := e.Request.URL.RawQuery; q != "" {
		path += "?" + q
	}
	if !security.Equal(fedSign(peer.GetString("secret"), e.Request.Method, path, date, ""), got) {
		return nil, e.UnauthorizedError("Wrong signature.", nil)
	}
	if st != "active" {
		return nil, router.NewApiError(503, "Suspended.", nil)
	}
	return peer, nil
}

// fedRoute: a peer's GET route, 404 while the module is off (config.js requireOn), then only for an active peer.
func fedRoute(h func(e *core.RequestEvent, peer *core.Record) error) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if !fedEnabled(e.App) {
			return e.NotFoundError("Linking with other instances is off here.", nil)
		}
		peer, err := fedVerify(e)
		if err != nil {
			return err
		}
		return h(e, peer)
	}
}

// fedFile: GET /api/fed/files/{message}/{file}: a file the message shows (a forward's are its original's, §33.5), in a
// room shared with the peer, as its home or as its mirror's home.
func fedFile(e *core.RequestEvent, peer *core.Record) error {
	name := e.Request.PathValue("file")
	msg, err := e.App.FindRecordById("messages", e.Request.PathValue("message"))
	if err != nil {
		return e.NotFoundError("", nil)
	}
	room, err := e.App.FindRecordById("rooms", msg.GetString("room"))
	if err != nil {
		return e.NotFoundError("", nil)
	}
	shared := room.GetString("peer") == peer.Id
	if !shared {
		rows, err := e.App.FindRecordsByFilter("fed_shares", "room = {:r} && peer = {:p} && state = 'active'", "", 1, 0,
			dbx.Params{"r": room.Id, "p": peer.Id})
		shared = err == nil && len(rows) > 0
	}
	if !shared || !messageShows(e.App, msg, name) {
		return e.NotFoundError("", nil)
	}
	row := fileRowByName(e.App, name)
	if row == nil {
		return e.NotFoundError("", nil)
	}
	return fedServe(e, fileKeyOf(row), name)
}

// fedAvatar: GET /api/fed/avatars/{user}: the picture of someone the peer was told of (a `known` fed_people row).
func fedAvatar(e *core.RequestEvent, peer *core.Record) error {
	id := e.Request.PathValue("user")
	user, err := e.App.FindRecordById("users", id)
	if err != nil {
		return e.NotFoundError("", nil)
	}
	if _, err := e.App.FindFirstRecordByFilter("fed_people", "peer = {:p} && user = {:u} && kind = 'known'",
		dbx.Params{"p": peer.Id, "u": id}); err != nil {
		return e.NotFoundError("", nil)
	}
	name := user.GetString("avatar")
	if name == "" {
		return e.NotFoundError("", nil)
	}
	return fedServe(e, user.BaseFilesPath()+"/"+name, name)
}

func fedServe(e *core.RequestEvent, key, name string) error {
	fsys, err := e.App.NewFilesystem()
	if err != nil {
		return e.InternalServerError("", err)
	}
	defer fsys.Close()
	if ok, _ := fsys.Exists(key); !ok {
		return e.NotFoundError("", nil)
	}
	if err := fsys.Serve(e.Response, e.Request, key, name); err != nil {
		return e.NotFoundError("", err)
	}
	return nil
}

// fedRoutes: path → handler, added by register (main.go) beside fileRoutes.
var fedRoutes = map[string]func(*core.RequestEvent) error{
	"/api/fed/files/{message}/{file}": fedRoute(fedFile),
	"/api/fed/avatars/{user}":         fedRoute(fedAvatar),
}
