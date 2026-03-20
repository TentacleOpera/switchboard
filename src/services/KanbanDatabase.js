"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.KanbanDatabase = void 0;
const fs = __importStar(require("fs"));
const module_1 = require("module");
const path = __importStar(require("path"));
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
const runtimeRequire = (0, module_1.createRequire)(__filename);
class KanbanDatabase {
    _workspaceRoot;
    static _instances = new Map();
    static _sqlJsPromise = null;
    static forWorkspace(workspaceRoot) {
        const stable = path.resolve(workspaceRoot);
        const existing = KanbanDatabase._instances.get(stable);
        if (existing) {
            return existing;
        }
        const created = new KanbanDatabase(stable);
        KanbanDatabase._instances.set(stable, created);
        return created;
    }
    _dbPath;
    _db = null;
    _initPromise = null;
    _lastInitError = null;
    constructor(_workspaceRoot) {
        this._workspaceRoot = _workspaceRoot;
        this._dbPath = path.join(this._workspaceRoot, '.switchboard', 'kanban.db');
    }
    get lastInitError() {
        return this._lastInitError;
    }
    async ensureReady() {
        if (this._db)
            return true;
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
    async getMigrationVersion() {
        if (!(await this.ensureReady()) || !this._db)
            return 0;
        const stmt = this._db.prepare('SELECT value FROM migration_meta WHERE key = ? LIMIT 1', [MIGRATION_VERSION_KEY]);
        try {
            if (!stmt.step())
                return 0;
            const row = stmt.getAsObject();
            const parsed = Number(row.value ?? 0);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        finally {
            stmt.free();
        }
    }
    async setMigrationVersion(version) {
        if (!(await this.ensureReady()) || !this._db)
            return false;
        this._db.run('INSERT INTO migration_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [MIGRATION_VERSION_KEY, String(version)]);
        return this._persist();
    }
    async upsertPlans(records) {
        if (!(await this.ensureReady()) || !this._db)
            return false;
        if (records.length === 0)
            return true;
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
        }
        catch (error) {
            try {
                this._db.run('ROLLBACK');
            }
            catch { }
            console.error('[KanbanDatabase] Failed to upsert records:', error);
            return false;
        }
        return this._persist();
    }
    async hasActivePlans(workspaceId) {
        if (!(await this.ensureReady()) || !this._db)
            return false;
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE workspace_id = ? AND status = ? LIMIT 1', [workspaceId, 'active']);
        try {
            return stmt.step();
        }
        finally {
            stmt.free();
        }
    }
    async hasPlan(sessionId) {
        if (!(await this.ensureReady()) || !this._db)
            return false;
        const stmt = this._db.prepare('SELECT 1 FROM plans WHERE session_id = ? LIMIT 1', [sessionId]);
        try {
            return stmt.step();
        }
        finally {
            stmt.free();
        }
    }
    async updateColumn(sessionId, newColumn) {
        return this._persistedUpdate('UPDATE plans SET kanban_column = ?, updated_at = ? WHERE session_id = ?', [newColumn, new Date().toISOString(), sessionId]);
    }
    async updateComplexity(sessionId, complexity) {
        return this._persistedUpdate('UPDATE plans SET complexity = ?, updated_at = ? WHERE session_id = ?', [complexity, new Date().toISOString(), sessionId]);
    }
    async updateStatus(sessionId, status) {
        return this._persistedUpdate('UPDATE plans SET status = ?, updated_at = ? WHERE session_id = ?', [status, new Date().toISOString(), sessionId]);
    }
    async updateTopic(sessionId, topic) {
        return this._persistedUpdate('UPDATE plans SET topic = ?, updated_at = ? WHERE session_id = ?', [topic, new Date().toISOString(), sessionId]);
    }
    async updatePlanFile(sessionId, planFile) {
        return this._persistedUpdate('UPDATE plans SET plan_file = ?, updated_at = ? WHERE session_id = ?', [planFile, new Date().toISOString(), sessionId]);
    }
    async deletePlan(sessionId) {
        return this._persistedUpdate('DELETE FROM plans WHERE session_id = ?', [sessionId]);
    }
    async getBoard(workspaceId) {
        if (!(await this.ensureReady()) || !this._db)
            return [];
        const stmt = this._db.prepare(`SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity,
                    workspace_id, created_at, updated_at, last_action, source_type
             FROM plans
             WHERE workspace_id = ? AND status = 'active'
             ORDER BY updated_at ASC`, [workspaceId]);
        return this._readRows(stmt);
    }
    async getPlansByColumn(workspaceId, column) {
        if (!(await this.ensureReady()) || !this._db)
            return [];
        const stmt = this._db.prepare(`SELECT plan_id, session_id, topic, plan_file, kanban_column, status, complexity,
                    workspace_id, created_at, updated_at, last_action, source_type
             FROM plans
             WHERE workspace_id = ? AND status = 'active' AND kanban_column = ?
             ORDER BY updated_at ASC`, [workspaceId, column]);
        return this._readRows(stmt);
    }
    async _initialize() {
        try {
            await fs.promises.mkdir(path.dirname(this._dbPath), { recursive: true });
            const SQL = await KanbanDatabase._loadSqlJs();
            if (fs.existsSync(this._dbPath)) {
                const existing = await fs.promises.readFile(this._dbPath);
                this._db = new SQL.Database(new Uint8Array(existing));
            }
            else {
                this._db = new SQL.Database();
            }
            if (!this._db) {
                throw new Error('Failed to initialize SQLite database instance.');
            }
            this._db.exec(SCHEMA_SQL);
            this._lastInitError = null;
            return true;
        }
        catch (error) {
            this._db = null;
            this._lastInitError = error instanceof Error ? error.message : String(error);
            console.error('[KanbanDatabase] Initialization failed, will use file-based fallback:', error);
            return false;
        }
    }
    async _persist() {
        if (!this._db)
            return false;
        try {
            const data = this._db.export();
            await fs.promises.writeFile(this._dbPath, Buffer.from(data));
            return true;
        }
        catch (error) {
            console.error('[KanbanDatabase] Failed to persist DB file:', error);
            return false;
        }
    }
    async _persistedUpdate(sql, params) {
        if (!(await this.ensureReady()) || !this._db)
            return false;
        try {
            this._db.run(sql, params);
        }
        catch (error) {
            console.error('[KanbanDatabase] Failed to update record:', error);
            return false;
        }
        return this._persist();
    }
    _readRows(stmt) {
        const rows = [];
        try {
            while (stmt.step()) {
                const row = stmt.getAsObject();
                rows.push({
                    planId: String(row.plan_id || ""),
                    sessionId: String(row.session_id || ""),
                    topic: String(row.topic || ""),
                    planFile: String(row.plan_file || ""),
                    kanbanColumn: String(row.kanban_column || "CREATED"),
                    status: String(row.status || "active"),
                    complexity: String(row.complexity || "Unknown"),
                    workspaceId: String(row.workspace_id || ""),
                    createdAt: String(row.created_at || ""),
                    updatedAt: String(row.updated_at || ""),
                    lastAction: String(row.last_action || ""),
                    sourceType: (String(row.source_type || "local") === "brain" ? "brain" : "local")
                });
            }
        }
        finally {
            stmt.free();
        }
        return rows;
    }
    static async _loadSqlJs() {
        if (!KanbanDatabase._sqlJsPromise) {
            KanbanDatabase._sqlJsPromise = (async () => {
                const sqlJsModulePath = KanbanDatabase._resolveSqlJsModulePath();
                const initSqlJsModule = runtimeRequire(sqlJsModulePath);
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
    static _resolveSqlJsModulePath() {
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
    static _resolveSqlWasmPath() {
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
exports.KanbanDatabase = KanbanDatabase;
//# sourceMappingURL=KanbanDatabase.js.map