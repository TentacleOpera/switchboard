# Add Kanban State Backup JSON for Database Rebuild

## Goal

Introduce a `.switchboard/kanban-state-backup.json` file that is updated on every kanban board mutation. This file captures the complete state of all active plans (including their columns, metadata, and relationships). It is **not** used for normal daily operations — it exists solely as a restore source when the user rebuilds the kanban database via the Setup panel's Database tab.

## Metadata

- **Tags:** backend, database, reliability, workflow
- **Complexity:** 5

## User Review Required

No — this is an internal resilience improvement with no product-level UX changes.

## Complexity Audit

### Routine
- Add `writeKanbanStateBackup()` to `KanbanDatabase.ts` that exports active plans to JSON.
- Wire backup write into existing `_persist()` or column-update paths (fire-and-forget).
- Modify `resetKanbanDb` in `extension.ts` to read backup JSON and repopulate columns before falling back to plan-file import.
- Update Setup panel Database tab copy to mention the backup behavior.

### Complex / Risky
- **Backup consistency during rapid moves:** The backup must be atomic (temp-file rename) to prevent file corruption. The backup write is fire-and-forget after `_persist()` completes, so it does not block subsequent DB writes. It may capture a slightly stale snapshot under extreme churn, which is acceptable for a best-effort disaster-recovery file.
- **Column restore vs. plan-file re-import:** If a plan file was deleted since the last backup, the backup may reference a missing file. The restore logic must gracefully skip stale entries and let the plan-file import handle whatever remains.

## Edge-Case & Dependency Audit

- **Race Conditions:** Backup writes are fire-and-forget inside `_persist()`. If the user triggers a rebuild while a backup write is in flight, the rebuild may read a partially-written file. Mitigation: use temp-file + atomic rename, and swallow read errors during rebuild (fallback to plan-file import).
- **Security:** The backup file lives in `.switchboard/` which is already workspace-local. No external input is written into it.
- **Side Effects:** The backup file is gitignored by default (`.switchboard/` is already ignored in most repos). If not, it should be added to `.gitignore` documentation.
- **Dependencies & Conflicts:** None. This is additive and does not change existing DB schema or APIs.

## Dependencies

None — this plan has no external blockers.

## Adversarial Synthesis

Key risks: (1) Backup writes are fire-and-forget and may capture partially updated DB state under extreme churn, though atomic temp-file rename prevents file corruption. (2) Restoring from a stale backup could re-insert plans whose files were deleted since the last backup; restore logic validates each entry against disk and skips missing files. (3) `importPlanFiles` naturally preserves restored `kanban_column` values because `kanban_column` is already excluded from the `DO UPDATE SET` clause in `UPSERT_PLAN_SQL`, so no additional SQL changes are required.

## Problem

When the kanban database is reset via Setup > Database > Rebuild Database, `resetKanbanDb` deletes `kanban.db` and re-imports all plans from `.switchboard/plans/*.md`. Because `importPlanFiles` defaults every plan to the `CREATED` column (`kanbanColumn = 'CREATED'`), the user loses all column assignments, dispatch state, tags, and dependencies. The existing `kanban-board.md` export is a human-readable markdown view — it does not contain machine-parseable metadata and is not consulted during rebuild.

## Root Cause

1. `PlanFileImporter.importPlanFiles` has no source of truth for column positions other than the plan files themselves, and plan files intentionally do not encode column state (the KanbanDatabase is the sole source of truth for that).
2. There is no durable, machine-readable snapshot of the DB's active-plan state outside of the binary `kanban.db` file.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

#### Add backup path helper

```typescript
private get _kanbanStateBackupPath(): string {
    return path.join(this._workspaceRoot, '.switchboard', 'kanban-state-backup.json');
}
```

#### Add backup writer

```typescript
private async _writeKanbanStateBackup(): Promise<void> {
    if (!this._workspaceRoot || !this._db) return;
    try {
        const workspaceId = await this.getWorkspaceId();
        if (!workspaceId) return;

        const stmt = this._db.prepare(
            `SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                    repo_scope, workspace_id, created_at, updated_at, last_action, source_type,
                    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                    clickup_task_id, linear_issue_id
             FROM plans WHERE workspace_id = ? AND status = 'active'`,
            [workspaceId]
        );
        const plans: any[] = [];
        while (stmt.step()) {
            plans.push(stmt.getAsObject());
        }
        stmt.free();

        const backup = {
            workspaceId,
            exportedAt: new Date().toISOString(),
            version: 1,
            plans
        };

        const tmpPath = this._kanbanStateBackupPath + '.tmp';
        await fs.promises.writeFile(tmpPath, JSON.stringify(backup, null, 2), 'utf8');
        await fs.promises.rename(tmpPath, this._kanbanStateBackupPath);
    } catch (error) {
        console.error('[KanbanDatabase] Failed to write kanban state backup:', error);
    }
}
```

#### Wire backup into `_persist()`

After the existing `void this.exportStateToFile();` line inside `_persist()`, add:

```typescript
void this._writeKanbanStateBackup();
```

Both are fire-and-forget; `_persist()` itself is already serialized via `_writeTail`.

#### Add restore-from-backup helper

```typescript
public async restoreFromBackup(backupPath: string): Promise<{ restored: number; skipped: number }> {
    if (!(await this.ensureReady()) || !this._db) return { restored: 0, skipped: 0 };

    if (!fs.existsSync(backupPath)) return { restored: 0, skipped: 0 };

    let backup: any;
    try {
        const raw = await fs.promises.readFile(backupPath, 'utf8');
        backup = JSON.parse(raw);
    } catch {
        return { restored: 0, skipped: 0 };
    }

    const plans = Array.isArray(backup.plans) ? backup.plans : [];
    if (plans.length === 0) return { restored: 0, skipped: 0 };

    let restored = 0;
    let skipped = 0;
    const workspaceId = await this.getWorkspaceId();
    const now = new Date().toISOString();

    for (const p of plans) {
        const planFile = p.plan_file || p.planFile || '';
        // Validate the plan file still exists on disk
        const absolutePath = planFile && !path.isAbsolute(planFile)
            ? path.join(this._workspaceRoot, planFile)
            : planFile;
        if (planFile && !fs.existsSync(absolutePath)) {
            skipped++;
            continue;
        }

        const record: KanbanPlanRecord = {
            planId: p.plan_id || p.planId || '',
            sessionId: p.session_id || p.sessionId || '',
            topic: p.topic || '',
            planFile: planFile.replace(/\\/g, '/'),
            kanbanColumn: p.kanban_column || p.kanbanColumn || 'CREATED',
            status: 'active',
            complexity: p.complexity || 'Unknown',
            tags: p.tags || '',
            dependencies: p.dependencies || '',
            repoScope: p.repo_scope || p.repoScope || '',
            workspaceId,
            createdAt: p.created_at || p.createdAt || now,
            updatedAt: now,
            lastAction: 'restored_from_backup',
            sourceType: p.source_type || p.sourceType || 'local',
            brainSourcePath: p.brain_source_path || p.brainSourcePath || '',
            mirrorPath: p.mirror_path || p.mirrorPath || '',
            routedTo: p.routed_to || p.routedTo || '',
            dispatchedAgent: p.dispatched_agent || p.dispatchedAgent || '',
            dispatchedIde: p.dispatched_ide || p.dispatchedIde || '',
            clickupTaskId: p.clickup_task_id || p.clickupTaskId || '',
            linearIssueId: p.linear_issue_id || p.linearIssueId || ''
        };

        try {
            this._db.run(UPSERT_PLAN_SQL, [
                record.planId, record.sessionId, record.topic, record.planFile, record.kanbanColumn,
                record.status, record.complexity, record.tags, record.dependencies, record.repoScope,
                record.workspaceId, record.createdAt, record.updatedAt, record.lastAction, record.sourceType,
                record.brainSourcePath, record.mirrorPath, record.routedTo, record.dispatchedAgent,
                record.dispatchedIde, record.clickupTaskId, record.linearIssueId
            ]);
            restored++;
        } catch (e) {
            console.error(`[KanbanDatabase] Failed to restore plan ${record.planFile}:`, e);
            skipped++;
        }
    }

    await this._persist();
    return { restored, skipped };
}
```

**Clarification:** Wrap the restore loop in `this._db.run('BEGIN')` / `this._db.run('COMMIT')` for bulk performance. Use `fs.promises.access(backupPath)` instead of `fs.existsSync` for async consistency.

### `src/extension.ts`

#### Modify `switchboard.resetKanbanDb`

After deleting the old DB file and before calling `importPlanFiles`, insert restore logic:

```typescript
// Inside resetKanbanDb command handler, after dbFilePath deletion
const db = KanbanDatabase.forWorkspace(workspaceRoot);
const backupPath = path.join(workspaceRoot, '.switchboard', 'kanban-state-backup.json');
let restoreResult: { restored: number; skipped: number } | null = null;

if (fs.existsSync(backupPath)) {
    try {
        await db.createIfMissing();
        restoreResult = await db.restoreFromBackup(backupPath);
    } catch (e) {
        console.error('[resetKanbanDb] Backup restore failed:', e);
    }
}

const importResult = await importPlanFiles(
    workspaceRoot,
    resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot
);
```

If `restoreResult` is non-null and `restored > 0`, the final toast message should say:
`Kanban database reset. Restored ${restoreResult.restored} plan(s) from backup, imported ${importResult.count} plan(s) from files.`

If `restoreResult` is null or `restored === 0`, keep the existing message.

**Important:** `importPlanFiles` must remain the final step so that any new plan files created since the last backup are still picked up. The existing `UPSERT_PLAN_SQL` already preserves `kanban_column`, `plan_id`, and `created_at` on conflict, so plans restored from backup will retain their original columns during re-import. New plan files not present in the backup will be inserted with `kanban_column = 'CREATED'` as expected.

### `src/webview/setup.html`

#### Update Database tab rebuild description

Change:
```
If the database is corrupted, this will delete and recreate it from your plan files in .switchboard/plans/.
```

To:
```
If the database is corrupted, this will delete and recreate it. If a <code>kanban-state-backup.json</code> exists, plan columns and metadata will be restored from it first; any new plan files in <code>.switchboard/plans/</code> will then be imported.
```

## Verification Plan

### Automated Tests

1. **Unit test for `_writeKanbanStateBackup`:** Mock `fs.promises.writeFile` and `fs.promises.rename`, verify that backup JSON is written with correct schema (`workspaceId`, `exportedAt`, `version: 1`, `plans` array) and only active plans are included.
2. **Unit test for `restoreFromBackup`:** Create a mock backup file with known plans (including one whose `plan_file` no longer exists on disk), call `restoreFromBackup`, assert that records are upserted into the DB, missing files are skipped, and `restored`/`skipped` counts are accurate.
3. **Integration test for `resetKanbanDb`:** Set up a workspace with plans in non-CREATED columns, trigger the reset command, verify that the rebuilt DB preserves column assignments and the toast reports accurate counts.
4. **Regression test for `UPSERT_PLAN_SQL` column preservation:** Insert a plan with `kanban_column = 'CODED'`, then run `importPlanFiles` for the same plan file, assert that `kanban_column` remains `'CODED'` and `plan_id` is unchanged.

## Validation

1. Move a plan to a non-CREATED column in the kanban board.
2. Verify `.switchboard/kanban-state-backup.json` is created/updated and contains the plan with the correct `kanban_column`.
3. Delete `kanban.db`.
4. Trigger Rebuild Database from Setup > Database.
5. Verify the rebuilt database has the plan in its original column (not CREATED).
6. Verify the toast message reports restored + imported counts accurately.
7. Delete a plan file, then rebuild. Verify the missing plan is skipped during restore and not re-imported.

---

**Recommendation:** Send to Coder.

---

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | `_writeKanbanStateBackup()` was NEVER wired into `_persist()` — the method existed but was dead code. Backup file would never be written. | CRITICAL | **FIXED** |
| 2 | `db.createIfMissing()` was NOT called before `restoreFromBackup()` in `resetKanbanDb` — after DB file deletion, `_initialize()` refuses to create a new DB, so `ensureReady()` returns false and restore always silently fails with `{ restored: 0, skipped: 0 }`. | CRITICAL | **FIXED** |
| 3 | Setup panel Database tab rebuild description was NOT updated — still said "Delete and recreate from plan files." instead of mentioning backup restore behavior. | MAJOR | **FIXED** |
| 4 | Confirmation dialog in `resetKanbanDb` still said "rebuild it from plan files" — misleading about actual rebuild flow. | NIT | **FIXED** |
| 5 | `dispose()` called `exportStateToFile()` but not `_writeKanbanStateBackup()` — final backup could be stale on deactivation. | NIT | **FIXED** |

### Stage 2: Balanced Synthesis

All 5 findings were fixed immediately. No findings deferred.

**What was correct in the implementation (kept as-is):**
- `_writeKanbanStateBackup()` method implementation: atomic temp-file rename, correct SQL query, only active plans, proper error handling.
- `restoreFromBackup()` method implementation: transaction wrapping (BEGIN/COMMIT), async `fs.promises.access()`, plan-file existence validation, graceful skip of missing files, correct `UPSERT_PLAN_SQL` usage.
- Toast message logic in extension.ts (conditional `restoredPart`).
- `UPSERT_PLAN_SQL` correctly preserves `kanban_column` on conflict (confirmed — `kanban_column` is NOT in the `DO UPDATE SET` clause).

### Code Fixes Applied

**File: `src/services/KanbanDatabase.ts`**
- Line 3730: Added `void this._writeKanbanStateBackup();` after `void this.exportStateToFile();` in `_persist()`.
- Line 866: Added `void this._writeKanbanStateBackup();` in `dispose()`.

**File: `src/extension.ts`**
- Line 1530: Added `await db.createIfMissing();` before `restoreResult = await db.restoreFromBackup(backupPath);` in `resetKanbanDb`.
- Line 1506: Updated confirmation dialog text to mention backup restore.

**File: `src/webview/setup.html`**
- Line 1151: Updated rebuild description to mention `kanban-state-backup.json` restore behavior.

### Validation Results

- **TypeScript compilation (`tsc --noEmit`):** No new errors introduced. Pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (unrelated import path issues) remain unchanged.
- **No test suite found** for kanban backup functionality (plan's Verification Plan section lists desired tests but they were not implemented as part of this plan).

### Remaining Risks

1. **No automated tests** for `_writeKanbanStateBackup` or `restoreFromBackup` — the plan's Verification Plan lists 4 desired test cases but none were implemented. Manual validation per the plan's Validation section is recommended.
2. **Fire-and-forget backup writes** under extreme churn may capture slightly stale snapshots — this is acceptable per the plan's Edge-Case audit but worth noting.
3. **Backup file not gitignored by default** — the plan notes `.switchboard/` is typically ignored, but if not, `kanban-state-backup.json` could leak workspace-internal metadata into git.
