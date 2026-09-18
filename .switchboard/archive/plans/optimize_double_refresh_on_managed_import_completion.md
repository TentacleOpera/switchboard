# Optimize Double Refresh on Managed-Import Completion

## Goal

Eliminate the redundant double `_syncFilesAndRefreshRunSheets` call when completing managed-import plans. The immediate `_syncConfiguredPlanFolder` already triggers an internal refresh, making the final refresh wasteful.

## Metadata

- **Tags:** frontend, optimization, performance
- **Complexity:** 3

## User Review Required

No

## Complexity Audit

### Routine

- Single-file change (`TaskViewerProvider.ts`).
- Simple boolean flag to track whether immediate sync ran.
- Conditional final refresh based on flag.

### Complex / Risky

- None. The immediate sync's internal refresh already pushes correct state to the webview (KanbanProvider's DB-first guard ensures column is already `COMPLETED`). Skipping the final refresh is safe.

## Edge-Case & Dependency Audit

- **Race Conditions**: None.
- **Security**: No security implications; changes are localized to completion flow.
- **Side Effects**: None — final refresh is redundant.
- **Dependencies & Conflicts**: None.

## Dependencies

None

## Adversarial Synthesis

Key risk: The final refresh at line 12387 runs AFTER archival at line 12386. The immediate sync at line 12366 runs BEFORE archival. If we skip the final refresh, the sidebar might not reflect the post-archival state (plan file moved to archive). However, the sidebar uses `filterGhostPlans` (fixed in previous review) to not filter completed plans, so the plan would still be visible even after archival. The only difference is that the sidebar would show the plan with the old `brainSourcePath` (pre-archival) instead of the updated path. The sidebar doesn't display `brainSourcePath`, so this is not a user-visible difference.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

#### `_handleCompletePlan` (line ~12300)

- **Context**: The immediate `_syncConfiguredPlanFolder` call at line 12366 triggers `_syncFilesAndRefreshRunSheets` internally (line 8753). The final `_syncFilesAndRefreshRunSheets` at line 12387 runs again, causing a double refresh.
- **Logic**: Add a boolean flag `ranImmediateSync` to track whether the immediate sync ran. If the immediate sync ran (managed import path), skip the final `_syncFilesAndRefreshRunSheets` at line 12387.
- **Implementation**:

```typescript
// At the top of _handleCompletePlan:
let ranImmediateSync = false;

// In the managed import block (after line 12371):
ranImmediateSync = true;

// Before line 12387 (final refresh):
if (!ranImmediateSync) {
    await this._syncFilesAndRefreshRunSheets();
}
```

## Verification Plan

### Manual Tests

1. Complete a managed-import plan.
2. **Expected**: Card animates to COMPLETED and stays there; no duplicate appears in NEW.
3. Verify the sidebar shows the completed plan.
4. Complete a brain plan (non-managed-import).
5. **Expected**: Card animates to COMPLETED and stays there; sidebar shows the completed plan.
6. Verify no visual regression for either plan type.

## Files to Modify

1. `src/services/TaskViewerProvider.ts`
   - `_handleCompletePlan` — add `ranImmediateSync` flag and conditional final refresh

## Risks

- **Very low**: The immediate sync's internal refresh already pushes correct state. Skipping the final refresh is safe because:
  - KanbanProvider's `_refreshBoard` handles the kanban board state.
  - Sidebar doesn't display `brainSourcePath`, so the pre-archival vs. post-archival path difference is not user-visible.
  - Completed plans are not filtered by `filterGhostPlans` (fixed in previous review), so they remain visible even after archival.

---

**Recommendation:** Send to Coder. Complexity is 3 — simple optimization with negligible risk.
