// The Chirkle server (docs/REFACTOR.md item 47): PocketBase, as its own binary is, with the JS hooks (pb_hooks/) and
// migrations (pb_migrations/), plus the hot paths in Go: the messages enrich hook (enrich.go), live messages
// (live.go), the room list and message pages (lists.go) and the unread counts (unread.go). Everything else stays in
// the JS hooks. Same flags, commands and routes as the stock `pocketbase` binary.
package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/osutils"
)

// version is Chirkle's (package.json), set by scripts/build-server.mjs with -ldflags "-X main.version=…".
var version = "dev"

// started: when this process started (GET /api/chat/metrics uptime).
var started = time.Now()

func main() {
	// PocketBase's own version, from the module it was built with (a dependency build has none set).
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, d := range bi.Deps {
			if d.Path == "github.com/pocketbase/pocketbase" {
				pocketbase.Version = strings.TrimPrefix(d.Version, "v")
			}
		}
	}
	app := pocketbase.New()
	app.RootCmd.Use = "chirkle-server"
	app.RootCmd.Version = pocketbase.Version + " (Chirkle " + version + ")"

	var hooksDir string
	app.RootCmd.PersistentFlags().StringVar(&hooksDir, "hooksDir", "", "the directory with the JS app hooks")

	var hooksWatch bool
	app.RootCmd.PersistentFlags().BoolVar(&hooksWatch, "hooksWatch", true,
		"auto restart the app on pb_hooks file change; it has no effect on Windows")

	var hooksPool int
	app.RootCmd.PersistentFlags().IntVar(&hooksPool, "hooksPool", 15,
		"the total prewarm goja.Runtime instances for the JS app hooks execution")

	var migrationsDir string
	app.RootCmd.PersistentFlags().StringVar(&migrationsDir, "migrationsDir", "", "the directory with the user defined migrations")

	var automigrate bool
	app.RootCmd.PersistentFlags().BoolVar(&automigrate, "automigrate", true, "enable/disable auto migrations")

	var publicDir string
	app.RootCmd.PersistentFlags().StringVar(&publicDir, "publicDir", defaultPublicDir(), "the directory to serve static files")

	var indexFallback bool
	app.RootCmd.PersistentFlags().BoolVar(&indexFallback, "indexFallback", true,
		"fallback the request to index.html on missing static path, e.g. when pretty urls are used with SPA")

	app.RootCmd.ParseFlags(os.Args[1:])

	jsvm.MustRegister(app, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    hooksWatch,
		HooksPoolSize: hooksPool,
	})

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		TemplateLang: migratecmd.TemplateLangJS,
		Automigrate:  automigrate,
		Dir:          migrationsDir,
	})

	register(app, os.Getenv("CHIRKLE_LEGACY") == "1")

	// As the stock binary: pb_public/ unless a route (the hooks' page route, lib/http.js) serves it.
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(e *core.ServeEvent) error {
			if !e.Router.HasRoute(http.MethodGet, "/{path...}") {
				e.Router.GET("/{path...}", apis.Static(os.DirFS(publicDir), indexFallback))
			}
			return e.Next()
		},
		Priority: 999,
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

// register binds the Go hooks and routes. `legacy` (CHIRKLE_LEGACY=1, tests only): answer as a server from before the
// list routes and the live topic (2026-10-29), so the apps' fallbacks can be tested (android TestServer.legacyUrl).
func register(app core.App, legacy bool) {
	live := newLive(app)
	// A client dropped for falling behind counts with live messages' own (GET /api/chat/metrics).
	bindRealtime(app, func() { live.dropped.Add(1) })
	bindEnrich(app)
	bindAnonymous(app)
	live.bind()

	// After the JS hooks' routes (they bind at priority 0): a route they define (an old release's hooks, tests) wins.
	app.OnServe().Bind(&hook.Handler[*core.ServeEvent]{
		Func: func(e *core.ServeEvent) error {
			add := func(method, path string, h func(*core.RequestEvent) error, auth bool) {
				if e.Router.HasRoute(method, path) {
					return
				}
				r := e.Router.Route(method, path, h)
				if auth {
					r.Bind(apis.RequireAuth("users"))
				}
			}
			if !legacy {
				add(http.MethodGet, "/api/chat/rooms", roomsRoute, false)
				add(http.MethodGet, "/api/chat/rooms/{room}/messages", messagesRoute, false)
				add(http.MethodGet, "/api/chat/notifiable", notifiableRoute, true)
				add(http.MethodGet, "/api/chat/live", liveInfoRoute, false)
			}
			add(http.MethodGet, "/api/chat/unread", unreadRoute, true)
			if !e.Router.HasRoute(http.MethodGet, "/api/chat/metrics") {
				e.Router.GET("/api/chat/metrics", metricsRoute(live)).Bind(apis.RequireSuperuserAuth())
			}
			add(http.MethodGet, "/api/chat/unread/{room}", firstUnreadRoute, true)
			return e.Next()
		},
		Priority: 900,
	})
}

// the default pb_public dir location is relative to the executable
func defaultPublicDir() string {
	if osutils.IsProbablyGoRun() {
		return "./pb_public"
	}
	return filepath.Join(os.Args[0], "../pb_public")
}
