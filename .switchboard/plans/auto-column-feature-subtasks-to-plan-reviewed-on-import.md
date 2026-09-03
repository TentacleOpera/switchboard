# Auto-Column Feature-Scoped Subtasks to Their Feature's Column on Import

<!-- board-collapse-03 -->
> **REWRITTEN 2026-09-04 (Board Collapse 03, decision 6).** This plan previously moved every freshly linked subtask to a hardcoded `PLAN REVIEWED`. It now moves it to **its feature's current column**, whatever that is. The body below has been rewritten to match; the plan id and file name are unchanged. This card has also moved from *Eliminate Manual Card Moves* into the **Board State Integrity** feature, where it lands last of four.

## Goal

When the plan watcher links a freshly imported plan to a feature via its `**Feature:**` frontmatter line, move that subtask into the feature's current column, eliminating the manual `move-card.js` step that `improve-feature` and `rearrange-feature` require today.

### Problem analysis

`PlanIngestionEngine._applyFeatureLink` (`src/services/PlanIngestionEngine.ts:965`) calls `db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId)` to set `feature_id`, but never touches `kanban_column`. The card stays wherever `insertFileDerivedPlan` put it, which is always `CREATED` for a fresh import. The authoring skill then has to move the card by hand, and agents sometimes bypass that by writing to `kanban.db` directly with `sqlite3`, corrupting board state.

The importer already has what it needs. It has resolved `featureRow` in order to link the subtask, so it knows the feature's column.

**Why not a fixed target column.** An earlier revision of this plan moved the subtask to `PLAN REVIEWED`. That is wrong in every case where the feature is not itself in Planned: it produces exactly the column-mixed feature that the sibling plans in this feature exist to prevent, and it can advance a subtask past its own feature. The rule that holds in all cases is containment — a subtask's column is its feature's column.

**The common case, from the operator (2026-09-04).** A plan reviewer working through a feature in Planned decides the feature needs another subtask and writes the plan file. The feature is in Planned, so the new subtask must start in Planned beside it. The same code puts a subtask added to a New feature in New, and one added to a feature already in a coding column into that column. Naming any specific column in this rule reintroduces the defect.

## Metadata

- **Complexity:** 3
- **Tags:** backend, feature, refactor, reliability
- **Project:** Browser Switchboard

## User Review Required

None.

## Proposed Changes

### 1. Adopt the feature's column in `_applyFeatureLink`

In `PlanIngestionEngine._applyFeatureLink`, after the successful `db.updateFeatureStatus` call, move the subtask to the feature's column when the two differ:

```typescript
await db.updateFeatureStatus(subtaskPlanId, 0, featureRow.planId);
// Containment: a subtask's column is its feature's column. A plan carrying a
// **Feature:** frontmatter line was authored as part of that feature's set, so
// it belongs wherever the feature currently sits — never a hardcoded column.
// The featureId guard above means this fires only on a fresh link.
const featureColumn = featureRow.kanbanColumn;
if (featureColumn && subtaskRow.kanbanColumn === 'CREATED' && featureColumn !== 'CREATED') {
    await db.movePlanByPlanFile(relativePath, workspaceId, featureColumn, relativePath);
    this._host.logger.appendLine(
        `[GlobalPlanWatcher] Linked subtask ${relativePath} adopted feature column ${featureColumn}`
    );
}
```

**Guards, all already present in the function:**

- `subtaskRow.featureId` is empty (`:993`) — fresh links only, so a re-import never re-moves a card.
- `featureRow` exists and `isFeature` is true (`:978`) — the feature is real.
- The subtask is not itself a feature file (`:974`).

**New conditions.** The subtask must still be in `CREATED`, so a card the operator has already moved is left alone. The feature's column must be non-empty and different from `CREATED`, so the common no-op costs no write and fires no event.

### 2. Remove the manual-move instruction from the `improve-feature` skill

In `.agents/skills/improve-feature/SKILL.md` and its `.claude/` counterpart, Step 4, remove:

> *"After restructuring, you MUST move each newly created plan file (merges, splits) to `PLAN REVIEWED` using the session-appropriate mechanism…"*

Replace it with a statement that a new plan carrying a `**Feature:**` frontmatter line is placed in its feature's column by the importer, and that no manual move is needed. Keep the `kanban_operations` fallback documented for the one case it still covers: a plan created outside a feature context and attached afterwards with `assign-to-feature.js`.

### 3. The same change in the High/Low mode variant

The High/Low section of `improve-feature` carries the same instruction. Apply the same edit, in both copies.

### 4. The same change in `rearrange-feature`

`.agents/skills/rearrange-feature/SKILL.md` and its `.claude/` counterpart instruct a manual move for newly created subtasks. Update both to describe the adopt-the-feature's-column behaviour.

> **Note on both skill files.** The Claude mirror generator is being deleted (*Delete the Claude mirror generator*), so `.agents/` and `.claude/` copies are both committed source and are edited in the same commit. Do not run a mirror regeneration.

## Edge-Case & Dependency Audit

1. **Feature file not yet imported when the subtask arrives.** Already handled by `_pendingFeatureLinks`, which retries. The move fires on the retry that resolves the feature, reading the feature's column at that moment.
2. **Feature is itself in `CREATED`.** No move, no event. The subtask is already in the right place.
3. **Operator moved the plan to `BACKLOG` before the link resolved.** The `subtaskRow.kanbanColumn === 'CREATED'` guard leaves it in `BACKLOG`.
4. **Feature is in a coding column.** The subtask adopts that column. This is the containment rule and is deliberate: a subtask of an in-flight feature belongs with it, not behind it.
5. **Re-import of an existing subtask.** `_applyFeatureLink` returns early because `featureId` is set, and `ON CONFLICT` preserves the column.
6. **Tombstone restoration.** A deleted plan re-created with a `**Feature:**` line is first restored to its prior column by `_handlePlanFile`; the guard then sees a non-`CREATED` column and does not move it. Correct.
7. **`assign-to-feature.js` path.** That script links in the database and does not run `_applyFeatureLink`, so it does not adopt the column. That is the manual fallback the skill text still documents. If the sibling plans make containment an enforced invariant, the API path should get the same adoption; record it there rather than widening this plan.
8. **Two column-changed events.** `insertFileDerivedPlan` fires `_fireColumnChanged(..., 'CREATED')` and the adoption fires a second for the feature's column. Verify the board coalesces them without flicker. Both events originate in `KanbanDatabase.ts`.
9. **`movePlanByPlanFile` signature.** `movePlanByPlanFile(planFile, workspaceId, newColumn, newPlanFile?)` at `KanbanDatabase.ts:2708`; used the same way for tombstone restoration at `PlanIngestionEngine.ts:1691`.
10. **`featureRow.kanbanColumn` field name.** `getPlanByPlanId` returns a record with `kanbanColumn` mapped from `kanban_column`, defaulting to `CREATED` when null. Treat a null as "no move".

## Dependencies

Lands **last** of the four column-containment plans in *Board State Integrity*, after:

1. *Every Feature Move Carries Its Subtasks* — the cascade and the single startup reconcile.
2. *A Subtask's Column Is Its Feature's Column* — the predicate and the refusal.
3. *Feature Creation Can Produce a Column-Mixed Feature* — creation-time resolution.

Landing earlier is harmless but pointless: until the cascade owns column changes, an adopted column can drift again on the next feature move.

## Verification Plan

1. Feature in **Planned**; create a plan file carrying its `**Feature:**` line. The card lands in Planned, not New. This is the reviewer case and is the headline test.
2. Feature in **New**; same test. The card stays in New and no move event fires.
3. Feature in a **coding column**; same test. The card adopts that column.
4. Feature in Planned; move the plan file's card to Backlog before the watcher links it. It stays in Backlog.
5. Re-import an existing subtask by touching its file. Its column is unchanged.
6. Delete a plan that was in a coding column, then re-create it with a `**Feature:**` line. It returns to its prior column, not the feature's.
7. Run `improve-feature` on a feature in Planned that gains a merged subtask. The new card appears in Planned with no `move-card.js` call, and the feature is not column-mixed.
8. Board UI: the card appears once in its final column; the two column-changed events cause no visible flicker.
9. Grep the plan and both skill copies: no instruction names a specific destination column.
