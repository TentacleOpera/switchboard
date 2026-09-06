//go:build windows

package main

import "os/exec"

func applySession(_ *exec.Cmd) {}

func killProcessTree(t *terminal) {
	if t == nil || t.cmd == nil || t.cmd.Process == nil {
		return
	}
	_ = t.cmd.Process.Kill()
}
