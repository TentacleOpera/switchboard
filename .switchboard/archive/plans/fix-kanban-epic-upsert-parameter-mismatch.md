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
- **Complexity:** 4
- **Tags:** backend, bugfix, database, api

## User Review Required
No — this is a targeted bugfix with a well-understood root cause and minimal blast radius.

## Complexity Audit

### Routine
- Append two parameters to `KanbanDatabase.ts` `upsertPlans()` values array.
- Add two explicit fields to `KanbanProvider.ts` `createEpic` handler.
- Remove two lines from `UPSERT_PLAN_SQL` `DO UPDATE SET` clause.
- No schema changes, no new dependencies, no API surface changes.

### Complex / Risky
- SQL conflict-clause change affects ALL `upsertPlans` callers. Must verify no caller relies on `is_epic`/`epic_id` being overwritten on conflict.
- `KanbanPlanRecord` optional fields (`isEpic`, `epicId`) are now required in the parameter list; callers that omit them pass `null`/`''`.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — Fix parameter count and SQL conflict clause

1. **Add missing parameters to `upsertPlans()`**
   - In the values array passed to `_db.run(UPSERT_PLAN_SQL, [...])` at line 1150, append two new entries after `record.worktreeId ?? null` (line 1173):
     - `record.isEpic ?? null` (maps to `is_epic`, parameter 24)
     - `record.epicId || ''` (maps to `epic_id`, parameter 25)
   - This fixes the binding mismatch for both the initial INSERT and the conflict-resolution path.

2. **Remove epic fields from the `ON CONFLICT DO UPDATE SET` clause**
   - In `UPSERT_PLAN_SQL` (line 465), delete the lines `is_epic = excluded.is_epic,` and `epic_id = excluded.epic_id` from the `ON CONFLICT ... DO UPDATE SET` block (lines 495–496).
   - **Rationale:** `is_epic` and `epic_id` are lifecycle fields set exclusively via `updateEpicStatus()` (and the `createEpic` handler). They should not be blindly overwritten by generic metadata re-imports, just as `kanban_column` and `status` are already excluded from the conflict update. This closes the systemic vulnerability where any `upsertPlans` caller that omits epic fields (e.g., `TaskViewerProvider`, `NotionBackupService`, `SessionActionLog`) silently destroys epic relationships.

### `src/services/KanbanProvider.ts` — Harden `createEpic` handler

3. **Pass `isEpic: 1` explicitly in the `upsertPlan` call**
   - In the `createEpic` handler (line 6456), add `isEpic: 1` and `epicId: ''` to the object passed to `db.upsertPlan()`. Currently the field is omitted, relying on the separate `updateEpicStatus` call. Making it explicit reduces the vulnerability window before `updateEpicStatus` runs and ensures the initial INSERT has correct epic state even before the SQL conflict fix takes effect.

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
- Verify `createPlan` (non-epic) still works — `isEpic` will be `null`/`undefined`, which maps to `NULL` in DB (correct).
- Verify ClickUp/Linear sync import paths — any plan re-import now preserves epic state instead of wiping it.
- Verify `TaskViewerProvider` re-registration of existing plans does not wipe epic data.

### Automated Tests
- Add a regression test in `src/test/completed-column-status-regression.test.js` (or a new `src/test/epic-upsert-regression.test.js`) that:
  1. Creates an epic plan via `db.upsertPlan({ ..., isEpic: 1, epicId: '' })`.
  2. Calls `db.upsertPlan({ ... })` on the same plan WITHOUT `isEpic`/`epicId` (simulating a generic metadata re-import from `TaskViewerProvider` or `GlobalPlanWatcherService`).
  3. Asserts `db.getPlanBySessionId()` still returns `isEpic === 1` and `epicId === ''`.
  4. Asserts `UPSERT_PLAN_SQL` does NOT contain `is_epic = excluded.is_epic` or `epic_id = excluded.epic_id` in its conflict clause.

## Edge-Case & Dependency Audit

### Race Conditions
- **createEpic race window:** Between `upsertPlan` (without `isEpic`) and `updateEpicStatus`, the file watcher could re-import the plan as non-epic. The fix closes this by passing `isEpic: 1` in the initial `upsertPlan` call and by removing epic fields from the conflict update clause.
- **GlobalPlanWatcher re-import:** Any plan file modification triggers `upsertPlans`. Because the SQL updates `is_epic = excluded.is_epic` and `epic_id = excluded.epic_id`, plans passed without these fields (e.g., from `TaskViewerProvider._savePlanRegistry`, `SessionActionLog`, `NotionBackupService`) write `NULL`/`''` to both columns, destroying epic state. Removing these from the `DO UPDATE SET` clause prevents this systemic data loss.

### Security
- None. No auth, input validation, or injection risks. SQL uses parameterized placeholders.

### Side Effects
- Callers that intentionally relied on `upsertPlans` to overwrite epic status on conflict will no longer do so. Audit shows no such callers exist; all epic status changes go through `updateEpicStatus` or `createEpic`.

### Dependencies & Conflicts
- `kanban.html`, `planning.html`, `planning.js` — unchanged.
- `GlobalPlanWatcherService` — unchanged; its update path spreads `...plan` preserving epic fields, and the SQL fix protects it from overwriting.
- `TaskViewerProvider` — unchanged; the SQL fix protects existing epic data during re-registration.
- `KanbanMigration` — unchanged; migration inserts new plans without epic data (legacy snapshots lack epic fields), and the SQL fix ensures conflicts don't overwrite existing epic state.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) The parameter fix alone leaves `is_epic`/`epic_id` in the `DO UPDATE SET` clause, so callers like `TaskViewerProvider` and `NotionBackupService` that omit these fields still wipe epic data on conflict. (2) Removing the conflict updates is architecturally correct (epic status is a lifecycle field, not metadata) but requires verifying no caller depends on the overwrite behavior. Mitigations: remove the fields from `DO UPDATE SET` to match the `kanban_column`/`status` pattern; audit confirms all epic mutations use `updateEpicStatus`.

## Recommendation
Complexity 4 → **Send to Coder** (single focused fix, well-understood root cause, minimal blast radius).

## Execution Log

**Files changed:**
- `src/services/KanbanDatabase.ts`
  - Removed `is_epic = excluded.is_epic,` and `epic_id = excluded.epic_id` from `UPSERT_PLAN_SQL` `ON CONFLICT ... DO UPDATE SET` clause.
  - Appended `record.isEpic ?? null` and `record.epicId || ''` to the `upsertPlans()` values array.
  - Appended same two parameters to the migration restore `UPSERT_PLAN_SQL` call.
- `src/services/KanbanProvider.ts`
  - Added `isEpic: 1, epicId: ''` to the `createEpic` handler's `db.upsertPlan()` call.
- `src/test/epic-upsert-regression.test.js` (new)
  - Regression test verifying SQL conflict clause does not overwrite epic fields and that functional DB checks preserve `isEpic` across metadata re-import.

**Validation results:**
- Regression test passes (4/4):
  - UPSERT_PLAN_SQL does not overwrite `is_epic` on conflict
  - UPSERT_PLAN_SQL does not overwrite `epic_id` on conflict
  - upsertPlans passes 25 parameters matching SQL placeholders
  - Functional DB checks preserve epic fields across conflict re-import

**Remaining risks:**
- None identified. No callers rely on epic fields being overwritten during conflict resolution; all epic mutations route through `updateEpicStatus` or `createEpic`.

## Review Findings

Reviewer pass completed. Files unchanged — implementation matches plan exactly. Validation: regression test passes 4/4 (SQL clause check, placeholder count, functional DB conflict preservation). No material issues found. The systemic vulnerability is closed: `is_epic` and `epic_id` are excluded from the `ON CONFLICT DO UPDATE SET` clause, so callers like `TaskViewerProvider`, `GlobalPlanWatcherService`, `SessionActionLog`, and `KanbanMigration` that omit epic fields in re-imports no longer silently wipe epic data. The `createEpic` handler now passes `isEpic: 1` explicitly in the initial `upsertPlan`, removing the race window before `updateEpicStatus` runs.
