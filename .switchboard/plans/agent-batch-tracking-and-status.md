# Agent Batch Observability: Completion Detection, Report-Back Channel, and Status

## Goal

Give headless batches a complete observability surface: semantic completion detection, a report-back channel so silent agents can raise questions and research requests, per-agent failure isolation, and a single status endpoint the supervising agent polls in short turns.

### The problem

Headless batch agents are invisible by design — they do not render in the terminals UI, are not registered in `runtime.terminals`, and are never typed into. That buys cost control and parallelism, and it removes every informal channel a human normally relies on. Without a deliberate observability layer, a batch is a black box that answers exactly one question ("did the processes exit?") and cannot distinguish:

- an agent that improved its plan and exited cleanly,
- an agent that exited having written nothing,
- an agent still working at minute nine,
- an agent wedged waiting for an approval nobody will give, and
- an agent that got partway, hit a genuine ambiguity, and needs a decision.

The last case is the one that pure process-level monitoring can never surface. A headless agent that needs to ask something has no interlocutor: it cannot prompt a human, and nothing is attached to its stdout. Without an explicit channel it will do the worst available thing — guess, and write the guess into a plan file.

### Root cause

Two separate gaps, often conflated:

1. **Completion is semantic, not process-level.** Process exit is a host event; task completion is a domain event. `GlobalPlanWatcherService` already emits `onPlanDiscovered` (`src/services/GlobalPlanWatcherService.ts:44-48`), and `OversightPassService.attachWatcher()` (line 147) already consumes exactly this signal. The plan-file-mtime-advance completion contract is established behavior (`switchboard-contracts`: *completion = plan-file mtime advance*; *plan files are write-once-at-the-end*). The signal and the consumption pattern both exist — they are simply not wired to batches.
2. **There is no agent→supervisor channel for batches.** `POST /orchestrator/request` (`LocalApiServer.ts:2126`) writes to `.switchboard/orchestrator/inbox/` and is drained by the **orchestrator persona** on its next wake. A batch supervisor is not the orchestrator, does not run that wake loop, and must not have batch questions land in a queue it never reads.

### Why not just reuse the oversight pass

`OversightPassService` tracks one in-flight card per lane and **halts the entire pass** on any failure or stuck-timeout. Both are correct for a serial conveyor and wrong at width, where one bad agent out of twenty must not stop the other nineteen. This plan reuses oversight's *signal source and state-file discipline*, not its state machine.

## Metadata

**Complexity:** 7
**Tags:** backend, api, reliability, feature

## Reconcile Before Building

Unpushed local work may already have added batch tracking. Before coding: `curl -s "$BASE/catalog"`, then `grep -n "batch" src/services/LocalApiServer.ts src/services/TaskViewerProvider.ts`. Extend an existing status endpoint rather than adding a second; note any deviation in the implementation summary.

## Design

### Completion signal

`AgentBatchService.attachWatcher(watcher: GlobalPlanWatcherService)` — mirror `OversightPassService.attachWatcher` (line 147).

For each agent whose `ref` resolves to a known planId, record the plan file's mtime at spawn. An `onPlanDiscovered` event for that file with an **advanced** mtime marks the agent `completed`.

**Non-plan refs have no semantic completion signal and must not fake one.** When `ref` resolves to no plan, the agent terminates at `exited` — reported honestly, never upgraded to `completed`. The primitive is general; this completion layer is opportunistic.

### Per-agent state machine

```
queued → running → completed   (plan-file mtime advanced)
                 → exited      (process exited, no mtime advance, or non-plan ref)
                 → failed      (spawn error, or non-zero exit with no mtime advance)
                 → timedOut    (hard wall-clock cap: killed, slot freed)
```

with a **`stuck` flag**, not a state: set on a `running` agent that has exceeded the soft threshold, cleared if it progresses.

The soft/hard split matters specifically because these agents are headless. `stuck` is **report-only** — it does not kill, free the slot, or halt the batch; it exists so the digest can name what needs a human. `timedOut` is the hard backstop owned by the spawn primitive's pool: with nobody watching, an unbounded hang holds a slot forever and can wedge the batch below its configured width. Set the hard cap generously (and per-role overridable), because plan files are written once at the end and killing an agent mid-write is the one way this feature can corrupt data.

**`exited` is not `completed`.** An agent whose process ended without its plan's mtime advancing produced nothing. This distinction is the single most load-bearing output of this plan — it is what turns a silent no-op into a visible line in the digest, and what stops the mass-improve plan from promoting unimproved work.

### Report-back channel

New endpoint, batch-scoped so reports land where the supervisor is already looking:

```
POST /agents/batch/report
{ "batchId": "...", "ref": "a1b2c3d4", "type": "question" | "research" | "blocker" | "note", "body": "..." }
```

Design rules:

- **Reports surface in `GET /agents/batch/status`, not a separate queue.** The supervisor already polls status; a second channel it must remember to drain is a channel it will forget to drain. This is precisely the failure mode of routing batch questions to `/orchestrator/request`, whose inbox only the orchestrator persona wakes on.
- **Filing a report never blocks the agent and never pauses the batch.** A headless agent cannot wait for an answer — there is no session to resume. It files, then either proceeds under a stated assumption or stops and exits; the prompt contract (owned by the supervisor-contract plan) tells it which. The endpoint returns immediately and is best-effort: a failed report must never crash the agent or abort its work.
- **`type: "research"` is filed, not dispatched.** Batch agents must **not** call `/research/dispatch` directly: that endpoint requires a live `researcher`-role terminal and is documented to return `{dispatched: false}` rather than spawn one (`LocalApiServer.ts:246`). From a headless agent with no observer, a `dispatched: false` is a silent drop. The supervisor decides whether to forward a filed research request to `/research/dispatch` or surface it to the human.
- **Cap and truncate.** Bound reports per agent and body length; a looping agent must not be able to flood the supervisor's context — which is the one resource this architecture exists to protect.
- Persist reports in the batch state so they survive reactivation and remain readable after the batch ends.

### Status endpoint

```
GET /agents/batch/status?workspaceRoot=/repo[&batchId=...]
```

Returns `{ success: true, data: {...} }` per the read-endpoint envelope convention:

```
{
  batchId, label, state,          // running | ended | stopped
  concurrency,
  providers: { "improver-cheap": { label: "Gemini CLI (personal sub)", agents: 14 } },
  queued:    [{ ref }],
  running:   [{ ref, topic, role, spawnedAt, elapsedSeconds, stuck }],
  completed: [{ ref, topic, role, durationSeconds }],
  exited:    [{ ref, topic, role, durationSeconds }],
  failed:    [{ ref, topic, role, reason }],
  timedOut:  [{ ref, topic, role, durationSeconds }],
  reports:   [{ ref, topic, type, body, at }],
  counts:    { total, queued, running, completed, exited, failed, timedOut, stuck, reports }
}
```

- `counts` exists so the supervisor can poll cheaply without parsing arrays.
- `providers` answers "what did this batch bill?" directly — the cost-control question that motivates headless dispatch. Roles and `label`s only; **never `env`**, which holds provider credentials.
- `topic` is the plan title where the ref resolves, else the ref. **The status payload must never include plan file content** — that guarantee is what keeps the supervisor's context flat as batch size grows.

Add `POST /agents/batch/stop { workspaceRoot, batchId }`: drains the queue, stops spawning, and leaves already-running agents alone — killing one mid-write is how a plan file gets corrupted. Mirrors `/oversight/stop`.

### Durability

The extension is the **sole writer** of `.switchboard/agent-batches/<batchId>.md` (state, rewritten per state change) and an append-only batch log, mirroring the oversight discipline for `oversight-state.md` / `oversight-log.md`. Agents read these; agents never write them.

`resumeFromDisk(workspaceRoots)` — on reactivation, reload in-flight batches, verify recorded PIDs, and re-classify: a dead PID whose plan mtime advanced while the extension was down becomes `completed` (detectable from the recorded spawn-time mtime); otherwise `exited`. **Never re-spawn on resume** — oversight's "resumes an in-flight pass without re-dispatching" rule applies with more force at width. Retain completed-batch state long enough for a supervisor to fetch the final digest; prune on a sweep, not at end-of-batch.

## Verification Plan

1. **Unit — completion vs exit.** Plan mtime advances then process exits → `completed`. Process exits with no mtime change → `exited`. Assert the latter is never reported `completed`.
2. **Unit — non-plan ref.** A ref resolving to no plan lands in `exited`, never `completed`.
3. **Unit — stuck vs timedOut.** Past the soft threshold: `stuck: true`, process alive, slot held, `state` still `running`. Past the hard cap: `timedOut`, process killed, slot freed, next agent spawns.
4. **Unit — failure isolation.** One `failed` agent among five: `state` never becomes `halted`; the other four reach terminal states.
5. **Unit — reports surface in status.** A filed report appears in `reports[]` and increments `counts.reports` on the next status call, with no separate drain step.
6. **Unit — report is non-blocking and best-effort.** The endpoint returns without waiting for a supervisor; a forced failure of the report write does not change the agent's state or the batch's.
7. **Unit — report flood cap.** An agent filing beyond the cap is truncated/rejected; assert the status payload stays bounded.
8. **Unit — research is filed, not dispatched.** Assert no batch code path calls `/research/dispatch`; a `type: "research"` report lands in `reports[]`.
9. **Unit — no plan bodies, no secrets.** Snapshot the status payload for plans with large bodies and a role with `env` credentials: assert no plan content appears, payload size is independent of body size, and no `env` value appears anywhere.
10. **Unit — resume without re-spawn.** Persist a batch with two `running` agents; simulate reactivation; assert re-classification and **zero** spawn calls.
11. **Unit — mtime-advanced-while-down.** Persist a `running` agent, advance its plan mtime, resume → `completed`, not `exited`.
12. **Contract — stop.** Empties `queued[]`, issues no new spawns, leaves `running[]` processes alive.
13. **Manual (VSIX).** Run a 4-agent batch where one prompt exits without editing its plan and another files a `question` report. Confirm status shows 3 `completed` / 1 `exited`, the question appears in `reports[]`, and both are legible without reading any plan file.

## Dependencies

- **Headless Agent Batch Spawn Primitive** (`agent-batch-spawn-primitive.md`) — supplies `batchId`, per-agent `ref`, the pool's lifecycle events, PID records, and the hard-timeout mechanism this plan classifies.
