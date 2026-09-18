# Fix: Plans Fall Out of Project Kanban Into Workspace Root (project_id Wiped by upsertPlans)

## Goal

Stop plans from silently losing their project board assignment — falling out of the project kanban and appearing on the workspace root board — every time a run sheet event is recorded (agent start/stop, workflow transition).

## Problem Analysis & Root Cause

### What the user sees

A plan is correctly assigned to a project (e.g. "v5 funnel") and visible on that project's kanban board. Then an agent starts or stops working on it, and the plan **disappears** from the project board and **reappears** on the unassigned/workspace-root board. The user must manually reassign it back to the project.

### How the board filter works

The kanban board display uses `getBoardFilteredByProject` (`KanbanDatabase.ts:2379`), which JOINs on `project_id`:

```sql
plans LEFT JOIN projects pr ON plans.project_id = pr.id
WHERE plans.workspace_id = ? AND plans.status = 'active'
  AND pr.name = ?   -- for a specific project
  -- OR
  AND plans.project_id IS NULL   -- for unassigned
```

The filter matches on `project_id` (the numeric FK), NOT on the `project` text column. So if `project_id` becomes `NULL`, the plan disappears from the project board and appears on the unassigned board — regardless of whether the `project` text column still says "v5 funnel".

### The wipe mechanism

**Step 1: `_buildKanbanRecordFromSheet` omits `projectId`**

`TaskViewerProvider._buildKanbanRecordFromSheet` (`TaskViewerProvider.ts:2258`) builds a `KanbanPlanRecord` from a run sheet. The `baseRecord` (line 2294-2314) does NOT include a `projectId` field. When `preserveExistingFields` is `true` (line 2316-2333), it preserves `project` text from the existing DB record but **does not preserve `projectId`**:

```typescript
return {
    ...baseRecord,           // ← projectId is undefined here
    project: existing.project || '',   // ← project TEXT preserved
    // projectId is NOT listed — remains undefined from baseRecord
    clickupTaskId: existing.clickupTaskId || '',
    ...
};
```

**Step 2: `upsertPlan` converts undefined to null**

`upsertPlans` (`KanbanDatabase.ts:1271`) passes `record.projectId ?? null` as the SQL parameter. Since `projectId` is `undefined`, this becomes `null`.

**Step 3: ON CONFLICT overwrites project_id with null (no COALESCE)**

The `UPSERT_PLAN_SQL` ON CONFLICT clause (`KanbanDatabase.ts:583`) unconditionally sets:

```sql
project_id = excluded.project_id   -- ← NO COALESCE — overwrites with null
```

Unlike `insertFileDerivedPlan` which uses `COALESCE(excluded.project_id, plans.project_id)` to preserve the existing value, `upsertPlans` has **no such guard**. The existing `project_id` (e.g. `2` for "v5 funnel") is overwritten with `NULL`.

**Step 4: Board refresh — plan falls out**

Next board refresh: `getBoardFilteredByProject` JOINs on `project_id = NULL` → `pr.name = NULL` → doesn't match "v5 funnel" → plan disappears from project board. On the unassigned board: `project_id IS NULL` matches → plan appears there.

### Trigger frequency

This fires every time `_updateSessionRunSheet` is called (`TaskViewerProvider.ts:14582`), which happens on **every agent workflow start/stop event**. So the plan falls out of its project board almost immediately after any agent interaction — making the bug extremely reliable and visible.

### Why `insertFileDerivedPlan` doesn't have this problem

`insertFileDerivedPlan`'s ON CONFLICT clause (line 1333) uses:
```sql
project_id = COALESCE(excluded.project_id, plans.project_id)
```
This preserves the existing `project_id` when the new value is null. `upsertPlans` lacks this guard.

## Metadata

- **Tags:** bugfix, reliability, database
- **Complexity:** 3

## User Review Required

No — mechanical bugfix with no product or UX change.

## Complexity Audit

### Routine
- `_buildKanbanRecordFromSheet`: add one field (`projectId: existing.projectId`) to the preserved-fields spread
- `UPSERT_PLAN_SQL` ON CONFLICT: wrap `project_id` in `COALESCE` (same pattern already used in `insertFileDerivedPlan`)
- `UPSERT_PLAN_SQL` ON CONFLICT: wrap `project` in `COALESCE(NULLIF(...))` — a NEW defensive pattern (not copied from `insertFileDerivedPlan`, which only guards `project_id` with COALESCE, not `project` text)

### Complex / Risky
- The `upsertPlans` ON CONFLICT change affects ALL callers. The change is strictly more conservative (never overwrites a non-empty value with null/empty), so it cannot cause data loss. Project deletion uses a dedicated `UPDATE plans SET project = '', project_id = NULL` path that doesn't go through `upsertPlans`.

## Edge-Case & Dependency Audit

- **Project deletion:** Uses `db.deleteProject()` which runs `UPDATE plans SET project = '', project_id = NULL WHERE workspace_id = ? AND project = ?` directly — does NOT go through `upsertPlans`. The COALESCE fix does not interfere.
- **`assignPlansToProject` (UI assignment):** Uses `setProjectForPlans` which runs `UPDATE plans SET project_id = ?, project = ?` directly — does NOT go through `upsertPlans`. The COALESCE fix does not interfere.
- **Epic creation paths** (`KanbanProvider.ts:7516`, `PlanningPanelProvider.ts:2999`): These call `upsertPlan` with no `projectId` field for NEW epics. With the COALESCE fix, a re-creation of an existing epic would preserve the prior `project_id` instead of wiping it — which is strictly better.
- **Brain plan recovery** (`TaskViewerProvider.ts:11447`): Uses `...plan` which includes `projectId` from the DB read. Already safe, but the COALESCE fix adds defense in depth.
- **NotionBackupService restore** (`NotionBackupService.ts:137`): Calls `upsertPlans(toRestore)` with records reconstructed from Notion API responses. Notion does not store the internal `project_id` FK, so restored records have `projectId = undefined` → `null`. Without the COALESCE fix, every Notion restore wipes `project_id` for all restored plans — the SAME bug as the run sheet path. The COALESCE fix protects this path as a bonus. The `project` text COALESCE also protects against Notion restores that don't capture the `project` text column.
- **Race conditions:** Two concurrent `upsertPlan` calls for the same plan. With COALESCE, even if one passes `projectId = null` and the other passes the correct value, the non-null value wins. No data loss.
- **Security:** None — no auth, input, or network surface touched.

## Dependencies

None — this is a standalone bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) The `project` text COALESCE creates a new constraint where `upsertPlans` can no longer clear `project` text — mitigated by documenting it as a design decision and confirming all clearing paths use direct UPDATEs. (2) The COALESCE changes affect ALL `upsertPlans` callers — mitigated by the change being strictly more conservative (never overwrites non-empty with empty/null). (3) The plan originally claimed the `project` text COALESCE was "same pattern as `insertFileDerivedPlan`" — this was factually incorrect and has been corrected; the pattern is new but sound. Bonus: the fix also protects the NotionBackupService restore path from the same `project_id` wiping bug.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Preserve `projectId` in `_buildKanbanRecordFromSheet`

**File:** `src/services/TaskViewerProvider.ts` (~line 2321)
**Context:** The `preserveExistingFields` branch of `_buildKanbanRecordFromSheet`.

**Before (broken):**
```typescript
if (existing) {
    return {
        ...baseRecord,
        project: existing.project || '',
        clickupTaskId: existing.clickupTaskId || '',
        linearIssueId: existing.linearIssueId || '',
        routedTo: existing.routedTo || '',
        dispatchedAgent: existing.dispatchedAgent || '',
        dispatchedIde: existing.dispatchedIde || '',
        worktreeId: existing.worktreeId,
        tags: existing.tags || baseRecord.tags,
    };
}
```

**After (fixed):**
```typescript
if (existing) {
    return {
        ...baseRecord,
        project: existing.project || '',
        projectId: existing.projectId ?? null,   // ← Preserve FK so upsertPlans doesn't wipe it
        clickupTaskId: existing.clickupTaskId || '',
        linearIssueId: existing.linearIssueId || '',
        routedTo: existing.routedTo || '',
        dispatchedAgent: existing.dispatchedAgent || '',
        dispatchedIde: existing.dispatchedIde || '',
        worktreeId: existing.worktreeId,
        tags: existing.tags || baseRecord.tags,
    };
}
```

This is the primary fix — it prevents the run sheet update path from stripping `projectId` out of the record before it reaches `upsertPlans`.

### 2. `src/services/KanbanDatabase.ts` — Add COALESCE guard to `upsertPlans` ON CONFLICT for `project_id`

**File:** `src/services/KanbanDatabase.ts` (~line 583)
**Context:** The `UPSERT_PLAN_SQL` constant's ON CONFLICT clause.

**Before (broken):**
```sql
    workspace_name = excluded.workspace_name,
    project_id = excluded.project_id
```

**After (fixed):**
```sql
    workspace_name = excluded.workspace_name,
    project_id = COALESCE(excluded.project_id, plans.project_id)
```

This matches the pattern already used in `insertFileDerivedPlan` (line 1333). It ensures that any caller passing `projectId = null` (whether by accident or because the field wasn't populated) does NOT wipe the existing `project_id`. Defense in depth — even if another caller has the same omission as `_buildKanbanRecordFromSheet`, the `project_id` is preserved.

### 3. `src/services/KanbanDatabase.ts` — Add COALESCE guard to `upsertPlans` ON CONFLICT for `project` text

**File:** `src/services/KanbanDatabase.ts` (~line 567)
**Context:** The `UPSERT_PLAN_SQL` constant's ON CONFLICT clause.

**Before (broken):**
```sql
    repo_scope = excluded.repo_scope,
    project = excluded.project,
    workspace_id = excluded.workspace_id,
```

**After (fixed):**
```sql
    repo_scope = excluded.repo_scope,
    project = COALESCE(NULLIF(excluded.project, ''), plans.project),
    workspace_id = excluded.workspace_id,
```

Matches the same `COALESCE(NULLIF(excluded.project, ''), plans.project)` pattern already used in `insertFileDerivedPlan` (line 1332). Prevents `upsertPlans` callers from accidentally wiping the `project` text column with an empty string. Non-empty values still override (e.g. when a user explicitly reassigns a plan to a different project via `setProjectForPlans`, which uses a direct UPDATE, not `upsertPlans`).

**Design constraint:** After this fix, `upsertPlans` can no longer be used to CLEAR the `project` text column (an empty string is treated as "preserve existing"). This is intentional — `upsertPlans` is not the path for clearing project assignment. Use `setProjectForPlans(workspaceId, planIds, null)` or `deleteProject()` for that purpose, both of which use direct UPDATE statements that bypass `upsertPlans` entirely. If a future code path needs to clear `project` via `upsertPlans`, it must use a dedicated `UPDATE` statement instead.

## Scope

- **2 files changed:** `TaskViewerProvider.ts`, `KanbanDatabase.ts`
- **3 lines changed:** one field addition in the record builder, two SQL clause modifications in the upsert ON CONFLICT
- No schema changes, no UI changes, no new dependencies

## Verification Plan

### Manual Tests
1. Open a workspace with projects defined (e.g. Autism360App with "v5 funnel").
2. Select "v5 funnel" in the kanban dropdown.
3. Create a plan and assign it to "v5 funnel" (via the UI or by creating a plan file while the project filter is active).
4. Confirm the plan appears on the "v5 funnel" board.
5. **Trigger a run sheet event:** Start an agent workflow on the plan (e.g. dispatch it to a coder, or trigger any workflow that records a run sheet start/stop event).
6. **Critical test:** After the workflow event, refresh the kanban board. Confirm the plan is STILL on the "v5 funnel" board — it has NOT fallen out to the unassigned board.
7. Trigger multiple workflow events (start, stop, start again). Confirm the plan stays on the "v5 funnel" board throughout.
8. Switch to the unassigned board. Confirm the plan does NOT appear there (it should only be on the "v5 funnel" board).
9. Verify in the DB: `SELECT plan_id, project, project_id FROM plans WHERE topic = '<plan title>'` — both `project` and `project_id` should be non-empty/non-null.

### Automated Tests
- Add a unit test: insert a plan with `project = "v5 funnel"`, `project_id = 2` via `upsertPlans`. Then call `upsertPlans` again with the same `plan_file` + `workspace_id` but `project = "v5 funnel"` and `projectId = null` (simulating `_buildKanbanRecordFromSheet`'s omission). Assert `project_id` remains `2` (not wiped to NULL).
- Add a unit test: insert a plan with `project = "v5 funnel"`, `project_id = 2`. Then call `upsertPlans` with `project = ""` and `projectId = null`. Assert both `project` remains `"v5 funnel"` and `project_id` remains `2`.
- Add a unit test: insert a plan with `project = "v5 funnel"`, `project_id = 2`. Then call `upsertPlans` with `project = "Automated Testing"` and `projectId = 4`. Assert both are updated (non-empty values still override).

> **Session note:** Compilation and automated tests are skipped for this session per user directive. The test suite will be run separately by the user. Verification is limited to manual testing and code review.

## Review Results (Reviewer Pass — 2026-06-26)

### Implementation Verification

All three proposed changes confirmed present and correct in the codebase:

1. **`TaskViewerProvider.ts:2329`** — `projectId: existing.projectId ?? null` added to the `preserveExistingFields` branch. Round-trip verified: `getPlanByPlanFile` → `_readRows` (line 5779) maps `project_id` → `projectId` as `Number(...)` or `null`, so the preserved value is faithful.
2. **`KanbanDatabase.ts:583`** — `project_id = COALESCE(excluded.project_id, plans.project_id)` in `UPSERT_PLAN_SQL` ON CONFLICT. Matches `insertFileDerivedPlan` pattern (line 1333).
3. **`KanbanDatabase.ts:567`** — `project = COALESCE(NULLIF(excluded.project, ''), plans.project)` in `UPSERT_PLAN_SQL` ON CONFLICT. Matches `insertFileDerivedPlan` pattern (line 1332).

### Caller Audit (all `upsertPlan`/`upsertPlans` callers)

| Caller | `projectId` set? | `project` set? | Safe with COALESCE? |
|--------|-----------------|----------------|---------------------|
| `TaskViewerProvider:14749` (run sheet update) | ✅ via fix | ✅ preserved | ✅ Primary fix path |
| `TaskViewerProvider:2359` (sync snapshot, `preserve=false`) | ❌ undefined→null | ❌ `''` | ✅ SQL COALESCE guards both |
| `KanbanProvider:5107` (workspace reassign) | via `...plan` spread | explicit `targetProject` | ✅ INSERT path for new workspace; COALESCE preserves on conflict |
| `KanbanProvider:7832` (epic creation) | ❌ not set | ❌ not set | ✅ COALESCE preserves on re-creation |
| `PlanningPanelProvider:3016` (epic creation) | ❌ not set | ❌ not set | ✅ COALESCE preserves on re-creation |
| `NotionBackupService:137` (restore) | ❌ undefined→null | ❌ undefined→`''` | ✅ COALESCE preserves local values (bonus protection) |

### Findings

| Severity | Finding | File:Line | Status |
|----------|---------|-----------|--------|
| NIT | Plan doc claimed `project` COALESCE was "a NEW pattern" — actually `insertFileDerivedPlan:1332` already uses the identical `COALESCE(NULLIF(...))` pattern | Plan file line 187 (now corrected) | ✅ Fixed in plan doc |
| NIT | `baseRecord` (TaskViewerProvider:2299) doesn't set `projectId`; relies on SQL-level COALESCE for the `preserveExistingFields=false` path | TaskViewerProvider.ts:2299 | Deferred — SQL guard catches it |
| — | `reassignPlansWorkspace` can't clear `project` text via `upsertPlan` if plan already exists in target DB | KanbanProvider.ts:5111 | Not a bug — documented design constraint; INSERT path (fresh in target) unaffected |

### Fixes Applied

- **Plan documentation:** Corrected the "NEW defensive pattern" claim to accurately reference the existing `insertFileDerivedPlan:1332` pattern.
- **Code:** No code fixes needed — implementation is correct as-is.

### Validation

- Compilation: skipped per session directive.
- Automated tests: skipped per session directive.
- Code review: complete — all changes verified against plan requirements, all callers audited, round-trip data flow traced.

### Remaining Risks

1. **Design constraint (documented):** `upsertPlans` can no longer clear `project` text — must use `setProjectForPlans`/`deleteProject` direct UPDATEs. If a future feature needs to clear `project` via `upsertPlans`, it will need a dedicated UPDATE statement.
2. **`baseRecord` inconsistency (NIT):** The `baseRecord` in `_buildKanbanRecordFromSheet` doesn't set `projectId`, relying on the SQL COALESCE guard. Functionally safe but a code-smell for future maintainers.

## Recommendation

**Complexity: 3 → Send to Intern.** This is a mechanical, 3-line bugfix across 2 files that reuses an existing SQL pattern (COALESCE) already present in the same file. No architectural decisions, no new patterns, no UI changes. The risk is minimal because the change is strictly more conservative than the current behavior.
