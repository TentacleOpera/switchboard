// Package client implements the static Switchboard CLI client: argument
// parsing, tagged endpoint/server-root/credential resolution, HTTP transport,
// output formatting, and the owned board verbs. It contains no database
// access, no kanban schema, no prompt text, and no column-transition logic —
// every board decision stays on the server.
//
// The resolution model is source-tagged. Endpoint, server workspace root, and
// credential are resolved independently into {value, source} pairs. A missing
// or ambiguous behavioural value fails loudly; a quiet loopback/cwd fallback
// can produce a valid response from the wrong board, so the client never
// substitutes client-local paths for a server root without an explicit source.
package client

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Source labels where a resolved value came from. It is reported to stderr
// under diagnostics and never includes the secret itself.
type Source string

const (
	SourceExplicitFlag Source = "flag"
	SourceEnv          Source = "env"
	SourceLocalProbe   Source = "local-discovery"
	SourcePortFile     Source = "port-file"
	SourceTokenFile    Source = "token-file"
	SourceCwd          Source = "cwd"
	SourceNone         Source = "none"
	SourceHealthRoots  Source = "health-roots"
	// SourceConfig marks a value that came from remotes.json — a named remote
	// or the stored default. It is still explicit operator intent, just
	// persisted.
	SourceConfig Source = "config"
)

// Resolved holds a value plus the source it came from.
type Resolved[T any] struct {
	Value  T
	Source Source
}

// Endpoint is a resolved board endpoint: a base URL and the host:port used for
// local discovery diagnostics.
type Endpoint struct {
	BaseURL string
	Port    int
	Host    string
	// RemoteName and StoredRoot are set only when the endpoint resolved
	// through a named remote in remotes.json. StoredRoot carries the stored
	// remote's workspaceRoot into ResolveServerRoot's config tier; it is NOT
	// the remote's live advertised root.
	RemoteName string
	StoredRoot string
}

// Routes is the full set of resolved routing values for one invocation.
type Routes struct {
	Endpoint   Resolved[Endpoint]
	ServerRoot Resolved[string]
	Token      Resolved[string] // empty + SourceNone when unauthenticated
	LocalBoard bool             // true when the endpoint is a verified loopback board
}

// portBase/portSpan mirror src/utils/portResolver.ts. One constant each; widen
// here if it widens there.
const (
	portBase = 7777
	portSpan = 4
)

// Options carries the explicit flag/env values that feed resolution.
type Options struct {
	// Explicit --remote <name|url>. A URL is equivalent to --server; a bare
	// name resolves through remotes.json.
	Remote string
	// Explicit --server <http[s]://host:port>.
	ServerURL string
	// Explicit --workspace-root <server-path>.
	WorkspaceRoot string
	// Explicit --token-file <path>.
	TokenFile string
	// Client-local cwd (os.Getwd at main). Used as the loopback fallback root
	// and as the directory that holds .switchboard/ for local discovery.
	ClientCwd string
	// Env snapshot (so tests can inject). Resolution reads SWITCHBOARD_REMOTE,
	// SWITCHBOARD_SERVER_URL, SWITCHBOARD_WORKSPACE_ROOT,
	// SWITCHBOARD_API_TOKEN, and SWITCHBOARD_STATE_HOME from here.
	Env map[string]string
	// RemotesFile overrides the remotes.json path (tests). Empty resolves it
	// from SWITCHBOARD_STATE_HOME/os.UserHomeDir, mirroring stateFile() in
	// src/utils/stateHome.ts.
	RemotesFile string
}

// StoredRemote is one named remote as written to ~/.switchboard/remotes.json
// by `switchboard remote add` (plan: named-remotes-and-the-source-line-in-
// both-clients). The resolver reads it; the remote verb owns the file.
type StoredRemote struct {
	URL           string   `json:"url"`
	WorkspaceRoot string   `json:"workspaceRoot,omitempty"`
	Roots         []string `json:"roots,omitempty"`
	LastContact   string   `json:"lastContact,omitempty"`
}

// RemotesConfig is the remotes.json top-level shape. A stored defaultRemote
// IS a named remote: it routes bare commands, and is the only config tier
// that applies when no flag/env names an endpoint.
type RemotesConfig struct {
	DefaultRemote string                  `json:"defaultRemote,omitempty"`
	Remotes       map[string]StoredRemote `json:"remotes,omitempty"`
}

// remotesFilePath resolves the remotes.json location. SWITCHBOARD_STATE_HOME
// wins, then os.UserHomeDir + .switchboard — the same order stateFile() runs
// in the Node client.
func remotesFilePath(opts Options) string {
	if p := strings.TrimSpace(opts.RemotesFile); p != "" {
		return p
	}
	home := strings.TrimSpace(opts.Env["SWITCHBOARD_STATE_HOME"])
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = h
		}
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".switchboard", "remotes.json")
}

// loadRemotesConfig reads remotes.json. An absent file is an ABSENT TIER
// (nil, nil), never an error. A corrupt file is surfaced as corrupt —
// catching the parse error and returning an empty config would read a broken
// file as an unconfigured one, which is the exact fallback shape the rules
// forbid.
func loadRemotesConfig(path string) (*RemotesConfig, error) {
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var cfg RemotesConfig
	if err := json.Unmarshal(b, &cfg); err != nil {
		return nil, fmt.Errorf("remotes.json at %s is corrupt: %w", path, err)
	}
	return &cfg, nil
}

// resolveRemoteSpec resolves a name-or-URL remote spec. A URL parses directly
// (equivalent to --server). A bare name resolves through remotes.json — a
// named remote that fails to resolve is an ERROR, never a demotion to local.
func resolveRemoteSpec(opts Options, spec string) (Endpoint, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return Endpoint{}, errors.New("empty remote spec")
	}
	if strings.Contains(spec, "://") {
		return parseServerURL(spec)
	}
	path := remotesFilePath(opts)
	cfg, err := loadRemotesConfig(path)
	if err != nil {
		return Endpoint{}, err
	}
	if cfg == nil {
		return Endpoint{}, fmt.Errorf("remote %q is not configured — no remotes.json at %s", spec, path)
	}
	entry, ok := cfg.Remotes[spec]
	if !ok {
		return Endpoint{}, fmt.Errorf("remote %q is not configured in %s", spec, path)
	}
	if strings.TrimSpace(entry.URL) == "" {
		return Endpoint{}, fmt.Errorf("remote %q in %s has no url", spec, path)
	}
	ep, err := parseServerURL(entry.URL)
	if err != nil {
		return Endpoint{}, fmt.Errorf("remote %q in %s has an unusable url %q: %w", spec, path, entry.URL, err)
	}
	ep.RemoteName = spec
	ep.StoredRoot = strings.TrimSpace(entry.WorkspaceRoot)
	return ep, nil
}

// ResolveEndpoint resolves the board endpoint with source tagging.
//
// Precedence: --remote <name|url>; SWITCHBOARD_REMOTE; --server /
// SWITCHBOARD_SERVER_URL; remotes.json defaultRemote; then local discovery by
// health probe over the port span and the workspace port file. Passing both
// --remote and --server, or both env vars, with disagreeing values is a loud
// conflict — never a silent pick. When any explicit/env/config tier resolves,
// local discovery is skipped entirely.
func ResolveEndpoint(opts Options, disc *Discoverer) (Resolved[Endpoint], error) {
	remoteFlag := strings.TrimSpace(opts.Remote)
	serverFlag := strings.TrimSpace(opts.ServerURL)
	envRemote := strings.TrimSpace(opts.Env["SWITCHBOARD_REMOTE"])
	envServer := strings.TrimSpace(opts.Env["SWITCHBOARD_SERVER_URL"])

	// Loud conflicts: two explicit endpoint spellings that disagree. A URL
	// spelling of --remote is equivalent to --server, so equal base URLs are
	// agreement, not conflict. A pair is only checked when ITS tier is the
	// winning one — a higher-tier answer outranks a disagreeing lower pair.
	if remoteFlag != "" {
		ep, err := resolveRemoteSpec(opts, remoteFlag)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("--remote %q: %w", remoteFlag, err)
		}
		if serverFlag != "" {
			b, err := parseServerURL(serverFlag)
			if err != nil {
				return Resolved[Endpoint]{}, fmt.Errorf("--server %q: %w", serverFlag, err)
			}
			if ep.BaseURL != b.BaseURL {
				return Resolved[Endpoint]{}, fmt.Errorf("conflicting endpoints: --remote %q resolves to %s but --server names %s — pick one", remoteFlag, ep.BaseURL, b.BaseURL)
			}
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceExplicitFlag}, nil
	}
	if envRemote != "" {
		ep, err := resolveRemoteSpec(opts, envRemote)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("SWITCHBOARD_REMOTE %q: %w", envRemote, err)
		}
		if envServer != "" {
			b, err := parseServerURL(envServer)
			if err != nil {
				return Resolved[Endpoint]{}, fmt.Errorf("SWITCHBOARD_SERVER_URL %q: %w", envServer, err)
			}
			if ep.BaseURL != b.BaseURL {
				return Resolved[Endpoint]{}, fmt.Errorf("conflicting endpoints: SWITCHBOARD_REMOTE %q resolves to %s but SWITCHBOARD_SERVER_URL names %s — pick one", envRemote, ep.BaseURL, b.BaseURL)
			}
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceEnv}, nil
	}
	if serverFlag != "" {
		ep, err := parseServerURL(serverFlag)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("--server %q: %w", serverFlag, err)
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceExplicitFlag}, nil
	}
	if envServer != "" {
		ep, err := parseServerURL(envServer)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("SWITCHBOARD_SERVER_URL %q: %w", envServer, err)
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceEnv}, nil
	}
	// Configured default remote. Loaded lazily — a corrupt file surfaces only
	// when this tier is actually reached.
	if cfg, err := loadRemotesConfig(remotesFilePath(opts)); err != nil {
		return Resolved[Endpoint]{}, err
	} else if cfg != nil && strings.TrimSpace(cfg.DefaultRemote) != "" {
		ep, err := resolveRemoteSpec(opts, strings.TrimSpace(cfg.DefaultRemote))
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("default remote %q: %w", cfg.DefaultRemote, err)
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceConfig}, nil
	}
	// Local discovery: probe the port span, then the workspace port file.
	if disc != nil {
		if ep, ok := disc.ProbeSpan(); ok {
			return Resolved[Endpoint]{Value: ep, Source: SourceLocalProbe}, nil
		}
		if ep, ok := disc.PortFile(); ok {
			return Resolved[Endpoint]{Value: ep, Source: SourcePortFile}, nil
		}
	}
	return Resolved[Endpoint]{}, errNoEndpoint
}

// parseServerURL validates an explicit remote URL.
//
// Accepts only http/https, rejects embedded credentials, and normalises a
// trailing slash. IPv6 syntax (http://[::1]:7777) is accepted.
func parseServerURL(raw string) (Endpoint, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return Endpoint{}, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return Endpoint{}, fmt.Errorf("scheme must be http or https, got %q", u.Scheme)
	}
	if u.User != nil {
		return Endpoint{}, errors.New("embedded credentials are not allowed in the server URL")
	}
	host := u.Hostname()
	portStr := u.Port()
	if host == "" {
		return Endpoint{}, errors.New("missing host")
	}
	port := 0
	if portStr != "" {
		var p int
		if _, err := fmt.Sscanf(portStr, "%d", &p); err != nil || p <= 0 || p > 65535 {
			return Endpoint{}, fmt.Errorf("invalid port %q", portStr)
		}
		port = p
	}
	if port == 0 {
		// https with no port means 443 — the natural spelling of a
		// `tailscale serve` endpoint (`https://host.tail-xyz.ts.net`) carries
		// no port and dials TLS on 443. http stays strict: a board endpoint
		// without a port is a typo, not a port-80 board.
		if u.Scheme == "https" {
			port = 443
		} else {
			return Endpoint{}, errors.New("missing port — the board endpoint must include an explicit port")
		}
	}
	// Base URL is scheme://host[:port], no path, no trailing slash.
	base := u.Scheme + "://" + u.Host
	if !strings.Contains(u.Host, ":") && port != 0 {
		base = fmt.Sprintf("%s://%s:%d", u.Scheme, host, port)
	}
	return Endpoint{BaseURL: strings.TrimRight(base, "/"), Port: port, Host: host}, nil
}

// ResolveServerRoot resolves the server-side workspace root.
//
// Precedence: explicit --workspace-root; SWITCHBOARD_WORKSPACE_ROOT; the
// stored remote's root (named-remote endpoints only); then the local cwd ONLY
// for a verified local board whose /health.roots contains it; then
// single-root auto-pick tagged health-roots for remote endpoints; then
// refusal listing the advertised roots. A remote root is never guessed — and
// selectedWorkspaceRoot is never read as a fallback.
func ResolveServerRoot(opts Options, ep Resolved[Endpoint], health *HealthJSON) (Resolved[string], error) {
	if s := strings.TrimSpace(opts.WorkspaceRoot); s != "" {
		return Resolved[string]{Value: s, Source: SourceExplicitFlag}, nil
	}
	if s := strings.TrimSpace(opts.Env["SWITCHBOARD_WORKSPACE_ROOT"]); s != "" {
		return Resolved[string]{Value: s, Source: SourceEnv}, nil
	}
	// Stored remote root — only for endpoints that resolved through a named
	// remote. Stale check: a remote that advertises roots but not THIS one is
	// a changed board; refuse and re-list, never silently switch to a
	// surviving root. Absent roots (version skew) is absence, not a mismatch
	// — the stored value stands.
	if ep.Value.StoredRoot != "" {
		if health != nil && len(health.Roots) > 0 && !rootContains(health.Roots, ep.Value.StoredRoot) {
			return Resolved[string]{}, &StaleRootError{Remote: ep.Value.RemoteName, Root: ep.Value.StoredRoot, Roots: health.Roots}
		}
		return Resolved[string]{Value: ep.Value.StoredRoot, Source: SourceConfig}, nil
	}
	// Local-board cwd fallback: only when the endpoint is loopback and /health
	// advertises the cwd among its roots.
	if ep.Source == SourceLocalProbe || ep.Source == SourcePortFile {
		cwd := strings.TrimSpace(opts.ClientCwd)
		if cwd != "" {
			abs, _ := filepath.Abs(cwd)
			if health != nil && rootContains(health.Roots, abs) {
				return Resolved[string]{Value: abs, Source: SourceCwd}, nil
			}
		}
		// Local endpoints keep today's path: cwd not advertised → refuse.
	} else if health != nil && len(health.Roots) == 1 {
		// Remote endpoint, exactly one advertised root: use it, tagged. More
		// than one is a refusal, not a pick.
		return Resolved[string]{Value: health.Roots[0], Source: SourceHealthRoots}, nil
	}
	// Remote without an explicit root: fail loudly. If we have health roots,
	// surface them so the operator can pick one.
	if health != nil && len(health.Roots) > 0 {
		return Resolved[string]{}, &MissingRootError{Roots: health.Roots}
	}
	return Resolved[string]{}, errNoServerRoot
}

// MissingRootError is returned by ResolveServerRoot when a remote endpoint has
// no explicit server root. It carries the server's advertised roots so the
// front controller can surface them.
type MissingRootError struct{ Roots []string }

func (e *MissingRootError) Error() string {
	return "no server workspace root supplied"
}

// StaleRootError is returned by ResolveServerRoot when a named remote's stored
// root is absent from the remote's CURRENT /health.roots — the board's roots
// changed since `remote add`. It carries the advertised roots so the front
// controller can re-list them.
type StaleRootError struct {
	Remote string
	Root   string
	Roots  []string
}

func (e *StaleRootError) Error() string {
	return fmt.Sprintf("stored root %q for remote %q is not advertised by the board (stale)", e.Root, e.Remote)
}

// ResolveToken resolves the auth credential.
//
// Precedence: SWITCHBOARD_API_TOKEN; explicit --token-file <path>; local
// workspace .switchboard/api-server-token.txt; then tagged none. A token value
// is never accepted in argv. An explicitly passed --token-file that cannot be
// read (or is empty) is an ERROR, never a demotion — the operator asked for a
// specific credential source, and silently falling through to none would
// produce a request tagged the same as a correct resolution while asserting
// the opposite of what happened.
func ResolveToken(opts Options) (Resolved[string], error) {
	if t := strings.TrimSpace(opts.Env["SWITCHBOARD_API_TOKEN"]); t != "" {
		return Resolved[string]{Value: t, Source: SourceEnv}, nil
	}
	if tf := strings.TrimSpace(opts.TokenFile); tf != "" {
		b, err := os.ReadFile(tf)
		if err != nil {
			return Resolved[string]{}, fmt.Errorf("--token-file %q: cannot read token — %w", tf, err)
		}
		v := strings.TrimSpace(string(b))
		if v == "" {
			return Resolved[string]{}, fmt.Errorf("--token-file %q: file is empty — no token to send", tf)
		}
		return Resolved[string]{Value: v, Source: SourceExplicitFlag}, nil
	}
	// Local workspace token file: <cwd>/.switchboard/api-server-token.txt.
	if cwd := strings.TrimSpace(opts.ClientCwd); cwd != "" {
		tf := filepath.Join(cwd, ".switchboard", "api-server-token.txt")
		if b, err := os.ReadFile(tf); err == nil {
			if v := strings.TrimSpace(string(b)); v != "" {
				return Resolved[string]{Value: v, Source: SourceTokenFile}, nil
			}
		}
	}
	return Resolved[string]{Value: "", Source: SourceNone}, nil
}

func rootContains(roots []string, target string) bool {
	absTarget, _ := filepath.Abs(target)
	for _, r := range roots {
		abs, _ := filepath.Abs(r)
		if abs == absTarget {
			return true
		}
	}
	return false
}

var (
	errNoEndpoint   = errors.New("no running Switchboard instance found for this workspace")
	errNoServerRoot = errors.New("no server workspace root supplied and none advertised")
)
