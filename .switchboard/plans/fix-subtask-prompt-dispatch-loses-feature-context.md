# Fix Subtask Prompt Dispatch Loses Feature Context

## Goal

When a subtask plan is selected (from the sidebar Plans view, or any path that passes a subtask's sessionId to `promptSelected`), the generated prompt uses the `improve-plan` workflow instead of `improve-feature`. This is because `buildDispatchPlans` only expands subtasks when the selected record has `isFeature === true` — a subtask record has `isFeature: 0`, so it is treated as a standalone plan, the feature group is never formed, `featureMode` stays `false`, and `buildKanbanBatchPrompt` selects `DEFAULT_PLANNER_WORKFLOW` (improve-plan) instead of `DEFAULT_FEATURE_PLANNER_WORKFLOW` (improve-feature).

The kanban board does not have this bug because it filters out subtask cards at render time (`displayCards.filter(card => !card.featureId)`) — only the feature card is visible, so the copy button always carries the feature's `planId`. The sidebar Plans view (`planning.js`) renders subtasks as individual items, each with its own copy-prompt button keyed by the subtask's `sessionId`.

### The problem

`buildDispatchPlans` (`src/services/KanbanProvider.ts:4691`) has a single gate for feature-subtask expansion:

```typescript
if (isFeature && hasDb && rec.planId) {
    const subs = await this.expandFeatureSubtaskPlans(...)
}
```

A subtask record has `isFeature: 0` and `featureId: <parentPlanId>`. The gate is never entered, so:
1. No sibling subtasks are appended to the plans array.
2. `partitionPlansByFeature` sees the subtask as an orphan (its `featureId` matches no feature in the array) → it lands in `loosePlans`.
3. `totalFeatureGroups === 0` → `featureMode` is never set to `true`.
4. In `buildKanbanBatchPrompt`, `isFeatureTarget = (options?.featureMode === true && !options?.batchMode) || plans.some(p => p.isFeature)` evaluates to `false` on both arms.
5. `DEFAULT_PLANNER_WORKFLOW` (`.agents/protocols/improve-plan/SKILL.md`) is selected instead of `DEFAULT_FEATURE_PLANNER_WORKFLOW` (`.agents/protocols/improve-feature/SKILL.md`).

### Root cause

`buildDispatchPlans` resolves feature context only from the **selected record's own `isFeature` flag**. It does not check whether the selected record is a **subtask** (`isFeature: 0` but `featureId` is set) and resolve its parent feature. The feature-aware path is entered exclusively by the feature card; the subtask card has no path back to its parent.

A secondary issue: the `promptSelected` handler hardcodes `const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;` at `KanbanProvider.ts:11642`. This does not change the workflow path (that is determined by `isFeatureTarget` in the builder), but it causes the run-sheet to record `'improve-plan'` even when the prompt actually contains the improve-feature workflow — a tracking mismatch that would persist after the primary fix.

## Metadata

**Tags:** backend, bugfix
**Complexity:** 3
**Feature:** (none — standalone bugfix)

## Complexity Audit

### Routine
- Add a subtask→parent resolution branch in `buildDispatchPlans`: when `isFeature === false` and `featureId` is set, look up the parent feature record and include it (plus all sibling subtasks) in the plans array.
- Fix the hardcoded `improve-plan` instruction at `KanbanProvider.ts:11642` to be feature-aware.

### Complex / Risky
- **`buildDispatchPlans` is the single plan-array builder for every dispatch/copy entry point.** Changing its output shape affects every downstream consumer (`generateUnifiedPrompt`, `partitionPlansByFeature`, `buildKanbanBatchPrompt`). The fix must not change the output for the existing feature-card path — only add a new resolution path for the subtask-card path.
- **Duplicate-plan dedup.** If the user selects a subtask AND its feature (multi-select on the board, though the board hides subtasks), the parent feature could appear twice. The existing `partitionPlansByFeature` handles duplicate feature keys (last-wins, line 590-595), but `buildDispatchPlans` itself does not dedup. The subtask→parent resolution must check whether the parent is already in the `records` array before adding it.
- **Sidebar vs board divergence.** The board's `promptSelected` handler receives `sessionIds` from the card's `data-plan-id` (always the feature for a feature card). The sidebar's `copyKanbanPlanPrompt` receives the subtask's `sessionId` directly. The fix must work for both paths — it should be in `buildDispatchPlans` (the shared builder), not in a caller-specific patch.

## Edge-Case & Dependency Audit

### Race Conditions
- None. `buildDispatchPlans` is async but not concurrent — each call builds its own array.

### Security
- None.

### Side Effects
- **Subtask copy-prompt buttons will now generate feature-mode prompts.** This is the intended fix, but it is a behaviour change: a subtask's "Copy planning prompt" button will now copy a prompt that references the entire feature and all sibling subtasks, not just the one subtask. This is correct — `improve-feature` is the workflow that should run for any part of a feature — but it is a visible change.
- **Column advancement changes.** The `promptSelected` handler advances the card to the next column. With the fix, a subtask's copy-prompt would advance the subtask card (not the feature card). This matches the existing behaviour for subtask selection on the board (selection-based operations trust the IDs, per `_visibleColumnCards` comment at line 677-679). No change needed.

### Dependencies & Conflicts
- None. This is a standalone bugfix with no prerequisite plans.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `buildDispatchPlans` (line 4691)

After the existing `isFeature` expansion block (line 4733-4746), add a subtask→parent resolution branch:

```typescript
// Subtask selected without its feature: resolve the parent feature and
// include it + all sibling subtasks so partitionPlansByFeature forms a
// feature group and the prompt enters feature mode.
if (!isFeature && rec.featureId && hasDb && rec.featureId !== rec.planId) {
    // Only resolve if the parent is not already in the records array
    // (avoids duplicate when the user selected both the feature and a subtask).
    const parentAlreadyIncluded = records.some(r => r.planId === rec.featureId);
    if (!parentAlreadyIncluded) {
        const parentRec = await db.getPlanByPlanId(rec.featureId);
        if (parentRec && parentRec.isFeature) {
            // Insert the parent at the front of the output so partitionPlansByFeature
            // establishes the feature group before encountering the subtask.
            const parentEntry = await this._buildSingleDispatchPlan(workspaceRoot, parentRec, opts);
            if (parentEntry) {
                // Expand the parent's subtasks (includes the originally-selected subtask)
                out.unshift(parentEntry);
                const subs = await this.expandFeatureSubtaskPlans(
                    workspaceRoot, parentRec.planId, parentRec.topic || 'Untitled', parentRec.kanbanColumn || '',
                    parentEntry.worktreePath, opts?.worktreePathMap, opts?.subtaskWorktreePathMap, parentRec.project || undefined
                );
                for (const sp of subs) {
                    // Dedup against the originally-selected subtask (already in `out`)
                    if (!out.some(o => o.planId === sp.planId)) {
                        out.push({ ...sp, sessionId: sp.sessionId || parentRec.sessionId || parentRec.planId });
                    }
                }
            }
        }
    }
}
```

This requires extracting the per-record plan-building logic (lines 4700-4732) into a small helper (`_buildSingleDispatchPlan`) so the parent record can be built without duplicating the path-resolution logic. The helper is a pure refactor of the existing inline block — same fields, same resolution chain — extracted for reuse.

### `src/services/KanbanProvider.ts` — `promptSelected` instruction (line 11642)

Change:
```typescript
const instruction = dispatchSpec.role === 'planner' ? 'improve-plan' : undefined;
```
To:
```typescript
const instruction = dispatchSpec.role === 'planner'
    ? (sourceCards.some(c => c.isFeature || c.featureId) ? 'improve-feature' : 'improve-plan')
    : undefined;
```

This makes the run-sheet instruction match the workflow the prompt actually carries. The workflow path itself is determined by `isFeatureTarget` in `buildKanbanBatchPrompt` (which checks `plans.some(p => p.isFeature)`), so the primary fix in `buildDispatchPlans` is what actually switches the workflow — this instruction fix is the tracking-correction half.

## Files Changed

- `src/services/KanbanProvider.ts` — `buildDispatchPlans`: add subtask→parent resolution; extract `_buildSingleDispatchPlan` helper; fix hardcoded `improve-plan` instruction in `promptSelected`

## Verification Plan

### Automated Tests
- Unit: `buildDispatchPlans` called with a single subtask record (`isFeature: 0`, `featureId: <parentId>`) returns an array whose first element has `isFeature: true` and whose length is `1 + siblingSubtaskCount`.
- Unit: `buildDispatchPlans` called with both a feature and one of its subtasks does not duplicate the feature in the output.
- Unit: `generateUnifiedPrompt('planner', <subtask-only plans>)` produces a prompt containing the improve-feature workflow path (`.agents/protocols/improve-feature/SKILL.md`), not improve-plan.
- Unit: `generateUnifiedPrompt('planner', <loose-plan-only plans>)` still produces the improve-plan workflow path (regression guard).
- Regression: existing feature-card dispatch tests still pass unchanged (the feature-card path is not modified).

### Goal Invariants
- Assert that `partitionPlansByFeature` returns `featureGroups.length >= 1` when the input plans array originated from a subtask-only selection.
- Assert that `buildKanbanBatchPrompt` receives `featureMode: true` when the plans array originated from a subtask-only selection.
- Assert that the run-sheet instruction recorded for a subtask planner dispatch is `'improve-feature'`, not `'improve-plan'`.

### Manual Verification
1. **Sidebar: subtask copy-prompt.** Open the Planning panel, switch to the Plans view, find a subtask of a feature, click its "Copy planning prompt" button. Paste the clipboard. The prompt must reference the improve-feature workflow and list all sibling subtasks, not just the one subtask.
2. **Sidebar: feature copy-prompt.** Click the feature's own copy-prompt button. The prompt must be unchanged from today (regression).
3. **Sidebar: loose plan copy-prompt.** Click a standalone plan's copy-prompt button. The prompt must still use improve-plan (regression).
4. **Board: feature card copy-prompt.** Click the feature card's copy-prompt button on the kanban board. Unchanged (regression — the board path was never broken).
5. **Run-sheet check.** After a subtask copy-prompt dispatch, inspect the run-sheet and confirm the recorded workflow is `improve-feature`.

## Risks

- **`buildDispatchPlans` is the single builder.** Any change to its output ripples through every dispatch path. The fix is additive (new branch for a previously-unhandled case), not modifying the existing feature-card or loose-plan paths, but the extraction of `_buildSingleDispatchPlan` is a refactor that must be byte-identical in its output.
- **Sidebar behaviour change is visible.** A subtask's copy-prompt button now copies a feature-level prompt. This is correct but different — a user who previously relied on the subtask-only prompt (even though it was wrong) will see a different payload.
