// Package main is the switchboard-launcher static controller (plan:
// go-launcher-static-binary). It is a Go binary that can run before Node.js or
// Switchboard is installed: it supervises the standalone host, selects
// workspaces, attaches/starts/stops hosts safely, provides headless CLI
// behaviour, and embeds a loopback launcher UI. Linux amd64 and arm64 only.
//
// The launcher holds NO business logic. It talks HTTP — /health for state,
// /launcher/state for the host-owned projection, /shutdown for teardown — and
// hands off to the Node host entry point for start. It never opens kanban.db,
// reads board schemas, stores prompt text, or decides column behavior.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/TentacleOpera/switchboard/internal/client"
	"github.com/TentacleOpera/switchboard/internal/launcher"
)

const usage = `switchboard-launcher — static Linux launcher (plan: go-launcher-static-binary)

Usage:
  switchboard-launcher status [--workspace-root <path>] [--json]
  switchboard-launcher workspaces [--workspace-root <path>] [--json]
  switchboard-launcher open [--workspace-root <path>]
  switchboard-launcher start [--workspace-root <path>] [--tailnet] [-- <node-args...>]
  switchboard-launcher stop [--workspace-root <path>] [--json]
  switchboard-launcher doctor [--workspace-root <path>] [--json]
  switchboard-launcher install [--workspace-root <path>] [--json]
  switchboard-launcher setup [--workspace-root <path>] [-- <node-args...>]
  switchboard-launcher ui [--workspace-root <path>] [--port <port>]
  switchboard-launcher help
  switchboard-launcher version

The launcher never reads kanban.db, never duplicates board/schema/prompt/column
logic, and never performs privileged installation automatically. Stop is
loopback-only and requires the host to declare kind=standalone with
shutdown.enabled=true; the extension host is never stopped.

--workspace-root defaults to the current working directory. Pass it explicitly
for icon/desktop launches so the host does not infer the workspace from cwd.
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 || hasFlag(args, "--help") || hasFlag(args, "-h") || firstPositional(args) == "help" {
		fmt.Print(usage)
		return
	}
	verb := firstPositional(args)
	if verb == "version" || verb == "--version" || verb == "-v" {
		fmt.Println("switchboard-launcher " + launcherVersion + " " + buildArch)
		return
	}

	workspaceRoot, remaining := extractWorkspaceRoot(args)
	if workspaceRoot == "" {
		cwd, err := os.Getwd()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[launcher] cannot resolve cwd: %v\n", err)
			os.Exit(1)
		}
		workspaceRoot = cwd
	}
	abs, err := filepath.Abs(workspaceRoot)
	if err == nil {
		workspaceRoot = abs
	}
	jsonFlag := hasFlag(remaining, "--json")

	switch verb {
	case "status":
		cmdStatus(workspaceRoot, jsonFlag)
	case "workspaces":
		cmdWorkspaces(workspaceRoot, jsonFlag)
	case "open":
		cmdOpen(workspaceRoot, remaining)
	case "start":
		cmdStart(workspaceRoot, remaining)
	case "stop":
		cmdStop(workspaceRoot, jsonFlag)
	case "doctor":
		cmdDoctor(workspaceRoot, jsonFlag)
	case "install":
		cmdInstall(workspaceRoot, jsonFlag)
	case "setup":
		cmdSetup(workspaceRoot, remaining)
	case "ui":
		cmdUI(workspaceRoot, remaining)
	default:
		fmt.Fprintf(os.Stderr, "[launcher] unknown verb '%s'\n", verb)
		fmt.Print(usage)
		os.Exit(2)
	}
}

// cmdStatus resolves the launcher state and prints it. The state is the
// symbolic name (see launcher.StateXxx); the JSON form includes every detected
// fact with its source so a stale projection is visible.
func cmdStatus(workspaceRoot string, jsonFlag bool) {
	state := resolveState(workspaceRoot)
	if jsonFlag {
		emitJSON(state)
		return
	}
	printStateHuman(state)
}

// cmdWorkspaces prints the named-workspace projection. When a host is running,
// proxies GET /launcher/state. When no host is running, the launcher shells
// out to `switchboard launcher-state --json` (Node host entry point) so the
// workspace mapping read goes through the existing KanbanDatabase service —
// Go never parses the database.
func cmdWorkspaces(workspaceRoot string, jsonFlag bool) {
	ident, port, _, _, _, _ := launcher.DetectRunningHost(workspaceRoot)
	if ident != nil && port > 0 {
		// Running host — proxy the authoritative projection.
		t := buildTransport(workspaceRoot, port)
		proj, err := launcher.FetchLauncherState(t)
		if err != nil {
			if err == launcher.ErrLauncherStateUnavailable {
				// Old host without the route — fall back to Node host.
				fallbackWorkspacesViaNode(workspaceRoot, jsonFlag)
				return
			}
			fmt.Fprintf(os.Stderr, "[launcher] /launcher/state failed: %v\n", err)
			os.Exit(1)
		}
		if jsonFlag {
			emitJSON(proj.WorkspaceMappings)
		} else {
			printWorkspacesHuman(proj.WorkspaceMappings)
		}
		return
	}
	// Stopped — defer to the Node host's launcher-state command.
	fallbackWorkspacesViaNode(workspaceRoot, jsonFlag)
}

// fallbackWorkspacesViaNode shells out to `switchboard launcher-state --json`
// through the Node host entry point. The Node host reads workspace mappings
// through KanbanDatabase; Go never opens the database.
func fallbackWorkspacesViaNode(workspaceRoot string, jsonFlag bool) {
	entry, _ := launcher.DetectHostEntry()
	if entry == "" {
		ws := launcher.WorkspaceProjection{
			Unavailable: true,
			Reason:      "no Node host installed — cannot read workspace mappings",
			Source:      "launcher-no-host",
		}
		if jsonFlag {
			emitJSON(ws)
		} else {
			fmt.Println("[launcher] No Node host installed — cannot read workspace mappings.")
		}
		return
	}
	// Hand off to `switchboard launcher-state --json` (Node host). The child
	// owns the KanbanDatabase read; the launcher only forwards stdout.
	launcher.HandoffLauncherState(entry, workspaceRoot)
}

// cmdOpen hands off to `switchboard status` (read-only) on the Node host. Open
// is the safe action for a running host; it never mutates state.
func cmdOpen(workspaceRoot string, remaining []string) {
	entry, _ := launcher.DetectHostEntry()
	if entry == "" {
		fmt.Fprintln(os.Stderr, "[launcher] No Node host installed — cannot open board.")
		os.Exit(127)
	}
	extra := stripVerbAndRoot(remaining, "open")
	if err := launcher.HandoffOpen(entry, workspaceRoot, extra); err != nil {
		fmt.Fprintf(os.Stderr, "[launcher] open handoff failed: %v\n", err)
		os.Exit(1)
	}
}

// cmdStart hands off to `switchboard local` (or `--tailnet`) on the Node host.
// The workspace root is passed via --workspace-root so the host does not infer
// it from cwd (the icon-launch bug the plan exists to fix).
func cmdStart(workspaceRoot string, remaining []string) {
	entry, entrySource := launcher.DetectHostEntry()
	if entry == "" {
		fmt.Fprintf(os.Stderr, "[launcher] No Node host installed (source: %s). Run `switchboard-launcher install` or install the switchboard package.\n", entrySource)
		os.Exit(127)
	}
	serveTailnet := hasFlag(remaining, "--tailnet")
	extra := stripVerbAndRoot(remaining, "start")
	// Strip --tailnet from forwarded args; it is consumed by the launcher.
	extra = removeFlag(extra, "--tailnet")
	if err := launcher.HandoffStart(entry, workspaceRoot, serveTailnet, extra); err != nil {
		fmt.Fprintf(os.Stderr, "[launcher] start handoff failed: %v\n", err)
		os.Exit(1)
	}
}

// cmdStop calls the loopback-only authenticated /shutdown route. Refuses an
// extension host, an identity-less host, or a host that declared shutdown
// disabled. The host verifies kind/capability/loopback again server-side; this
// CLI gate is the first line, not the only one.
func cmdStop(workspaceRoot string, jsonFlag bool) {
	ident, port, source, shutdown, _, _ := launcher.DetectRunningHost(workspaceRoot)
	if ident == nil || port == 0 {
		if jsonFlag {
			emitJSON(map[string]any{"success": false, "error": "no running host", "source": source})
		} else {
			fmt.Fprintln(os.Stderr, "[launcher] No running Switchboard instance found for this workspace.")
		}
		os.Exit(1)
	}
	if ident.Kind == launcher.HostKindExtension {
		reason := "extension host does not own process teardown — close VS Code to stop"
		if shutdown != nil && shutdown.Reason != "" {
			reason = shutdown.Reason
		}
		if jsonFlag {
			emitJSON(map[string]any{"success": false, "error": "refused", "reason": reason, "hostKind": string(ident.Kind)})
		} else {
			fmt.Fprintf(os.Stderr, "[launcher] Refusing to stop: %s\n", reason)
		}
		os.Exit(1)
	}
	if ident.Kind == launcher.HostKindUnknown {
		if jsonFlag {
			emitJSON(map[string]any{"success": false, "error": "refused", "reason": "host reported no identity (old version) — cannot verify it is safe to stop", "hostKind": string(ident.Kind)})
		} else {
			fmt.Fprintln(os.Stderr, "[launcher] Refusing to stop: host reported no identity (old version).")
		}
		os.Exit(1)
	}
	if shutdown == nil || !shutdown.Enabled {
		reason := "host declared shutdown disabled"
		if shutdown != nil && shutdown.Reason != "" {
			reason = shutdown.Reason
		}
		if jsonFlag {
			emitJSON(map[string]any{"success": false, "error": "refused", "reason": reason, "hostKind": string(ident.Kind)})
		} else {
			fmt.Fprintf(os.Stderr, "[launcher] Refusing to stop: %s\n", reason)
		}
		os.Exit(1)
	}
	t := buildTransport(workspaceRoot, port)
	body, err := launcher.PostShutdown(t)
	if err != nil {
		if jsonFlag {
			emitJSON(map[string]any{"success": false, "error": err.Error()})
		} else {
			fmt.Fprintf(os.Stderr, "[launcher] %v\n", err)
		}
		os.Exit(1)
	}
	if jsonFlag {
		emitJSON(map[string]any{"success": true, "host": map[string]any{"kind": string(ident.Kind), "instanceId": ident.InstanceID}, "response": body})
	} else {
		fmt.Printf("[launcher] Stop requested (instance %s, port %d). Host is tearing down.\n", ident.InstanceID, port)
	}
}

// cmdDoctor prints the detected prerequisites and host state. Each fact
// carries its source. Missing dependencies are surfaced, never silently
// defaulted.
func cmdDoctor(workspaceRoot string, jsonFlag bool) {
	state := resolveState(workspaceRoot)
	if jsonFlag {
		emitJSON(state)
		return
	}
	printDoctorHuman(state)
}

// cmdInstall is a placeholder. Automatic privileged installation is disabled
// pending research (plan: User Review Required). The command surfaces the
// detected missing prerequisites and points the operator at the documented
// install path; it never runs apt/dpkg/sudo itself.
func cmdInstall(workspaceRoot string, jsonFlag bool) {
	state := resolveState(workspaceRoot)
	if jsonFlag {
		emitJSON(map[string]any{
			"success":              false,
			"error":                "automatic installation is disabled pending research",
			"source":               "launcher-install-cmd",
			"detectedState":        state,
			"manualInstallHint":    "Install Node.js 22+ and the switchboard package, then re-run `switchboard-launcher doctor`.",
			"automaticInstallDisabled": true,
		})
		return
	}
	fmt.Println("[launcher] Automatic installation is disabled pending research (plan: User Review Required).")
	fmt.Println("[launcher] Detected state:")
	printDoctorHuman(state)
	fmt.Println("[launcher] Manual install: install Node.js 22+ and the switchboard package, then re-run `switchboard-launcher doctor`.")
}

// cmdSetup hands off to `switchboard setup` on the Node host for first-run
// initialization.
func cmdSetup(workspaceRoot string, remaining []string) {
	entry, _ := launcher.DetectHostEntry()
	if entry == "" {
		fmt.Fprintln(os.Stderr, "[launcher] No Node host installed — cannot run setup.")
		os.Exit(127)
	}
	extra := stripVerbAndRoot(remaining, "setup")
	if err := launcher.HandoffSetup(entry, workspaceRoot, extra); err != nil {
		fmt.Fprintf(os.Stderr, "[launcher] setup handoff failed: %v\n", err)
		os.Exit(1)
	}
}

// cmdUI starts the embedded loopback launcher UI. The UI is served on a
// loopback port and opened in the default browser. It is presentation only —
// every action routes back through the headless commands above.
func cmdUI(workspaceRoot string, remaining []string) {
	port := extractPort(remaining, 0)
	serveLauncherUI(workspaceRoot, port)
}

// resolveState is the controller's core: detect host entry, node, running
// host, then derive the symbolic state. Every fact carries its source.
func resolveState(workspaceRoot string) launcher.LauncherState {
	entry, entrySource := launcher.DetectHostEntry()
	nodeVer, nodePath, nodeSource, nodePresent := launcher.DetectNode()
	ident, port, runSource, shutdown, roots, selected := launcher.DetectRunningHost(workspaceRoot)

	var deps []launcher.DependencyFact
	deps = append(deps, launcher.DependencyFact{
		Name: "node", Present: nodePresent, Version: nodeVer, Path: nodePath, Source: nodeSource,
		Note: ifMissing(nodePresent, "Node.js 22+ required to run the Switchboard host"),
	})

	hostInstalled := entry != ""
	missingDep := !nodePresent
	stateName := launcher.ResolveState(hostInstalled, ident, shutdown, missingDep)
	sysFacts := launcher.DetectSystem()

	ws := launcher.WorkspaceProjection{}
	if ident != nil && port > 0 {
		t := buildTransport(workspaceRoot, port)
		proj, err := launcher.FetchLauncherState(t)
		if err == nil {
			ws = proj.WorkspaceMappings
		} else if err == launcher.ErrLauncherStateUnavailable {
			ws = launcher.WorkspaceProjection{Unavailable: true, Reason: "running host has no /launcher/state route (old version)", Source: "host-404"}
		} else {
			ws = launcher.WorkspaceProjection{Unavailable: true, Reason: err.Error(), Source: "host-fetch-error"}
		}
	} else {
		// Stopped — the workspaces command shells out to Node for the read.
		// For the status projection, mark unavailable with a source so the
		// state is visible; the workspaces command does the authoritative read.
		ws = launcher.WorkspaceProjection{Unavailable: true, Reason: "host not running — run `switchboard-launcher workspaces` for the local-DB projection", Source: "launcher-no-running-host"}
	}

	s := launcher.LauncherState{
		HostInstalled: hostInstalled,
		HostEntry:     entry,
		HostSource:    entrySource,
		RunningHost:   ident,
		RunningPort:   port,
		RunningSource: runSource,
		ShutdownCap:   shutdown,
		SelectedRoot:  selected,
		ServedRoots:   roots,
		Workspaces:    ws,
		Dependencies:  deps,
		SystemFacts:   &sysFacts,
		State:         stateName,
	}
	return s
}

func ifMissing(present bool, msg string) string {
	if present {
		return ""
	}
	return msg
}

// buildTransport constructs a client.Transport for a loopback endpoint. The
// token is resolved from the workspace's durable token file when present.
func buildTransport(workspaceRoot string, port int) *client.Transport {
	baseURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	t := &client.Transport{BaseURL: baseURL, ServerRoot: workspaceRoot, HTTP: httpClient2s()}
	// Token resolution: read <root>/.switchboard/api-token.txt when present.
	// The host writes a one-time token here for loopback CLI use; the durable
	// secret (switchboard.apiToken) is in the OS secrets store, which Go
	// cannot read portably. The token file is the documented loopback path.
	if tok, ok := readLoopbackToken(workspaceRoot); ok {
		t.Token = tok
	}
	return t
}

func readLoopbackToken(workspaceRoot string) (string, bool) {
	for _, cand := range []string{
		filepath.Join(workspaceRoot, ".switchboard", "api-token.txt"),
		filepath.Join(workspaceRoot, ".switchboard", "one-time-token.txt"),
	} {
		if b, err := os.ReadFile(cand); err == nil {
			s := strings.TrimSpace(string(b))
			if s != "" {
				return s, true
			}
		}
	}
	return "", false
}

// printStateHuman prints the resolved state in human-readable form.
func printStateHuman(s launcher.LauncherState) {
	fmt.Printf("State: %s\n", s.State)
	if s.RunningHost != nil {
		fmt.Printf("Running host: kind=%s instance=%s version=%s source=%s port=%d\n",
			s.RunningHost.Kind, s.RunningHost.InstanceID, s.RunningHost.Version, s.RunningHost.Source, s.RunningPort)
	} else {
		fmt.Println("Running host: none")
	}
	if s.HostInstalled {
		fmt.Printf("Host entry: %s (source: %s)\n", s.HostEntry, s.HostSource)
	} else {
		fmt.Printf("Host entry: not installed (source: %s)\n", s.HostSource)
	}
	fmt.Printf("Available actions: %s\n", strings.Join(s.AvailableActions(), ", "))
}

func printDoctorHuman(s launcher.LauncherState) {
	fmt.Println("=== switchboard-launcher doctor ===")
	fmt.Printf("State: %s\n", s.State)
	for _, d := range s.Dependencies {
		status := "missing"
		if d.Present {
			status = "ok"
		}
		fmt.Printf("  dependency %s: %s (source: %s)\n", d.Name, status, d.Source)
		if d.Version != "" {
			fmt.Printf("    version: %s\n", d.Version)
		}
		if d.Path != "" {
			fmt.Printf("    path: %s\n", d.Path)
		}
		if d.Note != "" {
			fmt.Printf("    note: %s\n", d.Note)
		}
	}
	if s.HostInstalled {
		fmt.Printf("Host entry: %s (source: %s)\n", s.HostEntry, s.HostSource)
	} else {
		fmt.Printf("Host entry: not installed (source: %s)\n", s.HostSource)
	}
	if s.RunningHost != nil {
		fmt.Printf("Running host: kind=%s instance=%s version=%s source=%s port=%d\n",
			s.RunningHost.Kind, s.RunningHost.InstanceID, s.RunningHost.Version, s.RunningHost.Source, s.RunningPort)
		if s.ShutdownCap != nil {
			fmt.Printf("  shutdown: enabled=%v reason=%s\n", s.ShutdownCap.Enabled, s.ShutdownCap.Reason)
		}
	} else {
		fmt.Println("Running host: none")
	}
	if s.SystemFacts != nil {
		sf := s.SystemFacts
		fmt.Printf("System: apt=%v dpkg=%v arch=%s systemd=%v desktop=%q privileged=%v\n",
			sf.AptPresent, sf.DpkgPresent, sf.Architecture, sf.SystemdRunning, sf.DesktopSession, sf.Privileged)
	}
	fmt.Println("Install: automatic privileged installation is disabled pending research (plan: User Review Required).")
}

func printWorkspacesHuman(ws launcher.WorkspaceProjection) {
	if ws.Unavailable {
		fmt.Printf("Workspaces: unavailable — %s (source: %s)\n", ws.Reason, ws.Source)
		return
	}
	if len(ws.Value) == 0 {
		fmt.Println("Workspaces: none configured (source: " + ws.Source + ")")
		return
	}
	fmt.Printf("Workspaces (source: %s):\n", ws.Source)
	for _, w := range ws.Value {
		label := w.Label
		if label == "" {
			label = "(unlabeled)"
		}
		enabled := "enabled"
		if !w.Enabled {
			enabled = "disabled"
		}
		fmt.Printf("  %s  %s  [%s]\n", w.Root, label, enabled)
	}
}

// emitJSON writes a JSON payload to stdout with 2-space indentation and a
// trailing newline, matching cli.ts emitJson. HTML escaping is disabled so `&`
// stays as `&`, matching Node's JSON.stringify default.
func emitJSON(payload any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(payload); err != nil {
		fmt.Fprintln(os.Stderr, "[launcher] internal error: could not encode JSON payload")
		os.Exit(1)
	}
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

func firstPositional(args []string) string {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	return ""
}

// extractWorkspaceRoot pulls --workspace-root <path> or --workspace-root=<path>
// out of the argument list, returning the root and the remaining args.
func extractWorkspaceRoot(args []string) (string, []string) {
	remaining := make([]string, 0, len(args))
	var root string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--workspace-root":
			if i+1 < len(args) {
				root = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "--workspace-root="):
			root = a[len("--workspace-root="):]
		default:
			remaining = append(remaining, a)
		}
	}
	return root, remaining
}

func extractPort(args []string, defaultPort int) int {
	for i := 0; i < len(args); i++ {
		if args[i] == "--port" && i+1 < len(args) {
			p := 0
			fmt.Sscanf(args[i+1], "%d", &p)
			if p > 0 {
				return p
			}
		}
		if strings.HasPrefix(args[i], "--port=") {
			p := 0
			fmt.Sscanf(args[i][len("--port="):], "%d", &p)
			if p > 0 {
				return p
			}
		}
	}
	return defaultPort
}

func stripVerbAndRoot(args []string, verb string) []string {
	out := make([]string, 0, len(args))
	removedVerb := false
	for _, a := range args {
		if !removedVerb && a == verb {
			removedVerb = true
			continue
		}
		if a == "--workspace-root" || strings.HasPrefix(a, "--workspace-root=") {
			continue
		}
		if a == "--json" {
			continue
		}
		out = append(out, a)
	}
	return out
}

func removeFlag(args []string, flag string) []string {
	out := make([]string, 0, len(args))
	for _, a := range args {
		if a == flag {
			continue
		}
		out = append(out, a)
	}
	return out
}
