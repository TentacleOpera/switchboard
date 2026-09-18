# Add Worktree Icon to Kanban Plan Cards

## Goal

Add a worktree icon to plan cards on the kanban board in the top right corner to indicate whether a plan has been assigned a worktree. The icon should visually indicate the worktree state: active (not merged/deleted) vs. merged/deleted.

## Metadata

- **Tags:** UI, frontend, workflow
- **Complexity:** 5

## User Review Required

- Confirm icon design for worktree states (active vs. merged/deleted)
- Confirm tooltip text for each state
- **[NEW]** Confirm the `worktree_id` nulling policy: should `worktree_id` remain set after merge/delete (recommended for tooltip branch name), or should the branch name be stored separately?

## Complexity Audit

### Routine
- Adding `worktree_status` column to plans table via migration (follows existing migration pattern)
- Adding icon constants to kanban.html (follows existing ICON_ pattern)
- Modifying `createCardHtml` to render icon in card header (follows existing card rendering pattern)
- Adding SVG icon files to `icons/` directory

### Complex / Risky
- Icon placement in card header requires careful CSS positioning to avoid overlapping with existing elements
- Worktree status state machine must be updated consistently across **4 distinct** deletion/merge paths (one previously unidentified: `_cleanupWorktreeAfterReview`)
- Migration backfill must correctly seed `worktree_status = 'active'` for pre-existing plans with `worktree_id IS NOT NULL`; the `DEFAULT 'none'` alone is insufficient
- Icon display logic must gate on `worktree_status`, **not** on `worktreeId`, because `worktree_id` is nulled out on deletion and would suppress the icon prematurely

## Edge-Case & Dependency Audit

- **Race Conditions**: None - worktree status updates are synchronous operations
- **Security**: None - UI-only change, no new data exposure
- **Side Effects**: `deleteWorktree()` in `KanbanDatabase` already NULLs `worktree_id` for any plan referencing the deleted worktree. After deletion the plan's `card.worktreeId` is `undefined`, so the icon HTML must rely solely on `worktree_status` (not `worktreeId`) to decide whether to render.
- **Dependencies & Conflicts**: Depends on existing worktrees table (V24/V25 migrations). The `worktreeId` field on plans must be populated. `PLAN_COLUMNS` and `_readRows()` must include the new column.
- **Missed Deletion Path**: `_cleanupWorktreeAfterReview` (KanbanProvider.ts ~line 6896) calls `deleteWorktree` + `updatePlanWorktree(null)` but was not listed in the original Phase 5. Must be covered.
- **False-Positive Path**: The rollback inside `_createWorktreeForPlan` (~line 6755) calls `db.deleteWorktree(id)` before any plan is assigned, so no status update is needed there.
- **Migration Backfill**: `ALTER TABLE … DEFAULT 'none'` gives ALL existing rows `'none'`. A backfill SQL step is required: `UPDATE plans SET worktree_status = 'active' WHERE worktree_id IS NOT NULL`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) The icon gating on `card.worktreeId` will suppress the merged/deleted icon because `deleteWorktree()` NULLs `worktree_id` — the render logic must gate on `worktree_status` instead. (2) V27 migration sets `DEFAULT 'none'` for all rows, silently breaking existing plans with active worktrees unless a backfill SQL step is included. (3) `_cleanupWorktreeAfterReview` is a fourth worktree deletion path not covered by the original plan. Mitigations: gate icon render on `worktree_status !== 'none'`, add backfill UPDATE to V27 migration, add status update call to `_cleanupWorktreeAfterReview`.

## Motivation

- **Visibility**: Users can quickly see which plans have active worktrees
- **State Awareness**: Users can distinguish between worktrees that are still active vs. those that have been merged/deleted
- **Workflow Clarity**: Helps users understand the state of their worktree-based development workflow

## High-Level Design

### User Flow

1. Plan card displays on kanban board
2. If plan has a worktree assigned (ever), an icon appears in the top-right corner of the card
3. Icon visual state indicates:
   - Active worktree (not merged/deleted): one icon style (teal-tinted branch icon)
   - Merged/deleted worktree: different icon style (grayscale/dimmed)
4. Tooltip on hover shows worktree status details

### Architecture Components

1. **Database Schema**: Add `worktree_status` column to plans table (not worktrees table - worktrees are deleted on merge, so status must persist on the plan)
2. **Icon Constants**: Add worktree icon constants to kanban.html
3. **Card Rendering**: Modify `createCardHtml` to render worktree icon in card header, gated on `worktree_status` (NOT `worktreeId`)
4. **Status Updates**: Update worktree status on assignment/merge/delete operations across ALL four paths
5. **Icon Injection**: Add worktree icon to KanbanProvider icon map
6. **SVG Icons**: Create `worktree-active.svg` and `worktree-merged.svg` in `icons/`

## Implementation Steps

### Phase 1: Database Schema Update

**File**: `src/services/KanbanDatabase.ts`

1. Add `worktree_status` column to plans table via migration V27 (~line 3865, after V26 block):
   ```typescript
   const MIGRATION_V27_SQL = [
       `ALTER TABLE plans ADD COLUMN worktree_status TEXT DEFAULT 'none'`,
       // Backfill: plans that already have a worktree assigned should start as 'active'
       `UPDATE plans SET worktree_status = 'active' WHERE worktree_id IS NOT NULL`,
   ];
   ```

2. Add V27 migration execution in `_runMigrations()` (after V26 block, before the closing `}`):
   ```typescript
   // V27: add worktree_status column to plans table
   const v27 = await this.getMigrationVersion();
   if (v27 < 27) {
       for (const sql of MIGRATION_V27_SQL) {
           try { this._db.exec(sql); } catch (e) {
               console.debug('[KanbanDatabase] V27 migration step skipped (already applied):', e);
           }
       }
       await this.setMigrationVersion(27);
       console.log('[KanbanDatabase] V27 migration completed: worktree_status column added');
   }
   ```

3. Add `worktree_status` to `KanbanPlanRecord` interface (line 19-44, after `worktreeId`):
   ```typescript
   worktreeStatus?: string; // 'none' | 'active' | 'merged' | 'deleted'
   ```

4. Update `PLAN_COLUMNS` constant (line 473-476) to include `worktree_status`:
   ```typescript
   const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                          repo_scope, project, workspace_id, created_at, updated_at, last_action, source_type,
                          brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                          clickup_task_id, linear_issue_id, worktree_id, worktree_status`;
   ```

5. Update `_readRows()` (line 4611, after `worktreeId` mapping) to map `worktree_status`:
   ```typescript
   worktreeStatus: String(row.worktree_status || 'none') as 'none' | 'active' | 'merged' | 'deleted',
   ```

6. Add method to update worktree status (after `updatePlanWorktree` at line 1460):
   ```typescript
   public async updatePlanWorktreeStatus(sessionId: string, status: 'none' | 'active' | 'merged' | 'deleted'): Promise<void> {
       if (!this._db) return;
       this._db.run(
           'UPDATE plans SET worktree_status = ? WHERE session_id = ?',
           [status, sessionId]
       );
       await this._persist();
   }
   ```

> **Clarification**: The `UPSERT_PLAN_SQL` does not need to include `worktree_status` because this field is managed exclusively by `updatePlanWorktreeStatus()` and the V27 migration, not by plan upserts (which would overwrite the status on every re-import).

### Phase 2: Icon Files

**Directory**: `icons/`

Create two SVG files. Both must use `currentColor` for theme adaptability and a 16×16 viewBox:

**`icons/worktree-active.svg`** — a git branch/fork icon in teal (use a colored fill directly in SVG since `<img>` tags don't inherit CSS `color`):
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="#4fc3f7" d="M5 3.5a1.5 1.5 0 1 1-1 1.415V8.5a3 3 0 0 0 3 3h1.086a1.5 1.5 0 1 1 0 1H7a4 4 0 0 1-4-4V4.915A1.5 1.5 0 0 1 5 3.5zm6 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 4.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1zm6 7a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z"/>
  <path fill="#4fc3f7" d="M11 2a1.5 1.5 0 0 1 1 2.583V7.5a3 3 0 0 1-3 3H7.914A1.5 1.5 0 1 1 7.914 9H9a2 2 0 0 0 2-2V4.583A1.5 1.5 0 0 1 11 2zm0 1a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z"/>
</svg>
```

**`icons/worktree-merged.svg`** — same shape but grey/dimmed:
```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="#888888" d="M5 3.5a1.5 1.5 0 1 1-1 1.415V8.5a3 3 0 0 0 3 3h1.086a1.5 1.5 0 1 1 0 1H7a4 4 0 0 1-4-4V4.915A1.5 1.5 0 0 1 5 3.5zm6 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM5 4.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1zm6 7a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z"/>
  <path fill="#888888" d="M11 2a1.5 1.5 0 0 1 1 2.583V7.5a3 3 0 0 1-3 3H7.914A1.5 1.5 0 1 1 7.914 9H9a2 2 0 0 0 2-2V4.583A1.5 1.5 0 0 1 11 2zm0 1a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z"/>
</svg>
```

### Phase 3: Icon Constants

**File**: `src/webview/kanban.html`

1. Add worktree icon constants (near line 3168, with other ICON_ constants):
   ```javascript
   const ICON_WORKTREE_ACTIVE = '{{ICON_WORKTREE_ACTIVE}}';
   const ICON_WORKTREE_MERGED = '{{ICON_WORKTREE_MERGED}}';
   ```

2. Add CSS for worktree icon positioning (in the `<style>` section, after `.kanban-card` styles ~line 510):
   ```css
   .card-worktree-icon {
       position: absolute;
       top: 8px;
       right: 8px;
       width: 14px;
       height: 14px;
       opacity: 0.85;
       transition: opacity 0.2s;
       pointer-events: auto;
   }
   .card-worktree-icon:hover {
       opacity: 1;
   }
   .card-worktree-icon.merged {
       opacity: 0.35;
   }
   ```

### Phase 4: Card Rendering Update

**File**: `src/webview/kanban.html`

1. Modify `createCardHtml` function (line 4448). **Important**: Gate on `card.worktreeStatus`, NOT `card.worktreeId`, because `worktree_id` is NULLed on deletion:

   Replace the existing `worktree`/`branchInfo` block (lines 4461-4462) with:
   ```javascript
   const worktree = card.worktreeId ? (lastWorktrees || []).find(wt => wt.id === card.worktreeId) : null;
   const branchInfo = worktree ? `<div class="card-branch" style="font-family:var(--font-mono); font-size:8px; color:var(--accent-teal, #4fc3f7); margin-top:2px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="Branch: ${escapeAttr(worktree.branch)}">🌿 ${escapeHtml(worktree.branch)}</div>` : '';

   // Worktree icon: gated on worktreeStatus (not worktreeId, which is NULLed on deletion)
   const worktreeStatus = card.worktreeStatus || 'none';
   const worktreeIconHtml = worktreeStatus !== 'none'
       ? `<img src="${worktreeStatus === 'active' ? ICON_WORKTREE_ACTIVE : ICON_WORKTREE_MERGED}"
            class="card-worktree-icon ${worktreeStatus !== 'active' ? 'merged' : ''}"
            alt="Worktree"
            title="Worktree: ${worktree ? escapeHtml(worktree.branch) : 'removed'} (${escapeHtml(worktreeStatus)})">`
       : '';
   ```

2. Insert `${worktreeIconHtml}` into the card template (line 4536), inside the `.kanban-card` div but before the topic div:
   ```javascript
   return `
       <div class="kanban-card${completedClass}" draggable="true" data-plan-id="${cardId}" data-session="${escapeAttr(card.sessionId || '')}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
           ${worktreeIconHtml}
           <div class="card-topic">${depWarningHtml}${escapeHtml(shortTopic)}${branchInfo}</div>
           ...
   `;
   ```

> Note: `.kanban-card` already has `position: relative` (line 484), so no CSS change is needed there.

### Phase 5: Icon Injection

**File**: `src/services/KanbanProvider.ts`

1. Add worktree icons to the icon injection map (near line 6613, with other icon mappings):
   ```typescript
   '{{ICON_WORKTREE_ACTIVE}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-active.svg')).toString(),
   '{{ICON_WORKTREE_MERGED}}': webview.asWebviewUri(vscode.Uri.joinPath(iconDir, 'worktree-merged.svg')).toString(),
   ```

### Phase 6: Status Updates on Worktree Lifecycle

**File**: `src/services/KanbanProvider.ts`

All four lifecycle paths must update `worktree_status`. The rollback path inside `_createWorktreeForPlan` (~line 6755) is intentionally excluded because no plan is assigned yet at that point.

**6a. On worktree assignment** — in `_assignWorktreeToCard` (line 6684, after `db.updatePlanWorktree`):
```typescript
await db.updatePlanWorktree(sessionId, worktreeResult.id);
await db.updatePlanWorktreeStatus(sessionId, 'active'); // NEW
```

**6b. On merge cleanup** — in `_cleanupWorktreeAfterMerge` (line 6853, after `db.deleteWorktree`):
```typescript
await db.deleteWorktree(worktree.id);
await db.updatePlanWorktree(plan.sessionId, null);
await db.updatePlanWorktreeStatus(plan.sessionId, 'merged'); // NEW
```

**6c. On user-initiated delete** — in `deleteWorktree` handler (line 6306, before `db.deleteWorktree`):
```typescript
// Get plans referencing this worktree before deletion clears worktree_id
const workspaceId2 = await db.getWorkspaceId();
const boardCards = workspaceId2 ? await db.getBoard(workspaceId2) : [];
const affectedPlans = boardCards.filter(c => c.worktreeId === wt.id);
for (const p of affectedPlans) {
    await db.updatePlanWorktreeStatus(p.sessionId, 'deleted'); // NEW
}
await db.deleteWorktree(Number(msg.worktreeId));
```
> Note: `allCards` is already fetched at line 6277 — the `affectedPlans` query can reuse that variable instead of a new `getBoard()` call.

**6d. On review cleanup** — in `_cleanupWorktreeAfterReview` (line 6920, inside the `if (choice === 'Clean Up')` block, after `db.deleteWorktree`):
```typescript
await db.deleteWorktree(worktree.id);
await db.updatePlanWorktreeStatus(plan.sessionId, 'deleted'); // NEW
```

## Testing

### Test Cases

1. **Icon Visibility**:
   - Plan without worktree: `worktree_status = 'none'` → no icon displayed
   - Plan with active worktree: `worktree_status = 'active'` → active icon displayed in top-right
   - Plan with merged worktree: `worktree_status = 'merged'` → merged icon displayed (dimmed)
   - Plan with deleted worktree: `worktree_status = 'deleted'` → merged icon displayed (dimmed)

2. **Icon Positioning**:
   - Icon appears in top-right corner without overlapping card content
   - Icon is visible on different card states (selected, completed, etc.)
   - Icon does not overlap with `.card-actions` buttons (icon is 14px, top-right positioned)

3. **Status Transitions**:
   - Worktree created: status = 'active', icon shows active state
   - Worktree merged: status = 'merged', icon shows merged/dimmed state, `worktree_id` is NULL
   - Worktree deleted (user-initiated): status = 'deleted', icon shows merged/dimmed state, `worktree_id` is NULL
   - Worktree cleaned up post-review: status = 'deleted'

4. **Tooltip**:
   - Hover over icon: shows `"Worktree: <branch> (active)"` when worktree still exists
   - Hover over icon: shows `"Worktree: removed (merged)"` when worktree is deleted

5. **Migration**:
   - Fresh DB: all plans start with `worktree_status = 'none'` — no icons
   - Existing DB with active worktrees: V27 backfill sets `worktree_status = 'active'` for rows where `worktree_id IS NOT NULL`

### Automated Tests

- Manual smoke test only (no automated test infrastructure change needed)

## Edge Cases & Considerations

1. **Icon Overlap**: Ensure icon doesn't overlap with card actions or topic text. Icon is 14px in top-right; `.card-topic` starts at top-left. Padding on `.kanban-card` is 10px 12px, so icon at `top: 8px; right: 8px` is within the padding zone and should not overlap text in a normal card.
2. **Status Consistency**: Ensure ALL four worktree lifecycle paths update status before/after deletion.
3. **Backward Compatibility**: V27 migration backfill correctly seeds `'active'` for existing plans with assigned worktrees. Default `'none'` applies to plans that never had a worktree.
4. **Icon Performance**: SVG files are small and static. No performance concern.
5. **Accessibility**: `alt="Worktree"` and `title` attributes provide screen reader and tooltip support.
6. **No `worktreeId` dependency in icon render**: The `worktreeIconHtml` block gates on `worktreeStatus !== 'none'` only. The worktree branch name in the tooltip falls back to `'removed'` when `worktree_id` is NULL.

## Success Criteria

- Worktree icon appears in top-right corner of plan cards when worktree has been/is assigned
- Icon visual state correctly reflects worktree status (active vs. merged/deleted)
- Icon positioning does not interfere with existing card elements
- Status updates correctly on all four lifecycle operations (assign, merge, user-delete, review-cleanup)
- Migration applies successfully to existing databases, correctly backfilling active worktrees
- Tooltip provides useful information on hover

## Recommendation

**Complexity: 5 → Send to Coder**

Elevated from 3 to 5 due to: the four-path status update requirement (one path previously unidentified), the migration backfill gap, and the icon display logic constraint (must gate on `worktreeStatus` not `worktreeId`). Changes are still well-scoped and follow existing patterns, but require careful attention to all deletion paths and the nulling-vs-status design decision.

## Review Pass (2026-06-01)

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **MAJOR** | `_cleanupWorktreeAfterReview`: `updatePlanWorktreeStatus('deleted')` trapped inside `if (worktree)` guard, but `updatePlanWorktree(null)` is outside it. If worktree DB record is missing or git ops throw, status stays `'active'` while `worktree_id` becomes NULL → icon shows "active" with tooltip "removed (active)" | `KanbanProvider.ts:6878-6898` |
| 2 | NIT | Redundant `updatePlanWorktree(sessionId, null)` after `deleteWorktree()` which already NULLs `worktree_id`. Kept as safety net for missing-DB-record case with clarifying comment. | `KanbanProvider.ts:6898` |
| 3 | NIT | Same redundant `updatePlanWorktree(null)` pattern in `_cleanupWorktreeAfterMerge`. Pre-existing, not introduced by this plan. Deferred. | `KanbanProvider.ts:6854` |

### Stage 2: Balanced Synthesis

- **Finding 1 (MAJOR)**: Fixed. Moved `updatePlanWorktreeStatus(sessionId, 'deleted')` outside `if (worktree)` block, inside `if (choice === 'Clean Up')`. Now always sets status to `'deleted'` when user chooses Clean Up, regardless of DB record existence or git operation success.
- **Finding 2 (NIT)**: Kept the `updatePlanWorktree(null)` call with clarifying comment — it's needed when `deleteWorktree()` was never called (worktree record missing from DB).
- **Finding 3 (NIT)**: Deferred. Pre-existing pattern, not a regression.

### Files Changed

- `src/services/KanbanProvider.ts` — Moved `updatePlanWorktreeStatus('deleted')` outside `if (worktree)` guard in `_cleanupWorktreeAfterReview` (lines 6896-6901). Added clarifying comments.

### Verification

- **Typecheck**: Ran `npx tsc --noEmit`. All 14 errors are pre-existing (in `ClickUpSyncService.ts`, `KanbanProvider.ts:2540-2550/4679`, `TaskViewerProvider.ts:2078`). Zero new errors introduced by this feature or the review fix.
- **Tests**: Skipped per instructions (user will run separately).

### Implementation Verification Summary

All six phases verified against plan requirements:

| Phase | Component | Status |
|-------|-----------|--------|
| 1 | V27 migration (ALTER TABLE + backfill UPDATE) | ✅ Present, correct |
| 1 | V27 migration execution in `_runMigrations()` | ✅ Present, version-gated |
| 1 | `worktreeStatus` in `KanbanPlanRecord` | ✅ Present, typed as `string` with union comment |
| 1 | `PLAN_COLUMNS` includes `worktree_status` | ✅ Present |
| 1 | `_readRows()` maps `worktree_status` → `worktreeStatus` | ✅ Present, defaults to `'none'` |
| 1 | `updatePlanWorktreeStatus()` method | ✅ Present, correct signature |
| 1 | `UPSERT_PLAN_SQL` excludes `worktree_status` | ✅ Correct per plan |
| 2 | `icons/worktree-active.svg` | ✅ Present, `#4fc3f7` fill |
| 2 | `icons/worktree-merged.svg` | ✅ Present, `#888888` fill |
| 3 | `ICON_WORKTREE_ACTIVE` / `ICON_WORKTREE_MERGED` constants | ✅ Present in kanban.html |
| 3 | `.card-worktree-icon` CSS | ✅ Present, all properties match plan |
| 4 | Icon HTML gated on `worktreeStatus !== 'none'` | ✅ Correct, not gated on `worktreeId` |
| 4 | `${worktreeIconHtml}` inserted before `.card-topic` | ✅ Correct placement |
| 4 | `.kanban-card` has `position: relative` | ✅ Confirmed |
| 5 | Icon injection map entries | ✅ Present in KanbanProvider.ts |
| 6a | `_assignWorktreeToCard` → `updatePlanWorktreeStatus('active')` | ✅ Present |
| 6b | `_cleanupWorktreeAfterMerge` → `updatePlanWorktreeStatus('merged')` | ✅ Present |
| 6c | `deleteWorktree` handler → loop over `assignedCards` → `updatePlanWorktreeStatus('deleted')` | ✅ Present, reuses `allCards` |
| 6d | `_cleanupWorktreeAfterReview` → `updatePlanWorktreeStatus('deleted')` | ✅ Fixed (moved outside `if(worktree)`) |

### Remaining Risks

1. **Pre-existing typecheck errors**: 14 pre-existing TS errors in the codebase unrelated to this feature. Should be addressed separately.
2. **`_cleanupWorktreeAfterMerge` redundant null**: `updatePlanWorktree(null)` after `deleteWorktree()` is redundant but harmless. Low priority cleanup.
3. **Upsert + worktree_id edge case**: If a plan is upserted with `worktree_id` already set (unusual path), `worktree_status` will be `'none'` (DEFAULT) while `worktree_id` is non-null. The icon won't show. This is a deliberate design decision per the plan's clarification note — `worktree_status` is managed exclusively by `updatePlanWorktreeStatus()`.
