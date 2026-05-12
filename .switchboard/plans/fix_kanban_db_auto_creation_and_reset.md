# Fix Kanban DB Auto-Creation and Reset Database Command

**sessionId:** `fix_kanban_db_auto_creation_and_reset`

**Created:** 2026-05-11

## Goal

Fix the `Switchboard: Reset Kanban Database` command so it works when `kanban.db` is missing. The `_initialize()` method intentionally does **not** auto-create the DB — this is by design. The bug is that the reset command deletes the old DB and then calls `importPlanFiles()`, which internally calls `ensureReady()` → `_initialize()`, which returns `false` when the file is absent. The reset command must explicitly create the DB before importing.

## Metadata

- **Tags:** bugfix, database, reliability
- **Complexity:** 3

## User Review Required

No — this is a single-file command handler fix with no architectural changes.

## Complexity Audit

### Routine
- Single change in `extension.ts` `resetKanbanDb` command handler.
- Calls an existing public method (`createIfMissing()`) that already handles directory validation, schema creation, and migrations.
- No changes to `_initialize()` or any core DB logic.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** `invalidateWorkspace()` nulls the cached instance and drains writes. A new `forWorkspace()` call afterwards creates a fresh instance. Safe.
- **Security:** No new security surface. `createIfMissing()` already has the directory traversal guard (line 799).
- **Side Effects:** `createIfMissing()` runs schema + migrations + `migrateFromJsonRegistry()` on empty DB. All are safe no-ops on a fresh DB.
- **Dependencies & Conflicts:** None.

## Dependencies

No plan dependencies.

## Adversarial Synthesis

Key risks: Calling `createIfMissing()` after `invalidateWorkspace()` but before `unlink()` could create the DB and then immediately delete it. Mitigation: The current code already calls `invalidateWorkspace()` before `unlink()`, so this ordering is safe. A second risk is that `createIfMissing()` could fail (permissions, disk full) and the command should surface this error instead of silently failing with a 0-import message. The fix must include an explicit `if (!created)` error path.

## Root Cause

The `_initialize()` method at lines 2350-2357 intentionally does **not** auto-create the DB:

```typescript
} else {
    // LAZY CHANGE: Don't create the DB file - just mark as unavailable
    KanbanDatabase._lastLoadedMtimes.delete(this._dbPath);
    this._loadedMtime = 0;
    this._db = null;
    this._lastInitError = 'Database file does not exist (not auto-creating)';
    console.log(`[KanbanDatabase] No DB exists at ${this._dbPath} - not creating`);
    return false;
}
```

This is by design — the DB should only be created explicitly via `createIfMissing()`.

**The actual bug:** The `resetKanbanDb` command (lines 1472–1515 in `extension.ts`) performs:
1. `KanbanDatabase.invalidateWorkspace(workspaceRoot)` — clears cached instance
2. `fs.promises.unlink(dbFilePath)` — deletes the file
3. `importPlanFiles(workspaceRoot, ...)` — calls `KanbanDatabase.forWorkspace()` → `ensureReady()` → `_initialize()`

Step 3 fails because `_initialize()` returns `false` when the file is missing. `importPlanFiles` then bails out with `{ count: 0 }`, leaving the user with an empty DB and a misleading success message.

**The fix:** After step 2 (deleting the file), explicitly call `createIfMissing()` on a fresh DB instance before step 3.

## Proposed Changes

### `src/extension.ts`

**Fix: Explicitly create the DB before importing (around line 1487)**

Current code:
```typescript
const db = KanbanDatabase.forWorkspace(workspaceRoot);
const dbFilePath = db.dbPath;

await KanbanDatabase.invalidateWorkspace(workspaceRoot);

try {
    if (fs.existsSync(dbFilePath)) {
        await fs.promises.unlink(dbFilePath);
    }
} catch (err) {
    vscode.window.showErrorMessage(`Failed to delete DB: ${err}`);
    return;
}

const importResult = await importPlanFiles(
    workspaceRoot,
    resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot
);
```

Replace the `importPlanFiles` call and everything after it with:

```typescript
// Explicitly create a new DB before importing plan files.
// _initialize() intentionally does NOT auto-create, so we must
// call createIfMissing() after deletion.
const newDb = KanbanDatabase.forWorkspace(workspaceRoot);
const created = await newDb.createIfMissing();
if (!created) {
    vscode.window.showErrorMessage(
        `Failed to create new Kanban database at ${newDb.dbPath}. Check permissions.`
    );
    return;
}

const importResult = await importPlanFiles(
    workspaceRoot,
    resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot
);
await vscode.commands.executeCommand('switchboard.fullSync');

// Trigger integration sync for imported plans
if (importResult.sessionIds.length > 0) {
    await vscode.commands.executeCommand('switchboard.syncImportedPlans', workspaceRoot, importResult);
}

vscode.window.showInformationMessage(
    `Kanban database reset. Imported ${importResult.count} plan(s) from .switchboard/plans/.`
);
```

**Why this works:**
- `invalidateWorkspace()` clears the stale instance and drains in-flight writes.
- `unlink()` removes the old file.
- `createIfMissing()` creates the new file, runs schema + migrations, and persists it.
- `importPlanFiles()` then calls `forWorkspace()` → `ensureReady()`, which finds the existing file and loads it normally.
- If `createIfMissing()` fails, the command surfaces an error and aborts before importing.

## Edge Cases

- **Directory traversal:** The parent directory guard in `createIfMissing()` (line 799) prevents creation outside `.switchboard`. No change needed.
- **Concurrent access:** `invalidateWorkspace()` drains the `_writeTail` before nulling `_db`. The new `forWorkspace()` call creates a fresh instance. Safe.
- **Migration version on new DB:** `createIfMissing()` runs `SCHEMA_SQL` then `_runMigrations()` (V2–V19). On empty DBs, migrations are idempotent no-ops. V19's DELETE is a no-op on 0 rows.
- **createIfMissing called when file already exists:** It is idempotent — if `this._db` is set or the file exists, it delegates to `ensureReady()`.

## Verification Plan

### Manual Tests

1. **Reset Database with existing DB:**
   - Ensure `.switchboard/kanban.db` exists with plans.
   - Run `Switchboard: Reset Kanban Database`.
   - Confirm: old DB deleted, new DB created, plans re-imported, no duplicates.

2. **Reset Database with missing DB:**
   - Delete `.switchboard/kanban.db`.
   - Run `Switchboard: Reset Kanban Database`.
   - Confirm: new DB created, plans imported, success message shown.

3. **Reset Database with permission failure (simulate):**
   - Make `.switchboard/` read-only.
   - Run `Switchboard: Reset Kanban Database`.
   - Confirm: user sees error message "Failed to create new Kanban database..." instead of silent failure.

### Automated Tests

- Add a unit test for `resetKanbanDb` command handler that mocks `fs.existsSync`, `fs.promises.unlink`, `KanbanDatabase.invalidateWorkspace`, `KanbanDatabase.forWorkspace().createIfMissing()`, and `importPlanFiles`.
- Assert that `createIfMissing()` is called before `importPlanFiles()`.
- Assert that when `createIfMissing()` returns `false`, the command shows an error and does not call `importPlanFiles`.

## Files to Change

1. `src/extension.ts` — insert explicit `createIfMissing()` call in `resetKanbanDb` command handler after `unlink()` and before `importPlanFiles()` (around line 1499).

## Acceptance Criteria

- [ ] The `Switchboard: Reset Kanban Database` command works when the DB file is missing
- [ ] The `Switchboard: Reset Kanban Database` command works when the DB file exists
- [ ] No plans are duplicated when running Reset Database
- [ ] When `createIfMissing()` fails, the command shows a clear error message and aborts

## Rollback

Remove the `createIfMissing()` call from the `resetKanbanDb` command handler. The command will revert to its current broken behavior when the DB is missing.

## Recommendation

**Send to Coder.** Complexity is 3 (routine single-file change). No architectural decisions required.
