/**
 * Shared-store safety: migration lock, version gate, and offline posture.
 *
 * These are the safety mechanisms that make a shared libSQL store safe to
 * operate without a server:
 *
 * 1. **Migration lock**: prevents two machines on different extension
 *    versions from both migrating one shared database. A `schema_migration_lock`
 *    table with a single lock row is acquired before migrations run and
 *    released after. A machine that cannot acquire the lock waits.
 *
 * 2. **Version gate**: a `schema_version` row records the client version
 *    that last migrated the store. A client refuses to open a store
 *    migrated *ahead* of it rather than running a downgrade.
 *
 * 3. **Offline posture**: when the remote is unreachable, reads succeed
 *    from the local replica but writes are refused with a visible state.
 *    A queue would mean a divergent local branch of board state with no
 *    arbitration on reconnect — the property this plan exists to buy.
 *
 * See `.switchboard/plans/libsql-shared-store-turso-and-self-hosted-sqld.md`.
 */

import type { ISqliteDriver } from './sqliteDriver';

export interface MigrationLockResult {
    acquired: boolean;
    /** The version that currently holds the lock, if any. */
    heldBy?: string;
    /** When the lock was acquired, if held. */
    heldAt?: string;
}

export interface SchemaVersionCheck {
    /** The client's schema version. */
    clientVersion: number;
    /** The store's schema version (0 if uninitialised). */
    storeVersion: number;
    /** True if the store is at or below the client's version (safe to open). */
    safe: boolean;
    /** True if the store is ahead of the client (must refuse). */
    ahead: boolean;
}

export interface OfflineStatus {
    online: boolean;
    /** Error message if offline. */
    error?: string;
}

/**
 * Acquire the schema migration lock. Returns `acquired: true` if this
 * machine now holds the lock. The lock has a TTL (5 minutes) so a crashed
 * machine's lock expires and another machine can take over.
 */
export function acquireMigrationLock(
    db: ISqliteDriver,
    clientId: string,
    ttlMs: number = 5 * 60 * 1000
): MigrationLockResult {
    try {
        // Ensure the lock table exists.
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migration_lock (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                holder_id TEXT NOT NULL,
                acquired_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )
        `);

        // Try to acquire via CAS: if no row or expired, take it.
        db.exec('BEGIN IMMEDIATE');
        try {
            const stmt = db.prepare('SELECT holder_id, expires_at FROM schema_migration_lock WHERE id = 1');
            let row: any = null;
            try {
                if (stmt.step()) {
                    row = stmt.getAsObject();
                }
            } finally {
                stmt.free();
            }

            const now = new Date().toISOString();
            const expiresAt = new Date(Date.now() + ttlMs).toISOString();

            if (!row) {
                // No lock — acquire it.
                db.run(
                    'INSERT INTO schema_migration_lock (id, holder_id, acquired_at, expires_at) VALUES (1, ?, ?, ?)',
                    [clientId, now, expiresAt]
                );
                db.exec('COMMIT');
                return { acquired: true };
            }

            // Check if the existing lock has expired.
            const existingExpiresAt = new Date(row.expires_at).getTime();
            if (Date.now() >= existingExpiresAt) {
                // Lock expired — take over.
                db.run(
                    'UPDATE schema_migration_lock SET holder_id = ?, acquired_at = ?, expires_at = ? WHERE id = 1',
                    [clientId, now, expiresAt]
                );
                db.exec('COMMIT');
                return { acquired: true };
            }

            // Lock is held by someone else and hasn't expired.
            db.exec('COMMIT');
            return { acquired: false, heldBy: row.holder_id, heldAt: row.expires_at };
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    } catch (e) {
        console.error('[SharedStoreSafety] acquireMigrationLock failed:', e);
        return { acquired: false };
    }
}

/**
 * Release the schema migration lock. Only releases if this machine holds it.
 */
export function releaseMigrationLock(db: ISqliteDriver, clientId: string): void {
    try {
        db.run('DELETE FROM schema_migration_lock WHERE id = 1 AND holder_id = ?', [clientId]);
    } catch (e) {
        console.error('[SharedStoreSafety] releaseMigrationLock failed:', e);
    }
}

/**
 * Check the schema version of the shared store against the client's version.
 * Returns `safe: true` if the store is at or below the client's version
 * (the client can safely open and migrate). Returns `ahead: true` if the
 * store is ahead (the client must refuse — never downgrade).
 */
export function checkSchemaVersion(db: ISqliteDriver, clientVersion: number): SchemaVersionCheck {
    try {
        // Ensure the version table exists.
        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_version (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version INTEGER NOT NULL,
                updated_at TEXT NOT NULL,
                client_id TEXT DEFAULT ''
            )
        `);

        const stmt = db.prepare('SELECT version FROM schema_version WHERE id = 1');
        let storeVersion = 0;
        try {
            if (stmt.step()) {
                const row = stmt.getAsObject();
                storeVersion = Number(row.version) || 0;
            }
        } finally {
            stmt.free();
        }

        return {
            clientVersion,
            storeVersion,
            safe: storeVersion <= clientVersion,
            ahead: storeVersion > clientVersion,
        };
    } catch (e) {
        console.error('[SharedStoreSafety] checkSchemaVersion failed:', e);
        return { clientVersion, storeVersion: 0, safe: true, ahead: false };
    }
}

/**
 * Record the schema version after a successful migration. Called after
 * migrations complete to stamp the store with the client's version.
 */
export function recordSchemaVersion(db: ISqliteDriver, version: number, clientId: string): void {
    try {
        const now = new Date().toISOString();
        db.run(
            `INSERT INTO schema_version (id, version, updated_at, client_id) VALUES (1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET version = ?, updated_at = ?, client_id = ?`,
            [version, now, clientId, version, now, clientId]
        );
    } catch (e) {
        console.error('[SharedStoreSafety] recordSchemaVersion failed:', e);
    }
}

/**
 * Check if the remote libSQL server is reachable by attempting a sync.
 * Returns `online: true` if the sync succeeds, `online: false` with an
 * error message if it fails.
 *
 * In offline mode, reads succeed from the local replica but writes must
 * be refused — a queue would mean a divergent local branch of board state
 * with no arbitration on reconnect.
 */
export function checkOnlineStatus(driver: any): OfflineStatus {
    // Only libsql drivers with syncUrl have a remote to check.
    if (!driver || typeof driver.sync !== 'function') {
        return { online: true }; // local-file — always "online"
    }
    try {
        driver.sync();
        return { online: true };
    } catch (e) {
        return {
            online: false,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
