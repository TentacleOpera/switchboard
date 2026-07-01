# Create Button in Implementation Tab Creates Duplicate Ticket

**Plan ID:** 8b2d4f71-6c3a-4e9b-8f0d-2a7c9e1b5538

## Goal

The CREATE button in `implementation.html` creates a duplicate ticket — two runsheets and two DB entries for the same plan file. The fix must ensure that when `_createInitiatedPlan` is in flight, neither file watcher creates a second runsheet or DB row.

### Problem
The CREATE button in the Implementation tab calls `createDraftPlanTicket()` which calls `_createInitiatedPlan()`. This method:
1. Adds the plan path to `_pendingPlanCreations` (dedup guard set)
2. Writes the plan file to disk
3. Creates a runsheet in the session log
4. Registers the plan in the kanban DB
5. Removes the path from `_pendingPlanCreations` after a 2-second timeout

Meanwhile, a VS Code file system watcher monitors the `.switchboard/plans/` directory. When it detects the new file, it calls `_handlePlanCreation()`, which:
1. Checks if the path is in `_pendingPlanCreations` or `_planCreationInFlight` — if so, returns early
2. Checks the kanban DB for an existing entry — if found, returns early
3. Checks for an existing runsheet — if found, returns early
4. If none of the guards match, creates a **second** runsheet and a **second** DB entry

### Background
There are **two independent file watchers** that both insert plan rows for a new file:

1. **TaskViewerProvider's watcher** — `_handlePlanCreation` (TaskViewerProvider.ts:13801-13964). Checks `_pendingPlanCreations` / `_planCreationInFlight` (line 13802). On a miss, calls `log.createRunSheet(planId, runSheet)` (line 13937) → `SessionActionLog._doCreateRunSheet` → `db.insertFileDerivedPlan` (SessionActionLog.ts:504).

2. **GlobalPlanWatcherService's watcher** — `_handlePlanFile` (GlobalPlanWatcherService.ts:444). Checks its OWN static `GlobalPlanWatcherService._pendingCreations` (line 446, **10-second** window). On a miss, calls `db.insertFileDerivedPlan(newRecord)` directly (line 574) — it does **NOT** create a session-log runsheet, only a kanban DB row.

`_createInitiatedPlan` registers both guards: `_pendingPlanCreations.add` (line 17256) and `GlobalPlanWatcherService.registerPendingCreation` (line 17257, 10s window). It does **NOT** currently add to `_planCreationInFlight`.

### Root Cause
**Two converging defects:**

1. **`_planCreationInFlight` is never populated by `_createInitiatedPlan`.** The finally block at TaskViewerProvider.ts:17329-17331 only removes `_pendingPlanCreations` after a 2s timeout. `_planCreationInFlight` — the "same-file mutex for watcher/direct create races" (declared at line 282) — is never added in `_createInitiatedPlan`. So the TaskViewerProvider watcher's check at line 13802 only sees `_pendingPlanCreations`, which expires after 2s. If the watcher event is delayed beyond 2s (network drives, busy systems), it passes the guard and creates a second runsheet + DB row.

2. **DB upsert key mismatch (deeper cause of "two DB entries").** `insertFileDerivedPlan` (KanbanDatabase.ts:1372-1441) uses `ON CONFLICT(plan_file, workspace_id) DO UPDATE` (line 1404) — a true upsert. Two inserts with the **same** `(plan_file, workspace_id)` produce ONE row. Duplicate DB rows therefore require the two insertions to use **different** `plan_file` keys or **different** `workspace_id` values. The most likely source: `_ensureRelativePlanFile` (KanbanDatabase.ts:6250) returns the path **unchanged** when `this._workspaceRoot` is not set (lines 6252-6254). On a cold-start workspace, one insertion may run before `_workspaceRoot` is populated, storing an absolute path while the other stores a relative path — different keys, two rows, upsert cannot save you.

The existing cleanup at lines 13994-14007 (`cleanupDuplicateLocalPlans`) removes duplicate DB rows but does **not** remove duplicate runsheets — so the user may see two tickets in the dropdown even after cleanup.

## Metadata
- **Tags:** backend, bugfix, reliability
- **Complexity:** 5

## User Review Required
Yes — confirm whether the deeper DB-key-mismatch root cause (cold-start `_workspaceRoot` unset during one insertion) should be investigated/fixed in this plan or tracked separately. The primary fix (change #1) prevents the duplicate runsheet at the source; the normalization fix is the durable cure for duplicate DB rows but requires verifying the mismatch hypothesis against real duplicate rows.

## Complexity Audit

### Routine
- Add one `Set.add` call (`_planCreationInFlight.add`) before the file write in `_createInitiatedPlan` (TaskViewerProvider.ts:17258).
- Add one `Set.delete` call in the existing `finally` block (TaskViewerProvider.ts:17329).
- Adjust the `_pendingPlanCreations` timeout constant (TaskViewerProvider.ts:17330) to match GlobalPlanWatcherService's 10s window so both watchers share the same suppression horizon.

### Complex / Risky
- **Two-watcher interaction:** the fix suppresses the TaskViewerProvider watcher via `_planCreationInFlight`; GlobalPlanWatcherService is already guarded for 10s via `registerPendingCreation` (line 17257). The fix must not over-suppress the legitimate manual-drop path (user copies a `.md` into `.switchboard/plans/`), which relies on the watcher creating exactly one entry. Suppression is keyed by exact path, and `_createInitiatedPlan` uses timestamped-unique filenames, so cross-contamination with manual drops is not a risk.
- **DB-key normalization (verification, not code change in this plan):** confirming whether duplicate rows carry different `plan_file`/`workspace_id` values determines whether a follow-up normalization fix is needed. This is investigative, not implementation, in scope here.

## Edge-Case & Dependency Audit
- **Race Conditions:**
  - **Watcher fires during `_createInitiatedPlan`:** With `_planCreationInFlight` added before the file write, the TaskViewerProvider watcher's check at line 13802 returns early for the entire async lifecycle. `finally` deletes `_planCreationInFlight` only after all DB writes commit. Correct.
  - **Watcher fires after `finally` but within the guard window:** `_pendingPlanCreations` (extended to 10s) catches it at line 13802. GlobalPlanWatcherService's own 10s window catches its watcher at line 446. Both windows now align.
  - **`_createInitiatedPlan` throws after file write, before DB register:** `finally` still deletes `_planCreationInFlight`. The watcher then runs (guard expired) and performs the registration — exactly once, because the DB upsert dedups on `(plan_file, workspace_id)` (assuming normalization is consistent). Acceptable.
- **Security:** None. No user input reaches a shell; plan paths are internally generated from timestamped slugs.
- **Side Effects:** Extending the guard window from 2s to 10s means a manually-dropped file with the *exact same path* as a just-created plan would be ignored for 10s. This is impossible in practice because `_createInitiatedPlan` generates timestamped-unique filenames.
- **Dependencies & Conflicts:**
  - **`GlobalPlanWatcherService.registerPendingCreation`** (GlobalPlanWatcherService.ts:42-49): already called at TaskViewerProvider.ts:17257. Uses a 10s window. The local `_pendingPlanCreations` window is extended to 10s to match — both guards now share the same suppression horizon.
  - **`_planCreationInFlight` set** (TaskViewerProvider.ts:282): "same-file mutex for watcher/direct create races." Already used by another create path at line 17116. Adding it to `_createInitiatedPlan` is consistent with its intended purpose.
  - **`insertFileDerivedPlan` upsert** (KanbanDatabase.ts:1404): `ON CONFLICT(plan_file, workspace_id) DO UPDATE`. Prevents duplicate rows ONLY when both insertions use the same normalized key. See Root Cause #2.
  - **`_ensureRelativePlanFile`** (KanbanDatabase.ts:6250): returns path unchanged when `_workspaceRoot` unset — the suspected source of key mismatch. Not modified in this plan; flagged for verification.
  - **`cleanupDuplicateLocalPlans`** (invoked at TaskViewerProvider.ts:14002): removes duplicate DB rows only, not runsheets. The primary fix (change #1) prevents the duplicate runsheet at the source, making runsheet cleanup unnecessary in the common case.
  - **No migration needed.** This is unreleased dev behavior.

## Dependencies
- None. This plan is self-contained and does not depend on any other in-flight plan (`sess_…`).

## Adversarial Synthesis
Key risks: (1) the plan's original "two DB entries" framing overlooked that `insertFileDerivedPlan` is a true upsert on `(plan_file, workspace_id)` — duplicate rows require a key mismatch, most likely from `_ensureRelativePlanFile` returning an un-normalized path when `_workspaceRoot` is unset on cold start; (2) there are TWO watchers and the original plan analyzed only one — GlobalPlanWatcherService is already guarded for 10s, so the local guard should match 10s rather than the originally-proposed 5s; (3) the original change #2 (runsheet cleanup) was a warning-log stub, not a real fix, and change #3 (removing a `planCreated` UI postMessage) was unrelated to the data-duplicate bug and risked breaking the standalone kanban panel's button re-enable. Mitigations: keep only the surgical `_planCreationInFlight` fix (change #1); align the guard window to 10s; drop the stub cleanup and the unrelated postMessage removal; add a verification step to inspect duplicate rows' keys and confirm whether a normalization follow-up is needed.

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — Add `_planCreationInFlight` before file write; align guard window to 10s

**File:** `src/services/TaskViewerProvider.ts`, lines 17255-17331

The key change: add the path to `_planCreationInFlight` **before** the file write, and only remove it **after** all DB operations complete (in the `finally` block). Extend the `_pendingPlanCreations` timeout from 2s to 10s to match `GlobalPlanWatcherService.registerPendingCreation`'s 10s window, so both watchers share the same suppression horizon.

```typescript
const stablePlanPath = this._normalizePendingPlanPath(planFileAbsolute);
this._pendingPlanCreations.add(stablePlanPath);
this._planCreationInFlight.add(stablePlanPath);  // NEW: same-file mutex for the full async lifecycle
GlobalPlanWatcherService.registerPendingCreation(planFileAbsolute);  // already 10s window
try {
    const content = isAirlock ? `## Notebook Plan\n\n${idea}` : idea;
    await fs.promises.writeFile(planFileAbsolute, content, 'utf8');

    const createdAt = options.createdAt || now.toISOString();
    const log = this._getSessionLog(workspaceRoot);
    await log.createRunSheet(planFileRelative, {
        planFile: planFileRelative,
        topic: title,
        createdAt,
        events: [{
            workflow: 'initiate-plan',
            timestamp: now.toISOString(),
            action: 'start'
        }]
    });

    // Register local plan in ownership registry
    const wsId = await this._getOrCreateWorkspaceId(workspaceRoot);

    await this._registerPlan(workspaceRoot, {
        planId: planFileRelative,
        ownerWorkspaceId: wsId,
        sourceType: 'local',
        localPlanPath: planFileRelative.replace(/\\/g, '/'),
        topic: title,
        createdAt,
        updatedAt: now.toISOString(),
        status: 'active'
    });

    // ... project assignment, logging, sync, brain promotion ...

    return { planFileAbsolute };
} finally {
    // Remove _planCreationInFlight immediately — all DB writes are committed,
    // so the TaskViewerProvider watcher's check at line 13802 will now pass
    // harmlessly (the upsert dedups any late insert on (plan_file, workspace_id)).
    this._planCreationInFlight.delete(stablePlanPath);
    // Keep _pendingPlanCreations for 10s to match GlobalPlanWatcherService's window,
    // covering delayed watcher events on slow/network filesystems. Both watchers
    // now share the same suppression horizon.
    setTimeout(() => this._pendingPlanCreations.delete(stablePlanPath), 10000);
}
```

**Why 10s and not the originally-proposed 5s:** `GlobalPlanWatcherService.registerPendingCreation` (GlobalPlanWatcherService.ts:46-48) already uses a 10s window and is called at line 17257. Setting the local guard to 5s would leave it shorter than the global guard, creating a 5s–10s window where the TaskViewerProvider watcher is unguarded while GlobalPlanWatcherService is still guarded — an inconsistent state. Aligning both to 10s makes the suppression horizon uniform.

### 2. (Dropped) Runsheets cleanup — removed from this plan

The original plan proposed a runsheet-cleanup block after `cleanupDuplicateLocalPlans`. Review determined it was a warning-log stub (`"For now, log a warning if the runsheet count > 1"`) rather than a real cleanup — it did not delete any duplicate runsheets. Change #1 prevents the duplicate runsheet at the source, making this cleanup unnecessary in the common case. A real `SessionActionLog.deleteDuplicateRunSheetsByPlanFile` method would be net-new API and is out of scope for this bugfix. **Removed.**

### 3. (Dropped) Remove dual `postMessage` in `createDraftPlanTicket` — removed from this plan

The original plan proposed removing `this._kanbanProvider?.postMessage?.({ type: 'planCreated' })` (TaskViewerProvider.ts:16713). Review determined this is a **UI message** that re-enables the "Add Plan" button in the standalone `kanban.html` panel (kanban.html:6582-6588) — it does **not** create runsheets or DB rows and is therefore unrelated to the duplicate-data bug. `KanbanProvider.postMessage` posts to `this._panel` (KanbanProvider.ts:1483-1490), the standalone kanban WebviewPanel, not project.html; removing it risks breaking that panel's button re-enable. If the dual postMessage is genuinely redundant UI work, it belongs in a separate UI-cleanup plan with its own verification. **Removed from this plan.**

## Verification Plan

### Automated Tests
No automated tests required for this change (per session directive, the test suite is run separately by the user). The change is a guard-set addition/deletion plus a timeout constant adjustment.

### Manual Verification
1. **Primary test:** Click CREATE in the Implementation tab, enter a title. Verify only ONE ticket appears in the runsheet dropdown. Check the kanban DB for duplicate entries:
   `sqlite3 .switchboard/kanban.db "SELECT plan_id, session_id, plan_file, workspace_id, kanban_column FROM plans WHERE plan_file LIKE '%<slug>%'"`
2. **Duplicate-key inspection (root-cause confirmation):** If duplicates still appear, dump the `plan_file` and `workspace_id` of every matching row. If the `plan_file` values differ (e.g. one absolute, one relative) or `workspace_id` values differ, the deeper cause is `_ensureRelativePlanFile` cold-start normalization (KanbanDatabase.ts:6252-6254) — track a follow-up plan to ensure `_workspaceRoot` is set before either watcher inserts.
3. **Rapid creation test:** Click CREATE, immediately click CREATE again with a different title. Verify two distinct tickets are created (no cross-contamination) — timestamped-unique filenames guarantee this.
4. **File watcher test (manual drop):** Manually copy a `.md` file into `.switchboard/plans/`. Verify the file watcher picks it up and creates exactly one runsheet/DB entry. This confirms the fix did not over-suppress the legitimate manual-drop path.
5. **Network drive test** (if available): Repeat the primary test on a network-mounted workspace. Verify no duplicates even with delayed file events (the 10s window covers typical network-drive event latency).
6. **Existing plans unaffected:** Verify that existing plans in the dropdown are not duplicated or removed after the fix.
7. **Compile check:** `npm run compile` — verify no TypeScript errors (run only when producing a VSIX; not required for dev testing per project build rules).

## Recommendation
Complexity 5 → **Send to Coder**.
