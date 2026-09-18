# The host inlines seat identity and the board URL into a remote spawn

## Goal

A seat spawned on another machine (`ssh`/`mosh` transport prefix) is told who it
is and where the board is, by the host that composed its startup command —
inlined into the remote command itself, not left to a transport that may not
carry it. This is the host-side half of the remote-seat story: after this lands,
a remote seat's process environment carries `SWITCHBOARD_TERMINAL`,
`SWITCHBOARD_AGENT_INSTANCE_ID`, `SWITCHBOARD_SERVER_URL` and
`SWITCHBOARD_WORKSPACE_ROOT`, and carries no credential.

This subtask does not change any client's resolution of those variables (that is
*A tagged `ApiTarget`*), does not change what the server accepts (*The board
refuses a `workspaceRoot` it does not serve*), and does not resolve which binary
the remote runs (*A remote machine's CLI path and working directory*).

## What already works

Measured on the Pi 400 and a tailnet Dell (x86_64), board served with
`switchboard tailnet`:

- The board serves **171 HTTP endpoints**, including everything a seat needs:
  `GET /kanban/plan`, `POST /kanban/queue/next`, `POST /kanban/queue/done`,
  `POST /kanban/task/complete`.
- The Dell reaches that board over the tailnet in ~15ms, by MagicDNS name and
  by IP, HTTP 200.
- The pty stays on the board host. `switchboard fleet` run from the Dell
  reports the Pi's PTY host (`surviveBoard=false`), so a seat whose startup
  command is `ssh <host> '<agent>'` is an ordinary local terminal to the board.
- **The Go client already implements the tagged resolution model this plan
  feeds** (`internal/client/resolve.go`): `SWITCHBOARD_SERVER_URL` /
  `--server` for the endpoint, `SWITCHBOARD_WORKSPACE_ROOT` /
  `--workspace-root` for the server root, `SWITCHBOARD_API_TOKEN` /
  `--token-file` for the credential — every value source-tagged
  (`{value, source}`). The remote-capable client exists; what is missing is the
  host *telling a spawned seat those values*, which is this subtask.

## Why it does not work today

### 1. The host never tells a spawned seat where the board is

`src/standalone/cli.ts:525` builds every request as
`http://127.0.0.1:${port}${pathname}`, and `findRunningInstance` (`cli.ts:435`)
probes `127.0.0.1` ports 7777-7780 and reads
`<cwd>/.switchboard/api-server-port.txt` — both halves assume the board's state
directory is on this disk.

An agent on another machine therefore dials *its own* loopback and gets
"No running Switchboard instance found" (verified). The only way through today
is `ssh -R 7777:127.0.0.1:7777`, which is a hack: it works by making the wrong
assumption accidentally true.

Making the Node client *able* to be told is the sibling subtask. Making the host
*do the telling* is this one. The board URL the host injects must carry its
source into the log where it is used — "which board did this seat get?" has to
be answerable after the fact.

### 2. Seat identity and board routing do not survive the ssh hop

The host injects `SWITCHBOARD_TERMINAL`, `SWITCHBOARD_AGENT_INSTANCE_ID` and
`SWITCHBOARD_API_TOKEN` into the pty's environment on the board machine
(`ptyFleetService.ts:546-550`, `main.go:306-308`). `ssh` does not forward
arbitrary environment by default (`SendEnv` requires `AcceptEnv` in the
remote's `sshd_config`, which the host cannot guarantee), so the agent on the
far side does not know which seat it is — and `next` / `done`, which resolve
identity from that variable, have nothing to resolve.

Switchboard composes the startup command itself, so it must inline the values
into the remote command rather than hope the transport carries it. The
transport-uniform form is `env K=V … <innerCli>` — `ssh host 'env … claude'`
works under sshd's `$SHELL -c`, and `mosh host -- env … claude` works under
mosh's post-`--` exec. Because the Go host's respawn replay re-types
`startupCommandComposed` verbatim, an inlined env re-delivers itself on every
respawn for free.

**A secret never crosses in the typed command.** The composed command is typed
into the pty (scrollback), stored on `handle.startupCommand`, and printed by
the `[cliFamily] spawn` log line (`ptyFleetService.ts:798`). Inlining
`SWITCHBOARD_API_TOKEN` there would spray the board credential into three
persistent stores. It is also unnecessary: a request that arrives on the
tailnet listener is trusted without a credential — `_isTailnetSocket`
(`LocalApiServer.ts:1791`) returns `true` BEFORE the token comparison, and the
remote seat's request lands on that listener by construction.

### 3. The seat needs no credential, and must never be handed one on a command line

`_checkAuth` tests `_isTailnetSocket(req)` first (`LocalApiServer.ts:1791`): a
request arriving on the tailnet listener is trusted exactly as loopback, before
any token is read. Tailnet membership IS the remote seat's credential, per
`auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md`. The measurement
that `GET /agent/control/config` answers a credential-free request from the
Dell is that bypass firing — not evidence that no token exists.

A durable token therefore does not lock a remote seat out, provided the seat
dials the tailnet listener. It 401s only a request that arrives on a
non-tailnet socket: the `tailscale serve` route, where tailscaled proxies to
`127.0.0.1` so the request presents as loopback, or any future non-tailnet
bind. So the injected `SWITCHBOARD_SERVER_URL` must be the tailnet-listener URL
(`http://<tailnetAddress>:<port>`, or a MagicDNS name resolving to it) and
never the `tailscale serve` URL — the second one silently needs a credential
this design deliberately never sends.

The consequence for this subtask is narrow and absolute: **a credential must
never be interpolated into a seat's startup command.** The command is composed
by the host, stored, logged and displayed; a token in it leaks into all four.
Identity and routing ride in the environment.

The CSRF guard is NOT a gap: `apiRequest` already sends
`X-Switchboard-Client: switchboard-cli` unconditionally, and that marker is
accepted from a non-loopback host with no `Origin` (measured).

### 4. CLI identity derivation — regression pinning only

`deriveCliIdentity` (`src/services/cliIdentity.ts:25`) still splits on the
first whitespace token, so handed `ssh dell 'claude'` it would answer
`displayName: "SSH CLI"`, `family: 'unknown'` — the wrong clear strategy and a
guessed-short readiness ceiling on the slowest seats there are.

No production caller feeds it the composed command. The machine-threading work
(`agents-are-saved-per-machine-and-a-team-picks-one`) landed the seams that
derive `cliFamily` from the inner cli at spawn, and the spawn, delivery,
respawn and display-name paths all read that. The misclassification is
unreachable today.

So this item is not a code change, and must not be planned as one. What it
needs is a pin: contract assertions that `cliFamily` derives from `innerCli` in
both fleet backends, and that no caller derives identity or display name from
the composed transport-wrapped string. Most already exist in
`agent-machines-contract.test.js`; the gap is an explicit assertion that the
composed string never reaches `deriveCliIdentity`, so a future caller that
passes it fails a test instead of silently mistiming every remote seat. The
`env K=V …` prefix this subtask adds makes that pin load-bearing rather than
theoretical.

## Scope

Standalone host only — `src/services/GlobalIntegrationConfigService.ts`
(`renderSpawnCommand`, `AgentMachine`), `src/services/goPtyFleetProjection.ts`
(the live fleet backend; `src/standalone/ptyFleetService.ts` calls the same
shared `renderSpawnCommand` and picks the env composition up for free), and the
board-endpoint resolver seam wired in `src/standalone/bootstrap.ts`.

The VS Code extension host is out of scope: it is the legacy host being removed
by the cutover, and wiring the new board-endpoint resolver seam there is
throwaway work. `renderSpawnCommand` is shared code — it lands once and serves
both roots while the extension lives; that is not divergence.

The Go pty host needs no change. It already records the whole startup chain
(`main.go`) precisely so an ssh/mosh seat does not respawn the CLI on the wrong
machine, and respawn replays `startupCommandComposed` — which after this plan
carries the inlined env, so env delivery is self-healing across respawns.

The Go client needs no change. `internal/client/resolve.go` already implements
the tagged endpoint/root/credential resolution this plan's injected env feeds.

`src/standalone/cli.ts` is **not** in scope — the Node client's resolution of
these variables belongs to *A tagged `ApiTarget`*. `LocalApiServer.ts` is not in
scope — the root refusal belongs to *The board refuses a `workspaceRoot` it does
not serve*. `src/webview/agent-control.js` and the prompt seams are not in scope
— per-machine `cliPath` belongs to *A remote machine's CLI path and working
directory*. This subtask adds the `cliPath` and `remoteCwd` fields to
`AgentMachine` and renders `remoteCwd`; it does not read `cliPath`.

## Metadata

**Tags:** cli, api, infrastructure, feature, auth
**Complexity:** 5

## User Review Required

- **No credential ever crosses in the typed remote command.** Tailnet-listener
  membership is the remote seat's auth (`LocalApiServer.ts:1791`; the posture
  already settled by
  `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md`). If a future seat
  must authenticate — e.g. reaching the board through `tailscale serve`, which
  lands on loopback — the channel is a seat-env file pushed over ssh stdin at
  spawn and sourced by the remote command, never argv. That is a follow-up
  card, not this one.
- **Env names are the shipped Go client's**: `SWITCHBOARD_SERVER_URL`,
  `SWITCHBOARD_WORKSPACE_ROOT`, `SWITCHBOARD_API_TOKEN`
  (`internal/client/usage.go:68-71`).
- **`AgentMachine` grows two optional fields** (`cliPath`, `remoteCwd`) — new
  config surface on the machines store. This subtask adds the fields and
  consumes `remoteCwd`; the editor inputs and `cliPath` consumption are the
  sibling subtask.

## Complexity Audit

### Routine

- Extending `renderSpawnCommand` with an allowlisted env-composition step —
  one shared function, both fleet backends pick it up.
- `AgentMachine` field additions — the machines store already round-trips
  unknown keys.

### Complex / Risky

- **Secrets vs argv.** The env inlining must be allowlisted
  (`SWITCHBOARD_TERMINAL`, `SWITCHBOARD_AGENT_INSTANCE_ID`,
  `SWITCHBOARD_SERVER_URL`, `SWITCHBOARD_WORKSPACE_ROOT`) with a contract test
  asserting `SWITCHBOARD_API_TOKEN` never appears in a composed command. The
  failure is silent and persistent (scrollback + handle field + log line).
- **Board-endpoint value choice.** The injected URL must be the tailnet
  listener (`http://<tailnetAddress>:<port>` or MagicDNS-resolving-to-it), NOT
  the `tailscale serve` HTTPS URL — the proxy lands on loopback and would 401 a
  seat that deliberately carries no credential.

## Edge-Case & Dependency Audit

- **Race conditions.** Env is captured into `startupCommandComposed` at
  injection; respawn replays that string verbatim, so a devin respawn
  re-delivers seat identity without re-reading live config. A machine renamed
  between spawns still resolves: `getMachineSync` fails loudly on an unknown
  id (`goPtyFleetProjection.ts:220`), unchanged.
- **Security.** Allowlisted env keys only in the composed command; token never
  rendered. `SWITCHBOARD_SERVER_URL` injection uses the tailnet-listener URL.
  The remote command is typed into a pty — every inlined value must be safe to
  see.
- **Side effects.** The composed command gains a visible `env K=V …` prefix —
  it appears in scrollback, `handle.startupCommand`, and the `[cliFamily]
  spawn` log; deliberate, non-secret. The stale-death echo allowance
  (`startupCommand.length + slack`) grows with the prefix automatically.
- **Dependencies & conflicts.** This subtask injects `SWITCHBOARD_WORKSPACE_ROOT`
  into every seat's env, which is the precondition for the server-side root
  refusal. That refusal must not land before this does, or a worktree-cwd seat
  starts getting 400s where it previously got silent-but-correct 200s.

## Dependencies

- *A tagged `ApiTarget`* — consumes the env this subtask injects. The env names
  are the contract between the two; neither invents a second vocabulary.
- *The board refuses a `workspaceRoot` it does not serve* — must land after
  this, per the edge-case note above.
- *A remote machine's CLI path and working directory* — consumes the
  `AgentMachine.cliPath` field this subtask adds.
- `agents-are-saved-per-machine-and-a-team-picks-one` (landed) — machine
  threading, `renderSpawnCommand`, `startupCommandInner`, per-machine startup
  commands.
- `go-cli-client-verbs` (landed) — the Go client's tagged resolution
  (`resolve.go`) and its env names.
- `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` — the trust model:
  tailnet membership is the remote device's credential.

## Adversarial Synthesis

Key risk: a secret or a wrong URL inlined into a typed command is persistent and
invisible — it survives in scrollback, on `handle.startupCommand`, in the spawn
log line, and through every respawn replay. Mitigated by an allowlist enforced
inside `renderSpawnCommand` (not at its callers), a contract test that attempts
to smuggle a token through `seatEnv` and asserts it is dropped, and using the
tailnet-listener URL only.

Secondary risk: the `env K=V …` prefix is exactly the kind of string that makes
`deriveCliIdentity` answer "SSH CLI"/`unknown` if a future caller ever feeds it
the composed command — which would silently mistime every remote seat. Mitigated
by the negative assertion in §4, which becomes load-bearing the moment this
prefix exists.

## Proposed Changes

### `src/services/GlobalIntegrationConfigService.ts`

- **Context.** `renderSpawnCommand(innerCli, machine)` (`:712`) is the single
  seam both fleet backends use to compose `ssh`/`mosh` prefixes. `AgentMachine`
  (`:86`) carries `id`, `name`, `transport`, `transportPrefix`.
- **Logic.** Two additions:
  1. `AgentMachine` gains optional `cliPath?: string` and `remoteCwd?: string`.
  2. `renderSpawnCommand` gains an optional `seatEnv` parameter
     (`Record<string,string>`), applied ONLY for non-local machines: remote
     renders as `ssh <prefix> 'cd <remoteCwd> && env K=V … <inner>'` (cd clause
     omitted when unset) and `mosh <prefix> -- env K=V … <inner>` (with a
     `remoteCwd`, mosh wraps in `sh -c 'cd … && env … <inner>'` since post-`--`
     is exec'd, not shelled). Env values are single-quote-escaped with the same
     `'\''` rule the inner cli already uses. Local machines return `inner`
     unchanged — the pty env already carries these variables.
- **Implementation.** Hardcode the allowlist of renderable keys
  (`SWITCHBOARD_TERMINAL`, `SWITCHBOARD_AGENT_INSTANCE_ID`,
  `SWITCHBOARD_SERVER_URL`, `SWITCHBOARD_WORKSPACE_ROOT`) inside the function —
  a caller-passed key outside the set is dropped AND logged, never rendered.
  Deterministic key order for testability.
- **Edge cases.** Values containing single quotes or spaces (a MagicDNS name
  cannot; a workspace path can) — escape. `remoteCwd` unset → no `cd` clause,
  remote lands in `$HOME` (visible, recoverable). Unknown transport — keep the
  existing fall-through to `inner` and log that env could not be delivered.

### `src/services/goPtyFleetProjection.ts` (+ `src/standalone/ptyFleetService.ts`)

- **Context.** `create()` resolves `machine` (`:217`), `innerCli` (`:241`), and
  `composedCli` via `renderSpawnCommand` (`:242`). The Go host injects
  `SWITCHBOARD_TERMINAL`/`SWITCHBOARD_AGENT_INSTANCE_ID`/`SWITCHBOARD_API_TOKEN`
  into the local pty env (`main.go:306-308`) — invisible to the remote side.
- **Logic.** For `machine.transport !== 'local'`, build `seatEnv` =
  `{ SWITCHBOARD_TERMINAL: name, SWITCHBOARD_AGENT_INSTANCE_ID: agentInstanceId,
  SWITCHBOARD_SERVER_URL: <resolved board URL>,
  SWITCHBOARD_WORKSPACE_ROOT: this.workspaceRoot }` and pass it to
  `renderSpawnCommand`. Never include `SWITCHBOARD_API_TOKEN`.
- **Implementation.** New seam `setBoardEndpointResolver(() => string | null)`
  on the projection; a remote machine with no resolver result throws at spawn —
  "machine '<id>' is remote but the board has no tailnet listener — run
  `switchboard tailnet`" — same loud-failure style as the machine-not-found
  throw at `:220`. `ptyFleetService.ts` calls the same `renderSpawnCommand`, so
  the env composition is shared; wire the same resolver there only if that
  backend is still reachable — check before writing a dead seam.
- **Edge cases.** Local seats: no change (pty env covers it). tmux seating:
  `composedCli` already flows into the tmux chain (`:296`) — the env rides
  inside it.

### `src/standalone/bootstrap.ts`

- **Context.** `GoPtyFleetProjection` is constructed at `:4179`; the bind
  policy (`tailnetAddress`, `magicDnsNames`) and bound port are known to the
  CLI layer before bootstrap runs (`cli.ts:5064`, tailnet log at `:5862`).
- **Logic.** Wire `ptyFleetService.setBoardEndpointResolver` to return
  `http://<tailnetAddress>:<port>` — prefer the raw tailnet address over
  MagicDNS (rename-proof; the listener identification is the socket's local
  address either way). Return `null` under a loopback-only bind.
- **Implementation.** Standalone-only seam — the extension is out of scope per
  the cutover; its absence there is intended state, not divergence.
- **Edge cases.** `switchboard local` posture + a remote machine spawn → the
  loud throw above, not a half-reachable seat.

## Verification Plan

### Automated Tests

Extend `src/test/agent-machines-contract.test.js`:

- `renderSpawnCommand` with a seatEnv map renders `env K=V …` inside the ssh
  single-quoted remote arg and after `--` for mosh; local machines return inner
  unchanged.
- The composed string for a remote seat NEVER contains `SWITCHBOARD_API_TOKEN`
  or a token value — assert against a seatEnv that attempts to smuggle one.
- `cliFamily` still derives from `innerCli` in both fleet backends (existing
  assertions hold; add: env-wrapped composed command does not change the
  derivation).
- `remoteCwd` renders `cd <wd> &&` ahead of `env` for ssh; mosh uses `sh -c`
  when a cwd is set.

Contract for the resolver seam:

- `bootstrap.ts` wires `setBoardEndpointResolver`; remote machine + null
  resolver → spawn throws naming the posture (`switchboard tailnet`).

`npm run compile-tests` before running any of these, per the build rule.

### Goal Invariants

- For a non-local machine, the composed spawn command contains
  `SWITCHBOARD_TERMINAL=`, `SWITCHBOARD_SERVER_URL=`, and
  `SWITCHBOARD_WORKSPACE_ROOT=` — positive assertions on the rendered string.
- For a non-local machine, the composed spawn command does NOT contain
  `SWITCHBOARD_API_TOKEN` — paired negative for the same artifact.
- `deriveCliFamily` is never invoked with a composed (transport/env-wrapped)
  command in either fleet backend — negative assertion, already pinned by
  `agent-machines-contract`; keep it green.

### Manual Verification

- The resolved board URL is logged with its source on every seat start; a seat
  that fell back to loopback is distinguishable in the log from one that was
  configured to use it.
- A seat started as `ssh <host> 'claude'` renders on the board as Claude Code,
  family `claude`, not "SSH CLI"/unknown.
- A remote `devin` seat resolves `clearStrategy: 'respawn'`, and a clear
  respawns it with its `--model` intact — and the respawned command still
  carries the inlined env (replayed via `startupCommandComposed`).
- An unrecognised remote agent resolves to `unknown` and waits on the longest
  readiness ceiling, not the shortest.
- Killing the board on A stops the pty on A; no orphaned ssh process is left
  holding a session on B.
- With a durable token set on A via `switchboard token rotate`, verify the token
  appears NOWHERE: not in the seat's scrollback, not in `handle.startupCommand`,
  not in the `[cliFamily] spawn` log line.
- A seat on a machine configured with `remoteCwd` lands its agent in that
  directory on the remote box.

## Recommendation

**Send to Coder.** Complexity 5: one shared spawn seam, both fleet backends and
one composition-root wiring, plus a security-sensitive rule (never inline a
credential) that a contract test must pin.

## Completion Summary (2026-09-18, Coding-coder-1)

`renderSpawnCommand` in `src/services/GlobalIntegrationConfigService.ts` gained an
optional `seatEnv` parameter rendered as `env K='V' …` for non-local machines only,
behind a closed allowlist (`SWITCHBOARD_TERMINAL`, `SWITCHBOARD_AGENT_INSTANCE_ID`,
`SWITCHBOARD_SERVER_URL`, `SWITCHBOARD_WORKSPACE_ROOT`); non-allowlisted keys are
dropped and logged, so `SWITCHBOARD_API_TOKEN` can never enter a typed command.
`AgentMachine` gained optional `cliPath`/`remoteCwd`; `remoteCwd` renders
`cd <wd> &&` for ssh and an `sh -c` wrap for mosh (post-`--` is exec'd).
`GoPtyFleetProjection` now generates `agentInstanceId` host-side (the Go host honours
`payload.agentInstanceId`), builds `seatEnv` for non-local machines, throws loudly
naming `switchboard tailnet` when the resolver answers null, and logs the endpoint
with its source; `bootstrap.ts` wires `setBoardEndpointResolver` to the
tailnet-listener URL (`http://<tailnetAddress>:<port>`), null under loopback-only.
The Node `PtyFleetService` backend is never instantiated (contract-pinned), so no
dead seam was wired there; the extension host is out of scope per the cutover.
Contract pins were added to `src/test/agent-machines-contract.test.js` (section 9);
per dispatch directives they were written but not executed, and render output was
verified by extracting and running the real function out-of-band. Review fix: the
`switchboard tailnet` throw assertion now matches the source's escaped backticks
(`\`` inside the template literal); `npm run test:contract:agent-machines` is ALL
PASSED.

## Review Findings

Reviewed `renderSpawnCommand` + `SEAT_ENV_ALLOWLIST` in `src/services/GlobalIntegrationConfigService.ts`, the `seatEnv`/`agentInstanceId` path in `src/services/goPtyFleetProjection.ts`, and the `setBoardEndpointResolver` wiring in `src/standalone/bootstrap.ts`; the allowlist is closed inside the function (not at its callers), `SWITCHBOARD_API_TOKEN` cannot render, the ssh double-quote escaping and the mosh `sh -c` wrap for `remoteCwd` are both correct, and a remote machine under a loopback-only bind throws naming `switchboard tailnet` rather than producing a half-reachable seat. Inbound field check passed on the two fields this subtask depends on: `cmd/switchboard-pty-host/main.go:303` reads `payload.agentInstanceId` and honours it in the `terminal` literal at `:328`, and `bootstrap.ts` hands `GoPtyFleetProjection` and `LocalApiServer` the same `workspaceRoot` binding, so the injected `SWITCHBOARD_WORKSPACE_ROOT` always matches a known root and the sibling root-refusal subtask is safe to have landed. The host-side `crypto.randomUUID()` change alters the id's shape from the Go host's 32-hex token; no consumer asserts a length or format. No code changes were needed here. Verification: `test:contract:agent-machines` ALL PASSED, typecheck clean, `go test -count=1 ./cmd/switchboard-pty-host` ok.

## Deferred Findings

- NIT `src/services/GlobalIntegrationConfigService.ts:740` — the dropped-key warning iterates `Object.keys(seatEnv)` on every spawn and logs once per non-allowlisted key; a caller that routinely passes extra keys would log on every seat start rather than once.
- NIT `src/services/goPtyFleetProjection.ts:239` — `agentInstanceId` is generated for local machines too even though only the remote path needs it host-side; harmless, but it moves id generation off the Go host for every seat, not just the ones that require it.
