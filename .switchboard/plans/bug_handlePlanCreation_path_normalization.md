# Fix _handlePlanCreation() Duplicate Plan Entries from Path Mismatch

## Goal
Eliminate spurious duplicate plan entries created in the `CREATED` kanban column when external tools edit existing plan files. The root cause is a path format mismatch — imported plans are stored with absolute paths in the DB, while the file watcher supplies relative paths to the dedup guard, causing the guard to always miss and create a new `sess_*` row.

## Metadata
**Tags:** backend, bugfix, database
**Complexity:** 3

## User Review Required
> [!NOTE]
> No schema changes. No migration required. The fix is a two-line fallback added to `_handlePlanCreation()` in `TaskViewerProvider.ts`. Existing DB entries with absolute paths will now be matched correctly. Existing entries already stored with relative paths are unaffected (the first lookup still succeeds for those).

## Problem Statement
`_handlePlanCreation()` is invoked by the `fs.watch` handler on every plan file change. Its DB-level dedup guard (lines 6061–6072) calls:

```typescript
const dbEntry = await db.getPlanByPlanFile(normalizedPlanFileRelative, workspaceId);
```

`normalizedPlanFileRelative` is always a **relative** path (e.g. `.switchboard/plans/foo.md`).

However, `PlanFileImporter.ts` (line 74) stores the plan with an **absolute** path (e.g. `/Users/pat/.../plans/foo.md`):

```typescript
const planFileNormalized = filePath.replace(/\\/g, '/');  // filePath is absolute
```

`getPlanByPlanFile()` runs `WHERE plan_file = ?` after only normalising backslashes — it never reconciles absolute vs. relative. The lookup returns `null`, dedup fails, and a duplicate row is inserted.

## Complexity Audit
### Routine
- **R1:** Add a two-line absolute-path fallback inside the existing `if (db)` block in `_handlePlanCreation()`.  No new functions, no schema changes, no interface changes.

### Complex / Risky
- **C1:** Determining `resolvedWorkspaceRoot` is already in scope; constructing the absolute path is deterministic. Risk: **none**.
- **C2:** The secondary dedup path (`log.findRunSheetByPlanFile` at lines 6053–6058) also uses `normalizedPlanFileRelative`. This operates on session log files in `.switchboard/sessions/`, not the DB. Session files are always written with relative paths (the watcher creates them), so this secondary guard is **not** affected by the same bug — it correctly skips files already in sessions. No change needed there.

## Edge-Case & Dependency Audit
- **Race Conditions:** `_handlePlanCreation()` is called sequentially per file event. The fallback lookup adds one additional synchronous DB read; no new concurrency surface.
- **Security:** Path construction uses `path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative)` — both values are already in scope and validated upstream. No injection risk.
- **Side Effects:** None. The fallback only prevents a premature `return`; it does not write to the DB.
- **Backward Compatibility:** Plans already stored with relative paths continue to match on the first lookup. Plans stored with absolute paths now match on the fallback. No existing rows are modified.
- **Dependencies & Conflicts:** `add_tags_and_dependencies_sync.md` also calls `getPlanByPlanFile(relativePath, wsId)` at its line 428 (in a separate sync context). That plan does not change the `getPlanByPlanFile` signature or its query logic, so there is no conflict. Our fix is isolated to the call site in `_handlePlanCreation()`.

## Adversarial Synthesis

### Grumpy Critique
*— Deep breath, cracking knuckles —*

Oh, wonderful. A "two-line fix." I've heard that before. Let me enumerate the ways this is still a festering wound after your "fix":

**1. WorkspaceId mismatch — you didn't even check this.** What if the plan was imported under a *different* `workspaceId` than what `this._workspaceId` resolves to at watcher time? `_getOrCreateWorkspaceId()` could generate a *new* UUID if the stored ID isn't in `localStorage` on this machine. Your fallback finds the right path but the wrong workspace and still returns `null`. Congratulations, you've fixed 60% of the bug.

**2. The `log.findRunSheetByPlanFile` secondary dedup path.** You casually wave it off as "not affected." Are you certain? What if a plan has a session file from a *previous* import run that used an absolute path prefix in the log metadata? You didn't check the log file schema. You're *assuming* it's fine.

**3. What about symlinks?** `resolvedWorkspaceRoot` is produced by `fs.realpath` somewhere upstream — but is it? If the workspace root has a symlink component and `filePath` from the importer was resolved differently, your `path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative)` absolute path won't match the absolute path stored by the importer. You've fixed the *common* case and left the edge case as a landmine.

**4. `path.join` on an already-absolute normalizedPlanFileRelative.** What if, in some code path, `normalizedPlanFileRelative` somehow already contains an absolute path? `path.join('/workspace', '/Users/foo/bar.md')` on Node = `/Users/foo/bar.md` (POSIX) — fine — but your `.replace(/\\/g, '/')` on the result still won't match a differently-rooted absolute path stored in the DB.

**5. You're adding a second DB round-trip on every single file-change event, even for plans that don't exist yet.** Every new plan creation now costs two DB reads instead of one. Performance? Probably fine. But it's still sloppier than fixing it at the right layer.

*This is a band-aid on a compound fracture.*

### Balanced Response
The Grumpy Engineer raises valid points; here's how each is addressed:

**On workspaceId mismatch (concern 1):** This is a real but orthogonal bug. The dedup failure being fixed here is specifically the *path* mismatch — the workspaceId was always consistent in the reported reproduction (same machine, single workspace). A separate plan should audit `_getOrCreateWorkspaceId()` idempotency. Fixing that here would expand scope from Complexity 3 to Complexity 6+.

**On the secondary `findRunSheetByPlanFile` path (concern 2):** Session log files are written by `_createRunSheet()` using `normalizedPlanFileRelative` (relative path), and are *read* with the same relative format. The importer does not write session log files — it only writes to `kanban.db`. This path is safe; the audit comment in the plan is accurate.

**On symlinks (concern 3):** `resolvedWorkspaceRoot` in `_handlePlanCreation()` is produced by `path.resolve(workspaceRoot)` (no `realpath`), and `PlanFileImporter` uses the same `workspaceRoot` value passed by the extension host. Symlink divergence is a pre-existing risk unrelated to this fix. Noted as a future audit item.

**On already-absolute `normalizedPlanFileRelative` (concern 4):** `planFileRelative` is always the output of `path.relative(resolvedWorkspaceRoot, uri.fsPath)` — it is definitionally relative. The `path.join` is safe.

**On the extra DB read (concern 5):** The second read only executes when the first returns `null`, i.e., when the plan is *not* found by relative path. For plans already stored as relative, this never fires. The overhead is one extra SQLite read on the rare path where dedup was already broken. Acceptable.

The fix is intentionally minimal. It is the least-invasive correct solution for the reported bug.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Single targeted change in `TaskViewerProvider.ts`. No DB schema changes. No changes to `KanbanDatabase.ts`.

### Target File: `src/services/TaskViewerProvider.ts`
#### MODIFY `src/services/TaskViewerProvider.ts` (lines 6061–6072)

- **Context:** The DB-level dedup guard only queries with `normalizedPlanFileRelative` (a relative path). Plans imported via `PlanFileImporter` are stored with absolute paths. Adding a second lookup with the absolute form of the same path closes the mismatch without touching the DB layer or query signatures.
- **Logic:**
  1. First lookup: use `normalizedPlanFileRelative` (relative path) — handles plans stored by the watcher or future imports that store relative paths.
  2. If `null`, construct the absolute path: `path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative).replace(/\\/g, '/')`.
  3. Second lookup: use the absolute path — handles plans stored by `PlanFileImporter` which stores `filePath` (absolute) directly.
  4. Combine results: if either lookup returns a record, treat as "already exists" and bail out.
- **Edge Cases Handled:**
  - Plans stored with absolute paths (imported) are now found by the fallback.
  - Plans stored with relative paths (watcher-created) are found by the first lookup as before.
  - `normalizedPlanFileRelative` is always relative (output of `path.relative()`), so `path.join` always produces a valid absolute path.

- **Implementation:** Replace lines 6061–6072 with:

```typescript
            // DB-level dedup: if kanban.db already knows about this plan, do not create a session file.
            // This prevents spurious file creation on machines that have the DB but not the session files.
            const db = await this._getKanbanDb(resolvedWorkspaceRoot);
            if (db) {
                const workspaceId = this._workspaceId || await this._getOrCreateWorkspaceId(resolvedWorkspaceRoot);

                // First try the relative path (format used by the file watcher).
                let dbEntry = await db.getPlanByPlanFile(normalizedPlanFileRelative, workspaceId);

                // Fallback: try the absolute path. PlanFileImporter stores plans with absolute paths
                // (e.g. `/Users/pat/.../plans/foo.md`), so the relative lookup above will miss them
                // and incorrectly allow a duplicate sess_* row to be created.
                if (!dbEntry) {
                    const absolutePlanFile = path.join(resolvedWorkspaceRoot, normalizedPlanFileRelative).replace(/\\/g, '/');
                    dbEntry = await db.getPlanByPlanFile(absolutePlanFile, workspaceId);
                }

                if (dbEntry) {
                    console.log(`[TaskViewerProvider] Plan already in DB (session: ${dbEntry.sessionId}), skipping file creation for: ${normalizedPlanFileRelative}`);
                    await this._syncFilesAndRefreshRunSheets(resolvedWorkspaceRoot);
                    return;
                }
            }
```

## Verification Plan
### Automated Tests
- Run existing unit tests for `_handlePlanCreation()` if present in `src/test/`.
- **Manual regression test:**
  1. Import a plan file so it is stored in `kanban.db` with an absolute `plan_file` path.
  2. Confirm the plan appears in a non-CREATED column.
  3. Edit the plan `.md` file externally (e.g., append a comment line).
  4. Verify no new `sess_*` row appears in `CREATED`; the existing row is unchanged.
  5. Verify `_syncFilesAndRefreshRunSheets` is called (board refreshes) without duplication.
- **Regression for existing relative-path plans:**
  1. Confirm plans already stored with relative paths still deduplicate correctly on file-change (first lookup succeeds, fallback is never reached).

### Cross-Plan Conflict Check
- **`add_tags_and_dependencies_sync.md`**: This plan modifies `KanbanDatabase.ts` (adds `dependencies` column, rewrites `PLAN_COLUMNS`, rewrites `getPlanByPlanFile` call sites). It calls `getPlanByPlanFile(relativePath, wsId)` at its line 428 — no signature change is proposed. Our fix is in `TaskViewerProvider.ts` only and does not touch `KanbanDatabase.ts`, so **no conflict**. If both plans land, the order of merge does not matter.

---
**Recommendation:** Send to Coder (Complexity 3 — single targeted change, no schema impact, no interface changes).
