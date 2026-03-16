# Make sqlite db actually useful

## Notebook Plan

The sqlite migration was apparently done, but the agent lied. This needs to be fixed.

[Investigate Kanban Complexity and Potential to Move to SQLite Database System](file:///c%3A/Users/patvu/Documents/GitHub/switchboard/.switchboard/plans/feature_plan_20260316_092117_investigate_kanban_complexity_and_potential_to_move_to_sqlite_database_system.md)

here is a summary:

You're right: this is not a true DB-backed Kanban. It's a partial migration with fallback, so "fully
  implemented database system" is inaccurate.

  Evidence: get_kanban_state first tries DB (src\mcp-server\register-tools.js:1968) but immediately falls back to
  derived file-state if DB is missing/unreadable (:1973-1975, :2041). In this workspace, .switchboard\kanban.db
  does not exist. Also, DB rows are populated from derived events (src\services\TaskViewerProvider.ts:583, :4072
  ), so DB is currently a mirror/cache, not source-of-truth.

  To do this properly: make DB authoritative, remove/strictly gate fallback, write columns directly on workflow
  transitions, and fail CI if DB path isn't active.

## Goal
- Make the SQLite database the **authoritative source of truth** for kanban board state, rather than a mirror/cache of file-derived state.
- Remove or strictly gate the fallback to file-based state derivation so the DB is always used when available.
- Ensure the DB is automatically created and bootstrapped on first use (no manual setup required).
- All column transitions (drag-drop, autoban, CLI triggers, manual moves) must write directly to the DB.

## Current Architecture (Problem Statement)

The current flow works like this:
1. `KanbanProvider._refreshBoard()` (line ~205) derives card state from runsheet JSON files via `deriveKanbanColumn()`.
2. It then calls `KanbanMigration.bootstrapAndSync()` which upserts the derived state into the DB.
3. If DB is ready, it reads back from DB. If not, it uses the file-derived state.
4. **Problem**: The DB is always overwritten by file-derived state on every refresh. It's never independently authoritative. Column moves in the DB are clobbered by the next refresh cycle.
5. `get_kanban_state` MCP tool also falls back to file state if DB is unavailable.

## Dependencies
- **KanbanDatabase.ts**: Already has the schema, upsert, and query methods. Needs no schema changes for core work.
- **KanbanMigration.ts**: Currently does a full overwrite on every sync. Must be changed to only bootstrap once, then respect DB state.
- **KanbanProvider.ts**: Main consumer. Must switch from "derive then sync" to "read from DB, bootstrap only if DB is empty".
- **TaskViewerProvider.ts**: Also reads kanban state for autoban and sidebar. Must use DB-first reads.
- **register-tools.js**: MCP `get_kanban_state` tool. Must use DB as primary source.
- **kanbanColumnDerivation.ts/.js**: Still needed for initial bootstrap (deriving column from runsheet events for plans that predate the DB). After bootstrap, DB is authoritative.
- **"Add edit metadata to review button"** (sess_1773605360670) — that plan's manual column override feature depends on DB being authoritative. This plan should be implemented first.

## Proposed Changes

### Step 1 — Make KanbanMigration bootstrap-only (Complex)
- **File**: `src/services/KanbanMigration.ts`
- Change `bootstrapAndSync` to `bootstrapIfNeeded`:
  - Check if the DB already has active plans for this workspace (`db.getBoard(workspaceId).length > 0`).
  - If DB is empty (first run or new workspace): perform the full file-derived bootstrap (current behavior).
  - If DB already has data: **skip the upsert entirely**. The DB is authoritative.
- Add a separate method `syncNewPlansOnly(db, workspaceId, snapshotRows)` that only inserts plans that exist in the file system but are **not yet in the DB** (new plans created since last sync). This handles new plan creation without clobbering existing DB state.
- Archive plans that no longer exist on disk (existing `markMissingAsArchived` logic is fine).

### Step 2 — Update KanbanProvider._refreshBoard to be DB-first (Complex)
- **File**: `src/services/KanbanProvider.ts`
- **Lines 205-282**: Restructure the refresh flow:
  ```
  1. Get workspaceId
  2. Ensure DB is ready
  3. If DB ready:
     a. Call syncNewPlansOnly() to pick up any newly created plans from disk
     b. Read cards from DB via db.getBoard(workspaceId)
     c. Use DB cards as the authoritative board state
  4. If DB NOT ready (fallback):
     a. Log a warning
     b. Fall back to file-derived state (current behavior)
     c. Attempt to create/initialize DB for next refresh
  ```
- Remove the current pattern where file-derived state always overwrites DB state.

### Step 3 — Write column transitions directly to DB (Complex)
- **File**: `src/services/KanbanProvider.ts`
- In `_handleMessage` for `'triggerAction'` (drag-drop column move):
  - After determining the target column, update the DB directly: `db.run('UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?', [targetColumn, now, sessionId])`.
  - Also still write the runsheet event for backward compatibility and action logging.
- In the autoban dispatch flow (`TaskViewerProvider.ts`):
  - After dispatching a card, update its column in the DB.
- In `completePlan`:
  - Mark the plan as `status = 'completed'` in the DB.

### Step 4 — Add direct column update method to KanbanDatabase (Routine)
- **File**: `src/services/KanbanDatabase.ts`
- Add a new method:
  ```ts
  public async updateColumn(sessionId: string, newColumn: string): Promise<boolean> {
      if (!(await this.ensureReady()) || !this._db) return false;
      this._db.run(
          'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?',
          [newColumn, new Date().toISOString(), sessionId]
      );
      return this._persist();
  }
  ```
- Add `updateComplexity`, `updateStatus` convenience methods similarly.

### Step 5 — Update MCP get_kanban_state to be DB-first (Moderate)
- **File**: `src/mcp-server/register-tools.js`
- In the `get_kanban_state` handler (~line 1968):
  - Try DB first (current behavior).
  - If DB succeeds, use DB data — do NOT fall back to file state.
  - If DB fails, fall back to file-derived state BUT log a clear warning: `"[get_kanban_state] DB unavailable, using file-derived fallback. Board state may be stale."`.
  - Do NOT silently fall back without warning.

### Step 6 — Ensure DB is auto-created on extension activation (Routine)
- **File**: `src/services/KanbanProvider.ts` (or extension activation)
- On first `open()` or first `_refreshBoard()`, ensure `KanbanDatabase.forWorkspace(workspaceRoot).ensureReady()` is called.
- The DB should be created at `.switchboard/kanban.db` automatically — `KanbanDatabase._initialize()` already handles this (line 216-239). Verify it works when the file doesn't exist.

### Step 7 — Add DB health check to sidebar (Routine)
- **File**: `src/services/TaskViewerProvider.ts`
- After DB initialization, check `db.lastInitError`. If there's an error, show a non-blocking warning: `"Kanban DB initialization failed: [error]. Using file-based fallback."`.
- This helps diagnose sql.js WASM loading issues.

## Verification Plan
1. `npm run compile` — no build errors.
2. **Fresh workspace test**: Delete `.switchboard/kanban.db` → open kanban → verify DB is created and bootstrapped from existing runsheet files → cards display correctly.
3. **DB persistence**: Drag a card to a new column → close and reopen kanban → verify the card is in the moved column (DB was updated, not re-derived from files).
4. **New plan creation**: Create a new plan → verify it appears in the DB and on the board without clobbering existing card positions.
5. **Autoban**: Run autoban → verify dispatched cards update their column in the DB.
6. **MCP tool**: Call `get_kanban_state` → verify it returns DB-sourced data.
7. **Fallback**: Temporarily corrupt the DB file → verify the board still renders using file-derived fallback with a warning logged.
8. **Complete plan**: Mark a plan as complete → verify it's marked `status = 'completed'` in the DB and disappears from the board.
9. **No clobbering**: Move a card manually → refresh the board → verify the card stays in the manually-set column (not re-derived back to its old position).

## Complexity Audit

### Band A — Routine
- Add convenience methods to KanbanDatabase (`updateColumn`, `updateComplexity`, `updateStatus`)
- Auto-create DB on first use (already mostly works)
- DB health check warning in sidebar

### Band B — Complex / Risky
- **Restructuring `_refreshBoard` to be DB-first** — this is the core change. Must handle the transition from "always derive" to "DB authoritative with new-plan sync". Risk: if sync logic has bugs, cards could disappear or duplicate.
- **Changing KanbanMigration from full-overwrite to bootstrap-only** — must correctly detect "DB already has data" vs "DB is fresh". Edge case: what if DB has data but it's stale from a previous workspace? Use workspaceId scoping.
- **Writing column transitions to DB** — must ensure every code path that moves a card (drag-drop, autoban, CLI trigger, completePlan) writes to DB. Missing a path means the DB gets out of sync.
- **Backward compatibility** — existing runsheet event files still need to be written for action logging. The DB replaces them as source-of-truth for column position, but events are still the audit trail.

**Recommendation**: Send it to the **Lead Coder** — this is a core architectural change affecting the data model, with multiple code paths to update and data consistency risks.
