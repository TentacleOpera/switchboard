// Package main is the switchboard static front controller. It owns argument
// parsing, tagged endpoint/server-root/credential resolution, the owned client
// verbs, and absolute Node-host handoff for non-client verbs. It never searches
// PATH for a lookalike, never recurses into itself, and never reinterprets
// setup, import/export, secrets, token, control-plane, local, or tailnet.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/TentacleOpera/switchboard/internal/client"
)

// ownedVerbs is the set of commands the Go client serves directly. Everything
// else is delegated to the Node host entry point.
var ownedVerbs = map[string]bool{
	"plans": true, "ready": true, "dispatch": true, "done": true, "next": true,
	"clear": true, "fleet": true, "verb": true, "api": true, "status": true,
	"logs": true, "probe": true, "help": true, "about": true, "version": true,
}

// connectionFlags are the global routing flags the Go client adds. They are
// extracted from the full argument list before verb dispatch. --endpoint and
// --server-root are accepted as aliases for --server and --workspace-root so a
// remote invocation spelled with either name is routed into remote mode
// (SourceExplicitFlag) rather than silently ignored and left to fall back to
// local discovery.
var connectionFlags = map[string]bool{
	"--server": true, "--endpoint": true,
	"--workspace-root": true, "--server-root": true,
	"--token-file": true,
}

func main() {
	args := os.Args[1:]

	// Bare invocation: delegate to the Node host (interactive front-door menu).
	// A client-only installation has no Node entry and reports the named error.
	if len(args) == 0 {
		delegateOrNoHost(args)
		return
	}

	// Extract global connection flags and --json/--help/--version that may
	// appear anywhere. The verb is the first remaining positional.
	connOpts, remaining := extractConnectionFlags(args)

	// --help/-h with no verb: show help directly.
	if hasFlag(remaining, "--help") || hasFlag(remaining, "-h") {
		c := &client.Client{}
		c.CmdHelpForMain()
		return
	}

	verb := firstPositional(remaining)
	if verb == "" {
		// Only flags, no verb: delegate to Node (e.g. `switchboard --hostname foo`).
		delegateOrNoHost(args)
		return
	}

	// --version/-v at the top level maps to about.
	if verb == "--version" || verb == "-v" {
		verb = "version"
	}

	if !ownedVerbs[verb] {
		// Non-client verb: hand off to the Node host with original arguments.
		delegateOrNoHost(args)
		return
	}

	// Owned verb: resolve routes and dispatch.
	runOwnedVerb(verb, remaining, connOpts)
}

// runOwnedVerb resolves routing values, builds a Client, and dispatches the
// owned verb. The jsonFlag is detected from the verb's own argument list
// (matching Node's per-command `argv.includes('--json')`).
func runOwnedVerb(verb string, args []string, connOpts client.Options) {
	cwd, _ := os.Getwd()
	if connOpts.ClientCwd == "" {
		connOpts.ClientCwd = cwd
	}
	if connOpts.Env == nil {
		connOpts.Env = envMap()
	}

	// Resolve endpoint. For `status` and `about` we want to report offline
	// gracefully; for other verbs we fail loudly when no endpoint is found.
	disc := client.NewDiscoverer(cwd)
	endpoint, err := client.ResolveEndpoint(connOpts, disc)
	if err != nil {
		// `status` and `about` emit their offline shape instead of erroring.
		if verb == "status" {
			jsonFlag := hasFlag(args, "--json")
			client.EmitStatusOffline(jsonFlag)
			os.Exit(1)
		}
		if verb == "about" || verb == "version" {
			runAboutNoEndpoint(connOpts, args)
			return
		}
		// All other verbs: emit offline guidance.
		jsonFlag := hasFlag(args, "--json")
		client.EmitOfflineGuidance(jsonFlag)
		return
	}

	// Fetch health to validate identity and resolve the server root fallback.
	// For an explicit endpoint we do NOT add an unconditional preflight that
	// doubles every request — except that we need roots to resolve the
	// server-root for remote. We fetch health once here (it is the endpoint
	// resolution step), then the verb re-fetches only what it needs.
	probe := client.NewTransportFromEndpoint(endpoint.Value)
	health, _ := probe.GetHealth(2000)

	serverRoot, err := client.ResolveServerRoot(connOpts, endpoint, health)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[switchboard] "+err.Error())
		if mr, ok := err.(*client.MissingRootError); ok && len(mr.Roots) > 0 {
			fmt.Fprintln(os.Stderr, "Advertised roots:")
			for _, r := range mr.Roots {
				fmt.Fprintf(os.Stderr, "  %s\n", r)
			}
			fmt.Fprintln(os.Stderr, "Pass --workspace-root <path> or SWITCHBOARD_WORKSPACE_ROOT.")
		}
		os.Exit(1)
	}

	token := client.ResolveToken(connOpts)

	localBoard := endpoint.Source == client.SourceLocalProbe || endpoint.Source == client.SourcePortFile
	routes := client.Routes{
		Endpoint:   endpoint,
		ServerRoot: serverRoot,
		Token:      token,
		LocalBoard: localBoard,
	}

	nodeEntry, nodeSource := resolveNodeEntry()
	c := client.NewClient(routes, nodeEntry, nodeSource)
	c.JSONFlag = hasFlag(args, "--json")
	dispatchOwned(c, verb, args)
}

// runAboutNoEndpoint handles `about`/`version` when no board is reachable, so
// the Go client still identifies itself and its Node-host resolution.
func runAboutNoEndpoint(opts client.Options, args []string) {
	nodeEntry, nodeSource := resolveNodeEntry()
	c := &client.Client{
		Routes: client.Routes{
			ServerRoot: client.Resolved[string]{Value: opts.WorkspaceRoot, Source: client.SourceExplicitFlag},
		},
		NodeEntry:  nodeEntry,
		NodeSource: nodeSource,
		JSONFlag:   hasFlag(args, "--json"),
	}
	c.CmdAboutForMain()
}

// dispatchOwned routes an owned verb to its Client method.
func dispatchOwned(c *client.Client, verb string, args []string) {
	// Strip the verb token from args.
	rest := stripVerb(args, verb)
	switch verb {
	case "plans":
		c.CmdPlans(rest)
	case "ready":
		c.CmdReady(rest)
	case "dispatch":
		c.CmdDispatch(rest)
	case "done":
		c.CmdDone(rest)
	case "next":
		c.CmdNext(rest)
	case "clear":
		c.CmdClear(rest)
	case "fleet":
		c.CmdFleet(rest)
	case "verb":
		c.CmdVerb(rest)
	case "api":
		c.CmdApi(rest)
	case "status":
		c.CmdStatus(rest)
	case "logs":
		c.CmdLogs(rest)
	case "probe":
		c.CmdProbe(rest)
	case "help":
		c.CmdHelp(rest)
	case "about", "version":
		c.CmdAbout(rest)
	default:
		// Should not happen (ownedVerbs gate), but fail loudly rather than
		// silently fall through to Node.
		fmt.Fprintf(os.Stderr, "[switchboard] internal error: unowned verb '%s' reached dispatch\n", verb)
		os.Exit(1)
	}
}

// delegateOrNoHost resolves the Node host entry point and runs it with the
// original arguments. If no entry point is installed, emits the named
// "no board host installed" error.
func delegateOrNoHost(originalArgs []string) {
	entry, source := resolveNodeEntry()
	if entry == "" {
		fmt.Fprintln(os.Stderr, "[switchboard] This machine has no board host installed.")
		fmt.Fprintln(os.Stderr, "[switchboard] Non-client verbs (local, tailnet, setup, secrets, import/export,")
		fmt.Fprintln(os.Stderr, "[switchboard] token, control-plane, interactive menu) require the Node host.")
		fmt.Fprintln(os.Stderr, "[switchboard] Install the switchboard package, or set SWITCHBOARD_NODE_ENTRYPOINT.")
		os.Exit(127)
	}
	if err := execNode(entry, originalArgs); err != nil {
		fmt.Fprintf(os.Stderr, "[switchboard] Node host entry point %s (%s) failed: %v\n", entry, source, err)
		os.Exit(1)
	}
}

// resolveNodeEntry resolves the absolute Node host entry point (cli.js).
//
// Precedence: SWITCHBOARD_NODE_ENTRYPOINT env; then known install layouts:
// .deb (/usr/lib/switchboard/standalone/cli.js), bundled extension/standalone
// (relative to the executable), and development (dist/standalone/cli.js
// relative to cwd). The target must be absolute, must exist, and must not be
// the current Go executable.
func resolveNodeEntry() (string, client.Source) {
	if v := strings.TrimSpace(os.Getenv("SWITCHBOARD_NODE_ENTRYPOINT")); v != "" {
		abs, _ := filepath.Abs(v)
		if isNodeEntry(abs) {
			return abs, client.SourceEnv
		}
	}
	// .deb layout.
	deb := "/usr/lib/switchboard/standalone/cli.js"
	if isNodeEntry(deb) {
		return deb, client.SourceExplicitFlag
	}
	// Bundled layout: <exe-dir>/standalone/cli.js or <exe-dir>/../standalone/cli.js.
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		for _, cand := range []string{
			filepath.Join(exeDir, "standalone", "cli.js"),
			filepath.Join(exeDir, "..", "standalone", "cli.js"),
			filepath.Join(exeDir, "dist", "standalone", "cli.js"),
		} {
			abs, _ := filepath.Abs(cand)
			if isNodeEntry(abs) {
				return abs, client.SourceExplicitFlag
			}
		}
	}
	// Development layout: dist/standalone/cli.js relative to cwd.
	if cwd, err := os.Getwd(); err == nil {
		cand := filepath.Join(cwd, "dist", "standalone", "cli.js")
		if isNodeEntry(cand) {
			return cand, client.SourceCwd
		}
	}
	return "", client.SourceNone
}

// isNodeEntry returns true when path exists, is a file, is not the current Go
// executable, and looks like a cli.js entry point.
func isNodeEntry(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return false
	}
	if exe, err := os.Executable(); err == nil {
		if abs, _ := filepath.Abs(path); abs == exe {
			return false // never recurse into the Go binary
		}
	}
	return true
}

// execNode runs the Node host entry point with original arguments, preserving
// stdin/stdout/stderr, working directory, and environment. Uses process
// replacement where supported (exec on Unix).
//
// Node is resolved to an absolute executable path because syscall.Exec calls
// execve(2), which does NOT perform PATH lookup — a bare "node" fails with
// ENOENT when node is only reachable via PATH. Resolution order:
// exec.LookPath("node"); SWITCHBOARD_NODE env; a few well-known absolute
// locations; then a named no-host-installed error.
//
// argv is built as [node, entry, args...] so that execve treats argv[0] as the
// program name and argv[1] as the script (cli.js). Building it as
// [entry, args...] would make node interpret the first user arg (e.g. "setup")
// as the script.
func execNode(entry string, args []string) error {
	node, err := resolveNode()
	if err != nil {
		return err
	}
	all := append([]string{node, entry}, args...)
	if runtime.GOOS != "windows" {
		// Process replacement: the child becomes this process. Signals,
		// stdin/stdout/stderr, and exit status are preserved by the kernel.
		if err := syscall.Exec(node, all, os.Environ()); err != nil {
			return err
		}
		return nil // unreachable
	}
	// Windows: start/wait/exit parity. all[0] is the program name; the
	// remaining elements are the args passed to node.
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

// resolveNode resolves an absolute path to the node executable. See execNode
// for the resolution order and rationale.
func resolveNode() (string, error) {
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
	return "", errNoNode
}

// errNoNode is the named error returned when no node executable can be
// resolved for the Node host handoff.
var errNoNode = fmt.Errorf("no node executable found: install Node.js, set SWITCHBOARD_NODE, or add node to PATH")

// extractConnectionFlags pulls --server/--endpoint, --workspace-root/
// --server-root, and --token-file (and their = forms) out of the argument
// list, returning the connection options and the remaining args.
// --endpoint aliases --server and --server-root aliases --workspace-root.
func extractConnectionFlags(args []string) (client.Options, []string) {
	var opts client.Options
	remaining := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--server" || a == "--endpoint":
			if i+1 < len(args) {
				opts.ServerURL = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "--server="):
			opts.ServerURL = a[len("--server="):]
		case strings.HasPrefix(a, "--endpoint="):
			opts.ServerURL = a[len("--endpoint="):]
		case a == "--workspace-root" || a == "--server-root":
			if i+1 < len(args) {
				opts.WorkspaceRoot = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "--workspace-root="):
			opts.WorkspaceRoot = a[len("--workspace-root="):]
		case strings.HasPrefix(a, "--server-root="):
			opts.WorkspaceRoot = a[len("--server-root="):]
		case a == "--token-file":
			if i+1 < len(args) {
				opts.TokenFile = args[i+1]
				i++
			}
		case strings.HasPrefix(a, "--token-file="):
			opts.TokenFile = a[len("--token-file="):]
		default:
			remaining = append(remaining, a)
		}
	}
	return opts, remaining
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

func stripVerb(args []string, verb string) []string {
	out := make([]string, 0, len(args))
	removed := false
	for _, a := range args {
		if !removed && a == verb {
			removed = true
			continue
		}
		out = append(out, a)
	}
	return out
}

func envMap() map[string]string {
	m := make(map[string]string, len(os.Environ()))
	for _, kv := range os.Environ() {
		if idx := strings.IndexByte(kv, '='); idx >= 0 {
			m[kv[:idx]] = kv[idx+1:]
		}
	}
	return m
}
