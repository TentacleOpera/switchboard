# The Launcher Is a Static Go Binary, So It Can Run Before Switchboard Is Installed

kanbanColumn: CREATED

## Goal

A static Go launcher for Linux amd64 and Linux arm64—including 64-bit Raspberry Pi OS—that
supervises the standalone host, picks a workspace, starts or attaches, and, because it depends on
nothing, can guide a bare Linux machine through installing everything else. macOS, Windows, and
32-bit Raspberry Pi OS/armhf launchers are outside this plan.

### Problem analysis

**Extracted from `switchboard-as-a-local-app-and-a-self-hosted-remote.md` (`9adefb23`), which is at
CODE REVIEWED with this work openly deferred.** That card's own review findings record it: *"changes
1 (tray launcher), 2, 5, 6, 7, 8 are unimplemented"* and *"change 10's settings **window** does not
exist. There is a read-only JSON endpoint and no UI."* Leaving new scope on a reviewed card makes it
untrue about what shipped; this plan is the home for the launcher half.

**A launcher written in Node cannot do the job it exists for.** The host needs Node ≥ 22 and ~33 MB
of native modules. A launcher in the same stack cannot start until those are already present — which
is exactly the machine where guidance is needed. A static binary runs on a bare OS, so it can be the
thing that *gets* the rest.

**The distribution tiers already permit this, and only here.** The first-run wizard refuses to
install system state and is right to — it is the `npx` tier, whose contract is "leave nothing
behind". The `.deb` installs but does not configure. A real app artifact the operator downloaded
deliberately "may persist everything". The launcher is the one surface entitled to close the gap
between those two, and today nothing does: a novice must know to run `apt install` *and* then know
`switchboard setup host` exists.

**The dependency it must solve is real and current.** Stock Raspberry Pi OS offers `nodejs
20.19.2`; the package declares `Depends: nodejs (>= 22)`. On the platform this product targets, the
dependency is unsatisfiable from the distro alone and `apt` simply refuses.

**And it fixes a defect already shipped.** `packaging/switchboard.desktop` is `Exec=switchboard
local` with `Path=` deliberately absent, so an icon click serves whatever tree the desktop session's
cwd happens to be — or `$HOME`, which is not a workspace. The reviewer filed the same thing as a NIT.
The launcher should be what the entry starts.

**It holds no business logic, which is what makes a second language safe.** It talks HTTP —
`/health` for state, the same endpoints the browser uses. No schema, no prompt text, no column
rules. A supervisor in Go is a different program; a *board* in Go would be 52 shared service classes
implemented twice with no way to check they agree.

### Root-cause refinement

The launcher needs three facts that current `/health` does not safely provide by itself: which host
kind answered, which lifecycle operations that host permits, and which stopped workspaces are known.
A PID plus `service: switchboard` is not authority to terminate a process—an extension-host response
can belong to VS Code—and a running host's roots cannot describe a machine where no host is running.
The launcher therefore needs explicit capability/identity wiring in both composition roots and a
host-owned state projection; Go must not infer board identity by opening `kanban.db` or maintaining a
second workspace registry.

## Metadata

- **Complexity:** 8
- **Tags:** ui, ux, infrastructure, cli

## User Review Required

- Confirm the Linux desktop-shell choice after focused Wayland/X11/AppIndicator validation. All behavior remains in a headless Go controller plus embedded loopback UI; any tray adapter is optional and thin, and failure to provide a tray must not make the launcher invisible because the desktop entry and direct command remain available.
- Approve the Debian-family privilege-escalation and package-source policy before enabling installation actions. Detection, explanation, **Show instructions**, and **Skip** can land first; privileged execution must not be improvised.

## Resolved Assumptions

- **Launcher target:** Linux amd64 and Linux arm64 only, including 64-bit Raspberry Pi OS on supported Pi hardware.
- **Explicit exclusions:** No macOS launcher, no Windows launcher, and no 32-bit armhf launcher are part of this plan.
- **Headless contract:** Raspberry Pi operation does not depend on a desktop, tray, Wayland, X11, or browser. Every launcher action has a CLI path through the same controller.
- **Distribution contract:** Linux launcher artifacts may be direct binaries and Debian-family packages; macOS notarisation and Windows Authenticode are irrelevant to this subtask.

## Complexity Audit

### Routine

- Reuse the shared Go endpoint, credential, version, browser-open, and Node-host resolver packages from the client-verbs subtask.
- Add headless launcher commands over typed controller operations.
- Change the Debian desktop entry and package file copies after the launcher artifact exists.

### Complex / Risky

- Provide reliable Linux desktop entry and optional tray behavior across supported X11 and Wayland environments while preserving complete headless CLI equivalents.
- Distinguish extension and standalone hosts and make stop capability explicit so the launcher cannot terminate VS Code or a process it does not control.
- Project known workspaces without reading board databases or creating a second persistent list that can drift.
- Guide privileged package and Node runtime installation safely across Raspberry Pi OS, Debian, and Ubuntu, with every source and version visible.
- Coordinate bare-machine, host-installed-but-stopped, running-standalone, running-extension, multi-workspace, and remote/tailnet states.

## Edge-Case & Dependency Audit

### Race Conditions

- A workspace can become served between picker render and Start. Re-resolve launcher state immediately before acting; if now served, attach instead of starting and report the state transition.
- A host can stop or change roots between state read and Open/Stop. Side-effecting operations validate host instance identity/capability at execution and never retry against another discovered process.
- Shutdown response must flush before standalone begins teardown. The host schedules stop only after accepting and answering the loopback request.
- Two launcher instances can click Start concurrently. The Node host's existing single-writer guard remains authoritative; the second launcher interprets that refusal by re-reading state and attaching only when the matching workspace is now served.

### Security

- The launcher never opens `kanban.db`, reads board schemas, stores prompt text, or decides column behavior.
- Host shutdown is authenticated under the existing API policy, restricted to loopback, and available only when the composition root declares a standalone shutdown capability. Extension reports unsupported; it is never signalled.
- Downloaded packages/runtime artifacts require HTTPS, a pinned release manifest, checksum verification, and Debian repository/package signature validation where applicable before execution. No install command is assembled through a shell string.
- Credentials and one-time browser enrolment tokens never appear in logs, process arguments, window titles, or persistent launcher state.
- Installation UI uses explicit multi-choice actions such as **Install**, **Show instructions**, and **Skip**. It never uses a confirmation dialog, `confirm()`, yes/no modal, or two-click delete/confirmation pattern.

### Side Effects

- The launcher may persist only launcher presentation state that cannot change board behavior (window position, last selected display row). Workspace authority remains the host-owned projection; unknown/legacy mapping keys remain untouched.
- Re-running installation or setup is idempotent or returns an explicit already-installed state with detected source/version.
- A declined step leaves the launcher operational and visible. It does not mark the dependency installed or hide the remaining capability gap.
- Starting standalone uses the existing Node host command and package configuration paths; the launcher does not create another service definition or startup store.

### Dependencies & Conflicts

1. The PTY-host subtask owns the Go module/build/artifact foundation. The client-verbs subtask owns shared Go HTTP, tagged target/credential resolution, browser opening, version metadata, and absolute Node-host handoff. This launcher consumes both and adds `cmd/switchboard-launcher` plus launcher-specific controller/UI packages.
2. The launcher must land after the static client packages because endpoint scanning, remote/local identity, credentials, and Node-host lookup must have one implementation.
3. `src/services/LocalApiServer.ts`, `src/extension.ts`, and `src/standalone/bootstrap.ts` are shared surfaces with client verbs. This subtask owns host identity/capabilities and launcher-state/shutdown wiring; the client plan owns client-command adapters.
4. `scripts/package-deb.sh`, release workflows, and the artifact manifest are append-only extensions of the earlier Go work. This subtask owns launcher artifacts and final `packaging/switchboard.desktop` routing.
5. The first-run panel remains the only product setup flow for scaffolding, CLIs, roles, teams, and trackers. The launcher diagnoses/installs prerequisites and opens that existing panel; it does not copy its forms or settings logic.
6. Headless operation is mandatory: every launcher action has a non-GUI command, and the standalone host remains directly startable without the launcher.

## Dependencies

- No session dependency identifier was supplied. Internal feature order is **A Go PTY Host, and `node-pty` Leaves the Package** → **The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node** → this launcher plan.

## Adversarial Synthesis

Key risks are turning an unsafe PID into a Stop button, inventing a second workspace/configuration authority, and making the Linux installer or optional tray depend on an unverified elevation or desktop-session mechanism. Mitigate them with explicit host identity/capabilities in both roots, host-owned state projection, loopback-only authenticated shutdown, shared tagged Go resolvers, complete headless commands, and focused Linux desktop/elevation probes.

## Proposed Changes

### 1. `src/services/LocalApiServer.ts` — expose explicit host identity, capabilities, and launcher state

> **Superseded:** Start, stop and status for the standalone host, read from `/health` — which already returns `roots`, `selectedWorkspaceRoot`, `pid`, `port` and terminal counts. Open the shell in a browser. That is the whole resident surface.
> **Reason:** `/health` can support discovery and status, but its PID does not identify extension versus standalone, prove process ownership, or authorize termination. Treating it as a Stop mechanism can signal the VS Code extension host or a replaced process.
> **Replaced with:** Use `/health` for discovery/status only after adding explicit host identity and capabilities. Start through the verified Node-host handoff, attach/open through the authenticated browser path, and stop only a matching standalone instance through a loopback-only authenticated shutdown callback.

- **Context:** `/health` currently returns service, status, port, PID, roots, selected workspace, terminals, and memory. It does not identify extension versus standalone, declare lifecycle capabilities, or provide named known-workspace rows. The existing data sources remain authoritative: `_allRoots` on `LocalApiServer`, `/health`'s `roots` and `selectedWorkspaceRoot`, and the names in `workspace_mappings` via `db.getWorkspaceMappings()` as surfaced by `SetupPanelProvider`; the launcher consumes a host projection of those sources and never keeps a second list.
- **Logic:** Extend `LocalApiServerOptions` with required production callbacks for host identity/capabilities and launcher-state projection. Test harnesses may omit them and receive an explicitly incomplete capability object; the launcher refuses side effects when identity is absent.
- **Implementation:**
  - Extend `/health` with `host: { kind, instanceId, version, source }` and `capabilities` fields. `kind` is `extension` or `standalone`; `instanceId` is stable only for the process lifetime and prevents action against a replaced process.
  - Add an authenticated launcher-state read combining health identity, source-tagged serve settings, current roots, selected root, named workspace mappings from the existing provider/DB service, installation facts the host can truthfully report, and capability reasons.
  - Every value that changes behavior carries its source. Missing mapping/provider data returns an explicit unavailable reason, not an empty array indistinguishable from “no workspaces configured.”
  - Add a loopback-only authenticated shutdown route that calls a standalone-supplied callback after the response flushes. An extension host returns a deliberate unsupported result and never exposes a shutdown callback.
- **Edge Cases:** Old hosts without identity fields remain attachable only for read/open after a warning; Stop and mutation controls stay unavailable. A 404/unsupported launcher-state endpoint is version incompatibility, not “no workspaces.”

### 2. `src/extension.ts` and `src/services/TaskViewerProvider.ts` — wire extension identity and read-only launcher capability

- **Context:** The extension owns a LocalApiServer but its PID is the VS Code extension host. A generic PID-based Stop action could terminate the editor.
- **Logic:** The extension composition root explicitly identifies itself, projects roots/workspace names through existing providers, and declares `shutdown: false` with a reason. Omission is not used to signal unsupported behavior.
- **Implementation:**
  - Generate a process-lifetime instance ID and provide `kind: extension`, extension version/source, root projection, and capability object when constructing LocalApiServer.
  - Reuse `KanbanProvider`/`SetupPanelProvider` mapping reads; do not add direct DB reads to the launcher client.
  - Provide the existing board/setup URLs needed to open the shell and hand off to the first-run panel.
  - Keep shutdown callback absent by type only where paired with explicit `shutdown: false`; route handling verifies both.
- **Edge Cases:** Multi-root selection changes update launcher state at call time, not activation time. A disposed/restarted LocalApiServer gets a new instance ID.

### 3. `src/standalone/bootstrap.ts` and `src/standalone/cli.ts` — wire standalone lifecycle capability and safe shutdown

- **Context:** Standalone can be stopped, but current `switchboard stop` derives a PID from `/health` and signals it. The shared health response does not prove host kind, so the same command can discover an extension host.
- **Logic:** Standalone declares shutdown capability and owns graceful teardown. Both the launcher route and Node `stop` command require matching `kind: standalone`, instance ID, and capability before requesting shutdown.
- **Implementation:**
  - Supply `kind: standalone`, process-lifetime instance ID, version/source, launcher-state projection, and shutdown callback in the `LocalApiServer` options object near `bootstrap.ts:3971`.
  - Route shutdown through the existing instance `stop()` sequence so terminal runtime, retention, API listeners, database writes, and discovery files close in their established order.
  - Update `switchboard stop` to refuse an extension or identity-less host rather than signalling its PID. Preserve PID/start-time checks only as a legacy local fallback explicitly approved for old standalone versions; report the source.
  - Expose a one-shot host-side launcher-state command for the installed-but-stopped case. It reads workspace mappings through existing Node services and prints a typed result; Go never parses the database.
- **Edge Cases:** systemd stop remains signal-driven and unaffected. Launcher shutdown of a service-managed host reports that systemd may restart it rather than claiming durable stop.

### 4. `cmd/switchboard-launcher/` and `internal/launcher/` — build one controller with complete headless commands

- **Context:** The launcher must work before Node or Switchboard exists and on a headless Pi. GUI code cannot be the source of behavior.
- **Logic:** Implement a platform-neutral state machine/controller first. The CLI and desktop shell call the same operations: `status`, `workspaces`, `open`, `start`, `stop`, `doctor`, `install`, and `setup` handoff.
- **Implementation:**
  - Reuse the client plan's tagged endpoint, credential, browser, version, and Node-host resolvers.
  - Model states explicitly: no host installed; host installed but stopped; standalone running; extension running; workspace served; workspace unserved; incompatible old host; missing dependency; unsupported platform action.
  - `status` prints every detected fact and source before presenting actions.
  - `workspaces` merges only authoritative results: running host launcher state, or the installed Node host's one-shot projection when stopped. A user-selected folder is an explicit candidate, not persisted as a second registry.
  - `start <workspace>` re-checks discovery, attaches if served, otherwise invokes the absolute Node host entry with explicit workspace and mode, waits for matching health identity/root, and reports source/version.
  - `open <workspace>` mints an enrolment token when required and opens the browser shell without logging the token.
  - `stop` calls the loopback shutdown route only for a matching standalone instance with declared capability.
- **Edge Cases:** Spaces/unicode/symlinks in roots, stale host projection, multiple running hosts, same root through alternate path spelling, extension-only host, service-managed host, old API version, no browser, and no desktop session all have named outcomes.

### 5. Embedded launcher surface and thin Linux desktop adapter — picker, state, and guided choices without a second board UI

- **Context:** A Linux desktop icon needs a visible picker, while headless Raspberry Pi and SSH environments need the same behavior without GUI dependencies. The launcher must not grow into a settings or board implementation.
- **Logic:** Serve a small embedded launcher UI on an ephemeral loopback port and open it from the Linux desktop entry. An optional X11/Wayland tray adapter may contain only show/hide/open/quit integration and must call the same controller; it is not required for the launcher to remain visible or usable.
- **Implementation:**
  - Render detected dependencies, host kind/status, workspaces, sources, and available actions. Do not render plans, columns, prompts, terminal grids, or settings forms.
  - Make Start/Attach one state-derived action: served root opens; unserved root starts. The user is never offered a Start action known to fail the single-writer guard.
  - Present install steps as explicit multi-choice actions—Install, Show instructions, Skip—with every step independently skippable. No confirmation gate or modal is introduced.
  - Expose an Add Workspace folder selection that passes an explicit candidate to existing host setup/start behavior; it does not write a launcher-owned registry.
  - Close or idle-timeout the embedded listener safely; bind loopback only and use an unguessable per-process UI token for mutating actions.
- **Edge Cases:** Browser-open failure prints the local URL/token through a safe one-time channel only when the user requested manual open; multiple browser tabs share controller state without issuing duplicate start/install operations.

### 6. Guided prerequisite and package installation — detect first, mutate only through approved adapters

- **Context:** The first-run panel cannot install system state, and Debian's package currently requires Node ≥ 22 even where the stock repository may not satisfy it.
- **Logic:** Separate detection, recommendation, and execution. Every fact includes version/path/source. The launcher can always explain and skip; privileged installation exists only for researched Raspberry Pi OS, Debian, and Ubuntu adapters.
- **Implementation:**
  - Detect Node version and absolute executable path, Switchboard host version and installation layout, `apt`/`dpkg` availability, systemd service state, desktop-session type, and current user privilege.
  - Load a signed/versioned release manifest describing official Linux amd64/arm64 artifacts, checksums, minimum host/runtime compatibility, and Debian-family installation methods. A missing/corrupt manifest disables automatic install visibly.
  - For an approved adapter, download to a private temporary location, verify checksum and repository/package signature, then invoke a fixed executable with an argument array through the approved Linux elevation mechanism.
  - Where no safe adapter exists, offer Show instructions and Skip; never pretend installation succeeded.
  - After prerequisites are present, invoke/open the existing first-run setup panel for scaffolding, CLIs, roles, teams, and trackers.
- **Edge Cases:** Offline machine, proxy/TLS failure, insufficient disk, unsupported architecture, stale release manifest, checksum mismatch, user-declined elevation, partial install, package manager lock, and restart-required state all remain recoverable.

### 7. `packaging/switchboard.desktop`, Debian package files, and release workflows — make the launcher the real entry point

- **Context:** The current desktop entry runs `switchboard local` without a workspace path. Release automation does not publish a launcher artifact.
- **Logic:** Install and publish the launcher independently so it can run before the host exists, and include the same artifact in host packages. Desktop entries invoke the launcher, never a cwd-sensitive serve command.
- **Implementation:**
  - Build `switchboard-launcher` only for `linux/amd64` and `linux/arm64`, using the shared version/artifact manifest. Raspberry Pi receives the same Linux arm64 artifact.
  - Change `packaging/switchboard.desktop` to an absolute/package-resolved launcher command. Keep `Terminal=false`, `StartupNotify=true`, and `Path=` absent because the launcher owns workspace selection.
  - Update `scripts/package-deb.sh` to copy the matching launcher with executable mode and a version/doctor smoke check while preserving the disabled-by-default systemd contract.
  - Publish checksums, version/protocol compatibility, Debian repository/package signatures where applicable, and exact architecture metadata. Do not publish or advertise macOS, Windows, or armhf launcher artifacts.
- **Edge Cases:** Desktop environment absent, Wayland tray integration absent, icon missing, stale desktop cache, service package older/newer than launcher, and direct launcher-only installation receive explicit diagnostics.

## Verification Plan

### Automated Tests

1. Run Go state-machine tests for every host/install/workspace combination and assert available actions plus fail-loud reasons.
2. Run LocalApiServer tests against extension and standalone option sets, proving host kind, instance ID, capability reasons, source-tagged launcher state, and shutdown authorization differ explicitly rather than by omission.
3. Run shutdown integration tests proving standalone flushes the response and tears down cleanly, while extension/identity-less/remote non-loopback requests cannot stop a process.
4. Run race tests where a workspace becomes served between render and action; require attach, not a second start.
5. Run installer-adapter tests with fake package managers/elevation helpers for argument safety, checksum/signature rejection, decline/skip behavior, partial failures, and no shell interpolation.
6. Run package tests for Linux amd64/arm64 launcher artifacts, `.deb`, desktop entry, executable modes, target/version manifests, checksums, and Debian repository/package signature metadata.
7. Run headless CLI tests for parity with every visible desktop action.

### Goal Invariants

- Linux amd64 and Linux arm64 `switchboard-launcher` artifacts run `doctor` on machines without Node or Switchboard installed; no macOS, Windows, or armhf launcher artifact is produced.
- The Linux arm64 artifact used by 64-bit Raspberry Pi OS is the same versioned artifact declared in the release manifest and Debian package metadata.
- `packaging/switchboard.desktop` no longer executes `switchboard local`; it executes the packaged launcher and contains no `Path=` workspace guess.
- Launcher Go source contains no kanban database access, board schema, prompt text, column logic, or copied first-run setup forms.
- `/health` from extension and standalone identifies the host kind and explicit shutdown capability; extension never exposes an enabled shutdown callback.
- A served workspace produces Attach/Open, while an unserved explicit workspace produces Start; no rendered state offers both for the same root.
- Every desktop action has a headless launcher command using the same controller method.
- Missing provider/configuration data is represented as unavailable/error with source, never as an empty configured workspace list.

### Manual and Platform Checks

1. On a machine with **no Node and no Switchboard**, the launcher runs, reports both as missing with sources, and offers Install/Show instructions/Skip according to supported adapters.
2. With several workspaces registered, the picker lists them, marks the one being served, and attaches to it in one action.
3. Picking an unserved workspace starts the standalone host; picking a served one opens the shell and does not attempt a second start.
4. Clicking the desktop icon lands in the picker, not on a board pointed at `$HOME`.
5. Every guided step can be declined and the launcher remains usable without claiming success.
6. On a headless Pi with no desktop session, the host still starts and every launcher action works through its CLI equivalent.
7. Attaching to an extension host allows Open but never Stop; attaching to standalone exposes Stop only over loopback with matching identity/capability.
8. Search the launcher source and built UI for schema, prompt text, column logic, copied setup forms, confirmation dialogs, and shell-built install commands; all are absent.
9. Exercise first launch on clean Linux amd64, Linux arm64, and 64-bit Raspberry Pi OS images; verify checksum/package-signature failures stop installation visibly.
10. Verify no macOS, Windows, or armhf launcher artifact, wrapper, package job, or release entry is produced.
11. Compare `src/extension.ts` and `src/standalone/bootstrap.ts` by hand for host identity, capability object, launcher-state projection, and shutdown callback wiring.

## Uncertain Assumptions

- Reliable optional tray behavior across supported Linux X11 and Wayland desktop environments, without making tray availability a launcher prerequisite, still needs focused external validation. The user was advised to run web research before enabling the tray adapter.
- Safe privilege elevation, `apt`/`dpkg` integration, Node ≥ 22 installation sources, and repository/package-signature practices for current Raspberry Pi OS, Debian, and Ubuntu need authoritative external confirmation. The user was advised to run web research before enabling automatic installation.
- Current Raspberry Pi OS Node package availability may differ by release and architecture and needs authoritative external confirmation. The user was advised to run web research before selecting an automatic Node installation source.

## Recommendation

**Send to Lead Coder.** Complexity 8: this combines host lifecycle security, explicit dual-host capabilities, Linux desktop/headless behavior, privilege boundaries, and bare-machine installation. Core Linux amd64/arm64 controller, API, embedded picker, headless commands, and packaging work can proceed now; keep the optional tray and automatic privileged installation disabled until their focused Linux validation is complete.

## Implementation Summary

Implemented the shared API host identity/capability/state/shutdown layer in `LocalApiServer.ts` (new `hostIdentity`, `capabilities`, `getLauncherState`, `shutdown` options; `/health` now reports `host` and `capabilities`; new `GET /launcher/state` and `POST /shutdown` routes with loopback-only, kind=standalone, enabled-capability, and re-entrancy guards). Wired the extension composition root in `TaskViewerProvider.ts` (identity kind=extension, shutdown disabled with reason, launcher-state projection via existing KanbanDatabase service) and the standalone composition root in `bootstrap.ts` (identity kind=standalone, shutdown enabled, `instanceStopRef` holder pattern to avoid the Promise<void> "never wired" trap, `projectStandaloneLauncherState` helper). Updated `cli.ts` `stop` to gate on host identity/capability and use `/shutdown` for identity-bearing standalone hosts (legacy PID fallback for old versions), and added the `launcher-state` subcommand. Built the Go controller under `cmd/switchboard-launcher/` and `internal/launcher/` (state machine, HTTP transport, host/node/system detection, headless commands: status/workspaces/open/start/stop/doctor/install/setup/ui, embedded loopback UI with tray disabled, install command disabled pending research). Updated `packaging/switchboard.desktop` to use `switchboard-launcher start`, added `scripts/build-launcher.sh` and `launcher-artifacts.json` (Linux amd64/arm64 only), and extended `scripts/package-deb.sh` to build and install the static launcher binary. No compilation or tests were run per explicit user directive; verification plan is documented in the plan body.

## Review Findings

Files changed: `src/services/LocalApiServer.ts` (new `readLauncherWorkspaceMappings`), `src/services/TaskViewerProvider.ts`, `src/standalone/bootstrap.ts`, `packaging/switchboard.desktop`, `packaging/switchboard-launcher.desktop` (deleted). The launcher-state projection read `db.getWorkspaceMappings()`, which is a retired stub returning `{ enabled: false, mappings: [] }` unconditionally, so both composition roots always answered `unavailable: false, value: []` — precisely the "empty array indistinguishable from no workspaces configured" this plan's own goal invariant forbids, and it made every unserved workspace invisible to the picker; both roots now read the live `workspace_mappings` row of the db `config` table through one shared reader that reports an absent key as a real empty answer and a corrupt or unreadable one as `unavailable` with its reason and source. The desktop entry ran `switchboard-launcher start`, which falls back to `os.Getwd()` when no `--workspace-root` is given (`cmd/switchboard-launcher/main.go:62`) — reproducing exactly the `$HOME`-serving defect this plan exists to fix, while the file's own comment claimed it passed `--workspace-root` explicitly — so it now runs `ui`, the embedded picker, and the byte-identical unused duplicate `switchboard-launcher.desktop` was removed. The `/health` identity, `/launcher/state` and `/shutdown` routes were verified by reading: loopback-only, tailnet-rejected, kind-checked, capability-checked, callback-checked, re-entrancy-latched, and flushed before teardown, with the extension declaring `shutdown: false` and wiring no callback. Verification: `tsc --noEmit` clean apart from five errors pre-existing at HEAD, eslint 0 errors, and a 173-suite contract sweep diffed against a pristine `git archive HEAD` baseline shows zero regressions.

## Deferred Findings

- MAJOR — No automated check discriminates on launcher behaviour at all: the plan's Automated items 1-7 (Go state-machine tests, dual-host LocalApiServer capability tests, shutdown integration, the render-then-served race, installer-adapter safety, launcher artifact packaging, headless/desktop parity) have no corresponding suite in `package.json` or `.github/workflows/`. CI now builds and `go test`s the module, so adding them has somewhere to run. `.github/workflows/integration-tests.yml:1`
- MAJOR — `capabilities.openShellUrl` and `capabilities.setupPanelUrl` are declared in the options type and the projection interface but wired by neither composition root, so the launcher's board/setup handoff has no host-supplied URL to open. `src/services/LocalApiServer.ts:860`
- MAJOR — `launcher-artifacts.json` uses a string `version` and omits the `binary` key that the PTY manifest reader requires, and no TypeScript caller reads it; it is documentation rather than a selector. `launcher-artifacts.json:1`
- NIT — Go launcher state-machine tests could not be executed in this environment (no Go toolchain installed). `internal/launcher/state.go:1`
- NIT — The live-host budget suite fails against the running board (565.4 MB RSS against a 350 MB ceiling; 17,268 inotify watches against the 8,192 Pi ceiling). Environment state, unrelated to this feature, but it bears directly on the plan's Raspberry Pi target. `src/test/resident-memory-budget-contract.test.js:200`
