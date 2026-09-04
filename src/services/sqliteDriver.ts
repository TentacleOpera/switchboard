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
    close(): void;
    backup(destPath: string): Promise<void>;
    lastInsertRowid(): number | bigint;
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
let exitHookInstalled = false;

function installExitHook(): void {
    if (exitHookInstalled) {
        return;
    }
    exitHookInstalled = true;
    process.on('exit', () => {
        for (const drv of Array.from(OPEN_DRIVERS)) {
            try { drv.close(); } catch { /* teardown is best effort */ }
        }
    });
}

export class BetterSqliteDriver implements ISqliteDriver {
    private _db: any;
    private _lastChanges: number = 0;
    private _lastInsertRowid: number | bigint = 0;
    private _mutationListeners: Set<() => void> = new Set();
    private _transactionDepth: number = 0;

    constructor(dbPath: string, options?: SqliteDriverOptions) {
        // Ensure parent directory exists if creating/opening writable
        if (!options?.readonly) {
            const dir = path.dirname(path.resolve(dbPath));
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

        // Set mandatory WAL pragmas unless opened readonly
        if (!options?.readonly) {
            try {
                this._db.pragma('journal_mode = WAL');
                this._db.pragma('synchronous = NORMAL');
                this._db.pragma('busy_timeout = 5000');
                this._db.pragma('foreign_keys = ON');
            } catch (err) {
                console.error('[BetterSqliteDriver] Failed setting pragmas:', err);
            }
        }
    }

    public recordLastMutation(changes: number, lastInsertRowid: number | bigint): void {
        this._lastChanges = changes;
        this._lastInsertRowid = lastInsertRowid;
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
     * life of the driver, then dropped in close().
     *
     * Two reasons, one of them a crash. (1) Every read on the old path re-compiled its
     * SQL: `get`/`all`/`run` each call prepare(), and the ~780 migrated sql.js
     * touchpoints hit this constantly. (2) better-sqlite3 destroys a Statement's C++
     * object when the JS wrapper is collected, and a wrapper collected during Node's
     * environment teardown aborts the process outright — `Assertion failed: (env) !=
     * nullptr` in Statement::~Statement, a core dump no try/catch can see. Uncached
     * statements became garbage on every call, so the collection sometimes landed in
     * teardown (measured: 2 aborts in 5 runs of the backup-retention suite). Holding
     * them until close() keeps destruction inside a live environment.
     *
     * Reuse is safe here because the cursor shim materialises rows with `.all()` rather
     * than streaming with `.iterate()`, so a cached statement carries no cross-call
     * position. DDL invalidates the cache — see exec().
     */
    private _stmtCache: Map<string, any> = new Map();

    public prepare(sql: string, params?: unknown[]): ISqliteStatement {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        let rawStmt = this._stmtCache.get(sql);
        if (!rawStmt) {
            rawStmt = this._db.prepare(sql);
            this._stmtCache.set(sql, rawStmt);
        }
        return new BetterSqliteStatementShim(this, rawStmt, params);
    }

    public run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        const normalized = sql.trim().replace(/;+$/, '').trim().toUpperCase();
        if (normalized === 'BEGIN' || normalized.startsWith('BEGIN TRANSACTION') || normalized.startsWith('BEGIN DEFERRED') || normalized.startsWith('BEGIN IMMEDIATE') || normalized.startsWith('BEGIN EXCLUSIVE')) {
            this._beginTransaction();
            return { changes: 0, lastInsertRowid: this._lastInsertRowid };
        }
        if (normalized === 'COMMIT' || normalized.startsWith('COMMIT TRANSACTION') || normalized === 'END' || normalized.startsWith('END TRANSACTION')) {
            this._commitTransaction();
            return { changes: 0, lastInsertRowid: this._lastInsertRowid };
        }
        if (normalized === 'ROLLBACK' || normalized.startsWith('ROLLBACK TRANSACTION')) {
            this._rollbackTransaction();
            return { changes: 0, lastInsertRowid: this._lastInsertRowid };
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
            this._beginTransaction();
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
        if (/\b(CREATE|DROP|ALTER)\b/i.test(sql)) {
            this._stmtCache.clear();
        }
        this._db.exec(sql);
        // If SQL contained mutation statements, notify
        if (/INSERT\s+|UPDATE\s+|DELETE\s+|REPLACE\s+|CREATE\s+|DROP\s+|ALTER\s+/i.test(sql)) {
            this._notifyMutation();
        }
    }

    private _beginTransaction(): void {
        if (this._transactionDepth === 0) {
            this._db.exec('BEGIN');
        } else {
            this._db.exec(`SAVEPOINT sp_${this._transactionDepth}`);
        }
        this._transactionDepth++;
    }

    private _commitTransaction(): void {
        if (this._transactionDepth <= 0) {
            return;
        }
        this._transactionDepth--;
        if (this._transactionDepth === 0) {
            this._db.exec('COMMIT');
            this._notifyMutation();
        } else {
            this._db.exec(`RELEASE SAVEPOINT sp_${this._transactionDepth}`);
        }
    }

    private _rollbackTransaction(): void {
        if (this._transactionDepth <= 0) {
            return;
        }
        this._transactionDepth--;
        if (this._transactionDepth === 0) {
            this._db.exec('ROLLBACK');
        } else {
            this._db.exec(`ROLLBACK TO SAVEPOINT sp_${this._transactionDepth}`);
            this._db.exec(`RELEASE SAVEPOINT sp_${this._transactionDepth}`);
        }
    }

    public transaction<T>(fn: () => T): T {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        this._beginTransaction();
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
        // Drop the statement cache BEFORE closing, so the wrappers become collectable
        // while the Node environment is still alive (see the note on _stmtCache).
        this._stmtCache.clear();
        if (this._db) {
            try {
                this._db.close();
            } catch (err) {
                console.error('[BetterSqliteDriver] Close error:', err);
            }
            this._db = null;
        }
        // A half-open transaction must not survive the handle: leaving the depth
        // non-zero would make the next BEGIN on a reopened driver emit a SAVEPOINT
        // against no transaction.
        this._transactionDepth = 0;
        this._mutationListeners.clear();
    }

    public async backup(destPath: string): Promise<void> {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        await this._db.backup(destPath);
    }

    public lastInsertRowid(): number | bigint {
        return this._lastInsertRowid;
    }

    public getRowsModified(): number {
        return this._lastChanges;
    }

    public isOpen(): boolean {
        return this._db !== null && this._db !== undefined;
    }
}
