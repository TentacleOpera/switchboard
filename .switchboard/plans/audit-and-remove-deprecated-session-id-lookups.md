# Audit and Remove Deprecated session_id Lookups

## Goal

Perform a codebase-wide audit of all `getPlanBySessionId` usages and migrate active code paths to `getPlanByPlanId` or `getPlanByPlanFile` as appropriate. `session_id` is deprecated as a unique lookup key; `plan_id` (via `getPlanByPlanId`) and `(plan_file, workspace_id)` (via `getPlanByPlanFile`) are the canonical primary keys. The immediate task is the audit; subsequent phases fix the classified usages.

**Problem Analysis:** `getPlanBySessionId` queries the deprecated `session_id` column first, then falls back to `plan_id` only if the parameter is truthy. For file-based plans where `session_id` is empty (`''`), the fallback is skipped entirely (`if (sessionId)` is `false` for empty strings), causing lookups to match arbitrary other plans with empty `session_id` or return nothing. Even when the parameter is a non-empty `planId`, the double-query fallback is semantically wrong, fragile, and risks collision if any plan's `session_id` happens to equal another plan's `plan_id`. All modern plans (including migration-v20 backfilled legacy plans) have a valid `plan_id` primary key, making `getPlanByPlanId` the correct lookup for ID-based resolution. File-based resolution should use `getPlanByPlanFile`.

## Metadata

**Tags:** backend, refactor, database, bugfix
**Complexity:** 6

## User Review Required

Yes — this plan spans multiple files and phases. Reviewer should validate the audit classification before Phase 2 execution begins.

## Complexity Audit

### Routine
- Method renames in call sites: `getPlanBySessionId` → `getPlanByPlanId` where the caller already has a `planId` or `_cardId()` value
- Method renames in call sites: `getPlanBySessionId` → `getPlanByPlanFile` where the caller already has a `planFile` path
- Updating callers of deprecated `KanbanDatabase` wrapper methods to use their `ByPlanFile` / `ByPlanId` replacements
- No schema changes, no new dependencies

### Complex / Risky
- **TaskViewerProvider.ts** has 28 usages, many inside registry/reconcile loops that iterate over candidate session IDs (`planId`, `antigravity_${planId}`, path hashes). Migrating these requires understanding which candidate is the canonical `planId` to avoid changing registry behavior.
- **KanbanProvider.ts** has 20 usages, several in batch operations (repoScope resolution, column moves, archiving) where `_cardId(card)` is passed. Changing the lookup method may affect performance or behavior if any card still relies on `sessionId`-only resolution.
- **PlanningPanelProvider.ts** epic handlers mirror `KanbanProvider.ts` epic handlers and may be out of sync after the epic fix plan is executed.
- **Test coverage gap**: `KanbanProvider.test.ts` references `getPlanBySessionId` directly; tests need updating alongside code changes.
- **updateEpicStatus** in `KanbanDatabase.ts` internally uses `getPlanBySessionId` and is called from multiple handlers. It cannot be safely refactored until all callers pass verified `planId`.

## Edge-Case & Dependency Audit

### Race Conditions
- None for the audit phase. For the fix phases, batch operations in KanbanProvider.ts (repoScope resolution, column moves) iterate over cards sequentially; changing the lookup method does not introduce new concurrency risks.

### Security
- None. No auth, input validation, or injection risks.

### Side Effects
- Changing lookups from `session_id`-first to `plan_id`-only may alter behavior for legacy plans that somehow have a non-empty `session_id` conflicting with another plan's `plan_id`. The collision risk exists today with `getPlanBySessionId`; switching to `getPlanByPlanId` eliminates it.
- PlanningPanelProvider.ts epic handlers must be kept in sync with KanbanProvider.ts epic handlers to avoid divergent behavior between the kanban board and the planning panel.

### Dependencies & Conflicts
- Depends on the epic handler fix plan (`fix-kanban-epic-button-uses-deprecated-session-id.md`) being completed first, or executed in the same changeset, to avoid divergent epic logic.
- `KanbanDatabase.ts` deprecated wrapper methods must remain during the migration; they can only be removed after all callers are migrated.
- `TaskViewerProvider.ts` registry logic may depend on `getPlanBySessionId`'s multi-candidate behavior for antigravity brain plans. This must be validated before migration.

## Dependencies

- `fix-kanban-epic-button-uses-deprecated-session-id.md` — epic handler fixes should precede or accompany this work

## Adversarial Synthesis

Key risks: (1) TaskViewerProvider.ts registry/reconcile logic iterates over multiple candidate IDs per plan; naively replacing `getPlanBySessionId` with `getPlanByPlanId` may break brain-plan discovery if the candidate being tried is not the canonical `planId`. (2) Some batch operations in KanbanProvider.ts may pass legacy `sessionId` values from `_cardId(card)` for plans that predate `plan_id` backfill; `getPlanByPlanId` with a legacy `sessionId` would fail. Mitigations: audit each call site to determine whether the parameter is guaranteed to be a `planId` or may still be a legacy `sessionId`; for ambiguous cases, add a `getPlanByAnyId` helper that queries `plan_id` first and falls back to `session_id` with a deprecation warning, or explicitly backfill `plan_id` for any remaining legacy records.

## Proposed Changes

### Phase 1 — Audit & Classify All `getPlanBySessionId` Usages

**File:** `src/services/KanbanDatabase.ts` (23 matches)

| Method | Status | Replacement | Migration Blocker |
|---|---|---|---|
| `getPlanBySessionId` | `@deprecated` | `getPlanByPlanId` / `getPlanByPlanFile` | None — direct call sites must be audited |
| `hasPlan` | `@deprecated` | `hasPlanByPlanFile` | Caller audit needed |
| `updateColumn` | `@deprecated` | `updateColumnByPlanFile` | Caller audit needed |
| `movePlan` | `@deprecated` | `movePlanByPlanFile` | Caller audit needed |
| `getPlanFilePath` | `@deprecated` | `getPlanFilePathByPlanFile` | Caller audit needed |
| `updateComplexity` | `@deprecated` | `updateComplexityByPlanFile` | Caller audit needed |
| `updateTags` | `@deprecated` | `updateTagsByPlanFile` | Caller audit needed |
| `updateStatus` | `@deprecated` | `updateStatusByPlanFile` | Caller audit needed |
| `reviveDeletedPlans` | `@deprecated` | `reviveDeletedPlansByPlanFile` | Caller audit needed |
| `updateLastAction` | `@deprecated` | `updateLastActionByPlanFile` | Caller audit needed |
| `updateTopic` | `@deprecated` | `updateTopicByPlanFile` | Caller audit needed |
| `updateLinearIssueId` | `@deprecated` | `updateLinearIssueIdByPlanFile` | Caller audit needed |
| `updateClickUpTaskId` | `@deprecated` | `updateClickUpTaskIdByPlanFile` | Caller audit needed |
| `deletePlan` | `@deprecated` | `deletePlanByPlanFile` | Caller audit needed |
| `updateMetadataBatch` | `@deprecated` | `updateMetadataBatchByPlanFile` | Caller audit needed |
| `completeMultiple` | `@deprecated` | `completeMultipleByPlanFile` | Caller audit needed |
| `updateDispatchInfo` | `@deprecated` | `updateDispatchInfoByPlanFile` | Caller audit needed |
| `updatePlanFile` | `@deprecated` (implicit) | `updatePlanFileByPlanFile` or direct by `planId` | Caller audit needed |
| `updateSessionId` | `@deprecated` (implicit) | N/A — should be removed entirely | Verify no callers remain |
| `updateEpicStatus` | No `@deprecated` tag | Add `updateEpicStatusByPlanId` | All callers must pass verified `planId` first |
| `appendPlanEvent` | `@deprecated` | `appendPlanEventByPlanId` | Caller audit needed |
| `getPlanEvents` | `@deprecated` | `getPlanEventsByPlanId` | Caller audit needed |

**Action:** Produce a spreadsheet or markdown table in this plan file documenting every call site across:
- `src/services/KanbanProvider.ts` (20 matches)
- `src/services/TaskViewerProvider.ts` (28 matches)
- `src/services/PlanningPanelProvider.ts` (4 matches)
- `src/services/ContinuousSyncService.ts` (1 match)
- `src/services/SessionActionLog.ts` (1 match)
- `src/services/__tests__/KanbanProvider.test.ts` (2 matches)

For each call site, classify:
- **Category A** — Safe to migrate: the caller already has a verified `planId` or `planFile` and should use `getPlanByPlanId` / `getPlanByPlanFile`.
- **Category B** — Needs helper: the caller passes a legacy `sessionId` that may not be a `planId`; needs a transitional `getPlanByAnyId` helper or explicit backfill.
- **Category C** — Registry/multi-candidate: the caller iterates over multiple candidate IDs (e.g., `planId`, `antigravity_${planId}`); needs redesign to use canonical `planId` directly.
- **Category D** — Deprecated wrapper internal: the usage is inside a deprecated wrapper method; will be removed with the wrapper.

### Phase 2 — Fix Epic Handlers & PlanningPanelProvider (High Priority)

**Files:**
- `src/services/KanbanProvider.ts` — lines 6408, 6419, 6429, 6439, 6460, 6531, 6540, 6559
- `src/services/PlanningPanelProvider.ts` — epic handler equivalents

**Action:** Apply the same `getPlanByPlanId` migrations and verified-`planId` passes to `updateEpicStatus` that are specified in `fix-kanban-epic-button-uses-deprecated-session-id.md`. Ensure `PlanningPanelProvider.ts` epic handlers (`getEpicDetails`, `addSubtaskToEpic`, `deleteEpic`) are updated identically to avoid divergent behavior.

### Phase 3 — Fix Remaining KanbanProvider.ts Active Paths

**File:** `src/services/KanbanProvider.ts`

Remaining usages after epic fix (lines approximate, verify against current HEAD):
- **Line ~2176** (`_buildKanbanColumns` epicId resolution): classify as A or B
- **Lines ~2293, 3003, 3192** (repoScope batch resolution): `cardKey = _cardId(card)`; classify as A (planId-first) or C (needs verification)
- **Line ~3838** (`queueIntegrationSyncForSession`): passes `sessionId`; classify as B
- **Line ~3894** (topic resolution for column move): passes `sessionId`; classify as B
- **Line ~3912** (column move epic check): passes `sessionId`; classify as B
- **Line ~3976** (planFile resolution): passes `sessionId`; classify as B
- **Line ~4193** (`reassignPlansWorkspace`): passes `sessionId` from source DB; classify as B
- **Line ~4722** (archive plans): passes `sid` from sessionIds list; classify as B
- **Line ~5500** (planId resolution): passes `sessionId`; classify as B
- **Line ~5637** (sidebar repoScope): `cardKey = _cardId(card)`; classify as A

**Action:** For Category A call sites, replace with `getPlanByPlanId`. For Category B call sites, either (a) trace the parameter upstream to confirm it is already a `planId` and reclassify, or (b) add a transitional helper `getPlanByAnyId` that queries `plan_id` first and `session_id` second with a deprecation warning, then update the caller to pass `planId` explicitly.

### Phase 4 — Fix TaskViewerProvider.ts

**File:** `src/services/TaskViewerProvider.ts` (28 matches)

**Action:** Audit each usage with the Phase 1 classification. Registry/reconcile logic (lines ~9975, ~10267, ~10435, ~10452, ~10479, ~10527, ~10573, ~10615, ~11054, ~11204, ~11985, ~12055, ~12113) that iterates candidate IDs should be redesigned to use the canonical `planId` from the registry entry instead of probing multiple IDs. Direct lookups (lines ~1038, ~1533, ~2572, ~2687, ~2719, ~2754, ~2884) should use `getPlanByPlanId` if the parameter is confirmed to be a `planId`.

### Phase 5 — Fix Remaining Services

**Files:**
- `src/services/ContinuousSyncService.ts` (line ~1046): `_getPlanRecord` should use `getPlanByPlanId`
- `src/services/SessionActionLog.ts` (1 match): classify and migrate
- `src/services/ClickUpSyncService.ts`: verify — grep showed 0 matches in source; may be in compiled output only

### Phase 6 — Update Tests

**File:** `src/services/__tests__/KanbanProvider.test.ts` (2 matches)

**Action:** Replace `getPlanBySessionId` references in tests with `getPlanByPlanId` or `getPlanByPlanFile` as appropriate. Add test cases for file-based plans with empty `session_id` to ensure lookups succeed via `plan_id`.

### Phase 7 — Final Cleanup (Future)

**File:** `src/services/KanbanDatabase.ts`

**Action:** After all callers in Phases 2–6 are migrated and verified:
1. Add `@deprecated` to `updateEpicStatus` and create `updateEpicStatusByPlanId`
2. Remove all `@deprecated` wrapper methods listed in Phase 1
3. Optionally remove the `session_id` column from the database schema (requires migration)

## Verification Plan

### Automated Tests
Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification
- After each phase, open the kanban board and verify:
  - Plan cards render correctly
  - Column moves persist
  - Epic operations (create, promote, add subtask, remove subtask, delete) work
  - Planning panel epic operations work identically
- After Phase 4, verify TaskViewer sidebar loads plans correctly and worktree/epic associations resolve

### Regression Checks
- Verify no plan lookups return wrong records (symptom: wrong card metadata, wrong epic association, or plan appearing in wrong workspace)
- Verify file-based plans (imported from brain watcher) with empty `session_id` are fully functional
- Verify legacy plans with non-empty `session_id` still resolve correctly via `plan_id`

## Recommendation

Complexity 6 → **Send to Coder** (multi-file coordination, moderate logic, requires understanding of registry/reconcile patterns in TaskViewerProvider.ts).

## Scope

### In Scope
- Phase 1: Audit and classify all `getPlanBySessionId` usages across the codebase
- Phase 2: Fix epic handlers in KanbanProvider.ts and PlanningPanelProvider.ts
- Phase 3: Fix remaining KanbanProvider.ts active paths
- Phase 4: Fix TaskViewerProvider.ts usages
- Phase 5: Fix ContinuousSyncService.ts, SessionActionLog.ts, and test references
- Phase 6: Update tests

### Out of Scope
- Phase 7 (final cleanup / removal of deprecated wrappers) — requires all callers migrated first
- Removing the `session_id` column from the database schema — requires a dedicated migration plan
- Refactoring registry/reconcile architecture in TaskViewerProvider.ts beyond lookup method changes
