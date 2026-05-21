# Bug Fix: Sidebar Dropdown Ghost Plans in Completed Mode

## Goal

Prevent ghost plans from workspace A appearing in workspace B's sidebar plan select dropdown when switching to 'completed' mode, by applying the same `fs.existsSync` ghost filter to completed plans that is already applied to active plans.

## Metadata

- **Tags:** bugfix, UI
- **Complexity:** 2

## User Review Required

No — this is a straightforward application of an existing proven filter pattern to a parallel code path.

## Complexity Audit

### Routine

- Single-file localized change in `TaskViewerProvider.ts`.
- Reuses existing `filterGhostPlans` closure (lines 13353-13358) already applied to active plans in the same method.
- No DB schema changes, no API contract changes.

### Complex / Risky

- None

## Edge-Case & Dependency Audit

- **Race Conditions:** Plan file could be deleted between DB read and `fs.existsSync` check. This is the same pre-existing risk as with active plans and is considered acceptable.
- **Security:** No new security surface. `fs.existsSync` only reads; no writes.
- **Side Effects:** None. The filtered completed plans will simply not appear in the dropdown, which is the intended behavior.
- **Dependencies & Conflicts:** None. No other code depends on completed plans being sent unfiltered to the webview.
- **Archived Plans Clarification:** The original comment (lines 13350-13352) claims completed plans are not filtered because they may have been archived (file moved). However, this conflates two different concerns: (1) intra-workspace completed plans whose files still exist (should appear, and will pass `fs.existsSync`), vs (2) cross-workspace ghost plans whose files don't exist in this workspace (should not appear). If a completed plan's file was physically moved/deleted within the workspace, `fs.existsSync` will return false and the plan will be filtered out — but such a plan would be broken anyway (clicking it would fail to open the file). Showing a broken dropdown entry is worse than hiding it. The confirmed bug (cross-workspace leakage) outweighs the theoretical edge case (intra-workspace file-moved plans).

## Dependencies

None.

## Adversarial Synthesis

Key risks: (1) Completed plans whose files were physically moved within the workspace will be filtered out by `fs.existsSync`, since the DB `planFile` field still references the original (now-absent) path. This is acceptable because such entries would be broken in the UI anyway. (2) No automated regression test exists for this filter path. Mitigations: the fix is minimal and mirrors the proven active-plan filter; the `filterGhostPlans` closure is a local function not easily unit-testable without refactoring; manual verification is sufficient for complexity level 2.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

- **Context:** `_refreshRunSheets` (lines 13308-13383) sends plan data to the sidebar dropdown. Active plans are filtered through `filterGhostPlans` (closure at lines 13353-13358, checks `fs.existsSync`), but completed plans are not, causing ghost plans from other workspaces to leak into the dropdown.
- **Logic:** Apply the same `filterGhostPlans` filter to `completedRows` before mapping to `visibleCompletedRows`, matching the pattern already used for `visibleActiveRows`.
- **Implementation:**
  ```typescript
  // Replace lines 13363-13365:
  const visibleCompletedRows = repoScope
      ? completedRows.filter((row) => !row.repoScope || row.repoScope === repoScope)
      : completedRows;

  // With:
  const visibleCompletedRows = repoScope
      ? filterGhostPlans(completedRows).filter((row) => !row.repoScope || row.repoScope === repoScope)
      : filterGhostPlans(completedRows);
  ```
- **Edge Cases:**
  - Empty `planFile` → filtered out (same as active plans).
  - Absolute `planFile` paths → checked directly via `fs.existsSync` (same as active plans).
  - All completed plans filtered out → results in empty 'completed' dropdown; acceptable.
  - Intra-workspace completed plans with moved/deleted files → filtered out; acceptable (broken entries worse than hidden ones).
- **Comment Update:** Update the comment on lines 13350-13352 to reflect that both active and completed plans are now filtered:
  ```typescript
  // Filter out ghost plans: plan files that don't exist in this workspace.
  // This applies to both active and completed plans to prevent cross-workspace leakage.
  // Completed plans whose files were moved/deleted within the workspace will also be
  // filtered out, but such entries would be broken in the UI anyway.
  ```

## Verification Plan

### Automated Tests

- No automated test added. The `filterGhostPlans` closure is a local function inside a private method (`_refreshRunSheets`), making it difficult to unit-test without refactoring the closure into a testable export. At complexity level 2, manual verification is sufficient. If regression occurs, consider extracting `filterGhostPlans` to a testable utility as a follow-up.

### Manual Checklist

- [ ] Open workspace A and create a plan, move it to COMPLETED.
- [ ] Switch to workspace B (same parent DB mapping).
- [ ] In workspace B's sidebar, toggle the plan select dropdown to 'COMPLETED' mode.
- [ ] Confirm the completed plan from workspace A does **not** appear in the dropdown.
- [ ] Confirm active plans from workspace A do **not** appear in workspace B's dropdown either.
- [ ] In workspace A, create a completed plan and then archive/move the file within the same workspace.
- [ ] Confirm the archived completed plan still appears in workspace A's dropdown (verifies intra-workspace archived plans are preserved — only applicable if the file still exists at the `planFile` path).

### Known Follow-Up

None — this completes the follow-up item documented in `fix_kanban_completed_tasks_workspace_scoping.md`.

---

## Original Investigation

### Problem

In multi-workspace setups where child repos share a parent DB via `workspaceDatabaseMappings`, the sidebar plan select dropdown in `implementation.html` bleeds ghost plans across workspaces when switching to 'completed' mode. Plans created in workspace A appear in workspace B's dropdown.

### Root Cause

`TaskViewerProvider._refreshRunSheets` (lines 13308-13383) applies `filterGhostPlans` (which checks `fs.existsSync`) to active plans but not to completed plans. The existing comment claims this is intentional because completed plans may have been archived, but this conflates intra-workspace archived plans with cross-workspace ghost plans.

```typescript
// Current code (lines 13360-13365):
const visibleActiveRows = repoScope
    ? filterGhostPlans(activeRows).filter((row) => !row.repoScope || row.repoScope === repoScope)
    : filterGhostPlans(activeRows);
const visibleCompletedRows = repoScope
    ? completedRows.filter((row) => !row.repoScope || row.repoScope === repoScope)
    : completedRows;  // ❌ No ghost filtering
```

When workspaces share a DB:
- All child workspaces resolve to the **same** `workspace_id`
- `db.getCompletedPlans(workspaceId)` returns **all** completed plans for that shared ID
- Without ghost filtering, plans whose files live in another child workspace are sent to the webview and appear in the dropdown

### Fix

Apply the same `filterGhostPlans` filter to completed plans that is already applied to active plans. This correctly handles both cases:
- Intra-workspace completed plans (file still exists): `fs.existsSync` returns `true` → plan appears
- Cross-workspace ghost plans: File doesn't exist in this workspace, so `fs.existsSync` returns `false` → plan filtered out
- Intra-workspace completed plans with moved/deleted files: `fs.existsSync` returns `false` → plan filtered out (acceptable; broken entry is worse than hidden)

---

**Recommendation:** Send to Intern (complexity 2)

---

## Review Pass (Grumpy + Balanced)

### Stage 1: Grumpy Principal Engineer Findings

Well well well. Let me look at what we have here. You had ONE job — apply `filterGhostPlans` to `completedRows` — and you actually did it. I'm almost disappointed I can't rip this apart.

- **NIT:** The comment at lines 13286-13289 is a near-verbatim copy of the plan's suggested comment. Good. No creative liberties taken. I'll allow it.
- **NIT:** The `filterGhostPlans` closure itself (lines 13290-13295) is unchanged from the original. The application pattern for `visibleCompletedRows` (lines 13300-13302) mirrors `visibleActiveRows` (lines 13297-13299) exactly. Symmetric. Clean. Boring. Exactly what a complexity-2 fix should be.
- **No CRITICAL findings.**
- **No MAJOR findings.**

I hate to admit it, but this is correct. The ghost plans from workspace A will no longer haunt workspace B's completed dropdown. The edge case about intra-workspace moved/deleted files is acknowledged in the comment and is acceptable per the plan's own analysis.

### Stage 2: Balanced Synthesis

- **Keep:** All findings are NITs. Implementation matches plan exactly.
- **Fix now:** Nothing.
- **Defer:** Nothing.

### Stage 3: Code Fixes Applied

None — implementation is correct as-is.

### Stage 4: Verification Results

No automated tests exist for this code path (per plan's own acknowledgment). The `filterGhostPlans` closure is a local function inside a private method, making unit testing impractical without refactoring. Manual verification per the plan's checklist is required.

### Stage 5: Remaining Risks

- No automated regression test for the completed-plan ghost filter. If this code path regresses, it won't be caught by CI.
- Consider extracting `filterGhostPlans` to a testable utility as a follow-up if this area sees further changes.
