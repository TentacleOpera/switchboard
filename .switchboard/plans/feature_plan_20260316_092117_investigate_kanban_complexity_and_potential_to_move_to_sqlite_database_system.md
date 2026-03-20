# Investigate Kanban Complexity and Potential to Move to SQLite Database System

## Notebook Plan

The kanban backend seems very complex for what it needs to do:

1. what column does a plan belong to
2. is it active

In a database, this would be:

plan_title
file_url
kanban_column
status
complexity
last_action

All I want to do is read the database and get an instant kanban board. 

Are we trying to replicate a database with an overly complex system of runsheets? We keep hitting bugs where plans aren't where they are meant to be, and every time I suggest a central state management system it gets shot down by agents. Why are you obsessd with buggy systems?

The other benefit to a database system is the potential for Jira integration later on. This is not for now, but it strikes me as more scaleable than a custom mashup of files.

---

## Architecture Audit: Current State

### What We Have Today

The Kanban board's state is **not stored** — it is **re-derived** on every read from 4+ filesystem artifacts:

| Artifact | Purpose | Read By |
|----------|---------|---------|
| `.switchboard/sessions/*.json` (61 files, ~38KB) | Runsheet event logs per plan | KanbanProvider, TaskViewerProvider, MCP server |
| `.switchboard/plan_registry.json` | Ownership mapping (planId → workspaceId, status) | All three column derivers |
| `.switchboard/workspace_identity.json` | Current workspace identity for scoping | All three column derivers |
| `.switchboard/plan_tombstones.json` | Deleted plan IDs | All three column derivers |
| `.switchboard/brain_plan_blacklist.json` | Legacy plan exclusion list | All three column derivers |
| `.switchboard/state.json` | Agent config, Autoban config, terminal state | Sidebar, Kanban, MCP server |
| `.switchboard/plans/*.md` (61 plan files) | Plan content + complexity audit sections | KanbanProvider (complexity parsing) |

### Why This Keeps Breaking

The user is correct. The current architecture fails because:

1. **No single source of truth for column assignment.** Three independent `deriveColumn()` functions re-derive from event logs with divergent keyword lists (see [Fix Autoban Issues](file:///c%3A/Users/patvu/Documents/GitHub/switchboard/.switchboard/plans/feature_plan_20260316_063407_fix_autoban_issues.md) plan).
2. **File I/O scatter.** A single "which column is this card in?" query touches 4 files minimum (session JSON + registry + identity + tombstones). Multiply by 61 cards = hundreds of file reads per board refresh.
3. **No transactional consistency.** `state.json` uses file locking via `proper-lockfile`, but session JSONs and the registry do not share the same lock. Concurrent writes (e.g. Autoban tick + user drag-drop) can silently corrupt state.
4. **Event-sourcing without the benefits.** Storing events without snapshots means every query is O(n) over all events. But there's no event replay, no audit trail UI, no undo — just derived columns.

### Data Volume Assessment

| Metric | Current |
|--------|---------|
| Total session files | 61 |
| Total data size (sessions) | 38 KB |
| Total plan files | 61 |
| Registry entries | ~61 |
| Average session JSON | ~620 bytes |
| Max concurrent cards on board | ~60 |

This is trivially small. SQLite could handle 100x this volume with sub-millisecond reads.

---

## Goal

Determine whether migrating the Kanban state management from file-based event derivation to a SQLite database is feasible, and if so, produce a migration plan. The core questions:

1. **Is SQLite viable in a VS Code extension?** (Packaging, native module issues)
2. **What is the migration scope?** (Which files/functions change, what stays file-based)
3. **Does this fix the desync bugs?** (Confirm the architectural hypothesis)
4. **What does the schema look like?**

---

## Feasibility Analysis

### SQLite in VS Code Extensions

| Concern | Assessment |
|---------|------------|
| **Native module packaging** | `better-sqlite3` requires native compilation. Must use `@vscode/vsce` with `--pre-install` or ship prebuilt binaries per platform (win32-x64, linux-x64, darwin-arm64, darwin-x64). This adds ~2-5MB per platform to the VSIX. |
| **WASM alternative** | `sql.js` is a pure-JS WASM build of SQLite. No native deps. ~1.5MB. Slower than native but plenty fast for <100 rows. **This is the recommended approach for a VS Code extension.** |
| **Cross-process access** | The MCP server runs as a child process. SQLite supports concurrent readers with WAL mode. Both the extension host and MCP server can read the same `.db` file. Writes should be serialized through the extension host. |
| **File watching** | Currently the extension watches session JSON files for changes. With SQLite, the MCP server would write to the DB and the extension would need a different notification mechanism (IPC message, or polling on a shorter interval). |

### Recommended: Hybrid `sql.js` Approach

Use `sql.js` (WASM SQLite) for the Kanban state database. Keep plan markdown files on disk (they are human-readable documents, not database records). Keep `state.json` for agent configuration (it serves a different purpose).

**What moves to SQLite:**
- Column assignment (currently derived from events)
- Plan status (active/archived/completed)
- Complexity assessment
- Session metadata (topic, planFile, createdAt, lastActivity)
- Ownership scoping (currently in plan_registry.json)

**What stays file-based:**
- Plan markdown files (`.switchboard/plans/*.md`)
- Agent/terminal configuration (`state.json`)
- Autoban configuration (stored in VS Code workspaceState)
- Activity log (`sessions/activity.jsonl`)

---

## Proposed Schema

```sql
CREATE TABLE plans (
    plan_id         TEXT PRIMARY KEY,
    session_id      TEXT UNIQUE NOT NULL,
    topic           TEXT NOT NULL,
    plan_file       TEXT,                    -- relative path to .md file
    kanban_column   TEXT NOT NULL DEFAULT 'CREATED',
    status          TEXT NOT NULL DEFAULT 'active',  -- active | archived | completed
    complexity      TEXT DEFAULT 'Unknown',  -- Unknown | Low | High
    workspace_id    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_action     TEXT,                    -- e.g. 'improve-plan', 'handoff-lead'
    source_type     TEXT DEFAULT 'local'     -- local | brain
);

CREATE INDEX idx_plans_column ON plans(kanban_column) WHERE status = 'active';
CREATE INDEX idx_plans_workspace ON plans(workspace_id);

-- Event history (optional, for audit trail)
CREATE TABLE plan_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id     TEXT NOT NULL REFERENCES plans(plan_id),
    workflow    TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    metadata    TEXT                         -- JSON blob for extra context
);
```

### Key Design Decisions

1. **`kanban_column` is now a stored field**, not derived. When a workflow runs, the column is updated directly via `UPDATE plans SET kanban_column = ?, last_action = ?, updated_at = ? WHERE session_id = ?`. No more event log parsing.
2. **`plan_events` is optional audit trail.** Events are appended for history but never read to determine current state.
3. **Single query to render the board:** `SELECT * FROM plans WHERE workspace_id = ? AND status = 'active' ORDER BY kanban_column, created_at`.

---

## Proposed Changes (High Level)

### Phase 1: Create the Database Layer

#### [NEW] `src/services/KanbanDatabase.ts`
- Initialize `sql.js`, create/open `.switchboard/kanban.db`
- `getBoard(workspaceId)`: returns all active plans grouped by column
- `movePlan(sessionId, newColumn, action)`: updates column assignment
- `addPlan(...)`: inserts a new plan
- `completePlan(sessionId)`: sets status to 'completed'
- `getPlansByColumn(column)`: for Autoban batch queries

### Phase 2: Migrate Column Derivation

#### [MODIFY] `src/services/KanbanProvider.ts`
- Replace `_deriveColumn()` with `db.getBoard()` read
- Replace `_getActiveSheets()` with `db.getBoard()` read
- Remove `SessionActionLog` dependency for card rendering

#### [MODIFY] `src/services/TaskViewerProvider.ts`
- Replace `_deriveColumnFromEvents()` calls with `db.getPlansByColumn()`
- `_autobanTickColumn()` reads directly from DB instead of parsing session JSONs
- `handleKanbanTrigger()` calls `db.movePlan()` after dispatch success

#### [MODIFY] `src/mcp-server/register-tools.js`
- `get_kanban_state` reads from SQLite DB file directly (using `sql.js`)
- No more inline `deriveColumn()` function

### Phase 3: Migration Script

#### [NEW] `src/services/KanbanMigration.ts`
- One-time migration: read all session JSONs + registry, derive columns one last time, INSERT into SQLite.
- Run automatically on first load after upgrade. Write a `migration_version` table to prevent re-runs.

---

## Complexity Audit

### Band A — Routine
- Schema creation and basic CRUD in `KanbanDatabase.ts`
- Migration script (one-time, read-only from old system, write to new)
- Updating `get_kanban_state` MCP tool to read from DB

### Band B — Complex / Risky
- Ensuring `sql.js` WASM binary is correctly bundled in the VSIX package
- Cross-process read access (extension host + MCP child process reading same `.db`)
- Maintaining backward compatibility during migration (old session JSONs must still work until migration completes)
- Wiring all column-mutation callsites to go through `db.movePlan()` instead of appending runsheet events

**Recommendation**: Send to **Lead Coder**. This is a foundational architectural change that touches every consumer of Kanban state.

---

## Adversarial Review

### 🔴 Grumpy Critique

1. **CRIT: WASM SQLite in an extension is unproven.** You're proposing to add a WASM runtime dependency to a VS Code extension that currently has zero native/WASM deps. If `sql.js` initialization fails on any platform, the entire Kanban board is bricked. What's the fallback?

2. **CRIT: Migration is a one-way door.** Once you stop writing runsheet events, every downstream consumer of session JSONs breaks. The Autoban engine, the Kanban provider, the MCP server, and potentially external tools all read these files. You need a dual-write period — and dual-write systems are notoriously fragile.

3. **MAJOR: You're solving three bugs with a rewrite.** The three column-derivation functions can be fixed by extracting a shared function (see the Autoban fix plan). That's a 30-minute change. The SQLite migration is a multi-day rewrite. The cost-benefit ratio is upside down.

4. **MINOR: Jira integration is speculative scope creep.** The plan mentions Jira compatibility as a benefit, but there is no concrete requirement. Do not justify architectural decisions with hypothetical future integrations.

### 🟢 Balanced Synthesis

1. **Agreed on CRIT #1 — partially.** `sql.js` is used in production VS Code extensions (e.g., `vscode-sqlite`). But a fallback IS needed. The plan should specify: if `sql.js` initialization fails, fall back to the current file-based derivation and log a warning. This makes the migration non-breaking.

2. **Agreed on CRIT #2.** Dual-write is necessary during migration. The plan should specify a 2-release transition:
   - **Release N**: DB writes + session JSON writes (dual-write). DB is authoritative for reads.
   - **Release N+1**: Session JSON writes removed. Old session files archived or left as read-only history.

3. **Partially disagree on MAJOR #3.** The shared-function fix (Plan 1) is necessary and should ship first. But it only fixes one symptom (keyword divergence). The deeper problem — that column state is derived rather than stored — will produce new bug categories as more workflows are added. The SQLite migration is a strategic fix, not just a tactical one. **However**, it should be sequenced after Plan 1 ships, not instead of it.

4. **Agreed on MINOR #4.** Remove Jira references from the plan rationale. If Jira integration is needed later, evaluate it separately.

### Challenge Review Action Plan

1. **[REQUIRED]** Add a fallback path: if `sql.js` fails to initialize, fall back to file-based derivation.
2. **[REQUIRED]** Define a dual-write transition period in the migration plan.
3. **[REQUIRED]** Sequence this plan AFTER Plan 1 (shared column-derivation function) ships.
4. **[RECOMMENDED]** Prototype `sql.js` initialization in the extension host to validate VSIX packaging before committing to the full migration.
5. **[RECOMMENDED]** Remove Jira integration from the rationale.

---

## Verification Plan

### Phase 1: Prototype Validation
- Add `sql.js` as a dependency. Verify `npm run compile` succeeds.
- Verify `vsce package` produces a valid VSIX that installs cleanly.
- Write a minimal test that creates an in-memory SQLite DB, inserts 100 plans, and queries by column.

### Phase 2: Integration Tests
- Write a test that migrates the current 61 session files into SQLite and compares the resulting column assignments against the current `deriveColumn()` output. They must be identical.
- Run the Autoban engine against the DB-backed board and verify dispatches match expected behavior.

### Manual Verification
1. Install the new VSIX on Windows, macOS, and Linux.
2. Open the Kanban board — verify all cards appear in correct columns.
3. Trigger a workflow (e.g., improve-plan) — verify the card moves to PLAN REVIEWED via DB update, not event append.
4. Call `get_kanban_state` via MCP — verify output matches the Kanban webview.

---

## Dependency: Must Ship After

> [!IMPORTANT]
> This plan depends on [Fix Autoban Issues](file:///c%3A/Users/patvu/Documents/GitHub/switchboard/.switchboard/plans/feature_plan_20260316_063407_fix_autoban_issues.md) shipping first. The shared `deriveKanbanColumn()` function from that plan is needed as the migration's source-of-truth for populating initial column values in the SQLite database.

## Open Questions
- None — feasibility confirmed. Decision to proceed is a product call.
