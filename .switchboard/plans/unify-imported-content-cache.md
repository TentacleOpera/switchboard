# Unify Imported Content Cache (Tickets + Docs → Single Registry)

## Goal

Give locally-imported tickets the same SQLite registry that imported docs already have, so a single indexed table (`imported_docs`, extended with a `content_type` discriminator) is the source of truth for both. Files remain the content storage; the DB is the index: workspace, remote ID, file path, sync metadata.

### Background & Problem

Three different caching strategies exist for content imported from external sources:

| Surface | Source of truth | Index |
|---|---|---|
| Kanban plans | SQLite `plans` table | — (DB is authoritative) |
| Imported docs | File on disk | SQLite `imported_docs` table |
| Tickets (local) | File on disk | None — filesystem scan only |

Tickets and docs are the same shape: a file imported from an external source (ClickUp/Linear/Notion) with a known remote ID, needing sync metadata. Docs got a DB registry with `source_id`, `file_path`, `last_synced_at`, `content_hash`. Tickets got nothing — the file scan added in local-cache mode is a workaround.

Consequences of the gap:
- Ticket local-cache scan reads every `.md` file to extract title (slow at scale)
- No `last_synced_at` — can't tell a stale ticket from a fresh one
- No `content_hash` — can't detect conflicts before overwriting
- No indexed query by workspace — must walk directories
- Tickets and docs have separate import/sync code paths that diverge over time

### Root-Cause Analysis (from code inspection)

The `imported_docs` table and its read/heal paths were written **assuming every row is a doc**. Three call sites encode that assumption and must change before any ticket row is written, or ticket data will be silently corrupted/deleted:

1. `KanbanDatabase.getImportedDocs(workspaceId)` (`src/services/KanbanDatabase.ts:1771`) does `SELECT * FROM imported_docs WHERE workspace_id = ?` with **no type filter**. After tickets land, every doc-list consumer (`PlanningPanelCacheService.getImportedDocs`, `checkForDuplicate`) leaks ticket rows into the docs surface.
2. `KanbanDatabase.healImports()` (`src/services/KanbanDatabase.ts:1829`) scans only `.switchboard/docs`, then treats any `getImportedDocs()` row whose file is not in that flat dir as an **orphan to DELETE** (`removeImport`). Ticket files live in a configurable, nested `tickets/{provider}/{space}/{folder}/{list}/` tree, so the doc heal scan would delete every ticket row on its next run. **This is a data-loss bug, not cosmetic.**
3. `TaskViewerProvider.deleteTicket()` (`src/services/TaskViewerProvider.ts:17744`) only archives the **remote** ticket (`archiveIssue`/`archiveTask`); it does **not** delete the local `.md` file. The original plan's "after deleting the file" premise was incorrect.

## Metadata

- **Tags:** backend, database, refactor, reliability
- **Complexity:** 7
- **Repo:** switchboard

## User Review Required

_All items below resolved by the user (2026-06-17):_

- **Local file deletion on ticket delete — RESOLVED (delete the local file):** Archiving a remote ticket SHALL also delete the local cached `.md` and its registry row. The user can re-fetch if needed; no archived-state retention required. `deleteTicket` adds local file deletion + `deleteImportedTicket` to the delete flow (no longer gated).
- **Shared `imported_docs` table naming — RESOLVED (Option A):** Overload `imported_docs` with a `content_type` discriminator. The table name is internal/non-user-facing; a separate `imported_tickets` table is not worth the duplicated schema and second heal-scan path.
- **`content_hash` for tickets — RESOLVED (best-effort, no comparison):** Store a best-effort SHA-256 of the written file content on upsert for forward-compatibility, but do NOT compare it for change/conflict detection (conflict detection remains out of scope). The embedded `new Date().toISOString()` makes the hash non-deterministic; that is acceptable because the stored value is unused until the future conflict-detection work normalizes it.

## Complexity Audit

### Routine
- Adding a versioned `ALTER TABLE ... ADD COLUMN` migration following the existing V12–V32 pattern
- Adding `upsert/list/get/delete` CRUD methods mirroring existing `imported_docs` methods
- Switching `listLocalTicketFiles` from filesystem scan to a DB query with filesystem fallback

### Complex / Risky
- **Read-path contamination:** `getImportedDocs` and `healImports` must be type-scoped to `'doc'` *before* any ticket row exists, or ticket rows leak into doc surfaces and get deleted as orphans (data loss).
- **Heal-scan isolation:** docs and tickets currently share one `last_heal_scan_at` (`import_sync_meta` PK = `workspace_id`) plus the `kanban_meta` key `last_heal_scan_<workspaceId>`. Tickets need an independent throttle key so the two scans don't starve each other.
- **Write-site retargeting:** the actual file write (with title/content/filePath) is in `TaskViewerProvider.importTaskAsDocument`, not `PlanningPanelProvider.importAllTickets` (which only receives a count). Upserts must route through `PlanningPanelCacheService` for `workspaceId` consistency.
- **Backfill correctness:** pre-migration tickets have no DB row; the backfill heal scan must recurse the nested/configurable tickets dir (reuse `_scanLocalTicketFiles`) and upsert missing rows without clobbering `imported_at`.

## Edge-Case & Dependency Audit

- **Race Conditions:** Concurrent `importAllTickets` (parallel imports) issuing `upsertImportedTicket` for distinct slugs is safe (PK = `slug_prefix, workspace_id`, `INSERT OR REPLACE`). Backfill heal scan racing a live import must not overwrite a fresher `last_synced_at` — backfill should only insert rows that are *missing*, never overwrite existing ones.
- **Security:** No new external input; `file_path` is workspace-internal. Continue using parameterized statements (existing code already does). No path-traversal surface added.
- **Side Effects:** `getImportedDocs` gaining a `content_type='doc'` filter changes results for any caller that previously (pre-migration) would have seen only docs anyway — behavior preserved for docs, ticket rows correctly excluded. `healImports` scoping prevents accidental ticket-row deletion. Adding local file deletion to `deleteTicket` is a user-visible behavior change (see User Review).
- **Dependencies & Conflicts:** Touches `KanbanDatabase.ts` (schema + CRUD + heal), `PlanningPanelProvider.ts` (`listLocalTicketFiles`, `deleteTicketConfirmed`, backfill), `TaskViewerProvider.ts` (`importTaskAsDocument`, `importAllTasks` loop, `deleteTicket`), `PlanningPanelCacheService.ts` (ticket pass-through methods), and the planning webview (optional staleness badge). Migration must be **V33** (latest is V32) and version-gated like V19+.

## Dependencies

- None identified. (No prior `sess_XXXX` plans block this work.)

## Adversarial Synthesis

**Risk Summary:** The dangerous surface is the read side, not the migration: `getImportedDocs` and `healImports` assume every row is a doc, so without a `content_type='doc'` filter, ticket rows leak into doc lists and get deleted as orphans on the next doc heal (data loss). Secondary risks: writes must be wired in `TaskViewerProvider` (where content/filePath exist) not `PlanningPanelProvider`; `deleteTicket` doesn't currently delete the local file; and ticket heal must use an independent throttle key. **Mitigations:** type-scope all doc reads and the doc heal scan before writing any ticket row, retarget upserts through `PlanningPanelCacheService`, add local unlink to the ticket delete flow, and use `last_ticket_heal_scan_<workspaceId>`.

## Option A — Extend `imported_docs` with a `content_type` column

Add `content_type TEXT NOT NULL DEFAULT 'doc'` to `imported_docs`. Tickets written with `content_type = 'ticket'`. Query by `workspace_id AND content_type = 'ticket'` for the local cache list.

**Pros:** No new table. Existing `imported_docs` rows default to `'doc'`. Shared `import_sync_meta` table already tracks heal scans.

> **Clarification (correction to original "queries unaffected" claim):** Existing *rows* default to `'doc'`, but existing *queries* are NOT automatically safe. `getImportedDocs` and `healImports` select by `workspace_id` only and must be explicitly scoped to `content_type = 'doc'` (see Proposed Changes), or ticket rows contaminate doc lists and are deleted as orphans.

**Cons:** `imported_docs` name becomes a misnomer. `slug_prefix` is the PK — tickets use `{provider}_{id}` as their slug, which is fine.

## Option B — Separate `imported_tickets` table with same schema

Mirror the `imported_docs` schema but named `imported_tickets`. Parallel code paths.

**Pros:** Clean naming. No risk of touching doc queries.

**Cons:** Duplicates schema. Two heal-scan tables. Future consolidation still needed.

**Recommendation: Option A.** The schema already handles everything needed. A `content_type` discriminator column is a standard pattern. The `imported_docs` name is internal — it's not user-facing.

## Schema Migration

```sql
-- Migration: add content_type to imported_docs
ALTER TABLE imported_docs ADD COLUMN content_type TEXT NOT NULL DEFAULT 'doc';
CREATE INDEX IF NOT EXISTS idx_imported_docs_type ON imported_docs(content_type, workspace_id);
```

No data migration needed — existing rows default to `'doc'`.

> **Clarification — migration must be V33, version-gated.** The latest migration in `src/services/KanbanDatabase.ts` is **V32** (`MIGRATION_V32_SQL`, applied at ~line 4491). Add `MIGRATION_V33_SQL` with the two statements above and a version-gated block mirroring V26/V27 (add-only, idempotent):
>
> ```ts
> // V33: add content_type to imported_docs to unify ticket + doc registry
> const v33 = await this.getMigrationVersion();
> if (v33 < 33) {
>     for (const sql of MIGRATION_V33_SQL) {
>         try { this._db.exec(sql); } catch (e) {
>             const msg = e instanceof Error ? e.message : String(e);
>             if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
>                 console.warn('[KanbanDatabase] V33 migration step failed:', msg);
>             }
>         }
>     }
>     await this.setMigrationVersion(33);
>     console.log('[KanbanDatabase] V33 migration completed: content_type added to imported_docs');
> }
> ```

## Backend Changes

### `KanbanDatabase.ts`

- Add `MIGRATION_V33_SQL` + version-gated block (see Schema Migration above).
- Add methods:
  - `upsertImportedTicket(workspaceId, slugPrefix, sourceId, remoteDocId, docName, filePath, contentHash)` — wraps `INSERT OR REPLACE INTO imported_docs (..., content_type) VALUES (..., 'ticket')`
  - `listImportedTickets(workspaceId)` — `SELECT * FROM imported_docs WHERE content_type = 'ticket' AND workspace_id = ?`
  - `getImportedTicket(workspaceId, slugPrefix)` — single row lookup (`AND content_type = 'ticket'`)
  - `deleteImportedTicket(workspaceId, slugPrefix)` — removes row (file deletion is caller's job)
- **CRITICAL — scope existing doc reads to `content_type = 'doc'`** (correction added by review):
  - `getImportedDocs` (`KanbanDatabase.ts:1771`): add `AND content_type = 'doc'` to the `WHERE` clause so ticket rows never leak into doc lists / `checkForDuplicate`.
  - `getImportBySlug` (`KanbanDatabase.ts:1802`): callers expecting docs should pass/enforce `content_type = 'doc'`; tickets use `getImportedTicket`.
  - `healImports` (`KanbanDatabase.ts:1829`): it deletes any `getImportedDocs()` row whose file isn't in `.switchboard/docs`. Once `getImportedDocs` is doc-scoped this is safe; **verify** no ticket rows are visible to this scan.

### `TaskViewerProvider.ts` (where ticket files are actually written)

> **Clarification (correction to original plan, which targeted `PlanningPanelProvider`):** The file write with title/content/filePath happens in `TaskViewerProvider.importTaskAsDocument` (`:17306`), and `importAllTasks` (`:17690`) loops over it. `PlanningPanelProvider.importAllTickets`/`importTaskAsDocument` cases only forward `vscode.commands.executeCommand('switchboard.importAllTasks' | 'switchboard.importTaskAsDocument')` and receive a count/filePath, not content. Wire upserts here.

- `importTaskAsDocument`: after `fs.writeFileSync(filePath, content, 'utf8')` (`:17385`), call `this._getCacheService(resolvedRoot)` and upsert a ticket row with `slugPrefix = `${provider}_${id}``, `sourceId = provider`, `remoteDocId = id`, `docName = title`, `filePath`, and (best-effort) `contentHash`. Route through `PlanningPanelCacheService` so `_getEffectiveWorkspaceId` resolves the same `workspaceId` docs use.
- `deleteTicket` (`:17744`): currently archives the remote only. Add (a) delete the local `.md` (use `_findTicketDocument` to locate it, then `fs.promises.unlink`, ignoring ENOENT), and (b) `deleteImportedTicket(workspaceId, `${provider}_${id}`)`. **Confirmed by User Review** — archiving the remote deletes the local cache; the user can re-fetch.

### `PlanningPanelCacheService.ts`

- Add pass-through ticket methods mirroring `registerImport`/`getImportedDocs`: `registerImportedTicket(...)`, `getImportedTickets(workspaceId?)`, `deleteImportedTicket(slugPrefix, workspaceId?)`, each resolving `_getEffectiveWorkspaceId` and delegating to the new `KanbanDatabase` methods.

### `PlanningPanelProvider.ts`

- `case 'listLocalTicketFiles'` (`:3016`): replace the `_scanLocalTicketFiles` filesystem walk with `cacheService.getImportedTickets(workspaceId)`, mapping rows to the existing `{ id, title, status, filePath }` shape. **Fallback:** if the DB returns empty for that workspace, run the backfill scan (below) then re-query — and if still empty, fall back to the live filesystem scan (pre-migration workspaces).
- `deleteTicketConfirmed` (`:2970`): no change needed here if the delete + DB cleanup is centralized in `TaskViewerProvider.deleteTicket`; otherwise call `cacheService.deleteImportedTicket(...)` after the command returns success. (Document which path is chosen.)
- `_scanLocalTicketFiles` (`:5424`): keep as the backfill helper. Backfill upserts only **missing** rows (do not overwrite existing `imported_at`/`last_synced_at`).

### Heal scan / backfill throttle

> **Clarification (correction):** Do **not** reuse the doc `last_heal_scan_<workspaceId>` / `import_sync_meta.last_heal_scan_at` clock — docs and tickets would starve each other. Use a dedicated `kanban_meta` key `last_ticket_heal_scan_<workspaceId>`.

On `listLocalTicketFiles`, if `last_ticket_heal_scan_<workspaceId>` is null or older than 24 hours, recurse the configured tickets dir (reuse `_scanLocalTicketFiles` recursion over the nested `tickets/{provider}/...` tree), upsert any missing ticket rows, and stamp the key. This makes pre-migration tickets appear immediately on first list.

## Frontend Changes

Minimal — the `localTicketFilesListed` message shape stays the same. The only change is the backend now returns DB rows instead of file-scanned objects. Each row already has `title` (stored as `doc_name`), `source_id` (the remote ticket ID), `file_path`, and `last_synced_at`.

The list cards can now show a staleness indicator: if `last_synced_at` is more than N days ago, show a subtle badge ("synced 5d ago").

## Implementation Order

1. **V33 migration** (`MIGRATION_V33_SQL` + version-gated block) and **doc-read scoping** (`getImportedDocs`/`healImports` → `content_type = 'doc'`). Do this first so the read side is safe before any ticket row exists.
2. `KanbanDatabase` ticket CRUD methods (`upsertImportedTicket`, `listImportedTickets`, `getImportedTicket`, `deleteImportedTicket`).
3. `PlanningPanelCacheService` ticket pass-through methods.
4. Wire `upsertImportedTicket` into `TaskViewerProvider.importTaskAsDocument` (covers `importAllTasks` loop automatically).
5. Backfill heal scan + dedicated `last_ticket_heal_scan_<workspaceId>` throttle.
6. Switch `listLocalTicketFiles` to DB query with backfill + filesystem fallback.
7. Wire local file delete + `deleteImportedTicket` into `TaskViewerProvider.deleteTicket` (confirmed by User Review).
8. (Optional) Add `last_synced_at` staleness badge to ticket cards.

## Out of Scope

- Conflict detection (`content_hash` comparison before push) — tracked separately
- Unifying doc and ticket import UI — separate concern
- Migrating kanban plans out of the `plans` table — different data model, not file-based

## Proposed Changes

### `src/services/KanbanDatabase.ts`
- **Context:** Owns the `imported_docs` schema (`MIGRATION_V15_SQL`), migration runner (V12–V32), and doc CRUD (`registerImport`, `getImportedDocs`, `getImportBySlug`, `removeImport`, `healImports`).
- **Logic:** Add `content_type` discriminator (V33); add ticket-scoped CRUD; scope all doc reads to `content_type = 'doc'`.
- **Implementation:** `MIGRATION_V33_SQL` + version-gated block (see Schema Migration). New methods `upsertImportedTicket`/`listImportedTickets`/`getImportedTicket`/`deleteImportedTicket`. Add `AND content_type = 'doc'` to `getImportedDocs` (`:1771`) and ensure `healImports` (`:1829`) only sees doc rows.
- **Edge Cases:** Migration re-run idempotent (catch duplicate-column); pre-migration rows default to `'doc'`; ticket `slug_prefix = {provider}_{id}` collides safely under PK `(slug_prefix, workspace_id)`.

### `src/services/TaskViewerProvider.ts`
- **Context:** `importTaskAsDocument` (`:17306`) writes the ticket `.md`; `importAllTasks` (`:17690`) loops it; `deleteTicket` (`:17744`) archives the remote only.
- **Logic:** Persist a registry row on write; remove the row (and local file) on delete.
- **Implementation:** After `fs.writeFileSync` (`:17385`) call `_getCacheService(resolvedRoot).registerImportedTicket(...)`. In `deleteTicket`, locate via `_findTicketDocument`, `fs.promises.unlink`, then `deleteImportedTicket`.
- **Edge Cases:** Hash material includes an injected timestamp → store best-effort SHA-256 only, never compared (conflict detection out of scope). `workspaceId` resolved via `PlanningPanelCacheService._getEffectiveWorkspaceId` for parity with docs.

### `src/services/PlanningPanelCacheService.ts`
- **Context:** Thin DB facade used by providers; already exposes `registerImport`/`getImportedDocs` with `_getEffectiveWorkspaceId`.
- **Logic:** Mirror those for tickets.
- **Implementation:** `registerImportedTicket`, `getImportedTickets`, `deleteImportedTicket`.
- **Edge Cases:** Returns `[]` when `_kanbanDb` unavailable (matches existing doc behavior).

### `src/services/PlanningPanelProvider.ts`
- **Context:** `listLocalTicketFiles` (`:3016`) currently calls `_scanLocalTicketFiles` (`:5424`); `deleteTicketConfirmed` (`:2970`) forwards `switchboard.deleteTicket`.
- **Logic:** Serve list from DB with backfill + filesystem fallback; keep delete cleanup centralized in `TaskViewerProvider`.
- **Implementation:** Query `getImportedTickets`; run backfill on empty using a dedicated throttle key; map rows to the existing message shape.
- **Edge Cases:** Pre-migration workspaces (empty DB) must still list via filesystem; backfill must not overwrite existing rows.

### Frontend (`src/webview/planning.js`) — optional
- **Context:** Renders `localTicketFilesListed` cards; message shape unchanged.
- **Logic:** Optional staleness badge from `last_synced_at`.
- **Implementation:** Render "synced Nd ago" when `last_synced_at` older than N days.
- **Edge Cases:** Missing `last_synced_at` → no badge.

## Verification Plan

> Per session directive: do NOT run project compilation or the automated test suite in this pass. The tests below are specified for the implementer/user to run separately.

### Automated Tests
- **Migration:** V33 applies on a V32 DB; `content_type` column exists, defaults to `'doc'` for pre-existing rows; re-running `_initialize` is a no-op (idempotent).
- **Doc isolation (regression):** After inserting a `'ticket'` row, `getImportedDocs(ws)` returns only `'doc'` rows; `healImports` does NOT delete ticket rows when scanning `.switchboard/docs`.
- **Ticket CRUD:** `upsertImportedTicket` then `listImportedTickets`/`getImportedTicket` round-trips; `deleteImportedTicket` removes only the targeted ticket row.
- **Write wiring:** `importTaskAsDocument` produces both a file and a registry row with matching `filePath` and `slugPrefix = {provider}_{id}`.
- **List path:** `listLocalTicketFiles` returns DB rows when present; on empty DB it backfills from the filesystem then returns rows; throttle key `last_ticket_heal_scan_<ws>` prevents repeated scans within 24h.
- **Delete path:** `deleteTicket` archives remote, unlinks the local file (ENOENT tolerated), and removes the registry row.

### Manual / Smoke
- Import a ticket, confirm it appears instantly in the local list; restart and confirm it loads from DB (no filesystem walk).
- Pre-migration workspace with existing ticket files lists correctly on first open (backfill).

## Recommendation

**Complexity 7 → Send to Lead Coder.** Multi-file coordination (`KanbanDatabase`, `TaskViewerProvider`, `PlanningPanelCacheService`, `PlanningPanelProvider`, webview), a schema migration, and a genuine data-consistency risk (doc-read scoping must land before any ticket write to avoid orphan-deletion data loss) place this above routine/coder scope.
