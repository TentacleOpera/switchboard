# Remove mtime-based completion detection

## Goal

Remove the mtime-based completion detection from `PlanIngestionEngine.ts` — both the real-time watcher and the periodic sweep. After the sibling subtasks add the queue/done instruction to team coders, update all completion directives to reference the API POST, and wire the completion callbacks into `_runQueueDone`, the API POST is the sole completion trigger. The mtime-based detection must be removed or it will race with the API path and cause premature turn-end on mid-work plan file edits.

### Background

This is Part 4 of the feature "Replace mtime-based completion detection with explicit API-based completion." **This subtask depends on the other three subtasks being complete** — removing the mtime watcher before the API path is in place would leave cards stuck with no completion signal until the 20-minute timeout.

### Root cause

Commit `c5185aa8` (Jul 7) replaced content-based completion detection (the `**Stage Complete:**` marker) with mtime-based detection. The reasoning was: "the dispatch flow does not write the plan file, so any mtime advance reaching here while dispatched_at is set is the agent's completion edit." This assumption is wrong — the agent can edit the plan file mid-work for many reasons (partial completion reports, plan updates, notes). The file watcher has no way to distinguish a mid-work edit from a completion edit.

### What this subtask does

1. Removes the real-time watcher's mtime-based completion block (replaces with a log line).
2. Removes the periodic sweep's mtime-based completion check.
3. Keeps `clearStaleWorkingState` (20-minute timeout) as the fallback.
4. Updates the `TurnEndInfo` interface comment.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, refactor
**Project:** Browser Switchboard

## User Review Required

This subtask removes the mtime-based completion detection entirely. If a coder or reviewer fails to POST `/kanban/queue/done` (e.g., the API server is not running, the agent doesn't comply with the instruction, or the agent crashes), the only fallback is the 20-minute timeout sweep (`clearStaleWorkingState`). The user should confirm this timeout is acceptable as the sole fallback before implementation proceeds.

## Proposed Changes

### 4a. Remove the real-time watcher completion detection — `src/services/PlanIngestionEngine.ts` (~lines 2096-2145)

Remove the `if (updatedRecord.dispatchedAt)` block that calls `clearWorkingState` and fires the turn-end notifier on plan file mtime advance. The file watcher still updates plan metadata (metadata parsing, DB upsert, feature links, ClickUp sync) — it just no longer treats a plan file edit as a completion signal.

Replace with a log line noting that mtime-based completion is retired:
```ts
if (updatedRecord.dispatchedAt) {
    this._host.logger.appendLine(
        `[GlobalPlanWatcher] Plan file edited while dispatched (mtime-based completion retired — waiting for POST /kanban/queue/done): ${relativePath}`
    );
}
```

### 4b. Remove the sweep's mtime-based completion detection — `src/services/PlanIngestionEngine.ts` (~lines 592-631)

The periodic sweep currently checks `stat.mtimeMs > dispatchedMs` and calls `clearWorkingState` if true. Remove this check — the sweep should only use the silence/blocked detection (the `else if (!record.blockedAt)` arm at line 632) and the timeout fallback.

Remove the mtime check and the `if (completed)` arm. Keep the `else if (!record.blockedAt)` arm (silence → blocked) and the timeout sweep (`clearStaleWorkingState`).

### 4c. Keep `clearStaleWorkingState` (timeout) as the fallback — no change

The 20-minute timeout sweep (`clearStaleWorkingState`) remains as the safety net for when a coder never calls the API (crash, stuck, etc.). This is the correct fallback — it's a timeout, not a false-positive on mid-work edits.

### 4d. Update the `TurnEndInfo` interface comment — `src/services/PlanIngestionEngine.ts` (~line 88)

```ts
/** `completed` = the seat POSTed /kanban/queue/done (the seat finished);
 *  `blocked` = silence without a report;
 *  `stalled` = the feature-level nudge — no dispatch is outstanding, the head went idle with
 *  un-accepted subtasks remaining, and the engine is waking it with evidence. */
outcome: 'completed' | 'blocked' | 'stalled';
```

## What does NOT change

- `clearStaleWorkingState` (timeout sweep) — remains as the fallback.
- The silence/blocked detection — the sweep's `else if (!record.blockedAt)` arm is unchanged.
- File watcher metadata updates — the watcher still parses metadata, upserts the DB, syncs feature links and ClickUp. Only the completion detection is removed.

## Verification Plan

### Automated Tests
1. `node --check src/services/PlanIngestionEngine.ts` — syntax check
2. Run `src/test/queue-pipeline-contract.test.js` — updated mtime/clearWorkingState assertions pass (the comment at line 189 should be updated to reflect API-based completion)

### Manual Verification
3. Grep `if (updatedRecord.dispatchedAt)` in `PlanIngestionEngine.ts` — confirm the mtime-based `clearWorkingState` call is removed (only the log line remains)
4. Grep `stat.mtimeMs > dispatchedMs` in `PlanIngestionEngine.ts` — confirm the sweep's mtime-based completion check is removed
5. Manual: dispatch a subtask to a team coder, wait for the coder to POST /kanban/queue/done, confirm the lead receives the turn-end notification and the card's activity light clears
6. Manual: dispatch a multi-part plan to a team coder, confirm that a mid-work plan file edit does NOT trigger turn-end notification or card movement
7. Manual: dispatch a review task to a reviewer, wait for the reviewer to POST /kanban/queue/done, confirm the lead receives the turn-end notification and the card's activity light clears

## Completion Report

Removed mtime-based completion detection from both paths in `PlanIngestionEngine.ts`: the real-time watcher's `clearWorkingState` + callback block (replaced with a log line noting mtime-based completion is retired) and the periodic sweep's mtime stat loop + `if (completed)` arm (removed entirely, keeping only the `!record.blockedAt` silence/blocked arm and the `clearStaleWorkingState` timeout fallback). Updated the `TurnEndInfo` interface comment to reference POST /kanban/queue/done, removed the now-unused `matchWorktreePath` import, and updated the test comment in `queue-pipeline-contract.test.js`. Files changed: `src/services/PlanIngestionEngine.ts`, `src/test/queue-pipeline-contract.test.js`. No issues encountered; grep checks (steps 3–4) confirm both mtime paths are removed. Compile and tests skipped per session directives.

## Review Findings

Removal itself is clean — the sweep keeps only the `!record.blockedAt` blocked arm plus the `clearStaleWorkingState` timeout, the watcher's dropped `updatedRecord.dispatchedAt = null` mutation had no downstream consumer (`plan` only feeds the ClickUp payload), and the unused `matchWorktreePath` import is gone. MAJOR fixed: this subtask left `src/test/terminal-plan-attribution-contract.test.js` RED — three CI-wired assertions pinned the removed code (`matchWorktreePath` in the silence branch, the file-edit clear firing the notifier, and two `outcome: 'completed'` engine call sites); all three are migrated to the new contract (sweep must NOT stat plan files or clear, the file-edit path must NOT clear or notify, and the single `completed` producer is `_runQueueDone` with a composed body). Also fixed: the now-false docblocks on `setOnWorkingStateCleared` (dormant — the engine has no producer left, both hosts receive the live event from the API path) and on the turn-end seam (it no longer has a `completed` arm), in `PlanIngestionEngine.ts`, `extension.ts` and `bootstrap.ts`. Verified: `compile-tests` clean, eslint 0 errors, `terminal-plan-attribution` 41/41, `queue-pipeline` green. Remaining risk accepted per the plan's User Review Required section — the 20-minute timeout is the sole fallback, and the silence sweep can now stamp a finished-but-quiet seat `blocked` before its POST lands, producing a false blocked notice ahead of the real completed one.
