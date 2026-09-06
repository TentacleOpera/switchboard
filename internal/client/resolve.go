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
	SourceExplicitFlag  Source = "flag"
	SourceEnv           Source = "env"
	SourceLocalProbe    Source = "local-discovery"
	SourcePortFile      Source = "port-file"
	SourceTokenFile     Source = "token-file"
	SourceCwd           Source = "cwd"
	SourceNone          Source = "none"
	SourceHealthRoots   Source = "health-roots"
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
}

// Routes is the full set of resolved routing values for one invocation.
type Routes struct {
	Endpoint     Resolved[Endpoint]
	ServerRoot   Resolved[string]
	Token        Resolved[string] // empty + SourceNone when unauthenticated
	LocalBoard   bool             // true when the endpoint is a verified loopback board
}

// portBase/portSpan mirror src/utils/portResolver.ts. One constant each; widen
// here if it widens there.
const (
	portBase = 7777
	portSpan = 4
)

// Options carries the explicit flag/env values that feed resolution.
type Options struct {
	// Explicit --server <http[s]://host:port>.
	ServerURL string
	// Explicit --workspace-root <server-path>.
	WorkspaceRoot string
	// Explicit --token-file <path>.
	TokenFile string
	// Client-local cwd (os.Getwd at main). Used as the loopback fallback root
	// and as the directory that holds .switchboard/ for local discovery.
	ClientCwd string
	// Env snapshot (so tests can inject). Resolution reads SWITCHBOARD_SERVER_URL,
	// SWITCHBOARD_WORKSPACE_ROOT, and SWITCHBOARD_API_TOKEN from here.
	Env map[string]string
}

// ResolveEndpoint resolves the board endpoint with source tagging.
//
// Precedence: explicit --server; SWITCHBOARD_SERVER_URL; local discovery by
// health probe over the port span, then the workspace port file.
func ResolveEndpoint(opts Options, disc *Discoverer) (Resolved[Endpoint], error) {
	if s := strings.TrimSpace(opts.ServerURL); s != "" {
		ep, err := parseServerURL(s)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("--server %q: %w", s, err)
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceExplicitFlag}, nil
	}
	if s := strings.TrimSpace(opts.Env["SWITCHBOARD_SERVER_URL"]); s != "" {
		ep, err := parseServerURL(s)
		if err != nil {
			return Resolved[Endpoint]{}, fmt.Errorf("SWITCHBOARD_SERVER_URL %q: %w", s, err)
		}
		return Resolved[Endpoint]{Value: ep, Source: SourceEnv}, nil
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
		return Endpoint{}, errors.New("missing port — the board endpoint must include an explicit port")
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
// Precedence: explicit --workspace-root; SWITCHBOARD_WORKSPACE_ROOT; then the
// local cwd ONLY for a verified local board whose /health.roots contains it.
// A remote endpoint without an explicit server root fails loudly and prints
// the server's advertised roots when available.
func ResolveServerRoot(opts Options, ep Resolved[Endpoint], health *HealthJSON) (Resolved[string], error) {
	if s := strings.TrimSpace(opts.WorkspaceRoot); s != "" {
		return Resolved[string]{Value: s, Source: SourceExplicitFlag}, nil
	}
	if s := strings.TrimSpace(opts.Env["SWITCHBOARD_WORKSPACE_ROOT"]); s != "" {
		return Resolved[string]{Value: s, Source: SourceEnv}, nil
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

// ResolveToken resolves the auth credential.
//
// Precedence: SWITCHBOARD_API_TOKEN; explicit --token-file <path>; local
// workspace .switchboard/api-server-token.txt; then tagged none. A token value
// is never accepted in argv.
func ResolveToken(opts Options) Resolved[string] {
	if t := strings.TrimSpace(opts.Env["SWITCHBOARD_API_TOKEN"]); t != "" {
		return Resolved[string]{Value: t, Source: SourceEnv}
	}
	if tf := strings.TrimSpace(opts.TokenFile); tf != "" {
		if b, err := os.ReadFile(tf); err == nil {
			if v := strings.TrimSpace(string(b)); v != "" {
				return Resolved[string]{Value: v, Source: SourceExplicitFlag}
			}
		}
	}
	// Local workspace token file: <cwd>/.switchboard/api-server-token.txt.
	if cwd := strings.TrimSpace(opts.ClientCwd); cwd != "" {
		tf := filepath.Join(cwd, ".switchboard", "api-server-token.txt")
		if b, err := os.ReadFile(tf); err == nil {
			if v := strings.TrimSpace(string(b)); v != "" {
				return Resolved[string]{Value: v, Source: SourceTokenFile}
			}
		}
	}
	return Resolved[string]{Value: "", Source: SourceNone}
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
