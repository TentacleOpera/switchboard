# Fix: `imported_docs.file_path` stores absolute paths, inconsistent with the DB's relative-path convention

**Plan ID:** 8d2b3c4d-5e6f-7081-9202-234567890abc

## Goal

Make `imported_docs` (docs **and** tickets) store `file_path` **relative to the workspace root** and resolve it to absolute **at read time** using the DB instance's own `_workspaceRoot` — exactly the pattern `plans.plan_file` already uses. Add a V45 migration that rewrites existing absolute rows to relative. This eliminates an entire class of "wrong workspace root" ticket bugs at the source.

### Core problem

The "Link to ticket" button (and Save / Refine / Ask-agent) in the Planning **Tickets** tab intermittently reports **"No local files found … Click Refetch to import them first."** even though the files exist on disk and are visible in the sidebar. It "works one day, breaks the next" with no change to the user's files or workspace folders.

### Root cause analysis

Two defects, one shallow and one structural:

1. **Shallow (already fixed at read side):** `PlanningPanelProvider._findTicketFilePath()` (lines 1961-1982) ignored the DB and re-derived the file location by scanning `<resolvedRoot>/.switchboard/tickets/<provider>`. For the Tickets tab, `_resolveWorkspaceRoot()` has no explicit root to use, so it falls back to `_getWorkspaceRoot()`, which `extension.ts` (line ~907) wires to `kanbanProvider.getCurrentWorkspaceRoot()`. That value drifts with focus / board selection / multi-root ordering. When the Kanban board points at a workspace other than the one holding the tickets, the scan looks in the wrong folder → "no local file." With no `ticketSaveLocation` configured (the common case), that scan dir is the *only* place it looks.
   - **Fixed** in `_findTicketFilePath` by making it DB-first: look up `getImportBySlugPrefix(\`${provider}_${id}\`)` and return the recorded path when it exists on disk; fall back to a scan across **all** allowed roots (not just the board's current one). This matches how the sidebar resolves paths, so "if it shows in the sidebar, the button finds it."

2. **Structural (this plan):** `imported_docs.file_path` is stored **absolute** (`/Users/.../.switchboard/tickets/...`), while every other path column in the DB is stored **relative** and resolved at read time. `plans.plan_file` is `.switchboard/plans/foo.md` and `_readRows()` resolves it via `_resolveAbsolutePlanFile(this._workspaceRoot, …)`. The team deliberately migrated *toward* relative-in-DB: **V17** (lines 336-343) converted relative→absolute, then **V18** (lines 345-354) reversed it, establishing the invariant (KanbanDatabase.ts:350): *"all plan_file values in DB are relative; absolute only in memory after `_readRows()`."* `imported_docs` never adopted this.
   - **Why this is the true root cause:** the DB instance already knows its own workspace root deterministically (`this._workspaceRoot` = the folder `.switchboard/kanban.db` was opened from, set at construction time — `KanbanDatabase.ts:1213`). Had tickets resolved paths via that root — like plans do — defect #1 would have been *impossible*, because resolution would never have depended on the drifting "current Kanban board root." Absolute storage is also non-portable: bulk-copying `.switchboard/` to a different path (different username/machine) makes every stored path stale at once.

### Background context

- `imported_docs` is shared by imported **docs** (`content_type='doc'`) and imported **tickets** (`content_type='ticket'`). Both store absolute `file_path` today.
- This column shipped in released versions to **~4,000 installs**, so the storage-format change **requires a migration** — existing absolute rows must be rewritten to relative. Follow the V18 precedent exactly (sentinel column + guarded UPDATE inside `_runMigrations`' transaction). This is a real migration, not a clean break.
- Reusable primitives already exist on `KanbanDatabase`: `_ensureRelativePlanFile()` (write side, lines 6414-6450) and `_resolveAbsolutePlanFile()` (read side, lines 6382-6400). Both already do workspace-boundary checks. Both accept arbitrary paths (the `planFile` parameter name is a misnomer — the logic is generic path normalization). Reuse them; do not write new path logic.

## Metadata
- **Tags:** bug, backend, database, kanban, paths, migration, tickets, docs
- **Complexity:** 4

## User Review Required

No — all assumptions were verified during planning:
1. **DB-per-workspace model: CONFIRMED.** `KanbanProvider._getKanbanDb` (line 1535-1548) creates one `KanbanDatabase` instance per `resolvedRoot` (via `resolveEffectiveWorkspaceRoot`), cached in `_kanbanDbs`. `KanbanDatabase.forWorkspace(resolvedRoot)` binds `_workspaceRoot` at construction. One DB file = one filesystem root. A single DB file may hold rows for multiple `workspace_id` values, but they all share the same `_workspaceRoot` (child workspaces map to the parent's DB). The V45 migration relativizing against `this._workspaceRoot` is correct for all rows in that DB.
2. **`_resolveAbsolutePlanFile` idempotency: CONFIRMED SAFE.** Line 6385: `if (path.isAbsolute(normalized)) return normalized;` — the helper already short-circuits on absolute input. Legacy unconverted rows (outside workspace) resolve correctly. No guard needed.
3. **Live DB row count: VERIFIED.** `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db` has **161 absolute rows** (all rows are absolute — confirms the problem is total), across two `workspace_id` values (`038bffef-9842-4574-96a1-69a43a280b3c`, `64a73ddc0069`) sharing one filesystem root. The plan's earlier "157" was a slightly stale count; 161 is the current value.

## Complexity Audit

### Routine
- Routing `file_path` through `this._ensureRelativePlanFile(...)` in the four `imported_docs` writers
- Wrapping `String(row.file_path)` in `this._resolveAbsolutePlanFile(...)` in the three readers
- Adding a V45 migration modeled on V18 (sentinel column + guarded UPDATE)

### Complex / Risky
- **Sentinel column name collision with V18.** V18 added `needs_relative_conversion` to the `plans` table. Adding the same column name to `imported_docs` is technically fine (different table) but confuses grepping. Mitigation: use a distinct sentinel name `needs_file_path_relative` on `imported_docs`.
- **`migrateFromJsonRegistry` (line 3504) re-introducing absolute paths.** If this legacy JSON-import path can still fire after V45, it would insert absolute paths and re-break the invariant. Mitigation: relativize there too (defensive, harmless if the path is dead legacy).

## Edge-Case & Dependency Audit

- **Race Conditions:** The V45 migration runs inside the existing `_runMigrations` transaction (BEGIN/COMMIT with ROLLBACK on failure), matching the V43 precedent. Writers and readers are not concurrently migrated — the migration completes before any new write/read uses the relativized values.
- **Security:** All paths are parameter-bound; no external input flows into SQL. The `_ensureRelativePlanFile` boundary check prevents path traversal escaping the workspace on write.
- **Side Effects:**
  - Post-migration, `SELECT file_path FROM imported_docs` returns `.switchboard/tickets/...` relative values instead of `/Users/.../.switchboard/tickets/...`. Consumers (sidebar, `_findTicketFilePath`, `resolveImportedDocPath`, sync-status) keep receiving absolute paths in memory because the readers now resolve via `_resolveAbsolutePlanFile` — no downstream changes needed.
  - Rows whose absolute path is **outside** the workspace root are left absolute (the helper returns unchanged + warns). These remain readable as long as `_resolveAbsolutePlanFile` is idempotent on absolute input (see User Review Required #2).
  - `INSERT OR REPLACE` in `registerImport` (line 2200) resets the sentinel column to its DEFAULT (0) on replace — this is fine because the new row's `file_path` is already relativized at write time; the sentinel is only for the one-time migration.
- **Dependencies & Conflicts:**
  - **Writers to relativize (4):** `registerImport()` (line 2198-2218, binds `entry.filePath` at line 2211), `upsertImportedTicket()` (lines 2289-2331, binds `filePath` at line 2324 including the `ON CONFLICT ... file_path = excluded.file_path` path), `registerImportBatch()` (lines 2461-2489, binds `entry.filePath` at line 2482), `migrateFromJsonRegistry()` (lines 3504-3519, binds `item.filePath` at line 3515).
  - **Readers to resolve (3):** `getImportedDocs()` (lines 2231-2259, `filePath: String(row.file_path)` at line 2248), `getImportBySlug()` (lines 2262-2287, at line 2277), `listImportedTickets()` (lines 2336-2365, at line 2352).
  - **`PlanningPanelCacheService.ts`** (lines 435-439, 488-492) delegates `getImportBySlugPrefix`/`getImportedTickets` straight through to `KanbanDatabase` — no change needed; it passes through the now-resolved absolute paths.
  - **`PlanningPanelProvider._findTicketFilePath()`** (lines 1961-1982) — DB-first fix already landed; calls `getImportBySlugPrefix` and does `fs.existsSync(entry.filePath)`. After this plan, `entry.filePath` is resolved-to-absolute by the reader, so `fs.existsSync` continues to work. No change.
  - **Migration version assignment:** This plan uses **V45**. The sibling plan `fix-archived-plans-leave-ghost-kanban-column.md` uses **V44**. Both are part of the "Kanban DB Storage Consistency" epic and run sequentially in the same migration chain (V44 before V45). No version collision.
  - **`imported_docs` schema evolution:** Created in V15 (lines 305-319), `content_type` added in V33 (lines 562-566), `url` added in V40 (lines 266-272). Additive `ALTER TABLE` is the established pattern — adding `needs_file_path_relative` in V45 follows precedent.

## Dependencies

- None blocking. This plan is part of epic "Kanban DB Storage Consistency" alongside `fix-archived-plans-leave-ghost-kanban-column.md` (V44). The two migrations are independent data repairs; V45 is assigned to this plan to avoid version collision with V44.

## Adversarial Synthesis

Key risks: (1) `migrateFromJsonRegistry` could re-introduce absolute paths if still live; mitigated by relativizing there defensively. (2) Sentinel column name collision with V18's `needs_relative_conversion` on the `plans` table; mitigated by using the distinct name `needs_file_path_relative`. The two assumptions originally flagged (DB-per-workspace model, `_resolveAbsolutePlanFile` idempotency) were **verified during planning** — the helper short-circuits on absolute input at line 6385, and the DB-per-root model is confirmed via `KanbanProvider._getKanbanDb` (line 1535-1548).

## Approach

### 1. Write side — store relative

Route `file_path` through `this._ensureRelativePlanFile(...)` before it is written, in every `imported_docs` writer:

- `KanbanDatabase.registerImport()` (line 2198-2218) — bind `this._ensureRelativePlanFile(entry.filePath)` at line 2211 instead of `entry.filePath`.
- `KanbanDatabase.upsertImportedTicket()` (line 2289-2331) — bind `this._ensureRelativePlanFile(filePath)` at line 2324 (the relativized value flows into both the INSERT and the `ON CONFLICT ... file_path = excluded.file_path` path automatically since `excluded.file_path` references the same bound value).
- `KanbanDatabase.registerImportBatch()` (line 2461-2489) — bind `this._ensureRelativePlanFile(entry.filePath)` at line 2482.
- `KanbanDatabase.migrateFromJsonRegistry()` (line 3504-3519) — bind `this._ensureRelativePlanFile(item.filePath)` at line 3515. (Defensive — confirm whether this legacy path is still live; relativizing is harmless either way.)

### 2. Read side — resolve to absolute

Wrap `String(row.file_path)` in `this._resolveAbsolutePlanFile(...)` in every reader that returns `filePath`:

- `getImportedDocs()` (line 2248): `filePath: this._resolveAbsolutePlanFile(String(row.file_path))`
- `getImportBySlug()` (line 2277): `filePath: this._resolveAbsolutePlanFile(String(row.file_path))`
- `listImportedTickets()` (line 2352): `filePath: this._resolveAbsolutePlanFile(String(row.file_path))`

After this, all consumers (sidebar, `_findTicketFilePath`, `resolveImportedDocPath`, sync-status) keep receiving absolute paths in memory — no downstream changes needed. The DB-first read fix in `PlanningPanelProvider._findTicketFilePath` stays correct because `getImportBySlugPrefix` returns a now-resolved absolute path.

**Critical:** `_resolveAbsolutePlanFile` (lines 6382-6400) already short-circuits on absolute input at line 6385 (`if (path.isAbsolute(normalized)) return normalized;`). No guard is needed — legacy unconverted rows (those left absolute because they're outside the workspace root) resolve correctly.

### 3. Migration — absolute → relative (mirror V18, version V45)

Add `MIGRATION_V45_SQL` modeled on `MIGRATION_V18_SQL` (lines 345-354). Use a **distinct** sentinel name `needs_file_path_relative` to avoid grep confusion with the `plans` table's V18 `needs_relative_conversion` column:

```typescript
const MIGRATION_V45_SQL: string[] = [
    // Sentinel column: mark imported_docs rows whose file_path needs absolute→relative conversion.
    // Mirrors the V18 precedent for plans.plan_file. Distinct column name to avoid grep confusion
    // with the plans table's needs_relative_conversion (V18).
    `ALTER TABLE imported_docs ADD COLUMN needs_file_path_relative INTEGER DEFAULT 0`,
    // Pre-populate: mark any row whose file_path begins with '/' (absolute path).
    `UPDATE imported_docs SET needs_file_path_relative = 1 WHERE file_path LIKE '/%' AND file_path != ''`,
];
```

In the migration runner (after the V44 block), process each flagged row by stripping the workspace-root prefix via `_ensureRelativePlanFile()` against the DB's `_workspaceRoot`, then clear the sentinel:

```typescript
const v45 = await this.getMigrationVersion();
if (v45 < 45) {
    try {
        this._db.exec('BEGIN');
        for (const sql of MIGRATION_V45_SQL) {
            this._db.exec(sql);
        }
        // Process each flagged row: convert absolute → relative.
        const flagStmt = this._db.prepare(
            "SELECT slug_prefix, workspace_id, file_path FROM imported_docs WHERE needs_file_path_relative = 1"
        );
        let converted = 0;
        let skipped = 0;
        try {
            while (flagStmt.step()) {
                const row = flagStmt.getAsObject();
                const slugPrefix = String(row.slug_prefix);
                const wsId = String(row.workspace_id);
                const absPath = String(row.file_path);
                const relPath = this._ensureRelativePlanFile(absPath);
                if (relPath !== absPath) {
                    // Successfully relativized (inside workspace root).
                    this._db.run(
                        "UPDATE imported_docs SET file_path = ?, needs_file_path_relative = 0 WHERE slug_prefix = ? AND workspace_id = ?",
                        [relPath, slugPrefix, wsId]
                    );
                    converted++;
                } else {
                    // Path is outside workspace root — leave absolute, clear sentinel so we don't retry.
                    this._db.run(
                        "UPDATE imported_docs SET needs_file_path_relative = 0 WHERE slug_prefix = ? AND workspace_id = ?",
                        [slugPrefix, wsId]
                    );
                    skipped++;
                    console.warn(`[KanbanDatabase] V45: imported_docs row ${slugPrefix} has file_path outside workspace root, left absolute: ${absPath}`);
                }
            }
        } finally {
            flagStmt.free();
        }
        this._db.exec('COMMIT');
        await this.setMigrationVersion(45);
        console.log(`[KanbanDatabase] V45 migration completed: ${converted} imported_docs file_path(s) relativized, ${skipped} left absolute (outside workspace root)`);
    } catch (e) {
        try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] V45 migration FAILED — rolled back. DB unchanged. Error:', e);
    }
}
```

Rows whose absolute path is **outside** the workspace root are left absolute (the helper already returns unchanged + warns) so cross-workspace/edge rows are never corrupted. The sentinel is cleared for them so the migration doesn't retry on every launch. Preserve, don't drop.

### 4. Verify against the live DB

Use the real DB at `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db` (**verified: 161 absolute rows, all rows absolute, two workspace_ids `038bffef-9842-4574-96a1-69a43a280b3c` and `64a73ddc0069` sharing one filesystem root**) as the migration test fixture. Post-migration, `SELECT file_path FROM imported_docs` should return `.switchboard/tickets/...` relative values (except rows that legitimately live outside the workspace root), and the Tickets sidebar + Link button must still resolve every ticket.

## Files to change

- `src/services/KanbanDatabase.ts` — writers (relativize at lines 2211, 2324, 2482, 3515), readers (resolve at lines 2248, 2277, 2352), new V45 migration version + `needs_file_path_relative` sentinel column, and (if needed) an absolute-input guard in `_resolveAbsolutePlanFile` (line 6382).
- `src/services/PlanningPanelCacheService.ts` — no change expected (delegates to KanbanDatabase at lines 435-439, 488-492); confirm `getImportBySlugPrefix`/`getImportedTickets` pass through resolved paths.
- `src/services/PlanningPanelProvider.ts` — no change (DB-first `_findTicketFilePath` already landed at lines 1961-1982); confirm it still returns absolute.

## Verification Plan

> Per session directives: **no compilation, no automated tests.** Verification is manual/inspection-only.

### Automated Tests
- *(skipped per session directive — the user runs the test suite separately)*

### Manual Verification (inspection + DB queries)
1. **Pre-migration baseline:** `SELECT COUNT(*) FROM imported_docs WHERE file_path LIKE '/%'` → confirm the runtime row count (**verified at planning time: 161** for the Gitlab workspace DB).
2. **Post-migration relative paths:** `SELECT file_path FROM imported_docs` → returns `.switchboard/tickets/...` relative values, except rows outside the workspace root which remain absolute.
3. **Sentinel cleared:** `SELECT COUNT(*) FROM imported_docs WHERE needs_file_path_relative = 1` → returns 0 (all flagged rows processed).
4. **Tickets sidebar:** Lists every ticket; "Link to ticket", Save, Refine, and Ask-agent all resolve the file regardless of which workspace the Kanban board is currently pointed at.
5. **Workspace-switch invariance:** Switching the Kanban board's active workspace does **not** change whether a ticket's Link button works.
6. **Docs unaffected:** Existing docs (`content_type='doc'`) resolve identically to before (readers now resolve via `_resolveAbsolutePlanFile`, returning the same absolute in-memory path).
7. **Idempotency:** Re-running V45 (e.g. by resetting the migration version) is a no-op — the sentinel is 0 for all rows, so no conversion runs.
8. **Rollback:** If the migration fails mid-way, the transaction rolls back cleanly (BEGIN/COMMIT/ROLLBACK per V43 precedent); no partial conversion.
9. **Outside-workspace rows:** Any row whose absolute path is outside `_workspaceRoot` remains absolute and is still readable (verify `_resolveAbsolutePlanFile` returns it unchanged — this confirms the idempotency guard).
10. **New writes are relative:** Import a new ticket/doc → `SELECT file_path FROM imported_docs WHERE slug_prefix = '<new>'` → returns a relative path.

## Acceptance criteria

- [ ] `SELECT file_path FROM imported_docs` returns only relative paths (`.switchboard/...`) after migration, except rows that legitimately live outside the workspace root.
- [ ] Tickets sidebar lists every ticket; "Link to ticket", Save, Refine, and Ask-agent all resolve the file regardless of which workspace the Kanban board is currently pointed at.
- [ ] Switching the Kanban board's active workspace does **not** change whether a ticket's Link button works.
- [ ] Migration is idempotent and runs inside the existing `_runMigrations` transaction; a failure rolls back cleanly. No absolute→relative conversion drops or corrupts rows pointing outside the workspace.
- [ ] Existing docs (`content_type='doc'`) resolve identically to before.
- [ ] `_resolveAbsolutePlanFile` is confirmed idempotent on already-absolute input (legacy unconverted rows resolve correctly).

## Non-goals

- No change to `plans`, `worktrees`, or `stitch_*` path handling — already correct.
- No UI changes. This is a storage-format + resolution fix only.
- No per-row workspace-root resolution for shared-DB multi-workspace models (out of scope; flagged in Uncertain Assumptions).

## Uncertain Assumptions

None. All three assumptions originally flagged were verified during planning:
1. **DB-per-workspace model** — CONFIRMED via `KanbanProvider._getKanbanDb` (line 1535-1548): one `KanbanDatabase` per filesystem root; multiple `workspace_id` values in one DB share the same `_workspaceRoot`.
2. **`_resolveAbsolutePlanFile` idempotency** — CONFIRMED at line 6385: `if (path.isAbsolute(normalized)) return normalized;` short-circuits on absolute input.
3. **Live DB row count** — VERIFIED: 161 absolute rows (all rows absolute), two workspace_ids sharing one root.

No web research is needed for this plan.

## Recommendation

Complexity 4 → **Send to Coder** (multi-site writer/reader changes in a single file plus a sentinel-column migration; reuses existing helpers and the V18 precedent, but the idempotency and DB-per-workspace assumptions require careful verification during implementation).

## Review Findings

Reviewed commit `510daaf` against plan requirements. Implementation is complete and correct: all 4 writers (`registerImport` L2241, `upsertImportedTicket` L2354, `registerImportBatch` L2512, `migrateFromJsonRegistry` L3545) now bind `this._ensureRelativePlanFile(...)`; all 3 readers (`getImportedDocs` L2278, `getImportBySlug` L2307, `listImportedTickets` L2382) now wrap with `this._resolveAbsolutePlanFile(...)`; V45 migration adds `needs_file_path_relative` sentinel, converts absolute→relative inside the `_runMigrations` transaction, leaves outside-workspace rows absolute with sentinel cleared. Verified `_resolveAbsolutePlanFile` short-circuits on absolute input (L6497) and `_ensureRelativePlanFile` returns unchanged for outside-workspace paths (L6556-6561) — idempotency holds. No external raw-SQL consumers bypass the readers (all `imported_docs` queries confined to `KanbanDatabase.ts`). `getImportBySlugPrefix`/`getImportedTickets` in `PlanningPanelCacheService` delegate to the now-resolving readers, so `_findTicketFilePath` and `resolveImportedDocPath` receive absolute paths in memory unchanged. **No code fixes needed.** No compilation/tests run per session directives. Remaining risk: rows whose absolute path is outside `_workspaceRoot` stay absolute in DB (by design, readable via idempotent resolver).
