# Headless Agent Batch Spawn Primitive: `POST /agents/spawn-batch`

## Goal

Expose an HTTP primitive that launches N **headless** agent processes from N prompts, each under a caller-chosen role (and therefore a caller-chosen CLI/provider), governed by a configurable concurrency cap with backfill. The agents never render in the terminals UI and are never typed into; they run non-interactively and report back over HTTP.

### The problem

Switchboard has three ways to run work across multiple plans, and none can do "improve these 20 plans in parallel, on a provider of my choosing":

| Existing mechanism | Capability | Why it falls short |
| :--- | :--- | :--- |
| `POST /oversight/start` (`OversightPassService.ts`) | Column sweep, queue resolution, mtime completion detection, digest | Coding lane is **WIP-1** — a serial conveyor. Halts the whole pass on any failure. |
| `POST /kanban/orchestration/dispatch` (`LocalApiServer.ts:3601`) | Genuine N-wide parallel fan-out | Scoped to **one feature**, gated on **PLAN REVIEWED**, routes every agent through a **git worktree**. |
| `improve-feature` skill | Improves every subtask of a feature | One agent handling N subtasks sequentially — not N processes. |

### Root cause

**No endpoint in `LocalApiServer.ts` creates an agent.** Every dispatch path targets a *pre-existing, registered* terminal and fails when none is live (`_handleResearchDispatch` → `404 no researcher agent configured`; `POST /kanban/dispatch` → `409` when there is no live terminal agent). The `onDispatchResearch` seam contract at `LocalApiServer.ts:246` states the callback "MUST NOT throw, and MUST NOT spawn a terminal" — that prohibition is **scoped to the research hand-off's best-effort semantics**, not a global architectural ban. This plan adds a new endpoint with spawn semantics and must not alter that one.

### Why processes, not subagents

Subagents are locked to the host session's own subscription and model catalogue. Separate processes let each agent run under a **different CLI, different subscription, and different billing** — the practical driver here is cost: routing bulk plan-improvement to a provider covered by a separate or free subscription instead of burning Claude credits, and reaching agents that are not available as in-process subagents at all. Subagent policy (`agentPromptBuilder.ts:790-831`) already covers the in-process case; this primitive covers the out-of-process one.

### Why headless, and what that forces

These agents are **not for watching.** They must not appear in the pty/terminals interface, are never focused, and are never typed into. Three consequences drive the whole design:

1. **No PTY by default.** If nothing renders the output and nobody types into it, a pseudo-terminal earns nothing. Direct `child_process.spawn` gives real exit codes, captured stdout/stderr for diagnostics, no shell-readiness race, and no registry pollution.
2. **The existing launch path is the wrong one.** `PtyFleetService.injectStartupCommand` (`src/standalone/ptyFleetService.ts:121`) opens a shell, waits `SHELL_READINESS_DELAY_MS` (750ms), then **types** the role's startup command via `sendText`. That model exists for interactive UX. Headless launch must `exec` a command directly with the prompt delivered deterministically.
3. **A blocked agent is invisible.** An interactive agent stuck on a permission prompt is obvious — a human sees it. A headless one hangs silently, holding a pool slot, until a timeout fires. Blocking-avoidance is a correctness requirement here, not a nicety.

## Metadata

**Complexity:** 8
**Tags:** backend, api, infrastructure, cli, feature

## Reconcile Before Building

Local unpushed work may already have added a spawn endpoint. **Before writing any code:**

1. `curl -s "$BASE/catalog"` and `grep -n "spawn\|/agents/\|batch" src/services/LocalApiServer.ts`
2. If a spawn/batch route exists, **adapt to its shape** — extend its payload and concurrency handling rather than introducing a second parallel endpoint.
3. Record what was found, and any resulting deviation from this plan, in the implementation summary.

Two competing spawn endpoints would be worse than either alone.

## Design

### New service: `AgentBatchService`

Mirror `OversightPassService` (`src/services/OversightPassService.ts:137`) — the proven in-repo template for this class of engine: injected deps object (`OversightPassDeps`, line 116), `start(body): Promise<{status, body}>` (line 156), `status(workspaceRoot?)` (line 315), `stop(body)` (line 325), `resumeFromDisk(workspaceRoots)` (line 352), `implements vscode.Disposable`.

Instantiate it in `TaskViewerProvider.ts` beside `this._oversightPass = new OversightPassService({...})` (line 819), the established wiring host for LocalApiServer options.

### Launch model — exec, not shell-and-type

Each agent is launched via `child_process.spawn(command, args, { cwd, env, stdio })` using the role's **headless launch spec** (schema, defaults, and configuration UI are owned by the sibling provider-configuration plan; this plan consumes the resolved spec).

The spec supplies: `command`, `args[]`, a `promptDelivery` mode of `stdin | arg | file`, and any non-interactive/auto-approve flags. Resolution rules:

- **Default `promptDelivery` to `stdin`.** Improve-plan prompts are long; `arg` risks platform argv length limits and leaks the full prompt into the process table.
- **Close stdin immediately after writing the prompt.** This is the single most important anti-hang measure: a CLI that later tries to read a confirmation gets EOF and exits instead of blocking forever on a TTY nobody is attached to.
- **Never allocate a TTY** unless the role's spec sets `requiresTty`. For that case only, fall back to the pty fleet — and register the handle with `purpose: 'batch'`, never `purpose: 'pty'`, so it stays out of the terminals UI (see Invisibility below).
- Capture stdout/stderr to a per-agent log under `.switchboard/agent-batches/<batchId>/<ref>.log`, ring-buffered/size-capped. Nobody watches these live, but they are the only forensic trail when an agent produces nothing.

**Do not reuse `getAgentStartupCommands()` verbatim for launching.** Those values are shell text designed to be *typed* into an interactive session; some are aliases or shell functions that will not `exec`. They are the right thing to *read as a default hint* when generating a headless spec, and the wrong thing to pass to `spawn`.

### Provider selection is role selection

The caller picks a `role` per agent; the role determines the CLI, the auth, and therefore the bill. Roles are already user-extensible (`CustomAgentConfig`, `parseCustomAgents`, `toCustomAgentRole` in `agentConfig.ts`), so "improve plans on a cheaper provider" is expressed as a custom role with its own headless spec — **no new provider concept is introduced here**, and roles gain a second launch mode rather than a parallel identity system.

### Invisibility

Two existing mechanisms, both to be used:

1. **No registry entry.** `PtyFleetService.updateRegistryState` persists the fleet into `runtime.terminals` "so /health, the board and worktree routing all see PTY terminals," and only `purpose:'pty'` rows are rewritten. Child-process agents write **no** registry entry at all, which makes them invisible by construction rather than by filtering. The `requiresTty` fallback path registers `purpose:'batch'`, which the pty UI does not own and must not render.
2. **Role picker suppression.** `GlobalIntegrationConfigService.SYSTEM_ONLY_ROLES` (line 436, currently `orchestrator`, `mcp_monitor`, `jules_monitor`, `scheduler`) is stripped from the role picker and the OPEN AGENT TERMINALS path precisely because those roles are "launched by automation, not selectable by users." Batch-only roles belong in that set.

Consequence to accept deliberately: because batch agents are absent from `runtime.terminals`, no dispatch endpoint can target them and `/health` will not list them. That is correct — they are fire-and-forget with a report-back channel — but it makes the batch status endpoint the **sole** observability surface, which raises the stakes on the tracking plan.

### Process lifecycle and orphan reaping

Record each agent's PID in the batch state file at spawn. On extension boot, reap: for every PID recorded as running in a non-terminal batch, verify liveness and either re-adopt it or mark it `exited`. `PtyFleetService.purgePtyTerminals` (line 273) establishes the boot-reconcile precedent — "drop every `purpose:'pty'` registry entry left over from a previous run" — and headless children need the equivalent or a crashed extension leaves orphaned CLI processes burning tokens with nobody watching.

Kill the process group, not just the leader, when stopping — CLI agents commonly spawn helpers.

### Endpoint contract

```
POST /agents/spawn-batch
{
  "workspaceRoot": "/repo",
  "label": "improve-created-2026-08-08",
  "concurrency": 5,
  "cwd": "/repo",
  "agents": [
    { "ref": "a1b2c3d4", "role": "improver-cheap", "prompt": "..." },
    { "ref": "e5f6g7h8", "role": "improver-cheap", "prompt": "..." }
  ]
}
```

- `concurrency` — optional; defaults to `switchboard.agentBatch.defaultConcurrency` (default `5`), clamped to `[1, 20]`. Overridable per run.
- `cwd` — defaults to `workspaceRoot`. **No worktree parameter.** Worktree-isolated batches remain `/kanban/orchestration/dispatch`'s job.
- `ref` — opaque caller-supplied correlation key. The primitive never interprets it.
- `role` — resolves the headless launch spec. A role with no valid spec is **rejected at validation time, before any agent spawns** — a batch that silently runs zero agents is the worst outcome here.

**Response** — follow the honest-response convention documented at `LocalApiServer.ts:2102-2114`; do not wrap partial failure in a blanket `{success: true}`:

```
200 { batchId, accepted: [...refs], rejected: [{ ref, reason }], concurrency, queued, running }
400 { error }   // malformed payload, empty agents, unresolvable role/launch spec
503 { error }   // host unavailable (headless/test harness)
```

`accepted` means *queued or spawned*, not *succeeded*.

### Concurrency pool with backfill

Fill up to `concurrency` slots; as each slot frees, spawn the next queued agent. **The slot-free signal is process exit**, not semantic task completion — process exit is a cheap, directly-observable event, while task completion (plan-file mtime advance) belongs to the tracking layer. Coupling the pool to the semantic signal would make the primitive plan-specific and unusable for non-plan batches.

Apply a hard per-agent wall-clock cap that kills and frees the slot. This is distinct from the soft, report-only `stuck` classification in the tracking plan: with no human watching a headless process, an unbounded hang holds a slot forever and can wedge the batch below its configured width.

### Failure isolation (deliberate divergence from oversight)

`OversightPassService` halts the whole pass on any dispatch failure — correct for a serial WIP-1 conveyor, wrong at width. One failed spawn must: mark that agent `failed` with a reason, leave every other agent running, free its slot for backfill, never auto-re-dispatch, and never move any card. Only a host-level inability to spawn anything aborts the batch.

## Verification Plan

1. **Unit — pool semantics.** `concurrency: 2` with 5 agents: at most 2 spawns in flight; agent 3 spawns only after one of the first two exits.
2. **Unit — failure isolation.** Force agent 2's spawn to reject; agents 1, 3, 4, 5 still spawn, agent 2 reports `failed`, batch does not halt.
3. **Unit — clamping.** `0`, `-1`, `999`, `"five"`, omitted → all resolve within `[1, 20]`.
4. **Unit — no TTY, no registry.** Assert the default path calls `child_process.spawn` (not the pty fleet) and writes **zero** `runtime.terminals` entries. Assert the `requiresTty` path registers `purpose: 'batch'` and never `purpose: 'pty'`.
5. **Unit — stdin closed.** Assert stdin is written then ended; simulate a child reading stdin after prompt delivery and assert it receives EOF rather than blocking.
6. **Unit — prompt delivery.** A 200KB prompt succeeds under `stdin` and `file`; assert `arg` mode is rejected or chunk-guarded above the platform argv limit rather than failing opaquely at spawn.
7. **Unit — invalid role rejected pre-spawn.** A batch containing one role with no launch spec returns `400` and spawns **zero** agents.
8. **Unit — hard timeout.** An agent exceeding the wall-clock cap is killed, its slot is freed, and the next queued agent spawns.
9. **Unit — process-group kill.** A child that forks a helper: assert stop kills the group, leaving no live descendants.
10. **Unit — orphan reap.** Persist a batch with a recorded PID that no longer exists; assert boot reconcile marks it `exited` and issues no re-spawn.
11. **Contract — research endpoint untouched.** Existing `_handleResearchDispatch` tests still pass; it still returns `dispatched: false` rather than spawning.
12. **Headless harness.** With no host available the endpoint returns `503`, matching the oversight endpoints.
13. **Manual (VSIX).** Run a 3-agent batch at `concurrency: 2` using a cheap non-Claude role. Confirm: no new terminals appear in the terminals sidebar, the role does not appear in the role picker, `runtime.terminals` is unchanged, all three plan files are modified, and per-agent logs exist under `.switchboard/agent-batches/`.

## Dependencies

- **Headless Agent Launch Specs & Provider Configuration** (`headless-agent-launch-specs.md`) — supplies the resolved per-role launch spec this plan consumes. That plan ships independently and can land first; this plan should read specs through its resolver rather than reimplementing spec parsing.
