# Investigate Kanban COMPLETED Column Display Issue

## Goal
Fix the Kanban board's COMPLETED column not showing plans despite 448 records in the DB with `status='completed'`. Root cause is confirmed: the `filterGhostPlans` function in `KanbanProvider.ts` is applied to completed rows in two methods (`refreshWithData` and a parallel `_refreshBoard` path), directly contradicting their own code comments and causing all archived completed plans to be silently filtered out.

## Metadata
- **Tags:** bugfix, frontend, reliability
- **Complexity:** 3

## User Review Required
None — this is a pure bug fix with a well-understood root cause. No breaking changes.

## Complexity Audit

### Routine
- Fix `filterGhostPlans` application in `KanbanProvider.ts:refreshWithData` (lines 949–950): pass `completedRows` through unfiltered.
- Fix `filterGhostPlans` application in the parallel `_refreshBoard`-variant method (lines 1800–1801): same change.
- Both are single-line changes at two locations in one file.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions**
- None. The fix is purely synchronous filtering logic, not state mutation.

**Security**
- None. Removing file-existence checks for completed plans does not expose any path traversal risk; paths are still workspace-scoped by the DB query itself.

**Side Effects**
- Completed plans with corrupted/missing `planFile` fields will now appear in the COMPLETED column with their DB topic. This is acceptable and intentional — the DB is the source of truth. The `.filter(rec => rec.planFile)` guard at the `_refreshBoard` completed path (line 1698) already handles the empty-planFile case and should be replicated in `refreshWithData`.
- No change to the sidebar (`_refreshRunSheets` in `TaskViewerProvider.ts`) is needed — it already correctly skips ghost filtering for completed rows (lines 13413–13415).

**Dependencies & Conflicts**
- `getCompletedPlans` DB query is correct — returns `status='completed'` rows. No DB layer changes required.
- The `_refreshBoard` path at line ~1697 already correctly fetches completed plans without file-existence filtering — this confirms the pattern to replicate.

## Dependencies
- None — standalone localized bugfix.

## Adversarial Synthesis
Key risk: the `filterGhostPlans` function is copy-pasted in three places (KanbanProvider×2, TaskViewerProvider×1); fixing two out of three without the third could cause future regressions if paths diverge again. Mitigation: after the fix, add a clarifying comment at each call site indicating that `completedRows` intentionally bypasses ghost filtering. Secondary risk: completed plans with empty `planFile` values will surface in the COMPLETED column — this is benign (they show DB topic) and is already the intended design per code comments.

## Proposed Changes

### `src/services/KanbanProvider.ts`

#### Fix 1: `refreshWithData` — lines 942–950

**Context:** The `filterGhostPlans` function is defined inline at line 942 and applied to both `activeRows` AND `completedRows` (line 950). The comment on line 940 explicitly says completed rows should NOT be filtered, but the code contradicts this.

**Logic:** Apply `filterGhostPlans` only to `activeRows`. Pass `completedRows` through with only a `planFile` truthy guard (matching the `_refreshBoard` pattern at line 1698).

**Implementation:**
```typescript
// BEFORE (lines 949–950):
const activeRowsFiltered = filterGhostPlans(activeRows);
const completedRowsFiltered = filterGhostPlans(completedRows);  // ❌ incorrectly filters completed

// AFTER:
const activeRowsFiltered = filterGhostPlans(activeRows);
// Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
const completedRowsFiltered = completedRows.filter(row => !!row.planFile);
```

**Edge Cases:** Plans with no `planFile` at all are still excluded (same guard as `_refreshBoard` line 1698).

---

#### Fix 2: Parallel `_refreshBoard`-variant method — lines 1794–1801

**Context:** A second inline `filterGhostPlans` definition at line 1794, applied to both active and completed rows (line 1801). Same bug pattern.

**Implementation:**
```typescript
// BEFORE (lines 1800–1801):
const activeRowsFiltered = filterGhostPlans(activeRows);
const completedRowsFiltered = filterGhostPlans(completedRows);  // ❌

// AFTER:
const activeRowsFiltered = filterGhostPlans(activeRows);
// Completed plans intentionally bypass file-existence check — DB is source of truth for completed state
const completedRowsFiltered = completedRows.filter(row => !!row.planFile);
```

**No changes required in:**
- `TaskViewerProvider.ts:_refreshRunSheets` — already correctly skips ghost filtering for `completedRows` (lines 13413–13415).
- `KanbanDatabase.ts` — DB queries are correct.
- `KanbanDatabase.ts:getPlansByColumn` — the earlier fix attempt here was a red herring; the issue was never in the query.

## Verification Plan

### Automated Tests
- Check `src/services/__tests__/KanbanProvider.test.ts` around line 280 (`refreshWithData` suite) — add or verify a test that passes completed rows with non-existent plan files and asserts they appear in the output cards.
- Run: `npm test -- --grep "refreshWithData"` (or equivalent Jest filter).

### Manual Verification
1. Open the Kanban board and observe COMPLETED column is empty (reproduce the bug).
2. Apply the fix to both call sites in `KanbanProvider.ts`.
3. Trigger a board refresh ("Sync Board" or reload the panel).
4. Confirm completed plans appear in the COMPLETED column.
5. Check the console log: `[KanbanProvider] refreshWithData: sent X cards (Y active + Z completed)` — Z should now be > 0.
6. Verify that ghost active plans (active plans whose files have been deleted) are still correctly hidden.

---

## Reviewer Pass

### Stage 1 (Grumpy Principal Engineer)
"Where's the drama? This is actually... fine. You found that the parallel `_refreshBoard` method did exactly the same flawed filtering and you fixed it too. You even wrote a clear test asserting `comp-2` shows up when the plan file is missing. My only NIT is that we didn't add a dedicated test for `_refreshBoard`, but the logic is identical and `refreshWithData` is clearly the primary pipeline going forward. I will let this pass. No material bugs found."

### Stage 2 (Balanced Synthesis)
- **What to Keep**: The single-line changes correctly segregate active row ghost filtering from completed row file-existence checking. The `KanbanProvider.test.ts` update perfectly tests the edge case.
- **What to Fix Now**: Nothing.
- **What to Defer**: Consolidating `_refreshBoard` and `refreshWithData` is beyond the scope of this localized fix.

### Implementation Status
- `src/services/KanbanProvider.ts`: Modified ghost filtering to preserve completed plans even if their files are missing.
- `src/services/__tests__/KanbanProvider.test.ts`: Added unit test to verify that `refreshWithData` passes completed rows through properly.

### Validation Results
- `npm run test -- --grep "refreshWithData"` executed and passed (`filters out active ghost plans but preserves all completed plans`).

**STATUS: VERIFIED & COMPLETE**
