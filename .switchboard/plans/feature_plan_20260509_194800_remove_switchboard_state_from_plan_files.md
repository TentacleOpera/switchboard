# Remove Switchboard State from Plan Files

## Goal
Remove all '## Switchboard State' sections from being added to plan files. The KanbanDatabase is the sole source of truth for plan state; plan files should not contain any Switchboard State metadata.

## Metadata
**Tags:** workflow, reliability
**Complexity:** 4

## User Review Required
None.

## Current State
- `writePlanStateToFile()` in `planStateUtils.ts` is already disabled (returns early with Promise.resolve())
- `inspectKanbanState()` is already disabled (hardcoded to return null state)
- `_schedulePlanStateWrite` in `KanbanProvider.ts` is already a no-op
- However, multiple services still directly append '## Switchboard State' sections to plan content when creating plans
- These hardcoded additions bypass the disabled `writePlanStateToFile` function
- PlanFileImporter JSDoc (lines 23-27) incorrectly claims embedded state is honored during import; this must be corrected
- Some regression tests may currently pass only against stale `out/` builds because `inspectKanbanState` was disabled in source but not yet reflected in compiled output

## Complexity Audit

### Routine
- Remove '## Switchboard State' section from plan creation in TaskViewerProvider.ts (2 locations)
- Remove '## Switchboard State' section from plan creation in ClickUpAutomationService.ts
- Remove '## Switchboard State' section from plan creation in LinearAutomationService.ts
- Remove '## Switchboard State' section from plan creation in LinearSyncService.ts
- Delete `applyKanbanStateToPlanContent` and its private helpers from planStateUtils.ts (no TypeScript source callers exist)
- Mark `inspectKanbanState` and `extractKanbanState` as deprecated in planStateUtils.ts
- Remove `inspectKanbanState` import and `validKanbanColumns` variable from PlanFileImporter.ts
- Remove `writePlanStateToFile` import from KanbanProvider.ts (already unused — `_schedulePlanStateWrite` is disabled)
- Update test files to remove state section assertions

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None
- **Security:** None
- **Side Effects:** Plan files will no longer contain state metadata. KanbanDatabase remains the sole source of truth.
- **Dependencies & Conflicts:** Some tests currently assert embedded state behavior, but `inspectKanbanState` is already disabled in source. These tests may already fail against fresh `out/` builds and must be updated to expect CREATED/active.

## Dependencies
None.

## Adversarial Synthesis
Key risks: (1) Several tests are already broken against current source because `inspectKanbanState` returns null and `writePlanStateToFile` has no callers in `.ts` files; (2) Removing the `inspectKanbanState` import from `PlanFileImporter.ts` without also removing `validKanbanColumns` would leave an unused variable, potentially failing compilation under `noUnusedLocals`; (3) `applyKanbanStateToPlanContent` has zero TypeScript source callers and actively appends state sections — marking it "deprecated" contradicts the plan goal. Mitigations: Add `npm run compile` as a mandatory verification step, delete `applyKanbanStateToPlanContent` and its helpers entirely, remove `validKanbanColumns` together with the `inspectKanbanState` import, and update all broken tests before running the suite.

## Proposed Changes

### 1. Remove State Section from Plan Creation

Remove hardcoded '## Switchboard State' sections from the following files:

#### 1.1 TaskViewerProvider.ts

**Location 1 (around line 3599):**
```typescript
// REMOVE:
'',
'## Switchboard State',
'',
`**Kanban Column:** ${kanbanColumn}`,
'**Status:** active'
```

**Location 2 (around line 3864):**
```typescript
// REMOVE:
'',
'## Switchboard State',
'',
`**Kanban Column:** ${kanbanColumn}`,
'**Status:** active'
```

#### 1.2 ClickUpAutomationService.ts (around line 218)

```typescript
// REMOVE:
'',
'## Switchboard State',
'',
`**Kanban Column:** ${rule.targetColumn}`,
'**Status:** active'
```

#### 1.3 LinearAutomationService.ts (around line 227)

```typescript
// REMOVE:
'',
'## Switchboard State',
'',
`**Kanban Column:** ${rule.targetColumn}`,
'**Status:** active'
```

#### 1.4 LinearSyncService.ts (around line 1910)

```typescript
// REMOVE:
`## Switchboard State\n\n**Kanban Column:** ${kanbanColumn}\n**Status:** active\n`
```

### 2. Deprecate State Parsing Functions

In `src/services/planStateUtils.ts`:

- **Delete** `applyKanbanStateToPlanContent()` and all its private helpers (`stripTrailingSwitchboardStateSections`, `collectTopLevelSwitchboardStateSections`, `parseStateSectionBody`, `extractStateSectionFields`). Verified: zero TypeScript source callers exist.
- Mark `inspectKanbanState()` as deprecated with a comment explaining it should no longer be used
- Mark `extractKanbanState()` as deprecated
- Keep `writePlanStateToFile()` as-is (already disabled)

Add deprecation notice at top of file:
```typescript
/**
 * @deprecated Plan files should not contain Switchboard State sections.
 * The KanbanDatabase is the sole source of truth for plan state.
 * These functions are kept for backward compatibility only.
 */
```

### 3. Remove State Reading from PlanFileImporter

In `src/services/PlanFileImporter.ts`:

Remove the `inspectKanbanState` import on line 6:
```typescript
// REMOVE:
import { inspectKanbanState } from './planStateUtils';
```

Remove the `validKanbanColumns` variable on line 51 (now unused):
```typescript
// REMOVE:
const validKanbanColumns = await readImportableKanbanColumns(
    resolveImportableStateRoot(workspaceRoot, effectiveStateRoot)
);
```

Remove the logic that reads embedded state (lines 111-123):
```typescript
// REMOVE:
// Use embedded kanban state if present; fall back to defaults for
// legacy files that pre-date the ## Switchboard State section.
const embeddedStateInspection = inspectKanbanState(content, { validColumns: validKanbanColumns });
const embeddedState = embeddedStateInspection.state;
if (embeddedStateInspection.topLevelSectionCount > 1) {
    console.warn(
        `[PlanFileImporter] Detected ${embeddedStateInspection.topLevelSectionCount} top-level Switchboard State sections in ${planFileNormalized}; using the last valid section.`
    );
} else if (!embeddedState && embeddedStateInspection.topLevelSectionCount > 0) {
    console.warn(
        `[PlanFileImporter] Found top-level Switchboard State section(s) in ${planFileNormalized} but '${embeddedStateInspection.lastSeenColumn || 'unknown'}' is not importable in this workspace; defaulting to CREATED/active.`
    );
}
```

Replace with simple default:
```typescript
// Always default to CREATED/active - KanbanDatabase is the sole source of truth
const embeddedState = null;
```

Update the JSDoc on lines 23-27 to remove the claim about embedded state:
```typescript
// BEFORE:
 * When a plan file contains a `## Switchboard State` section, the embedded
 * kanban column and status are used instead of defaulting to CREATED/active.

// AFTER:
 * All imported plans default to CREATED/active. The KanbanDatabase is the
 * sole source of truth for plan state.
```

### 4. Update Test Files

Update or remove tests that verify state section behavior. Note: some tests may currently pass only against stale `out/` builds; they will fail after `npm run compile` and must be fixed:

- `src/services/__tests__/PlanFileImporter.noStateSection.test.ts` — Update second test to expect `CREATED` (instead of `PLAN REVIEWED`) since `inspectKanbanState` already returns null. **Note: this test is already broken against fresh `out/` builds.**
- `src/test/duplicate-switchboard-state-regression.test.js` — Remove assertions that `applyKanbanStateToPlanContent` appends a live state section (the function will be deleted); keep importPlanFiles test but expect `CREATED`
- `src/test/custom-lane-roundtrip-regression.test.js` — Remove `writePlanStateToFile` source-code assertions and `applyKanbanStateToPlanContent` state-section assertions. **Note: the `writePlanStateToFile` source-code assertions are already broken against current source.**
- `src/test/kanban-custom-column-dispatch-regression.test.js` — Remove `writePlanStateToFile` source-code assertions. **Note: these assertions are already broken against current source.**
- `src/test/state-root-fragmentation-regression.test.js` — Remove `## Switchboard State` from `buildPlanContent` fixture; update import assertion to expect `CREATED` instead of `custom_column_docs_ready`. **Note: this assertion is already broken against fresh `out/` builds.**
- `src/test/integrations/linear/linear-automation-service.test.js` — Remove `## Switchboard State` from mixed-metadata fixture

## Implementation Steps

### Phase 1: Remove State from Plan Creation
1. Edit TaskViewerProvider.ts - remove state sections from plan creation (2 locations)
2. Edit ClickUpAutomationService.ts - remove state section
3. Edit LinearAutomationService.ts - remove state section
4. Edit LinearSyncService.ts - remove state section
5. Edit KanbanProvider.ts - remove unused `writePlanStateToFile` import

### Phase 2: Deprecate State Parsing
1. Add deprecation notice to planStateUtils.ts
2. Delete `applyKanbanStateToPlanContent` and its private helpers
3. Mark `inspectKanbanState` and `extractKanbanState` as deprecated

### Phase 3: Update PlanFileImporter
1. Remove embedded state reading logic
2. Default all imports to CREATED/active
3. Remove `inspectKanbanState` import and `validKanbanColumns` variable

### Phase 4: Update Tests
1. Update PlanFileImporter.noStateSection.test.ts
2. Deprecate or remove duplicate-switchboard-state-regression.test.js
3. Update custom-lane-roundtrip-regression.test.js
4. Update kanban-custom-column-dispatch-regression.test.js
5. Update state-root-fragmentation-regression.test.js
6. Update linear-automation-service.test.js

### Phase 5: Cleanup Existing Plan Files (NOT RECOMMENDED — removed from scope)
Existing plan files with `## Switchboard State` sections are already ignored because `inspectKanbanState` is hardcoded to return null. A migration script is unnecessary scope creep.

## Verification Plan

### Manual Verification
1. Create a new plan via TaskViewerProvider
2. Verify plan file does NOT contain '## Switchboard State' section
3. Create a plan via ClickUp automation
4. Verify plan file does NOT contain '## Switchboard State' section
5. Create a plan via Linear automation
6. Verify plan file does NOT contain '## Switchboard State' section
7. Run "Reset Database" command
8. Verify plans import correctly without state sections (all default to CREATED/active)

### Automated Tests
1. Run `npm run compile` to rebuild `out/` directory before testing
2. Run `npm test` or equivalent test suite
3. Verify all PlanFileImporter tests pass with new `CREATED` expectations
4. Verify all regression tests pass after removing state assertions
5. Verify no compilation errors from removed `inspectKanbanState` import

### Success Criteria
- No new plan files contain '## Switchboard State' sections
- PlanFileImporter defaults all imports to CREATED/active
- KanbanDatabase remains the sole source of truth for plan state
- `npm run compile` produces zero errors
- All tests pass after updates

## Risks and Considerations

- **Existing State Sections:** Old plan files may still contain state sections. These will be ignored after changes.
- **PlanFileImporter Behavior:** All imports will default to CREATED/active. This is the intended behavior since KanbanDatabase is the sole source of truth.
- **Test Coverage:** Removing state-related source-code assertions reduces coverage for deleted functionality. This is acceptable since the functionality is being removed.
- **Already Broken Tests:** Several tests are definitively broken against the current TypeScript source (not just "stale `out/` builds"):
  - `PlanFileImporter.noStateSection.test.ts` second test asserts `PLAN REVIEWED` but `inspectKanbanState` returns null.
  - `state-root-fragmentation-regression.test.js` asserts `custom_column_docs_ready` but `inspectKanbanState` returns null.
  - `kanban-custom-column-dispatch-regression.test.js` asserts `writePlanStateToFile` is called in `TaskViewerProvider.ts` source, but no callers exist in `.ts` files.
  - `custom-lane-roundtrip-regression.test.js` asserts `writePlanStateToFile` source patterns in `TaskViewerProvider.ts` that no longer exist.
  Recompilation (`npm run compile`) is required, but these tests will fail even after compile and must be fixed.

## Files to Modify

1. `src/services/TaskViewerProvider.ts` — Remove state sections from plan creation (2 locations)
2. `src/services/ClickUpAutomationService.ts` — Remove state section
3. `src/services/LinearAutomationService.ts` — Remove state section
4. `src/services/LinearSyncService.ts` — Remove state section
5. `src/services/planStateUtils.ts` — Delete `applyKanbanStateToPlanContent` and helpers; mark `inspectKanbanState`/`extractKanbanState` as deprecated
6. `src/services/PlanFileImporter.ts` — Remove state reading logic, remove `validKanbanColumns`, remove `inspectKanbanState` import, fix JSDoc
7. `src/services/KanbanProvider.ts` — Remove unused `writePlanStateToFile` import
8. `src/services/__tests__/PlanFileImporter.noStateSection.test.ts` — Update tests
9. `src/test/duplicate-switchboard-state-regression.test.js` — Remove state assertions
10. `src/test/custom-lane-roundtrip-regression.test.js` — Update tests
11. `src/test/kanban-custom-column-dispatch-regression.test.js` — Update tests
12. `src/test/state-root-fragmentation-regression.test.js` — Update fixtures and expectations
13. `src/test/integrations/linear/linear-automation-service.test.js` — Update fixtures

## Recommendation

Send to Coder.
