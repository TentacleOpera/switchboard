# Agent Batch Tracking: Semantic Completion, Status Endpoint, and Digest Data

## Goal

Give `POST /agents/spawn-batch` an observable lifecycle: a status endpoint a supervising agent can poll in short turns, per-agent semantic completion detection, per-agent failure isolation, and a durable state file that survives extension reactivation.

### The problem

The spawn primitive answers "did N terminals start?" but not "did the work land?" Those are different questions, and for plan batches the gap is where all the value is. A supervising agent that can only see process exit cannot distinguish:

- an agent that improved its plan and exited cleanly,
- an agent that exited without writing anything,
- an agent still thinking at minute nine, and
- an agent wedged on a prompt.

Without that distinction the supervisor's only options are to guess or to read all 20 plan files — and reading plan bodies is precisely what blows up its context on a wide batch.

### Root cause

Process exit (the spawn primitive's slot-free signal) is a *host-level* event. Task completion is a *semantic* event with a different owner: `GlobalPlanWatcherService` already emits `onPlanDiscovered` (`src/services/GlobalPlanWatcherService.ts:44-48`) and `OversightPassService.attachWatcher()` (line 147) already consumes exactly this signal to drive its state machine. The plan-file-mtime-advance completion contract is established behavior (see the `switchboard-contracts` skill: *completion = plan-file mtime advance*; *plan files are write-once-at-the-end*).

So the signal exists and the consumption pattern exists — they are simply not wired to batches. Rebuilding completion detection by parsing terminal output would be both redundant and far less reliable.

### Why not just reuse the oversight pass

`OversightPassService` tracks exactly one in-flight card per lane and **halts the entire pass** on any failure or stuck-timeout. Both properties are correct for a serial conveyor and wrong for a wide batch, where one bad agent out of twenty must not stop the other nineteen. This plan reuses oversight's *signal source and state-file discipline*, not its state machine.

## Metadata

**Complexity:** 6
**Tags:** backend, api, reliability, feature

## Reconcile Before Building

Unpushed local work may already have added batch tracking. Before coding: `curl -s "$BASE/catalog"`, then `grep -n "batch" src/services/LocalApiServer.ts src/services/TaskViewerProvider.ts`. If a status endpoint exists, extend its payload rather than adding a second one, and note the deviation in the implementation summary.

## Design

### Completion signal

`AgentBatchService.attachWatcher(watcher: GlobalPlanWatcherService)` — mirror `OversightPassService.attachWatcher` at line 147.

For each agent whose `ref` resolves to a known planId, record the plan file's mtime at spawn time. An `onPlanDiscovered` event for that file with an **advanced** mtime marks the agent `completed`.

**Non-plan refs have no semantic completion signal and must not fake one.** When `ref` does not resolve to a plan, the agent's terminal state is `exited` — reported honestly, never upgraded to `completed`. The primitive is general; the completion layer is opportunistic.

### Per-agent state machine

```
queued → running → completed   (mtime advanced)
                 → exited      (process exited, no mtime advance, or non-plan ref)
                 → failed      (spawn error)
                 → stuck       (exceeded stuckThresholdMs, still running)
```

`stuck` is a **report-only** classification. It does not kill the terminal, does not free the slot, and does not halt the batch — it exists so the supervisor's digest can name what needs a human. Default `stuckThresholdMs` mirrors the oversight default; make it overridable per batch.

An agent that exits without advancing its plan's mtime is `exited`, not `completed`. That distinction is the single most load-bearing output of this plan: it is what turns a silent no-op into a visible line in the digest.

### Status endpoint

```
GET /agents/batch/status?workspaceRoot=/repo[&batchId=...]
```

Returns `{ success: true, data: { ... } }` per the read-endpoint envelope convention:

```
{
  batchId, label, state,        // running | ended | stopped
  concurrency,
  queued:    [{ ref }],
  running:   [{ ref, topic, spawnedAt, elapsedSeconds, stuck }],
  completed: [{ ref, topic, durationSeconds }],
  exited:    [{ ref, topic, durationSeconds }],
  failed:    [{ ref, topic, reason }],
  counts:    { total, queued, running, completed, exited, failed, stuck }
}
```

`counts` exists so a supervisor can poll cheaply without parsing arrays. `topic` is the plan title where the ref resolves, otherwise the ref itself — never the plan body. **The status payload must never include plan file content**; that guarantee is what keeps the supervisor's context flat as batch size grows.

Add `POST /agents/batch/stop { workspaceRoot, batchId }` — drains the queue and stops spawning new agents. Already-running terminals are left alone; killing an agent mid-write is how you get a half-written plan file. Mirrors `/oversight/stop` semantics.

### Durability

The extension is the **sole writer** of `.switchboard/agent-batches/<batchId>.md` (state, rewritten per state change) and an append-only batch log, mirroring the oversight discipline where the extension solely owns `oversight-state.md` and `oversight-log.md`. Agents read these; agents never write them.

`resumeFromDisk(workspaceRoots)` — on reactivation, reload in-flight batches. Agents whose terminals are gone are reclassified from `running` to `exited` (or `completed` if their plan's mtime advanced while the extension was down, which is detectable from the recorded spawn-time mtime). **Never re-spawn on resume** — the oversight engine's "resumes an in-flight pass without re-dispatching" rule applies with equal force here, and doubly so at width.

Retain state files for completed batches long enough for a supervisor to fetch the final digest after the batch ends; prune on a sweep rather than deleting at end-of-batch.

## Verification Plan

1. **Unit — completion vs exit.** Agent A's plan file mtime advances then the process exits → `completed`. Agent B's process exits with no mtime change → `exited`. Assert B is never reported `completed`.
2. **Unit — non-plan ref.** A ref that resolves to no plan lands in `exited` on process exit and never in `completed`.
3. **Unit — stuck is report-only.** Drive an agent past `stuckThresholdMs`; assert `stuck: true` in `running[]`, the terminal is not killed, the slot is not freed, and `state` remains `running`.
4. **Unit — failure isolation.** One `failed` agent in a batch of five: assert `state` never becomes `halted`, and the other four reach terminal states.
5. **Unit — no plan bodies.** Snapshot the status payload for a batch of plans with large bodies; assert no plan file content appears and payload size is independent of body size.
6. **Unit — resume without re-spawn.** Persist a batch with two `running` agents, simulate reactivation, assert `resumeFromDisk` re-classifies them and issues **zero** spawn calls.
7. **Unit — mtime-advanced-while-down.** Persist a `running` agent, advance its plan mtime, then resume → `completed`, not `exited`.
8. **Contract — stop.** `POST /agents/batch/stop` empties `queued[]`, issues no new spawns, and leaves `running[]` terminals alive.
9. **Manual (VSIX).** Run a 4-agent batch where one agent is given a prompt that exits without editing its plan. Confirm the status endpoint reports 3 `completed` and 1 `exited`, and that the distinction is visible without reading any plan file.

## Dependencies

- **Agent Batch Spawn Primitive** (`agent-batch-spawn-primitive.md`) — this plan consumes the `batchId`, the per-agent `ref`, and the pool's lifecycle events. Build that first.
