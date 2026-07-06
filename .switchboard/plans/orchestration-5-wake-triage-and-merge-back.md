# Orchestration Wake + Triage Loop with Feature-by-Feature Merge-Back

## Metadata
**Complexity:** 8
**Tags:** backend, feature, automation, reliability
**Project:** Switchboard

## Goal

Close the loop: on each preconfigured interval, the *system* wakes the orchestrator; it drains the request inbox, verifies real progress against git and board state, writes a triage summary to the session log, and acts — advancing stages, dispatching research, escalating planner-stage or unresolvable items to the human, and merging completed features back (feature by feature, resolving conflicts). The batch ends when every feature is merged or escalated.

### Problem / background / root cause

Kickoff (subtask 4) leaves the fleet running and the orchestrator asleep. Something has to reconvene it, and the decision is explicit: **the system wakes it, not itself.** The autoban engine already ticks on `intervalMinutes` with `lastTickAt` tracking (`src/services/autobanState.ts`), which is exactly the heartbeat needed — in Orchestration mode the tick, instead of doing per-column dispatch, re-invokes the orchestrator with a "check status" wake. On wake the orchestrator must judge progress from **ground truth** (git branch ahead of base, commits, tests, card column) because an agent reporting "done" is unreliable; the inbox (subtask 3) carries the questions it must triage; and merge-back is the terminal action that retires each feature.

## Detailed changes

### 1. Wake hook (autoban tick, orchestration mode)

- In the autoban tick path, when `automationMode === 'orchestration'`, replace per-column dispatch with an orchestrator **wake**: send the orchestrator terminal a "wake: check status" prompt. Reuse the existing `intervalMinutes` + `lastTickAt` machinery and the single-flight guard so overlapping wakes don't stack (mirror the `_polling` guard pattern used by `RemoteControlService._poll`).
- Respect pause/stop: pausing the automation pauses wakes; stopping ends the loop.

### 2. Triage (orchestrator behaviour, per subtask-2 persona)

- **Drain inbox** (`.switchboard/orchestrator/inbox/`): for each request, decide an action by type — answer/act on a coder/reviewer question, dispatch a **research agent** for a well-formed research request, or **escalate** planner-stage questions and anything ambiguous/unresolvable to the human.
- **Verify progress from git/board**, not self-report: a subtask counts as coded only when its worktree branch is ahead of base with committed work (and tests where applicable); reviewed only when the review stage genuinely passed. Advance cards via `/kanban/move` accordingly.
- **Session log**: append a dated summary each wake — read, verified, advanced/dispatched/merged, escalated.
- Move processed inbox items to `processed/`.

### 3. Merge-back (feature by feature)

- When all of a feature's subtasks are code-reviewed, the orchestrator performs the **agent-driven merge** following the `merge-prompt` pattern: subtask branches → the feature integration branch → main, **resolving conflicts as it goes** (never a bare `git merge` that dead-ends). Do one feature at a time to keep the conflict surface contained.
- On success, request worktree cleanup via the existing `worktree_cleanup` skill / `/worktree/cleanup`. On a conflict the agent cannot resolve, leave the worktree intact and **escalate** to the human via the session log.

### 4. Termination

- When every feature is merged or escalated, the batch is done: write a final session-log summary and stop (or idle) the orchestration loop, mirroring how `PipelineOrchestrator` auto-stops when nothing is pending.

## Edge cases & constraints

- **Stalled agent.** No git progress across a configurable number of wakes → escalate rather than spin forever.
- **Overlapping wakes.** Single-flight guard; a wake that arrives while the previous is still working is skipped (re-fires next tick).
- **Partial feature.** Don't merge a feature until *all* its subtasks are reviewed; a half-done feature stays in progress.
- **Planner escalation is a hard boundary** — planner-stage questions are never auto-answered.
- **Verification beats optimism** — if git says no work landed, the subtask is not "done" regardless of what the agent wrote.

## Testing

- Simulated wake with git progress advances the right cards; without progress, nothing advances and a stall eventually escalates.
- Inbox drain routes each request type correctly (act / research / escalate) and marks items processed.
- A clean feature merges subtask → integration → main and triggers cleanup; an unresolvable conflict escalates and leaves the worktree.
- Loop terminates and reports when all features are merged/escalated; overlapping wakes are single-flighted.

## Out of scope

- The Notion command channel (directive in / status out) — deferred per the feature doc. Wake is driven by the autoban interval, reported via the session log.
