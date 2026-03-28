# Consolidate Session Files into Database with Event Sourcing for Cross-Machine Sync

## Goal
Eliminate dual persistence layers (SQLite + JSON session files) by consolidating all plan state into the database using an event sourcing pattern. This solves both technical debt (single source of truth) and cross-machine sync reliability (append-only history handles concurrent edits).

## Metadata
**Tags:** backend, database
**Complexity:** High

## User Review Required
- **Event sourcing vs. simpler consolidation**: Confirm that full event sourcing (append-only log + derived state) is desired rather than simply making the DB the single source of truth with direct state updates.
- **Vector clock inclusion**: The plan includes vector clocks for cross-machine ordering. Confirm this is needed now vs. deferred to a future sync-focused plan.
- **Dual-write transition duration**: Plan proposes 1-2 release cycles of dual-write (DB + files). Confirm acceptable timeline and rollback expectations.
- **Migration V5 scope**: This adds 2 new tables (`plan_events`, `activity_log`) + 4 indexes. Confirm this won't conflict with the DuckDB Archive plan's schema assumptions.
- **Session file retention**: After migration, should old `.switchboard/sessions/*.json` files be archived to `.switchboard/archive/sessions/` or deleted?

## Complexity Audit

### Routine
- Creating new SQLite tables via migration (V5) — well-established pattern in `KanbanDatabase.ts` (V2–V4 already exist)
- Adding indexes on `plan_events` and `activity_log` — standard SQL
- Reading/writing JSON payloads to TEXT columns — already done for `config` table
- Archiving old session files to `.switchboard/archive/` — existing `archiveFiles()` in `SessionActionLog.ts`

### Complex / Risky
- **Event sourcing derivation logic**: `deriveKanbanColumnFromEvents()` must replicate the exact semantics of the current `deriveKanbanColumn()` that operates on in-memory session objects. Any divergence = silent state corruption on the kanban board.
- **Dual-write transition (Phase 3)**: Two write targets (DB + file) with no distributed transaction coordinator. Partial failures create divergent state that's hard to detect.
- **Session file migration (Phase 2)**: Parsing 74+ JSON session files with heterogeneous schemas (different fields across versions). Error in one file must not block migration of others.
- **Vector clock implementation**: Adds distributed systems complexity (increment, compare, merge) to a single-user VS Code extension. Must handle clock drift, missing device IDs, and merge conflicts.
- **Cross-machine merge (`mergeRemoteEvents`)**: Detecting and reconciling events from a cloud-synced DB file requires comparing event streams without duplicating or losing events. sql.js loads the entire DB into memory, so "detecting mtime changes" means reloading the whole file.
- **Consumer migration**: 74+ callsites across `TaskViewerProvider.ts`, `KanbanProvider.ts`, `SessionActionLog.ts`, and `PipelineOrchestrator.ts` read session data. All must be audited and updated to read from DB first with file fallback.
- **`kanban_column` removal from `plans` table (Phase 6)**: Every query that currently reads `kanban_column` directly must be rewritten to call `deriveKanbanColumn()`. This includes `getBoard()`, `getPlansByColumn()`, and the kanban webview refresh pipeline.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent VS Code windows**: Two VS Code windows in the same workspace both call `appendPlanEvent()` simultaneously. sql.js is in-memory per-process — each window has its own copy. Events appended in Window A are invisible to Window B until the next file reload. This can cause duplicate or lost events.
- **Migration + active usage**: If `_migrateSessionFiles()` runs while a workflow is actively appending to a session JSON file, the migration may read a partial/stale snapshot. New events written to the file after migration starts are lost.
- **Dual-write ordering**: During Phase 3, if the DB write succeeds but the file write fails (disk full, permission error), the DB has the event but the file doesn't. Consumers reading from file fallback will see stale state.
- **Cloud sync race**: Dropbox/iCloud may sync a partially-written `kanban.db` file. sql.js reads the entire file into memory on init — a truncated file = corrupted DB load.

### Security
- **Payload sanitization**: `SessionActionLog._sanitizePayload()` currently scrubs API keys/tokens from JSONL payloads. The new `activity_log.payload` column must apply identical scrubbing before writing to DB. If missed, secrets persist in SQLite (harder to purge than deleting a JSONL line).
- **SQL injection via event payloads**: All event data is user/agent-generated. Parameterized queries are used (good), but `JSON.stringify(event)` in payload could contain malformed JSON that breaks downstream `JSON.parse()` consumers.

### Side Effects
- **DB file size growth**: Append-only `plan_events` table grows without bound. Unlike JSONL (which can be truncated), SQLite requires `VACUUM` to reclaim space after deletes. With `activity_log` also in the DB, the file could grow significantly for active workspaces.
- **Performance regression on `getBoard()`**: Currently `getBoard()` reads `kanban_column` directly from the `plans` table (indexed). After Phase 6, it must call `deriveKanbanColumn()` per plan — an N+1 query pattern that degrades with workspace size.
- **Memory pressure**: sql.js loads the entire DB into memory. Adding two new tables with potentially thousands of events increases baseline memory usage per VS Code window.

### Dependencies & Conflicts

#### Cross-Plan Conflicts
| Conflicting Plan | Conflict Area | Risk | Mitigation |
|-----------------|---------------|------|------------|
| **DuckDB Archive Database** (`feature_plan_20260327_103635_archive_database.md`) | Both modify `KanbanDatabase.ts`. Archive plan assumes current V4 schema for export. If event sourcing (V5) lands first, archive export must include `plan_events` and `activity_log` tables. If archive lands first, V5 migration must account for any schema changes archive introduced. | **High** | Sequence these plans explicitly. Event sourcing should land first since archive depends on stable schema. |
| **DB Operations Panel** (`feature_plan_20260327_104342_add_database_operaitons_panel.md`) | Panel exposes `kanban.dbPath` setting and shows database stats. If `plan_events` table is added, the stats display and any "table list" UI must be updated. Panel's "Reset Database" command must also handle the new tables. | **Medium** | Panel plan should land after schema is stable. Add `plan_events` and `activity_log` to the stats query. |
| **MCP Setup / extension.ts** | `extension.ts` orchestrates `KanbanDatabase` lifecycle, registers reset/sync commands. Event sourcing changes init flow (migration on first access) and adds new sync logic. Must not break existing `fullSync` or `resetKanbanDb` commands. | **Medium** | Ensure `_migrateSessionFiles()` is idempotent and `resetKanbanDb` drops new tables too. |
| **SQLite DB Not Syncing** (`feature_plan_20260326_150916_sqlite_db_not_syncing_correctly_across_machines.md`) | Custom `dbPath` support is foundational for this plan's cross-machine sync. If custom path plan isn't complete, event sourcing sync logic has no cloud-accessible DB file to merge. | **Low** | Custom dbPath is already partially implemented in `KanbanDatabase.forWorkspace()`. Verify it works before building sync on top. |

#### Internal Dependencies
- **sql.js WASM**: Already a dependency. No new packages needed for schema changes.
- **`os.hostname()`**: Used for `device_id` in events. Works cross-platform but returns different values if hostname changes (e.g., laptop rename). Not a stable device identifier.
- **`fs.statSync()` for mtime detection**: Used to detect cloud-synced DB changes. Unreliable on network-mounted filesystems where mtime may not update immediately.

## Adversarial Synthesis

### Grumpy Critique

This plan is a textbook case of **architecture astronautics** applied to a VS Code extension.

**1. Event sourcing is wildly overscoped.** The actual problem is: "`kanbanColumn` is stored in two places and they get out of sync." The fix is one line of logic: make the DB authoritative and stop writing `kanbanColumn` to session files. Instead, we're getting a full event sourcing system with append-only logs, derived state projections, vector clocks, and a merge algorithm. This is the kind of architecture you'd build for a multi-tenant SaaS with 10,000 concurrent users, not a single-user IDE plugin where the "concurrency" is one person opening two VS Code windows.

**2. sql.js destroys the core event sourcing guarantee.** The entire point of event sourcing is durability — events are immutable, append-only, and survive crashes. But sql.js loads the **entire database into memory** and writes back to disk on explicit flush (`_persistedUpdate`). If VS Code crashes between `appendPlanEvent()` and the next disk flush, your "append-only" events evaporate. The plan's claim that "append-only = no data loss" is flatly wrong in this runtime. You've built an in-memory event store that pretends to be durable.

**3. The dual-write transition is a distributed systems problem you don't need.** Phase 3 introduces dual-write to both DB and files for "backward compatibility." This is exactly the pattern that causes the most insidious bugs in real distributed systems — partial failures where one write succeeds and the other doesn't. You're introducing the hardest problem in distributed computing (consistency across two stores) as a *temporary transition mechanism*. And there's no transaction coordinator, no compensating action, no reconciliation. Just hope.

**4. Vector clocks for Dropbox sync? Really?** Vector clocks solve causal ordering in distributed systems where nodes can't share a global clock. Your "distributed system" is one person's laptop syncing a SQLite file via Dropbox. Timestamps are sufficient. If two edits happen within the same second (which requires superhuman speed given the manual nature of kanban moves), last-write-wins is fine. The vector clock adds code complexity, storage overhead, and a merge algorithm you'll have to debug — all to solve a conflict scenario that essentially can't happen in practice.

**5. `mergeRemoteEvents()` is hand-waved.** The plan says "Implementation: Compare local vs remote event streams, append missing events. No overwrites = no data loss." That's not an implementation, that's a wish. How do you compare streams? By event_id? Those are autoincrement and differ across machines. By timestamp + device_id? Clock skew makes this unreliable. By content hash? Now you need deduplication logic. This is the hardest part of the entire plan and it gets one comment line.

**6. Nine days for what should take two.** Strip out event sourcing, vector clocks, and the merge algorithm. Just: (a) make `plans` table authoritative for `kanban_column`, (b) move `activity.jsonl` reads to a simple `activity_log` table, (c) stop writing session JSON files. That's 2-3 days, low risk, and solves the actual problem. The remaining 6 days of event sourcing infrastructure solves a theoretical cross-machine sync problem that may never materialize at the scale this extension operates at.

**7. The consumer migration is underspecified.** 74+ callsites read session data. The plan shows code snippets for `SessionActionLog` changes but doesn't enumerate which of those 74 callsites need updating, in what order, or how to verify each one. This is where the real bugs will hide — some obscure code path in `PipelineOrchestrator.ts` that still reads from the JSON file and silently gets stale data.

**8. Phase 6 creates an N+1 query nightmare.** Removing `kanban_column` from the `plans` table means `getBoard()` can no longer do a single `SELECT` to get all plans with their columns. Instead, it must call `deriveKanbanColumn()` for each plan — which itself runs a `SELECT` against `plan_events`. For a workspace with 50 plans, that's 51 queries instead of 1. The plan doesn't address this. A materialized view or cache would help, but that reintroduces the "two sources of truth" problem this plan claims to solve.

### Balanced Response

The Grumpy Critique makes several valid points that should inform the implementation, but overstates the case against the overall direction.

**On event sourcing scope**: The critique is right that the *immediate* problem (dual `kanbanColumn`) has a simpler fix. However, the plan addresses a broader goal: eliminating file I/O as a persistence layer entirely. Session JSON files are the source of multiple bugs (file locking on Windows, partial writes, glob scanning on every refresh). Event sourcing isn't strictly necessary for this, but an append-only event table *is* a natural fit for workflow history that's currently stored as `events[]` arrays in JSON files. The pattern isn't overengineered — it's just what "move the events array into SQL" looks like.

**On sql.js durability**: This is the strongest critique. The plan should explicitly acknowledge that sql.js is not durable between flushes and add mitigations: (a) call `_persistedUpdate` (which does immediate flush) for every event append, not batch writes; (b) add a periodic flush timer as a safety net; (c) document that event sourcing here provides *logical* immutability (no UPDATE/DELETE on events), not *physical* crash durability. The plan should also note that the current JSON-file approach has the *same* durability problem — `fs.writeFile` can also lose data on crash.

**On dual-write complexity**: Fair point. The mitigation is to keep the dual-write window as short as possible (one release cycle, not two) and add a reconciliation check on startup that compares DB events vs file events and logs discrepancies. The plan should also add a feature flag (`switchboard.useDbEvents`) so dual-write can be disabled immediately if issues arise.

**On vector clocks**: Agree this should be deferred. Replace with simple `device_id + timestamp` for now. If real-world sync conflicts emerge (unlikely at current scale), vector clocks can be added in a future plan. The `vector_clock` column can remain in the schema as `DEFAULT ''` for forward compatibility, but the implementation should be a no-op.

**On `mergeRemoteEvents()`**: The critique is correct that this is underspecified. The plan should either: (a) fully specify the merge algorithm (compare by `session_id + event_type + timestamp + device_id` tuple, insert missing events, skip duplicates), or (b) defer cross-machine merge to a separate plan and focus this plan solely on consolidation. Option (b) is recommended — it halves the risk.

**On consumer migration**: The plan should add an explicit callsite audit table listing every file that reads session data, which method it calls, and whether it needs updating. This can be generated from `grep -rn 'getRunSheet\|readSession\|session\.events\|activity\.jsonl'` across the source tree.

**On the N+1 query concern**: Valid. The solution is to keep `kanban_column` in the `plans` table as a **materialized cache** that's updated whenever a `column_change` event is appended. This gives single-query reads while events remain the source of truth. The plan already asks this as an open question — the answer should be "yes, keep the cache."

**Net assessment**: The consolidation direction is correct — the extension needs to stop using JSON files as a persistence layer. The event sourcing framing adds some unnecessary complexity (vector clocks, merge algorithm) that should be deferred. Recommend splitting into two plans: (1) DB consolidation (move session data into SQL tables, eliminate file I/O), and (2) Cross-machine sync (event ordering, merge, conflict resolution). Plan 1 is ~4 days and low-medium risk. Plan 2 is ~5 days and medium-high risk, and can be deferred until sync issues are actually reported.

---

## Current State: Two Overlapping Persistence Layers

| Layer | Schema | Used By | Operations |
|-------|--------|---------|------------|
| **Database** (`kanban.db`) | `plans` table with metadata (topic, column, status, complexity, tags, workspace_id) | Kanban board, plan registry, column tracking | 27 in `KanbanDatabase.ts` |
| **Session Files** (`.switchboard/sessions/*.json`) | Per-session JSON with `events[]` array (workflow history) | Workflow state machines, activity feed, autoban engine, run sheets | 74+ across `TaskViewerProvider.ts`, `KanbanProvider.ts`, `SessionActionLog.ts`, `PipelineOrchestrator.ts` |

**Critical Overlap**: Both store `kanbanColumn`. The DB stores it directly; session files derive it from `events[]` via `deriveKanbanColumn()`. Any column change must update BOTH - they get out of sync.

---

## Consolidation Strategy: Event Sourcing in SQLite

Instead of storing derived state (kanbanColumn) in two places, store **immutable events** in the DB and derive state on read:

```sql
-- New table for append-only event log
CREATE TABLE plan_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'workflow_start', 'column_change', 'completed', 'dispatch'
    workflow TEXT,             -- 'handoff', 'review', 'improve-plan', etc.
    action TEXT,               -- 'start', 'complete', etc.
    timestamp TEXT NOT NULL,
    device_id TEXT NOT NULL DEFAULT '',   -- hostname for conflict debugging
    vector_clock TEXT DEFAULT '',         -- logical clock for ordering
    payload TEXT DEFAULT '{}',            -- JSON for extensibility
    FOREIGN KEY (session_id) REFERENCES plans(session_id)
);
CREATE INDEX idx_events_session_time ON plan_events(session_id, timestamp);
CREATE INDEX idx_events_time ON plan_events(timestamp);  -- for activity feed

-- Activity log consolidation (replaces activity.jsonl)
CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    event_type TEXT NOT NULL,  -- 'dispatch', 'workflow', 'autoban', 'ui_action'
    payload TEXT NOT NULL,     -- JSON
    correlation_id TEXT,
    session_id TEXT
);
CREATE INDEX idx_activity_time ON activity_log(timestamp);
CREATE INDEX idx_activity_session ON activity_log(session_id, timestamp);
```

**Why This Solves Both Problems:**

| Problem | Event Sourcing Solution |
|---------|------------------------|
| **Dual persistence** | Single DB file with all data |
| **Sync conflicts** | Append-only = no overwrites; concurrent edits both preserved in history |
| **Cloud sync reliability** | SQLite binary file still syncs atomically; conflict resolution via event ordering |
| **Activity feed** | Query `activity_log` table instead of parsing `activity.jsonl` |
| **Run sheets** | Query `plan_events` for session history |

---

## Key Data Mappings

| Data | Current Location | New Location | Derivation |
|------|-----------------|--------------|------------|
| `kanbanColumn` | DB `plans.kanban_column` + session `events[]` | Remove from `plans` table | Derived from `plan_events` via `deriveKanbanColumnFromEvents()` |
| `events[]` (workflow history) | Session JSON files | `plan_events` table | Direct query: `SELECT * FROM plan_events WHERE session_id = ? ORDER BY timestamp` |
| `activity.jsonl` | `.switchboard/sessions/activity.jsonl` | `activity_log` table | Query with filters/pagination |
| `topic`, `planFile`, `complexity`, `tags` | Both (duplicated) | `plans` table only | Remove from session files |
| `status` (active/completed/deleted) | DB only | `plans.status` | Keep as-is |
| `workspaceId` | DB only | `plans.workspace_id` | Keep as-is |

---

## Proposed Changes

### Phase 1: Database Schema Migration (V5)

**[MODIFY]** `src/services/KanbanDatabase.ts` - Add migration V5:

```typescript
const MIGRATION_V5_SQL = [
    // Create events table
    `CREATE TABLE IF NOT EXISTS plan_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        workflow TEXT,
        action TEXT,
        timestamp TEXT NOT NULL,
        device_id TEXT DEFAULT '',
        vector_clock TEXT DEFAULT '',
        payload TEXT DEFAULT '{}',
        FOREIGN KEY (session_id) REFERENCES plans(session_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_session ON plan_events(session_id, timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_events_time ON plan_events(timestamp)`,
    
    // Create activity log table (replaces activity.jsonl)
    `CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        correlation_id TEXT,
        session_id TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_time ON activity_log(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_session ON activity_log(session_id, timestamp)`,
];
```

### Phase 2: Session Migration on First Read

**[MODIFY]** `src/services/KanbanDatabase.ts` - Add migration helper:

```typescript
/**
 * Migrate existing session files into database.
 * Called once during initialization if plan_events table is empty.
 */
private async _migrateSessionFiles(): Promise<number> {
    const sessionsDir = path.join(this._workspaceRoot, '.switchboard', 'sessions');
    if (!fs.existsSync(sessionsDir)) return 0;
    
    const files = await fs.promises.readdir(sessionsDir);
    const migrated = [];
    
    for (const file of files) {
        if (!file.endsWith('.json') || file === 'activity.jsonl') continue;
        
        try {
            const content = await fs.promises.readFile(path.join(sessionsDir, file), 'utf8');
            const session = JSON.parse(content);
            
            // Migrate events to plan_events table
            if (Array.isArray(session.events)) {
                for (const event of session.events) {
                    this._db.run(
                        `INSERT INTO plan_events (session_id, event_type, workflow, action, timestamp, payload)
                         VALUES (?, 'workflow_event', ?, ?, ?, ?)`,
                        [
                            session.sessionId,
                            event.workflow || '',
                            event.action || '',
                            event.timestamp,
                            JSON.stringify(event)
                        ]
                    );
                }
            }
            
            // Update plan record to ensure it exists
            await this.upsertPlans([{
                planId: session.planId || session.sessionId,
                sessionId: session.sessionId,
                topic: session.topic || session.planName || 'Untitled',
                planFile: session.planFile || '',
                kanbanColumn: this._deriveKanbanColumnFromEvents(session.events),
                status: session.completed ? 'completed' : 'active',
                complexity: session.complexity || 'Unknown',
                tags: session.tags || '',
                workspaceId: session.workspaceId || this._getDefaultWorkspaceId(),
                createdAt: session.createdAt,
                updatedAt: session.updatedAt || session.createdAt,
                lastAction: session.lastAction || '',
                sourceType: session.sourceType || 'local',
                brainSourcePath: session.brainSourcePath || '',
                mirrorPath: session.mirrorPath || ''
            }]);
            
            migrated.push(session.sessionId);
        } catch (e) {
            console.error(`[KanbanDatabase] Failed to migrate session ${file}:`, e);
        }
    }
    
    return migrated.length;
}

/**
 * Derive kanban column from events (replaces deriveKanbanColumn() for DB-backed sessions)
 */
private _deriveKanbanColumnFromEvents(events: any[]): string {
    // Same logic as existing deriveKanbanColumn() but operates on event array
    // Returns: 'CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'COMPLETED'
}
```

### Phase 3: Dual-Write Transition

**[MODIFY]** `src/services/SessionActionLog.ts` - Add DB-backed event logging:

```typescript
export class SessionActionLog {
    private readonly _db: KanbanDatabase;
    
    constructor(workspaceRoot: string) {
        this._db = KanbanDatabase.forWorkspace(workspaceRoot);
    }
    
    /**
     * Append event to both legacy file (backward compat) and database (new source)
     */
    async append(event: SessionEvent): Promise<void> {
        // Dual-write: keep file for backward compat during transition
        await this._appendToFile(event);
        
        // New: Write to database
        await this._db.appendSessionEvent(event.dispatchId, {
            eventType: 'dispatch',
            workflow: event.sender || '',
            action: event.action || event.event,
            timestamp: event.timestamp,
            payload: JSON.stringify(event)
        });
    }
    
    /**
     * Get run sheet - read from DB first, fall back to file during transition
     */
    async getRunSheet(sessionId: string): Promise<any | null> {
        // Try database first
        const fromDb = await this._db.getRunSheet(sessionId);
        if (fromDb) return fromDb;
        
        // Fallback to file during transition period
        return this._getRunSheetFromFile(sessionId);
    }
    
    /**
     * Update run sheet - write to DB, optionally mirror to file
     */
    async updateRunSheet(sessionId: string, updater: (current: any) => any): Promise<void> {
        // Read current state
        const current = await this.getRunSheet(sessionId) || { sessionId, events: [] };
        
        // Apply update
        const next = updater(current);
        if (!next) return;
        
        // Write to database as event(s)
        const newEvents = next.events.slice(current.events?.length || 0);
        for (const event of newEvents) {
            await this._db.appendPlanEvent(sessionId, {
                eventType: 'workflow_event',
                workflow: event.workflow,
                action: event.action,
                timestamp: event.timestamp,
                payload: JSON.stringify(event)
            });
        }
        
        // Mirror to file during transition (for rollback safety)
        await this._writeRunSheetToFile(sessionId, next);
    }
}
```

### Phase 4: Activity Log Consolidation

**[MODIFY]** `src/services/SessionActionLog.ts` - Replace `activity.jsonl` with DB:

```typescript
/**
 * Log activity event - now writes to database instead of JSONL file
 */
async logEvent(type: string, payload: Record<string, any>, correlationId?: string): Promise<void> {
    await this._db.appendActivityEvent({
        timestamp: new Date().toISOString(),
        eventType: type,
        payload: JSON.stringify(this._sanitizePayload(type, payload)),
        correlationId,
        sessionId: payload.sessionId || payload.dispatchId || null
    });
}

/**
 * Read recent activity - now queries database with pagination
 */
async getRecentActivity(limit: number, beforeTimestamp?: string): Promise<{ events: ActivityEvent[]; hasMore: boolean; nextCursor?: string }> {
    return this._db.getRecentActivity(limit, beforeTimestamp);
}
```

### Phase 5: Cross-Machine Sync Support

**[MODIFY]** `src/services/KanbanDatabase.ts` - Add sync-aware methods:

```typescript
/**
 * Append event with conflict resolution metadata
 */
public async appendPlanEvent(sessionId: string, event: Omit<PlanEvent, 'eventId'>): Promise<boolean> {
    if (!(await this.ensureReady()) || !this._db) return false;
    
    const deviceId = os.hostname();
    const vectorClock = await this._incrementVectorClock(sessionId);
    
    return this._persistedUpdate(
        `INSERT INTO plan_events (session_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            sessionId,
            event.eventType,
            event.workflow || '',
            event.action || '',
            event.timestamp || new Date().toISOString(),
            deviceId,
            vectorClock,
            event.payload || '{}'
        ]
    );
}

/**
 * Detect and merge events from cloud-synced DB file
 * Called when mtime change detected in _initialize()
 */
public async mergeRemoteEvents(): Promise<{ newEvents: number; conflicts: number }> {
    // Implementation: Compare local vs remote event streams, append missing events
    // No overwrites = no data loss
}

/**
 * Derive current kanban column from event history
 * Replaces the need to store kanban_column in plans table
 */
public async deriveKanbanColumn(sessionId: string): Promise<string> {
    if (!(await this.ensureReady()) || !this._db) return 'CREATED';
    
    const stmt = this._db.prepare(
        `SELECT workflow, action, timestamp FROM plan_events 
         WHERE session_id = ? AND event_type = 'workflow_event'
         ORDER BY timestamp DESC`,
        [sessionId]
    );
    
    const events = [];
    while (stmt.step()) {
        events.push(stmt.getAsObject());
    }
    stmt.free();
    
    return deriveKanbanColumnFromEvents(events);
}
```

### Phase 6: Schema Cleanup (Post-Verification)

**[MODIFY]** `src/services/KanbanDatabase.ts` - After migration verified:

```typescript
// Add to MIGRATION_V6_SQL (future):
// - Remove kanban_column from plans table (now derived from events)
// - Drop support for legacy session file reads
// - Archive or delete .switchboard/sessions/ directory
```

---

## Verification Plan

### Automated Tests

**[CREATE]** `src/test/kanban-database-events.test.js`:
```javascript
// Test event append and retrieval
// Test kanban column derivation from events
// Test activity log pagination
// Test migration of legacy session files
```

**[CREATE]** `src/test/cross-machine-sync.test.js`:
```javascript
// Test mergeRemoteEvents() with concurrent edits
// Test vector clock ordering
// Test activity feed consistency after merge
```

### Manual Verification

1. **Migration Test**: Open workspace with existing session files → verify events migrate to DB → verify kanban column displays correctly
2. **Dual-Write Test**: Move card in kanban → verify event written to both DB and file → verify activity feed shows change
3. **Cross-Machine Test**: Edit plan on Machine A → sync via Dropbox → open on Machine B → verify "updated by another machine" toast → verify kanban state matches
4. **Rollback Safety Test**: Delete DB → verify fallback to session files works during transition
5. **Activity Feed Test**: Verify activity feed shows history from DB instead of activity.jsonl

---

## Open Questions

| Question | Current Answer | Decision Needed |
|----------|---------------|-----------------|
| How long to keep dual-write (files + DB)? | 1-2 release cycles | Confirm timeline |
| Should we archive or delete old session files post-migration? | Archive to `.switchboard/archive/sessions/` | Confirm retention policy |
| Vector clock complexity worth it? | Simple per-session counter may suffice | Evaluate conflict frequency |
| Keep `kanban_column` in plans table as cache? | Derived on read is source of truth | Performance test on large workspaces |

---

## Implementation Phases

| Phase | Duration | Risk | Deliverable |
|-------|----------|------|-------------|
| 1. Schema migration | 1 day | Low | DB tables created, backward compatible |
| 2. Session migration | 2 days | Medium | Existing data preserved, dual-read working |
| 3. Dual-write implementation | 2 days | Medium | Events write to both, reads prefer DB |
| 4. Activity log consolidation | 1 day | Low | activity.jsonl → DB, feed working |
| 5. Cross-machine sync polish | 2 days | Medium | mtime detection, merge logic, UX |
| 6. File I/O removal | 1 day | Low | Clean up legacy session file writes |

Total: ~9 days with testing

---

## Recommendation

**Send to Lead Coder** — with the following guidance:

1. **Split into two plans before execution**: Consolidation (Phases 1-4, ~4 days) should be a standalone deliverable. Cross-machine sync (Phase 5) should be a separate follow-up plan contingent on real-world sync issues being reported.
2. **Defer vector clock implementation**: Keep the `vector_clock` column in the schema for forward compatibility but implement as no-op. Use `device_id + timestamp` ordering for now.
3. **Keep `kanban_column` as materialized cache**: Do not remove it from the `plans` table in Phase 6. Instead, update it as a cache whenever a `column_change` event is appended. This avoids the N+1 query regression.
4. **Add feature flag**: Implement `switchboard.useDbEvents` setting to allow instant rollback to file-based persistence if issues arise during dual-write transition.
5. **Audit all 74+ consumer callsites**: Before starting Phase 3, generate a complete callsite inventory and update plan with specific per-file migration notes.
6. **Sequence with other plans**: This plan must land before DuckDB Archive and DB Operations Panel plans execute, as both depend on stable schema.

---

## Review Results

**Date**: 2026-03-27
**Reviewer**: Adversarial Code Review (Grumpy Principal Engineer → Balanced Synthesis)

---

### Stage 1: Grumpy Principal Engineer Review

#### Implementation Status vs Plan

The implementation is **~30% complete**. Phase 1 (schema) is done. Everything else is scaffolding with zero integration.

| Plan Phase | Status | Detail |
|:-----------|:-------|:-------|
| Phase 1: V5 Schema | ✅ Done | `plan_events` + `activity_log` tables, indexes |
| Phase 2: Session Migration | ⚠️ Partial | `migrateSessionEvents()` exists but is NEVER CALLED |
| Phase 3: Dual-Write | ❌ Not Started | `SessionActionLog` unchanged — file-only writes |
| Phase 4: Activity Log | ❌ Not Started | `logEvent()` still writes to `activity.jsonl` |
| Phase 5: Cross-Machine Sync | ❌ Not Started (correctly deferred per recommendation) | No `mergeRemoteEvents()` |
| Phase 6: Cleanup | ❌ Not Started | `kanban_column` still in `plans` table (correct per recommendation) |

#### Findings

**[CRITICAL-1] `migrateSessionEvents()` does not await `_persist()` — silent data loss**
`KanbanDatabase.ts:1080` — `this._persist()` returns a `Promise<boolean>` but the call was fire-and-forget. The method returns a migrated count to the caller while the disk write is still in-flight. If VS Code exits or crashes, all migrated events evaporate from the in-memory sql.js database. This directly contradicts the plan's durability guarantee.
```typescript
// WAS (line 1080):
this._persist();
// SHOULD BE:
await this._persist();
```
**Status: FIXED in this review.**

**[MAJOR-1] Inline `require('os')` on every event append — module resolution on hot path**
`KanbanDatabase.ts:925,1059` — `require('os').hostname()` is called inside `appendPlanEvent()` and `migrateSessionEvents()`. While Node caches modules, calling `require()` on every single event append is sloppy — it hits the module resolution cache on a hot path that could be invoked hundreds of times during migration. This should be a top-level import.
**Status: FIXED in this review.**

**[MAJOR-2] Dead code — all new DB methods are orphaned**
`appendPlanEvent()`, `appendActivityEvent()`, `getPlanEvents()`, `getRecentActivity()`, `getRunSheet()` (DB version), `migrateSessionEvents()` — six public methods across 166 lines of code with **zero callsites** in the entire codebase. Grep confirms no file outside `KanbanDatabase.ts` references any of them. This is dead code that will bitrot silently. When someone eventually tries to wire these up, the API surface may no longer match actual consumer needs.

**[MAJOR-3] `KanbanMigration.SCHEMA_VERSION` still at 2 — schema version divergence**
`KanbanMigration.ts:19` has `SCHEMA_VERSION = 2`. But `KanbanDatabase._runMigrations()` unconditionally executes `MIGRATION_V5_SQL` (using `IF NOT EXISTS` guards). The external migration utility (`KanbanMigration`) is unaware of the V5 tables. Any code that checks `SCHEMA_VERSION` to decide whether to run migrations will believe the DB is at V2 when it's actually at V5. This is a time bomb for the DuckDB Archive plan which reads schema version.

**[MAJOR-4] No feature flag — no rollback path**
The plan's Recommendation §4 explicitly calls for `switchboard.useDbEvents` setting. Not implemented. When dual-write eventually lands, there will be no kill switch. Every user gets the new behavior or none.

**[MAJOR-5] `migrateSessionEvents()` uses raw `_db.run()` without per-row persistence**
`KanbanDatabase.ts:1061-1073` — Individual event inserts use `this._db.run()` (in-memory only), and persistence happens once at the end via a single `_persist()`. For a session with 200 events, a crash at event #150 means all 150 prior events are lost with no partial-write recovery. The plan called for "immediate flush after event append" via `_persistedUpdate`. Compare with `appendPlanEvent()` which correctly uses `_persistedUpdate`.

**[MAJOR-6] Consumer callsite audit not performed — 30+ sites still read from files**
Grep finds 15+ `log.getRunSheet()` calls in `KanbanProvider.ts` and `TaskViewerProvider.ts`, 7+ `log.getRunSheets()` calls, 9+ `log.updateRunSheet()` calls, and 2 `log.findRunSheetByPlanFile()` calls — all hitting `SessionActionLog`'s file-based methods. Zero have been updated to check the DB. This means even if events were migrated to the DB, no consumer would read them.

**[NIT-1] `getPlanEvents()` returns `any[]` — no type safety**
All new DB methods use `any` for event types. The plan defines clear event structures (`PlanEvent` interface in Phase 5 code) but the implementation uses `any` throughout.

**[NIT-2] `getRunSheet()` JSON.parse fallback swallows errors silently**
`KanbanDatabase.ts:1029-1030` — The `catch` block falls back to `{ workflow, action, timestamp }` when payload parsing fails, but doesn't log the error. Malformed payloads will silently produce degraded run sheets.

**[NIT-3] Missing `NOT NULL` on `device_id` in schema vs plan spec**
Schema has `device_id TEXT DEFAULT ''` (line 93) but plan spec says `device_id TEXT NOT NULL DEFAULT ''`. Minor — the `DEFAULT ''` means inserts without device_id get empty string either way, but `NOT NULL` constraint is missing if someone explicitly passes `NULL`.

---

### Stage 2: Balanced Synthesis

#### Valid findings that need fixing NOW

| ID | Severity | Finding | Action |
|:---|:---------|:--------|:-------|
| CRITICAL-1 | CRITICAL | Un-awaited `_persist()` in `migrateSessionEvents()` | **FIXED** — added `await` |
| MAJOR-1 | MAJOR | Inline `require('os')` | **FIXED** — moved to top-level `import * as os` |

#### Valid findings to address before Phase 3 begins

| ID | Severity | Finding | Action Needed |
|:---|:---------|:--------|:--------------|
| MAJOR-2 | MAJOR | Dead code (6 orphaned methods) | Wire up when Phase 3 starts; do NOT delete — schema+methods are the foundation |
| MAJOR-3 | MAJOR | `KanbanMigration.SCHEMA_VERSION` divergence | Update to 5 when V5 is officially "shipped" (after dual-write lands) |
| MAJOR-4 | MAJOR | No feature flag | Add `switchboard.useDbEvents` to `package.json` contributes before Phase 3 |
| MAJOR-5 | MAJOR | Batch-only persist in migration | Refactor to use `_persistedUpdate` per event, or batch with explicit `await this._persist()` after each N events |
| MAJOR-6 | MAJOR | 30+ consumer callsites un-migrated | Generate callsite inventory and plan per-file migration before Phase 3 |

#### Correctly handled / Deferred per plan recommendations

| Item | Status | Notes |
|:-----|:-------|:------|
| Vector clock as no-op | ✅ Correct | `vector_clock TEXT DEFAULT ''` in schema, no implementation — matches recommendation |
| `kanban_column` kept as materialized cache | ✅ Correct | Column remains in `plans` table — matches recommendation §3 |
| `mergeRemoteEvents()` deferred | ✅ Correct | Not implemented — matches recommendation to split into separate sync plan |
| sql.js durability addressed | ✅ Correct | `appendPlanEvent()` and `appendActivityEvent()` both use `_persistedUpdate()` which does immediate `_persist()` after every write |
| `_migrateSessionFiles()` idempotency | ✅ Correct | `migrateSessionEvents()` checks `SELECT COUNT(*) ... WHERE session_id = ?` and skips if events exist |

---

### Code Fixes Applied

| File | Change | Description |
|:-----|:-------|:------------|
| `src/services/KanbanDatabase.ts:1-5` | Added `import * as os from 'os'` | Top-level import replaces inline `require('os')` |
| `src/services/KanbanDatabase.ts:925` | `os.hostname()` | Replaced `require('os').hostname()` in `appendPlanEvent()` |
| `src/services/KanbanDatabase.ts:1059` | `os.hostname()` | Replaced `require('os').hostname()` in `migrateSessionEvents()` |
| `src/services/KanbanDatabase.ts:1080` | `await this._persist()` | Fixed fire-and-forget persist — critical data loss bug |

### Verification Results

- `npx tsc --noEmit`: ✅ **PASS** (exit code 0, no errors)

### Remaining Risks

1. **Dead code bitrot**: The 6 new methods have no callers and no tests. They will drift from actual consumer needs as the codebase evolves. Recommend adding at minimum a smoke test that calls each method.
2. **Migration durability**: `migrateSessionEvents()` still does batch-only persist (one `_persist()` at the end). A crash mid-migration loses all progress. Consider persisting every N events.
3. **Schema version gap**: `KanbanMigration.SCHEMA_VERSION` at 2 while DB is effectively at V5 creates confusion for any tooling that reads schema version.
4. **No integration tests**: Zero test coverage for any of the new event sourcing methods.
5. **Plan sequencing**: DuckDB Archive and DB Operations Panel plans must not land until this plan's Phase 3 is complete and schema is stable.
