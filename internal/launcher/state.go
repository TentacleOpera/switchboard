// Package launcher implements the static Switchboard launcher controller (plan:
// go-launcher-static-binary). It is a platform-neutral state machine plus
// headless commands; the CLI and the embedded loopback UI call the same
// operations.
//
// The launcher holds NO business logic. It talks HTTP — /health for state,
// /launcher/state for the host-owned projection, /shutdown for teardown — and
// hands off to the Node host entry point for start. It never opens kanban.db,
// reads board schemas, stores prompt text, or decides column behavior. A
// supervisor in Go is a different program; a board in Go would be 52 shared
// service classes implemented twice with no way to check they agree.
package launcher

// HostKind is the kind of host that answered /health. It is the one fact /health
// did not safely provide and that a PID-only Stop action cannot recover.
type HostKind string

const (
	// HostKindExtension is the VS Code extension host. Its PID is the extension
	// host process — a generic Stop could terminate the editor. The launcher
	// offers Open but never Stop.
	HostKindExtension HostKind = "extension"
	// HostKindStandalone is the standalone Node host. It owns graceful teardown
	// and may expose a loopback-only authenticated /shutdown route.
	HostKindStandalone HostKind = "standalone"
	// HostKindUnknown is an old host that predates identity wiring, or a host
	// whose /health did not identify itself. The launcher refuses side effects.
	HostKindUnknown HostKind = "unknown"
)

// HostIdentity is the identity /health reports. All fields are optional on old
// hosts; the launcher treats absence as HostKindUnknown and refuses mutation.
type HostIdentity struct {
	Kind       HostKind `json:"kind"`
	InstanceID string   `json:"instanceId"`
	Version    string   `json:"version"`
	Source     string   `json:"source"`
}

// Capabilities are the lifecycle operations the host declares.
type Capabilities struct {
	Shutdown      ShutdownCapability `json:"shutdown"`
	OpenShellURL  *TaggedURL         `json:"openShellUrl,omitempty"`
	SetupPanelURL *TaggedURL         `json:"setupPanelUrl,omitempty"`
}

// ShutdownCapability is the explicit gate for Stop. Enabled is true ONLY on a
// standalone host that wired a shutdown callback; the extension declares false
// with a reason.
type ShutdownCapability struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

// TaggedURL is a URL plus the source it came from. Presentation only — never
// changes board behaviour.
type TaggedURL struct {
	URL    string `json:"url"`
	Source string `json:"source"`
}

// LauncherState is the controller's resolved state. Every detected fact carries
// its source so a stale projection is visible before it is acted on.
type LauncherState struct {
	// HostInstalled is true when a Node host entry point is resolvable on this
	// machine. Source names the resolution path (env, deb, bundled, dev, none).
	HostInstalled bool   `json:"hostInstalled"`
	HostEntry     string `json:"hostEntry,omitempty"`
	HostSource    string `json:"hostSource,omitempty"`

	// RunningHost is the identity of the running host, or nil when none is
	// reachable. Source names the discovery path (local-discovery, port-file,
	// none).
	RunningHost    *HostIdentity `json:"runningHost,omitempty"`
	RunningPort    int           `json:"runningPort,omitempty"`
	RunningSource  string        `json:"runningSource,omitempty"`
	ShutdownCap    *ShutdownCapability `json:"shutdownCapability,omitempty"`
	SelectedRoot   string        `json:"selectedWorkspaceRoot,omitempty"`
	ServedRoots    []string      `json:"servedRoots,omitempty"`

	// Workspaces is the named-workspace projection. Unavailable is true when the
	// provider/DB service is missing — NEVER an empty list indistinguishable
	// from "no workspaces configured" (the fallback rule in CLAUDE.md).
	Workspaces WorkspaceProjection `json:"workspaces"`

	// Dependencies are the detected prerequisites. Each carries version/path/
	// source. Missing is true when the dependency is not present.
	Dependencies []DependencyFact `json:"dependencies,omitempty"`

	// SystemFacts are the detected apt/dpkg/systemd/desktop/privilege facts
	// the launcher reports to `doctor` and `install` (the latter is disabled).
	// Read-only — never drives a privileged install.
	SystemFacts *SystemFacts `json:"systemFacts,omitempty"`

	// State is the symbolic state name (see StateXxx constants).
	State string `json:"state"`
}

// WorkspaceProjection is the named-workspace list with an explicit unavailable
// shape. An empty Value is "no workspaces configured"; Unavailable is "the
// provider could not answer".
type WorkspaceProjection struct {
	Unavailable bool                  `json:"unavailable"`
	Reason      string                `json:"reason,omitempty"`
	Source      string                `json:"source,omitempty"`
	Value       []WorkspaceMappingRow `json:"value,omitempty"`
}

// WorkspaceMappingRow is one named workspace from the host-owned projection.
type WorkspaceMappingRow struct {
	Root    string `json:"root"`
	Label   string `json:"label,omitempty"`
	Enabled bool   `json:"enabled"`
}

// DependencyFact is one detected prerequisite with version/path/source.
type DependencyFact struct {
	Name    string `json:"name"`
	Present bool   `json:"present"`
	Version string `json:"version,omitempty"`
	Path    string `json:"path,omitempty"`
	Source  string `json:"source"`
	Note    string `json:"note,omitempty"`
}

// Symbolic state names. The controller resolves raw facts into one of these so
// the UI and CLI present a single derived action rather than making the user
// pick among actions that would fail.
const (
	// StateNoHostInstalled: no Node host entry point resolvable. The launcher
	// offers Install/Show instructions/Skip and, after prerequisites, the
	// first-run setup panel handoff.
	StateNoHostInstalled = "no-host-installed"
	// StateHostStopped: a host is installed but no host is running. The launcher
	// offers Start for an explicit workspace.
	StateHostStopped = "host-stopped"
	// StateStandaloneRunning: a standalone host is running. The launcher offers
	// Open (and Stop, loopback-only, when capability is declared).
	StateStandaloneRunning = "standalone-running"
	// StateExtensionRunning: the extension host is running. The launcher offers
	// Open but never Stop.
	StateExtensionRunning = "extension-running"
	// StateIncompatibleOldHost: a host answered /health but reported no
	// identity. The launcher offers Open (read-only) and warns; mutation is
	// unavailable.
	StateIncompatibleOldHost = "incompatible-old-host"
	// StateMissingDependency: a prerequisite (Node runtime) is missing. The
	// launcher offers Install/Show instructions/Skip.
	StateMissingDependency = "missing-dependency"
	// StateUnsupportedPlatformAction: the requested action is not supported on
	// this platform/host combination (e.g. Stop on extension).
	StateUnsupportedPlatformAction = "unsupported-platform-action"
)

// AvailableActions returns the action set the controller permits for the state.
// A rendered state never offers both Start and Attach for the same root.
func (s LauncherState) AvailableActions() []string {
	switch s.State {
	case StateNoHostInstalled, StateMissingDependency:
		return []string{"doctor", "install", "show-instructions", "skip"}
	case StateHostStopped:
		return []string{"start", "open", "doctor", "install", "show-instructions"}
	case StateStandaloneRunning:
		acts := []string{"open", "doctor"}
		if s.ShutdownCap != nil && s.ShutdownCap.Enabled && s.RunningHost != nil && s.RunningHost.Kind == HostKindStandalone {
			acts = append(acts, "stop")
		}
		return acts
	case StateExtensionRunning:
		return []string{"open", "doctor"}
	case StateIncompatibleOldHost:
		return []string{"open", "doctor"}
	default:
		return []string{"doctor"}
	}
}

// ResolveState derives the symbolic state from the detected facts. The
// dependency check wins: a missing Node runtime means the host cannot start,
// so the state is StateMissingDependency even when a stale host binary exists.
func ResolveState(hostInstalled bool, running *HostIdentity, shutdown *ShutdownCapability, missingDep bool) string {
	if missingDep {
		return StateMissingDependency
	}
	if !hostInstalled {
		return StateNoHostInstalled
	}
	if running == nil {
		return StateHostStopped
	}
	switch running.Kind {
	case HostKindStandalone:
		_ = shutdown // shutdown capability refines the action set, not the state
		return StateStandaloneRunning
	case HostKindExtension:
		return StateExtensionRunning
	default:
		return StateIncompatibleOldHost
	}
}
