package launcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/TentacleOpera/switchboard/internal/client"
)

// DetectHostEntry resolves the Node host entry point (cli.js). Mirrors
// cmd/switchboard resolveNodeEntry but returns a typed result so the launcher
// can report the source alongside the value (the fallback rule: a missing
// host must be visible, not indistinguishable from "no entry configured").
//
// Precedence: SWITCHBOARD_NODE_ENTRYPOINT env; .deb layout; bundled layout
// (relative to the launcher executable); development layout (cwd). The target
// must be absolute, must exist, and must not be the launcher binary itself.
func DetectHostEntry() (entry string, source string) {
	if v := strings.TrimSpace(os.Getenv("SWITCHBOARD_NODE_ENTRYPOINT")); v != "" {
		abs, _ := filepath.Abs(v)
		if isJSFile(abs) {
			return abs, "env"
		}
	}
	deb := "/usr/lib/switchboard/standalone/cli.js"
	if isJSFile(deb) {
		return deb, "deb"
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		for _, cand := range []string{
			filepath.Join(exeDir, "standalone", "cli.js"),
			filepath.Join(exeDir, "..", "standalone", "cli.js"),
			filepath.Join(exeDir, "dist", "standalone", "cli.js"),
		} {
			abs, _ := filepath.Abs(cand)
			if isJSFile(abs) {
				return abs, "bundled"
			}
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		cand := filepath.Join(cwd, "dist", "standalone", "cli.js")
		if isJSFile(cand) {
			return cand, "cwd"
		}
	}
	return "", "none"
}

// isJSFile returns true when path exists, is a file, and is not the launcher
// executable itself (never recurse into the Go binary).
func isJSFile(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return false
	}
	if exe, err := os.Executable(); err == nil {
		if abs, _ := filepath.Abs(path); abs == exe {
			return false
		}
	}
	return true
}

// DetectNode resolves an absolute path to the node executable. Returns
// version, path, source. Source is "lookpath", "env" (SWITCHBOARD_NODE), or
// "well-known". Missing node is a hard blocker for Start — the launcher
// surfaces it as a missing dependency, never silently hands off to a
// non-existent interpreter.
func DetectNode() (version string, path string, source string, present bool) {
	if p, err := exec.LookPath("node"); err == nil {
		abs, _ := filepath.Abs(p)
		if abs == "" {
			abs = p
		}
		if v, ok := nodeVersion(abs); ok {
			return v, abs, "lookpath", true
		}
	}
	if v := strings.TrimSpace(os.Getenv("SWITCHBOARD_NODE")); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			if _, err := os.Stat(abs); err == nil {
				if ver, ok := nodeVersion(abs); ok {
					return ver, abs, "env", true
				}
			}
		}
	}
	for _, cand := range []string{
		"/usr/bin/node",
		"/usr/local/bin/node",
		"/opt/homebrew/bin/node",
	} {
		if _, err := os.Stat(cand); err == nil {
			if ver, ok := nodeVersion(cand); ok {
				return ver, cand, "well-known", true
			}
		}
	}
	return "", "", "none", false
}

// nodeVersion runs `node --version` with a short timeout. Returns false on any
// failure — a node that cannot identify itself is treated as missing.
func nodeVersion(nodePath string) (string, bool) {
	cmd := exec.Command(nodePath, "--version")
	cmd.Env = os.Environ()
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(out)), true
}

// DetectRunningHost probes loopback for a running Switchboard host serving the
// given workspace root. Returns the identity, port, source, and shutdown
// capability. Source is "local-discovery" (port-span probe) or "port-file"
// (<root>/.switchboard/api-server-port.txt). Returns nil identity when no host
// is reachable — the launcher treats this as StateHostStopped.
func DetectRunningHost(workspaceRoot string) (*HostIdentity, int, string, *ShutdownCapability, []string, string) {
	d := client.NewDiscoverer(workspaceRoot)
	if ep, ok := d.PortFile(); ok {
		return probeEndpoint(ep, workspaceRoot, "port-file")
	}
	if ep, ok := d.ProbeSpan(); ok {
		return probeEndpoint(ep, workspaceRoot, "local-discovery")
	}
	return nil, 0, "none", nil, nil, ""
}

func probeEndpoint(ep client.Endpoint, workspaceRoot, source string) (*HostIdentity, int, string, *ShutdownCapability, []string, string) {
	t := &client.Transport{BaseURL: ep.BaseURL, ServerRoot: workspaceRoot, HTTP: &http.Client{Timeout: 2 * time.Second}}
	h, err := t.GetHealth(2000)
	if err != nil || h == nil {
		return nil, 0, source, nil, nil, ""
	}
	var ident *HostIdentity
	if raw, ok := h.Raw["host"]; ok {
		var parsed HostIdentity
		if err := json.Unmarshal(raw, &parsed); err == nil && parsed.Kind != "" {
			ident = &parsed
		}
	}
	if ident == nil {
		// Old host without identity wiring. Mark unknown so the launcher
		// refuses mutation rather than guessing.
		ident = &HostIdentity{Kind: HostKindUnknown, Source: "health-no-identity"}
	}
	var caps *Capabilities
	if raw, ok := h.Raw["capabilities"]; ok {
		var parsed Capabilities
		if err := json.Unmarshal(raw, &parsed); err == nil {
			caps = &parsed
		}
	}
	var shutdown *ShutdownCapability
	if caps != nil {
		shutdown = &caps.Shutdown
	}
	selected := ""
	if h.SelectedWorkspaceRoot != nil {
		selected = *h.SelectedWorkspaceRoot
	}
	return ident, ep.Port, source, shutdown, h.Roots, selected
}

// HandoffStart runs the Node host entry point with `local` (or `tailnet` when
// serveTailnet is true) plus the original args, replacing the launcher
// process on Unix. The workspace root is passed via --workspace-root so the
// host does not infer it from cwd (the icon-launch bug the plan exists to
// fix). Returns an error when node or the entry is missing — the launcher
// surfaces the missing dependency rather than silently no-op'ing.
func HandoffStart(entry, workspaceRoot string, serveTailnet bool, extraArgs []string) error {
	node, err := resolveNodeAbs()
	if err != nil {
		return err
	}
	verb := "local"
	if serveTailnet {
		verb = "tailnet"
	}
	args := []string{verb, "--workspace-root", workspaceRoot}
	args = append(args, extraArgs...)
	all := append([]string{node, entry}, args...)
	if runtime.GOOS != "windows" {
		return syscall.Exec(node, all, os.Environ())
	}
	cmd := exec.Command(node, all[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	os.Exit(0)
	return nil
}

// HandoffSetup runs the Node host entry point with `setup` for first-run
// initialization. Same process-replacement semantics as HandoffStart.
func HandoffSetup(entry, workspaceRoot string, extraArgs []string) error {
	node, err := resolveNodeAbs()
	if err != nil {
		return err
	}
	args := []string{"setup", "--workspace-root", workspaceRoot}
	args = append(args, extraArgs...)
	all := append([]string{node, entry}, args...)
	if runtime.GOOS != "windows" {
		return syscall.Exec(node, all, os.Environ())
	}
	cmd := exec.Command(node, all[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	os.Exit(0)
	return nil
}

// HandoffOpen runs the Node host entry point with `status` (read-only) so the
// operator can see the running board. Open is the safe action for a running
// host; it never mutates state.
func HandoffOpen(entry, workspaceRoot string, extraArgs []string) error {
	node, err := resolveNodeAbs()
	if err != nil {
		return err
	}
	args := []string{"status", "--workspace-root", workspaceRoot}
	args = append(args, extraArgs...)
	all := append([]string{node, entry}, args...)
	if runtime.GOOS != "windows" {
		return syscall.Exec(node, all, os.Environ())
	}
	cmd := exec.Command(node, all[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		return err
	}
	os.Exit(0)
	return nil
}

// resolveNodeAbs mirrors cmd/switchboard resolveNode but returns the named
// error so the launcher can surface it as a missing dependency.
func resolveNodeAbs() (string, error) {
	if p, err := exec.LookPath("node"); err == nil {
		if abs, err := filepath.Abs(p); err == nil {
			return abs, nil
		}
		return p, nil
	}
	if v := strings.TrimSpace(os.Getenv("SWITCHBOARD_NODE")); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			if _, err := os.Stat(abs); err == nil {
				return abs, nil
			}
		}
	}
	for _, cand := range []string{
		"/usr/bin/node",
		"/usr/local/bin/node",
		"/opt/homebrew/bin/node",
	} {
		if _, err := os.Stat(cand); err == nil {
			return cand, nil
		}
	}
	return "", ErrNoNode
}

// ErrNoNode is the named error returned when no node executable can be
// resolved for the Node host handoff.
var ErrNoNode = fmt.Errorf("no node executable found: install Node.js, set SWITCHBOARD_NODE, or add node to PATH")

// HandoffLauncherState runs the Node host entry point with `launcher-state
// --json` so the workspace-mapping read goes through the existing
// KanbanDatabase service. The launcher never opens kanban.db. Process
// replacement on Unix; start/wait/exit on Windows.
func HandoffLauncherState(entry, workspaceRoot string) {
	node, err := resolveNodeAbs()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[launcher] "+err.Error())
		os.Exit(1)
	}
	args := []string{"launcher-state", "--json", "--workspace-root", workspaceRoot}
	all := append([]string{node, entry}, args...)
	if runtime.GOOS != "windows" {
		if err := syscall.Exec(node, all, os.Environ()); err != nil {
			fmt.Fprintf(os.Stderr, "[launcher] exec failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	cmd := exec.Command(node, all[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		fmt.Fprintf(os.Stderr, "[launcher] launcher-state handoff failed: %v\n", err)
		os.Exit(1)
	}
	os.Exit(0)
}
