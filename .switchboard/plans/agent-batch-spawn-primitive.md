# Agent Batch Spawn Primitive: `POST /agents/spawn-batch`

## Goal

Expose a general-purpose, host-agnostic HTTP primitive that spawns N terminal agents from N prompts, governed by a configurable concurrency cap with backfill. This is the missing capability that turns Switchboard's fan-out from feature-scoped into arbitrary-scoped.

### The problem

Switchboard has three ways to run work across multiple plans, and none of them can do "improve these 20 plans in parallel":

| Existing mechanism | Capability | Why it falls short |
| :--- | :--- | :--- |
| `POST /oversight/start` (`OversightPassService.ts`) | Column sweep, queue resolution, mtime completion detection, digest | Coding lane is **WIP-1** — a serial conveyor with one overlapping planner lane. Also halts the entire pass on any single failure. |
| `POST /kanban/orchestration/dispatch` (`LocalApiServer.ts:3601`) | Genuine N-wide parallel fan-out | Scoped to **one feature**, gated on the **PLAN REVIEWED** column, and routes every agent through a **git worktree**. |
| `improve-feature` skill | Improves every subtask of a feature | One agent handling N subtasks sequentially (or via subagent policy) — not N terminals. |

### Root cause

**No endpoint in `LocalApiServer.ts` creates a terminal.** Every dispatch path targets a *pre-existing, registered* terminal agent and fails when none is live:

- `_handleResearchDispatch` returns `404 { dispatched: false, reason: "no researcher agent configured" }`
- `POST /kanban/dispatch` returns `409` when there is "no live terminal agent"

This is deliberate for those endpoints — the `onDispatchResearch` seam contract at `LocalApiServer.ts:246` states the callback "MUST NOT throw, and MUST NOT spawn a terminal" so the planner cleanly falls back to emitting the prompt in chat. That prohibition is **scoped to the research hand-off's best-effort semantics**; it is not a global architectural ban on spawning. This plan adds a *new* endpoint with spawn semantics and must not alter the research endpoint's contract.

The underlying capability already exists (`PtyFleetService.create(role, friendlyName, cwd, worktreePath)` at `src/standalone/ptyFleetService.ts:75`, and `vscode.window.createTerminal` via `hostSeams.ts:250`). It is simply not exposed over HTTP and not batched.

### Why terminals rather than subagents

Terminals are independently observable and interruptible, can each run a different model or CLI, do not share a single context budget, and outlive the dispatching session. Subagent policy (`agentPromptBuilder.ts:790-831`) already covers the in-process case; this primitive covers the out-of-process one.

## Metadata

**Complexity:** 7
**Tags:** backend, api, infrastructure, feature

## Reconcile Before Building

Local unpushed work may already have added a spawn endpoint. **Before writing any code:**

1. `curl -s "$BASE/catalog"` and `grep -n "spawn\|/agents/\|batch" src/services/LocalApiServer.ts`
2. If a spawn/batch route already exists, **adapt to its shape** — extend its payload and concurrency handling rather than introducing a second parallel endpoint.
3. Record what was found (and the resulting deviation from this plan) in the implementation summary.

Two competing spawn endpoints would be worse than either alone.

## Design

### Host-seam routing (non-negotiable)

Terminal creation MUST go through `src/services/hostSeams.ts`, not `PtyFleetService` directly. `TaskViewerProvider.ts:25` carries an explicit comment that `PtyFleetService` is imported "for `purgePtyTerminals` ONLY — the fleet itself, the registry, and terminal creation are owned by the standalone host." Bypassing the seam produces a primitive that works in standalone and silently no-ops under VS Code (or vice versa).

If `hostSeams` lacks a batch-capable creation function, extend it there — one seam, two backends.

### New service: `AgentBatchService`

Mirror `OversightPassService` (`src/services/OversightPassService.ts:137`) exactly — it is the proven in-repo template for this class of engine:

- Constructor takes an injected deps object (see `OversightPassDeps` at line 116)
- `public async start(body): Promise<{ status: number; body: any }>` (line 156)
- `public status(workspaceRoot?)` (line 315), `public async stop(body)` (line 325)
- `public async resumeFromDisk(workspaceRoots)` (line 352) — batches must survive extension reactivation
- `implements vscode.Disposable`

Instantiate it in `TaskViewerProvider.ts` alongside `this._oversightPass = new OversightPassService({...})` at line 819, which is the established wiring host for LocalApiServer options.

### Endpoint contract

```
POST /agents/spawn-batch
{
  "workspaceRoot": "/repo",
  "label": "improve-created-2026-08-08",
  "concurrency": 5,
  "cwd": "/repo",
  "agents": [
    { "ref": "a1b2c3d4", "role": "planner", "prompt": "..." },
    { "ref": "e5f6g7h8", "role": "planner", "prompt": "..." }
  ]
}
```

- `concurrency` — optional; defaults to the `switchboard.agentBatch.defaultConcurrency` setting (default `5`), clamped to `[1, 20]`. Callers may raise it per run.
- `cwd` — defaults to `workspaceRoot`. **No worktree parameter in this plan.** Worktree-isolated batches remain the job of `/kanban/orchestration/dispatch`.
- `ref` — opaque caller-supplied correlation key (a planId for plan batches, anything for other callers). The primitive never interprets it.
- `role` — passed through to terminal creation so existing role-based prompt injection and registry behavior apply unchanged.

**Response** — follow the honest-response convention established by `/kanban/dispatch` and documented at `LocalApiServer.ts:2102-2114`. Do **not** wrap a partial failure in a blanket `{success: true}`:

```
200 { batchId, accepted: [...refs], rejected: [{ ref, reason }], concurrency, queued, running }
400 { error }   // malformed payload, empty agents array, bad concurrency
503 { error }   // host seam unavailable (headless/test harness)
```

`accepted` means *queued or spawned*, not *succeeded*. Outcome tracking is a separate concern (see the batch tracking plan).

### Concurrency pool with backfill

Maintain a run queue per batch. Fill up to `concurrency` slots; as each slot frees, spawn the next queued agent.

**The slot-free signal for this plan is terminal process exit, not plan completion.** These are different signals with different owners: process exit is a cheap pty/host-level event this primitive can observe directly, while semantic task completion (plan-file mtime advance) belongs to the tracking layer. Coupling the pool to the semantic signal would make the primitive plan-specific and unusable for non-plan batches.

Include a per-agent spawn timeout so a terminal that never starts cannot permanently hold a slot.

### Failure isolation (deliberate divergence from oversight)

`OversightPassService` halts the whole pass on any dispatch failure — correct for a serial WIP-1 conveyor where a bad card poisons the queue. It is **wrong here**. In a wide batch, one failed spawn must:

- mark that agent `failed` with a reason,
- leave every other agent running,
- free its slot for backfill,
- never re-dispatch automatically, and
- never move any card.

Only a host-seam-unavailable error (no terminals can be created at all) aborts the batch.

## Verification Plan

1. **Unit — pool semantics.** With `concurrency: 2` and 5 agents, assert at most 2 spawn calls are in flight; assert agent 3 spawns only after one of the first two exits.
2. **Unit — failure isolation.** Force agent 2's spawn to reject; assert agents 1, 3, 4, 5 still spawn, agent 2 is reported `failed`, and the batch does not halt.
3. **Unit — clamping.** `concurrency: 0`, `-1`, `999`, `"five"`, and omitted each resolve to a value within `[1, 20]`.
4. **Unit — host-seam routing.** Assert the service calls the `hostSeams` creation function and never imports/calls `PtyFleetService.create` directly.
5. **Contract — response honesty.** A batch where one agent is rejected returns it in `rejected[]` with a reason; assert no code path returns `success: true` with a non-empty `rejected[]` and no other signal.
6. **Contract — research endpoint untouched.** Existing `_handleResearchDispatch` tests still pass; assert it still returns `dispatched: false` rather than spawning.
7. **Headless.** With no host seam registered, the endpoint returns `503`, matching the oversight endpoints' behavior.
8. **Manual (VSIX).** Install the VSIX, run a 3-agent batch with `concurrency: 2` against a scratch workspace, confirm two terminals appear, the third appears after one exits, and all three are visible and interruptible in the terminals sidebar.

## Dependencies

None. This plan is deliberately self-contained and ships standalone — a working spawn primitive is useful before any batch tracking or plan-specific caller exists.
