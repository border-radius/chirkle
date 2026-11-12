package main

// Profiling (docs/PERF.md): CHIRKLE_PPROF=127.0.0.1:6060 serves Go's net/http/pprof there, on its own listener and
// never on the app's. Off unless set; for load tests, not production.

import (
	"log"
	"net/http"
	"net/http/pprof"
	"os"
	"runtime"
)

func startPprof() {
	addr := os.Getenv("CHIRKLE_PPROF")
	if addr == "" {
		return
	}
	runtime.SetMutexProfileFraction(5)
	runtime.SetBlockProfileRate(100_000) // a sample per 0.1 ms blocked
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Println("pprof:", err)
		}
	}()
}
