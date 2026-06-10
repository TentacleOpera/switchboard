---
description: Fix KanbanDatabase upsertPlans parameter mismatch that silently wipes is_epic and epic_id on plan re-import, breaking epic creation and all epic relationships
---

# Fix Kanban Epic Upsert Parameter Mismatch

## Goal

Fix the bug where creating an epic via the kanban board results in a regular plan with no epic relationships. The root cause is a parameter count mismatch in `KanbanDatabase.upsertPlans()` that causes `is_epic` and `epic_id` to be silently dropped on every plan re-import, which immediately nullifies the epic status set by `createEpic` when the file watcher triggers.

**Core Problem:** `KanbanDatabase.upsertPlans()` passes 23 values to `UPSERT_PLAN_SQL`, but the SQL statement defines 25 columns (`plan_id` through `epic_id`) and 25 placeholders. The missing parameters are `is_epic` (24) and `epic_id` (25). On `ON CONFLICT(plan_file, workspace_id) DO UPDATE`, the `excluded.is_epic` and `excluded.epic_id` references resolve to `NULL`, overwriting any previously set epic data.

**Impact:**
- Epic creation appears to succeed (file created, DB record inserted) but the epic vanishes on the next file watcher event or full sync.
- Existing epics and subtasks lose their relationships whenever their plan files are touched.
- The `createEpic` handler in `KanbanProvider.ts` is not itself buggy, but it is vulnerable to this race because it writes the plan file *after* calling `upsertPlan`, which guarantees a watcher re-import will occur.

## Metadata
- **Complexity:** 3
- **Tags:** backend, bugfix, database, api

## Proposed Changes

### `src/services/KanbanDatabase.ts` — Fix parameter count

1. **Add missing parameters to `upsertPlans()`**
   - In the values array passed to `_db.run(UPSERT_PLAN_SQL, [...])`, append two new entries after `record.worktreeId ?? null`:
     - `record.isEpic ?? null` (maps to `is_epic`, parameter 24)
     - `record.epicId || ''` (maps to `epic_id`, parameter 25)
   - This fixes both the initial insert and the `ON CONFLICT` update path for all callers.

### `src/services/KanbanProvider.ts` — Harden `createEpic` handler

2. **Pass `isEpic: 1` explicitly in the `upsertPlan` call**
   - In the `createEpic` handler (around line 6454), add `isEpic: 1` to the object passed to `db.upsertPlan()`. Currently the field is omitted, relying on the separate `updateEpicStatus` call. Making it explicit reduces the vulnerability window before `updateEpicStatus` runs.
   - Also pass `epicId: ''` explicitly to match the expected record shape.

### Out of Scope
- No changes to `kanban.html`, `planning.html`, or `planning.js` — the UI and modal flow are correct.
- No changes to `GlobalPlanWatcherService` — it correctly calls `upsertPlan`; the bug is in the callee.
- No schema changes — `is_epic` and `epic_id` columns already exist in the DB schema.

## Verification Plan

### Manual Verification
1. Open the kanban board. Multi-select 2+ non-epic plans.
2. Click the "EPIC (N)" strip button, fill in a name, and submit.
3. Verify the new epic card appears on the board with a purple border and the correct subtask count badge.
4. Wait 5–10 seconds (file watcher debounce window), then trigger a board refresh (Sync Board button or reload).
5. **Expected:** The epic card remains an epic with its subtask count intact. **Before fix:** The epic card reverts to a regular plan and subtasks are orphaned.
6. Verify existing epics survive a full sync (`switchboard.fullSync` command) without losing subtask relationships.

### Regression Checks
- Run the extension test suite (if available) to ensure `upsertPlans` still handles all other record shapes correctly.
- Verify `createPlan` (non-epic) still works — `isEpic` will be `null`/`undefined`, which maps to `NULL` in DB (correct).
- Verify ClickUp/Linear sync import paths — any plan re-import now preserves epic state instead of wiping it.

## Edge Cases
- **Empty epicId:** `record.epicId || ''` ensures the parameter is never `undefined`, which would shift all subsequent parameters. `''` is the correct "no epic" sentinel used elsewhere in the codebase.
- **Null isEpic:** `record.isEpic ?? null` correctly maps `undefined` to SQL `NULL` for non-epic plans, preserving existing behavior.
- **Race condition:** Even after this fix, there is a tiny window between `upsertPlan` (without `isEpic`) and `updateEpicStatus` where the file watcher could re-import the plan as non-epic. Passing `isEpic: 1` in the initial `upsertPlan` closes this window entirely.

## Recommendation
Complexity 3 → **Send to Coder** (single focused fix, well-understood root cause, minimal blast radius).
