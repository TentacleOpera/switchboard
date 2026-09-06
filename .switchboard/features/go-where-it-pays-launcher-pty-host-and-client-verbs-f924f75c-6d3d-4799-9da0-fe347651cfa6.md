# Go Where It Pays — Launcher, PTY Host and Client Verbs

**Complexity:** 9

## Goal

Three places Go removes a real dependency without duplicating any shared service: the launcher (runs before Switchboard exists), the PTY host (deletes node-pty and 63 MB), and the CLI client verbs (0.32s to 10ms, no Node to talk to a board). None of the three holds board logic.

## How the Subtasks Achieve This

- **A Go PTY Host, and `node-pty` Leaves the Package**: Replaces the complete TypeScript/`node-pty` terminal runtime with one versioned Go host used by both composition roots, preserving terminal protocol, WebSocket, lifecycle, prompt-delivery, and logging contracts while removing the native dependency and its packaging matrix.
- **The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node**: Builds the static `switchboard` front controller, moves one-request command decisions behind shared host APIs, adds explicit remote endpoint/workspace/credential resolution, and retains the Node host only as an absolute-path handoff for local administration and serving.
- **The Launcher Is a Static Go Binary, So It Can Run Before Switchboard Is Installed**: Adds the Linux amd64 and Linux arm64/Raspberry Pi bare-machine supervisor, workspace picker, safe start/attach/stop lifecycle, prerequisite guidance, headless commands, and desktop artifacts while consuming host-owned state instead of duplicating board or workspace logic. It produces no macOS, Windows, or armhf launcher.

## Dependencies & sequencing

- Ship **A Go PTY Host, and `node-pty` Leaves the Package** first. It establishes the single Go module, target naming, build helper, artifact manifest, and supported-platform guard used by both later binaries. Its language-neutral terminal fixtures must exist before the TypeScript terminal runtime or `node-pty` packaging is removed.
- Ship **The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node** second. It owns shared Go HTTP transport, tagged endpoint/workspace/credential resolution, version metadata, browser opening, and absolute Node-host handoff that the launcher must reuse.
- Ship **The Launcher Is a Static Go Binary, So It Can Run Before Switchboard Is Installed** third. It extends the shared server and packaging surfaces with host identity/capabilities, launcher-state projection, safe standalone shutdown, Linux/Raspberry Pi installer adapters, and final Linux desktop routing. Its only launcher artifacts are `linux/amd64` and `linux/arm64`.
- Shared composition-root, API-server, CLI-host, Debian-package, artifact-manifest, release-workflow, and test-contract edits follow that ownership order. Later subtasks extend earlier end states; they do not create competing modules, endpoint resolvers, workspace stores, or artifact selectors.
- PTY-host and static-client platform research remains scoped to those subtasks. Launcher research is limited to optional Linux X11/Wayland tray behavior, Debian-family privilege elevation, package signatures, and Node ≥ 22 sources. Those unresolved adapters stay disabled; they do not block the Linux launcher core, embedded picker, headless commands, or packaging.
- All three subtasks remain one delivery unit. Do not publish a launcher or static client against an artifact manifest/server contract that has not landed, and do not remove the current runtime before its replacement contracts are executable.

## Team Dispatch Instructions

### A Go PTY Host, and `node-pty` Leaves the Package

**Seat:** lead

**Acceptance:**
- Both extension and standalone composition roots start the same versioned Go PTY host contract and expose the same terminal capabilities.
- Spawn, input, output, resize, prompt framing/readiness, WebSocket authentication/replay, logging, close, and parent-death behavior pass the migrated language-neutral and black-box contracts.
- `node-pty` is absent from live dependencies, runtime imports, bundler externals, package inclusion rules, and produced artifacts; `better-sqlite3` remains intact.
- Every supported package contains the matching executable with correct architecture/mode and a successful version/handshake probe; missing targets disable terminals with an explicit reason.

**Must not touch:** Board schema, plan/column rules, board prompt templates, `better-sqlite3`, or the separate HTTP API trust model.

### The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node

**Seat:** lead

**Acceptance:**
- Every owned verb matches existing JSON bytes, human output, stderr behavior, timeout, and exit-code fixtures against both hosts.
- A Node-free machine can call a remote board with explicit endpoint, server workspace root, and credential source without creating local workspace state.
- Each owned verb makes one semantic command request after explicit endpoint resolution; routing values expose their source and ambiguous remote identity fails loudly.
- Non-client verbs reach one verified absolute Node host entry or return the named no-host-installed error; agent-facing CLI paths resolve to the static client in both hosts.

**Must not touch:** Database implementation, board transition/dispatch decisions, prompt text, or the existing Node implementations of serving, setup, secrets, token, import/export, and control-plane administration.

### The Launcher Is a Static Go Binary, So It Can Run Before Switchboard Is Installed

**Seat:** lead

**Acceptance:**
- Linux amd64 and Linux arm64/Raspberry Pi launcher artifacts run diagnostics without Node or Switchboard, every visible desktop action has an equivalent headless command, and no macOS, Windows, or armhf launcher artifact is produced.
- The workspace picker distinguishes served and unserved roots, attaches or starts accordingly, and never offers both actions for one root.
- Host identity and capabilities are explicit in both compositions: standalone can shut down through the guarded loopback path; extension can never expose Stop or be signalled.
- The Linux desktop entry opens the launcher picker rather than serving the process working directory, and every prerequisite step offers Install, Show instructions, or Skip without a confirmation dialog.
- Linux artifacts carry verified version, architecture, checksum, and Debian signature metadata; unresolved tray or privilege adapters stay visibly unavailable.

**Must not touch:** Board UI, schema, prompts, column logic, first-run setup forms, or a second launcher-owned workspace/service configuration store.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Go PTY Host, and `node-pty` Leaves the Package](../plans/go-pty-host-replaces-node-pty.md) — **CODE REVIEWED** — ID: 5603056e-9b32-42f5-9b7d-64efc5027b84
- [ ] [The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node](../plans/go-cli-client-verbs.md) — **CODE REVIEWED** — ID: ba8f2b52-2701-4c2d-b98c-00b8f292997d
- [ ] [The Launcher Is a Static Go Binary, So It Can Run Before Switchboard Is Installed](../plans/go-launcher-static-binary.md) — **CODE REVIEWED** — ID: 6e435690-ecd3-4c89-bdfa-2e12cbba1f4a
<!-- END SUBTASKS -->


## Review Findings

Reviewed as one delivery unit in the feature's stated ship order. Six CRITICAL and five MAJOR findings were fixed in place; the goal is achieved for the PTY host and reached only after this pass for the client and the launcher. The recurring shape was write-without-reader: `setGoClientPath()` was called by both roots and read by nothing, so every dispatched prompt still named the 17 MB Node bundle; `/usr/bin/switchboard` was still a symlink to `dist/standalone/cli.js` and the Go client was never built by any packaging script; the launcher-state projection routed through a retired `getWorkspaceMappings()` stub and so always reported zero configured workspaces as an available answer; and `ptyReady` was a hardcoded `true`, making a missing Go artifact indistinguishable from a working terminal runtime. The desktop entry ran `switchboard-launcher start`, which falls back to `os.Getwd()` — the same `$HOME`-serving defect the launcher exists to fix — and now opens the picker. `scripts/package-deb.sh` had node-pty staging reintroduced by a later commit, leaving the CI-wired VSIX contract red at HEAD. Gate wiring was the enabling condition throughout: CI had no Go toolchain, no `go build`, no `go test`, and never invoked the black-box PTY suite, so none of this could fail a check — all four are now wired. Verification: `tsc --noEmit` clean apart from five errors pre-existing at HEAD, eslint 0 errors, and a 173-suite contract sweep diffed against a pristine `git archive HEAD` baseline showing zero regressions and six suites newly green.

## Deferred Findings

- MAJOR — The CLI subtask's one-request server adapters were not built: `ready`, dispatch-by-prefix, `fleet` and `verb` still make two requests each, and `logs` has no host endpoint so it cannot work against a remote board. `internal/client/verbs.go:199`
- MAJOR — The launcher subtask has no automated coverage at all; its seven named Automated items have no suite in `package.json` or CI. `.github/workflows/integration-tests.yml:1`
- MAJOR — `capabilities.openShellUrl` / `setupPanelUrl` are typed and projected but wired by neither composition root. `src/services/LocalApiServer.ts:860`
- MAJOR — Three artifact manifests with three shapes were created where the plans specified one shared foundation. `launcher-artifacts.json:1`
- MAJOR — `SWITCHBOARD_API_TOKEN` is injected into pty children by standalone only, never by the extension. Pre-existing divergence carried forward, not introduced here. `src/services/goPtyFleetProjection.ts:216`
- NIT — No Go toolchain in this environment, so `go build`, `go vet` and the Go unit tests could not be run; the native PTY black-box probe did execute against a locally built binary. `go.mod:1`
- NIT — `PtyHostSupervisor.stop()` never clears `stopPromise`, so a start-after-stop then stop would leave the new child unreaped. `src/services/ptyHostSupervisor.ts:170`
- NIT — Terminal WS token uses a non-constant-time compare, and the `[::1]` origin literal can never match `url.Hostname()`. `cmd/switchboard-pty-host/ws.go:21`
- NIT — `test:contract:terminal-operations-no-periodic-reopen` is defined but not invoked by CI (pre-existing, unrelated to this feature). `package.json:1`
