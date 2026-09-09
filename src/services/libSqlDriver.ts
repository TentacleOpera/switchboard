/**
 * LibSqlDriver — a `libsql`-backed implementation of `ISqliteDriver`.
 *
 * `libsql` exposes a better-sqlite3-compatible synchronous API, so this
 * driver mirrors `BetterSqliteDriver` closely. The key addition is
 * embedded-replica support: when a `syncUrl` is provided, the driver opens
 * a local replica file and syncs with the remote libSQL server. Reads are
 * served from the local replica (microsecond-fast); writes are forwarded
 * to the remote and synced back.
 *
 * Offline posture: when the remote is unreachable, reads succeed from the
 * replica but writes are refused with a visible error (not queued). A queue
 * would mean a divergent local branch of board state with no arbitration on
 * reconnect, which is the property the libSQL plan exists to buy.
 *
 * See `.switchboard/plans/libsql-shared-store-turso-and-self-hosted-sqld.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ISqliteDriver, ISqliteStatement, SqliteDriverOptions } from './sqliteDriver';
import { BetterSqliteStatementShim } from './sqliteDriver';

export interface LibSqlDriverOptions extends SqliteDriverOptions {
    /** Remote libSQL URL (e.g. `libsql://<db>.turso.io` or `http://localhost:8080`). */
    url?: string;
    /** Auth token for the remote. */
    authToken?: string;
    /** Sync URL for embedded replica. If provided, opens in replica mode. */
    syncUrl?: string;
}

export class LibSqlDriver implements ISqliteDriver {
    private _db: any;
    private _lastChanges: number = 0;
    private _mutationListeners: Set<() => void> = new Set();
    private _savepointCounter: number = 0;
    private _dbPath: string;
    private _syncUrl: string | undefined;
    private _authToken: string | undefined;
    private _stmtCache: Map<string, any> = new Map();
    private _stmtGraveyard: any[] = [];
    private static readonly STMT_CACHE_MAX = 500;

    constructor(dbPath: string, options?: LibSqlDriverOptions) {
        this._dbPath = path.resolve(dbPath);
        this._syncUrl = options?.syncUrl;
        this._authToken = options?.authToken;

        // Ensure parent directory exists if creating/opening writable.
        if (!options?.readonly) {
            const dir = path.dirname(this._dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Lazily require libsql — local-only installs never load it.
        const Database = require('libsql');

        const dbOptions: any = {
            readonly: options?.readonly ?? false,
            fileMustExist: options?.fileMustExist ?? false,
            timeout: options?.timeout ?? 5000,
        };

        // Embedded replica mode: open a local file that syncs with a remote.
        if (this._syncUrl) {
            dbOptions.syncUrl = this._syncUrl;
            if (this._authToken) {
                dbOptions.authToken = this._authToken;
            }
        }

        this._db = new Database(this._dbPath, dbOptions);

        // Set mandatory pragmas unless opened readonly.
        if (!options?.readonly) {
            try {
                this._db.exec('PRAGMA journal_mode = WAL');
                this._db.exec('PRAGMA synchronous = NORMAL');
                this._db.exec('PRAGMA busy_timeout = 5000');
                this._db.exec('PRAGMA foreign_keys = ON');
            } catch (err) {
                console.error('[LibSqlDriver] Failed setting pragmas:', err);
            }
        }

        // Initial sync if in replica mode.
        if (this._syncUrl) {
            try {
                this._db.sync();
            } catch (err) {
                console.error('[LibSqlDriver] Initial sync failed (continuing with local replica):', err);
                // Not fatal — reads succeed from the local replica.
            }
        }
    }

    /**
     * Sync the embedded replica with the remote. Called on write, on focus,
     * and on a slow timer. Pulls remote changes into the local replica.
     */
    public sync(): void {
        if (!this._db || !this._syncUrl) { return; }
        try {
            this._db.sync();
        } catch (err) {
            console.error('[LibSqlDriver] sync failed:', err);
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
                console.error('[LibSqlDriver] Mutation listener error:', err);
            }
        }
    }

    public prepare(sql: string, params?: unknown[]): ISqliteStatement {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        let rawStmt = this._stmtCache.get(sql);
        if (rawStmt) {
            this._stmtCache.delete(sql);
            this._stmtCache.set(sql, rawStmt);
        } else {
            rawStmt = this._db.prepare(sql);
            this._stmtCache.set(sql, rawStmt);
            if (this._stmtCache.size > LibSqlDriver.STMT_CACHE_MAX) {
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
        return new BetterSqliteStatementShim(this as any, rawStmt, params);
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
        const result = stmt.run(params);
        // Sync after a successful write in replica mode.
        if (this._syncUrl) {
            this.sync();
        }
        return result;
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

        // DDL invalidates the statement cache.
        if (/\b(CREATE|DROP|ALTER)\b/i.test(sql)) {
            for (const stmt of this._stmtCache.values()) {
                this._stmtGraveyard.push(stmt);
            }
            this._stmtCache.clear();
        }
        this._db.exec(sql);
        if (/INSERT\s+|UPDATE\s+|DELETE\s+|REPLACE\s+|CREATE\s+|DROP\s+|ALTER\s+/i.test(sql)) {
            this._notifyMutation();
            // Sync after a mutation in replica mode.
            if (this._syncUrl) {
                this.sync();
            }
        }
    }

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
            if (this._syncUrl) {
                this.sync();
            }
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
        if (this._db) {
            try {
                this._db.close();
            } catch (err) {
                console.error('[LibSqlDriver] close error:', err);
            }
            this._db = null;
        }
        this._stmtCache.clear();
    }

    public async backup(destPath: string): Promise<void> {
        if (!this._db) {
            throw new Error('Database is closed');
        }
        // libsql supports the backup API similarly to better-sqlite3.
        const backup = this._db.backup(destPath);
        try {
            await backup;
        } catch (err) {
            console.error('[LibSqlDriver] backup error:', err);
            throw err;
        }
    }

    public getRowsModified(): number {
        return this._lastChanges;
    }

    public isOpen(): boolean {
        return this._db !== null;
    }
}
