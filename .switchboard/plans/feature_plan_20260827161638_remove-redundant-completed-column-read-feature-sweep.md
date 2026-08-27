# Remove redundant COMPLETED column read in PlanIngestionEngine feature sweep and move its contract pin

## Goal

Goal Invariant 2 of "A completed card is not in flight" says the only surviving column read in `PlanIngestionEngine.ts` is `=== 'STAGING'`. But the feature sweep's `remaining` filter at `PlanIngestionEngine.ts:1184` still reads `s.kanbanColumn !== 'COMPLETED'` as a done inference:

```typescript
const remaining = subtasks.filter(s => s.kanbanColumn !== 'COMPLETED' && !s.completedAt);
```

This column read is redundant: `getSubtasksByFeatureId` already filters `status = 'active'` (line 1172–1174), and reaching COMPLETED sets `status = 'completed'`, so those rows are already absent from the query results. The `!s.completedAt` check is the real termination condition.

The column read is harmless but violates Goal Invariant 2. Removing it is safe — but `completion-asserted-never-inferred.test.js:331` actively PINS it as required:

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

## Complexity Audit

**Routine:**
- Remove the `s.kanbanColumn !== 'COMPLETED' &&` clause from the `remaining` filter.
- Update the contract pin in `completion-asserted-never-inferred.test.js` to assert only `!s.completedAt` (without the column check).

**Complex/Risky:**
- The removal is safe because `getSubtasksByFeatureId` already filters `status = 'active'`, and completed subtasks have `status = 'completed'`. The column read is a no-op on the query results.
- The contract pin must be updated in the same change — otherwise the test goes red.
- Must verify that no other code path depends on the `remaining` filter including the column check. The filter is local to the feature nudge watch loop (line 1184).

## Edge-Case & Dependency Audit

- **`PlanIngestionEngine.ts:1172–1177`:** The comment explicitly states: "getSubtasksByFeatureId filters status = 'active'; reaching COMPLETED sets status = 'completed', so those rows are already absent. `completed_at` is on every row the query returns." This confirms the column read is redundant.
- **`completion-asserted-never-inferred.test.js:331`:** The pin asserts the combined expression. After removal, the pin should assert only `!s.completedAt` in the `remaining` filter context.
- **`completion-asserted-never-inferred.test.js:323–329`:** The queue-watch in-flight predicate pin (already rewritten to whole-body) asserts `!kanbanColumn` is NOT in the predicate. This is a different code path (the queue watch, not the feature sweep) and is unaffected.
- **Goal Invariant 2:** "The only surviving column read in PlanIngestionEngine.ts is `=== 'STAGING'`." After removing the `!== 'COMPLETED'` read, this invariant is satisfied.

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
    'the feature sweep must not read kanbanColumn — getSubtasksByFeatureId already filters status = active');
```

## Verification Plan

1. Run `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/completion-asserted-never-inferred.test.js` — assert exit code 0.
2. Run `npm run test:contract:completion-asserted-never-inferred` — assert exit code 0.
3. Run `npm run test:contract:queue-stall-watch` — assert exit code 0 (verify no regression in the related queue-watch gate).
4. Run the full contract suite — assert no regressions.
5. Verify Goal Invariant 2: `grep -n "kanbanColumn" src/services/PlanIngestionEngine.ts` — assert the only surviving column read is `=== 'STAGING'`.
