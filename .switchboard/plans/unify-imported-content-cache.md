# Unify Imported Content Cache (Tickets + Docs → Single Registry)

## Problem

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

## Goal

A single DB registry covering both tickets and docs. Files remain the content storage. The DB is the index: workspace, remote ID, file path, sync metadata.

## Option A — Extend `imported_docs` with a `content_type` column

Add `content_type TEXT NOT NULL DEFAULT 'doc'` to `imported_docs`. Tickets written with `content_type = 'ticket'`. Query by `workspace_id AND content_type = 'ticket'` for the local cache list.

**Pros:** No new table. Existing `imported_docs` queries unaffected (all existing rows default to `'doc'`). Shared `import_sync_meta` table already tracks heal scans.

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

## Backend Changes

### `KanbanDatabase.ts`

- Add migration SQL above to the migrations array
- Add methods:
  - `upsertImportedTicket(workspaceId, slugPrefix, sourceId, remoteDocId, docName, filePath, contentHash)` — wraps `INSERT OR REPLACE INTO imported_docs (..., content_type) VALUES (..., 'ticket')`
  - `listImportedTickets(workspaceId)` — `SELECT * FROM imported_docs WHERE content_type = 'ticket' AND workspace_id = ?`
  - `getImportedTicket(workspaceId, slugPrefix)` — single row lookup
  - `deleteImportedTicket(workspaceId, slugPrefix)` — removes row (file deletion is caller's job)

### `PlanningPanelProvider.ts`

- `case 'listLocalTicketFiles'`: replace `_scanLocalTicketFiles` filesystem walk with `db.listImportedTickets(workspaceId)`. Falls back to filesystem scan if DB returns empty (for workspaces that existed before migration).
- `importAllTickets` / `importTaskAsDocument` completion: after writing the file, call `db.upsertImportedTicket(...)` with the file path and a hash of the content.
- `deleteTicketConfirmed`: after deleting the file, call `db.deleteImportedTicket(...)`.
- `_scanLocalTicketFiles`: keep as a one-time heal/backfill helper — scan files, upsert any missing DB rows, mark `last_synced_at`. Call it once on first `listLocalTicketFiles` if the DB is empty for that workspace.

### Heal scan

Reuse the existing `import_sync_meta` table. On `listLocalTicketFiles`, if `last_heal_scan_at` for the workspace is null or older than 24 hours, run the filesystem backfill scan and update `last_heal_scan_at`. This ensures tickets imported before the migration appear immediately.

## Frontend Changes

Minimal — the `localTicketFilesListed` message shape stays the same. The only change is the backend now returns DB rows instead of file-scanned objects. Each row already has `title` (stored as `doc_name`), `source_id` (the remote ticket ID), `file_path`, and `last_synced_at`.

The list cards can now show a staleness indicator: if `last_synced_at` is more than N days ago, show a subtle badge ("synced 5d ago").

## Implementation Order

1. Schema migration + `KanbanDatabase` methods
2. Backfill heal scan in `PlanningPanelProvider._scanLocalTicketFiles`
3. Wire `upsertImportedTicket` into `importTaskAsDocument` and `importAllTickets` completion handlers
4. Switch `listLocalTicketFiles` to DB query with filesystem fallback
5. Wire `deleteImportedTicket` into `deleteTicketConfirmed`
6. (Optional) Add `last_synced_at` staleness badge to ticket cards

## Out of Scope

- Conflict detection (`content_hash` comparison before push) — tracked separately
- Unifying doc and ticket import UI — separate concern
- Migrating kanban plans out of the `plans` table — different data model, not file-based
