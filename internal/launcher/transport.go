package launcher

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/TentacleOpera/switchboard/internal/client"
)

// HealthSnapshot is the subset of /health the launcher reads. The server may
// carry more fields; only the identity/capability fields are load-bearing for
// the launcher's Stop gate.
type HealthSnapshot struct {
	Service  string `json:"service"`
	Status   string `json:"status"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Roots    []string `json:"roots"`
	SelectedWorkspaceRoot *string `json:"selectedWorkspaceRoot"`
	Host     *HostIdentity  `json:"host,omitempty"`
	Capabilities *Capabilities `json:"capabilities,omitempty"`
}

// LauncherStateProjection mirrors the host-owned LauncherStateProjection shape
// from src/services/LocalApiServer.ts. The launcher consumes this and never
// reads kanban.db.
type LauncherStateProjection struct {
	Host       HostIdentity  `json:"host"`
	Capabilities Capabilities `json:"capabilities"`
	Roots      TaggedStringList `json:"roots"`
	SelectedWorkspaceRoot TaggedString `json:"selectedWorkspaceRoot"`
	WorkspaceMappings WorkspaceProjection `json:"workspaceMappings"`
	ServeMode  *TaggedString `json:"serveMode,omitempty"`
	Installation *struct {
		NodeVersion *TaggedString `json:"nodeVersion,omitempty"`
		HostVersion *TaggedString `json:"hostVersion,omitempty"`
	} `json:"installation,omitempty"`
}

// TaggedString is a value plus the source it came from.
type TaggedString struct {
	Value  string `json:"value"`
	Source string `json:"source"`
}

// TaggedStringList is a string-list value plus its source.
type TaggedStringList struct {
	Value  []string `json:"value"`
	Source string   `json:"source"`
}

// FetchHealth reads /health from a loopback endpoint. Returns an error if the
// endpoint is unreachable or does not identify as a switchboard service — the
// launcher MUST never treat a non-switchboard port as a host.
func FetchHealth(baseURL string, timeoutMs int) (*HealthSnapshot, error) {
	if timeoutMs <= 0 {
		timeoutMs = 2000
	}
	t := &client.Transport{BaseURL: baseURL, HTTP: &http.Client{Timeout: time.Duration(timeoutMs) * time.Millisecond}}
	res, err := t.ApiGet("/health", nil)
	if err != nil {
		return nil, err
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("/health returned HTTP %d", res.Status)
	}
	var h HealthSnapshot
	if err := json.Unmarshal([]byte(res.Body), &h); err != nil {
		return nil, fmt.Errorf("/health parse failed: %w", err)
	}
	if h.Service != "switchboard" || h.Status != "ok" {
		return nil, fmt.Errorf("health endpoint did not identify as switchboard")
	}
	return &h, nil
}

// FetchLauncherState reads GET /launcher/state from a loopback endpoint. The
// route is authenticated the same as every other route; the launcher passes
// the resolved token through the transport.
func FetchLauncherState(t *client.Transport) (*LauncherStateProjection, error) {
	res, err := t.ApiGet("/launcher/state", nil)
	if err != nil {
		return nil, err
	}
	if res.Status == 404 {
		// Old host without the route — version incompatibility, NOT "no
		// workspaces". The caller falls back to a local-DB read.
		return nil, ErrLauncherStateUnavailable
	}
	if res.Status != 200 {
		return nil, fmt.Errorf("/launcher/state returned HTTP %d: %s", res.Status, res.Body)
	}
	var p LauncherStateProjection
	if err := json.Unmarshal([]byte(res.Body), &p); err != nil {
		return nil, fmt.Errorf("/launcher/state parse failed: %w", err)
	}
	return &p, nil
}

// ErrLauncherStateUnavailable is returned when the running host has no
// /launcher/state route (old version). Callers fall back to a local-DB read
// rather than treating this as "no workspaces".
var ErrLauncherStateUnavailable = fmt.Errorf("launcher-state route unavailable (old host version)")

// PostShutdown calls the loopback-only authenticated /shutdown route. The
// transport must carry the resolved auth token. Returns the parsed response or
// an error describing a refusal.
func PostShutdown(t *client.Transport) (map[string]any, error) {
	res, err := t.ApiPost("/shutdown", map[string]any{}, 10000)
	if err != nil {
		return nil, err
	}
	var body map[string]any
	_ = json.Unmarshal([]byte(res.Body), &body)
	if res.Status == 200 {
		return body, nil
	}
	reason := ""
	if body != nil {
		if r, ok := body["reason"].(string); ok {
			reason = r
		}
	}
	if reason == "" {
		reason = strings.TrimSpace(res.Body)
	}
	if reason == "" {
		reason = fmt.Sprintf("HTTP %d", res.Status)
	}
	return body, fmt.Errorf("shutdown refused: %s", reason)
}
