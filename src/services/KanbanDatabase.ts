import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';

export type KanbanPlanStatus = 'active' | 'archived' | 'completed';

export interface KanbanPlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    status: KanbanPlanStatus;
    complexity: 'Unknown' | 'Low' | 'High';
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: 'local' | 'brain';
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
    workspace_id  TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_action   TEXT,
    source_type   TEXT DEFAULT 'local'
);
CREATE INDEX IF NOT EXISTS idx_plans_column ON plans(kanban_column);
CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id);
CREATE TABLE IF NOT EXISTS migration_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const UPSERT_PLAN_SQL = `
INSERT INTO plans (
    plan_id, session_id, topic, plan_file, kanban_column, status, complexity,
    workspace_id, created_at, updated_at, last_action, source_type
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(plan_id) DO UPDATE SET
    session_id = excluded.session_id,
    topic = excluded.topic,
    plan_file = excluded.plan_file,
    kanban_column = excluded.kanban_column,
    status = excluded.status,
    complexity = excluded.complexity,
    workspace_id = excluded.workspace_id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    last_action = excluded.last_action,
    source_type = excluded.source_type
`;

const MIGRATION_VERSION_KEY = 'kanban_db_migration_version';
const runtimeRequire = createRequire(__filename);

const VALID_KANBAN_COLUMNS = new Set([
    'CREATED', 'PLAN REVIEWED', 'LEAD CODED', 'CODER CODED', 'CODE REVIEWED', 'CODED'
]);
const VALID_COMPLEXITIES = new Set(['Unknown', 'Low', 'High']);
const VALID_STATUSES = new Set(['active', 'archived', 'completed']);

// Allow built-in columns plus custom agent columns (alphanumeric, underscores, spaces)
const SAFE_COLUMN_NAME_RE = /^[a-zA-Z0-9 _-]{1,128}$/;

export class KanbanDatabase {
    private static _instances = new Map<string, KanbanDatabase>();
    private static _sqlJsPromise: Promise<SqlJsStatic> | null = null;

    public static forWorkspace(workspaceRoot: string): KanbanDatabase {
        const stable = path.resolve(workspaceRoot);
        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            return existing;
        }
        const created = new KanbanDatabase(stable);
        KanbanDatabase._instances.set(stable, created);
        return created;
    }

    private readonly _dbPath: string;
    private _db: SqlJsDatabase | null = null;
    private _initPromise: Promise<boolean> | null = null;
    private _lastInitError: string | null = null;

    private constructor(private readonly _workspaceRoot: string) {
        this._dbPath = path.join(this._workspaceRoot, '.switchboard', 'kanban.db');
    }

    public get lastInitError(): string | null {
        return this._lastInitError;
    }

    public async ensureReady(): Promise<boolean> {
        if (this._db) return true;
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
                    record.planId,
                    record.sessionId,
                    record.topic,
                    record.planFile,
                    record.kanbanColumn,
                    record.status,
                    record.complexity,
                    record.workspaceId,
                    record.createdAt,
                    record.updatedAt,
                    record.lastAction,
                    record.sourceType
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
        return this._persistedUpdate(
            'UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?',
            [newColumn, new Date().toISOString(), sessionId]
        );
    }

    public async updateComplexity(sessionId: string, complexity: 'Unknown' | 'Low' | 'High'): Promise<boolean> {
        if (!VALID_COMPLEXITIES.has(complexity)) {
            console.error(`[KanbanDatabase] Rejected invalid complexity value: ${complexity}`);
            return false;
        }
        return this._persistedUpdate(
            'UPDATE plans SET complexity = ?, updated_at = ? WHERE session_id = ?',
            [complexity, new Date().toISOString(), sessionId]
        );
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

    public async updateTopic(sessionId: string, topic: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET topic = ?, updated_at = ? WHERE session_id = ?',
            [topic, new Date().toISOString(), sessionId]
        );
    }

    public async updatePlanFile(sessionId: string, planFile: string): Promise<boolean> {
        return this._persistedUpdate(
            'UPDATE plans SET plan_file = ?, updated_at = ? WHERE session_id = ?',
            [planFile, new Date().toISOString(), sessionId]
        );
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
            `SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity,
                    workspace_id, created_at, updated_at, last_action, source_type
             FROM plans
             WHERE workspace_id = ? AND status = 'active'
             ORDER BY updated_at ASC`,
             [workspaceId]
        );
        return this._readRows(stmt);
    }

    public async getPlansByColumn(workspaceId: string, column: string): Promise<KanbanPlanRecord[]> {
        if (!(await this.ensureReady()) || !this._db) return [];
        const stmt = this._db.prepare(
            `SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity,
                    workspace_id, created_at, updated_at, last_action, source_type
             FROM plans
             WHERE workspace_id = ? AND status = 'active' AND kanban_column = ?
             ORDER BY updated_at ASC`,
            [workspaceId, column]
        );
        return this._readRows(stmt);
    }

    private async _initialize(): Promise<boolean> {
        try {
            await fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true });
            const SQL = await KanbanDatabase._loadSqlJs();

            if (fs.existsSync(this._dbPath)) {
                const existing = await fs.promises.readFile(this._dbPath);
                this._db = new SQL.Database(new Uint8Array(existing));
            } else {
                this._db = new SQL.Database();
            }

            if (!this._db) {
                throw new Error('Failed to initialize SQLite database instance.');
            }
            this._db.exec(SCHEMA_SQL);
            this._lastInitError = null;
            return true;
        } catch (error) {
            this._db = null;
            this._lastInitError = error instanceof Error ? error.message : String(error);
            console.error('[KanbanDatabase] Initialization failed, will use file-based fallback:', error);
            return false;
        }
    }

    private async _persist(): Promise<boolean> {
        if (!this._db) return false;
        try {
            const data = this._db.export();
            await fs.promises.writeFile(this._dbPath, Buffer.from(data));
            return true;
        } catch (error) {
            console.error('[KanbanDatabase] Failed to persist DB file:', error);
            return false;
        }
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

    private _readRows(stmt: ReturnType<SqlJsDatabase['prepare']>): KanbanPlanRecord[] {
        const rows: KanbanPlanRecord[] = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                rows.push({
                    planId: String(row.plan_id || ""),
                    sessionId: String(row.session_id || ""),
                    topic: String(row.topic || ""),
                    planFile: String(row.plan_file || ""),
                    kanbanColumn: String(row.kanban_column || "CREATED"),
                    status: String(row.status || "active") as KanbanPlanStatus,
                    complexity: String(row.complexity || "Unknown") as "Unknown" | "Low" | "High",
                    workspaceId: String(row.workspace_id || ""),
                    createdAt: String(row.created_at || ""),
                    updatedAt: String(row.updated_at || ""),
                    lastAction: String(row.last_action || ""),
                    sourceType: (String(row.source_type || "local") === "brain" ? "brain" : "local")
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

