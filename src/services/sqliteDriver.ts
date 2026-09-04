import * as fs from 'fs';
import * as path from 'path';

export interface ISqliteStatement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
    run(params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = Record<string, unknown>>(params?: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(params?: unknown[]): T[];
}

export interface ISqliteDriver {
    prepare(sql: string, params?: unknown[]): ISqliteStatement;
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
    exec(sql: string): void;
    transaction<T>(fn: () => T): T;
    readOnlyTransaction<T>(fn: () => T): T;
    close(): void;
    backup(destPath: string): Promise<void>;
    getRowsModified(): number;
    isOpen(): boolean;
    onMutation(listener: () => void): () => void;
}

export interface SqliteDriverOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
}

class BetterSqliteStatementShim implements ISqliteStatement {
    private _rawStmt: any | null;
    private _params: unknown[] | null = null;
    private _rows: Record<string, unknown>[] | null = null;
    private _index: number = -1;
    private _driver: BetterSqliteDriver;

    constructor(driver: BetterSqliteDriver, rawStmt: any, initialParams?: unknown[]) {
        this._driver = driver;
        this._rawStmt = rawStmt;
        if (initialParams !== undefined && initialParams !== null) {
            this._params = Array.isArray(initialParams) ? initialParams : [initialParams];
        }
    }

    public bind(params?: unknown[]): boolean {
        this._rows = null;
        this._index = -1;
        if (params !== undefined && params !== null) {
            this._params = Array.isArray(params) ? params : [params];
        } else {
            this._params = null;
        }
        return true;
    }

    public step(): boolean {
        let rows = this._rows;
        if (rows === null) {
            try {
                const args = this._params ? this._params : [];
                rows = this._stmt().all(...args) as Record<string, unknown>[];
                this._rows = rows;
            } catch (err) {
                this._rows = [];
                throw err;
            }
            this._index = 0;
        } else {
            this._index++;
        }
        return this._index < rows.length;
    }

    public getAsObject(): Record<string, unknown> {
        if (this._rows && this._index >= 0 && this._index < this._rows.length) {
            return this._rows[this._index];
        }
        return {};
    }

    public free(): void {
        this._rows = null;
        this._index = -1;
        // Drop the raw better-sqlite3 Statement too. Keeping a reference here pinned
        // it until GC, and a Statement destructor that runs during Node's environment
        // teardown aborts the process (`Assertion failed: (env) != nullptr` inside
        // Statement::~Statement, via RemoveEnvironmentCleanupHook). free() is the
        // sql.js cursor idiom's release point, so this is where it belongs.
        this._rawStmt = null;
    }

    private _stmt(): any {
        if (!this._rawStmt) {
            throw new Error('Statement has been freed');
        }
        return this._rawStmt;
    }

    public run(params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        const info = this._stmt().run(...args);
        const changes = Number(info?.changes ?? 0);
        const lastInsertRowid = info?.lastInsertRowid ?? 0;
        this._driver.recordLastMutation(changes, lastInsertRowid);
        return { changes, lastInsertRowid };
    }

    public get<T = Record<string, unknown>>(params?: unknown[]): T | undefined {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        return this._stmt().get(...args) as T | undefined;
    }

    public all<T = Record<string, unknown>>(params?: unknown[]): T[] {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        return this._stmt().all(...args) as T[];
    }
}

/**
 * Every open driver, so the databases are closed while the Node environment is still
 * alive. better-sqlite3 finalizes a Database's statements in Database#close(); left to
 * GC at teardown, the Statement destructor calls RemoveEnvironmentCleanupHook after the
 * env is gone and Node aborts with `Assertion failed: (env) != nullptr` — a core dump
 * rather than an exception, which no try/catch can contain. sql.js had no native
 * handles and so needed nothing like this.
 */
const OPEN_DRIVERS = new Set<BetterSqliteDriver>();
/**
 * Closed drivers are kept here to prevent GC of their statement caches. A
 * closed driver's _stmtCache still holds raw better-sqlite3 Statement JS
 * wrappers. If the driver is GC'd, the cache is GC'd, the wrappers are GC'd,
 * and their destructors crash Node with `(env) != nullptr`. Keeping closed
 * drivers in this set pins them (and their caches) for the life of the process.
 * The exit hook clears this set as the very last step.
 */
const CLOSED_DRIVER_GRAVEYARD: BetterSqliteDriver[] = [];
let exitHookInstalled = false;

function closeAllOpenDrivers(forceGc: boolean = false): void {
    for (const drv of Array.from(OPEN_DRIVERS)) {
        try { drv.close(); } catch { /* teardown is best effort */ }
    }
    if (forceGc) {
        // Release the closed-driver graveyard so drivers (and their statement
        // caches and backup graveyards) become eligible for GC. Then force GC
        // so the destructors run NOW, while the env is still alive. Without
        // this, V8 may call the destructors during teardown, crashing Node with
        // `(env) != nullptr` in Statement::~Statement / Backup::~Backup.
        CLOSED_DRIVER_GRAVEYARD.length = 0;
        if ((global as any).gc) {
            try {
                (global as any).gc();
                (global as any).gc();
            } catch { /* best effort */ }
        }
    }
}

function installExitHook(): void {
    if (exitHookInstalled) {
        return;
    }
    exitHookInstalled = true;
    // beforeExit fires when the event loop empties (natural exit) — while the
    // environment is fully alive. Closing drivers here AND forcing GC collects
    // the better-sqlite3 Statement JS wrappers, so their C++ destructors run
    // while the env is still valid. Without this, the destructors fire during
    // teardown and hit `(env) != nullptr` in RemoveEnvironmentCleanupHook.
    // The exit hook is a fallback for process.exit() which skips beforeExit;
    // it closes drivers but must NOT call gc() — that triggers the crash.
    process.on('beforeExit', () => closeAllOpenDrivers(true));
    process.on('exit', () => closeAllOpenDrivers(false));
}

export class BetterSqliteDriver implements ISqliteDriver {
    private _db: any;
    private _lastChanges: number = 0;
    private _mutationListeners: Set<() => void> = new Set();
    // Savepoint name counter — used ONLY for generating unique SAVEPOINT names
    // (sp_1, sp_2, …). The authority for "are we in a transaction?" is
    // db.inTransaction, not this counter. A counter that drifts after an
    // escaped error or a multi-statement exec() can produce a colliding name,
    // but db.inTransaction ensures we never emit a SAVEPOINT against no
    // transaction (the bug that broke the old _transactionDepth approach).
    private _savepointCounter: number = 0;
    private _dbPath: string;

    constructor(dbPath: string, options?: SqliteDriverOptions) {
        this._dbPath = path.resolve(dbPath);
        // Ensure parent directory exists if creating/opening writable
        if (!options?.readonly) {
            const dir = path.dirname(this._dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        const Database = require('better-sqlite3');
        this._db = new Database(dbPath, {
            readonly: options?.readonly ?? false,
            fileMustExist: options?.fileMustExist ?? false,
            timeout: options?.timeout ?? 5000,
        });

        OPEN_DRIVERS.add(this);
        installExitHook();

        // Set mandatory WAL pragmas unless opened readonly. Use exec() instead of
        // pragma() to avoid creating uncached better-sqlite3 Statement JS wrappers
        // that would be GC'd later and crash Node with `(env) != nullptr` in their
        // destructor. exec() uses sqlite3_exec() internally, which does not create
        // Statement objects.
        if (!options?.readonly) {
            try {
                this._db.exec('PRAGMA journal_mode = WAL');
                this._db.exec('PRAGMA synchronous = NORMAL');
                this._db.exec('PRAGMA busy_timeout = 5000');
                this._db.exec('PRAGMA foreign_keys = ON');
            } catch (err) {
                console.error('[BetterSqliteDriver] Failed setting pragmas:', err);
            }
        }
    }

    public recordLastMutation(changes: number, _lastInsertRowid: number | bigint): void {
        this._lastChanges = changes;
        this._notifyMutation();
    }

    public onMutation(listener: () => void): () => void {
        this._mutationListeners.add(listener);
        return () => {
            this._mutationListeners.delete(listener);
        };
    }

    private _notifyMutation(): void {
        for (const listener of this._mutationListeners) {
            try {
                listener();
            } catch (err) {
                console.error('[BetterSqliteDriver] Mutation listener error:', err);
            }
        }
    }

    /**
     * Prepared statements are cached by SQL text and the cache is held strongly for the
     * life of the driver. The cache is NOT cleared in close() — see the note below.
     *
     * Two reasons, one of them a crash. (1) Every read on the old path re-compiled its
     * SQL: `get`/`all`/`run` each call prepare(), and the ~780 migrated sql.js
     * touchpoints hit this constantly. (2) better-sqlite3 destroys a Statement's C++
     * object when the JS wrapper is collected, and a wrapper collected during Node's
     * environment teardown — or during normal GC in a finalizer context where the env
     * is not set up — aborts the process outright: `Assertion failed: (env) !=
     * nullptr` in Statement::~Statement, a core dump no try/catch can see. Uncached
     * statements became garbage on every call, so the collection sometimes landed in
     * teardown (measured: 2 aborts in 5 runs of the backup-retention suite). Holding
     * them in the cache pins them for the life of the driver, preventing GC collection.
     * db.close() finalizes the C++ statements; the JS wrappers become hollow shells
     * that V8 frees during teardown without calling destructors.
     *
     * Reuse is safe here because the cursor shim materialises rows with `.all()` rather
     * than streaming with `.iterate()`, so a cached statement carries no cross-call
     * position. DDL invalidates the cache — see exec() and _stmtGraveyard.
     */
    private _stmtCache: Map<string, any> = new Map();
    /**
     * When DDL invalidates cached statements, the old JS wrappers are moved here
     * instead of being released. This prevents GC from collecting them in a
     * finalizer context where the env is not set up, which would crash Node with
     * `Assertion failed: (env) != nullptr`. The graveyard is never cleared — it
     * is a bounded memory leak (at most STMT_CACHE_MAX entries per DDL event,
     * and DDL is rare in steady state).
     */
    private _stmtGraveyard: any[] = [];
    // Upper bound on cached prepared statements. One compiled statement per
    // distinct SQL string, for the life of the process, was unbounded — a
    // generated-SQL path (e.g. dynamic column lists) could grow it without
    // limit. The LRU evicts the oldest entry when the cap is reached.
    private static readonly STMT_CACHE_MAX = 500;

    public prepare(sql: string, params?: unknown[]): ISqliteStatement {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        let rawStmt = this._stmtCache.get(sql);
        if (rawStmt) {
            // LRU: move-to-end so the most recently used key is last in
            // insertion order (the eviction candidate is the first key).
            this._stmtCache.delete(sql);
            this._stmtCache.set(sql, rawStmt);
        } else {
            rawStmt = this._db.prepare(sql);
            this._stmtCache.set(sql, rawStmt);
            if (this._stmtCache.size > BetterSqliteDriver.STMT_CACHE_MAX) {
                // Evict the oldest entry (first in insertion order). Move the
                // evicted JS wrapper to the graveyard to prevent GC collection
                // (see _stmtGraveyard comment).
                const oldest = this._stmtCache.keys().next().value;
                if (oldest !== undefined) {
                    const evicted = this._stmtCache.get(oldest);
                    this._stmtCache.delete(oldest);
                    if (evicted) {
                        this._stmtGraveyard.push(evicted);
                    }
                }
            }
        }
        return new BetterSqliteStatementShim(this, rawStmt, params);
    }

    public run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        const normalized = sql.trim().replace(/;+$/, '').trim().toUpperCase();
        if (normalized === 'BEGIN' || normalized.startsWith('BEGIN TRANSACTION') || normalized.startsWith('BEGIN DEFERRED') || normalized.startsWith('BEGIN IMMEDIATE') || normalized.startsWith('BEGIN EXCLUSIVE')) {
            this._beginTransaction(this._beginMode(normalized));
            return { changes: 0, lastInsertRowid: 0 };
        }
        if (normalized === 'COMMIT' || normalized.startsWith('COMMIT TRANSACTION') || normalized === 'END' || normalized.startsWith('END TRANSACTION')) {
            this._commitTransaction();
            return { changes: 0, lastInsertRowid: 0 };
        }
        if (normalized === 'ROLLBACK' || normalized.startsWith('ROLLBACK TRANSACTION')) {
            this._rollbackTransaction();
            return { changes: 0, lastInsertRowid: 0 };
        }

        const stmt = this.prepare(sql);
        return stmt.run(params);
    }

    public get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined {
        const stmt = this.prepare(sql);
        return stmt.get<T>(params);
    }

    public all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[] {
        const stmt = this.prepare(sql);
        return stmt.all<T>(params);
    }

    public exec(sql: string): void {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        const normalized = sql.trim().replace(/;+$/, '').trim().toUpperCase();
        if (normalized === 'BEGIN' || normalized.startsWith('BEGIN TRANSACTION') || normalized.startsWith('BEGIN DEFERRED') || normalized.startsWith('BEGIN IMMEDIATE') || normalized.startsWith('BEGIN EXCLUSIVE')) {
            this._beginTransaction(this._beginMode(normalized));
            return;
        }
        if (normalized === 'COMMIT' || normalized.startsWith('COMMIT TRANSACTION') || normalized === 'END' || normalized.startsWith('END TRANSACTION')) {
            this._commitTransaction();
            return;
        }
        if (normalized === 'ROLLBACK' || normalized.startsWith('ROLLBACK TRANSACTION')) {
            this._rollbackTransaction();
            return;
        }

        // DDL can drop, rename or reshape a table a cached statement was compiled
        // against (V70 does exactly that to worktrees, job_instructions and
        // kanban_meta), so the cache is discarded before the schema moves under it.
        // Old statements are moved to the graveyard to prevent GC collection (see
        // _stmtGraveyard comment).
        if (/\b(CREATE|DROP|ALTER)\b/i.test(sql)) {
            for (const stmt of this._stmtCache.values()) {
                this._stmtGraveyard.push(stmt);
            }
            this._stmtCache.clear();
        }
        this._db.exec(sql);
        // If SQL contained mutation statements, notify
        if (/INSERT\s+|UPDATE\s+|DELETE\s+|REPLACE\s+|CREATE\s+|DROP\s+|ALTER\s+/i.test(sql)) {
            this._notifyMutation();
        }
    }

    /**
     * Determine the BEGIN mode from a normalized SQL string. A bare `BEGIN` or
     * `BEGIN TRANSACTION` defaults to `IMMEDIATE` — a deferred transaction that
     * later upgrades to a write can raise SQLITE_BUSY_SNAPSHOT, which
     * busy_timeout does NOT retry (unlike ordinary SQLITE_BUSY). An explicit
     * `BEGIN DEFERRED` is honoured (the caller accepted the snapshot risk, or
     * knows the transaction is read-only). `BEGIN IMMEDIATE`/`BEGIN EXCLUSIVE`
     * pass through unchanged.
     */
    private _beginMode(normalized: string): 'immediate' | 'deferred' | 'exclusive' {
        if (normalized.startsWith('BEGIN DEFERRED')) return 'deferred';
        if (normalized.startsWith('BEGIN EXCLUSIVE')) return 'exclusive';
        return 'immediate';
    }

    private _beginTransaction(mode: 'immediate' | 'deferred' | 'exclusive' = 'immediate'): void {
        if (!this._db.inTransaction) {
            const cmd = mode === 'deferred'
                ? 'BEGIN DEFERRED'
                : mode === 'exclusive'
                    ? 'BEGIN EXCLUSIVE'
                    : 'BEGIN IMMEDIATE';
            this._db.exec(cmd);
        } else {
            this._savepointCounter++;
            this._db.exec(`SAVEPOINT sp_${this._savepointCounter}`);
        }
    }

    private _commitTransaction(): void {
        if (!this._db.inTransaction) {
            return;
        }
        if (this._savepointCounter > 0) {
            this._db.exec(`RELEASE SAVEPOINT sp_${this._savepointCounter}`);
            this._savepointCounter--;
        } else {
            this._db.exec('COMMIT');
            this._notifyMutation();
        }
    }

    private _rollbackTransaction(): void {
        if (!this._db.inTransaction) {
            return;
        }
        if (this._savepointCounter > 0) {
            this._db.exec(`ROLLBACK TO SAVEPOINT sp_${this._savepointCounter}`);
            this._db.exec(`RELEASE SAVEPOINT sp_${this._savepointCounter}`);
            this._savepointCounter--;
        } else {
            this._db.exec('ROLLBACK');
        }
    }

    public transaction<T>(fn: () => T): T {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        this._beginTransaction('immediate');
        try {
            const result = fn();
            this._commitTransaction();
            return result;
        } catch (err) {
            this._rollbackTransaction();
            throw err;
        }
    }

    public readOnlyTransaction<T>(fn: () => T): T {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        this._beginTransaction('deferred');
        try {
            const result = fn();
            this._commitTransaction();
            return result;
        } catch (err) {
            this._rollbackTransaction();
            throw err;
        }
    }

    public close(): void {
        OPEN_DRIVERS.delete(this);
        // Move to the closed-driver graveyard to prevent GC of this driver (and
        // its statement cache). If the driver were GC'd, the raw better-sqlite3
        // Statement JS wrappers in _stmtCache would be GC'd, and their destructors
        // would crash Node with `(env) != nullptr`. See CLOSED_DRIVER_GRAVEYARD.
        CLOSED_DRIVER_GRAVEYARD.push(this);
        // NOTE: Do NOT clear _stmtCache here. The cache pins the raw Statement JS
        // wrappers, preventing GC collection in a finalizer context where the env
        // is not set up. db.close() finalizes the C++ statements; the JS wrappers
        // become hollow shells that V8 frees during process teardown without
        // calling destructors.
        if (this._db) {
            try {
                this._db.close();
            } catch (err) {
                console.error('[BetterSqliteDriver] Close error:', err);
            }
            this._db = null;
        }
        // A half-open savepoint counter must not survive the handle: leaving it
        // non-zero would make the next nested BEGIN emit a SAVEPOINT against no
        // transaction. db.inTransaction is the authority, but the counter feeds
        // savepoint names, so reset it too.
        this._savepointCounter = 0;
        this._mutationListeners.clear();
    }

    public async backup(destPath: string): Promise<void> {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        // Use VACUUM INTO instead of Database.backup() to avoid creating a
        // better-sqlite3 Backup JS wrapper. Backup::~Backup calls
        // RemoveEnvironmentCleanupHook, which crashes Node with
        // `(env) != nullptr` if the wrapper is GC'd in a finalizer context.
        // VACUUM INTO creates a consistent snapshot without native objects.
        const resolvedDest = path.resolve(destPath);
        // Ensure parent directory exists
        const dir = path.dirname(resolvedDest);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        // Quote the path for SQL safety
        const sqlPath = resolvedDest.replace(/'/g, "''");
        this._db.exec(`VACUUM INTO '${sqlPath}'`);
    }

    public getRowsModified(): number {
        return this._lastChanges;
    }

    public isOpen(): boolean {
        return this._db !== null && this._db !== undefined;
    }
}
