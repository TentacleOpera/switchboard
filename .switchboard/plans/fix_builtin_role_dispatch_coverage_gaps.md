# Fix: Built-In Role Dispatch Coverage Gaps

## Goal

Eliminate the class of bug where a built-in kanban role (e.g. `intern`, `team-lead`) silently fails to dispatch — either showing "Unknown role" or never sending a prompt — because hardcoded role lists in `KanbanProvider` and `TaskViewerProvider` are not derived from the canonical column definitions.

## Metadata
**Tags:** bugfix, backend
**Complexity:** 5

## User Review Required
> [!NOTE]
> - No breaking changes. All changes are additive (new dispatch branches, derived role lists).
> - Users without Team Lead agents configured see no behavior change.
> - After applying, verify that existing Planner/Lead/Coder/Intern/Reviewer dispatch still works via manual test.

## Background

Two bugs were discovered and partially fixed during a debugging session on 2026-04-10:

| Bug | Symptom | Root Cause | Status |
|-----|---------|------------|--------|
| `intern` missing from `_getAgentNames` | Drag-drop to `INTERN CODED`/`CODED_AUTO` silently does nothing (card moves but no prompt sent) | `lastAgentNames['intern']` always undefined → `isColumnAgentAvailable` returns false → `triggerAction` never posted | **Fixed** (added `intern` to roles list) |
| `intern` missing from `_handleTriggerAgentActionInternal` | Sidebar "Start Coding" button shows `"Unknown role: intern"` | No `else if (role === 'intern')` branch in dispatch chain | **Fixed** (added branch) |

**Not yet fixed:** `team-lead` has the exact same two gaps and will fail identically for any user with a Team Lead agent configured.

**Root cause of the whole class:** Multiple places maintain independent hardcoded role lists instead of deriving from `DEFAULT_KANBAN_COLUMNS` (the canonical source of truth in `agentConfig.ts`).

## Complexity Audit

### Routine
- **Add `team-lead` dispatch branch** in `TaskViewerProvider._handleTriggerAgentActionInternal` (line ~8817) — follows identical pattern to existing `intern` branch added in prior fix
- **Add `intern` and `team-lead` to `workflowMap`** in `TaskViewerProvider._handleTriggerAgentActionInternal` (line ~8840) — two dictionary entries
- **Create regression test file** `src/test/builtin-role-dispatch-coverage.test.js` — static source analysis, no runtime dependencies

### Complex / Risky
- **Derive `_getAgentNames` roles from `buildKanbanColumns([])`** — replaces hardcoded lists in three branches (active state line ~1230, no-state fallback line ~1246, catch fallback line ~1252) with a dynamic derivation. Risk: if `buildKanbanColumns` behavior changes or returns unexpected roles, all agent name resolution is affected. Mitigated by regression test asserting expected roles.
- **TypeScript type narrowing:** `.filter(col => col.role)` does not narrow `string | undefined` to `string` through the `.map()` chain. The existing plan uses `as string` cast which is safe (all `role` values in `DEFAULT_KANBAN_COLUMNS` are string literals) but an explicit type guard is more robust. See Adversarial Synthesis for details.

## Edge-Case & Dependency Audit
- **Race Conditions:** None. All changes are synchronous within their respective methods. `_getAgentNames` is called per-render and has no shared mutable state.
- **Security:** No new user inputs are processed. `buildKanbanColumns([])` uses only compile-time constant data. The `role` string in the dispatch chain is already validated by `_getAgentNameForRole` + `_isValidAgentName` before reaching the if/else chain.
- **Side Effects:** `buildKanbanColumns([])` is a pure function returning a new array — no side effects. The `workflowMap` addition ensures run sheet history is recorded for `intern` and `team-lead` dispatches (previously silently skipped).
- **Dependencies & Conflicts:**
  - **"Add Team Lead Orchestrator Role"** (Reviewed column, sess_1775781507496) — already implemented. This plan builds on that work by fixing the dispatch gaps left behind. No conflict.
  - **"Bug: Intern Column Missing from _columnToRole Mapping"** (Reviewed column) — already implemented. This plan extends the fix to cover `_getAgentNames` and dispatch. No conflict.
  - **"test"** (New column, sess_1775784856553) — no overlap.
  - No active plans in New or Planned columns conflict with this work.

## Affected Locations

### 1. `KanbanProvider._getAgentNames` — active-state branch (line ~1230)
```typescript
const roles = ['lead', 'coder', 'intern', 'reviewer', 'planner', 'analyst', ...customAgents.map(a => a.role)];
```
Missing: `'team-lead'`

### 2. `KanbanProvider._getAgentNames` — no-state fallback branch (line ~1246)
```typescript
for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
    result[role] = 'No agent assigned';
}
```
Missing: `'intern'`, `'team-lead'`

### 3. `KanbanProvider._getAgentNames` — catch fallback branch (line ~1252)
```typescript
for (const role of ['lead', 'coder', 'reviewer', 'planner', 'analyst']) {
    result[role] = 'No agent assigned';
}
```
Missing: `'intern'`, `'team-lead'` — identical gap to Location 2

### 4. `TaskViewerProvider._handleTriggerAgentActionInternal` — dispatch if/else chain (line ~8810)
Handles: `planner`, `reviewer`, `lead`, `coder`, `intern` (just added), `customAgent`
Missing: `team-lead` — falls through to `else` branch → `"Unknown role: team-lead"`

### 5. `TaskViewerProvider._handleTriggerAgentActionInternal` — `workflowMap` (line ~8840)
```typescript
const workflowMap: Record<string, string> = {
    'planner': 'sidebar-review',
    'reviewer': 'reviewer-pass',
    'lead': 'handoff-lead',
    'coder': 'handoff',
    'jules': 'jules'
};
```
Missing: `'intern'` and `'team-lead'` — causes `workflowName` to be `undefined`, silently skipping `_updateSessionRunSheet` for these roles

**Clarification:** `_getVisibleAgents` defaults (KanbanProvider line ~1260, TaskViewerProvider line ~1597) also omit `'team-lead'`, but this is acceptable because the `TEAM LEAD CODED` column has `hideWhenNoAgent: true` — the column is intentionally hidden until an agent is assigned, at which point `state.visibleAgents` overrides the default.

## Solution

### Change 1: Derive `_getAgentNames` roles from `buildKanbanColumns` (architectural fix)

Instead of maintaining a hardcoded list, derive built-in roles from `buildKanbanColumns([])` — the same source that defines which columns exist on the board.

**In `KanbanProvider._getAgentNames`**, replace the hardcoded roles list with:

```typescript
const builtInRoles = buildKanbanColumns([])
    .filter(col => col.role)
    .map(col => col.role as string);
const roles = [...new Set([...builtInRoles, 'analyst', ...customAgents.map(a => a.role)])];
```

And replace the no-state fallback **and** the catch fallback (line ~1252, which has the same stale list):

```typescript
const builtInRoles = buildKanbanColumns([])
    .filter(col => col.role)
    .map(col => col.role as string);
for (const role of [...builtInRoles, 'analyst']) {
    result[role] = 'No agent assigned';
}
```

`analyst` is included explicitly because it is a built-in agent without a kanban column of its own.

> **Why `buildKanbanColumns([])`?** Custom agent columns are already appended separately via `customAgents.map(a => a.role)`. The `[]` call gives only default built-in roles, which is what we want for the base list. Custom agents extend it.

### Change 2: Add `team-lead` to `_handleTriggerAgentActionInternal`

Add an `else if (role === 'team-lead')` branch after the `lead` branch, using `buildKanbanBatchPrompt('team-lead', ...)` which already has a Team Lead prompt implementation:

```typescript
} else if (role === 'team-lead') {
    messagePayload = buildKanbanBatchPrompt('team-lead', [dispatchPlan], {
        defaultPromptOverrides: this._cachedDefaultPromptOverrides
    });
    messageMetadata.phase_gate = { enforce_persona: 'team-lead' };
```

### Change 2.5: Add `intern` and `team-lead` to `workflowMap` (Clarification)

The `workflowMap` in `_handleTriggerAgentActionInternal` (line ~8840) determines which workflow name is recorded in the session run sheet. `intern` and `team-lead` are absent, causing `workflowName` to be `undefined` and silently skipping `_updateSessionRunSheet` calls for these roles.

**In `TaskViewerProvider._handleTriggerAgentActionInternal`**, add both entries:

```typescript
const workflowMap: Record<string, string> = {
    'planner': 'sidebar-review',
    'reviewer': 'reviewer-pass',
    'lead': 'handoff-lead',
    'team-lead': 'handoff-lead',
    'coder': 'handoff',
    'intern': 'handoff',
    'jules': 'jules'
};
```

### Change 3: Add regression tests

Create `src/test/builtin-role-dispatch-coverage.test.js` using static source analysis (same pattern as other regression tests). Tests assert:

1. Every role-mapped column in `DEFAULT_KANBAN_COLUMNS` is present in `_getAgentNames`' roles string
2. Every role-mapped column in `DEFAULT_KANBAN_COLUMNS` has a corresponding dispatch branch in `_handleTriggerAgentActionInternal`
3. `intern` and `team-lead` are specifically named (explicit regression guards)
4. `workflowMap` includes `intern` and `team-lead` entries

## Adversarial Synthesis

### Grumpy Critique

> *"Oh, bravo. Multiple independent hardcoded role lists that nobody bothered to derive from the canonical source, and the original plan heroically discovers... two of the three identical fallback branches. I had to point out the catch fallback at line 1252 has the EXACT same stale list. Classic bug-fix-that-misses-one."*
>
> *"And while we're at it — the `workflowMap` at line 8840 is another ticking time bomb. `team-lead` and `intern` dispatch fine, the card moves, the terminal gets the prompt, and the session run sheet thinks absolutely nothing happened. Silent data loss in the activity log. Delightful."*
>
> *"The regression tests use regex against TypeScript source code. That's... creative. One function rename, one code-gen pass, one 'let me just inline this' refactor, and your 'regression guard' matches nothing and gives a false green. Also, `buildKanbanColumns([])` returns `KanbanColumnDefinition[]` — the `.filter(col => col.role).map(col => col.role as string)` chain works at runtime but TypeScript won't narrow the type through `.filter().map()` without a type guard. You'll get a compiler warning about `string | undefined` being cast."*
>
> *"Finally — `_getVisibleAgents` defaults at line 1260 (KanbanProvider) and line 1597 (TaskViewerProvider) also have hardcoded defaults maps missing `team-lead`. Sure, `hideWhenNoAgent` saves you today. But you're writing a plan to eliminate hardcoded role lists and you're leaving two behind. At least document why."*

### Balanced Response

The Grumpy critique identified legitimate gaps not covered in the original plan:

1. **Catch fallback (line ~1252):** Added to Affected Locations as #3. The `buildKanbanColumns([])` derivation fix now explicitly covers all three branches in `_getAgentNames`.

2. **`workflowMap` gap (line ~8840):** Added as Change 2.5. Without this, `intern` and `team-lead` dispatches succeed but run sheet history is silently skipped. Two dictionary entries fix it.

3. **TypeScript type narrowing:** The `.filter(col => col.role)` doesn't narrow `string | undefined` to `string` automatically. The `as string` cast is runtime-safe (all role values in `DEFAULT_KANBAN_COLUMNS` are string literals) and the filter removes `undefined` entries. For stricter TS, a type predicate like `.filter((col): col is KanbanColumnDefinition & { role: string } => !!col.role)` could be used. Accepted trade-off: the cast matches the existing codebase style.

4. **`_getVisibleAgents` defaults:** Documented as a Clarification in Affected Locations. The `hideWhenNoAgent: true` on the `TEAM LEAD CODED` column means the column is hidden by default. When an agent is assigned, `state.visibleAgents` overrides the default. No code change needed, but the rationale is now explicit.

5. **Regex-based tests:** Accepted trade-off. The test pattern matches other regression tests in this codebase (e.g., `access-main-program-denied-regression.test.js`). A test that derives roles from `DEFAULT_KANBAN_COLUMNS` via regex and asserts coverage provides meaningful CI-time protection against the most common failure mode. Full integration tests require VS Code extension host, which is out of scope.

## Files to Modify

- `src/services/KanbanProvider.ts` — Change 1 (`_getAgentNames` all three branches: active state, no-state fallback, catch fallback)
- `src/services/TaskViewerProvider.ts` — Change 2 (dispatch `else if` branch for `team-lead`) + Change 2.5 (`workflowMap` entries for `intern` and `team-lead`)
- `src/test/builtin-role-dispatch-coverage.test.js` — **New file** (Change 3)

## Proposed Test File

```javascript
/**
 * Regression: every built-in kanban role must be covered in both
 * _getAgentNames (KanbanProvider) and _handleTriggerAgentActionInternal (TaskViewerProvider).
 *
 * Run with: node src/test/builtin-role-dispatch-coverage.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const kanbanProviderSource = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8');
const taskViewerSource = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8');
const agentConfigSource = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'agentConfig.ts'), 'utf8');

let passed = 0, failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  PASS ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

function run() {
    console.log('\nRunning built-in role dispatch coverage regression tests\n');

    // Extract all roles from DEFAULT_KANBAN_COLUMNS in agentConfig.ts
    const roleMatches = [...agentConfigSource.matchAll(/role:\s*'([^']+)'/g)].map(m => m[1]);
    const builtInRoles = [...new Set(roleMatches)]; // dedupe

    test('agentConfig DEFAULT_KANBAN_COLUMNS includes expected built-in roles', () => {
        for (const role of ['planner', 'lead', 'coder', 'intern', 'reviewer', 'team-lead']) {
            assert.ok(builtInRoles.includes(role), `Expected DEFAULT_KANBAN_COLUMNS to include role '${role}'`);
        }
    });

    test('KanbanProvider._getAgentNames derives roles from buildKanbanColumns (not hardcoded list)', () => {
        assert.match(kanbanProviderSource, /buildKanbanColumns\(\[\]\)[\s\S]{0,200}\.filter\(col => col\.role\)/,
            'Expected _getAgentNames to derive built-in roles from buildKanbanColumns([]).filter(col => col.role)');
    });

    test('KanbanProvider._getAgentNames covers intern explicitly or via buildKanbanColumns', () => {
        const coversIntern =
            kanbanProviderSource.includes("'intern'") ||
            /buildKanbanColumns\(\[\]\)[\s\S]{0,300}\.filter\(col => col\.role\)/.test(kanbanProviderSource);
        assert.ok(coversIntern, 'Expected _getAgentNames to cover intern role');
    });

    test('KanbanProvider._getAgentNames covers team-lead explicitly or via buildKanbanColumns', () => {
        const coversTeamLead =
            kanbanProviderSource.includes("'team-lead'") ||
            /buildKanbanColumns\(\[\]\)[\s\S]{0,300}\.filter\(col => col\.role\)/.test(kanbanProviderSource);
        assert.ok(coversTeamLead, 'Expected _getAgentNames to cover team-lead role');
    });

    test('TaskViewerProvider._handleTriggerAgentActionInternal has intern dispatch branch', () => {
        assert.match(taskViewerSource,
            /else if \(role === 'intern'\)[\s\S]{0,300}buildKanbanBatchPrompt\('intern'/,
            "Expected _handleTriggerAgentActionInternal to have an 'intern' dispatch branch");
    });

    test('TaskViewerProvider._handleTriggerAgentActionInternal has team-lead dispatch branch', () => {
        assert.match(taskViewerSource,
            /else if \(role === 'team-lead'\)[\s\S]{0,300}buildKanbanBatchPrompt\('team-lead'/,
            "Expected _handleTriggerAgentActionInternal to have a 'team-lead' dispatch branch");
    });

    test('TaskViewerProvider workflowMap includes intern', () => {
        assert.match(taskViewerSource,
            /'intern'\s*:\s*'handoff'/,
            "Expected workflowMap to include 'intern' entry");
    });

    test('TaskViewerProvider workflowMap includes team-lead', () => {
        assert.match(taskViewerSource,
            /'team-lead'\s*:\s*'handoff-lead'/,
            "Expected workflowMap to include 'team-lead' entry");
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run();
```

## Verification Plan

### Automated
```bash
node src/test/builtin-role-dispatch-coverage.test.js
npm test
```

### Manual (requires Team Lead agent configured in state.json)
1. Configure a terminal with role `team-lead`
2. Create a plan, open the Agents tab → click the Team Lead action button → expect dispatch, not "Unknown role: team-lead"
3. Drag a card to `TEAM LEAD CODED` column → expect prompt sent to team-lead terminal
4. Confirm `INTERN CODED` drag-drop still works (regression guard for the already-fixed bug)

## Impact

- No behavior change for users without Team Lead or Intern agents configured
- Users with Team Lead agents get working dispatch for the first time
- `_getAgentNames` becomes self-updating when new columns are added to `DEFAULT_KANBAN_COLUMNS`
- Regression tests will catch any future role omission at CI time

## Implementation Review (2026-04-10)

### Status: ✅ COMPLETE — All Changes Verified

### Files Changed
- `src/services/KanbanProvider.ts` — `_getAgentNames` now derives roles from `buildKanbanColumns([])` with proper type predicate; single `fallbackRoles` variable used by all three branches (active state, no-state fallback, catch fallback)
- `src/services/TaskViewerProvider.ts` — `team-lead` dispatch branch added (line ~8794); `workflowMap` updated with `intern` and `team-lead` entries (lines ~8850-8851)
- `src/test/builtin-role-dispatch-coverage.test.js` — New regression test file (7 tests)

### Validation Results
- **Regression tests**: 7/7 PASS (`node src/test/builtin-role-dispatch-coverage.test.js`)
- **TypeScript compilation**: No new errors. Only pre-existing TS2835 (unrelated import extension in ArchiveManager reference)
- **No CRITICAL or MAJOR issues found** during adversarial review

### Implementation Notes
- Type predicate `.filter((role): role is string => Boolean(role))` used instead of plan's `as string` cast — strictly superior, no TS warnings
- Test file uses `extractMethodBody` (brace-counted method extraction) instead of full-file regex — more robust than plan's proposed approach
- Test includes negative assertion (`doesNotMatch`) verifying stale hardcoded list is gone

### Remaining Risks
- **Low**: `_getVisibleAgents` defaults (KanbanProvider line ~1264) still hardcoded without `team-lead`. Safe due to `hideWhenNoAgent: true` on TEAM LEAD CODED column — documented in Affected Locations clarification. Consistency improvement deferred.
- **Low**: Test `extractMethodBody` uses naive brace counting — could break if target methods contain unbalanced braces in string literals. Not a concern for current method bodies.
