# Stage 2 — The Extension Stops Being a Host

kanbanColumn: CREATED

## Goal

The extension stops constructing `LocalApiServer` in-process and stops owning its own database,
fleet, and watcher. Instead it spawns or attaches to the standalone host and the sidebar talks HTTP,
the same endpoints the browser uses. This is the stage that pays — it eliminates the two-hosts
divergence that is the single largest source of defects in this codebase.

### Problem analysis

**Two hosts is the single largest source of defects in this codebase, by its own account.**
`CLAUDE.md`'s second rule exists only because of the extension, and its worked example is four
`PlanIngestionEngine` queue seams wired in `extension.ts` alone for a month. Four more divergences
turned up in one evening. The defence against it is three parity gates — and the rule itself records
that `standalone-parity:check` is *"scoped to the browser read-back path, not the composition root"*
— so it does not catch the class it was built for.

**A board inside an editor is not always-on: close the window and the fleet's supervisor goes with
it.** The always-on board is the reason to run Switchboard on a Pi at all, and the extension is the
one deployment that cannot have it. Stage 2 fixes this by moving the host out of the extension
process.

## Metadata

- **Complexity:** 9
- **Tags:** refactor, infrastructure, cli

## User Review Required

None.

## Complexity Audit

### Routine

- Removing `LocalApiServer` construction from `TaskViewerProvider._startLocalApiServer()` (`TaskViewerProvider.ts:4610`) and the call site at line 2435.
- Rewriting parity checkers (`scripts/check-standalone-push-parity.js`, `scripts/check-host-seam-parity.js`) as assertions that the extension holds no host state.

### Complex / Risky

- **Extension spawn/attach lifecycle:** the extension must spawn the standalone host with `--detach` (which reparents to init via `detached: true` + `stdio: 'ignore'` in `cli.ts:4431-4457`) so the host survives window close — or attach to an already-running host via `findRunningInstance` (`cli.ts:443-468`, probes ports and matches workspace roots). The lifecycle decision determines whether the "always-on board" goal is actually met.
- **PTY ownership transfer:** the fleet and all PTYs move to the standalone host process. Terminals a user expects to see in the editor now live in the host process. The sidebar must show fleet status over HTTP and offer `tmux attach` or a browser terminal — but the design for this is Stage 3 work and must be resolved before Stage 2 lands.
- **Database ownership:** the extension currently opens its own database via `KanbanDatabase.forWorkspace()`. After Stage 2, the extension never opens the database — all reads and writes go through the host's HTTP API. This is a breaking change for every extension user's data path.
- **Single-writer race:** if the extension spawns a host while a host is already running for the same workspace, the single-writer check (`cli.ts:4267-4271`) exits 1. The extension must call `findRunningInstance` first and attach if one is running.

## Edge-Case & Dependency Audit

### Race Conditions

1. **Extension and standalone host starting concurrently:** if the extension spawns a host while a host is already running for the same workspace, the single-writer check exits 1. The extension must call `findRunningInstance` first and attach if one is running, spawning only when none is found. The sidebar must never show the single-writer refusal to a user.

### Security

2. **The sidebar talks HTTP to a loopback host:** the standalone host binds 127.0.0.1 by default. The sidebar's HTTP client must target loopback only — never a configurable hostname that could be redirected. The one-time token (`HeadlessSwitchboardInstance.oneTimeToken`) or durable token (`switchboard.apiToken`) must be used for authentication; an unauthenticated sidebar over HTTP is a local privilege escalation surface.

### Side Effects

3. **~4,000 installs — this is the largest migration this product has attempted.** Stage 2 changes where the database lives for every extension user. Ship Stage 1 and Stage 2 in separate releases so a regression has one cause.
4. **Which process owns the PTYs.** The fleet moves to the standalone host. Terminals a user expects to see in the editor now live elsewhere — decide what the sidebar shows and how a user reaches a live terminal, before stage 2 lands.

### Dependencies & Conflicts

5. **Stage 1 must land first.** Stage 1 (panels → browser) is reversible and low-risk; Stage 2 changes the data path. Shipping them apart means a regression has one cause.
6. **Stage 2b (vscodeShim removal) is a follow-on, not a prerequisite.** The standalone host continues using the shim until 2b lands. Stage 2 makes the extension a client; 2b makes the services vscode-free.
7. **This unblocks the Go work but must not wait for it.** `Go Where It Pays` and a possible sidecar both become simpler once there is one host; neither is a prerequisite here.

## Dependencies

- Stage 1 (panels leave the editor) — must land first. Same feature.

## Adversarial Synthesis

Key risks: the spawn/attach lifecycle determines whether the always-on goal is met (a naive spawn without `--detach` dies on window close, reproducing the problem); the single-writer race must be handled by attach-first; and the database ownership transfer is a breaking change for every extension user. Mitigations: specify `--detach` spawn with `findRunningInstance` attach-first; ship in a separate release from Stage 1.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** `TaskViewerProvider._startLocalApiServer()` (line 4102) constructs `new LocalApiServer({...})` at line 4610. Called from line 2435 during activation. The provider also owns the database (`KanbanDatabase.forWorkspace()`), the fleet, and the watcher.
- **Logic:** Replace `_startLocalApiServer()` with a `_ensureHostRunning()` method that:
  1. Calls `findRunningInstance(workspaceRoot)` to detect an already-running host.
  2. If a host is running, stores its port and token — attach, do not spawn.
  3. If no host is running, spawns `npx switchboard local --detach` (or the installed `switchboard` binary) with `detached: true` + `stdio: 'ignore'` so the host is reparented to init and survives window close.
  4. Waits for the host's health endpoint to respond before proceeding.
- **Implementation:** Delete `new LocalApiServer({...})` at line 4610. Delete `_stopLocalApiServer()` at line 5320 (the extension no longer owns the host's lifecycle). Replace database access with HTTP calls to the host's API.
- **Edge Cases:** If the host cannot be started (binary not found, port in use by non-switchboard process), show an explicit error — never an empty panel.

### `src/extension.ts`

- **Context:** The activation block constructs `TaskViewerProvider`, which starts the `LocalApiServer`. The `registerWebviewViewProvider` at line 1169 registers the sidebar.
- **Logic:** The activation block no longer starts a host. It calls `taskViewerProvider._ensureHostRunning()` which attaches or spawns. The sidebar's webview resolve handler fetches state from the host over HTTP instead of from in-process services.
- **Implementation:** Remove all `LocalApiServer`-related wiring. Remove the four `PlanIngestionEngine` queue seams (`setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`, `setQueueEscalationRecorder` at lines 1097-1128) — these are now wired in the standalone host only. Remove `setTurnEndNotifier` (line 1143) and `setHopSnapshotResolver` (line 1148) — same reason.
- **Edge Cases:** The sidebar must handle "no host running" gracefully — offer to start one, say so plainly when it cannot.

### `scripts/check-standalone-push-parity.js`

- **Context:** Currently checks browser read-back parity between the two hosts.
- **Logic:** Rewrite as an assertion that the extension holds no host state — specifically, that `new LocalApiServer(` is absent from `src/extension.ts` and `src/services/TaskViewerProvider.ts` when called from the extension composition root.
- **Edge Cases:** The assertion must fail if a `LocalApiServer` construction is reintroduced.

### `scripts/check-host-seam-parity.js`

- **Context:** Currently checks composition-root seam parity between the two hosts.
- **Logic:** Rewrite as an assertion that the extension wires no `PlanIngestionEngine` seams (no `setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`, `setQueueEscalationRecorder`, `setTurnEndNotifier`, `setHopSnapshotResolver`).
- **Edge Cases:** The assertion must fail if any engine seam is reintroduced in the extension.

## Verification Plan

### Automated Tests

> NOTE: Per the dispatching directive, compilation and automated tests are not executed in this
> review pass. The checks below remain written down for the implementer to run.

1. `npm run compile` — typecheck passes after Stage 2.
2. `npm test` — existing test suite passes (parity checkers are rewritten, not deleted).
3. `grep -n "new LocalApiServer" src/extension.ts src/services/TaskViewerProvider.ts` returns no matches (the extension does not construct a host).

### Goal Invariants

- Assert `new LocalApiServer(` is absent from `src/extension.ts` and from `src/services/TaskViewerProvider.ts` (extension composition root). Paired positive: assert `new LocalApiServer(` is present in `src/standalone/bootstrap.ts` (the one host).
- Assert `setQueueHeadResolver`, `setQueuePacingResolver`, `setQueueTeamMembersResolver`, `setQueueEscalationRecorder`, `setTurnEndNotifier`, `setHopSnapshotResolver` are absent from `src/extension.ts`. Paired positive: assert they are present in `src/standalone/bootstrap.ts`.
- Assert `findRunningInstance` (or equivalent port-probe logic) is called before spawning a host — the attach-first invariant.

### Manual Verification

1. The extension constructs no `LocalApiServer`, opens no database, and spawns no PTY — verified by reading `extension.ts`, not by the UI appearing to work.
2. With no host running, the sidebar offers to start one and says so plainly when it cannot.
3. With a host already running, the sidebar attaches rather than starting a second — the single-writer refusal is never shown to a user.
4. After spawning a host with `--detach`, closing the VS Code window does **not** kill the host — verified by checking the host's health endpoint after the window closes. This is the always-on invariant.
5. The parity checkers assert the absence of host state in the extension, and fail if `LocalApiServer` construction is reintroduced.

## Outstanding Questions

- **[user]** What does the sidebar show for terminal status, and how does a user reach a live terminal after the fleet moves to the host? Proceeding on the assumption that the sidebar shows fleet liveness over HTTP and terminal access is via `tmux attach` or the browser terminal page — but this design is Stage 3 work and must be resolved before Stage 2 lands.
