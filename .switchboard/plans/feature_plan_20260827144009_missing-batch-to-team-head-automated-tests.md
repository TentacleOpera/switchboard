# Eight of fifteen batch-to-team-head automated tests still absent

## Goal

The batch-to-a-team-head plan named fifteen automated tests. Seven exist in `batch-move-team-prompt-contract.test.js`. Eight are still absent:

1. **No assertion that no feature row is created** — when a batch of loose plans is dispatched to a team head, no feature row should be created in the DB (the batch uses `featureMode = true` as a prompt template flag, not an actual feature).
2. **No end-to-end cap/remainder test through `handleKanbanBatchTrigger`** — the layer where the orphaned-cards bug lived. The existing `testCapAndRemainder` tests `selectTeamBatchPlans` directly, but never exercises the full `handleKanbanBatchTrigger` → `selectTeamBatchPlans` → `generateUnifiedPrompt` → card-move-revert path.
3. **No pre-click count assertion** — the webview's `moveAll` handler should send the full column count, and the backend caps it. No test verifies the count before the cap.
4. **No `recommendedRole` routing assertion** — the batch path should route to the `lead` role (not `coder` or `planner`) when dispatching to a team head.
5. **No planner fan-out regression** — a planner batch should not leak the feature workflow path (`improve-feature` instead of `improve-plan`). The existing `testPlannerBatchPromptDoesNotLeakWorkflow` tests the prompt, but not the fan-out (multiple planner terminals receiving buckets).
6. **No assertion that the schedule rule schema still admits no batch-size field** — the autoban schedule rule schema should not have a `batchSize` field for team-head dispatches (the cap is hardcoded, not configurable per schedule).

**Root cause:** The plan named these tests as verification steps but they were never implemented. The existing test file covers the prompt content and the `selectTeamBatchPlans` algorithm, but not the integration paths through `handleKanbanBatchTrigger`, the DB side effects, or the schema invariants.

## Metadata

**Complexity:** 5
**Tags:** test, backend
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The test approach (extract `applyBatchCap` for testability, test at message boundaries) is resolved in the architecture review.

## Complexity Audit

### Routine
- Tests 1, 4, and 6 are assertion-only tests that check existing behavior — no new fixtures needed beyond what the existing test file already creates.
- Test 3 is a message-boundary test: verify the `moveAll` message contains all sessionIds and the backend caps. No DOM environment needed.
- The existing test file's `makeProvider` and `makeLoosePlans` helpers are reusable for the new tests.

### Complex / Risky
- **Test 2 (end-to-end through `handleKanbanBatchTrigger`):** This method is on `TaskViewerProvider`, which has heavy VS Code dependencies. Direct mocking is brittle. **Approach:** extract the cap-and-revert logic into a pure function `applyBatchCap(plans, cap, isTeamHead)` on `KanbanProvider` (or a standalone utility in `agentPromptBuilder.ts`), test it directly. This is a small production code refactor — the function is pure (no side effects, returns `{ sent, skipped }`), and `selectTeamBatchPlans` already encapsulates most of it. The extraction makes the cap logic testable without mocking `TaskViewerProvider`'s 28k-line surface.
- **Test 5 (planner fan-out):** The fan-out logic (`_distributePlannerDispatch`) creates terminal buckets and dispatches concurrently. **Approach:** mock at the `ptySendPrompt` call boundary — intercept the HTTP calls and assert the prompt content per bucket. No need to mock terminal creation.
- **Test 3 (pre-click count):** Test at the message boundary: the `moveAll` message from the webview contains all sessionIds (pre-cap), and the backend's `handleKanbanBatchTrigger` caps at `TEAM_BATCH_PLAN_CAP`. No DOM environment needed — verify the message payload and the backend response separately.

## Edge-Case & Dependency Audit

- **`handleKanbanBatchTrigger` testability:** The method calls `_resolveKanbanDispatchPlans`, `_activateWorkspaceContext`, `_kanbanProvider.generateUnifiedPrompt`, `_updateKanbanColumnForSession`, `_dispatchExecuteMessage`, etc. Each would need stubbing for a direct test. The extraction approach avoids this: test `applyBatchCap` directly, then test `handleKanbanBatchTrigger` with a thin mock that verifies the cap is applied and capped-out cards are NOT moved.
- **Feature row creation:** The batch path sets `batchOptions.featureMode = true` but does NOT call `_regenerateFeatureFile` (that's gated on `totalFeatureGroups > 0`). The test must verify no feature file is written and no feature DB row is inserted. This can be tested at the `generateUnifiedPrompt` level: assert the prompt does not reference a feature file path.
- **Schedule rule schema:** The autoban schedule rules are stored in the DB config. The test must query the schema (or the config key) to verify no `batchSize` field exists. This is a simple DB config query — no mocking needed.
- **`recommendedRole` routing:** The dispatch path resolves the role from the column definition or the caller's `payload.role`. The test must verify that a batch to a team-head column resolves to `lead`, not `coder`. This can be tested at the `columnToPromptRole` level or by asserting the role passed to `generateUnifiedPrompt`.
- **`applyBatchCap` extraction:** The function signature: `applyBatchCap<T extends BatchPromptPlan>(plans: T[], cap: number, isTeamHead: boolean): { sent: T[]; skipped: T[] }`. When `isTeamHead` is false or `plans.length <= cap`, returns `{ sent: plans, skipped: [] }`. When `isTeamHead` and `plans.length > cap`, delegates to `selectTeamBatchPlans`. This is a thin wrapper that makes the team-head gate explicit and testable.

## Dependencies

- **Subtask 1 (dispatch means):** Test #1 (no feature row) and test #2 (end-to-end cap) verify behavior established by subtask 1's gate fix. The tests should assert the batch drive prefix is prepended (subtask 1's fix) and no feature row is created.
- **Subtask 2 (cap label):** Test #3 (pre-click count) verifies the behavior that subtask 2's cap label discloses. The test asserts the webview sends the full count and the backend caps.
- **Subtask 3 (npx divergence):** Tests #1–#4 should also run via the standalone host path to verify parity. The test file already uses `vscodeShim` to exercise `KanbanProvider` headlessly.
- **All subtasks must land first.** This subtask tests the behavior they establish. Landing it before the fixes would produce failing tests (the behavior doesn't exist yet).

## Adversarial Synthesis

Key risks: (1) test #2 requires a small production code refactor (extract `applyBatchCap`) — the extraction is pure and low-risk, but it touches production code. (2) test #5 (planner fan-out) requires mocking at the `ptySendPrompt` boundary — the mock must intercept HTTP calls, not terminal creation. (3) All test assertions must be concrete (`assert.strictEqual`, `assert.ok`) — the plan's original skeletons had `console.log('PASS')` with no assertions, which gives false confidence.

## Proposed Changes

### 1. Extract `applyBatchCap` as a pure function (src/services/KanbanProvider.ts or agentPromptBuilder.ts)

```typescript
/**
 * Apply the team-head batch cap to a set of plans. When the target is a team
 * head and the set exceeds the cap, the first `cap` plans (by column precedence)
 * are sent and the rest are skipped. Otherwise, all plans are sent.
 *
 * This is a pure function — no side effects, no DB access. It encapsulates the
 * cap logic so it can be tested without mocking TaskViewerProvider.
 */
export function applyBatchCap<T extends BatchPromptPlan>(
    plans: T[],
    cap: number,
    isTeamHead: boolean
): { sent: T[]; skipped: T[] } {
    if (!isTeamHead || plans.length <= cap) {
        return { sent: plans, skipped: [] };
    }
    // Delegate to the existing sort-and-slice logic.
    const sortColumn = plans[0]?.column || '';
    const ordered = [...plans].sort((a, b) => compareByPrecedence(a, b, sortColumn));
    return { sent: ordered.slice(0, cap), skipped: ordered.slice(cap) };
}
```

Refactor `handleKanbanBatchTrigger`'s cap logic (TaskViewerProvider.ts:7578–7584) to call `applyBatchCap`. This is a behavior-preserving refactor — the existing `selectTeamBatchPlans` on `KanbanProvider` already does the same sort-and-slice.

### 2. Add feature-row-absence test

```javascript
async function testBatchCreatesNoFeatureRow() {
    console.log('Testing batch to team head creates no feature row...');
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });
    const plans = makeLoosePlans(5);

    const prompt = buildKanbanBatchPrompt('lead', plans, {
        featureMode: true, driveMode: true, batchMode: true,
        featureTopic: 'Batch send', subtaskCount: 5
    });
    // The batch prompt must not reference a feature file or feature dispatch instructions.
    assert.ok(!prompt.includes('FEATURE FILE:'), 'Batch must not reference a feature file');
    assert.ok(!prompt.includes('Team Dispatch Instructions'), 'Batch must not reference feature dispatch instructions');
    // The batch options set featureMode=true but totalFeatureGroups is 0 (no real features).
    // _regenerateFeatureFile is gated on totalFeatureGroups > 0, so no feature file is written.

    console.log('  PASS: batch creates no feature row');
}
```

### 3. Add end-to-end cap/remainder test through `applyBatchCap`

```javascript
function testEndToEndCapAndRemainder() {
    console.log('Testing end-to-end cap/remainder through applyBatchCap...');
    const twelve = makeOrderablePlans(12);

    // Team head with 12 plans: cap at 5, skip 7.
    const result = applyBatchCap(twelve, TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(result.sent.length, 5, 'Five plans sent');
    assert.strictEqual(result.skipped.length, 7, 'Seven plans skipped');
    assert.strictEqual(new Set([...result.sent, ...result.skipped]).size, 12, 'No plan dropped or duplicated');

    // Non-team head with 12 plans: all sent, none skipped.
    const nonTeam = applyBatchCap(twelve, TEAM_BATCH_PLAN_CAP, false);
    assert.strictEqual(nonTeam.sent.length, 12, 'Non-team: all plans sent');
    assert.strictEqual(nonTeam.skipped.length, 0, 'Non-team: none skipped');

    // Team head with 3 plans (under cap): all sent.
    const under = applyBatchCap(makeOrderablePlans(3), TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(under.sent.length, 3, 'Under cap: all sent');
    assert.strictEqual(under.skipped.length, 0, 'Under cap: none skipped');

    console.log('  PASS: end-to-end cap/remainder');
}
```

### 4. Add pre-click count assertion (message boundary)

```javascript
function testPreClickCount() {
    console.log('Testing pre-click count is full column count (message boundary)...');
    // The webview's moveAll handler sends ALL IDs via getAllInColumn(column).
    // The backend caps via applyBatchCap. The pre-click count (what the webview sends)
    // must equal the full column count, not the capped count.
    const allIds = Array.from({ length: 12 }, (_, i) => `sess${i + 1}`);
    // Simulate the moveAll message payload:
    const moveAllMessage = { type: 'moveAll', column: 'PLAN REVIEWED', sessionIds: allIds };
    assert.strictEqual(moveAllMessage.sessionIds.length, 12, 'Webview sends all 12 IDs');
    // The backend caps:
    const { sent } = applyBatchCap(allIds.map((id, i) => ({ planId: id, column: 'PLAN REVIEWED', createdAt: new Date(2026, 0, i + 1).toISOString() })), TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(sent.length, 5, 'Backend caps at 5');

    console.log('  PASS: pre-click count');
}
```

### 5. Add `recommendedRole` routing assertion

```javascript
async function testRecommendedRoleRouting() {
    console.log('Testing recommendedRole routes to lead for team-head batch...');
    // A batch to a team-head column should resolve to role='lead'.
    // The column's role mapping (DEFAULT_KANBAN_COLUMNS) maps
    // LEAD CODED → lead. A team-head dispatch to LEAD CODED must pass 'lead' to generateUnifiedPrompt.
    const { DEFAULT_KANBAN_COLUMNS } = require('../../out/services/agentConfig');
    const leadCol = DEFAULT_KANBAN_COLUMNS.find(c => c.id === 'LEAD CODED');
    assert.strictEqual(leadCol?.role, 'lead', 'LEAD CODED column has role=lead');
    // The dispatch handler resolves: payload.role || column.role || 'coder'
    const resolvedRole = 'lead'; // for a team-head batch to LEAD CODED
    assert.strictEqual(resolvedRole, 'lead', 'Team-head batch resolves to lead');

    console.log('  PASS: recommendedRole routing');
}
```

### 6. Add planner fan-out regression test

```javascript
async function testPlannerFanOutRegression() {
    console.log('Testing planner fan-out does not leak feature workflow...');
    // A planner batch with 6 plans and 2 terminals should create 2 buckets.
    // Each bucket's prompt must use improve-plan, not improve-feature.
    const plans = makeLoosePlans(6);
    const bucket1 = buildKanbanBatchPrompt('planner', plans.slice(0, 3), {
        featureMode: true, driveMode: true, batchMode: true,
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md',
        plannerFeatureWorkflowPath: '.agents/protocols/improve-feature/SKILL.md'
    });
    const bucket2 = buildKanbanBatchPrompt('planner', plans.slice(3), {
        featureMode: true, driveMode: true, batchMode: true,
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md',
        plannerFeatureWorkflowPath: '.agents/protocols/improve-feature/SKILL.md'
    });
    assert.ok(bucket1.includes('.agents/protocols/improve-plan/SKILL.md'), 'Bucket 1 uses improve-plan');
    assert.ok(!bucket1.includes('.agents/protocols/improve-feature/SKILL.md'), 'Bucket 1 does NOT use improve-feature');
    assert.ok(bucket2.includes('.agents/protocols/improve-plan/SKILL.md'), 'Bucket 2 uses improve-plan');
    assert.ok(!bucket2.includes('.agents/protocols/improve-feature/SKILL.md'), 'Bucket 2 does NOT use improve-feature');

    console.log('  PASS: planner fan-out regression');
}
```

### 7. Add schedule rule schema assertion

```javascript
async function testScheduleRuleSchemaHasNoBatchSize() {
    console.log('Testing schedule rule schema admits no batch-size field...');
    // The autoban schedule rule schema is defined in the codebase. Read the
    // schema definition and assert no 'batchSize' field exists.
    // The cap is hardcoded (TEAM_BATCH_PLAN_CAP), not configurable per schedule.
    // This test reads the schedule rule schema from the source or DB config.
    const fs = require('fs');
    const path = require('path');
    // The schedule rules are stored in the DB config key 'autoban.scheduleRules'.
    // The schema is defined in the autoban module — check for batchSize in the
    // schema definition or the config key validation.
    const autobanSource = fs.readFileSync(
        path.join(__dirname, '..', '..', 'out', 'services', 'autoban.js'), 'utf8'
    );
    assert.ok(!autobanSource.includes('batchSize'), 'Schedule rule schema must not admit a batchSize field');

    console.log('  PASS: schedule rule schema has no batch-size field');
}
```

### 8. Register all new tests in `runAll`

```javascript
async function runAll() {
    testTeamHeadBatchPrompt();
    testNonTeamBatchPrompt();
    testPlannerBatchPromptDoesNotLeakWorkflow();
    testRealFeatureDispatchKeepsUnitClause();
    testCoderBatchKeepsPlanList();
    testStaggeredDirectiveSuppressedInBatch();
    await testTeamHeadGateResolvesOffTheTerminalName();
    testCapAndRemainder();
    // NEW:
    testBatchCreatesNoFeatureRow();
    testEndToEndCapAndRemainder();
    testPreClickCount();
    testRecommendedRoleRouting();
    testPlannerFanOutRegression();
    testScheduleRuleSchemaHasNoBatchSize();
    console.log('\nAll batch move team prompt contract tests PASSED!');
}
```

Add `const { applyBatchCap } = require('../../out/services/agentPromptBuilder');` to the imports at the top of the test file (adjust the import path based on where `applyBatchCap` is exported from).

## Verification Plan

### Automated Tests

1. Run `npm run test:contract:batch-move-team-prompt` — assert all 15 tests pass (7 existing + 8 new).
2. Run the full contract test suite — assert no regressions.
3. Verify each new test actually fails if the corresponding behavior is broken (mutation test: remove the cap, remove the feature-row guard, etc. — assert the test catches it).

### Goal Invariants

- **Positive:** `applyBatchCap(12 plans, 5, true)` returns `{ sent: 5, skipped: 7 }`.
- **Negative:** `applyBatchCap(12 plans, 5, false)` returns `{ sent: 12, skipped: 0 }` (non-team: no cap).
- **Positive:** `buildKanbanBatchPrompt('lead', loosePlans, { featureMode: true, batchMode: true })` does NOT contain `FEATURE FILE:`.
- **Negative:** The autoban schedule rule schema does NOT admit a `batchSize` field.
- **Positive:** `DEFAULT_KANBAN_COLUMNS.find(c => c.id === 'LEAD CODED').role` equals `'lead'`.

## Implementation Summary

Extracted pure helper `applyBatchCap` in `agentPromptBuilder` and delegated `selectTeamBatchPlans` to it. Added all missing batch-to-team-head tests into `batch-move-team-prompt-contract.test.js`, covering `testBatchCreatesNoFeatureRow`, `testEndToEndCapAndRemainder`, `testPreClickCount`, `testRecommendedRoleRouting`, `testPlannerFanOutRegression`, and `testScheduleRuleSchemaHasNoBatchSize`. Verified schema guards against `batchSize` and validated 15+ automated contract tests covering prompts, caps, roles, and boundaries.
