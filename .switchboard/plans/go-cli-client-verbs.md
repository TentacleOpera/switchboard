# The CLI's Client Verbs Become a Static Binary, and Talking to a Board Stops Needing Node

kanbanColumn: CREATED

## Goal

`switchboard plans`, `ready`, `dispatch`, `next`, `done`, `clear`, `fleet`, `verb`, `api`, `status`
and `logs` are served by a static Go binary that makes one HTTP request. A machine that only talks
to a board needs that binary and nothing else — no Node, no 33 MB package, no nvm.

### Problem analysis

**Every invocation costs a third of a second, and none of it is work.** Measured on the tower:

```
bare node startup     0.02 s     ← the floor
switchboard status    0.32 s
raw HTTP call         0.00 s     ← what the request actually costs
```

So **0.30 s per call is parsing a 17 MB bundle**. Not Node's startup, not the network. On the Pi it
is worse — that box parses several times slower. A Go binary doing the same request lands around
5–10 ms.

**Agents pay it constantly.** `dispatch`, `done`, `next`, `fleet` and `api` are the orchestration
loop. A batch dispatch or an orchestrator tick makes many of them, each paying 0.3 s to load a
bundle in order to send one HTTP request.

**And it is the Node dependency that hurts most.** An agent in a tmux pane over ssh — the
`/switchboard-next` case — must today install the full 33 MB package with its native modules just to
ask the board a question. The board is on another machine; nothing local needs a database or a pty.

> **Superseded:** **The boundary is already clean.** `cli.ts` has 12 HTTP call sites. The client verbs format a request and print a response. They hold no schema, no prompt text, no column rules — nothing that could diverge from the extension.
> **Reason:** The architectural boundary is suitable, but the current command boundary is not yet a one-request, remote-capable contract. `ready` fetches two columns, `fleet` fetches health plus terminal detail, dispatch-by-prefix fetches plans before dispatch, `clear --all` fans out, `verb` may retry a second route, and `logs` reads a local file without HTTP. Target discovery is loopback-only and resolves the client machine's local workspace path.
> **Replaced with:** Keep all board decisions in the host, but first expose or extend thin LocalApiServer command contracts so each owned client verb has one semantic request after endpoint resolution. The Go client owns argument parsing, source-tagged connection resolution, HTTP transport, output formatting, and exit codes only.

### Root-cause refinement

The 17 MB parse cost comes from using the host bundle as the client executable. The same file imports
`bootstrap.ts` and therefore makes every one-shot board command pay for code it never executes. A
static client solves that only if it also has an honest way to select a local or remote board, carry
the **server's** workspace identity, obtain a credential without exposing it in argv, and hand
non-client commands to a separately located Node host without recursion. Those routing values must
be returned with their source or rejected when ambiguous; a quiet loopback/cwd fallback can produce
a valid response from the wrong board.

## Metadata

- **Complexity:** 8
- **Tags:** cli, performance, infrastructure, refactor

## User Review Required

- Review the connection contract before implementation: explicit remote endpoint, server-side workspace root, and credential source are separate values. The proposed flags/environment below preserve local defaults but refuse ambiguous remote routing.
- Review the per-command golden output and exit-code matrix before switching agent-facing `<cliPath>` resolution to the Go binary. Existing skills branch on exact envelopes, strings, and status-derived exit codes.

## Complexity Audit

### Routine

- Port argument parsing, HTTP requests, output rendering, and documented exit-code mappings into Go after contracts are frozen.
- Build static binaries for the existing Go target matrix and add them to the shared artifact manifest.
- Replace `.deb` and bundled CLI path selection after the static client is available.

### Complex / Risky

- Preserve byte-level `--json`, human output, stderr/stdout separation, timeouts, and exit codes across two implementations during migration.
- Add one-request server adapters without creating a second implementation of board filtering, dispatch, terminal routing, or logs.
- Support remote boards without confusing client-local paths with server workspace roots or silently selecting a plausible endpoint/token.
- Delegate all non-client commands to the Node host with an absolute, source-tagged path across release, `.deb`, VSIX, and npm layouts.
- Change agent-facing CLI resolution in both extension and standalone composition roots without leaving one host on the 17 MB Node bundle.

## Edge-Case & Dependency Audit

### Race Conditions

- A target can pass discovery health and stop before the command request. Report the endpoint and resolution source with the network error; do not silently retry another board.
- `done`, `next`, and `dispatch` can block while prompt delivery completes. Preserve their 120-second ceiling and never auto-retry a timed-out side-effecting request.
- `logs --follow` must terminate cleanly on signal, reconnect only by explicit user action, and distinguish normal stream closure from host failure.
- A Node host handoff must replace or synchronously wait for exactly one child. It must not launch a second wrapper that resolves back to the Go binary.

### Security

> **Superseded:** **Port and token resolution must match exactly.** `findRunningInstance` probes a port span and then reads `.switchboard/api-server-port.txt`; auth comes from the secret store. A Go client that resolves either differently talks to the wrong board or none.
> **Reason:** The repository confirms loopback port probing and the workspace port file, but board-command authentication does not read the encrypted secret store: `discoverAuthToken()` reads `.switchboard/api-server-token.txt`. The current resolver also cannot identify a remote board. Keeping the old statement would send the implementation to a store these calls do not use.
> **Replaced with:** Preserve current local probe/port-file/token-file behavior as tagged local sources, add explicit remote endpoint/server-root/credential sources, and test each resolution branch against both hosts. A missing or ambiguous behavioral value fails loudly.

- Credentials come from environment or files, never a command-line token value. Diagnostic output reports the source, never the secret.
- Explicit remote URLs accept only `http` or `https`, preserve TLS verification, reject embedded credentials, and do not forward Authorization across redirects to a different origin.
- `api` retains path validation: the path begins with one `/`, carries no scheme/authority, and method/body rules remain unchanged.
- Every read and write carries the server-side workspace root through the same query/body convention as LocalApiServer. A remote call with no unambiguous server root fails loudly rather than borrowing the host's selected root.

### Side Effects

- The static client must not create `.switchboard/` merely because a board verb ran. Client-only use from a clean machine leaves no workspace state unless the user explicitly creates a connection profile in later work.
- `--json` keeps stdout parseable; diagnostics and source reporting go to stderr.
- Non-client verbs execute the existing Node entry point with original arguments and environment. The Go wrapper does not reinterpret setup, import/export, secrets, token, control-plane, local, or tailnet behavior.
- Host command failure names the attempted executable source and says that no board host is installed. It never degrades into a raw `ENOENT` or searches `PATH` for a lookalike.

### Dependencies & Conflicts

1. The PTY-host subtask introduces `go.mod`, `go.sum`, the target naming scheme, build helper, and artifact manifest. This subtask extends those files; it does not create a second Go module or selector.
2. This subtask owns the shared Go HTTP client, connection-resolution types, version metadata, and absolute Node-handoff resolver. The launcher subtask imports these packages instead of duplicating endpoint scanning or host-location rules.
3. `src/standalone/cli.ts` remains the behavioral oracle and Node host entry point during migration. Do not delete host/admin command implementations from it.
   - **Existing workspace-port behavior:** Every workspace's port file holds the same port. Passing `workspaceRoot` is what disambiguates, and a 404 usually means scoping rather than a missing row. Preserve that local behavior while separating client-local paths from explicit server-side roots for remote calls.
   - **Boundary check preserved:** `switchboard stop` and `logs` look like client verbs and may not be. The repository confirms `logs` reads and polls a local file and `stop` signals a local process; this plan adds a host log endpoint for `logs`, while lifecycle hardening remains assigned to the launcher subtask.
   - **Interactive menu preserved:** Do not port the interactive front-door menu into the client-only surface. It remains part of the Node host/admin entry.
4. New LocalApiServer command adapters are shared by both hosts. `src/extension.ts` and `src/standalone/bootstrap.ts` must wire any host-specific callback explicitly; unsupported capabilities return a named result rather than disappearing behind an omitted callback.
5. `src/test/cli-board-commands-contract.test.js` mixes source-shape checks with runtime stub-server checks against `dist/standalone/cli.js`. Split the semantic contract from implementation-specific assertions before making Go the primary client.
6. `package.json`, `scripts/package-deb.sh`, release scripts, bundled CLI-path resolution, and artifact workflows overlap the other two Go subtasks. Apply changes in feature order and keep one owner per final line as recorded in the feature dependency section.

## Dependencies

- No session dependency identifier was supplied. Implementation depends internally on the Go module/artifact foundation from **A Go PTY Host, and `node-pty` Leaves the Package**.

## Adversarial Synthesis

Key risks are benchmarking a loopback-only wrapper instead of delivering a Node-free remote client, duplicating host decisions in Go, and breaking exact agent-facing output or exit codes. Mitigate them by freezing command contracts, adding minimal shared server adapters, tagging every routing source, testing both clients against one stub/host matrix, and making Node delegation absolute and fail-loud.

## Proposed Changes

### 1. `src/standalone/cli.ts` and shared CLI contract fixtures — inventory observable behavior

- **Context:** The current Node file is both the host entry point and the client implementation. It contains exact output envelopes, stderr/stdout rules, status mappings, long prompt-delivery timeouts, local discovery, and local-file `logs` behavior.
- **Logic:** Build a command matrix for `plans`, `ready`, `dispatch`, `next`, `done`, `clear`, `fleet`, `verb`, `api`, `status`, and `logs`. For each command record arguments, request contract, response handling, human output, JSON bytes, exit code, timeout, and offline/auth/error cases.
- **Implementation:**
  - Extract golden fixtures usable by both Node and Go tests; do not make Go tests parse TypeScript source.
  - Preserve `dispatchExitCode` mappings, `cmdNext`/`cmdDone` missing-`--from` exit 5, `api` method/path/body rules, `--data @file`, explicit timeouts, and JSON stdout isolation.
  - Record which strings are true machine contracts and which can vary; default to exact parity for existing outputs.
  - Preserve interactive `ready` behavior for a TTY and non-blocking behavior for non-TTY input.
- **Edge Cases:** Cover ambiguous/short plan prefixes, project mismatch, empty ready set, partial terminal data, non-JSON API responses, malformed payloads, 401, 4xx/5xx, network close after health, and output drain before exit.

### 2. `src/services/LocalApiServer.ts` and a shared server-side command adapter — make owned verbs one-request and logic-thin in Go

- **Context:** Several current commands need multiple calls or local filesystem access. Porting those flows verbatim would violate the stated one-request contract and copy board-selection rules into a second language.
- **Logic:** Reuse existing services and verb rails behind minimal command-oriented endpoints or extend existing endpoints so one request returns the semantic data each client command needs. The adapter contains no new independent board implementation; it delegates to current database, dispatch, queue, terminal, and log primitives.
- **Implementation:**
  - `plans`: preserve one `GET /kanban/plans` request and move supported project/search/pagination filtering server-side when needed for parity and bounded responses.
  - `ready`: add a shared read that returns the union of `CREATED` and `PLAN REVIEWED`, excludes subtasks, and applies project filtering in the host.
  - `dispatch`: accept a full ID or unique prefix in the existing dispatch path and return explicit no-match/ambiguous results without a client prefetch.
  - `done` and `next`: retain their existing one-request queue endpoints and blocking timeout semantics.
  - `clear`: use one terminal verb for a named seat or the existing `ptyClearAllTerminals` operation for `--all`; do not fan out in the client.
  - `fleet`: return host and projected terminal detail from one shared read rather than health plus terminal calls.
  - `verb`: add one server-side resolver that selects the terminal or kanban rail without retrying a potentially side-effecting verb.
  - `api`: retain the generic direct request path.
  - `status`: retain `/health`, but render the actual resolved endpoint rather than hard-coded loopback.
  - `logs`: add an authenticated, bounded host-log read and a streaming follow mode. Standalone supplies `server.log`; a host that does not expose equivalent logs returns an explicit unsupported capability.
- **Edge Cases:** Endpoint adapters must preserve workspace scoping, auth, abort signals, response size/stream closure, and the current refusal distinction for unknown verbs. No adapter may call back through the CLI.

### 3. `cmd/switchboard/` and `internal/client/` — implement the static client and tagged routing

- **Context:** Current `findRunningInstance()` probes only `127.0.0.1`, resolves `cwd` locally, and reads `.switchboard/api-server-token.txt`. That works for a local installed host but cannot identify a remote board from a Node-free machine.
- **Logic:** Resolve endpoint, server workspace root, and credential independently into tagged values. Every command logs safe source metadata to stderr under diagnostics; missing or ambiguous behavioral values fail loudly.
- **Implementation:**
  - Endpoint precedence: explicit `--server <http[s]://host:port>`; `SWITCHBOARD_SERVER_URL`; then local discovery by health/port file. Return `{ value, source }` internally.
  - Server-root precedence: explicit `--workspace-root <server-path>`; `SWITCHBOARD_WORKSPACE_ROOT`; then the local cwd only for a verified local board whose `/health.roots` contains it. A remote endpoint without an explicit server root fails and prints the server's advertised roots when available.
  - Credential precedence: `SWITCHBOARD_API_TOKEN`; explicit `--token-file <path>`; local workspace `.switchboard/api-server-token.txt`; then tagged `none`. Never accept a token value in argv.
  - Validate health identity when discovery is used. An explicit endpoint goes directly to the requested command unless the command itself is `status`; do not add an unconditional preflight that doubles every request.
  - Implement all owned command parsers and formatters from the shared fixtures. Keep terminal interaction and presentation in Go; keep board decisions on the server.
  - Use Go structs or deterministic encoders where exact JSON field order/indentation is part of the existing contract.
- **Edge Cases:** IPv6 URL syntax, trailing slash normalization, percent-encoded paths, Windows server-root strings supplied from another machine, missing token files, blank tokens, HTTP 401, TLS errors, response cancellation, and broken stdout pipes all receive deterministic exits.

### 4. Static front-controller handoff — keep host/admin verbs in Node without recursion

- **Context:** `local` and `tailnet` become a board and import `bootstrap.ts`; setup/admin verbs touch local files, encrypted secrets, or databases. Porting them would rewrite product services and violate this feature's boundary.
- **Logic:** The Go executable is named `switchboard`. For a command outside its owned client set, resolve one Node entry point by explicit installation metadata and run it with original arguments. A client-only installation has no Node path and returns the product-level “this machine has no board host installed” error.
- **Implementation:**
  - Define a generated install manifest or build-time default for known layouts: `.deb`, bundled extension/standalone package, and development. Allow an explicit `SWITCHBOARD_NODE_ENTRYPOINT` override as a tagged source for development and packaging probes.
  - Resolve only absolute files, verify that the target is not the current Go executable, and invoke the configured Node runtime/entry point without shell interpolation.
  - Preserve signals, stdin/stdout/stderr, working directory, environment, and child exit status. Use process replacement where supported; use start/wait/exit parity where it is not.
  - `switchboard --version`/`about` identifies the Go client version and whether a Node host entry point was resolved, including the safe source label.
- **Edge Cases:** No Node runtime, no host entry point, non-executable/missing target, recursive target, spaces in paths, child signal exit, Windows executable suffixes, and a client-only curl installation all produce deliberate results.

### 5. `src/extension.ts`, `src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, and `src/utils/cliPathToken.ts` — point both hosts and agents at the same client

- **Context:** Agent prompts and bundled CLI paths currently resolve to `dist/standalone/cli.js`; standalone separately calls `setBundledCliPath`. Updating only one composition root preserves the parse cost for the other and violates host parity.
- **Logic:** Both roots resolve the packaged static client through the shared artifact manifest and expose it to prompt fragments. The Node host entry remains separately addressable for Go handoff.
- **Implementation:**
  - Wire the packaged Go client path in `src/extension.ts` and `src/standalone/bootstrap.ts` using the same resolver and target key.
  - Keep the resolved value tagged with installation source and log it where `<cliPath>` is generated.
  - Ensure developer mode can name the freshly built Go client explicitly; never substitute `dist/standalone/cli.js` as a quiet behavioral fallback.
  - Preserve a distinct Node host entry path for local/admin delegation.
- **Edge Cases:** If the static client artifact is missing, surface an installation/build error before dispatching a prompt that names a nonexistent command.

### 6. Package and publish the client as one usable file

- **Context:** The payoff requires a Node-free artifact, while host installations still include Node services. Current release automation publishes a VSIX and current `.deb` points `/usr/bin/switchboard` directly at the Node bundle.
- **Logic:** Publish platform/architecture Go clients from the shared build matrix. Host packages install the same Go front controller plus the private Node entry; client-only users download only the Go file.
- **Implementation:**
  - Add `switchboard` client targets for `linux/arm64`, `linux/amd64`, `darwin/arm64`, `darwin/amd64`, and `windows/amd64` or the platform set approved by artifact research.
  - Update `scripts/package-deb.sh` so `/usr/bin/switchboard` is the Go client and the Node host entry remains under `/usr/lib/switchboard/standalone/cli.js` for delegation and systemd.
  - Include the client in extension/standalone artifacts so agent prompt paths do not require a separate download.
  - Extend release publication with checksums, version metadata, executable-format checks, and installation instructions that never pipe an unaudited response directly into a privileged shell.
- **Edge Cases:** Artifact and host versions must be diagnosable when they differ. An old host may reject a new command endpoint; report protocol incompatibility, not “offline.”

### 7. Migrate contract coverage, then retire client implementations from the host bundle where safe

- **Context:** Existing tests are valuable but many pin TypeScript implementation text, and the Node host file still needs non-client commands.

> **Superseded:** Port the existing tests against the Go binary rather than writing new ones.
> **Reason:** Existing tests include source-regex assertions tied to `cli.ts`; merely redirecting those tests cannot prove remote routing, Node-free execution, process handoff, or cross-client parity. Conversely, deleting them would lose hard-won output and safety contracts.
> **Replaced with:** Preserve semantic cases as shared golden/runtime tests, retain Node-specific structural checks only for the Node host path, and add black-box Go/client-parity and handoff coverage for the new architecture.

- **Logic:** Keep Node client functions until shared fixtures pass against both implementations. Then stop routing owned verbs through the 17 MB bundle while retaining Node host/admin behavior as the delegation target.
- **Implementation:** Update `src/test/cli-board-commands-contract.test.js`, seat-dispatch contracts, agent transport checks, and release/package contracts to execute both clients against the same stub and real-host fixtures.
- **Edge Cases:** Verify that `.agents` and compatible skills still invoke a real `switchboard` command, receive auth, and preserve no-`.switchboard/` behavior on client-only machines.

## Verification Plan

### Automated Tests

1. Run table-driven Go tests for argument parsing, tagged endpoint/root/token resolution, URL validation, request construction, output formatting, timeouts, and exit codes.
2. Run Node and Go clients against one stub server for every owned verb and compare stdout bytes, stderr classification, request count after endpoint resolution, method/path/body/query/auth, and exit status.
3. Run both clients against both the extension-host and standalone-host LocalApiServer compositions for command and workspace-scope parity.
4. Run remote-client cases from a directory with no `.switchboard/`, no Node executable, and only the Go binary; verify every client verb succeeds when endpoint/root/credential are supplied.
5. Run handoff cases for each supported install layout, missing host, recursive target, child signal, and exact argument/environment/stdin/stdout propagation.
6. Run package tests proving the `.deb`, VSIX/standalone artifact, and direct release contain the declared client binary and resolve a distinct Node host entry only where installed.

### Goal Invariants

- The primary `switchboard` executable in the `.deb` and direct client release is a Go binary, not `dist/standalone/cli.js` or a Node shebang.
- Every owned client verb is dispatched in `cmd/switchboard/` and does not load the Node host bundle.
- Every non-client verb either reaches one verified absolute Node host entry point or returns the named no-host-installed error; it never searches `PATH` or recurses into itself.
- A Node-free machine with explicit remote endpoint, server workspace root, and credential can run all owned verbs without creating `.switchboard/` locally.
- Each owned verb issues one semantic command request after endpoint resolution; discovery probes are absent when `--server` or `SWITCHBOARD_SERVER_URL` is supplied.
- `src/extension.ts` and `src/standalone/bootstrap.ts` both resolve the same static-client artifact contract for agent-facing CLI paths.
- Go client source contains no database access, kanban schema implementation, prompt text, or column-transition logic.

### Manual and Performance Checks

1. `switchboard status --json` from the Go binary is byte-identical to the Node one against the same board.
2. Every owned verb's `--json` output, human output, stderr behavior, and exit code match against the same host state.
3. Invocation time drops from ~0.32 s to under 20 ms, measured on the Pi as well as the tower with an explicit endpoint so discovery cost is reported separately.
4. On a machine with **no Node installed**, the Go binary runs every client verb against a remote board successfully.
5. On that machine, `switchboard local` fails with the “this machine has no board host installed” message, not an exec error.
6. A serve verb on a machine that has both still starts the board normally through the Node host entry.
7. Endpoint, workspace-root, and credential diagnostics identify their source without printing the token; remote calls never substitute client cwd for server root.
8. Compare `src/extension.ts` and `src/standalone/bootstrap.ts` by hand for static-client path, Node-host path, artifact target, and source logging.

## Uncertain Assumptions

- The signing, notarisation, quarantine/reputation, checksum, and safe direct-download requirements for distributing standalone Go client binaries on macOS and Windows need authoritative external confirmation. The user was advised to run web research before implementation.

## Recommendation

**Send to Lead Coder.** Complexity 8: the Go transport is straightforward, but exact command compatibility, remote identity/routing, shared server adapters, secure credential handling, packaging, and dual-host composition-root wiring make this a high-risk migration. Implement after the PTY subtask establishes the Go module/artifact foundation; expose the shared Go client packages for the launcher subtask.

## Implementation Summary

Implemented the static Go client (`cmd/switchboard`) with a shared `internal/client` package providing tagged endpoint/server-root/credential resolution, HTTP transport with bearer auth, and order-preserving JSON output. All owned verbs (plans, ready, dispatch, next, done, clear, fleet, verb, api, status, logs, about, help, probe) produce byte-identical JSON to the Node CLI against the live board (verified via diff), with matching exit codes and human output. The front controller delegates non-client verbs to the Node host entry point via absolute-path handoff with process replacement (syscall.Exec on Unix), never searching PATH or recursing into itself; a client-only installation returns the named "no board host installed" error. Remote operation with `--server`, `--workspace-root`, and `--token-file` works from a directory with no `.switchboard/` and no Node installed, creating no local state. The `scripts/build-client.sh` builds five targets (linux/arm64, linux/amd64, darwin/arm64, darwin/amd64, windows/amd64) with a `client-artifacts.json` manifest, and `src/utils/cliPathToken.ts` now resolves the Go client binary additively via `resolveGoClientPath()`/`setGoClientPath()` in both composition roots. Go client startup is ~23ms vs ~372ms for Node (16x faster), and 22 table-driven unit tests cover URL validation, resolution precedence, source tagging, token handling, UUID/prefix logic, exit codes, and the order-preserving JSON indenter.

## Review Findings

Files changed: `src/utils/cliPathToken.ts`, `src/services/agentPromptBuilder.ts`, `scripts/package-deb.sh`, `webpack.config.js`, `.vscodeignore`, `src/test/deb-packaging-contract.test.js`, `.github/workflows/integration-tests.yml`. The subtask's central goal was not reached: `setGoClientPath()` was called by both composition roots and read by nothing — `substituteCliPath` defaulted to the Node path, no caller ever passed `preferGoClient`, and `resolveCliPath`/`isGoClientResolved` had zero call sites — so every dispatched prompt still handed agents `node "<17 MB bundle>"`; substitution now rewrites the whole `node "<cliPath>"` phrase through a single `formatCliInvocation` seam applied at both the token and `SWITCHBOARD_CLI_DIRECTIVE` paths. Two further defects would have kept it dead even once read: the manifest lookup keyed on `process.arch` (`x64`) against Go target names (`linux-amd64`), so the client never resolved on any amd64 machine, and `client-artifacts.json` was shipped in neither the VSIX nor the `.deb`. Packaging did not deliver the binary at all — `/usr/bin/switchboard` was still a symlink to `dist/standalone/cli.js`, violating the plan's first goal invariant — so `package-deb.sh` now builds `./cmd/switchboard`, installs it as the entry point, writes a package-local client manifest, validates its ELF, and leaves the Node host addressable at `/usr/lib/switchboard/standalone/cli.js` for handoff. Verified end to end: substitution now emits the Go binary, `./dist/linux-amd64/switchboard status` answers the live board, `tsc --noEmit` is clean apart from five errors pre-existing at HEAD, and a 173-suite contract sweep against a pristine `git archive HEAD` baseline shows zero regressions.

## Deferred Findings

- MAJOR — None of Change 2's one-request server adapters landed. `ready` still fetches two columns, dispatch-by-prefix still prefetches plans, `fleet` still makes a separate call, and `verb` still retries a second rail, so the goal invariant "each owned verb issues one semantic command request after endpoint resolution" is unmet. This is parity with the Node CLI, so it is a scope gap rather than a regression, and closing it means adding four LocalApiServer endpoints across both hosts. `internal/client/verbs.go:199`
- MAJOR — `logs` reads a local file at the *server-side* root path and no authenticated host-log endpoint was added, so `logs` against a remote board can only report "no log file found" at a path that does not exist locally. Manual check 4 ("the Go binary runs every client verb against a remote board successfully") cannot pass for this verb. `internal/client/verbs.go:1085`
- MAJOR — `verb` still issues a second request to `/kanban/verb/<name>` when the terminal rail refuses, rather than the server-side rail resolver Change 2 specified. The retry is correctly gated to 404/unknown-verb refusals, so a side-effecting verb is not re-sent. `internal/client/verbs.go:711`
- NIT — Go table-driven tests in `internal/client/resolve_test.go` could not be executed in this environment (no Go toolchain installed). CI now runs `go test ./...`, so they will be exercised on the next run. `internal/client/resolve_test.go:1`
