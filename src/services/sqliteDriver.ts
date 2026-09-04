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
    private _rawStmt: any;
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
        if (this._rows === null) {
            try {
                const args = this._params ? this._params : [];
                this._rows = this._rawStmt.all(...args);
            } catch (err) {
                this._rows = [];
                throw err;
            }
            this._index = 0;
        } else {
            this._index++;
        }
        return this._index < this._rows.length;
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
    }

    public run(params?: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        const info = this._rawStmt.run(...args);
        const changes = Number(info?.changes ?? 0);
        const lastInsertRowid = info?.lastInsertRowid ?? 0;
        this._driver.recordLastMutation(changes, lastInsertRowid);
        return { changes, lastInsertRowid };
    }

    public get<T = Record<string, unknown>>(params?: unknown[]): T | undefined {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        return this._rawStmt.get(...args) as T | undefined;
    }

    public all<T = Record<string, unknown>>(params?: unknown[]): T[] {
        const args = params !== undefined && params !== null
            ? (Array.isArray(params) ? params : [params])
            : (this._params ? this._params : []);
        return this._rawStmt.all(...args) as T[];
    }
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

    public prepare(sql: string, params?: unknown[]): ISqliteStatement {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        const rawStmt = this._db.prepare(sql);
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
        if (this._db) {
            try {
                this._db.close();
            } catch (err) {
                console.error('[BetterSqliteDriver] Close error:', err);
            }
            this._db = null;
        }
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
