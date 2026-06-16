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
- `_cardId(card)` in KanbanProvider.ts falls back to `card.sessionId` if `planId` is missing. Any un-backfilled legacy card will silently skip `getPlanByPlanId` lookups until its `plan_id` is populated.
- `reassignPlansWorkspace` (line 4193) passes `sessionId` to `getPlanBySessionId` with no `workspace_id` filter in the query. Cross-DB ghost record risk exists if the same `sessionId` value appears in multiple workspace databases.
- `updateEpicStatus` wrapper (KanbanDatabase.ts:1324) still calls `getPlanBySessionId` internally. Even after all epic handler lookups are migrated, epic status updates will continue to use the deprecated path until this wrapper is replaced.
- PlanningPanelProvider.ts epic handlers must be kept in sync with KanbanProvider.ts epic handlers to avoid divergent behavior between the kanban board and the planning panel.

### Dependencies & Conflicts
- KanbanProvider.ts epic handlers already use `getPlanByPlanId`; the remaining epic dependency is replacing the `updateEpicStatus` wrapper (KanbanDatabase.ts:1324) and migrating PlanningPanelProvider.ts epic handlers.
- `KanbanDatabase.ts` deprecated wrapper methods must remain during the migration; they can only be removed after all callers are migrated. Notably, `reviveDeletedPlans` (line 1545) internally loops with `getPlanBySessionId` and must be fixed before its wrapper can be removed.
- `TaskViewerProvider.ts` registry logic uses `_getRegistrySessionIdCandidates` to probe `antigravity_${planId}` and `planId`. Since modern backfill guarantees `plan_id` is populated, the candidate loop can be collapsed to a single `getPlanByPlanId` query.

## Dependencies

- `fix-kanban-epic-button-uses-deprecated-session-id.md` — already completed for KanbanProvider.ts; PlanningPanelProvider.ts epic handlers remain

## Adversarial Synthesis

Key risks: (1) `updateEpicStatus` wrapper in KanbanDatabase.ts still uses `getPlanBySessionId`, so epic mutations remain on the deprecated path even though lookups were migrated. (2) `reassignPlansWorkspace` and other Category B callers pass parameters named `sessionId` that may be legacy values; `getPlanByPlanId` will miss them. (3) TaskViewerProvider.ts registry loops probe multiple candidates; collapsing them requires confirming `plan_id` backfill is complete for all brain plans. Mitigations: add `updateEpicStatusByPlanId` and migrate the two KanbanProvider call sites; trace Category B parameters upstream to verify they are canonical `planId` values; replace registry candidate loops with direct `getPlanByPlanId` after backfill validation.

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
- `src/services/KanbanProvider.ts` (14 matches — 12 active call sites + 2 in comments)
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

**Status:** `KanbanProvider.ts` epic handler lookups already migrated to `getPlanByPlanId` (verified at lines 6408, 6419, 6429, 6439, 6460, 6531, 6540, 6559). The remaining epic work is:

**Files:**
- `src/services/KanbanProvider.ts` — lines 6507, 6521: `updateEpicStatus` still receives `sessionId` / `st.planId || st.sessionId`. The `updateEpicStatus` wrapper (KanbanDatabase.ts:1324) internally calls `getPlanBySessionId`. Must add `updateEpicStatusByPlanId(planId, isEpic, epicId)` and migrate these two call sites.
- `src/services/PlanningPanelProvider.ts` — lines 2002 (`getEpicDetails`), 2017 (`addSubtaskToEpic` epic lookup), 2026 (`addSubtaskToEpic` subtask lookup), 2065 (`deleteEpic`): still use `getPlanBySessionId`. Migrate to `getPlanByPlanId`.

**Action:** Add `updateEpicStatusByPlanId` in KanbanDatabase.ts. Migrate KanbanProvider.ts lines 6507 and 6521 to pass `planId` explicitly. Migrate PlanningPanelProvider.ts epic handlers to `getPlanByPlanId`.

### Phase 3 — Fix Remaining KanbanProvider.ts Active Paths

**File:** `src/services/KanbanProvider.ts`

Verified exact call sites and classifications:
- **Line 2176** (`_buildKanbanColumns` epicId resolution): passes `cardKey` (`_cardId(card)` = `planId || sessionId`). **Category A** — `planId` is populated for all modern plans. Migrate to `getPlanByPlanId(cardKey)` with defensive fallback logging if no record found.
- **Lines 2293, 3003, 3192** (repoScope batch resolution): `cardKey = _cardId(card)`. **Category A** — same as above. All three locations are identical repoScope resolution loops. Migrate to `getPlanByPlanId(cardKey)`.
- **Line 3838** (`queueIntegrationSyncForSession`): parameter is named `sessionId` but is passed from `msg.sessionId` which is the card's primary ID. **Category B** — trace upstream to confirm it is `planId`; if confirmed, reclassify to A and migrate.
- **Line 3894** (topic resolution for column move): passes `sessionId` from `msg.sessionId`. **Category B** — trace upstream to confirm it is `planId`.
- **Line 3912** (column move epic check): passes `sessionId` from `msg.sessionId`. **Category B** — trace upstream to confirm it is `planId`.
- **Line 3976** (planFile resolution): passes `sessionId` from `msg.sessionId`. **Category B** — trace upstream to confirm it is `planId`.
- **Line 4193** (`reassignPlansWorkspace`): passes `sessionId` from the `sessionIds` array sourced from the source DB. The comment at line 4191 explicitly warns `getPlanBySessionId` has no `workspace_id` filter. **Category B / High Risk** — must use `getPlanByPlanId` AND validate the returned record's `workspaceId` matches the expected workspace.
- **Line 4722** (archive plans): passes `sid` from `sessionIds` list. **Category B** — trace upstream; if the list is derived from `_cardId` values, reclassify to A.
- **Line 5500** (planId resolution inside integration sync): passes `sessionId`. **Category B** — trace upstream to confirm it is `planId`.
- **Line 5637** (sidebar repoScope): `cardKey = _cardId(card)`. **Category A** — same pattern as lines 2293/3003/3192. Migrate to `getPlanByPlanId(cardKey)`.

**Action:** For Category A call sites, replace with `getPlanByPlanId`. For Category B call sites, trace the parameter upstream. If confirmed as `planId`, reclassify to A. For `reassignPlansWorkspace`, add workspace validation after the lookup. Do not add a transitional `getPlanByAnyId` helper unless an un-backfilled legacy caller is found.

### Phase 4 — Fix TaskViewerProvider.ts

**File:** `src/services/TaskViewerProvider.ts` (28 matches)

Verified exact call sites:

**Registry / reconcile loops (Category C):**
- **Line 9975** (`_getRegistryDbRecord`): iterates `_getRegistrySessionIdCandidates(planId, sourceType)` which returns `[antigravity_${planId}, planId]` for brain plans and `[planId]` for others. **Redesign:** query `getPlanByPlanId(planId)` directly since `plan_id` backfill is complete. The `antigravity_` prefix is a legacy `session_id` artifact; the canonical key is `planId`.
- **Line 10267** (registry reconcile duplicate check): iterates candidates to delete duplicates. Replace with `getPlanByPlanId(candidate)` or remove the candidate loop and use direct `planId`.
- **Lines 10435, 10452, 10479, 10527** (registry hydrate loops): iterate `sessionIds` derived from `planId` and `antigravity_${planId}` to fetch topic, updatedAt, and completed status. **Redesign:** use a single `getPlanByPlanId(entry.planId)` call and read the fields from the result.
- **Line 10573** (tombstone revive): passes `pathHash` (which IS the `planId` for brain plans). **Category A** — migrate to `getPlanByPlanId(pathHash)`.
- **Line 11204** (tombstone hash ensure exists): passes `hash` (brain plan hash = `planId`). **Category A** — migrate to `getPlanByPlanId(hash)`.

**Direct lookups (Category A or B):**
- **Line 1038** (workspace resolution for session): parameter is `sessionId` passed from `_findWorkspaceRootForSession`. If this is the canonical `planId`, **Category A** — migrate to `getPlanByPlanId`.
- **Line 1533** (`_lastSessionId` lookup): `this._lastSessionId` is stored from prior registry entries. Verify if it stores `planId` or legacy `sessionId`. If `planId`, **Category A**.
- **Line 2572** (epicId/worktreePath from `sid`): `sid` comes from `sessionIds` array. Trace upstream to confirm it is `planId`.
- **Line 2687** (planner improve-plan planRecord): passes `plan.sessionId`. If `plan` object has `planId`, use it instead. **Category A** — `plan.sessionId` may be empty for file-based plans.
- **Line 2719** (analyst map single): passes `sessionId`. Trace upstream.
- **Line 2754** (analyst map batch): passes `sessionId` from `sessionIds` array. Trace upstream.
- **Line 2884** (normalizedCurrentColumn): passes `sessionId`. Trace upstream.

**Other lookups:**
- **Line 10615** (plan data from DB): passes `sessionId`. Trace upstream.
- **Line 11054** (revived deleted local plan): passes `deletedEntry.sessionId`. If `deletedEntry` has `planId`, use it. **Category A** with fallback.
- **Line 11985** (reconcile mirror name): passes `completedSessionId`. If this is derived from `planId`, **Category A**.
- **Line 12055** (brainSourcePath): passes `sessionId`. Trace upstream.
- **Line 12113** (completed status check): passes `sessionId`. Trace upstream.

**Action:** Collapse registry candidate loops to direct `getPlanByPlanId(planId)` calls. For direct lookups, prefer `planId` if available on the calling object; otherwise trace the parameter upstream to confirm it is canonical before migrating.

### Phase 5 — Fix Remaining Services

**Files:**
- `src/services/ContinuousSyncService.ts` (line 1046): `_getPlanRecord` receives `sessionId` from its caller. Trace upstream to confirm it is `planId`, then migrate to `getPlanByPlanId`.
- `src/services/SessionActionLog.ts` (line 76): `_resolvePlan` tries `getPlanByPlanFile` first, then falls back to `getPlanBySessionId`. This is an intentional backward-compatibility shim. **Do not migrate** until legacy sessionId support is dropped entirely.
- `src/services/ClickUpSyncService.ts`: verify — grep showed 0 matches in source; may be in compiled output only

### Phase 6 — Update Tests

**File:** `src/services/__tests__/KanbanProvider.test.ts` (2 matches)

**Action:** Replace `getPlanBySessionId` references in tests with `getPlanByPlanId` or `getPlanByPlanFile` as appropriate. The mock DB objects must also expose `getPlanByPlanId` returning `undefined` (lines 59, 81) or the tests will fail with `TypeError: db.getPlanByPlanId is not a function`. Add test cases for file-based plans with empty `session_id` to ensure lookups succeed via `plan_id`.

### Phase 7 — Final Cleanup (Future)

**File:** `src/services/KanbanDatabase.ts`

**Action:** After all callers in Phases 2–6 are migrated and verified:
1. Add `@deprecated` to `updateEpicStatus` and create `updateEpicStatusByPlanId` (do this in Phase 2)
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
- Phase 2: Fix `updateEpicStatus` wrapper (KanbanDatabase.ts) and epic handlers in PlanningPanelProvider.ts (KanbanProvider.ts epic lookups already migrated)
- Phase 3: Fix remaining KanbanProvider.ts active paths
- Phase 4: Fix TaskViewerProvider.ts usages
- Phase 5: Fix ContinuousSyncService.ts, SessionActionLog.ts, and test references
- Phase 6: Update tests

### Out of Scope
- Phase 7 (final cleanup / removal of deprecated wrappers) — requires all callers migrated first
- Removing the `session_id` column from the database schema — requires a dedicated migration plan
- Refactoring registry/reconcile architecture in TaskViewerProvider.ts beyond lookup method changes
