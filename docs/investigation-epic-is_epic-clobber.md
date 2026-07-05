# Investigation: `is_feature` Clobbered to 0 on Feature Creation

**Date:** 2025-07-05
**Status:** Root cause candidates identified, fix not yet written
**Symptom:** Press "GROUP INTO FEATURE" → feature file lands in `.switchboard/features/` → board shows it as a plain plan (is_feature=0 in DB) → ~15 min later self-heals to feature

---

## Architecture Summary

### Creation flow (all 3 entry points converge here)

1. **Kanban board button** → `kanban.html` sends `{ type: 'createFeature', subtaskPlanIds }` → `KanbanProvider` case `'createFeature'` (line 9008) → delegates to `createFeatureFromPlanIds()`
2. **Features tab "New Feature"** → `PlanningPanelProvider` case `'createFeature'` (line 3833) → delegates to `createFeatureFromPlanIds()`
3. **Agent CLI** → `create-feature.js` → `POST /kanban/feature` → `LocalApiServer._handleKanbanCreateFeature` (line 324) → `TaskViewerProvider.createFeature` callback (line 1012) → delegates to `createFeatureFromPlanIds()`

### `createFeatureFromPlanIds` timeline ([KanbanProvider.ts:10011](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L10011-L10199))

| Step | Line | Action | is_feature state |
|------|------|--------|--------------|
| 1 | 10097 | `upsertPlan({ isFeature: 1, ... })` | **SET to 1** |
| 2 | 10152 | `registerPendingCreation(featurePath)` — 10s watcher skip | — |
| 3 | 10153 | `writeFile(featurePath)` — triggers fs watcher (300ms debounce) | — |
| 4 | 10177 | `_regenerateFeatureFile()` → re-reads file, adds subtask list, writes again (with its own `registerPendingCreation` at 9974) | — |
| 5 | 10181 | `updateFeatureStatus(featurePlanId, 1, '')` | **RE-ASSERT to 1** |
| 6 | 10189 | `_markConfigDirty()` | — |
| 7 | 10190 | `_refreshBoard()` → `switchboard.refreshUI` → reads DB | Should read 1 |

### SQL guards protecting `is_feature`

Both `UPSERT_PLAN_SQL` ([KanbanDatabase.ts:640](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L640)) and `insertFileDerivedPlan` ([KanbanDatabase.ts:1465](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L1465)) have:

```sql
is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END
```

This means: on an ON CONFLICT upsert, if the incoming value is 0 (or NULL), keep the existing value. Only a **direct UPDATE** can set `is_feature = 0`.

### The ONLY function that does a direct UPDATE on `is_feature`

[`updateFeatureStatus`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L1630-L1658):
```sql
UPDATE plans SET is_feature = ?, feature_id = ?, updated_at = ?
WHERE plan_file = ? AND workspace_id = ?
```

---

## Clobber Vector Candidates

### ❶ The subtask-linking loop IN `createFeatureFromPlanIds` itself (HIGHEST SUSPICION)

[Line 10170](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L10170):
```typescript
const linkOk = await db.updateFeatureStatus(st.planId || st.sessionId, 0, effectiveFeaturePlanId);
```

This calls `updateFeatureStatus(subtaskPlanId, 0, featurePlanId)` for each subtask — setting `is_feature = 0` and `feature_id = featurePlanId`. The intent is to mark subtasks as non-feature children of the new feature.

**How this could clobber the feature:** `updateFeatureStatus` resolves the target by `planId` → looks up `plan_file` → then UPDATEs by `plan_file + workspace_id`. If there's a `planId` collision, stale lookup, or if `st.planId` is empty and `st.sessionId` matches the feature (unlikely with UUIDs but possible with empty strings), the UPDATE would hit the feature's row.

**Edge case to audit:** If a subtask's `planId` is empty/falsy, `st.planId || st.sessionId` falls through to `sessionId`. If `sessionId` is also empty, `getPlanByPlanId('')` could match something unexpected or return null (in which case `updateFeatureStatus` returns false — safe). But if it matched a plan with the same `plan_file` as the feature (through DB corruption or stale records), it would clobber.

### ❷ Timing race WITHIN `createFeatureFromPlanIds` (HIGHEST SUSPICION — "not created in time")

> **User note:** Linear/ClickUp sync services are NOT active in this environment. Remote sync vectors (RemoteControlService, ClickUpSyncService, LinearSyncService) are **ruled out** as the active clobber — though they remain worth hardening for users who do enable sync.

The creation flow in `createFeatureFromPlanIds` is a multi-step async sequence. Between step 1 (`upsertPlan` with `isFeature: 1`) and step 5 (`updateFeatureStatus` re-assert), several potentially slow operations run:

```
upsertPlan(isFeature:1)          ← DB row created with is_feature=1
registerPendingCreation(10s)   ← watcher suppression starts
writeFile(featurePath)            ← file hits disk, watcher event queued (suppressed)
  ↓ SLOW ZONE ↓
_ensureFeatureIntegrationWorktree / _provisionHighLowTierWorktrees  ← git operations
for (subtask of subtasks) {
    updateFeatureStatus(subtask, 0, featurePlanId)  ← marks each subtask
    _provisionSubtaskWorktreeIfNeeded         ← more git operations
}
_regenerateFeatureFile()          ← reads file, builds content, WRITES file again
                                  (sets its own registerPendingCreation at 9974)
  ↓ END SLOW ZONE ↓
updateFeatureStatus(featurePlanId, 1, '')  ← re-assert
_refreshBoard()
```

**The timing question:** If the SLOW ZONE takes longer than 10 seconds (worktree provisioning involves `git worktree add`, which can be slow on large repos), the FIRST `registerPendingCreation` expires. The file watcher event from the initial `writeFile` was already debounced and suppressed — but what if the native `fs.watch` fires a SECOND event for the same file (e.g., macOS FSEvents coalescing), or the periodic scan picks it up?

**Key sub-question: are `this._getKanbanDb()` and `KanbanDatabase.forWorkspace()` returning the same in-memory DB instance?** If the KanbanProvider and the GlobalPlanWatcherService hold different sql.js instances backed by the same on-disk file, their in-memory states can diverge. The watcher's `insertFileDerivedPlan` would write to ITS instance (which may not have the `is_feature=1` from `upsertPlan`), and then `_persist()` would flush the watcher's stale state to disk, overwriting the provider's writes. This would manifest as:

- `createFeatureFromPlanIds` writes `is_feature=1` to Provider's DB instance
- Watcher's `_handlePlanFile` reads its own DB instance where `is_feature=0` (stale)
- Watcher calls `insertFileDerivedPlan` which does a fresh INSERT (no ON CONFLICT because the row doesn't exist in THIS instance) with `is_feature=1` (for features dir)
- But then watcher's `_persist()` flushes to disk, potentially racing with Provider's persist

Actually, since both use `sql.js` (in-memory SQLite), if they are separate instances loaded from the same `.db` file, each instance has its own in-memory copy. Writes to one are invisible to the other until `_persist()` flushes and the other re-reads. **If the watcher instance persists a stale snapshot that doesn't include the Provider's `is_feature=1` write, the Provider's write is silently lost on the next load.**

**This is the most likely clobber mechanism if the DB instances are not shared.** Needs verification.

### ❸ PlanningPanelProvider — Features tab subtask operations (LOW SUSPICION)

[PlanningPanelProvider.ts:3781](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts#L3781):
```typescript
await db.updateFeatureStatus(subtask.planId, 0, feature.planId);  // addSubtaskToFeature
```

[PlanningPanelProvider.ts:3798](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts#L3798):
```typescript
await db.updateFeatureStatus(subtask.planId, 0, '');  // removeSubtaskFromFeature
```

These have guards (`!feature.isFeature` check, `subtask.isFeature` check), but they still run `updateFeatureStatus(subtaskPlanId, 0, ...)` — if the planId resolution is wrong, the feature gets clobbered.

### ❹ Backup restore drops `is_feature` (CONFIRMED DESIGN GAP, not the active clobber)

[KanbanDatabase.ts:5920-5927](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5920-L5927): The `exportStateToFile` SELECT does NOT include `is_feature`, `feature_id`, `project_id`, or `notion_page_id`. On restore ([line 5995-6033](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5995-L6033)), `record.isFeature` is `undefined` → `?? null` → NULL in SQL.

For an ON CONFLICT upsert: `NULL > 0` is FALSE → keeps old value. **Safe.**
For a fresh INSERT (cleared DB): `is_feature = NULL`. **LOSES feature state.**

This is a gap but requires a full DB clear + restore — unlikely to be the in-session clobber.

### ❺ Remote sync services (RULED OUT — not active)

`RemoteControlService._mirrorFeatureStructure`, `ClickUpSyncService`, `LinearSyncService` all have `updateFeatureStatus(planId, 0, ...)` calls that could theoretically clobber an feature. **However, user confirms these services are not enabled in this environment.** Still worth hardening for other users, but not the active bug.

---

## Why the self-heal takes ~15 minutes

The user correctly identified this: **no runtime path re-asserts `is_feature` from the file's directory location on board refresh.** The only healers are:

| Healer | Trigger | Timing |
|--------|---------|--------|
| File watcher `_handlePlanFile` | File change event | Only fires when the feature `.md` file is modified on disk |
| V37 migration | One-shot on DB open | Already ran, doesn't repeat |
| `regenerateAllFeatureFiles` | Extension startup (`setTimeout(3000)`) | One-time, 3s after startup — doesn't help mid-session |

The ~15 minute self-heal is likely the agent writing the `## How the Subtasks Achieve This` and `## Dependencies & sequencing` sections into the feature file (per the `group-into-features` SKILL.md step 5, lines 107-112). That file modification triggers the watcher, which calls `_handlePlanFile`, which hits the existing-plan path (line 617+) and calls `insertFileDerivedPlan(updatedRecord)` with `isFeature = 1` (line 638-639), followed by `updateFeatureStatus(planId, 1, '')` (line 649-650).

**Without that agent file write, the feature would stay clobbered indefinitely** until the next extension restart or manual file edit.

---

## Recommended Fix Strategy

> The user specified: "the fix is NOT to simply heal on refresh — the fix is to stop the clobber in the first place."

### Step 1: Instrument to identify the exact clobber

Add a **defensive log + stack trace** inside `updateFeatureStatus` when `isFeature = 0` and the target plan is currently `is_feature = 1`:

```typescript
public async updateFeatureStatus(planId: string, isFeature: number, featureId: string): Promise<boolean> {
    const plan = await this.getPlanByPlanId(planId);
    if (!plan) return false;
    // DIAGNOSTIC: catch the clobber in the act
    if (plan.isFeature === 1 && isFeature === 0) {
        console.error(`[KanbanDatabase] ⚠️ FEATURE CLOBBER: updateFeatureStatus(${planId}, 0, '${featureId}') would clear is_feature on feature "${plan.topic}" (plan_file=${plan.planFile}). Stack:`, new Error().stack);
    }
    ...
```

This will immediately reveal which caller is doing the clobber.

### Step 2: Harden `updateFeatureStatus` against accidental feature demotion

Add a guard that refuses to set `is_feature = 0` on a plan whose `plan_file` is in `.switchboard/features/`:

```typescript
// An feature file in .switchboard/features/ is structurally an feature.
// Refuse to clear is_feature for it — callers must move the file first (promoteToFeature does this).
if (isFeature === 0 && plan.isFeature === 1 && plan.planFile.startsWith('.switchboard/features/')) {
    console.warn(`[KanbanDatabase] updateFeatureStatus: refused to clear is_feature for feature-directory file ${plan.planFile}`);
    // Still allow setting feature_id (subtask linking) if the caller also wanted that
    if (featureId !== plan.featureId) {
        // only update feature_id, leave is_feature alone
        this._db.run('UPDATE plans SET feature_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [featureId, new Date().toISOString(), relativePlanFile, plan.workspaceId]);
        await this._persist();
    }
    return true; // report success — the intent (link subtask) was fulfilled
}
```

### Step 3: Fix the backup export/restore gap

Add `is_feature`, `feature_id`, `project_id` to the `exportStateToFile` SELECT at [KanbanDatabase.ts:5921-5926](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5921-L5926), and read them back in the restore at [line 5995-6022](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5995-L6022).

---

## Files Involved

| File | Relevance |
|------|-----------|
| [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts) | `createFeatureFromPlanIds` (L10011), `promoteToFeature` (L8939), `addSubtaskToFeature` (L8907), `_regenerateFeatureFile` (L9875) |
| [KanbanDatabase.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts) | `upsertPlan` (L1412), `insertFileDerivedPlan` (L1426), `updateFeatureStatus` (L1630), `UPSERT_PLAN_SQL` (L606), backup export (L5920), restore (L5950) |
| [GlobalPlanWatcherService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts) | `_handlePlanFile` (L444), `registerPendingCreation` (L42), periodic scan (L173) |
| [RemoteControlService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/RemoteControlService.ts) | `_mirrorFeatureStructure` (L524) — potential clobber via remote poll |
| [LocalApiServer.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts) | `_handleKanbanCreateFeature` (L324) |
| [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html) | Button handler (L10287), `postKanbanMessage` createFeature (L10339) |
| [create-feature.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/kanban_operations/create-feature.js) | Agent CLI entry point |

---

## Next Steps

1. **Deploy the diagnostic log** (Step 1) and reproduce the bug — the stack trace will name the exact caller.
2. **Implement the structural guard** (Step 2) in `updateFeatureStatus` to prevent `.switchboard/features/` files from being demoted.
3. **Fix the backup gap** (Step 3) so restore operations preserve feature state.
4. **(User decision)** Whether to also add a board-refresh healer as defense-in-depth, despite the user's preference to fix the clobber at the source. A cheap `plan_file LIKE '.switchboard/features/%' AND is_feature = 0` query on refresh would catch any future regressions without masking the root cause.
