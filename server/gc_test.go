package main

import (
	"runtime"
	"testing"
)

func TestMachineMemory(t *testing.T) {
	n := machineMemory()
	if runtime.GOOS == "linux" && n <= 0 {
		t.Fatalf("machineMemory() = %d on Linux", n)
	}
	if n < 0 {
		t.Fatalf("machineMemory() = %d", n)
	}
}
