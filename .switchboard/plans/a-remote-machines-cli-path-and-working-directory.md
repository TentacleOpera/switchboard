# A remote machine's CLI path and working directory

## Goal

A seat on another machine runs *that machine's* CLI binary, in *that machine's*
checkout — not the board host's absolute `dist/linux-arm64/switchboard` path on
an x86_64 box, and not the remote's bare `$HOME`. Two optional fields on
`AgentMachine` (`cliPath`, `remoteCwd`), an editor input for each, and a
per-machine resolution at the prompt seams that currently resolve the host's own
binary.

## Why it does not work today

### The seat is handed the board machine's binary, at the board machine's path

The invocation already prefers the front controller. `formatCliInvocation`
(`src/utils/cliPathToken.ts:133`) returns `"<goPath>"` when
`resolveGoClientPath()` finds a static client, and only falls back to
`node "<nodeCliPath>"` when none is installed — the `node` prefix and the path
are one substitution, so the prefix disappears with the path. There is no
second CLI to consolidate here: `done`, `next`, `dispatch` and `ready` are all
in `ownedVerbs` (`cmd/switchboard/main.go:22-26`), so the Go client serves a
seat's callbacks natively and hands anything else to the Node host itself.

What breaks on a remote seat is the *path*, not the program. `resolveCliPath()`
resolves the BOARD host's absolute binary — `dist/linux-arm64/switchboard` on
this Pi. Handed to a seat on the x86_64 Dell that path does not exist, and if a
path-shaped coincidence made it exist it would be the wrong architecture.

The fix is to resolve the invocation per machine, the way startup commands
already resolve (`GlobalIntegrationConfigService.getAgentStartupCommands(machineId)`,
`teamMachineId`): local keeps `formatCliInvocation()`; remote uses the machine's
configured `cliPath`, else bare `switchboard` and lets the remote `PATH` answer —
right architecture by construction, because the remote machine resolves its own
binary.

This is also why the seat path needs no Node-client work. A remote seat running
bare `switchboard` inherits the Go client's shipped endpoint, root and
credential resolution — tagged, and already measured working from the Dell
against this board. The Node CLI work in this feature is for `npx switchboard`
operators, not for seats, and must not be treated as a blocker for them.

### The remote agent's cwd

`ssh host 'claude'` lands the agent in remote `$HOME`, not its checkout.
`AgentMachine` needs an optional remote working directory that rides into the
composed command (`cd <wd> && env … <inner>`), or the seat wakes in an empty
room. The inner cli stays bare so `cliFamily` derivation is unaffected.

The rendering of that `cd` clause belongs to *The host inlines seat identity and
the board URL into a remote spawn*, which also adds both fields to
`AgentMachine`. This subtask supplies the *values*: the editor inputs that let an
operator set them, and the per-machine `cliPath` resolution at the seams that
emit a CLI invocation into a prompt.

## Scope

`src/webview/agent-control.js` (the Agents-tab machine editor),
`src/utils/cliPathToken.ts` (a new per-machine resolver), and the three prompt
emission seams that call it: `agentPromptBuilder.finalizeAgentPrompt:251`,
`KanbanProvider:6915`, and `teamWiring:1516`.

**Out of scope:** `renderSpawnCommand` and the fleet backends (*The host inlines
seat identity and the board URL into a remote spawn* owns those, and adds the
`AgentMachine.cliPath`/`remoteCwd` fields this subtask edits), `cli.ts`, and
`LocalApiServer.ts`.

The Go pty host needs no change. It already records the whole startup chain
(`main.go`) precisely so an ssh/mosh seat does not respawn the CLI on the wrong
machine.

## Metadata

**Complexity:** 4
**Tags:** cli, infrastructure, feature, ui
**Feature:** 30f625e0-feb9-4e96-aadb-af04610e3643

## User Review Required

- **`AgentMachine` grows two optional fields** (`cliPath`, `remoteCwd`) — new
  config surface on the machines store, plus one input each in the Agents-tab
  machine editor. The fields themselves are added by the sibling spawn subtask;
  this one exposes and consumes them.

## Complexity Audit

### Routine

- `AgentMachine` field additions are already done by the sibling subtask — the
  machines store round-trips unknown keys, so the editor inputs are a form
  change, not a schema migration.

### Complex / Risky

- **Per-machine `cliPath` threading.** `substituteCliPath` is invoked at
  several emission seams (`agentPromptBuilder.finalizeAgentPrompt`,
  `KanbanProvider:6915`, `teamWiring:1516` member-orders) without machine
  context; each must resolve the target seat's `machineId` first. A team is
  one machine (`delegateMachineId`), which keeps the resolution unambiguous.
- **A presentation default here is fine; a behavioural one is not.** An empty
  `cliPath` on a remote machine resolving to bare `switchboard` is correct by
  construction — the remote's `PATH` answers with the right architecture. What
  must never happen is a remote machine silently inheriting the *host's*
  absolute path, which is the current behaviour and is indistinguishable from a
  configured value until the seat dies.

## Edge-Case & Dependency Audit

- **Remote machine, no `cliPath`, no `switchboard` on remote `PATH`** → the
  seat dies inside the stale-command-death window, reported with the command and
  its source — visible failure. Hardening option: extend the existing machine
  probe (`ssh <prefix> true`, `KanbanProvider:14280`) to `command -v switchboard`
  at machine-save time and warn.
- **Presentation defaults are fine in the editor** — an empty `cliPath` on a
  remote machine resolves to bare `switchboard`; an empty `remoteCwd` means
  remote `$HOME`.
- **Local machines are unchanged.** `local` keeps today's `formatCliInvocation()`
  exactly, including the Go-binary preference and the `node` prefix fallback.
- **A team is one machine.** `delegateMachineId` is uniform across a team, so
  member-orders (`teamWiring:1516`) resolves once for the team's machine rather
  than per member.

## Dependencies

- *The host inlines seat identity and the board URL into a remote spawn* —
  **must land first.** It adds `AgentMachine.cliPath` and `AgentMachine.remoteCwd`
  and renders the `cd` clause; this subtask edits and consumes them.
- `agents-are-saved-per-machine-and-a-team-picks-one` (landed) — machine
  threading, `getAgentStartupCommands(machineId)`, `teamMachineId`, the pattern
  this subtask follows for `cliPath`.
- `go-cli-client-verbs` (landed) — the reason a remote seat running bare
  `switchboard` already resolves its own endpoint, root and credential.

## Adversarial Synthesis

Key risk: a remote seat left with no runnable CLI. Mitigated by defaulting remote
machines to bare `switchboard` — PATH-resolved on the remote, correct arch by
construction — and by extending the existing machine ssh-probe to check for it at
save time, so the failure surfaces when the operator configures the machine
rather than when a seat dies hours later.

Secondary risk: a seam missed. `substituteCliPath` has several callers and a
missed one silently emits the host's absolute path into a remote seat's prompt —
which looks exactly like a working configuration until that seat runs its first
callback. Mitigated by resolving at every emission seam and asserting the
negative: no emitted prompt for a remote machine contains the host's absolute
binary path.

## Proposed Changes

### `AgentMachine` editor — `src/webview/agent-control.js`

- **Context.** The Agents-tab machine form (`:2407-2473`) edits
  `transport`/`transportPrefix`.
- **Logic.** Two optional inputs per machine: "CLI path on this machine" and
  "Remote working directory". Both pass through to the `AgentMachine` record.
- **Edge cases.** Presentation defaults are fine here — an empty cliPath on a
  remote machine resolves to bare `switchboard` (PATH-resolved remotely,
  correct arch); an empty remoteCwd means remote `$HOME`.

### Per-machine cliPath at the prompt seams

- **Context.** `substituteCliPath`/`formatCliInvocation`
  (`src/utils/cliPathToken.ts`) resolve the HOST's binary; callers
  (`agentPromptBuilder.finalizeAgentPrompt:251`, `KanbanProvider:6915`,
  `teamWiring:1516`) pass or omit a single cliPath with no machine context.
- **Logic.** Add `resolveCliInvocationForMachine(machineId)`:
  `local` → today's `formatCliInvocation()`; remote → `machine.cliPath` if
  configured, else bare `switchboard` (PATH resolution happens on the remote —
  right arch by construction). Each emission seam resolves the TARGET seat's
  machineId (the handle carries it) before substituting. A team's
  `delegateMachineId` is uniform, so member-orders.md (`teamWiring:1516`)
  resolves once for the team's machine.
- **Edge cases.** Remote machine, no `cliPath`, no `switchboard` on remote
  PATH → the seat dies inside the stale-command-death window, reported with the
  command and its source — visible failure. Hardening option: extend the
  existing machine probe (`ssh <prefix> true`, `KanbanProvider:14280`) to
  `command -v switchboard` at machine-save time and warn.

## Verification Plan

### Automated Tests

Extend `src/test/agent-machines-contract.test.js`:

- `resolveCliInvocationForMachine('<local id>')` returns today's
  `formatCliInvocation()` output byte-for-byte — local is unchanged.
- A remote machine with a configured `cliPath` resolves to it; a remote machine
  without one resolves to bare `switchboard`, never to the host's absolute
  binary path.
- Each of the three emission seams resolves the target seat's machineId before
  substituting — asserted by emitting a prompt for a remote-machine seat and
  confirming the host's absolute path does not appear in it.
- The machines store round-trips `cliPath` and `remoteCwd` through save and
  reload without dropping them.

`npm run compile-tests` before running any of these, per the build rule.

### Goal Invariants

- No prompt emitted for a seat on a remote machine contains the board host's
  absolute CLI path — negative assertion across all three seams.
- A local seat's emitted invocation is byte-identical to today's — paired
  positive, so the change is provably remote-only.

### Manual Verification

- An `AgentMachine` saved with a CLI path and a remote working directory
  round-trips through the Agents-tab editor and reloads with both values.
- A seat on a machine configured with `remoteCwd` lands its agent in that
  directory on the remote box.
- A seat on a remote machine with no configured `cliPath` runs bare
  `switchboard` and its `next`/`done` callbacks succeed — the remote's PATH
  resolved the right binary for its architecture.
- A remote machine whose configured `cliPath` does not exist produces a visible
  seat death naming the command, not a silent hang.

## Recommendation

**Send to Coder.** Complexity 4: two form inputs plus one resolver threaded
through three known emission seams. The risk is a missed seam, which a negative
assertion pins.

---

**Implementation summary (Coding-coder-2).** `resolveCliInvocationForMachine`/`resolveCliInvocationForMachineId` resolve a seat's CLI invocation per machine — local keeps `formatCliInvocation()` byte-for-byte, remote gets the configured `cliPath` or bare `switchboard` — and `substituteCliPath` gained an invocation override so the whole `node "<cliPath>"` phrase rewrites verbatim. The plan's three seams are wired (prompt builder, KanbanProvider resolved options/drive prefixes/custom-agent branch, and `writeMemberOrdersFile` via `machineId` threaded through `wireSpawnedTeam`), plus a fourth the plan under-named: `applyStandingOrders` substitution at every delivery rail (bootstrap deliverPrompt, the tmux applier, ptySendPrompt composition, and the VS Code snapshot the extension applier consumes). The Agents-tab editor gained `cliPath` and `remoteCwd` inputs, both `saveMachine` handlers persist them (blank omitted), and both `probeMachine` handlers now run an advisory `test -x <cliPath>`/`command -v switchboard` check reported as `cliFound`/`cliWarning`. Contract coverage landed in `agent-machines-contract.test.js` §10; compilation and automated tests were not run per dispatch directives.

## Review Findings

Reviewed `resolveCliInvocationForMachine` (`src/utils/cliPathToken.ts`), `resolveCliInvocationForMachineId` (`src/services/GlobalIntegrationConfigService.ts`), the `invocation` override in `substituteCliPath`, and all four emission seams (prompt builder, `KanbanProvider`, `writeMemberOrdersFile` via the threaded `machineId`, and the `applyStandingOrders` delivery rails the plan under-named); local resolves `formatCliInvocation()` byte-for-byte, a remote machine takes its configured `cliPath` or bare `switchboard`, and an absent record refuses to resolve the host path. Inbound field check passed on both fields this subtask reads from elsewhere: `snapshot.cliInvocation` is set in the returned literal at `TaskViewerProvider.ts:1710` (and `:2929`), and `msg.cliWarning` is set in the `probeMachineResult` literals at `KanbanProvider.ts:14381` and `TaskViewerProvider.ts:16451` — not merely typed. The one `src/extension.ts` line is a shared-service options field, which the divergence rule requires in both roots, not throwaway legacy-host work. No code changes were needed. Verification: `test:contract:agent-machines` ALL PASSED (§10 included), typecheck clean.

## Deferred Findings

- NIT `src/services/GlobalIntegrationConfigService.ts:657` — `resolveCliInvocationForMachineId(undefined)` resolves to the LOCAL host invocation, so a seat whose handle lost its `machineId` would be handed the board host's absolute binary path. `machineId` is set on the handle at `goPtyFleetProjection.ts:598/620` and defaults to `'local'` at `:227`, so it is unreachable today, but the absent-id branch defaults to the one answer the module exists to prevent.
- NIT `src/utils/cliPathToken.ts:213` — the `invocation` override strips exactly one leading/trailing double quote for the bare-token substitution; a `cliPath` containing a double quote would round-trip incorrectly. Paths with quotes are not realistic, but the unquoting is positional rather than parsed.
