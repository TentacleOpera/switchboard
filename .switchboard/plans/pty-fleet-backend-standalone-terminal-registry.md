# Standalone PTY Fleet Backend: node-pty TerminalBackend and Registry Integration

## Goal

Give the standalone host (`npx switchboard`) the ability to spawn and manage real PTY-backed terminals server-side, so CLI agents (Claude Code etc.) can run under Switchboard with VS Code closed. This plan delivers the process layer and registry only — WebSocket I/O streaming, the browser xterm panel, and dispatch wiring are separate subtasks of this feature.

### Problem analysis / root cause

Standalone mode has no terminal capability at all: `vscode.window.createTerminal` in the shim **throws** ("dispatch verbs are not supported over npx (B3)", `src/standalone/vscodeShim.ts:131-133`), `getRegisteredTerminals` is hardwired to `[]` (`bootstrap.ts:1004`) so `POST /kanban/dispatch` always 409s at the pre-flight (`LocalApiServer.ts:1162-1168`), and `terminalDispatch: false` (`bootstrap.ts:385`) CSS-hides every dispatch affordance. The codebase already anticipated this exact feature: the `TerminalBackend`/`TerminalHandle` seam exists at `src/services/hostSeams.ts:198-232` with an in-code comment reserving the node-pty implementation as "B3" — but the seam is incomplete (no output stream, `resize()` is a no-op, `hostSeams.ts:258-265`) and no dispatch path consumes it yet.

Interactive CLI agents need a real PTY, not pipes: this codebase's standing rule is **never `claude -p`** (API-billed, loses claude.ai MCP connectors — `TaskViewerProvider.ts:22466`, `KanbanProvider.ts:5386`), and the interactive CLIs detect TTY-ness. `child_process` with pipes is not an option; node-pty is.

### Hard constraint — user directive 2026-07-31

**PTY terminals are standalone-only. VS Code mode continues to use VS Code terminals, unchanged.** Enforced three ways: (1) all PTY code lives under `src/standalone/` and is imported only by the standalone bundle; (2) the extension bundle (`dist/extension.js`) must contain zero node-pty references — guarded by a contract test; (3) no extension-host code path constructs the PTY backend.

## Metadata

**Complexity:** 7
**Tags:** backend, infrastructure, feature

## User Review Required

- The fixed ~750ms shell-readiness delay before startup-command injection is a v1 simplification with a known flake mode (slow login shells). Confirm the user accepts this over a prompt-detection heuristic.

(Dependency choice — previously flagged here — is now resolved by research; see `## Resolved Assumptions`.)

## Complexity Audit

### Routine
- Adding a runtime dependency and a webpack externals entry to the standalone config.
- Extending the `TerminalHandle` interface — the seam and its extension point already exist.
- Registry writes reuse the established `state.terminals` field set and `stateConfigBridge` key.
- Boot-reconcile purge is a simple filter on `purpose: 'pty'`.

### Complex / Risky
- Native module packaging for `npx` distribution across darwin/linux/win32 — research resolved the strategy (upstream node-pty, bundled prebuilds), but the darwin `spawn-helper` permission defect and exit-time SIGABRT race must be coded around.
- No shell-readiness event exists; startup-command injection timing is heuristic (fixed delay) and can silently drop or garble the agent launch command on slow shells.
- Shutdown semantics: draining/killing interactive agent processes without a timeout budget can orphan shells or corrupt an agent mid-write.
- Boot-purge must be sequenced before any reader of `state.terminals` routes work, or dispatch can target a ghost terminal.
- The import-location contract test alone cannot catch bundling via barrel-file re-exports; only the `dist/extension.js` purity grep does, and it must not be silently skipped.

## Edge-Case & Dependency Audit

**Race Conditions**
- Boot purge vs. early dispatch: a dispatch landing between server start and purge completion would target a dead terminal. The purge MUST run synchronously during bootstrap, before `LocalApiServer.start()` accepts requests.
- Startup-command injection vs. shell readiness: no readiness event exists; the fixed delay can race slow `.zshrc`/`.bashrc` sourcing. Mitigation: delay + trailing `\r`, documented flake mode, retry-safe (user can re-send).
- Concurrent `create()` with the same friendly name: fleet service must reject or disambiguate duplicate names before spawn.

**Security**
- A PTY fleet is RCE-grade: any verb reaching it must ride the existing standalone session auth; the verb arms hard-fail when the fleet service is absent (extension host).
- Startup commands come from the machine-global integration config — same trust level as the extension's existing startup-command path; no new trust boundary.
- node-pty spawns login shells inheriting the server environment — no env scrubbing beyond what the role config specifies.

**Side Effects**
- Registry entries with `purpose:'pty'` / `ideName:'standalone-pty'` are visible to `/health` and worktree routing in BOTH hosts; the `ideName` partition (`extension.ts:548-556`, `isCompatibleIdeName`) prevents adoption, but the coder must audit name-keyed cleanup sweeps for missing owner checks (see step 3).
- SIGTERM-then-kill on shutdown affects real user agent processes; a mid-write agent needs a bounded grace period.

**Dependencies & Conflicts**
- Depends on `GlobalIntegrationConfigService` (`~/.switchboard/integration-config.json`) — already host-agnostic.
- Sibling subtasks consume this plan's outputs: the WS channel needs the extended `TerminalHandle` (`onData`/`write`/`resize`) and the fleet change hook; dispatch needs the fleet + lazy-spawn; the panel needs the `terminalFleet` capability.
- Runtime conflict with the extension is impossible: `cli.ts:116-121` exits when another instance's API server is alive (single-writer rule).

## Dependencies

- None recorded (no prior research sessions).

## Adversarial Synthesis

Key risks: the fixed 750ms shell-readiness delay can silently drop startup commands on slow shells; shutdown without a timeout budget can orphan or corrupt agent processes; the import-grep contract test misses barrel-file bundling paths. Mitigations: document the flake mode and keep the delay retry-safe, specify a SIGTERM → grace → SIGKILL budget, and make the `dist/extension.js` purity grep mandatory in the release path.

## Non-Goals

- No PTY in the VS Code extension host, ever (see above).
- No per-platform VSIX builds — the VSIX is unaffected because the extension bundle never imports node-pty and the VSIX ships no node_modules.
- No terminal I/O streaming to the browser (next subtask: WebSocket channel).
- No dispatch verb implementation (separate subtask).

## Implementation Steps

### 1. Dependency and packaging

> **Superseded:** "Add `@homebridge/node-pty-prebuilt-multiarch` as a runtime `dependency` (decided over upstream `node-pty`: ships prebuilt binaries for darwin/linux/win32 across node ABIs, so `npx switchboard` users don't need node-gyp/build tools)."
> **Reason:** Web research (2026-07-31) reversed the decision. The homebridge fork downloads its binaries at install time via `prebuild-install` in a `postinstall` hook (`prebuild-install || node-gyp rebuild`) — this fails under `--ignore-scripts`, pnpm/Yarn Berry/Bun script suppression, offline/air-gapped machines, and proxies blocking GitHub Releases, and its `node-gyp` fallback requires build tools we promised users they wouldn't need. Upstream `node-pty` v1.1.x migrated to N-API (ABI-stable across Node 20/22+ LTS) and bundles prebuilt binaries **inside the npm tarball** (`prebuilds/<platform>-<arch>/pty.node`) — zero network, zero scripts at install time, maintained by the VS Code team.
> **Replaced with:** Add upstream **`node-pty`** (v1.1.x, or v1.2.x if Linux prebuilds are required — see caveat below) as a runtime `dependency`, pinned to a published version ≥ 7 days old. Add typings as needed. (Confirmed: no node-pty variant is currently in `package.json`.)
>
> **Caveats from research, must be handled in implementation:**
> 1. **macOS `spawn-helper` permission defect:** node-pty v1.1.0's npm tarball packs the darwin `spawn-helper` binary mode `644` (no execute bit); spawning fails with `posix_spawnp failed` after `npx`/pnpm/bun extraction. `PtyTerminalBackend` must run a zero-dependency repair at construction (before first `spawn`): on darwin, `fs.chmodSync(<resolved node-pty>/prebuilds/darwin-<arch>/spawn-helper, 0o755)`, best-effort with a warn on failure.
> 2. **Linux prebuild coverage:** upstream v1.1.0 bundles darwin-arm64/x64 + win32-x64/arm64; Linux (glibc/musl) prebuilds stabilized in v1.2.0-beta line. The coder must confirm the pinned version ships `linux-x64` (glibc, and musl if Alpine support is claimed) prebuilds; if the chosen pinned version lacks them, either pin the v1.2.x line or document linux as build-from-source-required — do NOT silently ship an npx package that compiles on install.
> 3. **Exit-time SIGABRT race (upstream issue #904):** failing to explicitly `.kill()`/dispose all live `IPty` instances before Node process exit can crash in `Napi::ThreadSafeFunction` cleanup. This hardens the shutdown step below from "graceful" to **mandatory-dispose-before-exit**.

- `webpack.config.js`: add the module to `externals` in **`standaloneConfig` only**.

> **Superseded:** "`webpack.config.js`: add the module to `externals` in **`standaloneConfig` only** (`webpack.config.js:100-140`)."
> **Reason:** Line range drifted and, more importantly, `standaloneConfig` (lines 107-144) has **no externals section today** — it uses `resolve.alias` to map `vscode` to the shim (lines 125-126). "Add to externals" implied extending a section that does not exist.
> **Replaced with:** Create a new `externals` key on `standaloneConfig` (`webpack.config.js:107-144`): `externals: { 'node-pty': 'commonjs node-pty' }`. The main extension config's externals stay `{ vscode }` (lines 24-26) — if the extension bundle ever pulls it in, the build should fail loudly rather than bundle a `.node` binary.

- Import rule: only `src/standalone/**` may import node-pty. Add a contract test that (a) greps `src/` for the import and asserts all sites are under `src/standalone/`, and (b) asserts `dist/extension.js` contains no `node-pty` string after a compile (skippable when dist is stale — dist is not the dev source of truth, but the check must run in the VSIX release path). **Known gap:** (a) alone cannot catch bundling via barrel-file re-exports that never name `node-pty` in source; only (b) does — so (b) is the load-bearing check and must be mandatory in the release path, never waived for a stale dist without a loud warning.

### 2. Extend the TerminalBackend seam (`src/services/hostSeams.ts`)

- Extend `TerminalHandle` (`hostSeams.ts:198-206`) with: `write(data: string): void`, `onData(cb: (chunk: string) => void): Disposable`, `onExit(cb: (code: number | undefined) => void): Disposable`, `resize(cols: number, rows: number): void`, `kill(): void`.
- `VscodeTerminalBackend` (`hostSeams.ts:225-232`) implements the new members as no-ops / undefined-safe stubs (VS Code's stable API offers no terminal output stream — that is precisely why extension mode keeps native VS Code terminals and why mirroring them to a browser is out of scope).
- New `PtyTerminalBackend` in `src/standalone/ptyBackend.ts`: `create({ name, cwd, env, cols, rows, shell })` spawns via node-pty (login shell from `$SHELL`/platform default), returns the extended handle.

### 3. PtyFleetService (`src/standalone/ptyFleetService.ts`)

Owns the living set of PTY terminals:

- `create(role, friendlyName, cwd?)` → spawns PTY, injects the role's startup command, registers metadata; `list()`, `get(name)`, `kill(name)`, `rename(name, alias)`. Reject or disambiguate duplicate friendly names before spawn.
- **Change-notification hook:** expose `onDidChange(cb)` (create/close/rename events) on the fleet service. The WebSocket subtask subscribes to this to emit its `terminalsChanged` hub broadcast — the fleet service is the single owner of fleet lifecycle events; do not let the gateway poll or infer changes.
- **Startup commands** come from the machine-global `~/.switchboard/integration-config.json` via `GlobalIntegrationConfigService` (plain-fs service, host-agnostic), mirroring `getStartupCommands` semantics (`TaskViewerProvider.ts:5095-5138`).

> **Superseded:** "...mirroring `getStartupCommands` semantics (`TaskViewerProvider.ts:5095-5138`) including the hardcoded `'claude'` fallbacks."
> **Reason:** Code inspection found no hardcoded `'claude'` fallbacks in that range — the fallback chain is `GlobalIntegrationConfigService` → `globalState` → state file.
> **Replaced with:** Mirror the actual fallback chain exactly: `GlobalIntegrationConfigService` → `globalState` → state file (`TaskViewerProvider.ts:5095-5138`), resolving the role's agent binary from config.

- Inject after a short shell-readiness delay (no `onDidStartTerminalShellExecution` equivalent exists; a fixed ~750ms delay + trailing `\r` is acceptable v1 — PTYs don't have the VS Code race the event solved). **Known flake mode:** on slow login shells (heavy `.zshrc`), the command can arrive before the prompt and be garbled or dropped; the delay is a heuristic, not a guarantee. v1 accepts this; recovery is manual re-dispatch, and the delay value should be a named constant so it can be tuned without a code hunt.
- **Registry integration:** persist per-terminal metadata into the same `state.terminals` map (`runtime.terminals` config key via `src/services/stateConfigBridge.ts:38`) with the established field set (`purpose`, `role`, `pid`, `startTime`, `status`, `friendlyName`, `worktreePath`, `ideName`) so `/health`, the board, and worktree routing all see them. Use `purpose: 'pty'` and `ideName: 'standalone-pty'` — the existing `ideName` partition (`extension.ts:548-556`, `isCompatibleIdeName`) keeps the extension from adopting them. **Coder must verify** the extension's cleanup paths (`handleTerminalClosed` at `TaskViewerProvider.ts:17917-17960` and any stale-entry sweeps) never prune entries with a foreign `ideName`; if any sweep is name-keyed without an owner check, add the owner check there. (Verified: `handleTerminalClosed` prunes by name only after confirming no live terminal with that name exists — `TaskViewerProvider.ts:17935-17940` — but any OTHER sweep must get the same audit.)
- **Boot reconcile:** on standalone start, purge `state.terminals` entries with `purpose: 'pty'` (they are dead — PTYs do not survive the server process). **Sequencing requirement:** the purge MUST complete synchronously inside bootstrap, before `LocalApiServer.start()` begins accepting requests — otherwise a dispatch landing in the gap routes to a ghost terminal. Runtime conflict with the extension is already impossible: `cli.ts:116-121` exits when the extension's API server is alive (single-writer rule).
- Graceful shutdown: SIGTERM to children, then kill, on standalone process exit. Specify the budget: SIGTERM → bounded grace period (e.g. 3s, named constant) → SIGKILL; reap via node-pty `kill()` and confirm no orphaned shells remain. **Mandatory dispose-before-exit (research-hardened):** upstream node-pty has an N-API teardown race (issue #904) — exiting the Node process with live `IPty` instances can SIGABRT in `ThreadSafeFunction` cleanup. Register `SIGINT`/`SIGTERM`/`exit` handlers in bootstrap that explicitly `.kill()` + dispose every live fleet handle BEFORE the process exits; this is a crash-prevention requirement, not politeness.

### 4. Wire into bootstrap + HTTP surface

- `bootstrap.ts:1004`: `getRegisteredTerminals` returns the live fleet (name, role, status) — this makes `/health` report real terminals and clears the `/kanban/dispatch` 409 pre-flight for the later dispatch subtask.
- New standalone-only verbs on the existing verb rail: `ptyCreateTerminal { role, name?, cwd? }`, `ptyCloseTerminal { name }`, `ptyListTerminals`, `ptyRenameTerminal { name, alias }`. Register them the same way existing standalone verbs are added (the generated allowlist in `src/generated/verbAllowlist.ts` is produced by `scripts/generate-verb-allowlist.js` from `protocol-catalog.json` — add the verbs to the catalog and regenerate; don't hand-edit generated output). These verbs must hard-fail (`success:false`) if invoked when the fleet service is absent — i.e. in the extension host — as defense in depth on top of the wiring never existing there.
- Capability flags: leave `terminalDispatch: false` for now (flips in the dispatch subtask). Flip `terminalFleet: true` in standalone's capabilities (`bootstrap.ts:388` — the flag exists in `HostCapabilities` (`src/services/headlessPanelHtml.ts:16-35`) and is currently `false`/dead). **Ownership note (reconciled across subtasks):** this subtask is the ONLY owner of the `terminalFleet` capability flip — the Terminals panel subtask sets `availability.terminals` only and must not duplicate this.

## Proposed Changes

### `package.json`
- **Context:** No node-pty variant is currently a dependency.
- **Logic:** Add upstream `node-pty` (v1.1.x / v1.2.x) as a runtime dependency (pin a published version ≥ 7 days old). Research resolved the fork-vs-upstream decision in upstream's favor (bundled prebuilds, N-API ABI stability).
- **Edge cases:** Pinned version must bundle prebuilds for every claimed platform in its npm tarball — verify `linux-x64` (glibc/musl) coverage on the exact pinned version before committing to Linux support.

### `webpack.config.js` (standaloneConfig, lines 107-144)
- **Context:** `standaloneConfig` currently has no `externals` section; it uses `resolve.alias` for the `vscode` shim.
- **Logic:** Add `externals: { '@homebridge/node-pty-prebuilt-multiarch': 'commonjs @homebridge/node-pty-prebuilt-multiarch' }` so the `.node` binary is required at runtime, never bundled. Main extension config untouched.
- **Edge cases:** If any extension-bundle code path transitively imports the module, the build must fail loudly — do not add the module to the main config's externals as an "escape hatch."

### `src/services/hostSeams.ts` (TerminalHandle :198-206, VscodeTerminalBackend :225-232)
- **Context:** Seam exists but is output-blind (no stream, resize no-op at :258-265).
- **Logic:** Extend `TerminalHandle` with `write`/`onData`/`onExit`/`resize`/`kill`; stub them safely in `VscodeTerminalBackend`.
- **Edge cases:** Extension-host callers of the existing handle must not break — new members are additive; stubs are no-ops returning safe values.

### `src/standalone/ptyBackend.ts` (new)
- **Context:** The "B3" reservation at `hostSeams.ts:196` names this implementation.
- **Logic:** `PtyTerminalBackend.create()` spawns via node-pty with login shell from `$SHELL`/platform default; wires `onData`/`onExit`/`resize`/`kill` to the IPty.
- **Edge cases:** Spawn failure (missing prebuilt binary) must surface as a clean verb error, not an unhandled exception killing the server.

### `src/standalone/ptyFleetService.ts` (new)
- **Context:** Needs to own the living fleet set, registry metadata, startup-command injection, change events, and shutdown.
- **Logic:** Per Implementation Steps §3 — CRUD + `onDidChange` + registry persistence + boot purge + shutdown budget.
- **Edge cases:** Duplicate names, slow-shell injection flake, boot-purge-before-accept sequencing, SIGTERM grace then SIGKILL.

### `src/standalone/bootstrap.ts` (:1004, :388)
- **Context:** `getRegisteredTerminals` hardwired `[]`; `terminalFleet: false` already present at :388.
- **Logic:** Return the live fleet; flip `terminalFleet: true`; run boot purge before `LocalApiServer.start()`; construct fleet service only in standalone.
- **Edge cases:** Fleet service absent (extension host) → verb arms hard-fail `success:false`.

### `protocol-catalog.json` + `src/generated/verbAllowlist.ts` (generated)
- **Context:** Allowlist is generated by `scripts/generate-verb-allowlist.js`.
- **Logic:** Add the four `pty*` verbs to the catalog; regenerate.
- **Edge cases:** Never hand-edit the generated file.

## Resolved Assumptions

Resolved by web research (2026-07-31) — authoritative, do not re-open:

1. **Dependency choice → upstream `node-pty` v1.1.x/v1.2.x.** N-API bindings (ABI-stable across Node 20/22+ LTS); prebuilt binaries bundled inside the npm tarball (no install-time network, immune to `--ignore-scripts`/offline/proxy failures that break the homebridge fork's `prebuild-install` postinstall model). Maintained by the VS Code team.
2. **macOS `spawn-helper` defect:** v1.1.0 tarballs pack darwin's `spawn-helper` mode `644`; runtime `chmod 0o755` repair required before first spawn (coded into step 1).
3. **Linux prebuilds:** bundled in the v1.2.0-beta line, not v1.1.0 — pin accordingly (caveat in step 1).
4. **`IPty.pause()`/`resume()` exist and buffer, never drop.** Pausing suspends master-fd reads; child output accumulates in the OS kernel PTY/pipe buffer (~64 KB) and the child blocks on write when it fills — exactly the flow control the WS subtask's backpressure design needs. Cautions: don't call `pause()` before the first data cycle (early-pause race can swallow chunks); explicitly `.kill()`/dispose all instances before process exit (SIGABRT teardown race, issue #904).

## Verification Plan

Per session directives (SKIP COMPILATION / SKIP TESTS), this verification plan does **not** include running any project compilation step or automated test suite. Verification is manual UAT plus code-review checkpoints. (The contract-test ideas named in the implementation steps — import-location grep, bundle-purity grep, fleet lifecycle, startup-command resolution, extension-host defense — are recorded as requirements for the automated suite, to be written and run outside this session's scope.)

- **Code-review checkpoints:**
  - Only `src/standalone/**` imports node-pty; `standaloneConfig` externals entry present; main extension config untouched.
  - `VscodeTerminalBackend` stubs are additive and no-op safe.
  - Boot purge runs synchronously before `LocalApiServer.start()`; shutdown implements SIGTERM → grace → SIGKILL with named constants.
  - Verb registrations come from the catalog + generator, not hand-edited generated output.
- **Manual UAT (darwin):** `npx switchboard` in a test workspace → `curl POST /kanban/verb/ptyCreateTerminal {"role":"coder"}` with session cookie → `/health` lists the terminal with a real PID → `ps` shows the shell + claude process → `ptyCloseTerminal` reaps both. Restart the server with a stale `purpose:'pty'` entry seeded → entry is gone before the server accepts requests. In VS Code mode: extension boots unchanged, no fleet wiring exists, `pty*` verbs (if ever invoked) return `success:false`.
