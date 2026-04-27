import * as fs from 'fs';
import * as crypto from 'crypto';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';

export type KanbanPlanStatus = 'active' | 'archived' | 'completed' | 'deleted';

export interface KanbanPlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    status: KanbanPlanStatus;
    complexity: string; // 'Unknown' or string integer '1'-'10'
    tags: string;
    dependencies: string;
    repoScope: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: 'local' | 'brain' | 'clickup-automation' | 'linear-automation';
    brainSourcePath: string;
    mirrorPath: string;
    routedTo: string;        // agent role dispatched to: 'lead' | 'coder' | 'intern' | ''
    dispatchedAgent: string; // terminal/tool name: 'claude cli', 'copilot cli', etc.
    dispatchedIde: string;   // IDE name: 'Visual Studio Code', 'Cursor', 'Windsurf', etc.
    clickupTaskId?: string;
    linearIssueId?: string;
}

type SqlJsDatabase = {
    exec: (sql: string) => void;
    run: (sql: string, params?: unknown[]) => void;
    prepare: (sql: string, params?: unknown[]) => {
        step: () => boolean;
        getAsObject: () => Record<string, unknown>;
        free: () => void;
    };
    export: () => Uint8Array;
    close?: () => void;
};

type SqlJsStatic = {
    Database: new (data?: Uint8Array) => SqlJsDatabase;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plans (
    plan_id       TEXT PRIMARY KEY,
    session_id    TEXT UNIQUE NOT NULL,
    topic         TEXT NOT NULL,
    plan_file     TEXT,
    kanban_column TEXT NOT NULL DEFAULT 'CREATED',
    status        TEXT NOT NULL DEFAULT 'active',
    complexity    TEXT DEFAULT 'Unknown',
    tags          TEXT DEFAULT '',
    dependencies  TEXT DEFAULT '',
    repo_scope    TEXT DEFAULT '',
    workspace_id  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_action   TEXT,
    source_type   TEXT DEFAULT 'local',
    brain_source_path TEXT DEFAULT '',
    mirror_path       TEXT DEFAULT '',
    routed_to         TEXT DEFAULT '',
    dispatched_agent  TEXT DEFAULT '',
    dispatched_ide    TEXT DEFAULT '',
    clickup_task_id   TEXT DEFAULT '',
    linear_issue_id   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

// Migration SQL to add new columns to existing databases
const MIGRATION_V2_SQL = [
    `ALTER TABLE plans ADD COLUMN brain_source_path TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN mirror_path TEXT DEFAULT ''`,
];
const MIGRATION_V2_CONFIG_TABLE = `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
const MIGRATION_V2_STATUS_INDEX = `CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)`;

const MIGRATION_V4_SQL = [
    `ALTER TABLE plans ADD COLUMN tags TEXT DEFAULT ''`,
];

const MIGRATION_V5_SQL = [
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

const MIGRATION_V6_SQL = [
    `ALTER TABLE plans ADD COLUMN dependencies TEXT DEFAULT ''`,
];

const MIGRATION_V7_SQL = [
    `ALTER TABLE plans ADD COLUMN routed_to TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN dispatched_agent TEXT DEFAULT ''`,
    `ALTER TABLE plans ADD COLUMN dispatched_ide TEXT DEFAULT ''`,
];

const MIGRATION_V9_SQL = [
    `ALTER TABLE plans ADD COLUMN clickup_task_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)`,
];

const MIGRATION_V12_SQL = [
    `ALTER TABLE plans ADD COLUMN linear_issue_id TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)`,
];

const MIGRATION_V13_SQL = [
    `ALTER TABLE plans ADD COLUMN repo_scope TEXT DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS idx_plans_repo_scope ON plans(workspace_id, repo_scope)`,
];

const MIGRATION_V14_SQL = [
    `CREATE TABLE IF NOT EXISTS kanban_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )`,
];

/**
 * Generic plan upsert. On conflict, updates metadata fields and allows the
 * narrow deleted -> active recovery needed when a live local plan file is
 * re-imported after a false tombstone. Use updateStatus() and updateColumn()
 * for explicit lifecycle or kanban transitions in all other cases.
 */
const UPSERT_PLAN_SQL = `
INSERT INTO plans (
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
    repo_scope, workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
    clickup_task_id, linear_issue_id
 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(plan_id) DO UPDATE SET
    session_id = excluded.session_id,
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    status = CASE
        WHEN status = 'deleted' AND excluded.status = 'active' THEN excluded.status
        ELSE status
    END,
    complexity = excluded.complexity,
    tags = excluded.tags,
    dependencies = excluded.dependencies,
    repo_scope = excluded.repo_scope,
    workspace_id = excluded.workspace_id,
    updated_at = excluded.updated_at,
    last_action = excluded.last_action,
    source_type = excluded.source_type,
    brain_source_path = excluded.brain_source_path,
    mirror_path = excluded.mirror_path,
    routed_to = excluded.routed_to,
    dispatched_agent = excluded.dispatched_agent,
    dispatched_ide = excluded.dispatched_ide,
    clickup_task_id = excluded.clickup_task_id,
    linear_issue_id = excluded.linear_issue_id
`;

const MIGRATION_VERSION_KEY = 'kanban_db_migration_version';
const ORPHAN_PURGE_CONFIRMATION_DELAY_MS = 350;

const PLAN_COLUMNS = `plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
                       repo_scope, workspace_id, created_at, updated_at, last_action, source_type,
                       brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                       clickup_task_id, linear_issue_id`;

const runtimeRequire = createRequire(__filename);

export const VALID_KANBAN_COLUMNS = new Set([
    'CREATED', 'BACKLOG', 'PLAN REVIEWED', 'CONTEXT GATHERER', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED', 'COMPLETED'
]);
// VALID_COMPLEXITIES is now handled by isValidComplexityValue() in complexityScale.ts
const VALID_STATUSES = new Set(['active', 'archived', 'completed', 'deleted']);

// Allow built-in columns plus custom agent columns (alphanumeric, underscores, spaces)
const SAFE_COLUMN_NAME_RE = /^[a-zA-Z0-9 _-]{1,128}$/;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KanbanDatabase {
    private static _instances = new Map<string, KanbanDatabase>();
    private static _sqlJsPromise: Promise<SqlJsStatic> | null = null;

    public static forWorkspace(workspaceRoot: string, customDbPath?: string): KanbanDatabase {
        const stable = path.resolve(workspaceRoot);
        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            return existing;
        }

        // Resolve the DB path — either from explicit parameter, VS Code setting, or default
        let resolvedDbPath: string;
        if (customDbPath !== undefined && customDbPath.trim() !== '') {
            const trimmed = customDbPath.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(require('os').homedir(), trimmed.slice(1))
                : trimmed;
            resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(stable, expanded);
        } else {
            // Try reading from VS Code settings (safe to fail outside extension host)
            let settingValue = '';
            try {
                const vscode = require('vscode');
                settingValue = String(vscode.workspace.getConfiguration('switchboard').get('kanban.dbPath') || '').trim();
            } catch {
                // Outside extension host (e.g. unit tests) — use default
            }
            if (settingValue) {
                const expanded = settingValue.startsWith('~')
                    ? path.join(require('os').homedir(), settingValue.slice(1))
                    : settingValue;
                resolvedDbPath = path.isAbsolute(expanded) ? expanded : path.join(stable, expanded);
            } else {
                resolvedDbPath = path.join(stable, '.switchboard', 'kanban.db');
            }
        }

        const created = new KanbanDatabase(stable, resolvedDbPath);
        KanbanDatabase._instances.set(stable, created);
        return created;
    }

    /**
     * Invalidate the cached DB instance for a workspace, forcing re-creation
     * on the next forWorkspace() call. Used when kanban.dbPath setting changes.
     * Drains any in-flight writes before tearing down to prevent silent data loss.
     */
    public static async invalidateWorkspace(workspaceRoot: string): Promise<void> {
        const stable = path.resolve(workspaceRoot);
        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            // Drain in-flight writes before nulling _db to prevent silent data loss
            try { await existing._writeTail; } catch { /* swallow — chain keeps alive internally */ }
            existing._db = null;
            existing._initPromise = null;
            KanbanDatabase._instances.delete(stable);
            console.log(`[KanbanDatabase] Invalidated cached instance for ${stable}`);
        }
    }

    /**
     * Validates a potential database path. Checks for directory existence and resolve errors.
     */
    public static validatePath(dbPath: string): { valid: boolean; error?: string } {
        if (!dbPath || dbPath.trim() === '') {
            return { valid: false, error: 'Path cannot be empty.' };
        }
        try {
            const trimmed = dbPath.trim();
            const expanded = trimmed.startsWith('~')
                ? path.join(os.homedir(), trimmed.slice(1))
                : trimmed;
            const absolute = path.resolve(expanded);
            const dir = path.dirname(absolute);
            if (!fs.existsSync(dir)) {
                return { valid: false, error: `Parent directory does not exist: ${dir}` };
            }
            // Basic check for permissions if directory exists
            try {
                fs.accessSync(dir, fs.constants.W_OK);
            } catch {
                return { valid: false, error: `Directory is not writable: ${dir}` };
            }
            return { valid: true };
        } catch (e: any) {
            return { valid: false, error: e.message };
        }
    }

    private static _migrationInProgress = false;

    /**
     * Migrate data from sourcePath to targetPath if target is empty/missing and source has plans.
     * Returns migration result. Safe to call even if source/target don't exist.
     */
    public static async migrateIfNeeded(
        sourcePath: string,
        targetPath: string
    ): Promise<{ migrated: boolean; skipped: string | null }> {
        if (path.resolve(sourcePath) === path.resolve(targetPath)) {
            return { migrated: false, skipped: 'same_path' };
        }
        if (KanbanDatabase._migrationInProgress) {
            return { migrated: false, skipped: 'migration_in_progress' };
        }
        KanbanDatabase._migrationInProgress = true;
        try {
            if (!fs.existsSync(sourcePath)) {
                return { migrated: false, skipped: 'source_not_found' };
            }
            const sourceHasPlans = await KanbanDatabase.dbFileHasPlans(sourcePath);
            if (!sourceHasPlans) {
                return { migrated: false, skipped: 'source_empty' };
            }

            if (fs.existsSync(targetPath)) {
                const targetHasPlans = await KanbanDatabase.dbFileHasPlans(targetPath);
                if (targetHasPlans) {
                    return { migrated: false, skipped: 'target_has_data' };
                }
            }

            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
            console.log(`[KanbanDatabase] Migrated DB from ${sourcePath} to ${targetPath}`);

            const backupPath = `${sourcePath}.backup.${Date.now()}`;
            await fs.promises.rename(sourcePath, backupPath);
            console.log(`[KanbanDatabase] Source backed up to ${backupPath}`);

            return { migrated: true, skipped: null };
        } catch (error) {
            console.error('[KanbanDatabase] Migration failed:', error);
            return { migrated: false, skipped: `error: ${error instanceof Error ? error.message : String(error)}` };
        } finally {
            KanbanDatabase._migrationInProgress = false;
        }
    }

    /**
     * Open a DB file read-only and check if it contains any active plans.
     * Returns false if file is missing, corrupt, or has no plans.
     */
    public static async dbFileHasPlans(dbPath: string): Promise<boolean> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            const buffer = await fs.promises.readFile(dbPath);
            const db = new SQL.Database(new Uint8Array(buffer));
            try {
                const stmt = db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (stmt.step()) {
                    const count = Number(stmt.getAsObject().cnt);
                    stmt.free();
                    return count > 0;
                }
                stmt.free();
                return false;
            } finally {
                if (db.close) { db.close(); }
            }
        } catch {
            return false;
        }
    }

    /**
     * Count active plans in a DB file. Returns 0 on error.
     */
    public static async countPlansInFile(dbPath: string): Promise<number> {
        try {
            const SQL = await KanbanDatabase._loadSqlJs();
            const buffer = await fs.promises.readFile(dbPath);
            const db = new SQL.Database(new Uint8Array(buffer));
            try {
                const stmt = db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (stmt.step()) {
                    const count = Number(stmt.getAsObject().cnt);
                    stmt.free();
                    return count;
                }
                stmt.free();
                return 0;
            } finally {
                if (db.close) { db.close(); }
            }
        } catch {
            return 0;
        }
    }

    /**
     * Merge active plans from source DB into target DB. Conflicts resolved by newest updated_at.
     * Returns number of plans merged. Backs up source after successful merge.
     */
    public static async reconcileDatabases(sourcePath: string, targetPath: string): Promise<number> {
        const SQL = await KanbanDatabase._loadSqlJs();
        const srcBuf = await fs.promises.readFile(sourcePath);
        const tgtBuf = await fs.promises.readFile(targetPath);
        const srcDb = new SQL.Database(new Uint8Array(srcBuf));
        const tgtDb = new SQL.Database(new Uint8Array(tgtBuf));

        try {
            // Get column names from BOTH databases and use the intersection
            // to handle schema version mismatches safely
            const srcColStmt = srcDb.prepare("PRAGMA table_info(plans)");
            const srcColumns = new Set<string>();
            while (srcColStmt.step()) {
                srcColumns.add(String(srcColStmt.getAsObject().name));
            }
            srcColStmt.free();

            const tgtColStmt = tgtDb.prepare("PRAGMA table_info(plans)");
            const tgtColumns = new Set<string>();
            while (tgtColStmt.step()) {
                tgtColumns.add(String(tgtColStmt.getAsObject().name));
            }
            tgtColStmt.free();

            // Only use columns that exist in both databases
            const columns = [...srcColumns].filter(c => tgtColumns.has(c));
            if (columns.length === 0) return 0;

            const planIdCol = 'plan_id';
            const updatedAtCol = 'updated_at';

            // Read all active plans from source using getAsObject
            const srcStmt = srcDb.prepare("SELECT * FROM plans WHERE status = 'active'");
            const srcRows: Record<string, unknown>[] = [];
            while (srcStmt.step()) {
                srcRows.push(srcStmt.getAsObject());
            }
            srcStmt.free();
            if (srcRows.length === 0) return 0;

            tgtDb.run('BEGIN TRANSACTION');
            let merged = 0;
            try {
                for (const srcRow of srcRows) {
                    const planId = String(srcRow[planIdCol] ?? '');
                    // Check if target has this plan with a newer updated_at
                    const chkStmt = tgtDb.prepare("SELECT updated_at FROM plans WHERE plan_id = ?", [planId]);
                    let skip = false;
                    if (chkStmt.step()) {
                        const tgtUpdated = String(chkStmt.getAsObject().updated_at);
                        const srcUpdated = String(srcRow[updatedAtCol] ?? '');
                        if (srcUpdated <= tgtUpdated) skip = true;
                    }
                    chkStmt.free();
                    if (skip) continue;

                    // Build ordered values array from the intersection columns
                    const values = columns.map(c => srcRow[c] ?? null);
                    const placeholders = columns.map(() => '?').join(', ');
                    tgtDb.run(`INSERT OR REPLACE INTO plans (${columns.join(', ')}) VALUES (${placeholders})`, values);
                    merged++;
                }
                tgtDb.run('COMMIT');
            } catch (txErr) {
                try { tgtDb.run('ROLLBACK'); } catch { /* best effort */ }
                throw txErr;
            }

            // Persist target
            const data = tgtDb.export();
            const tmpPath = targetPath + '.tmp.' + Date.now();
            await fs.promises.writeFile(tmpPath, Buffer.from(data));
            await fs.promises.rename(tmpPath, targetPath);

            // Backup source
            const backupPath = `${sourcePath}.backup.${Date.now()}`;
            await fs.promises.rename(sourcePath, backupPath);

            return merged;
        } finally {
            if (srcDb.close) { srcDb.close(); }
            if (tgtDb.close) { tgtDb.close(); }
        }
    }

    /**
     * Returns the default local DB path for a workspace.
     */
    public static defaultDbPath(workspaceRoot: string): string {
        return path.join(path.resolve(workspaceRoot), '.switchboard', 'kanban.db');
    }

    private readonly _dbPath: string;
    private _db: SqlJsDatabase | null = null;
    private _initPromise: Promise<boolean> | null = null;
    private _lastInitError: string | null = null;
    private _writeTail: Promise<void> = Promise.resolve();
    private _loadedMtime: number = 0;       // mtimeMs of kanban.db when last loaded into memory
    private _lastStatCheckMs: number = 0;   // Date.now() of last fs.stat() call (debounce)
    private static readonly STAT_DEBOUNCE_MS = 500; // Don't re-stat more often than this
    private static _lastLoadedMtimes = new Map<string, number>();

    private constructor(private readonly _workspaceRoot: string, resolvedDbPath: string) {
        this._dbPath = resolvedDbPath;
    }

    public get lastInitError(): string | null {
        return this._lastInitError;
    }

    public get dbPath(): string {
        return this._dbPath;
    }

    public async ensureReady(forceReload: boolean = false): Promise<boolean> {
        if (this._db) {
            // Check if another IDE has modified the DB file since we loaded it
            await this._reloadIfStale(forceReload);
            return true;
        }
        if (!this._initPromise) {
            this._initPromise = this._initialize().then((ready) => {
                if (!ready) {
                    this._initPromise = null;
                }
                return ready;
            });
        }
        return this._initPromise;
    }

    public async refreshFromDisk(forceReload: boolean = true): Promise<boolean> {
        if (!this._db) {
            return this.ensureReady(forceReload);
        }
        await this._reloadIfStale(forceReload);
        return true;
    }

    public async getMigrationVersion(): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        const stmt = this._db.prepare('SELECT value FROM migration_meta WHERE key = ? LIMIT 1', [MIGRATION_VERSION_KEY]);
        try {
            if (!stmt.step()) return 0;
            const row = stmt.getAsObject();
            const parsed = Number(row.value ?? 0);
            return Number.isFinite(parsed) ? parsed : 0;
        } finally {
            stmt.free();
        }
    }

    public async setMigrationVersion(version: number): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run('INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MIGRATION_VERSION_KEY, String(version)]);
        return this._persist();
    }

    public async upsertPlans(records: KanbanPlanRecord[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (records.length === 0) return true;

        this._db.run('BEGIN');
        try {
            for (const record of records) {
                this._db.run(UPSERT_PLAN_SQL, [
                    record.planId,        // 1
                    record.sessionId,     // 2
                    record.topic,         // 3
                    this._normalizePath(record.planFile), // 4
                    record.kanbanColumn,  // 5
                    record.status,        // 6
                    record.complexity,    // 7
                    record.tags || '',    // 8
                    record.dependencies || '', // 9
                    record.repoScope || '', // 10
                    record.workspaceId,   // 11
                    record.createdAt,     // 12
                    record.updatedAt,     // 13
                    record.lastAction,    // 14
                    record.sourceType,    // 15
                    this._normalizePath(record.brainSourcePath), // 16
                    this._normalizePath(record.mirrorPath), // 17
                    record.routedTo || '',       // 18
                    record.dispatchedAgent || '', // 19
                    record.dispatchedIde || '',   // 20
                    record.clickupTaskId || '',   // 21
                    record.linearIssueId || ''    // 22
                ]);
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to upsert records:', error);
            return false;
        }
        return this._persist();
    }

    public async hasActivePlans(workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            'SELECT 1 FROM plans WHERE workspace_id = ? AND status = ? LIMIT 1',
            [workspaceId, 'active']
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    public async hasPlan(sessionId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE session_id = ? LIMIT 1', [sessionId]);
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    public async updateColumn(sessionId: string, newColumn: string): Promise<boolean> {
        if (!VALID_KANBAN_COLUMNS.has(newColumn) && !SAFE_COLUMN_NAME_RE.test(newColumn)) {
            console.error(`[KanbanDatabase] Rejected invalid column name: ${newColumn}`);
            return false;
        }
        console.log(`[KanbanDatabase] updateColumn: sessionId=${sessionId}, newColumn=${newColumn}`);
        const result = await this._persistedUpdate(
            'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?',
            [newColumn, new Date().toISOString(), sessionId]
        );
        // Verify the update took effect
        if (this._db) {
            try {
                const stmt = this._db.prepare('SELECT kanban_column FROM plans WHERE session_id = ?', [sessionId]);
                if (stmt.step()) {
                    const row = stmt.getAsObject();
                    console.log(`[KanbanDatabase] updateColumn VERIFY: sessionId=${sessionId}, column now=${row.kanban_column}`);
                } else {
                    console.warn(`[KanbanDatabase] updateColumn VERIFY: sessionId=${sessionId} NOT FOUND in DB`);
                }
                stmt.free();
            } catch (e) {
                console.error(`[KanbanDatabase] updateColumn VERIFY failed:`, e);
            }
        }
        return result;
    }

    /**
     * Returns the stored plan_file path for a given session ID, or null if not found.
     * Used by the kanban state write hook to locate the plan file for state section updates.
     */
    async getPlanFilePath(sessionId: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) {
            return null;
        }
        const stmt = this._db.prepare('SELECT plan_file FROM plans WHERE session_id = ?', [sessionId]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return (row.plan_file as string) || null;
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    public async updateComplexity(sessionId: string, complexity: string): Promise<boolean> {
        // Import or use local validation to avoid circular dependency if possible, 
        // but here we are in a central service.
        const { isValidComplexityValue } = require('./complexityScale');
        if (!isValidComplexityValue(complexity)) {
            console.error(`[KanbanDatabase] Rejected invalid complexity value: ${complexity}`);
            return false;
        }
        return this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE session_id = ?',
            [complexity, new Date().toISOString(), sessionId]
        );
    }

    public async updateTags(sessionId: string, tags: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET tags = ?, updated_at = ? WHERE session_id = ?',
            [tags, new Date().toISOString(), sessionId]
        );
    }

    public async updateDependencies(sessionId: string, dependencies: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET dependencies = ?, updated_at = ? WHERE session_id = ?',
            [dependencies, new Date().toISOString(), sessionId]
        );
    }

    public async getMeta(key: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT value FROM kanban_meta WHERE key = ?', [key]);
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                return String(row.value ?? '');
            }
            return null;
        } finally {
            stmt.free();
        }
    }

    public async setMeta(key: string, value: string): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO kanban_meta(key, value) VALUES(?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [key, value]
        );
    }

    public async getDependencyStatus(
        dependenciesCsv: string
    ): Promise<Array<{ planId: string; sessionId: string; topic: string; column: string; ready: boolean }>> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const deps = dependenciesCsv.split(',').map(d => d.trim()).filter(Boolean);
        if (deps.length === 0) return [];

        const results: Array<{ planId: string; sessionId: string; topic: string; column: string; ready: boolean }> = [];
        for (const depId of deps) {
            const stmt = this._db.prepare(
                `SELECT plan_id, session_id, topic, kanban_column FROM plans
                 WHERE plan_id = ? OR session_id = ? OR LOWER(topic) = LOWER(?)
                 LIMIT 1`,
                [depId, depId, depId]
            );
            if (stmt.step()) {
                const row = stmt.getAsObject();
                const column = String(row.kanban_column || 'CREATED');
                results.push({
                    planId: String(row.plan_id || depId),
                    sessionId: String(row.session_id || ''),
                    topic: String(row.topic || depId),
                    column,
                    ready: column === 'COMPLETED' || column === 'CODE REVIEWED'
                });
            } else {
                results.push({ planId: depId, sessionId: '', topic: depId, column: 'UNKNOWN', ready: true });
            }
            stmt.free();
        }
        return results;
    }

    public async updateStatus(sessionId: string, status: KanbanPlanStatus): Promise<boolean> {
        if (!VALID_STATUSES.has(status)) {
            console.error(`[KanbanDatabase] Rejected invalid status value: ${status}`);
            return false;
        }
        return this._persistedUpdate(
            'UPDATE plans SET status = ?, updated_at = ? WHERE session_id = ?',
            [status, new Date().toISOString(), sessionId]
        );
    }

    public async reviveDeletedPlans(sessionIds: string[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const uniqueSessionIds = [...new Set(
            sessionIds
                .map((sessionId) => String(sessionId || '').trim())
                .filter((sessionId) => sessionId.length > 0)
        )];
        if (uniqueSessionIds.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const sessionId of uniqueSessionIds) {
                this._db.run(
                    "UPDATE plans SET status = 'active', updated_at = ? WHERE session_id = ? AND status = 'deleted'",
                    [now, sessionId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to revive deleted plans:', error);
            return false;
        }
        return this._persist();
    }

    public async updateLastAction(sessionId: string, lastAction: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET last_action = ?, updated_at = ? WHERE session_id = ?',
            [lastAction, new Date().toISOString(), sessionId]
        );
    }

    public async updateTopic(sessionId: string, topic: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET topic = ?, updated_at = ? WHERE session_id = ?',
            [topic, new Date().toISOString(), sessionId]
        );
    }

    public async updatePlanFile(sessionId: string, planFile: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET plan_file = ?, updated_at = ? WHERE session_id = ?',
            [this._normalizePath(planFile), new Date().toISOString(), sessionId]
        );
    }

    public async updateLinearIssueId(sessionId: string, linearIssueId: string): Promise<boolean> {
        const normalizedIssueId = String(linearIssueId || '').trim();
        const persisted = await this._persistedUpdate(
            'UPDATE plans SET linear_issue_id = ?, updated_at = ? WHERE session_id = ?',
            [normalizedIssueId, new Date().toISOString(), sessionId]
        );
        if (!persisted) {
            return false;
        }

        const updatedPlan = await this.getPlanBySessionId(sessionId);
        if (!updatedPlan) {
            console.error(`[KanbanDatabase] Failed to update linear_issue_id for missing session ${sessionId}.`);
            return false;
        }
        if (String(updatedPlan.linearIssueId || '').trim() !== normalizedIssueId) {
            console.error(
                `[KanbanDatabase] Failed to verify linear_issue_id update for session ${sessionId}. ` +
                `Expected "${normalizedIssueId}", found "${String(updatedPlan.linearIssueId || '').trim()}".`
            );
            return false;
        }
        return true;
    }

    public async deletePlan(sessionId: string): Promise<boolean> {
        return this._persistedUpdate(
            'DELETE FROM plans WHERE session_id = ?',
            [sessionId]
        );
    }

    public async getBoard(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active'
             ORDER BY updated_at DESC`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }

    public async getBoardFiltered(workspaceId: string, repoScope: string | null): Promise<KanbanPlanRecord[]> {
        if (!repoScope) {
            return this.getBoard(workspaceId);
        }
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND repo_scope IN (?, '')
             ORDER BY updated_at DESC`,
            [workspaceId, repoScope]
        );
        return this._readRows(stmt);
    }

    public async getPlansByColumn(workspaceId: string, column: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'active' AND kanban_column = ?
             ORDER BY updated_at ASC`,
            [workspaceId, column]
        );
        return this._readRows(stmt);
    }

    public async getCompletedPlans(workspaceId: string, limit: number = 100): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed'
             ORDER BY updated_at DESC
             LIMIT ?`,
            [workspaceId, limit]
        );
        return this._readRows(stmt);
    }

    public async getCompletedPlansFiltered(
        workspaceId: string,
        repoScope: string | null,
        limit: number = 100
    ): Promise<KanbanPlanRecord[]> {
        if (!repoScope) {
            return this.getCompletedPlans(workspaceId, limit);
        }
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ? AND status = 'completed' AND repo_scope IN (?, '')
             ORDER BY updated_at DESC
             LIMIT ?`,
            [workspaceId, repoScope, limit]
        );
        return this._readRows(stmt);
    }

    public async getPlanBySessionId(sessionId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE session_id = ? LIMIT 1`,
            [sessionId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async findPlanByClickUpTaskId(
        workspaceId: string,
        clickupTaskId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalizedTaskId = String(clickupTaskId || '').trim();
        if (!normalizedTaskId) {
            return null;
        }

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ?
               AND clickup_task_id = ?
               AND status != 'deleted'
              ORDER BY updated_at DESC
              LIMIT 1`,
            [workspaceId, normalizedTaskId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async findPlanByLinearIssueId(
        workspaceId: string,
        linearIssueId: string
    ): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalizedIssueId = String(linearIssueId || '').trim();
        if (!normalizedIssueId) {
            return null;
        }

        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE workspace_id = ?
               AND linear_issue_id = ?
               AND status != 'deleted'
             ORDER BY updated_at DESC
             LIMIT 1`,
            [workspaceId, normalizedIssueId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByPlanId(planId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE plan_id = ? LIMIT 1`,
            [planId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByPlanFile(planFile: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const normalized = this._normalizePath(planFile);
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE plan_file = ? AND workspace_id = ?
             ORDER BY CASE status
                WHEN 'active' THEN 0
                WHEN 'completed' THEN 1
                WHEN 'archived' THEN 2
                WHEN 'deleted' THEN 3
                ELSE 4
             END,
             updated_at DESC
             LIMIT 1`,
            [normalized, workspaceId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    public async getPlanByTopic(topic: string, workspaceId: string): Promise<KanbanPlanRecord | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans
             WHERE LOWER(topic) = LOWER(?)
               AND workspace_id = ?
               AND status = 'active'
             LIMIT 1`,
            [topic, workspaceId]
        );
        const rows = this._readRows(stmt);
        return rows.length > 0 ? rows[0] : null;
    }

    /** Returns all session IDs in the DB (any status) in a single query. */
    public async getSessionIdSet(): Promise<Set<string>> {
        if (!(await this.ensureReady()) || !this._db) return new Set();
        const stmt = this._db.prepare('SELECT session_id FROM plans');
        const ids = new Set<string>();
        try {
            while (stmt.step()) {
                ids.add(String(stmt.getAsObject().session_id));
            }
        } finally {
            stmt.free();
        }
        return ids;
    }

    /**
     * Batch-update topic, planFile, and (optionally) complexity, tags, and dependencies
     * for multiple plans in one transaction + persist.
     *
     * @param options.preserveTimestamps - Pass `true` for background/system operations
     *   (e.g. self-healing complexity or tags). Pass `false` (or omit) ONLY for genuine
     *   user-initiated actions that should update the "last edited" timestamp.
     */
    public async updateMetadataBatch(updates: Array<{
        sessionId: string;
        topic: string;
        planFile: string;
        complexity?: string;
        tags?: string;
        dependencies?: string;
        repoScope?: string;
    }>, options?: { preserveTimestamps?: boolean }): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (updates.length === 0) return true;

        this._db.run('BEGIN');
        try {
            for (const u of updates) {
                const setClauses = ['topic = ?', 'plan_file = ?'];
                const params: unknown[] = [u.topic, this._normalizePath(u.planFile)];

                if (!options?.preserveTimestamps) {
                    const now = new Date().toISOString();
                    setClauses.push('updated_at = ?');
                    params.push(now);
                }

                if (u.complexity && u.complexity !== 'Unknown') {
                    setClauses.push('complexity = ?');
                    params.push(u.complexity);
                }
                if (typeof u.tags === 'string') {
                    setClauses.push('tags = ?');
                    params.push(u.tags);
                }
                if (typeof u.dependencies === 'string') {
                    setClauses.push('dependencies = ?');
                    params.push(u.dependencies);
                }
                if (typeof u.repoScope === 'string') {
                    setClauses.push('repo_scope = ?');
                    params.push(u.repoScope);
                }

                params.push(u.sessionId);
                this._db.run(
                    `UPDATE plans SET ${setClauses.join(', ')} WHERE session_id = ?`,
                    params
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch update metadata:', error);
            return false;
        }
        return this._persist();
    }

    /** Batch-complete multiple plans in one transaction + persist. */
    public async completeMultiple(sessionIds: string[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        if (sessionIds.length === 0) return true;

        const now = new Date().toISOString();
        this._db.run('BEGIN');
        try {
            for (const sessionId of sessionIds) {
                this._db.run(
                    'UPDATE plans SET status = ?, kanban_column = ?, updated_at = ? WHERE session_id = ?',
                    ['completed', 'COMPLETED', now, sessionId]
                );
            }
            this._db.run('COMMIT');
        } catch (error) {
            try { this._db.run('ROLLBACK'); } catch { }
            console.error('[KanbanDatabase] Failed to batch-complete plans:', error);
            return false;
        }
        return this._persist();
    }

    // ── Config table (replaces workspace_identity.json) ─────────────

    public async getConfig(key: string): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare('SELECT value FROM config WHERE key = ? LIMIT 1', [key]);
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().value ?? '');
        } finally {
            stmt.free();
        }
    }

    public async setConfig(key: string, value: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        this._db.run(
            'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            [key, value]
        );
        return this._persist();
    }

    /** Get workspace ID from DB config, or null if not set. */
    public async getWorkspaceId(): Promise<string | null> {
        return this.getConfig('workspace_id');
    }

    /** Derive workspace ID from the plans table (most-used workspace_id). */
    public async getDominantWorkspaceId(): Promise<string | null> {
        if (!(await this.ensureReady()) || !this._db) return null;
        const stmt = this._db.prepare(
            "SELECT workspace_id FROM plans GROUP BY workspace_id ORDER BY COUNT(*) DESC LIMIT 1"
        );
        try {
            if (!stmt.step()) return null;
            return String(stmt.getAsObject().workspace_id ?? '');
        } finally {
            stmt.free();
        }
    }

    /** Set workspace ID in DB config. */
    public async setWorkspaceId(workspaceId: string): Promise<boolean> {
        return this.setConfig('workspace_id', workspaceId);
    }

    // ── Tombstone support via status column ─────────────────────────

    /** Get all tombstoned (deleted) plan IDs for a workspace. */
    public async getTombstonedPlanIds(workspaceId: string): Promise<Set<string>> {
        if (!(await this.ensureReady()) || !this._db) return new Set();
        const stmt = this._db.prepare(
            "SELECT plan_id FROM plans WHERE workspace_id = ? AND status = 'deleted'",
            [workspaceId]
        );
        const ids = new Set<string>();
        try {
            while (stmt.step()) {
                ids.add(String(stmt.getAsObject().plan_id));
            }
        } finally {
            stmt.free();
        }
        return ids;
    }

    /** Mark a plan as tombstoned (deleted). */
    public async tombstonePlan(planId: string): Promise<boolean> {
        return this._persistedUpdate(
            "UPDATE plans SET status = 'deleted', updated_at = ? WHERE plan_id = ?",
            [new Date().toISOString(), planId]
        );
    }

    /**
     * Find active plans whose plan_file no longer exists on disk and tombstone them.
     * Only checks local-source plans (skips brain-source).
     * Missing files must still be absent after a short confirmation delay so
     * temporary editor save churn does not tombstone a live card.
     * Returns the number of plans tombstoned.
     */
    public async purgeOrphanedPlans(
        workspaceId: string,
        resolvePath: (planFile: string) => string
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        const stmt = this._db.prepare(
            `SELECT session_id, plan_file, source_type FROM plans
             WHERE workspace_id = ? AND status = 'active' AND plan_file IS NOT NULL AND plan_file != ''`,
            [workspaceId]
        );
        const rows: Array<{ session_id: string; plan_file: string; source_type: string }> = [];
        while (stmt.step()) {
            rows.push(stmt.getAsObject() as any);
        }
        stmt.free();

        const missingCandidates: Array<{ session_id: string; plan_file: string; absPath: string }> = [];
        for (const row of rows) {
            if (row.source_type === 'brain') continue;
            const absPath = resolvePath(row.plan_file);
            try {
                if (!fs.existsSync(absPath)) {
                    missingCandidates.push({
                        session_id: row.session_id,
                        plan_file: row.plan_file,
                        absPath
                    });
                }
            } catch {
                // If we can't check the file, skip it — don't tombstone on error
            }
        }

        if (missingCandidates.length === 0) {
            return 0;
        }

        await delay(ORPHAN_PURGE_CONFIRMATION_DELAY_MS);

        let purged = 0;
        const now = new Date().toISOString();
        for (const candidate of missingCandidates) {
            try {
                if (!fs.existsSync(candidate.absPath)) {
                    this._db.run(
                        "UPDATE plans SET status = 'deleted', updated_at = ? WHERE session_id = ? AND workspace_id = ?",
                        [now, candidate.session_id, workspaceId]
                    );
                    purged++;
                    console.log(`[KanbanDatabase] Tombstoned orphaned plan after confirmation delay: ${candidate.session_id} (missing file: ${candidate.plan_file})`);
                }
            } catch {
                // If we can't check the file, skip it — don't tombstone on error
            }
        }

        if (purged > 0) {
            await this._persist();
        }
        return purged;
    }

    /**
     * Permanently delete tombstoned plans older than the specified threshold.
     * Default: 30 days. Returns number of records purged.
     */
    public async purgeOldTombstones(
        workspaceId: string,
        olderThanDays: number = 30
    ): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;
        if (olderThanDays < 1) {
            console.warn(`[KanbanDatabase] purgeOldTombstones called with olderThanDays=${olderThanDays}; clamping to 1`);
            olderThanDays = 1;
        }

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const cutoffIso = cutoff.toISOString();

        // Count matching rows first since the local type doesn't expose getRowsModified
        const countStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ?
               AND status = 'deleted'
               AND updated_at < ?`,
            [workspaceId, cutoffIso]
        );
        let purged = 0;
        try {
            if (countStmt.step()) {
                purged = (countStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            countStmt.free();
        }

        if (purged === 0) return 0;

        try {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ?
                   AND status = 'deleted'
                   AND updated_at < ?`,
                [workspaceId, cutoffIso]
            );
            await this._persist();
            console.log(`[KanbanDatabase] Purged ${purged} old tombstones older than ${olderThanDays} days`);
            return purged;
        } catch (e) {
            console.error('[KanbanDatabase] Failed to purge old tombstones:', e);
            return 0;
        }
    }

    /**
     * Remove duplicate kanban entries created when the plan watcher fires for mirror files
     * before the authoritative runsheet (antigravity_* or ingested_*) is written.
     * Keeps the canonical entry (session_id LIKE 'antigravity_%') and deletes any
     * spurious local entry pointing to the same brain_ or ingested_ mirror file.
     * Also removes brain-source entries with an empty plan_file since they cannot be
     * opened by agents and will be re-created correctly on the next sync.
     */
    public async cleanupSpuriousMirrorPlans(workspaceId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        // Find mirror plan_file values that have more than one active entry
        const dupStmt = this._db.prepare(
            `SELECT plan_file, COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND plan_file IS NOT NULL AND plan_file != ''
               AND (plan_file LIKE '%/.switchboard/plans/brain_%.md'
                 OR plan_file LIKE '%.switchboard/plans/brain_%.md'
                 OR plan_file LIKE '%/.switchboard/plans/ingested_%.md'
                 OR plan_file LIKE '%.switchboard/plans/ingested_%.md')
             GROUP BY plan_file
             HAVING cnt > 1`,
            [workspaceId]
        );
        const dupFiles: string[] = [];
        try {
            while (dupStmt.step()) {
                dupFiles.push(String((dupStmt.getAsObject() as any).plan_file));
            }
        } finally {
            dupStmt.free();
        }

        let removed = 0;

        for (const planFile of dupFiles) {
            // Delete the spurious watcher-created entry (session_id LIKE 'sess_%').
            // Brain plans use 'antigravity_*' and ingested plans use a plain hash as
            // their canonical session_id — neither starts with 'sess_'. The watcher
            // always generates 'sess_<timestamp>' IDs, so this correctly targets only
            // the spurious duplicates regardless of plan type.
            const countStmt = this._db.prepare(
                `SELECT COUNT(*) as cnt FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND plan_file = ?
                   AND session_id LIKE 'sess_%'`,
                [workspaceId, planFile]
            );
            let spuriousCount = 0;
            try {
                if (countStmt.step()) {
                    spuriousCount = (countStmt.getAsObject() as any).cnt as number;
                }
            } finally {
                countStmt.free();
            }
            if (spuriousCount > 0) {
                this._db.run(
                    `DELETE FROM plans
                     WHERE workspace_id = ? AND status = 'active' AND plan_file = ?
                       AND session_id LIKE 'sess_%'`,
                    [workspaceId, planFile]
                );
                removed += spuriousCount;
                console.log(`[KanbanDatabase] Removed ${spuriousCount} spurious mirror plan(s) for: ${planFile}`);
            }
        }

        // Also remove brain-source plans with an empty plan_file — they cannot be opened
        // and will be re-created correctly on the next mirror sync.
        const emptyCountStmt = this._db.prepare(
            `SELECT COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active'
               AND source_type = 'brain'
               AND (plan_file IS NULL OR plan_file = '')`,
            [workspaceId]
        );
        let emptyCount = 0;
        try {
            if (emptyCountStmt.step()) {
                emptyCount = (emptyCountStmt.getAsObject() as any).cnt as number;
            }
        } finally {
            emptyCountStmt.free();
        }
        if (emptyCount > 0) {
            this._db.run(
                `DELETE FROM plans
                 WHERE workspace_id = ? AND status = 'active'
                   AND source_type = 'brain'
                   AND (plan_file IS NULL OR plan_file = '')`,
                [workspaceId]
            );
            removed += emptyCount;
            console.log(`[KanbanDatabase] Removed ${emptyCount} brain plan(s) with empty plan_file`);
        }

        if (removed > 0) {
            await this._persist();
        }
        return removed;
    }

    /**
     * Remove duplicate active local plan rows for the same .switchboard/plans/*.md file.
     * Keeps the most recently updated row and drops stale duplicate sess_* rows plus
     * their event/activity history so SessionActionLog DB-first hydration stops
     * reintroducing phantom cards on refresh.
     */
    public async cleanupDuplicateLocalPlans(workspaceId: string): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        const dupStmt = this._db.prepare(
            `SELECT plan_file, COUNT(*) as cnt FROM plans
             WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
               AND plan_file IS NOT NULL AND plan_file != ''
               AND plan_file LIKE '%.switchboard/plans/%.md'
               AND session_id LIKE 'sess_%'
             GROUP BY plan_file
             HAVING cnt > 1`,
            [workspaceId]
        );
        const duplicatePlanFiles: string[] = [];
        try {
            while (dupStmt.step()) {
                duplicatePlanFiles.push(String((dupStmt.getAsObject() as any).plan_file));
            }
        } finally {
            dupStmt.free();
        }

        let removed = 0;

        for (const planFile of duplicatePlanFiles) {
            const rowsStmt = this._db.prepare(
                `SELECT session_id, updated_at, created_at FROM plans
                 WHERE workspace_id = ? AND status = 'active' AND source_type = 'local'
                   AND plan_file = ? AND session_id LIKE 'sess_%'
                 ORDER BY updated_at DESC, created_at DESC, session_id DESC`,
                [workspaceId, planFile]
            );
            const sessionIds: string[] = [];
            try {
                while (rowsStmt.step()) {
                    sessionIds.push(String((rowsStmt.getAsObject() as any).session_id));
                }
            } finally {
                rowsStmt.free();
            }

            if (sessionIds.length <= 1) {
                continue;
            }

            const canonicalSessionId = sessionIds[0];
            const staleSessionIds = sessionIds.slice(1);
            for (const staleSessionId of staleSessionIds) {
                this._db.run('DELETE FROM plan_events WHERE session_id = ?', [staleSessionId]);
                this._db.run('DELETE FROM activity_log WHERE session_id = ?', [staleSessionId]);
                this._db.run('DELETE FROM plans WHERE session_id = ? AND workspace_id = ?', [staleSessionId, workspaceId]);
                removed += 1;
                console.log(
                    `[KanbanDatabase] Removed stale duplicate local plan session ${staleSessionId} for ${planFile}; kept ${canonicalSessionId}`
                );
            }
        }

        return removed > 0 ? (await this._persist(), removed) : 0;
    }

    /** Check if a plan ID is tombstoned. */
    public async isTombstoned(planId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            "SELECT 1 FROM plans WHERE plan_id = ? AND status = 'deleted' LIMIT 1",
            [planId]
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    // ── Plan registry equivalents ───────────────────────────────────

    /** Update brain_source_path and mirror_path for a plan. */
    public async updateBrainPaths(sessionId: string, brainSourcePath: string, mirrorPath: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET brain_source_path = ?, mirror_path = ?, updated_at = ? WHERE session_id = ?',
            [this._normalizePath(brainSourcePath), this._normalizePath(mirrorPath), new Date().toISOString(), sessionId]
        );
    }

    /** Get all active plans for a workspace (replaces plan_registry ownership check). */
    public async getActivePlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        return this.getBoard(workspaceId);
    }

    /** Get ALL plans for a workspace, regardless of status. Used to populate the in-memory registry cache. */
    public async getAllPlans(workspaceId: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT ${PLAN_COLUMNS} FROM plans WHERE workspace_id = ? ORDER BY updated_at ASC`,
            [workspaceId]
        );
        return this._readRows(stmt);
    }

    /** Check if a session is owned by this workspace and active. */
    public async isOwnedActive(sessionId: string, workspaceId: string): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        const stmt = this._db.prepare(
            "SELECT 1 FROM plans WHERE session_id = ? AND workspace_id = ? AND status = 'active' LIMIT 1",
            [sessionId, workspaceId]
        );
        try {
            return stmt.step();
        } finally {
            stmt.free();
        }
    }

    /**
     * Check if the on-disk DB file has been modified by another process (e.g. another IDE).
     * If so, reload the entire in-memory database from disk.
     * Debounced to avoid excessive fs.stat() calls during rapid query bursts.
     */
    private async _reloadIfStale(forceReload: boolean = false): Promise<void> {
        if (!this._db) return; // Not initialized yet — _initialize() will load fresh

        const now = Date.now();
        if (!forceReload && now - this._lastStatCheckMs < KanbanDatabase.STAT_DEBOUNCE_MS) return;
        this._lastStatCheckMs = now;

        try {
            if (!fs.existsSync(this._dbPath)) return; // File deleted — keep in-memory state

            const stats = await fs.promises.stat(this._dbPath);
            const currentMtime = stats.mtimeMs;

            if (currentMtime === this._loadedMtime) return; // No external changes

            // Drain any in-flight writes before reloading to prevent data loss
            try { await this._writeTail; } catch { /* swallow — chain keeps alive internally */ }

            console.log(`[KanbanDatabase] External modification detected (mtime ${this._loadedMtime} → ${currentMtime}). Reloading from disk.`);

            const SQL = await KanbanDatabase._loadSqlJs();
            const fileBuffer = await fs.promises.readFile(this._dbPath);

            // Release old DB reference for GC
            this._db = null;
            this._db = new SQL.Database(new Uint8Array(fileBuffer));

            // Re-apply schema and migrations (idempotent — safe to re-run)
            this._db.exec(SCHEMA_SQL);
            this._runMigrations();

            this._loadedMtime = currentMtime;
            KanbanDatabase._lastLoadedMtimes.set(this._dbPath, currentMtime);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to reload from disk:', error);
            // Keep using stale in-memory copy — better than crashing
        }
    }

    private async _initialize(): Promise<boolean> {
        try {
            await fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true });
            const SQL = await KanbanDatabase._loadSqlJs();

            if (fs.existsSync(this._dbPath)) {
                const stats = await fs.promises.stat(this._dbPath);
                const fileMtime = stats.mtimeMs;

                const previousMtime = KanbanDatabase._lastLoadedMtimes.get(this._dbPath) || 0;
                if (previousMtime > 0 && fileMtime > previousMtime) {
                    console.warn(`[KanbanDatabase] DB file modified externally (cloud sync?). Reloading from ${this._dbPath}`);
                    try {
                        const vscode = require('vscode');
                        vscode.window.showInformationMessage(
                            'Kanban database was updated by another machine. Reloading…'
                        );
                    } catch {
                        // Outside extension host — skip notification
                    }
                }

                KanbanDatabase._lastLoadedMtimes.set(this._dbPath, fileMtime);
                this._loadedMtime = fileMtime;
                const existing = await fs.promises.readFile(this._dbPath);
                this._db = new SQL.Database(new Uint8Array(existing));
                console.log(`[KanbanDatabase] Loaded existing DB from ${this._dbPath} (${existing.length} bytes)`);
            } else {
                KanbanDatabase._lastLoadedMtimes.delete(this._dbPath);
                this._loadedMtime = 0;
                this._db = new SQL.Database();
                console.log(`[KanbanDatabase] Created new empty DB at ${this._dbPath}`);
            }

            if (!this._db) {
                throw new Error('Failed to initialize SQLite database instance.');
            }
            this._db.exec(SCHEMA_SQL);

            // Run migrations for existing databases
            this._runMigrations();

            // Persist migration changes (new tables/columns) to disk
            await this._persist();

            // Warn about conflict copies
            this._warnConflictCopies();

            // Verify config table exists and has workspace_id
            try {
                const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
                const hasWs = cfgStmt.step();
                if (hasWs) {
                    const wsId = String(cfgStmt.getAsObject().value);
                    console.log(`[KanbanDatabase] Post-init: workspace_id=${wsId}`);
                } else {
                    console.warn(`[KanbanDatabase] Post-init: NO workspace_id in config table`);
                }
                cfgStmt.free();
                // Count active plans
                const countStmt = this._db.prepare("SELECT COUNT(*) as cnt FROM plans WHERE status = 'active'");
                if (countStmt.step()) {
                    console.log(`[KanbanDatabase] Post-init: ${countStmt.getAsObject().cnt} active plans`);
                }
                countStmt.free();
            } catch (e) {
                console.error(`[KanbanDatabase] Post-init diagnostics failed:`, e);
            }

            this._lastInitError = null;
            return true;
        } catch (error) {
            this._db = null;
            // Handle non-Error objects (SQL.js sometimes throws plain objects)
            let errorMessage: string;
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'object' && error !== null) {
                // SQL.js may throw { message: string } or other object shapes
                errorMessage = (error as any).message || JSON.stringify(error);
            } else {
                errorMessage = String(error);
            }
            this._lastInitError = errorMessage;
            console.error('[KanbanDatabase] Initialization failed:', error);
            return false;
        }
    }

    private _warnConflictCopies(): void {
        try {
            const dir = path.dirname(this._dbPath);
            const baseName = path.basename(this._dbPath, '.db'); // e.g. 'kanban'
            const siblings = fs.readdirSync(dir).filter(
                f => f !== path.basename(this._dbPath) && f.startsWith(baseName) && f.endsWith('.db')
            );
            if (siblings.length > 0) {
                const msg = `[KanbanDatabase] Possible cloud sync conflict copies detected: ${siblings.join(', ')}`;
                console.warn(msg);
                try {
                    const vscode = require('vscode');
                    vscode.window.showWarningMessage(
                        `Kanban DB conflict copies found (${siblings.length}). Check ${dir} and remove stale files.`
                    );
                } catch { /* outside extension host */ }
            }
        } catch {
            // Directory read failed — non-critical, swallow
        }
    }

    private _runMigrations(): void {
        if (!this._db) return;

        // V2: add brain_source_path, mirror_path columns + config table + status index
        for (const sql of MIGRATION_V2_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }
        try { this._db.exec(MIGRATION_V2_CONFIG_TABLE); } catch { /* table already exists */ }
        try { this._db.exec(MIGRATION_V2_STATUS_INDEX); } catch { /* index already exists */ }

        // V3: fix zombie plans (status=active but kanban_column=COMPLETED)
        try {
            this._db.exec(
                "UPDATE plans SET status = 'completed' WHERE status = 'active' AND kanban_column = 'COMPLETED'"
            );
        } catch { /* best effort */ }

        // V3: consolidate workspace_ids — if config has no workspace_id but plans exist,
        // adopt the most-used workspace_id and unify all plans under it
        try {
            const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
            const hasWsId = cfgStmt.step();
            cfgStmt.free();

            if (!hasWsId) {
                const domStmt = this._db.prepare(
                    "SELECT workspace_id FROM plans GROUP BY workspace_id ORDER BY COUNT(*) DESC LIMIT 1"
                );
                if (domStmt.step()) {
                    const dominantWsId = String(domStmt.getAsObject().workspace_id);
                    domStmt.free();
                    // Set it in config
                    this._db.run(
                        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                        ['workspace_id', dominantWsId]
                    );
                    // Unify all plans under the dominant workspace_id
                    this._db.run(
                        "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                        [dominantWsId, dominantWsId]
                    );
                    console.log(`[KanbanDatabase] V3 migration: consolidated workspace_id to ${dominantWsId}`);
                } else {
                    domStmt.free();
                }
            }
        } catch (e) {
            console.error('[KanbanDatabase] V3 migration workspace consolidation failed:', e);
        }

        // V6: fix workspace_id mismatch — if config workspace_id exists but doesn't match the
        // dominant plans workspace_id, update config to match the plans (the plans are authoritative)
        try {
            const cfgStmt = this._db.prepare("SELECT value FROM config WHERE key = 'workspace_id'");
            const hasCfgWsId = cfgStmt.step();
            const cfgWsId = hasCfgWsId ? String(cfgStmt.getAsObject().value) : null;
            cfgStmt.free();

            if (cfgWsId) {
                const domStmt = this._db.prepare(
                    "SELECT workspace_id, COUNT(*) as cnt FROM plans GROUP BY workspace_id ORDER BY cnt DESC LIMIT 1"
                );
                if (domStmt.step()) {
                    const dominantWsId = String(domStmt.getAsObject().workspace_id);
                    domStmt.free();
                    if (dominantWsId && dominantWsId !== cfgWsId) {
                        // Config has a stale/wrong workspace_id; unify under the dominant one
                        this._db.run(
                            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                            ['workspace_id', dominantWsId]
                        );
                        this._db.run(
                            "UPDATE plans SET workspace_id = ? WHERE workspace_id != ?",
                            [dominantWsId, dominantWsId]
                        );
                        console.log(`[KanbanDatabase] V6 migration: corrected workspace_id from ${cfgWsId} to ${dominantWsId}`);
                    }
                } else {
                    domStmt.free();
                }
            }
        } catch (e) {
            console.error('[KanbanDatabase] V6 migration workspace_id fix failed:', e);
        }

        // V4: add tags column
        for (const sql of MIGRATION_V4_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V5: event sourcing tables (plan_events + activity_log)
        for (const sql of MIGRATION_V5_SQL) {
            try { this._db.exec(sql); } catch { /* table/index already exists */ }
        }

        // V6: add dependencies column
        for (const sql of MIGRATION_V6_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V7: add dispatch identity columns for routing analytics
        for (const sql of MIGRATION_V7_SQL) {
            try { this._db.exec(sql); } catch { /* column already exists */ }
        }

        // V8: migrate legacy complexity values to numeric 1-10 scale
        // Low → 3, High → 8. Idempotent: won't re-match already-migrated rows.
        try {
            this._db.exec("UPDATE plans SET complexity = '3' WHERE LOWER(complexity) = 'low'");
            this._db.exec("UPDATE plans SET complexity = '8' WHERE LOWER(complexity) = 'high'");
        } catch (e) {
            console.error('[KanbanDatabase] V8 complexity migration failed:', e);
        }

        // V9: add ClickUp task tracking field and lookup index.
        for (const sql of MIGRATION_V9_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V10: repair completed rows that were silently rewritten to archived.
        try {
            const repairStmt = this._db.prepare(
                "SELECT COUNT(*) as cnt FROM plans WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
            );
            let repairedCount = 0;
            try {
                if (repairStmt.step()) {
                    repairedCount = Number(repairStmt.getAsObject().cnt || 0);
                }
            } finally {
                repairStmt.free();
            }
            if (repairedCount > 0) {
                this._db.exec(
                    "UPDATE plans SET status = 'completed' WHERE status = 'archived' AND kanban_column = 'COMPLETED'"
                );
                console.log(`[KanbanDatabase] V10 migration: repaired ${repairedCount} completed-column status row(s)`);
            }
        } catch (e) {
            console.error('[KanbanDatabase] V10 completed-status repair failed:', e);
        }

        // V11: remove abandoned internal ClickUp automation fields.
        try {
            this._dropLegacyClickUpAutomationColumns();
        } catch (e) {
            console.error('[KanbanDatabase] V11 ClickUp automation cleanup failed:', e);
        }

        // V12: add Linear issue tracking field and lookup index.
        for (const sql of MIGRATION_V12_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V13: add repo-scope metadata and filtered-query index.
        for (const sql of MIGRATION_V13_SQL) {
            try { this._db.exec(sql); } catch { /* column/index already exists */ }
        }

        // V14: add kanban_meta table for parser versioning and backfill tracking.
        for (const sql of MIGRATION_V14_SQL) {
            try { this._db.exec(sql); } catch { /* table already exists */ }
        }
    }

    private _planTableHasColumn(columnName: string): boolean {
        if (!this._db) return false;
        const stmt = this._db.prepare("PRAGMA table_info(plans)");
        try {
            while (stmt.step()) {
                if (String(stmt.getAsObject().name || '') === columnName) {
                    return true;
                }
            }
            return false;
        } finally {
            stmt.free();
        }
    }

    private _dropLegacyClickUpAutomationColumns(): void {
        if (!this._db) return;

        const hasPipelineId = this._planTableHasColumn('pipeline_id');
        const hasIsInternal = this._planTableHasColumn('is_internal');
        const hasLinearIssueId = this._planTableHasColumn('linear_issue_id');
        if (!hasPipelineId && !hasIsInternal) {
            try { this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline'); } catch { /* best effort */ }
            try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)'); } catch { /* best effort */ }
            if (hasLinearIssueId) {
                try { this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)'); } catch { /* best effort */ }
            }
            return;
        }

        const linearIssueColumnSql = hasLinearIssueId
            ? ",\n    linear_issue_id TEXT DEFAULT ''"
            : '';
        const linearIssueColumnList = hasLinearIssueId ? ', linear_issue_id' : '';

        this._db.exec('BEGIN TRANSACTION');
        try {
            this._db.exec('DROP INDEX IF EXISTS idx_plans_clickup_pipeline');
            this._db.exec(`
CREATE TABLE plans_v11 (
    plan_id TEXT PRIMARY KEY,
    session_id TEXT UNIQUE NOT NULL,
    topic TEXT NOT NULL,
    plan_file TEXT,
    kanban_column TEXT NOT NULL DEFAULT 'CREATED',
    status TEXT NOT NULL DEFAULT 'active',
    complexity TEXT DEFAULT 'Unknown',
    tags TEXT DEFAULT '',
    dependencies TEXT DEFAULT '',
    workspace_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_action TEXT,
    source_type TEXT DEFAULT 'local',
    brain_source_path TEXT DEFAULT '',
    mirror_path TEXT DEFAULT '',
    routed_to TEXT DEFAULT '',
    dispatched_agent TEXT DEFAULT '',
    dispatched_ide TEXT DEFAULT '',
    clickup_task_id TEXT DEFAULT ''${linearIssueColumnSql}
);
`);
            this._db.exec(`
INSERT INTO plans_v11 (
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
    workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id${linearIssueColumnList}
)
SELECT
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags, dependencies,
    workspace_id, created_at, updated_at, last_action, source_type,
    brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide, clickup_task_id${linearIssueColumnList}
FROM plans
`);
            this._db.exec('DROP TABLE plans');
            this._db.exec('ALTER TABLE plans_v11 RENAME TO plans');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status)');
            this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_clickup_task ON plans(workspace_id, clickup_task_id)');
            if (hasLinearIssueId) {
                this._db.exec('CREATE INDEX IF NOT EXISTS idx_plans_linear_issue ON plans(workspace_id, linear_issue_id)');
            }
            this._db.exec('COMMIT');
            console.log('[KanbanDatabase] V11 migration: removed legacy ClickUp automation columns pipeline_id and is_internal');
        } catch (error) {
            try { this._db.exec('ROLLBACK'); } catch { /* ignore rollback failure */ }
            throw error;
        }
    }

    private async _persist(): Promise<boolean> {
        if (!this._db) return false;
        const data = this._db.export();
        const writeOperation = async (): Promise<boolean> => {
            // Use crypto random suffix to avoid collisions in rapid writes
            const suffix = crypto.randomBytes(4).toString('hex');
            const tmpPath = `${this._dbPath}.${suffix}.tmp`;
            try {
                await fs.promises.writeFile(tmpPath, Buffer.from(data));
                await fs.promises.rename(tmpPath, this._dbPath);
                // Update our mtime baseline so _reloadIfStale() doesn't
                // re-read our own write as an "external modification"
                try {
                    const stats = await fs.promises.stat(this._dbPath);
                    this._loadedMtime = stats.mtimeMs;
                    KanbanDatabase._lastLoadedMtimes.set(this._dbPath, stats.mtimeMs);
                } catch { /* stat failure is non-critical */ }
                return true;
            } catch (error) {
                try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
                console.error('[KanbanDatabase] Failed to persist DB file:', error);
                return false;
            }
        };
        let result = false;
        const nextWrite = this._writeTail.then(async () => { result = await writeOperation(); });
        this._writeTail = nextWrite.catch(() => { /* swallow to keep chain alive */ });
        await nextWrite;
        return result;
    }

    private async _persistedUpdate(sql: string, params: unknown[]): Promise<boolean> {
        if (!(await this.ensureReady()) || !this._db) return false;
        try {
            this._db.run(sql, params);
        } catch (error) {
            console.error('[KanbanDatabase] Failed to update record:', error);
            return false;
        }
        return this._persist();
    }

    /**
     * Append a plan event (workflow start, column change, completion, etc.)
     */
    public async appendPlanEvent(sessionId: string, event: {
        eventType: string;
        workflow?: string;
        action?: string;
        timestamp?: string;
        payload?: string;
    }): Promise<boolean> {
        const deviceId = os.hostname();
        return this._persistedUpdate(
            `INSERT INTO plan_events (session_id, event_type, workflow, action, timestamp, device_id, payload)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                sessionId,
                event.eventType,
                event.workflow || '',
                event.action || '',
                event.timestamp || new Date().toISOString(),
                deviceId,
                event.payload || '{}'
            ]
        );
    }

    /**
     * Get plan events for a session, ordered by timestamp
     */
    public async getPlanEvents(sessionId: string): Promise<any[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        try {
            const stmt = this._db.prepare(
                `SELECT * FROM plan_events WHERE session_id = ? ORDER BY timestamp ASC`,
                [sessionId]
            );
            const results: any[] = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            return results;
        } catch (error) {
            console.error('[KanbanDatabase] Failed to get plan events:', error);
            return [];
        }
    }

    /**
     * Append an activity log event (replaces activity.jsonl writes)
     */
    public async appendActivityEvent(event: {
        timestamp: string;
        eventType: string;
        payload: string;
        correlationId?: string;
        sessionId?: string | null;
    }): Promise<boolean> {
        return this._persistedUpdate(
            `INSERT INTO activity_log (timestamp, event_type, payload, correlation_id, session_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
                event.timestamp,
                event.eventType,
                event.payload,
                event.correlationId || null,
                event.sessionId || null
            ]
        );
    }

    /**
     * Get recent activity events with cursor-based pagination
     */
    public async getRecentActivity(limit: number, beforeTimestamp?: string): Promise<{
        events: any[];
        hasMore: boolean;
        nextCursor?: string;
    }> {
        if (!(await this.ensureReady()) || !this._db) return { events: [], hasMore: false };
        try {
            const whereClause = beforeTimestamp ? 'WHERE timestamp < ?' : '';
            const params = beforeTimestamp ? [beforeTimestamp, limit + 1] : [limit + 1];
            const stmt = this._db.prepare(
                `SELECT * FROM activity_log ${whereClause} ORDER BY timestamp DESC LIMIT ?`,
                params
            );
            const results: any[] = [];
            while (stmt.step()) {
                results.push(stmt.getAsObject());
            }
            stmt.free();
            const hasMore = results.length > limit;
            if (hasMore) results.pop();
            return {
                events: results,
                hasMore,
                nextCursor: hasMore && results.length > 0 ? results[results.length - 1].timestamp : undefined
            };
        } catch (error) {
            console.error('[KanbanDatabase] Failed to get recent activity:', error);
            return { events: [], hasMore: false };
        }
    }

    /**
     * Get a run sheet (session event history) from the database.
     * Returns null if no events found for this session.
     */
    public async getRunSheet(sessionId: string): Promise<any | null> {
        const events = await this.getPlanEvents(sessionId);
        if (events.length === 0) return null;
        return {
            sessionId,
            events: events.map(e => {
                try { return JSON.parse(e.payload); }
                catch { return { workflow: e.workflow, action: e.action, timestamp: e.timestamp }; }
            })
        };
    }

    /**
     * Migrate events from a session file into the plan_events table.
     * Returns number of events migrated. Skips if events already exist for this session.
     */
    public async migrateSessionEvents(sessionId: string, events: any[]): Promise<number> {
        if (!(await this.ensureReady()) || !this._db) return 0;

        // Skip if session already has events in DB
        try {
            const checkStmt = this._db.prepare(
                `SELECT COUNT(*) as cnt FROM plan_events WHERE session_id = ?`,
                [sessionId]
            );
            if (checkStmt.step()) {
                const count = checkStmt.getAsObject().cnt;
                checkStmt.free();
                if (Number(count) > 0) return 0;
            } else {
                checkStmt.free();
            }
        } catch { return 0; }

        let migrated = 0;
        const deviceId = os.hostname();
        for (const event of events) {
            try {
                this._db.run(
                    `INSERT INTO plan_events (session_id, event_type, workflow, action, timestamp, device_id, payload)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        sessionId,
                        'workflow_event',
                        event.workflow || '',
                        event.action || '',
                        event.timestamp || new Date().toISOString(),
                        deviceId,
                        JSON.stringify(event)
                    ]
                );
                migrated++;
            } catch (e) {
                console.error(`[KanbanDatabase] Failed to migrate event for ${sessionId}:`, e);
            }
        }
        if (migrated > 0) {
            await this._persist();
        }
        return migrated;
    }

    /**
     * Delete all plan events for a session (used by deleteRunSheet).
     */
    public async deletePlanEvents(sessionId: string): Promise<boolean> {
        return this._persistedUpdate(
            'DELETE FROM plan_events WHERE session_id = ?',
            [sessionId]
        );
    }

    /**
     * Delete activity log events older than the given ISO timestamp.
     */
    public async cleanupActivityLog(beforeTimestamp: string): Promise<boolean> {
        return this._persistedUpdate(
            'DELETE FROM activity_log WHERE timestamp < ?',
            [beforeTimestamp]
        );
    }

    /**
     * Update dispatch identity fields for a plan (routing analytics).
     */
    public async updateDispatchInfo(sessionId: string, info: {
        routedTo: string;
        dispatchedAgent: string;
        dispatchedIde: string;
    }): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET routed_to = ?, dispatched_agent = ?, dispatched_ide = ?, updated_at = ? WHERE session_id = ?',
            [info.routedTo, info.dispatchedAgent, info.dispatchedIde, new Date().toISOString(), sessionId]
        );
    }

    /** Normalize paths to use forward slashes for cross-platform compatibility */
    private _normalizePath(filePath: string): string {
        if (!filePath) return '';
        return filePath.replace(/\\/g, '/');
    }

    private _readRows(stmt: ReturnType<SqlJsDatabase['prepare']>): KanbanPlanRecord[] {
        const rows: KanbanPlanRecord[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                rows.push({
                    planId: String(row.plan_id || ""),
                    sessionId: String(row.session_id || ""),
                    topic: String(row.topic || ""),
                    planFile: this._normalizePath(String(row.plan_file || "")),
                    kanbanColumn: String(row.kanban_column || "CREATED"),
                    status: String(row.status || "active") as KanbanPlanStatus,
                    complexity: String(row.complexity || "Unknown"),
                    tags: String(row.tags || ""),
                    dependencies: String(row.dependencies || ""),
                    repoScope: String(row.repo_scope || ""),
                    workspaceId: String(row.workspace_id || ""),
                    createdAt: String(row.created_at || ""),
                    updatedAt: String(row.updated_at || ""),
                    lastAction: String(row.last_action || ""),
                    sourceType: (() => {
                        const st = String(row.source_type || 'local');
                        return st === 'brain' || st === 'clickup-automation' || st === 'linear-automation'
                            ? st
                            : 'local';
                    })(),
                    brainSourcePath: this._normalizePath(String(row.brain_source_path || "")),
                    mirrorPath: this._normalizePath(String(row.mirror_path || "")),
                    routedTo: String(row.routed_to || ""),
                    dispatchedAgent: String(row.dispatched_agent || ""),
                    dispatchedIde: String(row.dispatched_ide || ""),
                    clickupTaskId: String(row.clickup_task_id || ""),
                    linearIssueId: String(row.linear_issue_id || "")
                });
            }
        } finally {
            stmt.free();
        }
        return rows;
    }

    private static async _loadSqlJs(): Promise<SqlJsStatic> {
        if (!KanbanDatabase._sqlJsPromise) {
            KanbanDatabase._sqlJsPromise = (async () => {
                const sqlJsModulePath = KanbanDatabase._resolveSqlJsModulePath();
                const initSqlJsModule = runtimeRequire(sqlJsModulePath) as ((config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>) | { default?: (config?: { wasmBinary?: Uint8Array }) => Promise<SqlJsStatic> };
                const initSqlJs = typeof initSqlJsModule === 'function' ? initSqlJsModule : initSqlJsModule.default;
                if (!initSqlJs) {
                    throw new Error('sql.js module did not expose an initializer function.');
                }
                const wasmPath = KanbanDatabase._resolveSqlWasmPath();
                const wasmBinary = new Uint8Array(await fs.promises.readFile(wasmPath));
                return initSqlJs({ wasmBinary });
            })().catch((error) => {
                KanbanDatabase._sqlJsPromise = null;
                throw error;
            });
        }
        return KanbanDatabase._sqlJsPromise;
    }

    private static _resolveSqlJsModulePath(): string {
        const candidates = [
            path.join(__dirname, 'sql-wasm.js'),
            path.join(__dirname, '..', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', 'sql-wasm.js'),
            path.join(path.dirname(require.main?.filename || process.cwd()), 'sql-wasm.js'),
            path.join(process.cwd(), 'dist', 'sql-wasm.js'),
            path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
            path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new Error(`Unable to locate sql-wasm.js. Checked: ${candidates.join(', ')}`);
    }

    private static _resolveSqlWasmPath(): string {
        const candidates = [
            path.join(__dirname, 'sql-wasm.wasm'),
            path.join(__dirname, '..', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', 'sql-wasm.wasm'),
            path.join(path.dirname(require.main?.filename || process.cwd()), 'sql-wasm.wasm'),
            path.join(process.cwd(), 'dist', 'sql-wasm.wasm'),
            path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
            path.join(__dirname, '..', '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        throw new Error(`Unable to locate sql-wasm.wasm. Checked: ${candidates.join(', ')}`);
    }
}
