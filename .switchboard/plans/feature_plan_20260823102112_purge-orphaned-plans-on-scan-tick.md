# Reconcile Disk-vs-DB on Every Scan Tick — Clear Stranded Cards from Remote `git rm`

## Goal

Make `purgeOrphanedPlans` run on every periodic scan tick so that plan files deleted while no watcher was alive (remote `git rm`, machine off, etc.) are reconciled on the next local session instead of leaving stranded `active` cards on the board forever.

### Problem & background

When a plan file is deleted while the extension's file watcher is not running, the DB row stays `status='active'` indefinitely. The card remains on the board pointing at a file that no longer exists. This happens routinely with remote agents that `git rm` subtask files — the `improve-feature` protocol instructs them to do exactly this.

### Root cause

There are two deletion paths in the codebase, and neither covers the "file deleted while watcher was dead" case on a populated DB:

1. **Watcher path** (`PlanIngestionEngine._handlePlanDelete`, `:2141`): fires on a live `onDidDelete` event → `markPlanMissingByPlanFile` sets `status='missing'` → `runPurgeSweep` hard-deletes after 24h. **Only works if a watcher is alive at unlink time.**

2. **Disk-vs-DB reconciler** (`KanbanDatabase.purgeOrphanedPlans`, `:6100`): enumerates all `status='active'` rows, checks if their files exist on disk, tombstones the orphans after a 350ms confirmation delay. **This is exactly the right tool** — but its only caller is `_syncKanbanDbFromSheetsSnapshot` (`TaskViewerProvider.ts:5656`), which is only reached from `initializeKanbanDbOnStartup` when the DB is **empty** (`:5729-5732`). On a populated DB, the startup path explicitly skips the sync (`:5718-5720`: *"DB-first: DB already has data. Just run cleanup, do NOT re-sync from files."*).

3. **`runPurgeSweep`** (`PlanIngestionEngine.ts:888`): runs on startup and every scan tick (10s). But it only handles rows already in `status='missing'` — it calls `getMissingPlansOlderThan` and hard-deletes them. It does **not** scan for `active` rows whose files are missing. That detection is the watcher's job, and the watcher wasn't alive.

So: `purgeOrphanedPlans` is the right method, `runPurgeSweep` is the right call site, and the two have never been connected. The fix is one call.

---

## Metadata

**Complexity:** 3
**Tags:** backend, bugfix, reliability
**Project:** Browser Switchboard

---

## Complexity Audit

* **Score:** 3 / 10

### Routine

* Adding one method call inside an existing loop in `runPurgeSweep`.
* The method (`purgeOrphanedPlans`) already exists, is already tested (`plan-creation-status-regression.test.js:196`), and already handles the confirmation delay and error skipping.

### Complex / Risky

* **False-positive tombstoning during transient file operations.** `purgeOrphanedPlans` has a 350ms confirmation delay (`ORPHAN_PURGE_CONFIRMATION_DELAY_MS = 350`), which handles atomic-write temp+rename churn. But a `git pull` that temporarily removes and recreates files could take longer than 350ms. Mitigation: `runPurgeSweep` already skips when `isGitOpActive(folder)` is true (`:892-894`) — the git-operation guard covers this. The call must be placed **inside** that guard, not before it.
* **Blocking the scan tick for 350ms.** `purgeOrphanedPlans` has an `await delay(350)` inside it. On a workspace with many plans, the `fs.existsSync` loop also takes time. This is acceptable — the scan tick already does significant work (file scanning, activity-light sweeps, queue nudges) and is gated by `_scanInProgress`.

---

## Edge-Case & Dependency Audit

### Race Conditions

* **Git pull in progress:** `runPurgeSweep` already checks `isGitOpActive(folder)` at the top of the per-folder loop (`:892`) and `continue`s if true. The new call goes inside that guard, so it is skipped during git operations. No change needed.
* **File being rewritten (atomic save):** `purgeOrphanedPlans` re-checks `fs.existsSync` after the 350ms delay before tombstoning (`:6143`). If the file reappeared, it survives.
* **Watcher fires delete concurrently:** If the watcher detects the delete and calls `markPlanMissingByPlanFile` (setting `status='missing'`) while `purgeOrphanedPlans` is in its 350ms delay, `purgeOrphanedPlans` will find the row is no longer `status='active'` on the second check — the `UPDATE ... WHERE status = 'active'` in the tombstone step won't match it. No conflict.

### Security

* None. The method only tombstones plans whose files are already gone.

### Side Effects

* Plans tombstoned by `purgeOrphanedPlans` get `status='deleted'` (not `status='missing'`). This is a direct tombstone, bypassing the 24h grace period that the watcher path uses. This is correct for the orphan case — the file has been gone for an unknown time (possibly days), not for a few seconds. The 350ms confirmation delay handles the transient case.
* Tombstoned plans are excluded from the board immediately (`getPlansByColumn` renders `status='active'` only, `KanbanDatabase.ts:4119`).
* External tracker sync (ClickUp/Linear/Notion) is **not** triggered by `purgeOrphanedPlans`. The existing `runPurgeSweep` handles external archive for `status='missing'` plans (`:904-944`). Plans tombstoned directly to `deleted` by `purgeOrphanedPlans` skip that. This is a minor gap — if the orphaned plan had a ClickUp/Linear/Notion link, the external task won't be archived. Acceptable for now: the primary goal is clearing the board, and the external task can be cleaned up by a later reconciliation. Documented as a follow-up at the bottom.

### Dependencies & Conflicts

* **`PlanIngestionEngine.runPurgeSweep`** (`:888-961`) — the call site. Already iterates watched roots, already gets the DB and workspaceId, already has the git-operation guard.
* **`KanbanDatabase.purgeOrphanedPlans`** (`:6100-6160`) — the method to call. Signature: `(workspaceId: string, resolvePath: (planFile: string) => string) => Promise<number>`.
* **`TaskViewerProvider._syncKanbanDbFromSheetsSnapshot`** (`:5656`) — existing caller, unchanged. Still used for empty-DB bootstrap.
* No source changes outside `PlanIngestionEngine.ts`.

---

## Proposed Changes

### `src/services/PlanIngestionEngine.ts`

**Context:** `runPurgeSweep` (`:888-961`) iterates watched folders. For each folder, it skips if `isGitOpActive`, gets the DB and workspaceId, then purges `status='missing'` plans older than 24h. The new call goes after the missing-plan purge loop, still inside the per-folder loop and inside the git-operation guard.

**After line 956** (after the `for (const plan of missingPlans)` loop closes, before the per-folder loop closes at `:957`), add:

```typescript
                // Reconcile disk vs DB: tombstone active plans whose files are
                // gone. This catches deletions that happened while no watcher
                // was alive (remote git rm, machine off, etc.) — the watcher
                // path only fires on a live onDidDelete event, so without this
                // check the row stays active forever on a populated DB.
                try {
                    const orphans = await db.purgeOrphanedPlans(workspaceId, (planFile: string) => {
                        return path.resolve(folder, planFile);
                    });
                    if (orphans > 0) {
                        this._host.logger.appendLine(`[GlobalPlanWatcher] Tombstoned ${orphans} orphaned plan(s) in ${folder}`);
                    }
                } catch (orphanErr) {
                    this._host.logger.appendLine(`[GlobalPlanWatcher] Orphan reconciliation failed for ${folder}: ${orphanErr}`);
                }
```

**No other file changes.** `purgeOrphanedPlans` already exists on `KanbanDatabase` and is already tested. The `path` import is already present at the top of `PlanIngestionEngine.ts`.

---

## Verification Plan

### Automated Tests

1. **Existing test still passes:** `src/test/plan-creation-status-regression.test.js` (`:196`) directly tests `purgeOrphanedPlans` — verify it still passes unchanged.

2. **New test — orphan reconciliation via purge sweep:** Add a test to `src/services/__tests__/PlanIngestionEngine.test.ts` (or the headless regression test file if that suite is more appropriate) that:
   - Seeds a DB with an `active` plan whose `plan_file` points to a non-existent file.
   - Calls `runPurgeSweep()`.
   - Asserts the plan's status is now `'deleted'` (tombstoned).
   - Seeds a second `active` plan whose file **does** exist.
   - Calls `runPurgeSweep()` again.
   - Asserts the existing plan is still `active`.

3. **Git-operation guard test:** Verify that when `isGitOpActive(folder)` returns `true`, `purgeOrphanedPlans` is not called (the folder is skipped entirely).

### Static checks

1. `npm run compile` — typecheck the new call against `purgeOrphanedPlans`'s signature.
2. `grep -n "purgeOrphanedPlans" src/services/PlanIngestionEngine.ts` — confirm the call is present.
3. `grep -n "purgeOrphanedPlans" src/services/TaskViewerProvider.ts` — confirm the existing caller is unchanged.

### Manual verification

1. Start the extension on a workspace with an existing populated DB.
2. Stop the extension (close VS Code).
3. `rm` a plan file from `.switchboard/plans/` (simulating a remote `git rm`).
4. Restart the extension.
5. Within ~10 seconds (one scan tick), the card should disappear from the board.
6. Check the DB: the plan's status should be `'deleted'`.

---

## Recommendation

Complexity 3 → **Send to Intern.** One method call in an existing loop, using an existing tested method. The git-operation guard and confirmation delay are already in place.

**Follow-up, not in scope:** `purgeOrphanedPlans` tombstones directly to `status='deleted'`, bypassing the external-tracker archival that `runPurgeSweep` does for `status='missing'` plans (ClickUp/Linear/Notion archive at `:904-944`). If an orphaned plan has external tracker links, they won't be archived. A future plan could either (a) have `purgeOrphanedPlans` set `status='missing'` instead of `'deleted'` so the existing 24h purge pipeline handles external archival, or (b) add external archival calls to the orphan reconciliation step. Low priority — the primary value is clearing the board.

**Migration:** none. No state format change, no settings change. Existing `active` plans with missing files will be tombstoned on the first scan tick after the fix lands — which is the desired behavior.
