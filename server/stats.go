package main

// Usage statistics (DESIGN.md §40), the part each realtime subscription does: note the connection's app, and mark its
// account active today (at most once an hour). In Go, so a subscription takes no JS runtime (docs/REFACTOR.md item 61).
// pb_hooks/lib/stats.js keeps the rest: the 5-minute samples (which read the app noted here), pruning, the page.

import (
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/security"
)

// statsAppKey: the client store key of a connection's app (lib/stats.js KEY_APP).
const statsAppKey = "chirkle_app"

var okhttpUA = regexp.MustCompile(`(?i)^okhttp/`)

// appOf: the app a User-Agent is (the Android app's OkHttp sends "okhttp/…").
func appOf(ua string) string {
	switch {
	case okhttpUA.MatchString(ua):
		return "android"
	case strings.HasPrefix(ua, "Mozilla/"):
		return "web"
	}
	return "other"
}

// touchedThisHour: the accounts a subscription marked active in the current (UTC) hour. Replaced when the hour
// changes, so it holds only the last hour's accounts (the JS store's key per account ever seen did not).
type touchedThisHour struct {
	mu    sync.Mutex
	hour  string
	users map[string]struct{}
}

// first: whether this is user's first mark in hour.
func (t *touchedThisHour) first(user, hour string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.hour != hour {
		t.hour, t.users = hour, map[string]struct{}{}
	}
	if _, ok := t.users[user]; ok {
		return false
	}
	t.users[user] = struct{}{}
	return true
}

// statsOff: the site's `no_stats` switch.
func statsOff(app core.App) bool {
	found, err := app.FindRecordsByFilter("site", "", "created", 1, 0)
	return err == nil && len(found) > 0 && found[0].GetBool("no_stats")
}

// touchActivity: user was online at `at` (lib/stats.js touch).
func touchActivity(app core.App, user string, at time.Time) error {
	_, err := app.DB().NewQuery(
		"INSERT INTO stats_activity (id, user, day, last_at) VALUES ({:id}, {:user}, {:day}, {:at}) ON CONFLICT (user, day) DO UPDATE SET last_at = excluded.last_at",
	).Bind(dbx.Params{
		"id":   security.RandomStringWithAlphabet(15, "abcdefghijklmnopqrstuvwxyz0123456789"),
		"user": user,
		"day":  at.Format("2006-01-02"),
		"at":   at.Format("2006-01-02 15:04:05.000Z"),
	}).Execute()
	return err
}

// bindStats: on every realtime subscribe request, after the subscription is checked (so a refused one counts
// nothing). Never fails the subscription.
func bindStats(app core.App) {
	touched := &touchedThisHour{}
	app.OnRealtimeSubscribeRequest().BindFunc(func(e *core.RealtimeSubscribeRequestEvent) error {
		e.Client.Set(statsAppKey, appOf(e.Request.UserAgent()))
		if e.Auth != nil && !e.Auth.IsSuperuser() && e.Auth.Collection().Name == "users" {
			now := time.Now().UTC()
			if touched.first(e.Auth.Id, now.Format("2006-01-02T15")) && !statsOff(e.App) {
				if err := touchActivity(e.App, e.Auth.Id, now); err != nil {
					e.App.Logger().Warn("stats: subscribe", "error", err.Error())
				}
			}
		}
		return e.Next()
	})
}
