# Fix: `imported_docs.file_path` stores absolute paths, inconsistent with the DB's relative-path convention

## Goal

Make `imported_docs` (docs **and** tickets) store `file_path` **relative to the workspace root** and resolve it to absolute **at read time** using the DB instance's own `_workspaceRoot` — exactly the pattern `plans.plan_file` already uses. Add a migration that rewrites existing absolute rows to relative. This eliminates an entire class of "wrong workspace root" ticket bugs at the source.

### Core problem

The "Link to ticket" button (and Save / Refine / Ask-agent) in the Planning **Tickets** tab intermittently reports **"No local files found … Click Refetch to import them first."** even though the files exist on disk and are visible in the sidebar. It "works one day, breaks the next" with no change to the user's files or workspace folders.

### Root cause analysis

Two defects, one shallow and one structural:

1. **Shallow (already fixed at read side):** `PlanningPanelProvider._findTicketFilePath()` ignored the DB and re-derived the file location by scanning `<resolvedRoot>/.switchboard/tickets/<provider>`. For the Tickets tab, `_resolveWorkspaceRoot()` has no explicit root to use, so it falls back to `_getWorkspaceRoot()`, which `extension.ts` (line ~907) wires to `kanbanProvider.getCurrentWorkspaceRoot()`. That value drifts with focus / board selection / multi-root ordering. When the Kanban board points at a workspace other than the one holding the tickets, the scan looks in the wrong folder → "no local file." With no `ticketSaveLocation` configured (the common case), that scan dir is the *only* place it looks.
   - **Fixed** in `_findTicketFilePath` by making it DB-first: look up `getImportBySlugPrefix(\`${provider}_${id}\`)` and return the recorded path when it exists on disk; fall back to a scan across **all** allowed roots (not just the board's current one). This matches how the sidebar resolves paths, so "if it shows in the sidebar, the button finds it."

2. **Structural (this plan):** `imported_docs.file_path` is stored **absolute** (`/Users/.../.switchboard/tickets/...`), while every other path column in the DB is stored **relative** and resolved at read time. `plans.plan_file` is `.switchboard/plans/foo.md` and `_readRows()` resolves it via `_resolveAbsolutePlanFile(this._workspaceRoot, …)`. The team deliberately migrated *toward* relative-in-DB: **V17** converted relative→absolute, then **V18** reversed it, establishing the invariant (KanbanDatabase.ts:343): *"all plan_file values in DB are relative; absolute only in memory after `_readRows()`."* `imported_docs` never adopted this.
   - **Why this is the true root cause:** the DB instance already knows its own workspace root deterministically (`this._workspaceRoot` = the folder `.switchboard/kanban.db` was opened from). Had tickets resolved paths via that root — like plans do — defect #1 would have been *impossible*, because resolution would never have depended on the drifting "current Kanban board root." Absolute storage is also non-portable: bulk-copying `.switchboard/` to a different path (different username/machine) makes every stored path stale at once.

### Background context

- `imported_docs` is shared by imported **docs** (`content_type='doc'`) and imported **tickets** (`content_type='ticket'`). Both store absolute `file_path` today.
- This column shipped in released versions to **~4,000 installs**, so the storage-format change **requires a migration** — existing absolute rows must be rewritten to relative. Follow the V18 precedent exactly (sentinel column + guarded UPDATE inside `_runMigrations`' transaction). This is a real migration, not a clean break.
- Reusable primitives already exist on `KanbanDatabase`: `_ensureRelativePlanFile()` (write side) and `_resolveAbsolutePlanFile()` (read side). Both already do workspace-boundary checks. Reuse them; do not write new path logic.

## Approach

### 1. Write side — store relative

Route `file_path` through `this._ensureRelativePlanFile(...)` before it is written, in every `imported_docs` writer:

- `KanbanDatabase.registerImport()` (line ~2191)
- `KanbanDatabase.upsertImportedTicket()` (line ~2282) — including the `ON CONFLICT … file_path = excluded.file_path` path (bind the already-relativized value)
- The two other raw inserts at lines ~2467 and ~3500 (audit and confirm they target `imported_docs`; relativize consistently)

### 2. Read side — resolve to absolute

Wrap `String(row.file_path)` in `this._resolveAbsolutePlanFile(...)` in every reader that returns `filePath`:

- `getImportedDocs()` (line ~2241)
- `getImportBySlug()` (line ~2270)
- `listImportedTickets()` (line ~2345)

After this, all consumers (sidebar, `_findTicketFilePath`, `resolveImportedDocPath`, sync-status) keep receiving absolute paths in memory — no downstream changes needed. The DB-first read fix in `PlanningPanelProvider._findTicketFilePath` stays correct because `getImportBySlugPrefix` returns a now-resolved absolute path.

### 3. Migration — absolute → relative (mirror V18)

Add the next migration version (V-next) modeled on `MIGRATION_V18_SQL`:

- Add a sentinel column, e.g. `ALTER TABLE imported_docs ADD COLUMN needs_relative_conversion INTEGER DEFAULT 0`.
- Pre-populate: `UPDATE imported_docs SET needs_relative_conversion = 1 WHERE file_path LIKE '/%' AND file_path != ''`.
- In the migration runner (matching how V18 processes marked plan rows), for each flagged row strip the workspace-root prefix via `_ensureRelativePlanFile()` against the DB's `_workspaceRoot`, then clear the sentinel.
- Rows whose absolute path is **outside** the workspace root must be left absolute (the helper already returns unchanged + warns) so cross-workspace/edge rows are never corrupted. Preserve, don't drop.

### 4. Verify against the live DB

Use the real DB at `/Users/patrickvuleta/Documents/Gitlab/.switchboard/kanban.db` (157 absolute rows, workspace_id `64a73ddc0069`) as the migration test fixture. Post-migration, `SELECT file_path FROM imported_docs` should return `.switchboard/tickets/...` relative values, and the Tickets sidebar + Link button must still resolve every ticket.

## Files to change

- `src/services/KanbanDatabase.ts` — writers (relativize), readers (resolve), new migration version + sentinel column.
- `src/services/PlanningPanelCacheService.ts` — no change expected (delegates to KanbanDatabase); confirm `getImportBySlugPrefix`/`getImportedTickets` pass through resolved paths.
- `src/services/PlanningPanelProvider.ts` — no change (DB-first `_findTicketFilePath` already landed); confirm it still returns absolute.

## Acceptance criteria

- [ ] `SELECT file_path FROM imported_docs` returns only relative paths (`.switchboard/...`) after migration, except rows that legitimately live outside the workspace root.
- [ ] Tickets sidebar lists every ticket; "Link to ticket", Save, Refine, and Ask-agent all resolve the file regardless of which workspace the Kanban board is currently pointed at.
- [ ] Switching the Kanban board's active workspace does **not** change whether a ticket's Link button works.
- [ ] Migration is idempotent and runs inside the existing `_runMigrations` transaction; a failure rolls back cleanly. No absolute→relative conversion drops or corrupts rows pointing outside the workspace.
- [ ] Existing docs (`content_type='doc'`) resolve identically to before.

## Non-goals

- No change to `plans`, `worktrees`, or `stitch_*` path handling — already correct.
- No UI changes. This is a storage-format + resolution fix only.
