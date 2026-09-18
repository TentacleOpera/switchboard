package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// ─── Resolved-target surfacing (plan: named-remotes-and-the-source-line-in-both-clients) ───

// TargetInfo is the {baseUrl, workspaceRoot, source} triple injected into
// every emitJSON envelope for a remote invocation — the --json counterpart of
// the stderr source line. Mirrors the `target` key cli.ts emitJson appends.
type TargetInfo struct {
	BaseURL       string `json:"baseUrl"`
	WorkspaceRoot string `json:"workspaceRoot"`
	Source        string `json:"source"`
}

// activeJSONTarget mirrors cli.ts activeBoardTarget — set once per process
// when the resolved endpoint is remote; emitJSON appends it to every object
// payload for that invocation.
var activeJSONTarget *TargetInfo

// SetActiveTarget records the invocation's resolved remote target (nil =
// local/none — emitJSON then emits the payload untouched).
func SetActiveTarget(t *TargetInfo) { activeJSONTarget = t }

// DescribeTargetVia renders the source tag for the resolved endpoint exactly
// as cli.ts does — 'flag:--remote labcom', 'env:SWITCHBOARD_REMOTE',
// 'flag:--server', 'env:SWITCHBOARD_SERVER_URL', 'config:remotes.labcom', or a
// local source. The via string must be byte-identical between clients: the
// source line is the tagging half of the fallback rule.
func DescribeTargetVia(opts Options, ep Resolved[Endpoint]) string {
	if s := strings.TrimSpace(opts.Remote); s != "" {
		return "flag:--remote " + s
	}
	if strings.TrimSpace(opts.Env["SWITCHBOARD_REMOTE"]) != "" {
		return "env:SWITCHBOARD_REMOTE"
	}
	if strings.TrimSpace(opts.ServerURL) != "" {
		return "flag:--server"
	}
	if strings.TrimSpace(opts.Env["SWITCHBOARD_SERVER_URL"]) != "" {
		return "env:SWITCHBOARD_SERVER_URL"
	}
	if ep.Source == SourceConfig && ep.Value.RemoteName != "" {
		return "config:remotes." + ep.Value.RemoteName
	}
	return string(ep.Source)
}

// TargetSourceLine renders the stderr line emitted before a remote command's
// output:
//
//	[switchboard] labcom · https://labcom.ts.net · /home/patrick/labcom · via config:remotes.labcom
//
// Unnamed remotes omit the name segment — identical to cli.ts
// recordActiveTarget. A sticky configured defaultRemote retargets every bare
// command; this line is what makes that stickiness visible instead of silent.
func TargetSourceLine(opts Options, ep Resolved[Endpoint], root string) string {
	name := ""
	if ep.Value.RemoteName != "" {
		name = ep.Value.RemoteName + " · "
	}
	return fmt.Sprintf("[switchboard] %s%s · %s · via %s", name, ep.Value.BaseURL, root, DescribeTargetVia(opts, ep))
}

// ─── remotes.json write side (mirrors apiTarget.ts saveRemotesConfig) ──────

// writeRemotesConfig writes remotes.json at 0600. WriteFile's perm argument
// is umask-masked, so the mode is pinned with Chmod after the write — the
// same write-then-chmod pattern as the Node client's saveRemotesConfig.
// The file is JSON with 2-space indent and no HTML escaping, matching Node's
// JSON.stringify(cfg, null, 2).
func writeRemotesConfig(path string, cfg *RemotesConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(cfg); err != nil {
		return err
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// ─── remote: named boards (mirrors cmdRemote in src/standalone/cli.ts) ─────
//
// `switchboard remote add|list|remove|default` touches ONLY the local config
// file — it never resolves a board target, so it is handled before the
// owned-verb dispatch and takes no endpoint resolution. Only `add` dials,
// and it resolves its own URL argument. Every output string here is
// byte-identical to the Node client's — keep them in sync.

// RunRemote implements the `remote` subcommand family, returning the process
// exit code. Handled before the owned-verb dispatch in main.
func RunRemote(args []string, opts Options) int {
	path := remotesFilePath(opts)
	if path == "" {
		emitErr("[switchboard] cannot locate remotes.json — no SWITCHBOARD_STATE_HOME and no home directory.")
		return 1
	}
	if len(args) == 0 {
		return remoteUsageFail()
	}
	switch args[0] {
	case "add":
		return remoteAdd(path, args[1:], opts)
	case "list":
		return remoteList(path)
	case "remove", "rm":
		return remoteRemove(path, args[1:])
	case "default":
		return remoteDefault(path, args[1:])
	default:
		return remoteUsageFail()
	}
}

func remoteUsageFail() int {
	emitErr("[switchboard] 'remote' needs a subcommand: add | list | remove | default")
	emitErr("  switchboard remote add <name> <url> [--workspace-root <path>] [--force]")
	emitErr("  switchboard remote list")
	emitErr("  switchboard remote remove <name>")
	emitErr("  switchboard remote default <name> | --clear")
	return 1
}

// remoteAddToken resolves the credential for `remote add`'s probe read: env,
// then --token-file (loud failure), then none. The workspace token file is
// deliberately NOT read — it is the LOCAL board's credential and would leak
// to the remote being added. Mirrors remoteAddAuth in cli.ts.
func remoteAddToken(opts Options) (string, error) {
	if t := strings.TrimSpace(opts.Env["SWITCHBOARD_API_TOKEN"]); t != "" {
		return t, nil
	}
	if tf := strings.TrimSpace(opts.TokenFile); tf != "" {
		b, err := os.ReadFile(tf)
		if err != nil {
			return "", fmt.Errorf("--token-file '%s': cannot read token — %v", tf, err)
		}
		v := strings.TrimSpace(string(b))
		if v == "" {
			return "", fmt.Errorf("--token-file '%s': file is empty — no token to send", tf)
		}
		return v, nil
	}
	return "", nil
}

// describeUnreachableForAdd mirrors Node's unreachableMessage for the add
// path — same single-quoted remote name, same DNS-vs-refused distinction.
// DescribeUnreachable's %q quoting differs, so this renders the Node form.
func describeUnreachableForAdd(name, baseURL string, err error) string {
	target := fmt.Sprintf("remote '%s' (%s, via remote add)", name, baseURL)
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return target + " does not resolve — the machine may have been renamed or is off the tailnet"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return target + " refused the connection — the host is reachable but the board is not listening"
	}
	return fmt.Sprintf("%s is unreachable: %v", target, err)
}

func remoteAdd(path string, args []string, opts Options) int {
	if len(args) < 2 {
		return remoteUsageFail()
	}
	name, rawURL := args[0], args[1]
	force := false
	for _, a := range args {
		if a == "--force" {
			force = true
		}
	}
	if name == "" || strings.Contains(name, "://") || strings.HasPrefix(name, "-") || strings.IndexAny(name, " \t\n") >= 0 {
		emitErr("[switchboard] '%s' is not a usable remote name — use a short name (letters, digits, '-', '_', '.'), not a URL.", name)
		return 1
	}
	ep, err := parseServerURL(rawURL)
	if err != nil {
		emitErr("[switchboard] remote '%s' not added — '%s' is not a usable board URL: %v", name, rawURL, err)
		return 1
	}
	cfg, err := loadRemotesConfig(path)
	if err != nil {
		emitErr("[switchboard] %v", err)
		return 1
	}
	if cfg == nil {
		cfg = &RemotesConfig{}
	}
	if existing, ok := cfg.Remotes[name]; ok && !force {
		emitErr("[switchboard] remote '%s' is already configured (%s) — pass --force to overwrite, or pick another name.", name, existing.URL)
		return 1
	}

	// Probe /health — proves the URL names a switchboard board, nothing more.
	probe := NewTransportFromEndpoint(ep)
	health, herr := probe.GetHealth(4000)
	if herr != nil {
		emitErr("[switchboard] remote '%s' not added — %s. Check the URL and that the remote board is running, then retry.", name, describeUnreachableForAdd(name, ep.BaseURL, herr))
		return 1
	}

	// Pick the root BEFORE the read — the read itself is routed by it. An
	// explicit --workspace-root wins; a single advertised root is
	// unambiguous; more than one is a refusal that lists them, not a pick.
	roots := health.Roots
	root := strings.TrimSpace(opts.WorkspaceRoot)
	if root == "" {
		switch {
		case len(roots) == 1:
			root = roots[0]
		case len(roots) > 1:
			emitErr("[switchboard] remote '%s' not added — %s advertises %d workspace roots and none was chosen:", name, ep.BaseURL, len(roots))
			for _, r := range roots {
				emitErr("  %s", r)
			}
			emitErr("[switchboard] Re-run with --workspace-root <path> to name one.")
			return 1
		default:
			emitErr("[switchboard] remote '%s' not added — %s advertises no workspace roots. Re-run with --workspace-root <path> to name the board's root.", name, ep.BaseURL)
			return 1
		}
	}

	// One real read: /health proves reachability, NOT usability — a board
	// with a durable token answers /health and then 401s the first real
	// read. Storing that target hands the operator a remote that fails on
	// every subsequent command with no explanation, so the read must pass.
	tok, err := remoteAddToken(opts)
	if err != nil {
		emitErr("[switchboard] %v", err)
		return 1
	}
	t := &Transport{
		BaseURL:    ep.BaseURL,
		ServerRoot: root,
		Token:      tok,
		HTTP:       &http.Client{Timeout: time.Duration(defaultTimeoutMs) * time.Millisecond},
	}
	res, rerr := t.apiGet("/kanban/plans", nil)
	if rerr != nil {
		emitErr("[switchboard] remote '%s' not added — %s. Check the URL and that the remote board is running, then retry.", name, describeUnreachableForAdd(name, ep.BaseURL, rerr))
		return 1
	}
	if res.Status == 401 {
		emitErr("[switchboard] remote '%s' not added — %s answered /health but rejected a real read with 401: the remote board has an API token configured.", name, ep.BaseURL)
		emitErr("[switchboard] Re-run with SWITCHBOARD_API_TOKEN=<token> or --token-file <path>, or run 'switchboard token clear' on the remote host to remove the token.")
		return 1
	}
	if res.Status < 200 || res.Status >= 300 {
		emitErr("[switchboard] remote '%s' not added — %s answered /health but a real read returned %d — the endpoint is not a usable board. Check the URL, then retry.", name, ep.BaseURL, res.Status)
		return 1
	}

	if cfg.Remotes == nil {
		cfg.Remotes = map[string]StoredRemote{}
	}
	cfg.Remotes[name] = StoredRemote{
		URL:           ep.BaseURL,
		WorkspaceRoot: root,
		Roots:         roots,
		LastContact:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := writeRemotesConfig(path, cfg); err != nil {
		emitErr("[switchboard] remote '%s' not added — cannot write %s: %v", name, path, err)
		return 1
	}
	emitHuman("[switchboard] remote '%s' added: %s · %s", name, ep.BaseURL, root)
	rootsList := "(none)"
	if len(roots) > 0 {
		rootsList = strings.Join(roots, ", ")
	}
	emitHuman("[switchboard]   advertised roots: %s", rootsList)
	emitHuman("[switchboard] Stored in %s — target it with 'switchboard --remote %s <command>', or make it the default with 'switchboard remote default %s'.", path, name, name)
	return 0
}

func remoteList(path string) int {
	cfg, err := loadRemotesConfig(path)
	if err != nil {
		emitErr("[switchboard] %v", err)
		return 1
	}
	names := make([]string, 0)
	if cfg != nil {
		for n := range cfg.Remotes {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	if len(names) == 0 {
		emitHuman("[switchboard] No remotes configured — add one with 'switchboard remote add <name> <url>'.")
		return 0
	}
	for _, name := range names {
		r := cfg.Remotes[name]
		root := r.WorkspaceRoot
		if root == "" {
			root = "(no root stored)"
		}
		contact := r.LastContact
		if contact == "" {
			contact = "never"
		}
		def := ""
		if cfg.DefaultRemote == name {
			def = " (default)"
		}
		emitHuman("[switchboard] %s · %s · %s · last contact %s%s", name, r.URL, root, contact, def)
	}
	return 0
}

func remoteRemove(path string, args []string) int {
	if len(args) == 0 || args[0] == "" {
		return remoteUsageFail()
	}
	name := args[0]
	cfg, err := loadRemotesConfig(path)
	if err != nil {
		emitErr("[switchboard] %v", err)
		return 1
	}
	if cfg == nil {
		cfg = &RemotesConfig{}
	}
	if _, ok := cfg.Remotes[name]; !ok {
		names := make([]string, 0, len(cfg.Remotes))
		for n := range cfg.Remotes {
			names = append(names, n)
		}
		sort.Strings(names)
		list := "none"
		if len(names) > 0 {
			list = strings.Join(names, ", ")
		}
		emitErr("[switchboard] remote '%s' is not configured — configured remotes: %s.", name, list)
		return 1
	}
	delete(cfg.Remotes, name)
	wasDefault := cfg.DefaultRemote == name
	if wasDefault {
		cfg.DefaultRemote = ""
	}
	if err := writeRemotesConfig(path, cfg); err != nil {
		emitErr("[switchboard] remote '%s' not removed — cannot write %s: %v", name, path, err)
		return 1
	}
	if wasDefault {
		emitHuman("[switchboard] remote '%s' removed — it was the configured default remote; the default is cleared.", name)
	} else {
		emitHuman("[switchboard] remote '%s' removed.", name)
	}
	return 0
}

func remoteDefault(path string, args []string) int {
	cfg, err := loadRemotesConfig(path)
	if err != nil {
		emitErr("[switchboard] %v", err)
		return 1
	}
	if cfg == nil {
		cfg = &RemotesConfig{}
	}
	arg := ""
	if len(args) > 0 {
		arg = args[0]
	}
	if arg == "--clear" {
		if cfg.DefaultRemote == "" {
			emitHuman("[switchboard] no default remote is configured.")
			return 0
		}
		cfg.DefaultRemote = ""
		if err := writeRemotesConfig(path, cfg); err != nil {
			emitErr("[switchboard] default remote not cleared — cannot write %s: %v", path, err)
			return 1
		}
		emitHuman("[switchboard] default remote cleared — bare commands resolve this machine's board again.")
		return 0
	}
	if arg == "" {
		return remoteUsageFail()
	}
	entry, ok := cfg.Remotes[arg]
	if !ok {
		emitErr("[switchboard] remote '%s' is not configured — add it with 'switchboard remote add %s <url>'.", arg, arg)
		return 1
	}
	cfg.DefaultRemote = arg
	if err := writeRemotesConfig(path, cfg); err != nil {
		emitErr("[switchboard] default remote not set — cannot write %s: %v", path, err)
		return 1
	}
	emitHuman("[switchboard] default remote set to '%s' — bare commands now target %s (via config:remotes.%s).", arg, entry.URL, arg)
	return 0
}
