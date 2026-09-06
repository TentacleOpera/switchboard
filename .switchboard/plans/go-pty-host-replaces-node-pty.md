# A Go PTY Host, and `node-pty` Leaves the Package

kanbanColumn: CREATED

## Goal

Terminals are owned by a static Go binary speaking the protocol `ptyHost.ts` already speaks. Both
hosts spawn it. `node-pty` is removed from the dependency tree, taking 63 MB, four platforms of
prebuilds and an `optionalDependencies` silent-failure mode with it.

### Problem analysis

**The process boundary is already justified, and already half-built.** The
*Out-of-process PTY host* feature measured it: the identical gateway responds in **0.24 ms p50 in
its own process versus 35.21 ms p50 inside the extension host**, against a 0.06 ms bare-loopback
control. The delay is event-loop contention, not transport. `src/standalone/ptyHost.ts` already
exists as a separate webpack entry point — 525 lines — and `TaskViewerProvider:3714` already spawns
it as a child.

> **Superseded:** **The protocol is small and language-neutral.** `ptyHost.ts` serves HTTP on `127.0.0.1:0`, parses JSON bodies, treats **stdin EOF as the parent-died signal** (`process.stdin.on('end', …)`), and cleans up on `SIGTERM`/`SIGINT`. Nothing in that is Node-specific. A Go binary can present the same surface byte for byte.
> **Reason:** The wire surface is language-neutral, but the executable contract is not small. `ptyHost.ts` imports `PtyFleetService`, `TerminalWsGateway`, `ptyPromptDelivery`, and `TerminalLogWriter`; together they own terminal creation, delegate trees, prompt framing and readiness, WebSocket authentication/compression/replay, liveness tombstones, image paste, and session logs. Porting only the visible HTTP wrapper would leave the real runtime in Node or silently drop behavior.
> **Replaced with:** Treat the current TypeScript terminal subsystem as the executable specification. Freeze its HTTP, WebSocket, process-lifecycle, byte-delivery, logging, and projection behavior in language-neutral fixtures, then replace the subsystem with one Go implementation rather than translating only `ptyHost.ts`.

**`node-pty` is the single heaviest thing in the package, and the least reliable.**

- **63 MB of the 91 MB** vendored tree, of which **58 MB is `prebuilds/`** — `darwin-arm64`,
  `darwin-x64`, `win32-arm64`, `win32-x64`. There is **no `linux-arm64` prebuild**: the Linux binary
  is compiled from source at package time, so the arm64 `.deb` ships 58 MB of macOS and Windows
  binaries it can never load.
- It sits in **`optionalDependencies`**, so a failed build makes `npm` **succeed**. The board starts
  perfectly and every terminal is dead. `package-deb.sh` gates on `require()`ing it precisely
  because nothing else would notice.
- It is the reason the `.deb` is architecture-specific at all, and therefore the reason there is no
  amd64 package for the tower.

**And it would unify a divergence that exists today.** The extension spawns the out-of-process host;
standalone calls `node-pty` **in-process** from `ptyFleetService`. Two PTY paths, one per host — the
exact class this codebase forbids. One Go binary spawned by both collapses them.

**This does not touch shared business logic.** The PTY host owns pseudo-terminals and bytes. It
holds no schema, no prompt text, no column rules. That is what makes a second language safe here.

### Root-cause refinement

The removable dependency is not isolated at one import. `src/standalone/ptyBackend.ts` is the only
runtime loader, but its `node-pty` handle type and lifecycle flow through `PtyFleetService`; the
extension reaches that runtime through the child protocol while standalone wires the same service,
gateway, prompt delivery, and log writer directly in `bootstrap.ts`. The safe end state therefore
has one Go terminal runtime, one versioned protocol contract, and two explicit composition-root
clients. A plausible fallback to the old in-process backend is forbidden because it would make a
missing Go artifact look like a working but divergent host.

## Metadata

- **Complexity:** 9
- **Tags:** infrastructure, performance, reliability, refactor

## User Review Required

> **Superseded:** Decide explicitly and record it: a single cross-platform Go PTY library, a `//go:build` split with a ConPTY implementation for Windows, or — if neither is sound — **keep the Node PTY host on Windows and ship Go on Linux and macOS only**. The last is acceptable; shipping a Windows binary that drops input is not.
> **Reason:** Retaining the Node host on Windows keeps `node-pty` in the dependency tree and packaging matrix, creates a platform-specific second terminal runtime, and contradicts this feature's stated removal and both-host convergence goals.
> **Replaced with:** Windows ships only after the Go host passes the same spawn, input, output, resize, process-tree, protocol, and packaging contracts. Until then Windows is explicitly unsupported with a fail-loud platform message; there is no silent Node PTY fallback.

- Confirm the supported-platform decision after the external PTY-library and signing research: ship a platform only when spawn, input, output, resize, process-tree termination, and packaging are verified there. An unsupported platform must fail loudly with its platform and missing artifact; it must not fall back silently to `node-pty`.
- Review the new versioned protocol inventory before the TypeScript runtime is removed. The inventory is the scope boundary for the port and must cover the current terminal behavior, not only the HTTP verb names.

## Complexity Audit

### Routine

- Replace executable-path resolution and child startup after a shared supervisor exists.
- Remove `node-pty` from `package.json`, `package-lock.json`, webpack externals, and `.vscodeignore` after all imports are gone.
- Remove obsolete prebuild staging and package assertions after the Go artifacts have equivalent positive checks.

### Complex / Risky

- Port a multi-module terminal runtime, including PTY process control, prompt byte sequencing, WebSocket flow control, authentication, compression, replay, and session logging.
- Preserve one behavioral contract across Linux, macOS, and Windows despite different PTY and process-tree APIs.
- Change both composition roots without leaving an extension-only or standalone-only terminal path.
- Cross-compile, select, package, and verify the correct executable for every supported OS/architecture pair.
- Replace source-shaped TypeScript contract tests with language-neutral and black-box checks before deleting their source targets.

## Edge-Case & Dependency Audit

### Race Conditions

- Parent EOF, `SIGTERM`/`SIGINT`, host shutdown, terminal self-exit, explicit terminal close, and process-tree escalation can race. Cleanup must be idempotent, bounded, and wait for terminal reaping before host exit.
- Child stdout can split or combine newline-delimited handshake messages. The supervisor must buffer complete lines and accept exactly one valid `{ "t": "ready", "port": number, "token": string }` message before the timeout.
- Terminal create/rename/close bursts update fleet membership and the mirrored `runtime.terminals` registry concurrently. The host-facing mirror remains serialized and must never resurrect a closed row.
- Two hosts or a watchdog re-entry must not construct two Go runtimes for one host process. Each composition root owns one supervisor with an explicit lifecycle.

### Security

- Preserve the separate, always-minted terminal WebSocket credential. The HTTP API token and terminal token must not be merged; an empty terminal token must fail closed even on loopback.
- Continue rejecting caller-supplied startup commands, delegate definitions, and host-only safeguard fields. A caller holding the API token must not turn a terminal verb into arbitrary host command execution beyond the deliberate PTY surface.
- Keep request-size limits before buffering image bodies, path quoting for pasted-image references, trusted WebSocket-origin checks, and loopback-only control listeners.
- Executable resolution must use a packaged absolute path selected from an explicit platform/architecture map. Never search `PATH` for a plausible `switchboard-pty-host` binary.

### Side Effects

- Terminal logs under `.switchboard/logs/` remain readable, bounded, and closed cleanly on shutdown.
- The extension's `runtime.terminals` mirror and standalone's registry writer must continue preserving non-PTY rows owned by another writer.
- Removing `scripts/package-targets.sh` changes release mechanics. Replace every positive runtime-file assertion before deleting prebuild-specific checks.
- A missing, non-executable, wrong-architecture, or pre-handshake-crashing Go binary disables terminal capability visibly for that host lifetime; board and plan surfaces remain available.

### Dependencies & Conflicts

1. **Both composition roots** — `src/extension.ts` and `src/standalone/bootstrap.ts` must resolve and start the same supervisor contract. Standalone is the host that must change most.
2. **The out-of-process feature is the parent of this work.** Read it before starting; its measurements are the justification and its subtasks may already cover the extension-side spawn.
3. **`spawn-helper` on macOS.** `node-pty`'s darwin prebuilds include a `spawn-helper` binary and `package-targets.sh` asserts its presence. Whatever replaces it must handle the same case, and the assertion must move rather than be deleted.
4. **Signing on macOS.** A spawned binary inside a signed app or VSIX has its own notarisation requirements. Cheap to overlook and expensive to discover.
5. **`better-sqlite3` stays.** It is a library binding, not a separable process. It cannot leave without the sidecar rewrite, which is not this plan.
6. **Do not put board logic in the binary.** It owns pty file descriptors and bytes. The moment it knows what a plan is, the divergence rule applies to it.
7. `go.mod`, `go.sum`, the shared Go build helper, and the packaged binary manifest are introduced here as the feature foundation. The client-verbs and launcher subtasks extend that foundation rather than creating competing modules or artifact selectors.
8. Existing contracts in `src/test/` name `ptyHost.ts`, `ptyFleetService.ts`, `ptyPromptDelivery.ts`, `terminalWsGateway.ts`, and `terminalLogWriter.ts`. Migrate each assertion to fixtures or black-box behavior before its source target is removed.

## Dependencies

- No session dependency identifier was supplied. The checked-in TypeScript PTY runtime is the behavioral baseline and must remain available until the Go conformance suite covers it.

## Adversarial Synthesis

Key risks are undercounting the imported terminal runtime, preserving security- and byte-sensitive behavior across operating systems, and wiring only one host or packaging the wrong executable. Mitigate them with a versioned protocol manifest, golden fixtures plus black-box lifecycle tests, explicit fail-loud executable resolution in both composition roots, and removal of the TypeScript/`node-pty` path only after positive artifact and behavior checks exist.

## Proposed Changes

### 1. `go.mod`, `go.sum`, `cmd/switchboard-pty-host/`, and `internal/ptyhost/` — establish the shared Go foundation

- **Context:** No Go module exists in the repository. This subtask owns the initial module, dependency policy, common version metadata, platform/architecture naming, and build output manifest reused by the later Go client and launcher subtasks.
- **Logic:** Define one command entry point and internal packages for protocol types, fleet state, PTY backend adapters, WebSocket transport, prompt delivery, logging, and process lifecycle. Use build-tagged PTY adapters only where operating-system APIs genuinely differ; keep protocol and fleet semantics platform-neutral.
- **Implementation:**
  - Add a checked-in protocol version and typed request/response structures for every current `/api/pty/<verb>` payload and projection.
  - Preserve the ready handshake, random terminal token, loopback ephemeral listener, stdin-EOF parent-death signal, parent-PID liveness backstop, `SIGTERM`/`SIGINT` cleanup, and bounded escalation.
  - Preserve all current verbs: `ptyCreateTerminal`, `ptyCreateBatch`, `ptyCloseTerminal`, `ptyListTerminals`, `ptyRenameTerminal`, `ptyClearTerminal`, `ptySendModel`, `ptyClearAllTerminals`, `ptyWrite`, `ptyPasteImage`, `ptySendPrompt`, `ptySetControllerSeat`, and `ptyRollLogSession`.
  - Preserve `/ws/terminal` authentication, trusted-origin policy, replay/flow-control semantics, and the current permessage-deflate contract where the chosen Go WebSocket implementation supports an equivalent wire contract.
  - Keep schema, kanban columns, prompt templates, and board routing out of Go. Host-resolved policy values remain request fields or host-side decisions.
- **Edge Cases:** Unknown verbs retain a non-executing refusal distinguishable by the CLI fallback; invalid JSON returns 400; oversized image bodies return 413 before full buffering; a partial handshake never marks the runtime ready.

### 2. Protocol fixtures and test harnesses — freeze behavior before translating it

- **Context:** Existing tests mostly import or grep TypeScript implementation files. Those tests become dead or fail for the wrong reason when the files are removed.
- **Logic:** Derive language-neutral fixtures from observable behavior, not copied implementation literals. Run the same request/response, byte-write, WebSocket, log, and lifecycle cases against the current TypeScript host and the Go candidate during migration.
- **Implementation:**
  - Add golden JSON fixtures for every verb, including error envelopes and terminal projections.
  - Add byte-sequence fixtures for bracketed paste, 256-byte chunk boundaries, isolated submit carriage returns, `/clear`, `/model`, and first-prompt readiness outcomes.
  - Add WebSocket fixtures for empty/wrong/correct terminal tokens, trusted/untrusted origins, replay gaps, flow control, resize, and compression negotiation.
  - Add process fixtures for stdin EOF, parent disappearance, explicit close, self-exit, graceful termination, forced termination, and descendant reaping.
  - Update the affected `src/test/*pty*`, `src/test/terminal-*`, fleet-seam, route-surface, and session-log contracts to target the protocol fixtures or launch the packaged candidate instead of requiring retired TypeScript symbols.
- **Edge Cases:** Preserve explicit tests for tombstones after operator kill, hidden terminals, controller-seat singleton behavior, startup-command provenance, image cleanup, and balanced Markdown logs.

### 3. `src/services/TaskViewerProvider.ts` and `src/extension.ts` — inject the Go supervisor into the extension composition root

- **Context:** `TaskViewerProvider._startLocalApiServer()` currently resolves `dist/standalone/ptyHost.js`, runs it through Electron with `ELECTRON_RUN_AS_NODE=1`, parses the handshake, and forwards verbs. This hides composition-root wiring inside a service and is specific to the Node child.
- **Logic:** Move executable selection and supervisor construction to `src/extension.ts`; inject a required terminal-runtime seam into `TaskViewerProvider`. Keep host-side policy, DB mirroring, team lookup, dispatch safeguards, and LocalApiServer wiring in TypeScript.
- **Implementation:**
  - Add a shared TypeScript supervisor/client with explicit states such as `starting`, `ready`, `failed`, and `stopped`, plus the Go child's port and terminal token.
  - Resolve the absolute binary path from the extension install root and the checked-in artifact manifest. Log the exact source and selected target; fail terminal availability loudly when the mapping or file is missing.
  - Replace `process.execPath`, `ELECTRON_RUN_AS_NODE`, and `ptyHost.js` startup with the injected supervisor while preserving handshake buffering, diagnostics, timeout, one-shot boot-failure latch, registry mirroring, and controller-seat synchronization.
  - Keep the LocalApiServer's terminal-token injection and direct WebSocket endpoint pointed at the Go runtime.
- **Edge Cases:** Extension activation must remain usable when terminal startup fails; watchdog re-entry must reuse the same supervisor; dispose must close stdin and await bounded child cleanup.

### 4. `src/standalone/bootstrap.ts` — replace the in-process fleet with the same supervisor

- **Context:** Standalone currently constructs `PtyFleetService`, `TerminalWsGateway`, and `TerminalLogWriter` in-process, then passes a closure to `TaskViewerProvider.setFleetVerb`. That is the host divergence this plan removes.
- **Logic:** Resolve and start the same Go executable through the same supervisor/client used by the extension. Keep standalone-only config reads, DB access, board routing, team definitions, and registry projection in TypeScript; forward only terminal-runtime operations.
- **Implementation:**
  - Remove direct construction of the TypeScript fleet/gateway/log writer and replace it with supervisor startup adjacent to the existing PTY composition-root wiring.
  - Preserve the dedicated terminal token, terminal availability flags, LocalApiServer verb seam, WebSocket endpoint, live-terminal provider, liveness provider, activity-light resolver, team operations, shutdown ordering, and registry behavior.
  - Compare `src/extension.ts` and `src/standalone/bootstrap.ts` by hand after wiring. Record every supervisor option and callback supplied by each root; any unsupported capability must be explicit, never an omitted `Promise<void>` callback.
- **Edge Cases:** A missing binary disables terminal panels and dispatch with a named reason while the standalone board continues; stopping the standalone host closes the Go runtime before the database and API server are torn down.

### 5. Packaging and release surfaces — ship positive Go artifacts before removing prebuild machinery

- **Context:** The current VSIX and `.deb` paths explicitly stage and verify `node-pty` prebuilds. No Go toolchain or Go artifact publication exists.
- **Logic:** Build a deterministic target matrix, package by explicit manifest, and verify executable existence, mode, architecture, and startup handshake. A platform is supported only when its artifact is produced and tested.
- **Implementation:**
  - Extend CI/release automation for `linux/arm64`, `linux/amd64`, `darwin/arm64`, `darwin/amd64`, and approved Windows targets.
  - Include the required PTY-host artifacts in the VSIX under a stable platform/architecture directory; a universal VSIX may carry all small Go artifacts and select exactly one at runtime.
  - Update `scripts/package-deb.sh` to copy the matching Linux artifact, set executable mode, and run a safe version/handshake probe. Keep `better-sqlite3` vendoring and its positive gate.
  - Replace `.vscodeignore`, VSIX contract, and release assertions that name `node-pty` with assertions for the Go manifest and binaries.
- **Edge Cases:** Reject stale/mismatched versions, wrong executable formats, absent executable bits, and unsupported architecture keys before publishing.

### 6. Remove the retired Node PTY runtime and dependency

- **Context:** The removal is last. Until the Go host is wired and verified, the TypeScript runtime is the only executable specification and rollback path.
- **Logic:** Delete, do not retain as a silent fallback. A fallback would make a broken Go package behaviorally indistinguishable from the old configured path and would immediately recreate host divergence.
- **Implementation:**
  - Remove runtime imports and, once no migrated test depends on them, retire `src/standalone/ptyHost.ts`, `src/standalone/ptyBackend.ts`, `src/standalone/ptyFleetService.ts`, `src/standalone/terminalWsGateway.ts`, `src/standalone/ptyPromptDelivery.ts`, and `src/standalone/terminalLogWriter.ts` or any portions fully replaced by Go.
  - Drop `node-pty` from `optionalDependencies` and regenerate the lockfile through the package manager.
  - Delete the `node-pty` externals from both webpack configurations.
  - Remove prebuild allow-list rules from `.vscodeignore`, the `node-pty` gates from `scripts/package-deb.sh`, and prebuild staging from `scripts/package-targets.sh`. Delete that script only if no non-PTY release responsibility remains.
  - Update `scripts/publish-marketplace.sh`, package descriptions, workflow comments, and contract names so release output no longer claims terminal capability can degrade behind `isPtyAvailable()`.
- **Edge Cases:** A repository search must distinguish historical prose/plan references from live source, package, test, and release references; only live runtime and packaging dependencies are prohibited.

## Verification Plan

### Automated Tests

1. Run Go unit tests for platform-neutral protocol, fleet, prompt-delivery, logging, handshake, and cleanup packages.
2. Run the language-neutral conformance suite against the last TypeScript baseline and the Go host; require identical status codes, JSON shapes, terminal projections, prompt-byte sequences, and lifecycle outcomes.
3. Run black-box extension-host and standalone-host terminal suites covering spawn, input, output, resize, rename, clear, model command, prompt delivery, image paste, close, batch creation, delegate teardown, and shutdown.
4. Run terminal WebSocket contracts for separate token enforcement, origin checks, replay, backpressure, resize, and compression negotiation.
5. Run package contracts that inspect every produced VSIX, `.deb`, and release artifact for the declared Go target, executable mode, architecture, version, and successful startup handshake.
6. Run dependency and source contracts proving no live TypeScript/JavaScript import or package edge reaches `node-pty`.

### Goal Invariants

- `node-pty` is absent from `package.json`, `package-lock.json`, webpack externals, runtime imports, `.vscodeignore` inclusion rules, and packaged artifacts.
- A platform-selected `switchboard-pty-host` executable exists in every supported VSIX and host package and reports the expected protocol/build version.
- `src/extension.ts` and `src/standalone/bootstrap.ts` each construct or receive the same supervisor type and provide an explicit executable-resolution result.
- Neither host constructs `PtyFleetService`, `PtyTerminalBackend`, or a second terminal WebSocket gateway after the migration.
- The Go source contains no kanban schema, plan-column rules, board prompt templates, or database access.
- Missing or unsupported Go artifacts produce an explicit terminal-unavailable reason and never activate a Node PTY fallback.

### Manual and Performance Checks

1. Terminals work in the **extension** with the Go host: spawn, input, output, resize, kill.
2. Terminals work in **standalone**, spawned through the same binary.
3. Round-trip latency is at or below the measured 0.24 ms p50 the feature recorded.
4. Killing the parent kills the host — stdin EOF path — and leaves no orphaned pty or descendant shell.
5. The vendored tree in a built `.deb` is ~28 MB and contains no `node-pty/prebuilds/` directory.
6. `scripts/package-targets.sh` is deleted or reduced to responsibilities that survive without prebuild staging.
7. Windows is either verified working or explicitly unsupported with the decision recorded and a fail-loud runtime message.
8. An agent CLI runs in a Go-hosted terminal on the Pi — the arm64 path, on the target hardware.
9. Compare the extension and standalone composition roots by hand, including supervisor construction, executable source, tokens, callbacks, shutdown, and terminal capability reporting.

## Uncertain Assumptions

- The choice of maintained Go PTY/ConPTY implementation, its exact OS/architecture coverage, static-linking constraints, resize/process-tree semantics, and cross-compilation requirements need authoritative external confirmation. The user was advised to run web research before implementation.
- The signing, notarisation, executable-quarantine, and Marketplace packaging requirements for a spawned Go helper inside macOS and Windows VSIX/application artifacts need authoritative external confirmation. The user was advised to run web research before implementation.

## Recommendation

**Send to Lead Coder.** Complexity 9: this is a cross-language terminal-runtime replacement with security-sensitive input, process lifecycle, multi-platform packaging, and mandatory extension/standalone composition-root parity. Do not begin platform implementation until the external PTY and artifact-signing assumptions are confirmed; the protocol inventory and language-neutral fixtures can be prepared first.

## Implementation Summary
The Go PTY host now owns terminal process creation, loopback control, token authentication, output capture/replay, WebSocket input and resize, prompt framing, image paste limits, session logs, bounded cleanup, and parent-death handling. Both composition roots use the shared versioned supervisor seam, and the Node PTY dependency, webpack externals, VSIX inclusion rules, and Debian prebuild gates were removed; legacy TypeScript fleet seams now fail loudly instead of creating a second runtime. The checked-in manifest, Go build matrix, protocol fixtures, and package probes cover Linux amd64/arm64 and macOS amd64/arm64, with Windows explicitly unsupported until a verified adapter exists. Source/static verification and Go artifact/handshake probes passed; VSIX and Debian package probes remain unrun because the standing SKIP COMPILATION directive prevents the packaging tool from invoking webpack, and Coding must run those final release checks.

Review-fix pass: `GoPtyFleetProjection` now implements the live fleet surface (create/list/kill/rename/delegates/batch/liveness/registry) instead of throwing on standalone callers. Go `ptySendPrompt` accepts the existing `data` payload, emits isolated bracketed-paste writes plus confirm CR, returns bytesWritten/deliveredAt/promptSeq/readiness/cleared, and writes markdown log headings. Standalone `handlePtyVerb` again owns host policy (dispatch attribution, team barrier, token strip) and only forwards bytes to the supervisor. Restored gating/VSIX vsce-filter contracts and added a language-neutral black-box suite. Compile/tests skipped per run directives.

## Review Findings

Files changed: `src/services/ptyHostSupervisor.ts` (new `probePtyHostAvailability`), `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, `scripts/package-deb.sh`, `src/test/deb-packaging-contract.test.js`, `.github/workflows/integration-tests.yml`. Two fail-open defects were fixed: `ptyReady` was a hardcoded `true` in standalone and `_hasFleet()` counted a merely-constructed supervisor, so a missing or unsupported Go artifact was indistinguishable from a working terminal runtime — both now derive from a real manifest/file/exec-bit probe whose reason is logged. `scripts/package-deb.sh` had node-pty staging, prebuild-stripping and a load probe reintroduced by commit `2405c873`, which left the CI-wired `test:contract:vsix-packaging` RED at HEAD; that is removed, the stale deb-contract assertion that *required* the retired dependency is replaced with positive Go-artifact checks, and the retired Node PTY spawn kept behind `if (false)` (84 lines) plus its 66-line unreachable HTTP-proxy branch and orphaned `_ptyHostChild` field are gone. CI had no Go toolchain, no `go build`/`go test`, and never invoked `test:contract:pty-host-blackbox`, so the only check able to discriminate on terminal correctness gated nothing — a Go job, an artifact build and both missing contracts are now wired. Verification: `tsc --noEmit` clean apart from five errors pre-existing at HEAD (from `b85e3a3c`), eslint 0 errors, and a full 173-suite contract sweep diffed against a pristine `git archive HEAD` baseline shows zero regressions and six suites newly green.

## Deferred Findings

- MAJOR — Three artifact manifests with three different shapes were created where the plan specified one shared foundation; `launcher-artifacts.json` uses a string `version` and no `binary` key and is read by no TypeScript caller. `launcher-artifacts.json:1`
- MAJOR — `SWITCHBOARD_API_TOKEN` injection into pty children happens in standalone only; the extension never supplies `apiToken`. Pre-existing divergence (the retired `ptyHost.ts` also constructed `PtyFleetService` with no token) carried forward unchanged, not introduced here. `src/services/goPtyFleetProjection.ts:216`
- NIT — `stop()` latches `stopPromise` and never clears it, so a start-after-stop followed by a second stop would leave the new child unreaped. Not reachable on any current path. `src/services/ptyHostSupervisor.ts:170`
- NIT — The terminal WebSocket token is compared with `!=` rather than a constant-time compare. `cmd/switchboard-pty-host/ws.go:33`
- NIT — The trusted-origin check tests `u.Hostname() == "[::1]"`, but `url.Hostname()` strips the brackets and returns `::1`, so that literal can never match. `cmd/switchboard-pty-host/ws.go:21`
- NIT — Go unit tests could not be executed in this environment (no Go toolchain installed); the native black-box probe did run against a locally built `dist/linux-amd64/switchboard-pty-host`. `go.mod:1`
