package main

// Operational metrics (REFACTOR item 51, DESIGN.md §40.6): GET /api/chat/metrics, for superusers only. What used to be
// found by users: queues backing up (Telegram, linked instances, link previews, the media worker's files, storage
// cleanup), a worker that stopped passing or keeps failing, realtime clients and live senders falling behind, the
// database's size, the process's memory. JSON by default (the /stats page shows it to a superuser); in Prometheus's
// text format with ?format=prometheus, or when the request accepts text/plain and not JSON (a scraper; it signs in
// with a superuser token, e.g. one made by POST /api/collections/_superusers/impersonate/{id} with a long duration).
//
// The workers note their passes in the app store (pb_hooks/lib/worker.js noted): `<lock>.last` is the last pass's
// time (epoch ms), `<lock>.error` the last failed one's ("<ms> <error>"), `<lock>` the run's lock ("<handle> <ms>",
// renewed after each item). Not reported: the JS hooks pool (the jsvm plugin keeps no count of busy runtimes).

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

// metricWorkers: the workers' app store keys (their lock's name), by the name the metrics give them.
var metricWorkers = map[string]string{
	"previews":   "previews.worker",
	"media":      "media.worker",
	"telegram":   "telegram.worker",
	"federation": "federation.worker",
	"retention":  "retention",
}

// metricQueues: each queue's table and the SQL conditions for its rows, its failing rows ("" for none) and the time its
// age is from ("" for none).
var metricQueues = []struct {
	Name, Table, Where, Failing, Created string
}{
	{"telegram", "tg_queue", "1", "tries > 0", "created"},
	{"federation", "fed_queue", "1", "tries > 0", "created"},
	{"link_previews", "link_queue", "1", "", "created"},
	{"media_thumbs", "files", "ready = FALSE AND src = ''", "", "created"},
	{"media_sizes", "files", "ready = TRUE AND sized = FALSE AND src = ''", "", "created"},
	{"media_moves", "files", "src != ''", "", "created"},
	{"storage_cleanup", "storage_cleanup", "1", "", ""},
}

type queueMetric struct {
	Rows          int     `json:"rows"`
	Failing       int     `json:"failing"`
	OldestSeconds float64 `json:"oldest_seconds"`
}

type workerMetric struct {
	// LastPass: when it last passed (RFC 3339), "" for not since the start.
	LastPass string `json:"last_pass"`
	// LastError: the last failed pass's error and when, "" for none since the start.
	LastError   string `json:"last_error"`
	LastErrorAt string `json:"last_error_at"`
	// Running: a run holds its lock now (renewed within the last 2 minutes).
	Running bool `json:"running"`
}

type metrics struct {
	At            string                  `json:"at"`
	Version       string                  `json:"version"`
	PocketBase    string                  `json:"pocketbase"`
	UptimeSeconds float64                 `json:"uptime_seconds"`
	Queues        map[string]queueMetric  `json:"queues"`
	Workers       map[string]workerMetric `json:"workers"`
	Realtime      struct {
		Clients int `json:"clients"`
		liveStats
	} `json:"realtime"`
	DB      map[string]int64 `json:"db"`
	Process struct {
		Goroutines int    `json:"goroutines"`
		HeapBytes  uint64 `json:"heap_bytes"`
		SysBytes   uint64 `json:"sys_bytes"`
		GCRuns     uint32 `json:"gc_runs"`
	} `json:"process"`
}

// storeMs: an app store value noted as "<ms>" or "<ms> <text>", as a time and the text.
func storeMs(app core.App, key string) (time.Time, string, bool) {
	s, ok := app.Store().Get(key).(string)
	if !ok || s == "" {
		return time.Time{}, "", false
	}
	head, rest, _ := strings.Cut(s, " ")
	ms, err := strconv.ParseInt(head, 10, 64)
	if err != nil {
		return time.Time{}, "", false
	}
	return time.UnixMilli(ms), rest, true
}

func collectMetrics(app core.App, l *live) (*metrics, error) {
	now := time.Now()
	m := &metrics{
		At:            now.UTC().Format(time.RFC3339),
		Version:       version,
		PocketBase:    pocketbase.Version,
		UptimeSeconds: now.Sub(started).Seconds(),
		Queues:        map[string]queueMetric{},
		Workers:       map[string]workerMetric{},
		DB:            map[string]int64{},
	}
	for _, q := range metricQueues {
		failing := "0"
		if q.Failing != "" {
			failing = "COALESCE(SUM(" + q.Failing + "), 0)"
		}
		oldest := "''"
		if q.Created != "" {
			oldest = "COALESCE(MIN(" + q.Created + "), '')"
		}
		row := struct {
			Rows    int    `db:"n"`
			Failing int    `db:"failing"`
			Oldest  string `db:"oldest"`
		}{}
		err := app.DB().NewQuery("SELECT COUNT(*) AS n, " + failing + " AS failing, " + oldest + " AS oldest FROM " + q.Table +
			" WHERE " + q.Where).One(&row)
		if err != nil {
			return nil, fmt.Errorf("metrics: queue %s: %w", q.Name, err)
		}
		qm := queueMetric{Rows: row.Rows, Failing: row.Failing}
		if t, err := time.Parse("2006-01-02 15:04:05.000Z", row.Oldest); err == nil {
			qm.OldestSeconds = now.Sub(t).Seconds()
		}
		m.Queues[q.Name] = qm
	}
	for name, key := range metricWorkers {
		w := workerMetric{}
		if t, _, ok := storeMs(app, key+".last"); ok {
			w.LastPass = t.UTC().Format(time.RFC3339)
		}
		if t, text, ok := storeMs(app, key+".error"); ok {
			w.LastErrorAt = t.UTC().Format(time.RFC3339)
			w.LastError = text
		}
		// The lock: "<handle> <ms>".
		if s, ok := app.Store().Get(key).(string); ok {
			if _, ms, ok := strings.Cut(s, " "); ok {
				if v, err := strconv.ParseInt(ms, 10, 64); err == nil && now.Sub(time.UnixMilli(v)) < 2*time.Minute {
					w.Running = true
				}
			}
		}
		m.Workers[name] = w
	}
	m.Realtime.Clients = app.SubscriptionsBroker().TotalClients()
	m.Realtime.liveStats = l.stats()
	for _, f := range []string{"data.db", "data.db-wal", "auxiliary.db", "auxiliary.db-wal"} {
		if st, err := os.Stat(filepath.Join(app.DataDir(), f)); err == nil {
			m.DB[f] = st.Size()
		} else {
			m.DB[f] = 0
		}
	}
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	m.Process.Goroutines = runtime.NumGoroutine()
	m.Process.HeapBytes = mem.HeapAlloc
	m.Process.SysBytes = mem.Sys
	m.Process.GCRuns = mem.NumGC
	return m, nil
}

// prometheus: m in Prometheus's text exposition format.
func (m *metrics) prometheus() string {
	var b strings.Builder
	metric := func(name, kind, help string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	}
	label := func(v string) string { return strconv.Quote(v) }
	sorted := func(keys []string) []string { sort.Strings(keys); return keys }

	metric("chirkle_info", "gauge", "Chirkle's and PocketBase's versions.")
	fmt.Fprintf(&b, "chirkle_info{version=%s,pocketbase=%s} 1\n", label(m.Version), label(m.PocketBase))
	metric("chirkle_uptime_seconds", "gauge", "Seconds since the server started.")
	fmt.Fprintf(&b, "chirkle_uptime_seconds %.0f\n", m.UptimeSeconds)

	queues := make([]string, 0, len(m.Queues))
	for k := range m.Queues {
		queues = append(queues, k)
	}
	queues = sorted(queues)
	metric("chirkle_queue_rows", "gauge", "Rows waiting in a worker's queue.")
	for _, k := range queues {
		fmt.Fprintf(&b, "chirkle_queue_rows{queue=%s} %d\n", label(k), m.Queues[k].Rows)
	}
	metric("chirkle_queue_failing_rows", "gauge", "Queued rows that have failed at least once.")
	for _, k := range queues {
		fmt.Fprintf(&b, "chirkle_queue_failing_rows{queue=%s} %d\n", label(k), m.Queues[k].Failing)
	}
	metric("chirkle_queue_oldest_seconds", "gauge", "Age of the oldest queued row (0 when empty).")
	for _, k := range queues {
		fmt.Fprintf(&b, "chirkle_queue_oldest_seconds{queue=%s} %.0f\n", label(k), m.Queues[k].OldestSeconds)
	}

	workers := make([]string, 0, len(m.Workers))
	for k := range m.Workers {
		workers = append(workers, k)
	}
	workers = sorted(workers)
	ts := func(s string) string {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return strconv.FormatInt(t.Unix(), 10)
		}
		return "0"
	}
	metric("chirkle_worker_last_pass_timestamp_seconds", "gauge", "When a worker last passed (0: not since the start).")
	for _, k := range workers {
		fmt.Fprintf(&b, "chirkle_worker_last_pass_timestamp_seconds{worker=%s} %s\n", label(k), ts(m.Workers[k].LastPass))
	}
	metric("chirkle_worker_last_error_timestamp_seconds", "gauge", "When a worker's pass last failed (0: not since the start).")
	for _, k := range workers {
		fmt.Fprintf(&b, "chirkle_worker_last_error_timestamp_seconds{worker=%s} %s\n", label(k), ts(m.Workers[k].LastErrorAt))
	}
	metric("chirkle_worker_running", "gauge", "1 while a run of the worker holds its lock.")
	for _, k := range workers {
		v := 0
		if m.Workers[k].Running {
			v = 1
		}
		fmt.Fprintf(&b, "chirkle_worker_running{worker=%s} %d\n", label(k), v)
	}

	metric("chirkle_realtime_clients", "gauge", "Realtime (SSE) connections.")
	fmt.Fprintf(&b, "chirkle_realtime_clients %d\n", m.Realtime.Clients)
	metric("chirkle_live_senders", "gauge", "Clients with a live message sender running.")
	fmt.Fprintf(&b, "chirkle_live_senders %d\n", m.Realtime.Senders)
	metric("chirkle_live_queued_events", "gauge", "Live message events waiting to be sent.")
	fmt.Fprintf(&b, "chirkle_live_queued_events %d\n", m.Realtime.Queued)
	metric("chirkle_live_dropped_clients_total", "counter", "Clients disconnected for falling too far behind.")
	fmt.Fprintf(&b, "chirkle_live_dropped_clients_total %d\n", m.Realtime.Dropped)

	files := make([]string, 0, len(m.DB))
	for k := range m.DB {
		files = append(files, k)
	}
	metric("chirkle_db_bytes", "gauge", "Size of a database file.")
	for _, k := range sorted(files) {
		fmt.Fprintf(&b, "chirkle_db_bytes{file=%s} %d\n", label(k), m.DB[k])
	}

	metric("chirkle_goroutines", "gauge", "Goroutines running.")
	fmt.Fprintf(&b, "chirkle_goroutines %d\n", m.Process.Goroutines)
	metric("chirkle_heap_bytes", "gauge", "Go heap in use.")
	fmt.Fprintf(&b, "chirkle_heap_bytes %d\n", m.Process.HeapBytes)
	metric("chirkle_sys_bytes", "gauge", "Memory obtained from the OS by the Go runtime.")
	fmt.Fprintf(&b, "chirkle_sys_bytes %d\n", m.Process.SysBytes)
	return b.String()
}

// wantsPrometheus: ?format=prometheus, or an Accept header asking for text and not JSON.
func wantsPrometheus(r *http.Request) bool {
	switch r.URL.Query().Get("format") {
	case "prometheus":
		return true
	case "json":
		return false
	}
	accept := r.Header.Get("Accept")
	return (strings.Contains(accept, "text/plain") || strings.Contains(accept, "openmetrics")) && !strings.Contains(accept, "json")
}

// metricsRoute: GET /api/chat/metrics (superusers; the route requires it).
func metricsRoute(l *live) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		m, err := collectMetrics(e.App, l)
		if err != nil {
			return err
		}
		e.Response.Header().Set("Cache-Control", "no-store")
		if wantsPrometheus(e.Request) {
			return e.Blob(http.StatusOK, "text/plain; version=0.0.4; charset=utf-8", []byte(m.prometheus()))
		}
		return e.JSON(http.StatusOK, m)
	}
}
