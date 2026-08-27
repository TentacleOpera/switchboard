# Remove redundant COMPLETED column read in PlanIngestionEngine feature sweep and move its contract pin

## Goal

Goal Invariant 2 of "A completed card is not in flight" says the only surviving column read in `PlanIngestionEngine.ts` is `=== 'STAGING'`. But the feature sweep's `remaining` filter at `PlanIngestionEngine.ts:1184` still reads `s.kanbanColumn !== 'COMPLETED'` as a done inference:

```typescript
const remaining = subtasks.filter(s => s.kanbanColumn !== 'COMPLETED' && !s.completedAt);
```

This column read is redundant: `getSubtasksByFeatureId` already filters `status = 'active'` (line 1172–1174, confirmed at `KanbanDatabase.ts:6652`), and reaching COMPLETED sets `status = 'completed'` (via feature auto-complete at `KanbanDatabase.ts:5587` and startup V3 migration at `KanbanDatabase.ts:7417`), so those rows are already absent from the query results. The `!s.completedAt` check is the real termination condition.

The column read is harmless in the normal case but violates Goal Invariant 2. Removing it is safe — but `completion-asserted-never-inferred.test.js:331` actively PINS it as required:

```javascript
assert.ok(/kanbanColumn !== 'COMPLETED' && !s\.completedAt/.test(planEngineSrc),
    'the feature sweep must treat a subtask as remaining only until its completion post');
```

So removing the column read requires moving the pin in the same change.

**Root cause:** The `kanbanColumn !== 'COMPLETED'` clause was added as a belt-and-suspenders check before the `completedAt` field existed. Once `completedAt` became the canonical completion signal and `getSubtasksByFeatureId` started filtering `status = 'active'`, the column read became redundant. The contract test was written to pin the combined expression, including the redundant clause.

## Metadata

**Complexity:** 3
**Tags:** refactor, test, backend
**Project:** Browser Switchboard

## User Review Required

No user review required. The change is a single-line refactor (remove redundant clause) plus a test-pin update in the same change. The removal is verified safe by the `getSubtasksByFeatureId` `status = 'active'` filter and the `completedAt` canonical signal. The one behavior change (zombie exposure — see Edge-Case Audit) is an improvement, not a regression.

## Complexity Audit

### Routine
- Remove the `s.kanbanColumn !== 'COMPLETED' &&` clause from the `remaining` filter at `PlanIngestionEngine.ts:1184`.
- Update the contract pin in `completion-asserted-never-inferred.test.js:330–332` to assert only `!s.completedAt` (without the column check), plus a negative assertion that `kanbanColumn !== 'COMPLETED'` is absent from `PlanIngestionEngine.ts`.

### Complex / Risky
- The removal is safe because `getSubtasksByFeatureId` already filters `status = 'active'` (`KanbanDatabase.ts:6652`), and completed subtasks have `status = 'completed'` (set atomically by feature auto-complete at `KanbanDatabase.ts:5587`, and repaired by V3 migration at `KanbanDatabase.ts:7417`). The column read is a no-op on the query results in the normal case.
- The contract pin must be updated in the same change — otherwise the test goes red.
- Must verify that no other code path depends on the `remaining` filter including the column check. The filter is local to the feature nudge watch loop (line 1184). Verified: `kanbanColumn !== 'COMPLETED'` appears at exactly two sites in `src/` — the code at `PlanIngestionEngine.ts:1184` and the test pin at `completion-asserted-never-inferred.test.js:331`. No other references.
- **Zombie-window behavior change (see Edge-Case Audit):** `movePlanByPlanFile` (`KanbanDatabase.ts:2916`) sets `kanban_column` without setting `status` or `completed_at`. A subtask dragged to COMPLETED without a completion post creates a zombie (`status='active'`, `kanban_column='COMPLETED'`, `completed_at=NULL`). The old column check masked these zombies; the new code exposes them. This is an improvement — see Edge-Case Audit for full analysis.

## Edge-Case & Dependency Audit

- **`PlanIngestionEngine.ts:1172–1177`:** The comment explicitly states: "getSubtasksByFeatureId filters status = 'active'; reaching COMPLETED sets status = 'completed', so those rows are already absent. `completed_at` is on every row the query returns." This confirms the column read is redundant in the normal case.
- **`completion-asserted-never-inferred.test.js:331`:** The pin asserts the combined expression. After removal, the pin should assert only `!s.completedAt` in the `remaining` filter context, plus a negative assertion that `kanbanColumn !== 'COMPLETED'` is absent from the file.
- **`completion-asserted-never-inferred.test.js:323–329`:** The queue-watch in-flight predicate pin (already rewritten to whole-body) asserts `!kanbanColumn` is NOT in the predicate. This is a different code path (the queue watch, not the feature sweep) and is unaffected.
- **Goal Invariant 2:** "The only surviving column read in PlanIngestionEngine.ts is `=== 'STAGING'`." After removing the `!== 'COMPLETED'` read, this invariant is satisfied. Verified: the only remaining `kanbanColumn` comparison in `PlanIngestionEngine.ts` is `p.kanbanColumn === 'STAGING'` at line 1437. All other `kanbanColumn` references are display/logging strings or assignments, not completion inferences.
- **Zombie-window analysis (verified against source):**
  - `setCompletedAt` (`KanbanDatabase.ts:3058`) sets ONLY `completed_at` — not `status`, not `kanban_column`. This is the lead's POST /kanban/task/complete handler.
  - `movePlanByPlanFile` (`KanbanDatabase.ts:2916`) sets ONLY `kanban_column` — not `status`, not `completed_at`. This is the card-move path (user drag, system auto-move).
  - Feature auto-complete (`KanbanDatabase.ts:5587`) sets `status = 'completed'` AND `kanban_column = 'COMPLETED'` atomically for all subtasks — but NOT `completed_at`.
  - V3 migration (`KanbanDatabase.ts:7417`) repairs zombies (`status='active'` + `kanban_column='COMPLETED'`) at startup only. No runtime reconcile exists.
  - **Zombie scenario:** A subtask dragged to COMPLETED via `movePlanByPlanFile` without a completion post has `status='active'`, `kanban_column='COMPLETED'`, `completed_at=NULL`. `getSubtasksByFeatureId` (filters `status='active'`) RETURNS it.
    - Old code: `s.kanbanColumn !== 'COMPLETED' && !s.completedAt` → `false && true` → `false` → excluded from `remaining`. The watch can drop, masking unposted work as done.
    - New code: `!s.completedAt` → `true` → included in `remaining`. The watch keeps watching and nudges the head.
    - **This is the correct behavior** per the "completion is asserted, never inferred" philosophy (comments at `PlanIngestionEngine.ts:1160–1170` and `LocalApiServer.ts:1775–1776`). A zombie in COMPLETED column without a `completed_at` post is NOT completed by the canonical signal. The old column check was silently treating unposted work as done — exactly the inference the architecture rejects. The new code exposes the zombie, prompting the head to post completion.
- **No other consumers:** The `remaining` variable is local to the feature nudge watch loop. It feeds `remaining.length === 0` (drop-watch decision, line 1185), `remaining.some(s => !!s.dispatchedAt)` (outstanding-dispatch check, line 1197), and `remaining.some(s => !!s.dispatchedTerminal && ...)` (seat-notified check, line 1217). All three read `remaining` as a set of not-yet-completed subtasks. Removing the column check only adds zombies back into this set — which is correct (they ARE not-yet-completed by the canonical signal).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) zombie-window behavior change — subtasks in COMPLETED column without a completion post are no longer masked, keeping the feature nudge watch alive; this is an improvement, not a regression, but changes observable behavior. (2) The negative test assertion `!/kanbanColumn !== 'COMPLETED'/.test(planEngineSrc)` is a whole-file scan — a future comment or string literal containing that exact expression would break the test. Mitigations: (1) the zombie exposure aligns with the asserted-completion philosophy and the watch is designed to keep watching until all subtasks have completion posts; (2) the regex is specific enough (`kanbanColumn !== 'COMPLETED'` as a literal string) that incidental comment matches are unlikely, and the existing `CODING_COLUMNS` whole-file check at line 312 sets the same precedent.

## Proposed Changes

### 1. `src/services/PlanIngestionEngine.ts` — remove redundant column read

Change line 1184 from:

```typescript
const remaining = subtasks.filter(s => s.kanbanColumn !== 'COMPLETED' && !s.completedAt);
```

to:

```typescript
const remaining = subtasks.filter(s => !s.completedAt);
```

### 2. `src/test/completion-asserted-never-inferred.test.js` — update the pin

Change lines 330–332 from:

```javascript
// The feature sweep's remaining-subtask filter must read it too.
assert.ok(/kanbanColumn !== 'COMPLETED' && !s\.completedAt/.test(planEngineSrc),
    'the feature sweep must treat a subtask as remaining only until its completion post');
```

to:

```javascript
// The feature sweep's remaining-subtask filter must read completedAt.
// The kanbanColumn !== 'COMPLETED' clause was removed as redundant
// (getSubtasksByFeatureId already filters status = 'active').
assert.ok(/remaining.*=.*subtasks\.filter\(s => !s\.completedAt\)/.test(planEngineSrc),
    'the feature sweep must treat a subtask as remaining only until its completion post (completedAt)');
assert.ok(!/kanbanColumn !== 'COMPLETED'/.test(planEngineSrc),
    'PlanIngestionEngine must not carry a kanbanColumn !== COMPLETED read — getSubtasksByFeatureId already filters status = active');
```

**Note on the negative assertion message:** The assertion `!/kanbanColumn !== 'COMPLETED'/.test(planEngineSrc)` scans the whole file, not just the feature sweep. The message is updated to say "PlanIngestionEngine must not carry..." (file-level) rather than "the feature sweep must not read..." (site-level), matching the whole-file scope of the check and the precedent set by the `CODING_COLUMNS` whole-file check at line 312.

## Verification Plan

### Automated Tests
1. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/completion-asserted-never-inferred.test.js` — assert exit code 0.
2. Run `npm run test:contract:completion-asserted-never-inferred` — assert exit code 0.
3. Run `npm run test:contract:queue-stall-watch` — assert exit code 0 (verify no regression in the related queue-watch gate).
4. Run the full contract suite — assert no regressions.

### Goal Invariants
- **Negative (removal):** Assert `kanbanColumn !== 'COMPLETED'` is absent from `src/services/PlanIngestionEngine.ts` — `grep -c "kanbanColumn !== 'COMPLETED'" src/services/PlanIngestionEngine.ts` returns 0.
- **Positive (replacement):** Assert the `remaining` filter reads `!s.completedAt` without the column clause — `grep -n "const remaining = subtasks.filter(s => !s.completedAt)" src/services/PlanIngestionEngine.ts` returns exactly one match at line 1184.
- **Positive (surviving column read):** Assert `=== 'STAGING'` is the only surviving column comparison — `grep -n "kanbanColumn ===" src/services/PlanIngestionEngine.ts` returns exactly one match at line 1437.
- **Positive (test pin moved):** Assert the new positive pin exists in the test file — `grep -c "remaining.*subtasks\.filter.*!s\.completedAt" src/test/completion-asserted-never-inferred.test.js` returns at least 1.
- **Negative (test pin moved):** Assert the old combined-expression pin is gone from the test file — `grep -c "kanbanColumn !== 'COMPLETED' && !s" src/test/completion-asserted-never-inferred.test.js` returns 0.
