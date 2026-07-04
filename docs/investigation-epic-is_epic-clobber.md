# Investigation: `is_epic` Clobbered to 0 on Epic Creation

**Date:** 2025-07-05
**Status:** Root cause candidates identified, fix not yet written
**Symptom:** Press "GROUP INTO EPIC" → epic file lands in `.switchboard/epics/` → board shows it as a plain plan (is_epic=0 in DB) → ~15 min later self-heals to epic

---

## Architecture Summary

### Creation flow (all 3 entry points converge here)

1. **Kanban board button** → `kanban.html` sends `{ type: 'createEpic', subtaskPlanIds }` → `KanbanProvider` case `'createEpic'` (line 9008) → delegates to `createEpicFromPlanIds()`
2. **Epics tab "New Epic"** → `PlanningPanelProvider` case `'createEpic'` (line 3833) → delegates to `createEpicFromPlanIds()`
3. **Agent CLI** → `create-epic.js` → `POST /kanban/epic` → `LocalApiServer._handleKanbanCreateEpic` (line 324) → `TaskViewerProvider.createEpic` callback (line 1012) → delegates to `createEpicFromPlanIds()`

### `createEpicFromPlanIds` timeline ([KanbanProvider.ts:10011](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L10011-L10199))

| Step | Line | Action | is_epic state |
|------|------|--------|--------------|
| 1 | 10097 | `upsertPlan({ isEpic: 1, ... })` | **SET to 1** |
| 2 | 10152 | `registerPendingCreation(epicPath)` — 10s watcher skip | — |
| 3 | 10153 | `writeFile(epicPath)` — triggers fs watcher (300ms debounce) | — |
| 4 | 10177 | `_regenerateEpicFile()` → re-reads file, adds subtask list, writes again (with its own `registerPendingCreation` at 9974) | — |
| 5 | 10181 | `updateEpicStatus(epicPlanId, 1, '')` | **RE-ASSERT to 1** |
| 6 | 10189 | `_markConfigDirty()` | — |
| 7 | 10190 | `_refreshBoard()` → `switchboard.refreshUI` → reads DB | Should read 1 |

### SQL guards protecting `is_epic`

Both `UPSERT_PLAN_SQL` ([KanbanDatabase.ts:640](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L640)) and `insertFileDerivedPlan` ([KanbanDatabase.ts:1465](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L1465)) have:

```sql
is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END
```

This means: on an ON CONFLICT upsert, if the incoming value is 0 (or NULL), keep the existing value. Only a **direct UPDATE** can set `is_epic = 0`.

### The ONLY function that does a direct UPDATE on `is_epic`

[`updateEpicStatus`](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L1630-L1658):
```sql
UPDATE plans SET is_epic = ?, epic_id = ?, updated_at = ?
WHERE plan_file = ? AND workspace_id = ?
```

---

## Clobber Vector Candidates

### ❶ The subtask-linking loop IN `createEpicFromPlanIds` itself (HIGHEST SUSPICION)

[Line 10170](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts#L10170):
```typescript
const linkOk = await db.updateEpicStatus(st.planId || st.sessionId, 0, effectiveEpicPlanId);
```

This calls `updateEpicStatus(subtaskPlanId, 0, epicPlanId)` for each subtask — setting `is_epic = 0` and `epic_id = epicPlanId`. The intent is to mark subtasks as non-epic children of the new epic.

**How this could clobber the epic:** `updateEpicStatus` resolves the target by `planId` → looks up `plan_file` → then UPDATEs by `plan_file + workspace_id`. If there's a `planId` collision, stale lookup, or if `st.planId` is empty and `st.sessionId` matches the epic (unlikely with UUIDs but possible with empty strings), the UPDATE would hit the epic's row.

**Edge case to audit:** If a subtask's `planId` is empty/falsy, `st.planId || st.sessionId` falls through to `sessionId`. If `sessionId` is also empty, `getPlanByPlanId('')` could match something unexpected or return null (in which case `updateEpicStatus` returns false — safe). But if it matched a plan with the same `plan_file` as the epic (through DB corruption or stale records), it would clobber.

### ❷ Timing race WITHIN `createEpicFromPlanIds` (HIGHEST SUSPICION — "not created in time")

> **User note:** Linear/ClickUp sync services are NOT active in this environment. Remote sync vectors (RemoteControlService, ClickUpSyncService, LinearSyncService) are **ruled out** as the active clobber — though they remain worth hardening for users who do enable sync.

The creation flow in `createEpicFromPlanIds` is a multi-step async sequence. Between step 1 (`upsertPlan` with `isEpic: 1`) and step 5 (`updateEpicStatus` re-assert), several potentially slow operations run:

```
upsertPlan(isEpic:1)          ← DB row created with is_epic=1
registerPendingCreation(10s)   ← watcher suppression starts
writeFile(epicPath)            ← file hits disk, watcher event queued (suppressed)
  ↓ SLOW ZONE ↓
_ensureEpicIntegrationWorktree / _provisionHighLowTierWorktrees  ← git operations
for (subtask of subtasks) {
    updateEpicStatus(subtask, 0, epicPlanId)  ← marks each subtask
    _provisionSubtaskWorktreeIfNeeded         ← more git operations
}
_regenerateEpicFile()          ← reads file, builds content, WRITES file again
                                  (sets its own registerPendingCreation at 9974)
  ↓ END SLOW ZONE ↓
updateEpicStatus(epicPlanId, 1, '')  ← re-assert
_refreshBoard()
```

**The timing question:** If the SLOW ZONE takes longer than 10 seconds (worktree provisioning involves `git worktree add`, which can be slow on large repos), the FIRST `registerPendingCreation` expires. The file watcher event from the initial `writeFile` was already debounced and suppressed — but what if the native `fs.watch` fires a SECOND event for the same file (e.g., macOS FSEvents coalescing), or the periodic scan picks it up?

**Key sub-question: are `this._getKanbanDb()` and `KanbanDatabase.forWorkspace()` returning the same in-memory DB instance?** If the KanbanProvider and the GlobalPlanWatcherService hold different sql.js instances backed by the same on-disk file, their in-memory states can diverge. The watcher's `insertFileDerivedPlan` would write to ITS instance (which may not have the `is_epic=1` from `upsertPlan`), and then `_persist()` would flush the watcher's stale state to disk, overwriting the provider's writes. This would manifest as:

- `createEpicFromPlanIds` writes `is_epic=1` to Provider's DB instance
- Watcher's `_handlePlanFile` reads its own DB instance where `is_epic=0` (stale)
- Watcher calls `insertFileDerivedPlan` which does a fresh INSERT (no ON CONFLICT because the row doesn't exist in THIS instance) with `is_epic=1` (for epics dir)
- But then watcher's `_persist()` flushes to disk, potentially racing with Provider's persist

Actually, since both use `sql.js` (in-memory SQLite), if they are separate instances loaded from the same `.db` file, each instance has its own in-memory copy. Writes to one are invisible to the other until `_persist()` flushes and the other re-reads. **If the watcher instance persists a stale snapshot that doesn't include the Provider's `is_epic=1` write, the Provider's write is silently lost on the next load.**

**This is the most likely clobber mechanism if the DB instances are not shared.** Needs verification.

### ❸ PlanningPanelProvider — Epics tab subtask operations (LOW SUSPICION)

[PlanningPanelProvider.ts:3781](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts#L3781):
```typescript
await db.updateEpicStatus(subtask.planId, 0, epic.planId);  // addSubtaskToEpic
```

[PlanningPanelProvider.ts:3798](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/PlanningPanelProvider.ts#L3798):
```typescript
await db.updateEpicStatus(subtask.planId, 0, '');  // removeSubtaskFromEpic
```

These have guards (`!epic.isEpic` check, `subtask.isEpic` check), but they still run `updateEpicStatus(subtaskPlanId, 0, ...)` — if the planId resolution is wrong, the epic gets clobbered.

### ❹ Backup restore drops `is_epic` (CONFIRMED DESIGN GAP, not the active clobber)

[KanbanDatabase.ts:5920-5927](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5920-L5927): The `exportStateToFile` SELECT does NOT include `is_epic`, `epic_id`, `project_id`, or `notion_page_id`. On restore ([line 5995-6033](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5995-L6033)), `record.isEpic` is `undefined` → `?? null` → NULL in SQL.

For an ON CONFLICT upsert: `NULL > 0` is FALSE → keeps old value. **Safe.**
For a fresh INSERT (cleared DB): `is_epic = NULL`. **LOSES epic state.**

This is a gap but requires a full DB clear + restore — unlikely to be the in-session clobber.

### ❺ Remote sync services (RULED OUT — not active)

`RemoteControlService._mirrorEpicStructure`, `ClickUpSyncService`, `LinearSyncService` all have `updateEpicStatus(planId, 0, ...)` calls that could theoretically clobber an epic. **However, user confirms these services are not enabled in this environment.** Still worth hardening for other users, but not the active bug.

---

## Why the self-heal takes ~15 minutes

The user correctly identified this: **no runtime path re-asserts `is_epic` from the file's directory location on board refresh.** The only healers are:

| Healer | Trigger | Timing |
|--------|---------|--------|
| File watcher `_handlePlanFile` | File change event | Only fires when the epic `.md` file is modified on disk |
| V37 migration | One-shot on DB open | Already ran, doesn't repeat |
| `regenerateAllEpicFiles` | Extension startup (`setTimeout(3000)`) | One-time, 3s after startup — doesn't help mid-session |

The ~15 minute self-heal is likely the agent writing the `## How the Subtasks Achieve This` and `## Dependencies & sequencing` sections into the epic file (per the `group-into-epics` SKILL.md step 5, lines 107-112). That file modification triggers the watcher, which calls `_handlePlanFile`, which hits the existing-plan path (line 617+) and calls `insertFileDerivedPlan(updatedRecord)` with `isEpic = 1` (line 638-639), followed by `updateEpicStatus(planId, 1, '')` (line 649-650).

**Without that agent file write, the epic would stay clobbered indefinitely** until the next extension restart or manual file edit.

---

## Recommended Fix Strategy

> The user specified: "the fix is NOT to simply heal on refresh — the fix is to stop the clobber in the first place."

### Step 1: Instrument to identify the exact clobber

Add a **defensive log + stack trace** inside `updateEpicStatus` when `isEpic = 0` and the target plan is currently `is_epic = 1`:

```typescript
public async updateEpicStatus(planId: string, isEpic: number, epicId: string): Promise<boolean> {
    const plan = await this.getPlanByPlanId(planId);
    if (!plan) return false;
    // DIAGNOSTIC: catch the clobber in the act
    if (plan.isEpic === 1 && isEpic === 0) {
        console.error(`[KanbanDatabase] ⚠️ EPIC CLOBBER: updateEpicStatus(${planId}, 0, '${epicId}') would clear is_epic on epic "${plan.topic}" (plan_file=${plan.planFile}). Stack:`, new Error().stack);
    }
    ...
```

This will immediately reveal which caller is doing the clobber.

### Step 2: Harden `updateEpicStatus` against accidental epic demotion

Add a guard that refuses to set `is_epic = 0` on a plan whose `plan_file` is in `.switchboard/epics/`:

```typescript
// An epic file in .switchboard/epics/ is structurally an epic.
// Refuse to clear is_epic for it — callers must move the file first (promoteToEpic does this).
if (isEpic === 0 && plan.isEpic === 1 && plan.planFile.startsWith('.switchboard/epics/')) {
    console.warn(`[KanbanDatabase] updateEpicStatus: refused to clear is_epic for epic-directory file ${plan.planFile}`);
    // Still allow setting epic_id (subtask linking) if the caller also wanted that
    if (epicId !== plan.epicId) {
        // only update epic_id, leave is_epic alone
        this._db.run('UPDATE plans SET epic_id = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?',
            [epicId, new Date().toISOString(), relativePlanFile, plan.workspaceId]);
        await this._persist();
    }
    return true; // report success — the intent (link subtask) was fulfilled
}
```

### Step 3: Fix the backup export/restore gap

Add `is_epic`, `epic_id`, `project_id` to the `exportStateToFile` SELECT at [KanbanDatabase.ts:5921-5926](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5921-L5926), and read them back in the restore at [line 5995-6022](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts#L5995-L6022).

---

## Files Involved

| File | Relevance |
|------|-----------|
| [KanbanProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts) | `createEpicFromPlanIds` (L10011), `promoteToEpic` (L8939), `addSubtaskToEpic` (L8907), `_regenerateEpicFile` (L9875) |
| [KanbanDatabase.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanDatabase.ts) | `upsertPlan` (L1412), `insertFileDerivedPlan` (L1426), `updateEpicStatus` (L1630), `UPSERT_PLAN_SQL` (L606), backup export (L5920), restore (L5950) |
| [GlobalPlanWatcherService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/GlobalPlanWatcherService.ts) | `_handlePlanFile` (L444), `registerPendingCreation` (L42), periodic scan (L173) |
| [RemoteControlService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/RemoteControlService.ts) | `_mirrorEpicStructure` (L524) — potential clobber via remote poll |
| [LocalApiServer.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts) | `_handleKanbanCreateEpic` (L324) |
| [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html) | Button handler (L10287), `postKanbanMessage` createEpic (L10339) |
| [create-epic.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/.agents/skills/kanban_operations/create-epic.js) | Agent CLI entry point |

---

## Next Steps

1. **Deploy the diagnostic log** (Step 1) and reproduce the bug — the stack trace will name the exact caller.
2. **Implement the structural guard** (Step 2) in `updateEpicStatus` to prevent `.switchboard/epics/` files from being demoted.
3. **Fix the backup gap** (Step 3) so restore operations preserve epic state.
4. **(User decision)** Whether to also add a board-refresh healer as defense-in-depth, despite the user's preference to fix the clobber at the source. A cheap `plan_file LIKE '.switchboard/epics/%' AND is_epic = 0` query on refresh would catch any future regressions without masking the root cause.
