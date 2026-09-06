//go:build !windows

package main

import (
	"os/exec"
	"syscall"
	"time"
)

func applySession(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

func killProcessTree(t *terminal) {
	if t == nil || t.cmd == nil || t.cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_, _ = t.cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		_ = syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
		_ = t.cmd.Process.Kill()
	}
}
