# DuckDB Archive Database for Historical Plan Research

## Goal
Enable cross-machine access to archived plan history by storing completed/outdated plans in a DuckDB database that lives in a user-configured cloud-synced folder (e.g., Google Drive, Dropbox). This provides a shared, queryable archive across all machines while keeping the active SQLite database lightweight and compatible with sql.js's in-memory constraints.

## Metadata
**Tags:** backend, database, infrastructure
**Complexity:** High

## Problem Statement

The current Switchboard architecture faces a fundamental limitation:

1. **Local-only history**: Plans are stored in `.switchboard/kanban.db` which is gitignored. Archived plans (moved to local archive files) are also gitignored and stay on one machine.

2. **Cloud sync mismatch**: Machine A archives plans to local storage. Machine B syncs `kanban.db` via cloud but never sees A's archives. The "shared memory" concept breaks down.

3. **sql.js constraints**: Switchboard uses sql.js (WASM SQLite) which loads the entire database into memory. Large archives would cause memory bloat and slow loads.

4. **Agent research limitations**: Agents can only query active plans via `get_kanban_state`. Historical research across all past plans is impossible.

## Solution Overview

Create a **DuckDB archive database** that:
- Lives in a user-configured cloud-synced folder (outside `.switchboard/`)
- Stores completed/archived plans in columnar format (efficient for analytics)
- Supports SQL queries via DuckDB CLI for agent research
- Is periodically populated from the active SQLite database
- Does not impact the active Switchboard SQLite database performance

## User Review Required

- Confirm cloud storage path pattern (e.g., `~/GoogleDrive/SwitchboardArchives/{workspace_name}.duckdb`)
- Confirm archive trigger: automatic (on plan completion), manual command, or periodic?
- Confirm data retention: keep all history forever, or purge after N months?
- Confirm agent access: direct DuckDB CLI usage, or MCP tool wrapper?

## Complexity Audit

### Routine
- **DuckDB schema design** — Single table mirroring `plans` table structure. No migrations needed initially.
- **Export mechanism** — SELECT from SQLite, INSERT to DuckDB via DuckDB's SQLite scanner extension. ~30 lines.
- **Configuration** — Add `switchboard.archive.dbPath` setting. ~10 lines in `package.json` + config handling.

### Complex / Risky
- **Cross-database sync timing** — When to archive? On every status change (noisy), nightly (stale), or manual (user-forgot)? Needs careful UX design.
- **Conflict resolution** — Multiple machines may try to write to the same DuckDB file simultaneously. DuckDB has WAL mode but network filesystems (Google Drive FUSE) may not support proper locking.
- **DuckDB CLI dependency** — Users must install DuckDB separately. Need clear error messages when CLI is missing.

## Edge-Case & Dependency Audit

### Race Conditions
- **Archive DB locked by another process** — DuckDB on FUSE mounts may see stale locks from other machines or processes. Need retry logic with exponential backoff and a maximum retry count.
- **Cloud sync lag** — Machine B queries archive immediately after Machine A archives. The `.duckdb` file may not be synced yet. This is an **acceptable limitation** that should be documented for users.
- **Simultaneous writes from multiple machines** — Two machines completing plans at the same instant both try to INSERT into the same DuckDB file via cloud sync. DuckDB's WAL mode does not function correctly over network/FUSE filesystems. This could corrupt the archive.

### Security
- **⚠️ SQL injection via MCP tool** — The `query_plan_archive` tool accepts raw SQL from agents and passes it to `duckdb` CLI via shell `exec()`. The current mitigation (`safeSql = sql.replace(/;/g, '')`) is cosmetic — it does not prevent injection. An attacker (or hallucinating agent) could craft queries using DuckDB's `COPY`, `ATTACH`, or `.read` commands to read/write arbitrary files. This needs a proper allowlist of permitted query patterns or a read-only connection mode (`-readonly` flag at minimum).
- **Shell injection via archive path** — The `archivePath` is interpolated into a shell command string (`exec(\`duckdb "${archivePath}" ...\``). A malicious or malformed path could escape the quotes. Use `execFile()` with argument arrays instead of `exec()` with string interpolation.

### Side Effects
- **Schema drift** — If the `plans` table in SQLite adds columns (e.g., from the Consolidate Session Files plan which restructures events), the DuckDB archive schema must be updated in lockstep. Version the archive schema and add migration logic on open.
- **Huge archives** — DuckDB handles large files well, but queries over cloud-synced mounts may be slow due to random I/O. Add indexes on common query columns (status, kanban_column, created_at).
- **DuckDB CLI missing** — If the user hasn't installed DuckDB, all archive operations fail silently or with cryptic `ENOENT` errors. Need a clear diagnostic message and a health-check command.

### Dependencies & Conflicts
- **Cross-plan conflict: Consolidate Session Files** (`feature_plan_20260327_084057_consolidate_session_files_into_db.md`) — That plan **extensively modifies `KanbanDatabase.ts`** across 6 phases: adds event sourcing with `plan_events` table, removes direct `kanban_column` writes, and adds vector clock sync. This plan also modifies `KanbanDatabase.ts` to add archive triggers on status change. **Merge conflict is near-certain.** The archive trigger code assumes `updatePlanStatus()` exists in its current form, but the consolidation plan replaces it with event-driven column derivation. **Resolution**: This plan should depend on the consolidation plan completing first, then hook into the new `appendPlanEvent()` method instead.
- **Cross-plan dependency: DB Operations Panel** (`feature_plan_20260327_104342_add_database_operaitons_panel.md`) — That plan builds a UI panel that exposes archive path configuration, DuckDB CLI status, and "Export Completed Plans" buttons. It **depends on this plan's archive features existing**. Implementation order: this plan first, panel plan second.
- **External dependency: DuckDB CLI** — Not an npm package; requires separate user installation. No version pinning. Breaking changes in DuckDB CLI flags could silently break the MCP tool.
- **sql.js / DuckDB impedance mismatch** — The codebase uses sql.js (WASM SQLite in-memory). DuckDB is a completely separate engine with different SQL dialect quirks (e.g., `INSERT OR REPLACE` is SQLite syntax, not DuckDB — DuckDB uses `INSERT ... ON CONFLICT`). The schema SQL in `archiveSchema.sql` uses SQLite syntax that won't run in DuckDB.

## Adversarial Synthesis

### Grumpy Critique

Oh, wonderful. We're adding a *second* database engine to an extension that already struggles with cloud-synced SQLite files. Let me count the ways this is going to hurt.

**1. The DuckDB CLI dependency is a ticking time bomb.** You're asking VS Code extension users — who may not even know what a terminal is — to install a separate CLI binary, keep it on their PATH, and pray that the flag syntax doesn't change between versions. There's no version pinning, no bundled binary, no fallback. When DuckDB 1.3 renames `-json` to `--format json`, every Switchboard archive silently breaks and the user gets a cryptic `exec` error. "Just install DuckDB" is not a dependency management strategy, it's a hope-based architecture.

**2. The SQL injection "prevention" is a joke, and I mean that literally.** `safeSql = sql.replace(/;/g, '')` — this is the security equivalent of locking your front door but leaving every window open. DuckDB supports `COPY ... TO '/etc/passwd'`, `ATTACH 'malicious.db'`, and `.read` directives. Stripping semicolons prevents exactly nothing. You're handing an MCP tool — callable by any agent, including ones that hallucinate — a raw shell exec with user-controlled SQL. This isn't a risk, it's an *invitation*. At minimum you need `duckdb -readonly`, query pattern allowlisting, or (radical idea) don't pass raw SQL through a shell command at all.

**3. Cloud filesystem locking is a fantasy.** DuckDB's WAL mode assumes POSIX file locking. Google Drive FUSE, Dropbox smart sync, and OneDrive Files On-Demand do *not* provide POSIX locking. Two machines archiving simultaneously will either corrupt the WAL, produce a stale-lock deadlock, or silently drop writes. The plan acknowledges this in "Complex / Risky" and then... proposes "retry logic with backoff" as the fix. Retrying a fundamentally broken lock on a FUSE mount doesn't make it work; it just makes it fail slower.

**4. The schema SQL is written in the wrong dialect.** `INSERT OR REPLACE` and `CREATE INDEX ... USING GIN` are not valid DuckDB syntax. DuckDB uses `INSERT ... ON CONFLICT DO UPDATE` and doesn't have GIN indexes. The `archiveSchema.sql` file as written will fail on first execution. This suggests the plan was authored without actually testing against DuckDB.

**5. "Send to Coder" for a plan that introduces a new external runtime dependency, cross-database synchronization, cloud filesystem handling, and an MCP tool with shell injection surface?** This is Lead Coder territory at minimum. A Coder will implement the happy path, ship it, and you'll spend two sprints debugging lock files on Google Drive FUSE mounts across macOS, Windows, and Linux. This needs someone who will push back on the design before writing line one.

**6. The Consolidate Session Files plan is about to blow up your KanbanDatabase.ts integration point.** That plan replaces the current status-update model with event sourcing and vector clocks. Your archive trigger hooks into `updatePlanStatus()` — a method that won't exist in its current form after consolidation lands. If both plans are in-flight, one of them is getting a painful rebase.

### Balanced Response

The Grumpy critique is harsh but substantively correct on every point. Here's the prioritized response:

1. **SQL injection is the most urgent fix.** Before any implementation, the `query_plan_archive` tool must use `execFile()` (not `exec()`), pass the `-readonly` flag to DuckDB, and either allowlist query patterns (e.g., only `SELECT` statements matching a regex) or use parameterized queries via the DuckDB Node.js binding instead of CLI. The semicolon strip must be removed — it provides false confidence.

2. **DuckDB syntax errors are a real blocker.** The `archiveSchema.sql` must be rewritten in valid DuckDB SQL: `INSERT ... ON CONFLICT DO UPDATE`, remove the GIN index, and test the schema against an actual DuckDB instance before merging. Add a CI step that validates the schema.

3. **Cloud filesystem locking deserves a design decision, not a retry loop.** Options: (a) append-only design where each machine writes to a separate partition file and a merge query combines them, (b) use DuckDB's `ATTACH` to read multiple per-machine archives, or (c) document that concurrent writes are unsupported and archive is single-writer. Option (c) is honest and acceptable for Phase 1.

4. **The DuckDB CLI dependency should be gated.** Add a `which duckdb` health check on activation, surface a clear warning in the DB Operations Panel when it's missing, and document the install steps per platform. Long-term, consider bundling a WASM build or using the `duckdb-async` npm package to eliminate the external dependency.

5. **Cross-plan ordering must be explicit.** This plan should be sequenced *after* the Consolidate Session Files plan lands, since the integration point (`KanbanDatabase.ts` status update methods) will be restructured. The archive trigger should be designed against the *future* event-sourcing API (`appendPlanEvent()`), not the current `updatePlanStatus()`.

6. **Recommendation upgrade is warranted.** Given the external dependency, security surface, cross-database sync complexity, and cross-plan conflicts, this should be **Send to Lead Coder** with explicit guidance to resolve the SQL injection and schema dialect issues before implementation begins.

## Proposed Changes

### 1. Configuration

#### [MODIFY] `package.json`
Add new configuration option for archive path:

```json
{
  "contributes": {
    "configuration": {
      "switchboard.archive.dbPath": {
        "type": "string",
        "default": "",
        "description": "Path to DuckDB archive database (e.g., ~/GoogleDrive/SwitchboardArchives/{workspace}.duckdb). Leave empty to disable archiving."
      },
      "switchboard.archive.autoArchiveCompleted": {
        "type": "boolean",
        "default": true,
        "description": "Automatically archive plans when moved to 'COMPLETED' column"
      }
    }
  }
}
```

### 2. Archive Service

#### [CREATE] `src/services/ArchiveManager.ts`
New service class responsible for DuckDB archive operations:

```typescript
export class ArchiveManager {
    private archivePath: string | null;
    
    constructor(workspaceRoot: string) {
        const config = vscode.workspace.getConfiguration('switchboard');
        const configuredPath = config.get<string>('archive.dbPath', '');
        this.archivePath = this.resolveArchivePath(configuredPath, workspaceRoot);
    }
    
    /**
     * Archive a plan to DuckDB
     */
    async archivePlan(plan: PlanRecord): Promise<void> {
        if (!this.archivePath) return;
        
        const duckdb = await this.ensureDuckDB();
        const stmt = duckdb.prepare(`
            INSERT OR REPLACE INTO plans (
                plan_id, session_id, topic, plan_file, kanban_column,
                status, complexity, workspace_id, created_at, updated_at,
                last_action, source_type, tags, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            plan.planId, plan.sessionId, plan.topic, plan.planFile,
            plan.kanbanColumn, plan.status, plan.complexity, plan.workspaceId,
            plan.createdAt, plan.updatedAt, plan.lastAction, plan.sourceType,
            plan.tags, new Date().toISOString()
        );
        stmt.finalize();
    }
    
    /**
     * Query archived plans via DuckDB CLI
     */
    async queryArchive(sql: string): Promise<any[]> {
        if (!this.archivePath) {
            throw new Error('Archive not configured. Set switchboard.archive.dbPath');
        }
        
        return new Promise((resolve, reject) => {
            exec(`duckdb "${this.archivePath}" "${sql}" -json`, (error, stdout) => {
                if (error) reject(error);
                else resolve(JSON.parse(stdout));
            });
        });
    }
    
    private resolveArchivePath(configured: string, workspaceRoot: string): string | null {
        if (!configured) return null;
        const expanded = configured.replace(/^~/, os.homedir());
        if (expanded.includes('{workspace}')) {
            const workspaceName = path.basename(workspaceRoot);
            return expanded.replace(/{workspace}/g, workspaceName);
        }
        return path.isAbsolute(expanded) ? expanded : path.join(workspaceRoot, expanded);
    }
    
    private async ensureDuckDB(): Promise<any> {
        // Uses duckdb-async npm package or spawns CLI
        // Implementation depends on chosen approach
    }
}
```

### 3. Schema Definition

#### [CREATE] `src/services/archiveSchema.sql`
DuckDB schema for archived plans:

```sql
-- Archive schema version 1
CREATE TABLE IF NOT EXISTS plans (
    plan_id VARCHAR PRIMARY KEY,
    session_id VARCHAR NOT NULL,
    topic VARCHAR,
    plan_file VARCHAR,
    kanban_column VARCHAR,
    status VARCHAR,
    complexity VARCHAR,
    workspace_id VARCHAR NOT NULL,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    last_action VARCHAR,
    source_type VARCHAR,
    tags VARCHAR,  -- comma-separated for DuckDB simplicity
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- metadata for analysis
    days_to_completion INTEGER,  -- computed: updated_at - created_at
    revision_count INTEGER DEFAULT 1
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_complexity ON plans(complexity);
CREATE INDEX IF NOT EXISTS idx_plans_archived_at ON plans(archived_at);
CREATE INDEX IF NOT EXISTS idx_plans_tags ON plans USING GIN(tags);  -- if DuckDB supports, else regular

-- Metadata table for tracking
CREATE TABLE IF NOT EXISTS archive_metadata (
    key VARCHAR PRIMARY KEY,
    value VARCHAR,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT OR REPLACE INTO archive_metadata (key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO archive_metadata (key, value) VALUES ('created_at', CURRENT_TIMESTAMP);
```

### 4. Integration with KanbanDatabase

#### [MODIFY] `src/services/KanbanDatabase.ts`

Add archive trigger on plan status changes:

```typescript
// In updatePlanStatus or similar method
async updatePlanStatus(sessionId: string, newStatus: string, newColumn: string): Promise<void> {
    const plan = await this.getPlanBySessionId(sessionId);
    if (!plan) return;
    
    const oldStatus = plan.status;
    const oldColumn = plan.kanbanColumn;
    
    // Update SQLite
    await this.upsertPlans([{...plan, status: newStatus, kanban_column: newColumn}]);
    
    // Archive if moved to COMPLETED
    const autoArchive = this.getConfig('archive.autoArchiveCompleted', true);
    if (autoArchive && newColumn === 'COMPLETED' && oldColumn !== 'COMPLETED') {
        await this.archiveManager.archivePlan({...plan, status: newStatus, kanban_column: newColumn});
    }
}
```

### 5. MCP Tool for Agent Access

#### [MODIFY] `src/mcp-server/register-tools.js`

Add new tool `query_plan_archive`:

```javascript
server.tool(
    "query_plan_archive",
    {
        sql: z.string().describe("DuckDB SQL query (e.g., 'SELECT * FROM plans WHERE complexity = \"high\"')"),
        limit: z.number().optional().describe("Max rows to return (default 100)")
    },
    async ({ sql, limit = 100 }) => {
        const workspaceRoot = getWorkspaceRoot();
        const archivePath = getArchivePath(workspaceRoot);  // from config
        
        if (!archivePath) {
            return { isError: true, content: [{ type: "text", text: "Archive not configured" }] };
        }
        
        if (!fs.existsSync(archivePath)) {
            return { content: [{ type: "text", text: "No archive found. Complete some plans first." }] };
        }
        
        const safeSql = sql.replace(/;/g, '');  // basic injection prevention
        const limitedSql = `${safeSql} LIMIT ${limit}`;
        
        try {
            const { stdout } = await execAsync(`duckdb "${archivePath}" "${limitedSql}" -json`);
            const results = JSON.parse(stdout);
            return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
        } catch (e) {
            return { isError: true, content: [{ type: "text", text: `Query failed: ${e.message}` }] };
        }
    }
);
```

### 6. Command Palette Integration

#### [MODIFY] `package.json` contributes.commands

```json
{
  "command": "switchboard.archiveCurrentPlan",
  "title": "Switchboard: Archive Current Plan"
},
{
  "command": "switchboard.queryArchive",
  "title": "Switchboard: Query Plan Archive"
},
{
  "command": "switchboard.exportAllToArchive",
  "title": "Switchboard: Export All Completed Plans to Archive"
}
```

## Verification Plan

### Automated Tests

#### [CREATE] `src/test/archive-manager.test.ts`

```typescript
describe('ArchiveManager', () => {
    it('should resolve workspace name in path template', () => {
        const manager = new ArchiveManager('/home/user/projects/my-app');
        const path = manager.resolveArchivePath(
            '~/GoogleDrive/SwitchboardArchives/{workspace}.duckdb',
            '/home/user/projects/my-app'
        );
        expect(path).toBe('~/GoogleDrive/SwitchboardArchives/my-app.duckdb');
    });
    
    it('should skip archiving if not configured', async () => {
        const manager = new ArchiveManager('/tmp/test');
        // No config set
        await expect(manager.archivePlan(mockPlan)).resolves.not.toThrow();
    });
});
```

### Manual Tests

1. **Configuration**: Set `switchboard.archive.dbPath` to `~/GoogleDrive/SwitchboardArchives/{workspace}.duckdb`
2. **First archive**: Complete a plan → verify `.duckdb` file created in Google Drive folder
3. **Cross-machine sync**: On second machine, install DuckDB CLI, query archive:
   ```bash
   duckdb ~/GoogleDrive/SwitchboardArchives/my-project.duckdb "SELECT * FROM plans"
   ```
4. **Agent access**: Call MCP tool `query_plan_archive` with SQL → verify results
5. **Conflict test**: Archive from two machines simultaneously → verify one succeeds, other retries

## Open Questions

1. **DuckDB Node.js vs CLI?** 
   - Option A: Use `duckdb` npm package (native dependency, harder to bundle)
   - Option B: Require DuckDB CLI installed separately (simpler, but extra install step)
   
2. **Automatic vs Manual Archiving?**
   - Auto: Every completed plan immediately archived (simpler, more network writes)
   - Manual: User triggers archive (less noise, risk of forgetting)
   - Periodic: Nightly batch export (best of both, needs scheduler)

3. **Purge Strategy?**
   - Keep forever (simple, grows unbounded)
   - Archive after N days (complexity)
   - Manual deletion only (safest)

## Recommendation

**Phase 1**: CLI-based, manual archive trigger, keep forever
- Easiest to implement
- No native dependencies
- Users opt-in by installing DuckDB and setting path

**Phase 2**: Add auto-archive, Node.js DuckDB binding, purge rules
- After proving the concept

## Files Changed Summary

| File | Change |
|------|--------|
| `package.json` | Add `archive.dbPath` and `archive.autoArchiveCompleted` config |
| `src/services/ArchiveManager.ts` | **NEW** — Archive operations service |
| `src/services/archiveSchema.sql` | **NEW** — DuckDB schema definition |
| `src/services/KanbanDatabase.ts` | Integrate archive calls on plan completion |
| `src/mcp-server/register-tools.js` | Add `query_plan_archive` MCP tool |

## Agent Recommendation

**Send to Lead Coder** — This plan introduces a new external runtime dependency (DuckDB CLI), cross-database synchronization over cloud filesystems, an MCP tool with shell injection surface area, and has confirmed merge conflicts with the in-flight Consolidate Session Files plan. A Lead Coder must resolve the SQL injection vulnerability, validate the DuckDB SQL dialect, establish cross-plan sequencing, and make a design decision on cloud filesystem locking before implementation begins. A standard Coder assignment risks shipping the happy path without addressing these structural issues.
