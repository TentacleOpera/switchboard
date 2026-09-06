package launcher

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// SystemFacts are the detected system prerequisites the launcher reports to
// `doctor` and `install` (the latter is disabled — these facts only inform the
// operator, never drive a privileged install). Every fact carries its source
// so a stale detection is visible. No fact here performs a privileged
// operation: apt/dpkg are probed via `--version`/`--print-architecture` only,
// systemd via `pidof`/`systemctl` (read-only), and the desktop session via
// env vars. The launcher never runs `apt install`, `sudo`, or `dpkg -i`.
type SystemFacts struct {
	AptPresent       bool   `json:"aptPresent"`
	AptPath          string `json:"aptPath,omitempty"`
	DpkgPresent      bool   `json:"dpkgPresent"`
	DpkgPath         string `json:"dpkgPath,omitempty"`
	Architecture     string `json:"architecture,omitempty"`
	ArchitectureSrc  string `json:"architectureSource,omitempty"`
	SystemdRunning   bool   `json:"systemdRunning"`
	SystemdSource    string `json:"systemdSource,omitempty"`
	DesktopSession   string `json:"desktopSession,omitempty"`
	DesktopSessionSrc string `json:"desktopSessionSource,omitempty"`
	Privileged       bool   `json:"privileged"`
	PrivilegedSrc    string `json:"privilegedSource,omitempty"`
}

// DetectSystem collects the non-Node system facts the launcher reports. It is
// read-only and never performs a privileged operation. Missing tools are
// reported as absent with their source; the launcher never substitutes a
// plausible default (the fallback rule).
func DetectSystem() SystemFacts {
	var f SystemFacts
	if p, err := exec.LookPath("apt"); err == nil {
		f.AptPresent = true
		f.AptPath = absOr(p)
	}
	if p, err := exec.LookPath("dpkg"); err == nil {
		f.DpkgPresent = true
		f.DpkgPath = absOr(p)
	}
	if f.DpkgPresent {
		out, err := exec.Command(f.DpkgPath, "--print-architecture").Output()
		if err == nil {
			f.Architecture = strings.TrimSpace(string(out))
			f.ArchitectureSrc = "dpkg --print-architecture"
		}
	}
	// systemd detection: pidof init (systemd) is the cheap read-only probe.
	// `systemctl is-system-running` would also work but requires the unit
	// manager to be reachable; pidof is sufficient for "is systemd the init".
	if _, err := exec.LookPath("pidof"); err == nil {
		if err := exec.Command("pidof", "systemd").Run(); err == nil {
			f.SystemdRunning = true
			f.SystemdSource = "pidof systemd"
		}
	}
	if v := os.Getenv("XDG_CURRENT_DESKTOP"); v != "" {
		f.DesktopSession = v
		f.DesktopSessionSrc = "XDG_CURRENT_DESKTOP"
	} else if v := os.Getenv("XDG_SESSION_DESKTOP"); v != "" {
		f.DesktopSession = v
		f.DesktopSessionSrc = "XDG_SESSION_DESKTOP"
	} else if v := os.Getenv("DESKTOP_SESSION"); v != "" {
		f.DesktopSession = v
		f.DesktopSessionSrc = "DESKTOP_SESSION"
	}
	// Privilege: geteuid() == 0 on Unix. The launcher never escalates; this
	// fact only informs the operator that a manual install step would need
	// sudo. On non-Unix it is always false.
	if os.Geteuid() == 0 {
		f.Privileged = true
		f.PrivilegedSrc = "geteuid"
	}
	return f
}

func absOr(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}
