package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// deliveryBlockingTimeoutMs mirrors cli.ts DELIVERY_BLOCKING_TIMEOUT_MS. The
// board callbacks for done/next/dispatch block on prompt delivery and may
// legitimately hold ~35s; never auto-retry a timed-out side-effecting request.
const deliveryBlockingTimeoutMs = 120000

// defaultTimeoutMs is the standard request ceiling for non-blocking reads.
const defaultTimeoutMs = 15000

// HealthJSON is the subset of /health the client reads. The server may carry
// more fields; they are preserved when re-emitted.
type HealthJSON struct {
	Service               string          `json:"service"`
	Status                string          `json:"status"`
	Port                  int             `json:"port"`
	PID                   int             `json:"pid"`
	Roots                 []string        `json:"roots"`
	Terminals             []string        `json:"terminals"`
	TerminalCount         int             `json:"terminalCount"`
	SelectedWorkspaceRoot *string         `json:"selectedWorkspaceRoot"`
	Memory                json.RawMessage `json:"memory,omitempty"`
	// Raw preserves the full server payload so `status` can re-emit fields the
	// struct does not name (e.g. extension-added capabilities).
	Raw map[string]json.RawMessage `json:"-"`
}

// APIResponse mirrors cli.ts ApiResponse.
type APIResponse struct {
	Status int
	Body   string
	parsed any // cached json parse; nil = not yet parsed
}

// JSON parses the body as JSON once and caches the result. Returns nil on
// parse failure (matching cli.ts `json: () => null`).
func (r *APIResponse) JSON() any {
	if r == nil {
		return nil
	}
	if r.parsed != nil || r.Body == "" {
		return r.parsed
	}
	var v any
	if err := json.Unmarshal([]byte(r.Body), &v); err != nil {
		r.parsed = nil // explicit: parse failure → nil
		return nil
	}
	r.parsed = v
	return v
}

// Transport is the shared HTTP client. It carries the resolved routes so every
// request attaches the server workspace root and credential the same way
// cli.ts apiRequest does.
type Transport struct {
	BaseURL    string
	ServerRoot string
	Token      string
	HTTP       *http.Client
	// Diagnostics writer (stderr). nil = silent.
	Diag func(format string, args ...any)
}

func newTransport(r Routes) *Transport {
	return &Transport{
		BaseURL:    r.Endpoint.Value.BaseURL,
		ServerRoot: r.ServerRoot.Value,
		Token:      r.Token.Value,
		HTTP:       &http.Client{Timeout: time.Duration(defaultTimeoutMs) * time.Millisecond},
		// Diagnostics go to stderr — stdout stays the command payload.
		// Declared since the transport landed; first assigned for the
		// remote-source line (named-remotes plan).
		Diag: func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) },
	}
}

func defaultTimeoutTimeoutMs() int { return defaultTimeoutMs }

// apiRequest mirrors cli.ts apiRequest: workspaceRoot is a query param for
// read-like methods (GET, DELETE) and a body field for write-like methods
// (POST, PUT, PATCH). Auth header attached when a token is present.
func (t *Transport) apiRequest(method, pathname string, payload any, query map[string]string, timeoutMs int) (*APIResponse, error) {
	if timeoutMs <= 0 {
		timeoutMs = defaultTimeoutMs
	}
	upper := strings.ToUpper(method)
	isReadLike := upper == "GET" || upper == "DELETE"

	fullURL := t.BaseURL + pathname
	values := url.Values{}
	if isReadLike {
		for k, v := range query {
			values.Set(k, v)
		}
		// workspaceRoot is NOT optional on the read path.
		values.Set("workspaceRoot", t.ServerRoot)
		if enc := values.Encode(); enc != "" {
			fullURL += "?" + enc
		}
	} else if len(query) > 0 {
		for k, v := range query {
			values.Set(k, v)
		}
		if enc := values.Encode(); enc != "" {
			fullURL += "?" + enc
		}
	}

	var bodyBytes []byte
	var bodyStr string
	if !isReadLike && payload != nil {
		// Inject workspaceRoot into the object body, matching cli.ts.
		if m, ok := payload.(map[string]any); ok {
			if _, exists := m["workspaceRoot"]; !exists {
				merged := make(map[string]any, len(m)+1)
				merged["workspaceRoot"] = t.ServerRoot
				for k, v := range m {
					merged[k] = v
				}
				payload = merged
			}
		}
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		bodyBytes = b
		bodyStr = string(b)
	}

	req, err := http.NewRequest(upper, fullURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	if bodyStr != "" || upper == "POST" || upper == "PUT" || upper == "PATCH" {
		req.Header.Set("Content-Type", "application/json")
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	// Positive client marker for the CSRF guard (plan:
	// browser-board-csrf-cross-site-rejection). The guard rejects a request
	// with no Origin, no Sec-Fetch-Site, and no marker — a local CLI caller
	// sends none of the browser signals, so it MUST send the marker or it
	// 403s. A browser cannot set a custom header on a cross-site request
	// without a CORS preflight, and the preflight mirrors
	// Access-Control-Allow-Origin only for an origin the bind policy already
	// allows — so a hostile page cannot forge it.
	req.Header.Set("X-Switchboard-Client", "switchboard-cli")

	client := t.HTTP
	if timeoutMs != defaultTimeoutMs {
		client = &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return &APIResponse{Status: resp.StatusCode, Body: string(b)}, nil
}

// apiGet is a read-only convenience.
func (t *Transport) apiGet(pathname string, query map[string]string) (*APIResponse, error) {
	return t.apiRequest("GET", pathname, nil, query, defaultTimeoutMs)
}

// ApiGet is the exported form of apiGet for callers outside the client package
// (the launcher controller). Same semantics: read-only, default timeout,
// workspaceRoot attached as a query param.
func (t *Transport) ApiGet(pathname string, query map[string]string) (*APIResponse, error) {
	return t.apiGet(pathname, query)
}

// apiPost is a write convenience with the delivery-blocking timeout default.
func (t *Transport) apiPost(pathname string, payload map[string]any, timeoutMs int) (*APIResponse, error) {
	if timeoutMs <= 0 {
		timeoutMs = deliveryBlockingTimeoutMs
	}
	return t.apiRequest("POST", pathname, payload, nil, timeoutMs)
}

// ApiPost is the exported form of apiPost for callers outside the client
// package (the launcher controller). Same semantics: write, workspaceRoot
// injected into the body, custom timeout.
func (t *Transport) ApiPost(pathname string, payload map[string]any, timeoutMs int) (*APIResponse, error) {
	return t.apiPost(pathname, payload, timeoutMs)
}

// DescribeUnreachable names an unreachable remote precisely for an operator
// message. A DNS failure is the rename case ("the machine may have been
// renamed"), ECONNREFUSED is a reachable host with a stopped board — the
// difference between "check the name" and "start the board". Mirrors
// unreachableMessage in src/standalone/apiTarget.ts.
func DescribeUnreachable(ep Endpoint, source Source, err error) string {
	// Name the resolved URL AND the tier that produced it — "the URL and the
	// env var" is what the operator edits.
	target := fmt.Sprintf("remote %s (via %s)", ep.BaseURL, source)
	if ep.RemoteName != "" {
		target = fmt.Sprintf("remote %q (%s, via %s)", ep.RemoteName, ep.BaseURL, source)
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return fmt.Sprintf("%s does not resolve — the machine may have been renamed or is off the tailnet", target)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return fmt.Sprintf("%s refused the connection — the host is reachable but the board is not listening", target)
	}
	return fmt.Sprintf("%s is unreachable: %v", target, err)
}

// GetHealth fetches and validates /health. Returns an error if the endpoint is
// unreachable or does not identify as a switchboard service — callers must
// never signal a PID based on a port that a non-switchboard process happens to
// be listening on.
func (t *Transport) GetHealth(timeoutMs int) (*HealthJSON, error) {
	if timeoutMs <= 0 {
		timeoutMs = 2000
	}
	client := &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}
	req, err := http.NewRequest("GET", t.BaseURL+"/health", nil)
	if err != nil {
		return nil, err
	}
	if t.Token != "" {
		req.Header.Set("Authorization", "Bearer "+t.Token)
	}
	// Positive client marker for the CSRF guard (plan:
	// browser-board-csrf-cross-site-rejection). The guard rejects a request
	// with no Origin, no Sec-Fetch-Site, and no marker — a local CLI caller
	// sends none of the browser signals, so it MUST send the marker or it
	// 403s. A browser cannot set a custom header on a cross-site request
	// without a CORS preflight, and the preflight mirrors
	// Access-Control-Allow-Origin only for an origin the bind policy already
	// allows — so a hostile page cannot forge it.
	req.Header.Set("X-Switchboard-Client", "switchboard-cli")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var h HealthJSON
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, err
	}
	// Preserve the full raw payload for re-emission.
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(b, &raw)
	h.Raw = raw
	if h.Service != "switchboard" || h.Status != "ok" {
		return nil, fmt.Errorf("health endpoint did not identify as switchboard")
	}
	return &h, nil
}

// Discoverer probes loopback for a local board. It mirrors cli.ts
// findRunningInstance: probe the port span, then read the workspace port file.
type Discoverer struct {
	cwd string
}

// NewDiscoverer returns a loopback discoverer rooted at cwd.
func NewDiscoverer(cwd string) *Discoverer { return &Discoverer{cwd: cwd} }

// NewTransportFromEndpoint builds a minimal transport for a one-off health
// probe (used by the front controller during endpoint/server-root resolution).
func NewTransportFromEndpoint(ep Endpoint) *Transport {
	return &Transport{BaseURL: ep.BaseURL, HTTP: &http.Client{Timeout: 2 * time.Second}}
}

// ProbeSpan probes 127.0.0.1:portBase..portBase+portSpan-1 with a short
// timeout, returning the first port whose /health advertises a root matching
// the client cwd. A board whose roots do not contain the cwd is skipped, so a
// second board on a nearby port is never selected for the wrong workspace.
func (d *Discoverer) ProbeSpan() (Endpoint, bool) {
	for i := 0; i < portSpan; i++ {
		port := portBase + i
		ep := Endpoint{BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port), Port: port, Host: "127.0.0.1"}
		t := &Transport{BaseURL: ep.BaseURL, HTTP: &http.Client{Timeout: 500 * time.Millisecond}}
		h, err := t.GetHealth(500)
		if err != nil {
			continue
		}
		if d.cwd != "" && rootContains(h.Roots, d.cwd) {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// PortFile reads <cwd>/.switchboard/api-server-port.txt and probes it.
func (d *Discoverer) PortFile() (Endpoint, bool) {
	if d.cwd == "" {
		return Endpoint{}, false
	}
	b, err := os.ReadFile(filepath.Join(d.cwd, ".switchboard", "api-server-port.txt"))
	if err != nil {
		return Endpoint{}, false
	}
	port, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || port <= 0 {
		return Endpoint{}, false
	}
	ep := Endpoint{BaseURL: fmt.Sprintf("http://127.0.0.1:%d", port), Port: port, Host: "127.0.0.1"}
	t := &Transport{BaseURL: ep.BaseURL, HTTP: &http.Client{Timeout: 2000 * time.Millisecond}}
	if _, err := t.GetHealth(2000); err != nil {
		return Endpoint{}, false
	}
	return ep, true
}
