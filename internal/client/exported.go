package client

import (
	"os"
	"runtime"
	"strings"
)

// NewClient is the exported constructor used by the front controller. It wires
// a Transport from the routes and records the resolved Node host entry point.
// (Defined in verbs.go; this comment documents the exported surface.)

// EmitOfflineGuidance is the exported offline-guidance emitter.
func EmitOfflineGuidance(jsonFlag bool) { emitOfflineGuidance(jsonFlag) }

// EmitStatusOffline emits the established `{running:false}` shape for `status`
// when no endpoint is reachable. Always exits 1.
func EmitStatusOffline(jsonFlag bool) {
	if jsonFlag {
		emitJSON(map[string]any{"running": false})
	} else {
		emitErr("[switchboard] No running Switchboard instance for this workspace.")
	}
	os.Exit(1)
}

// CmdHelpForMain is the no-argument help entry point used by the front
// controller for `--help`/`-h`.
func (c *Client) CmdHelpForMain() {
	os.Stdout.WriteString(usageText)
	os.Exit(0)
}

// CmdAboutForMain is the about entry point used when no endpoint is reachable.
// It still identifies the Go client and the resolved Node host entry.
func (c *Client) CmdAboutForMain() {
	if c.JSONFlag {
		type aboutJSON struct {
			Version        string  `json:"version"`
			Service        string  `json:"service"`
			Host           string  `json:"host"`
			Platform       string  `json:"platform"`
			Arch           string  `json:"arch"`
			WorkspaceRoot  string  `json:"workspaceRoot"`
			Running        bool    `json:"running"`
			NodeHostEntry  *string `json:"nodeHostEntry"`
			NodeHostSource string  `json:"nodeHostSource"`
		}
		p := aboutJSON{
			Version:       Version,
			Service:       "switchboard",
			Host:          "go-client",
			Platform:      runtime.GOOS,
			Arch:          runtime.GOARCH,
			WorkspaceRoot: c.serverRoot(),
			Running:       false,
		}
		if c.NodeEntry != "" {
			entry := c.NodeEntry
			p.NodeHostEntry = &entry
			p.NodeHostSource = string(c.NodeSource)
		} else {
			p.NodeHostEntry = nil
			p.NodeHostSource = string(SourceNone)
		}
		emitJSON(p)
		os.Exit(0)
	}
	emitHuman(bannerArtASCII)
	emitHuman("")
	emitHuman("SWITCHBOARD v%s", Version)
	emitHuman("Agent Fleet Command")
	emitHuman("")
	emitHuman("https://github.com/TentacleOpera/switchboard")
	emitHuman("Host: Go Client (" + runtime.GOOS + " " + runtime.GOARCH + ")")
	if c.NodeEntry != "" {
		emitHuman("Node host: %s (%s)", c.NodeEntry, c.NodeSource)
	} else {
		emitHuman("Node host: (not installed)")
	}
	emitHuman("")
	emitHuman("Active Server:    (not running)")
	emitHuman("Workspace:        %s", c.serverRoot())
	os.Exit(0)
}

// HasScheme is a thin wrapper for tests that want to exercise path
// validation without constructing a Client.
func HasScheme(p string) bool { return hasScheme(p) }

// IsFullUUID reports whether s is a canonical 8-4-4-4-12 hex UUID.
func IsFullUUID(s string) bool { return isFullUUID(s) }

// ShortPrefixExported mirrors shortPrefix for tests.
func ShortPrefixExported(planID string) string { return shortPrefix(planID) }

// ParseServerURLExported mirrors parseServerURL for tests.
func ParseServerURLExported(raw string) (Endpoint, error) { return parseServerURL(raw) }

// DispatchExitCodeExported mirrors dispatchExitCode for tests.
func DispatchExitCodeExported(status int) int { return dispatchExitCode(status) }

// TrimPrefix is a small helper to avoid importing strings in callers that
// only need this one operation.
func TrimPrefix(s, prefix string) string { return strings.TrimPrefix(s, prefix) }
