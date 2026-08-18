# Auto-Column Feature-Scoped Subtasks to PLAN REVIEWED on Import

## Goal

Auto-advance freshly imported feature-scoped subtasks from `CREATED` to `PLAN REVIEWED` when a `**Feature:**` frontmatter line is detected, eliminating the manual `move-card.js` step that `improve-feature` and `rearrange-feature` currently require. A plan carrying a `**Feature:**` frontmatter line has been authored as part of a reviewed feature set (merge, split, or initial grouping) and is by definition already reviewed — the importer has the information to place it correctly.

## Metadata

**Complexity:** 3
**Tags:** backend, feature, refactor, reliability
**Project:** Browser Switchboard

## User Review Required

No user review required — the change is a straightforward extension of existing import logic with well-understood guard conditions.

## Complexity Audit

### Routine
- Adding a single conditional `movePlanByPlanFile` call inside an existing function (`_applyFeatureLink`)
- The guard conditions (`featureId` empty, `featureRow` exists, `kanbanColumn === 'CREATED'`) are already present or trivially added
- `movePlanByPlanFile` is an existing method with a confirmed signature, already used for tombstone restoration in the same file
- Skill text updates (removing manual-move instructions) are documentation changes

### Complex / Risky
- The auto-move fires a second `_fireColumnChanged` event after the initial `CREATED` event from `insertFileDerivedPlan` — verify the board UI handles two rapid column-change events for the same plan without flicker or race

## Problem

When `improve-feature` (or any skill) creates a new plan file with a `**Feature:** <featureId>` frontmatter line, the plan watcher imports it and links it to the feature — but leaves it in `CREATED`. The skill then has to manually move the card to `PLAN REVIEWED` using `kanban_operations` / `move-card.js`. This is an unnecessary manual step that agents sometimes bypass by writing to `kanban.db` directly via `sqlite3` (no `-readonly`), which corrupts board state.

The importer already has the information it needs: a plan carrying a `**Feature:**` frontmatter line has been authored as part of a feature set (merge, split, or initial grouping) and is by definition already reviewed. It should land in `PLAN REVIEWED` automatically.

## Root Cause

`PlanIngestionEngine._applyFeatureLink` (src/services/PlanIngestionEngine.ts:965) calls `db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId)` to set `feature_id`, but never touches `kanban_column`. The card stays in whatever column `insertFileDerivedPlan` put it in — always `CREATED` for fresh imports.

## Proposed Changes

### 1. Auto-move to PLAN REVIEWED in `_applyFeatureLink`

In `PlanIngestionEngine._applyFeatureLink` (src/services/PlanIngestionEngine.ts:996), after the successful `db.updateFeatureStatus` call, add a column move:

```typescript
await db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId);
// Auto-advance freshly linked subtasks to PLAN REVIEWED — a plan carrying a
// **Feature:** frontmatter line has been authored as part of a reviewed feature
// set (merge/split/grouping). The guard above (featureId already set → return)
// ensures this only fires on fresh links, never on re-imports.
if (subtaskRow.kanbanColumn === 'CREATED') {
    await db.movePlanByPlanFile(relativePath, workspaceId, 'PLAN REVIEWED', relativePath);
    this._host.logger.appendLine(
        `[GlobalPlanWatcher] Auto-advanced subtask ${relativePath} to PLAN REVIEWED (fresh feature link)`
    );
}
```

**Guard conditions (all already present in the function):**
- `subtaskRow.featureId` is empty (line 993: `if (subtaskRow.featureId && subtaskRow.featureId !== '') return;`) — only fresh links
- `featureRow` exists and `isFeature` is true (line 978) — the feature is real
- The subtask is not itself a feature file (line 974: `if (relativePath.startsWith('.switchboard/features/')) return;`)

**New condition:** Only move if `kanbanColumn === 'CREATED'`. This preserves:
- Re-imports (ON CONFLICT preserves column; `_applyFeatureLink` won't fire because `featureId` is already set)
- Plans the user manually moved to BACKLOG before the feature link resolved (the pending-link retry path — if the card was moved to BACKLOG while waiting for the feature to appear, it stays in BACKLOG)
- Plans in any non-CREATED column for any reason

### 2. Remove the manual-move instruction from `improve-feature` skill

In `.agents/skills/improve-feature/SKILL.md` **and** `.claude/skills/improve-feature/SKILL.md` (separate files, not symlinks — both must be updated), Step 4, remove the instruction:

> *"After restructuring, you MUST move each **newly created** plan file (merges, splits) to `PLAN REVIEWED` using the session-appropriate mechanism..."*

Replace with a note that newly created plans carrying a `**Feature:**` frontmatter line are auto-advanced to `PLAN REVIEWED` by the importer. The `kanban_operations` fallback is still needed for plans that don't carry the frontmatter line (edge case: a plan created outside a feature context that the agent later assigns via `assign-to-feature.js`).

### 3. Same change for the High/Low mode variant

The High/Low mode section of `improve-feature` (Step 4, variant) has the same manual-move instruction. Apply the same update — in both `.agents/skills/` and `.claude/skills/` copies.

### 4. Same change for `rearrange-feature` skill

`.agents/skills/rearrange-feature/SKILL.md` **and** `.claude/skills/rearrange-feature/SKILL.md` also instruct manual column moves for newly created subtasks (line 36: "move it to `PLAN REVIEWED` via the Notion/Linear provider or MCP"). If rearrange-feature creates new plan files with `**Feature:**` frontmatter, they'll auto-advance too. Update the skill text in both copies to reflect this.

## Edge-Case & Dependency Audit

1. **Race: feature file not yet imported when subtask arrives.** `_applyFeatureLink` already handles this via `_pendingFeatureLinks` (retries up to 5 times). The auto-move will fire on the retry that succeeds. No change needed.

2. **Plan created in CREATED, user moves to BACKLOG, then feature link resolves.** The `kanbanColumn === 'CREATED'` guard prevents the auto-move — the card stays in BACKLOG. Correct behavior.

3. **Plan created by a planner (not improve-feature) with a `**Feature:**` line.** This is fine — any plan carrying a `**Feature:**` frontmatter has been authored as part of a feature set and is reviewed. The auto-move is correct.

4. **Bulk re-import (Reset Database command).** `importPlanFiles` calls `insertFileDerivedPlan` for each file. For existing plans, the ON CONFLICT clause preserves the column. For new plans with `**Feature:**` lines, the watcher's `_handlePlanFile` path fires (not the bulk import path), so `_applyFeatureLink` runs and auto-advances. No issue.

5. **`movePlanByPlanFile` signature.** Confirmed: `movePlanByPlanFile(planFile: string, workspaceId: string, newColumn: string, newPlanFile?: string)` at KanbanDatabase.ts:2708. The call `db.movePlanByPlanFile(relativePath, workspaceId, 'PLAN REVIEWED', relativePath)` matches. Used identically for tombstone restoration at PlanIngestionEngine.ts:1691.

6. **Column-changed event.** `insertFileDerivedPlan` (KanbanDatabase.ts:2450) fires `_fireColumnChanged(relativePlanFile, 'CREATED')` on fresh insert. The subsequent auto-move fires a second `_fireColumnChanged` for `PLAN REVIEWED` via `movePlanByPlanFile` (KanbanDatabase.ts:2732). Both events are in `KanbanDatabase.ts`, not `PlanIngestionEngine.ts`. Verify the board UI handles two rapid column-change events without flicker — the board's column-change listener likely debounces UI updates, but this must be confirmed.

7. **`subtaskRow.kanbanColumn` field name.** Confirmed: `getPlanByPlanId` returns a `KanbanPlanRecord` with `kanbanColumn` mapped from `kanban_column` (KanbanDatabase.ts:8865, 10382). The field defaults to `'CREATED'` if null.

8. **Tombstone interaction.** If a plan is deleted and re-created with a `**Feature:**` line, the tombstone restoration in `_handlePlanFile` (PlanIngestionEngine.ts:1688-1701) runs first, restoring the plan to its prior column (e.g. `IN PROGRESS`). Then `_applyFeatureLink` runs, but `kanbanColumn !== 'CREATED'` (it's `IN PROGRESS`), so the auto-move does NOT fire. This is correct — a re-created plan should preserve its prior column, not reset to `PLAN REVIEWED`.

9. **`assign-to-feature.js` path.** The auto-move only fires inside `_applyFeatureLink`, which is triggered by the plan watcher on file import (when a `**Feature:**` frontmatter line is detected). Plans assigned to a feature via `assign-to-feature.js` (the API path) do NOT trigger `_applyFeatureLink` — they are linked directly in the DB. These plans will NOT auto-advance. This is by design: `assign-to-feature.js` is the manual fallback for plans created outside a feature context. The skill text update in Step 2 clarifies when this fallback is still needed.

## Dependencies

- None — this is a self-contained change to the import pipeline. No other plan or feature must land first.

## Adversarial Synthesis

Key risks: (1) double `_fireColumnChanged` event (CREATED → PLAN REVIEWED) could cause board UI flicker — mitigated by the board's likely debounce, but must be verified; (2) the auto-move only fires inside `_applyFeatureLink` (file-import path), so plans linked via `assign-to-feature.js` (API path) won't auto-advance — by design, but the skill text must clarify this; (3) `.claude/skills/` copies of the skill files must be updated alongside `.agents/skills/` copies or Claude Code agents will still see the old manual-move instructions.

## Verification Plan

1. **Unit test:** Create a plan file with a `**Feature:** <featureId>` frontmatter line in a workspace with an existing feature. Verify the card lands in `PLAN REVIEWED` after the watcher processes it.
2. **Unit test:** Create a plan file with a `**Feature:**` line, manually move it to `BACKLOG` before the watcher processes it. Verify it stays in `BACKLOG` (the `kanbanColumn === 'CREATED'` guard).
3. **Unit test:** Re-import an existing feature subtask (modify and save the file). Verify the column is preserved (ON CONFLICT + `featureId` already set → `_applyFeatureLink` returns early).
4. **Integration test:** Run `improve-feature` on a test feature with 3 subtasks. Merge two into one. Verify the new merged plan auto-advances to `PLAN REVIEWED` without any manual `move-card.js` call.
5. **Check:** Verify the kanban UI updates to show the card in PLAN REVIEWED (column-changed event fires) and that the double event (CREATED → PLAN REVIEWED) does not cause visible flicker.
6. **Check:** Verify tombstone restoration interaction — delete a plan in `IN PROGRESS`, re-create it with a `**Feature:**` line, confirm it stays in `IN PROGRESS` (not auto-advanced).
