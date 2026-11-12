package main

// Garbage collection (docs/PERF.md §13). Go's default (GOGC=100) collected so often that GC took ~12% of a small VPS's
// one core under load; at 200 the same load ran with sends twice as fast. The heap may then grow further between
// collections, so unless GOMEMLIMIT says otherwise the server holds it to 70% of the machine's memory (cgroup limit or
// RAM), where Go collects harder instead of growing. GOGC or GOMEMLIMIT in the environment win, as Go reads them.

import (
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

const (
	defaultGOGC  = 200
	memoryShare  = 0.7
	minimumLimit = 256 << 20 // never below this, whatever the machine says
)

func tuneGC() {
	if os.Getenv("GOGC") == "" {
		debug.SetGCPercent(defaultGOGC)
	}
	if os.Getenv("GOMEMLIMIT") == "" {
		if total := machineMemory(); total > 0 {
			debug.SetMemoryLimit(max(int64(float64(total)*memoryShare), minimumLimit))
		}
	}
}

// machineMemory: the bytes this process may use, the cgroup's limit when there is one, else the RAM; 0 if unknown
// (not Linux).
func machineMemory() int64 {
	ram := int64(0)
	if b, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[0] == "MemTotal:" {
				if kb, err := strconv.ParseInt(f[1], 10, 64); err == nil {
					ram = kb << 10
				}
			}
		}
	}
	for _, path := range []string{"/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"} {
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		// "max", or a huge number, when there is no limit.
		if n, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64); err == nil && n > 0 && (ram == 0 || n < ram) {
			return n
		}
	}
	return ram
}
