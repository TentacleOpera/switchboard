# Fix Antigravity Brain Plan Mirroring and Project Sentinel Values

## Goal
Resolve two critical issues that prevent Antigravity brain plans from showing up on the Switchboard Kanban board:
1. **Sentinel Project Filter Mismatch**: Normalize the `"__unassigned__"` project sentinel value to `""` (empty string) before storing it in `kanban.db` and plan registry, ensuring that unassigned plans are successfully retrieved by the Kanban queries which filter for `project = ''`.
2. **15-Second Autoclaim Cutoff**: Relax the 15-second auto-claim age limit for unregistered brain plans when they are completely unclaimed (no claim marker exists on disk or is owned by the current workspace).

**Core Problem & Root Cause**: The sentinel value `'__unassigned__'` (defined at `KanbanDatabase.ts:524` as `UNASSIGNED_PROJECT_FILTER`) is a UI-only filter value. The DB query methods (`getBoardFilteredByProject`, `getColumnCounts`, `getColumnDependencies`, `getCompletedPlansFilteredByProject`) already translate this sentinel to `''` at read time (lines 2200, 2230, 2257, 2313). However, the write paths — specifically `_mirrorBrainPlan` (line 11900), `_registerPlan` (line 9991), `_savePlanRegistry` (line 9904), `_loadPlanRegistry` (lines 9781, 9796), and `assignPlansToProject` (line 2180) — do NOT normalize the sentinel before writing to the DB. When `getProjectFilter()` returns `'__unassigned__'` and that value flows into a plan's `project` field, it gets stored verbatim in the DB, making the plan invisible to the very queries that translate the sentinel to `''` for filtering.

**Canonical Invariant**: `''` (empty string) is the sole canonical DB representation for "no project". The sentinel `'__unassigned__'` is a UI-only value that must never reach the `plans.project` column. `GlobalPlanWatcherService.ts:44` already enforces this invariant for its write path; the fix extends it to all remaining write boundaries.

## Metadata
- **Tags:** [kanban, watcher, reliability]
- **Complexity:** 3

## User Review Required
- Existing database rows with `project = '__unassigned__'` will be migrated to `project = ''` via database migration version 28.
- The 15-second age cutoff will be relaxed only when no other workspace has claimed the plan (coordinated by checking `.switchboard_claim_<hash>.json`). This means old unclaimed brain plans encountered during startup rescan (`_rescanAntigravityPlanSources`) will now be auto-claimed, which is the intended behavior — they were previously invisible due to the age gate.

## Complexity Audit

### Routine
- Adding SQL migration step in `KanbanDatabase.ts` for migration v28 (follows established pattern from V19–V27).
- Normalizing the string sentinel `"__unassigned__"` to `""` at registration, load, and save functions in `TaskViewerProvider.ts` and `KanbanDatabase.ts`.
- Updating the candidate checks in `_mirrorBrainPlan` to relax the age gate.

### Complex / Risky
- None. The changes modify metadata normalization and relax limits without impacting data formats or concurrency safety. The atomic claim marker (`_tryClaimBrainPlan` with `writeFileSync flag: 'wx'`) remains the authoritative guard for cross-workspace coordination.

## Edge-Case & Dependency Audit
- **Race Conditions**: The claim marker pre-check in `_mirrorBrainPlan` (proposed `claimMarkerExists` / `claimMarkerOwnedByUs` variables) has a TOCTOU window with the subsequent `_tryClaimBrainPlan` call. This is acceptable: the pre-check is an optimization to avoid unnecessary file reads, not a security boundary. The atomic `wx` write in `_tryClaimBrainPlan` (line 10840) is the authoritative guard. Worst case of a stale pre-check is wasted I/O reading a brain file that can't be claimed — no data corruption risk.
- **Security**: No security implications. The sentinel is an internal UI value, not user-supplied input. The claim marker uses atomic file creation, preventing cross-workspace contamination.
- **Side Effects**: The age relaxation will cause `_rescanAntigravityPlanSources` (line 11192, which calls `_mirrorBrainPlan(filePath, isRecent, ...)`) to auto-claim old unclaimed brain plans during startup rescan. This is the intended fix — these plans were previously invisible. No other side effects on existing plans or kanban state.
- **Dependencies & Conflicts**: `GlobalPlanWatcherService.ts:44` already normalizes the sentinel in its `setCurrentProject` method. The fix brings `TaskViewerProvider.ts` and `KanbanDatabase.ts` write paths into alignment with this existing precedent. No conflicts with other in-flight work.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) TOCTOU between claim marker pre-check and `_tryClaimBrainPlan` — acceptable since atomic write is the real guard; (2) `_loadPlanRegistry` has two entry construction paths (stale entries at line 9781 and normal entries at line 9796) that both need sentinel normalization — missing the stale path would re-register sentinel values. Mitigations: document TOCTOU as acceptable in code comments; apply normalization to both `_loadPlanRegistry` entry paths.

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Migration V28** (add after V27 block at line ~3915):
  - Define `MIGRATION_V28_SQL` constant (add near line 439 after `MIGRATION_V27_SQL`):
    ```typescript
    // V28: Normalize project sentinel values stored as '__unassigned__' to empty string.
    // The sentinel is a UI filter value that must never appear in the plans.project column.
    const MIGRATION_V28_SQL = [
        `UPDATE plans SET project = '' WHERE project = '__unassigned__'`,
    ];
    ```
  - Add version-gated migration execution in `_runMigrations()` (add after V27 block, around line 3915):
    ```typescript
    // V28: Normalize project sentinel values from '__unassigned__' to ''
    const v28 = await this.getMigrationVersion();
    if (v28 < 28) {
        for (const sql of MIGRATION_V28_SQL) {
            try { this._db.exec(sql); } catch (e) {
                console.debug('[KanbanDatabase] V28 migration step skipped:', e);
            }
        }
        await this.setMigrationVersion(28);
        console.log('[KanbanDatabase] V28 migration completed: project values normalized from __unassigned__ to empty string');
    }
    ```

- **Method `assignPlansToProject`** (line 2170):
  - Normalize `projectName` to `''` if it matches `UNASSIGNED_PROJECT_FILTER` before writing to DB:
    ```typescript
    // At line 2175, before the try block, add:
    const effectiveProjectName = projectName === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : projectName;
    // Then at line 2180, replace projectName with effectiveProjectName:
    this._db.run(
        "UPDATE plans SET project = ? WHERE (plan_id = ? OR session_id = ?) AND workspace_id = ?",
        [effectiveProjectName, planId, planId, workspaceId]
    );
    ```

### `src/services/TaskViewerProvider.ts`
- **Method `_loadPlanRegistry`** (line 9740):
  - Normalize `p.project` in the **stale entries** construction (line 9781):
    ```typescript
    // Line 9781: Change from:
    project: p.project || undefined,
    // To:
    project: (p.project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : p.project) || undefined,
    ```
  - Normalize `p.project` in the **normal entries** construction (line 9796):
    ```typescript
    // Line 9796: Change from:
    project: p.project || undefined,
    // To:
    project: (p.project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : p.project) || undefined,
    ```

- **Method `_savePlanRegistry`** (line 9887):
  - Normalize `entry.project` before writing to DB record (line 9904):
    ```typescript
    // Line 9904: Change from:
    project: entry.project ?? existing?.project ?? '',
    // To:
    project: (entry.project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : entry.project) ?? existing?.project ?? '',
    ```

- **Method `_registerPlan`** (line 9923):
  - Normalize `entry.project` before writing to DB record (line 9991):
    ```typescript
    // Line 9991: Change from:
    project: entry.project ?? existing?.project ?? '',
    // To:
    project: (entry.project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : entry.project) ?? existing?.project ?? '',
    ```

- **Method `_mirrorBrainPlan`** (line 11776):
  - Add claim marker pre-check before the `isFreshUnregisteredCandidate` definition (insert before line 11842):
    ```typescript
    // Pre-check claim marker for age relaxation (see TOCTOU note in Edge-Case audit).
    // _tryClaimBrainPlan's atomic wx write remains the authoritative guard.
    const claimMarkerPath = path.join(path.dirname(baseBrainPath), `.switchboard_claim_${pathHash}.json`);
    let claimMarkerExists = false;
    let claimMarkerOwnedByUs = false;
    try {
        if (fs.existsSync(claimMarkerPath)) {
            claimMarkerExists = true;
            const existingClaim = JSON.parse(fs.readFileSync(claimMarkerPath, 'utf8'));
            const wsId = await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);
            if (existingClaim.workspaceId === wsId) {
                claimMarkerOwnedByUs = true;
            }
        }
    } catch {
        // ignore — marker may be unreadable or malformed; safe to proceed
    }
    ```
  - Relax age check condition in `isFreshUnregisteredCandidate` (line 11842–11846):
    ```typescript
    // Change from:
    const isFreshUnregisteredCandidate =
        !existingEntry &&
        !runSheetKnown &&
        !fs.existsSync(mirrorPath) &&
        (Date.now() - fileCreationTimeMs) <= TaskViewerProvider.NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS;
    // To:
    const isFreshUnregisteredCandidate =
        !existingEntry &&
        !runSheetKnown &&
        !fs.existsSync(mirrorPath) &&
        ((Date.now() - fileCreationTimeMs) <= TaskViewerProvider.NEW_BRAIN_PLAN_AUTOCLAIM_WINDOW_MS || !claimMarkerExists || claimMarkerOwnedByUs);
    ```
  - Normalize `activeProject` to `''` if it equals `UNASSIGNED_PROJECT_FILTER` before registering the plan (line 11900):
    ```typescript
    // Line 11900: Change from:
    const activeProject = this._kanbanProvider?.getProjectFilter() ?? undefined;
    // To:
    const activeProject = this._kanbanProvider?.getProjectFilter() ?? undefined;
    const insertProject = activeProject === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : activeProject;
    // Line 11908: Change from:
    project: activeProject,
    // To:
    project: insertProject,
    ```

## Verification Plan

### Automated Tests
- Run all tests to ensure zero regressions:
  ```bash
  npm test
  ```
- **Clarification**: Existing test `KanbanProvider.test.ts:512` verifies that `getProjectFilter()` returns the sentinel after workspace switch. This test should continue to pass unchanged — the sentinel is correct as a UI filter value; the fix ensures it never reaches the DB.

### Manual Verification
- Verify that old plans with project name `__unassigned__` in `.switchboard/kanban.db` are updated to `''` and appear correctly on the Kanban board under the "Unassigned" project filter.
- Place a brain plan that is hours old (with no claim marker) in the brain directory, open the workspace, and verify that the startup rescan claims and mirrors it.
- Verify that `_rescanAntigravityPlanSources` (triggered on workspace activation) now picks up previously-invisible old brain plans.

**Recommendation**: Complexity 3 → Send to Intern

## Review Results (2026-06-05)

### Stage 1: Adversarial Findings

| # | Finding | Severity | Details |
|---|---------|----------|---------|
| 1 | Plan references phantom methods `getColumnCounts` / `getColumnDependencies` at lines 2230, 2257 | NIT | Actual methods are `getPlansByColumn` (line 2227) and `getPlansWithDependencies` (line 2258). Both correctly translate sentinel. Code is fine; plan line refs are stale. |
| 2 | `upsertPlans` (KanbanDatabase.ts:1149) does `record.project \|\| ''` — no sentinel guard | NIT | If any caller passes `'__unassigned__'`, it sails into DB. All 28 current callers verified safe. Architectural fragility, not a current bug. |
| 3 | `_migrateLegacyPlanRegistryEntries` (TaskViewerProvider.ts:9845) omits `project` field | NIT | `undefined \|\| ''` in `upsertPlans` produces correct `''`. Cosmetic inconsistency with other write paths. |

**No CRITICAL or MAJOR findings.** All 10 implementation sites verified correct against plan requirements.

### Stage 2: Balanced Synthesis

- **Keep**: All implemented code — matches plan exactly.
- **Fix now**: Nothing required.
- **Defer**: Consider adding sentinel normalization in `upsertPlans` as defense-in-depth (one-liner: `record.project === KanbanDatabase.UNASSIGNED_PROJECT_FILTER ? '' : (record.project \|\| '')`). Low priority since all callers are safe.

### Verification

- **Typecheck**: Ran `npx tsc --noEmit`. 2 pre-existing errors in unrelated files (`ClickUpSyncService.ts:2310`, `KanbanProvider.ts:4788` — missing `.js` extensions in dynamic imports). **Zero new type errors introduced by this plan.**
- **Tests**: Skipped per session instructions (user will run separately).

### Implementation Verification Matrix

| Plan Requirement | File | Line(s) | Status |
|---|---|---|---|
| V28 migration SQL | KanbanDatabase.ts | 441-445 | ✅ Exact match |
| V28 migration execution | KanbanDatabase.ts | 3925-3935 | ✅ Exact match |
| `assignPlansToProject` normalization | KanbanDatabase.ts | 2183 | ✅ Exact match |
| `_loadPlanRegistry` stale entries | TaskViewerProvider.ts | 9781 | ✅ Exact match |
| `_loadPlanRegistry` normal entries | TaskViewerProvider.ts | 9796 | ✅ Exact match |
| `_savePlanRegistry` normalization | TaskViewerProvider.ts | 9904 | ✅ Exact match |
| `_registerPlan` normalization | TaskViewerProvider.ts | 9991 | ✅ Exact match |
| Claim marker pre-check | TaskViewerProvider.ts | 9843-9857 | ✅ Exact match |
| Age relaxation in `isFreshUnregisteredCandidate` | TaskViewerProvider.ts | 9864 | ✅ Exact match |
| `insertProject` normalization | TaskViewerProvider.ts | 9918-9919, 9927 | ✅ Exact match |

### Remaining Risks

1. **Maintenance trap**: Future callers of `upsertPlans` may pass the sentinel without normalization. Mitigation: add central guard in `upsertPlans` as follow-up.
2. **Pre-existing type errors**: Two unrelated TS2835 errors in dynamic imports. Not caused by this plan.
3. **Manual verification pending**: The three manual verification steps in the Verification Plan have not been executed in this review session.
