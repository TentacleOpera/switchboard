# Fix Subtask Prompt Dispatch Loses Feature Context

## Goal

When a subtask plan is selected (from the sidebar Plans view, or any path that passes a subtask's sessionId to `promptSelected`), the generated prompt uses the `improve-plan` workflow instead of `improve-feature`. This is because `buildDispatchPlans` only expands subtasks when the selected record has `isFeature === true` — a subtask record has `isFeature: 0`, so it is treated as a standalone plan, the feature group is never formed, `featureMode` stays `false`, and `buildKanbanBatchPrompt` selects `DEFAULT_PLANNER_WORKFLOW` (improve-plan) instead of `DEFAULT_FEATURE_PLANNER_WORKFLOW` (improve-feature).

The kanban board does not have this bug because it filters out subtask cards at render time (`displayCards.filter(card => !card.featureId)`) — only the feature card is visible, so the copy button always carries the feature's `planId`. The sidebar Plans view (`planning.js`) renders subtasks as individual items, each with its own copy-prompt button keyed by the subtask's `sessionId`.

A secondary concern: on the CLI dispatch paths, the run-sheet workflow name is derived from a hardcoded `'improve-plan'` instruction, so a subtask dispatched via CLI records `'Improved plan'` even when the prompt (after the primary fix) carries the improve-feature workflow. The run-sheet should record what the prompt actually carried.

### The problem

`buildDispatchPlans` (`src/services/KanbanProvider.ts:4758`) has a single gate for feature-subtask expansion:

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

A secondary issue: the run-sheet workflow name. The sidebar copy-prompt path (`promptSelected`, `KanbanProvider.ts:12151`) generates the prompt via `_generatePromptForColumn` → `_cardsToPromptPlans` → `buildDispatchPlans` and copies it to the clipboard; for a PLAN REVIEWED source it advances via the complexity-routing branch, which records `move-to-<column>` through `recordRunSheetForColumnMove` (`TaskViewerProvider.ts:8346`) — NOT a planner workflow name. So the sidebar copy-prompt path itself does not record `'improve-plan'`. The mismatch arises on the **CLI dispatch paths**: `handleKanbanBatchTrigger` (`TaskViewerProvider.ts:8185`) and the single-card dispatch (`:23495`) compute `workflowName = this._workflowNameForDispatchRole(role, instruction)` (`:8207`, `:8609`, `:23513`) and record it via `_updateSessionRunSheet`. `_plannerWorkflowNameForInstruction` (`:8451`) maps `'improve-plan'` → `'Improved plan'` but has **no mapping for `'improve-feature'`**, so even if the instruction were changed the run-sheet would fall back to `'sidebar-review'`. The instruction is hardcoded `role === 'planner' ? 'improve-plan' : undefined` at ~10 KanbanProvider sites, so a subtask dispatched via CLI records `'Improved plan'` while its prompt carries improve-feature.

## Metadata

**Tags:** backend, bugfix
**Complexity:** 3
**Feature:** (none — standalone bugfix)

## Complexity Audit

### Routine
- Add a subtask→parent resolution branch in `buildDispatchPlans`: when `isFeature === false` and `featureId` is set, look up the parent feature record and include it (plus all sibling subtasks) in the plans array.
- Add an `'improve-feature'` → `'Improved feature'` mapping to `_plannerWorkflowNameForInstruction` (`TaskViewerProvider.ts:8451`).

### Complex / Risky
- **`buildDispatchPlans` is the single plan-array builder for every dispatch/copy entry point.** Changing its output shape affects every downstream consumer (`generateUnifiedPrompt`, `partitionPlansByFeature`, `buildKanbanBatchPrompt`). The fix must not change the output for the existing feature-card path — only add a new resolution path for the subtask-card path.
- **Duplicate-plan dedup.** If the user selects a subtask AND its feature (multi-select on the board, though the board hides subtasks), the parent feature could appear twice. The existing `partitionPlansByFeature` handles duplicate feature keys (last-wins), but `buildDispatchPlans` itself does not dedup. The subtask→parent resolution must check whether the parent is already in the `records` array before adding it.
- **Sidebar vs board divergence.** The board's `promptSelected` handler receives `sessionIds` from the card's `data-plan-id` (always the feature for a feature card). The sidebar's `copyKanbanPlanPrompt` receives the subtask's `sessionId` directly. The fix must work for both paths — it should be in `buildDispatchPlans` (the shared builder), not in a caller-specific patch.
- **Run-sheet derivation must follow the resolved plans, not the instruction.** The three CLI recording sites (`:8207`, `:8609`, `:23513`) all have the resolved plans in scope (`validPlans` / `dispatchPlans`). The workflow name should be derived from `plans.some(p => p.isFeature)` — the same predicate `buildKanbanBatchPrompt` uses to select the workflow — so the run-sheet records what the prompt actually carried. Patching the ~10 KanbanProvider instruction sites is the wrong layer: they pass `sessionIds`, not plans, so each would need its own DB lookup to learn whether the dispatch is a feature. Deriving at the recording site (which already holds the plans) is one change in one place.

## Edge-Case & Dependency Audit

### Race Conditions
- None. `buildDispatchPlans` is async but not concurrent — each call builds its own array.

### Security
- None.

### Side Effects
- **Subtask copy-prompt buttons will now generate feature-mode prompts.** This is the intended fix, but it is a behaviour change: a subtask's "Copy planning prompt" button will now copy a prompt that references the entire feature and all sibling subtasks, not just the one subtask. This is correct — `improve-feature` is the workflow that should run for any part of a feature — but it is a visible change.
- **Column advancement changes.** The `promptSelected` handler advances the card to the next column. With the fix, a subtask's copy-prompt would advance the subtask card (not the feature card). This matches the existing behaviour for subtask selection on the board (selection-based operations trust the IDs). No change needed.
- **Run-sheet workflow name changes for feature CLI dispatches.** A subtask (or feature) dispatched via CLI will now record `'Improved feature'` instead of `'Improved plan'`. This is the intended tracking correction. Non-feature planner dispatches are unchanged.

### Dependencies & Conflicts
- None. This is a standalone bugfix with no prerequisite plans.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `buildDispatchPlans` (line 4758)

After the existing `isFeature` expansion block (line 4815-4828), add a subtask→parent resolution branch:

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

This requires extracting the per-record plan-building logic (lines 4767-4814) into a small helper (`_buildSingleDispatchPlan`) so the parent record can be built without duplicating the path-resolution logic. The helper is a pure refactor of the existing inline block — same fields, same resolution chain — extracted for reuse.

### `src/services/TaskViewerProvider.ts` — run-sheet workflow name derivation

The three CLI run-sheet recording sites derive the workflow name from a hardcoded instruction. They should derive it from the resolved plans' `isFeature` flag, so the run-sheet matches the workflow the prompt actually carries.

**1. `_plannerWorkflowNameForInstruction` (line 8451)** — add the feature mapping:

```typescript
private _plannerWorkflowNameForInstruction(instruction?: string): string | undefined {
    const { baseInstruction } = this._parsePromptInstruction(instruction);
    if (baseInstruction === 'improve-plan') {
        return 'Improved plan';
    }
    if (baseInstruction === 'improve-feature') {
        return 'Improved feature';
    }
    if (baseInstruction === 'enhance') {
        return 'Enhanced plan';
    }
    return undefined;
}
```

**2. The three recording sites** — derive the effective instruction from the resolved plans when the caller's instruction is the generic `'improve-plan'`. Each site already holds the resolved plans (`validPlans` at `:8197`/`:8598`, `dispatchPlans` at the single-card site). At each, before computing `workflowName`:

```typescript
// The run-sheet must record the workflow the prompt actually carries.
// buildKanbanBatchPrompt selects improve-feature when plans.some(p => p.isFeature);
// derive the instruction from the same source so the run-sheet matches.
const effectiveInstruction = role === 'planner' && validPlans.some(p => p.isFeature)
    ? 'improve-feature'
    : instruction;
const workflowName = this._workflowNameForDispatchRole(role, effectiveInstruction);
```

Apply at `TaskViewerProvider.ts:8207`, `:8609`, and `:23513` (the single-card site uses `dispatchPlans` in place of `validPlans`).

This does NOT change the prompt itself — the workflow selection in `buildKanbanBatchPrompt` is driven by `isFeatureTarget` (`plans.some(p => p.isFeature)`), which the `buildDispatchPlans` fix above already satisfies. The run-sheet derivation simply reads the same flag.

## Files Changed

- `src/services/KanbanProvider.ts` — `buildDispatchPlans`: add subtask→parent resolution; extract `_buildSingleDispatchPlan` helper.
- `src/services/TaskViewerProvider.ts` — `_plannerWorkflowNameForInstruction`: add `'improve-feature'` mapping; derive the run-sheet workflow name from the resolved plans' `isFeature` flag at the three CLI recording sites (`:8207`, `:8609`, `:23513`).

## Verification Plan

### Automated Tests
- Unit: `buildDispatchPlans` called with a single subtask record (`isFeature: 0`, `featureId: <parentId>`) returns an array whose first element has `isFeature: true` and whose length is `1 + siblingSubtaskCount`.
- Unit: `buildDispatchPlans` called with both a feature and one of its subtasks does not duplicate the feature in the output.
- Unit: `generateUnifiedPrompt('planner', <subtask-only plans>)` produces a prompt containing the improve-feature workflow path (`.agents/protocols/improve-feature/SKILL.md`), not improve-plan.
- Unit: `generateUnifiedPrompt('planner', <loose-plan-only plans>)` still produces the improve-plan workflow path (regression guard).
- Unit: `_plannerWorkflowNameForInstruction('improve-feature')` returns `'Improved feature'`; `('improve-plan')` still returns `'Improved plan'` (regression guard).
- Unit: a planner CLI dispatch whose resolved plans include a feature records `'Improved feature'` in the run-sheet; a non-feature planner dispatch still records `'Improved plan'`.
- Regression: existing feature-card dispatch tests still pass unchanged (the feature-card path is not modified).

*(Automated tests and compilation skipped this run per dispatch directive; the checks remain written for the implementing coder.)*

### Goal Invariants
- Assert that `partitionPlansByFeature` returns `featureGroups.length >= 1` when the input plans array originated from a subtask-only selection.
- Assert that `buildKanbanBatchPrompt` receives `featureMode: true` when the plans array originated from a subtask-only selection.
- Assert that the run-sheet workflow name recorded for a feature planner CLI dispatch is `'Improved feature'`, not `'Improved plan'`.
- Assert that a non-feature planner CLI dispatch still records `'Improved plan'` (regression guard).

### Manual Verification
1. **Sidebar: subtask copy-prompt.** Open the Planning panel, switch to the Plans view, find a subtask of a feature, click its "Copy planning prompt" button. Paste the clipboard. The prompt must reference the improve-feature workflow and list all sibling subtasks, not just the one subtask.
2. **Sidebar: feature copy-prompt.** Click the feature's own copy-prompt button. The prompt must be unchanged from today (regression).
3. **Sidebar: loose plan copy-prompt.** Click a standalone plan's copy-prompt button. The prompt must still use improve-plan (regression).
4. **Board: feature card copy-prompt.** Click the feature card's copy-prompt button on the kanban board. Unchanged (regression — the board path was never broken).
5. **Run-sheet check.** After a subtask CLI dispatch (not copy-prompt — the copy-prompt path records `move-to-<col>`), inspect the run-sheet and confirm the recorded workflow is `Improved feature`. After a standalone-plan CLI dispatch, confirm it is still `Improved plan`.

## Risks

- **`buildDispatchPlans` is the single builder.** Any change to its output ripples through every dispatch path. The fix is additive (new branch for a previously-unhandled case), not modifying the existing feature-card or loose-plan paths, but the extraction of `_buildSingleDispatchPlan` is a refactor that must be byte-identical in its output.
- **Sidebar behaviour change is visible.** A subtask's copy-prompt button now copies a feature-level prompt. This is correct but different — a user who previously relied on the subtask-only prompt (even though it was wrong) will see a different payload.
- **Run-sheet derivation touches three sites in TaskViewerProvider.** Each must use the plans variable in scope at that site (`validPlans` for the two batch sites, `dispatchPlans` for the single-card site). A copy-paste that uses the wrong variable name compiles only if both exist in scope — verify each site individually.

---

**Recommendation: Send to Coder** (complexity 3 — the `buildDispatchPlans` branch is additive and the helper extraction is a pure refactor, but the run-sheet derivation spans three TaskViewerProvider sites that must each be verified to use the correct in-scope plans variable. The sidebar-vs-board divergence is the inherited trap: a green board check proves nothing.)
