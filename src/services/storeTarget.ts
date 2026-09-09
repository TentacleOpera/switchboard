/**
 * Store-target abstraction — selects the database binding per configured target.
 *
 * `local-file` (default): uses `better-sqlite3` via `BetterSqliteDriver`.
 * `libsql`: uses `libsql` via `LibSqlDriver`, lazily required as an
 *   `optionalDependency` only when a libSQL target is configured. Local-only
 *   installs never load `libsql`, so they take no prebuild risk for a feature
 *   they do not use.
 *
 * The sidecar is the sole opener of the database and every other client reaches
 * it over the `LocalApiServer` HTTP surface, so the binding changes inside one
 * process behind an unchanged contract.
 *
 * See `.switchboard/plans/libsql-shared-store-turso-and-self-hosted-sqld.md`.
 */

import type { ISqliteDriver, SqliteDriverOptions } from './sqliteDriver';
import { BetterSqliteDriver } from './sqliteDriver';

export type StoreTargetKind = 'local-file' | 'libsql';

export interface StoreTargetConfig {
    kind: StoreTargetKind;
    /** For `libsql`: the remote URL (e.g. `libsql://<db>.turso.io` or `http://localhost:8080`). */
    url?: string;
    /** For `libsql`: the auth token. Stored in `encryptedSecretsStore`, never `settings.json`. */
    authToken?: string;
    /** For `libsql` embedded replica: the local replica file path. */
    replicaPath?: string;
    /** For `libsql` embedded replica: the sync URL. */
    syncUrl?: string;
}

/**
 * Resolve the active store target from configuration. Returns `local-file`
 * (the default) when no libSQL target is configured.
 *
 * Configuration is read from the `switchboard.storeTarget` setting:
 *   - `none` / `local-file` → local-file (default)
 *   - `libsql` → libSQL (requires `storeTarget.url` and `storeTarget.authToken`)
 */
export function resolveStoreTarget(): StoreTargetConfig {
    const mode = _readConfig('storeTarget', 'local-file');
    if (mode === 'libsql') {
        const url = _readConfig('storeTarget.url', '');
        const authToken = _readConfig('storeTarget.authToken', '');
        const replicaPath = _readConfig('storeTarget.replicaPath', '');
        const syncUrl = _readConfig('storeTarget.syncUrl', '');
        return { kind: 'libsql', url, authToken, replicaPath, syncUrl };
    }
    return { kind: 'local-file' };
}

function _readConfig(key: string, fallback: string): string {
    // Try the path config provider first (set by the extension host).
    try {
        const KanbanDatabase = require('./KanbanDatabase');
        const provider = KanbanDatabase.KanbanDatabase._pathConfigProvider;
        if (provider) {
            const val = provider.getConfigString(key);
            if (val) { return val; }
        }
    } catch { /* outside extension host */ }
    // Fall back to VS Code configuration.
    try {
        const vscode = require('vscode');
        const config = vscode.workspace.getConfiguration('switchboard');
        return String(config.get(key, fallback));
    } catch { /* outside extension host */ }
    return fallback;
}

/**
 * Open a database driver for the given path, selecting the binding based on
 * the configured store target.
 *
 * For `local-file`: opens a `BetterSqliteDriver` against `dbPath`.
 * For `libsql` with a `replicaPath`: opens a `LibSqlDriver` in embedded-replica
 *   mode, using `replicaPath` as the local file and `syncUrl`/`authToken` for
 *   the remote.
 * For `libsql` without a `replicaPath`: opens a `LibSqlDriver` in remote-only
 *   mode against `url`/`authToken`.
 */
export function openDriver(dbPath: string, options?: SqliteDriverOptions): ISqliteDriver {
    const target = resolveStoreTarget();
    if (target.kind === 'libsql') {
        // Lazily require LibSqlDriver so local-only installs never load `libsql`.
        const { LibSqlDriver } = require('./libSqlDriver');
        const replicaPath = target.replicaPath || dbPath;
        return new LibSqlDriver(replicaPath, {
            url: target.url,
            authToken: target.authToken,
            syncUrl: target.syncUrl || target.url,
            ...options,
        });
    }
    return new BetterSqliteDriver(dbPath, options);
}

/**
 * Check whether a libSQL target is configured and the `libsql` binding is
 * available. Returns `{ available: false, reason: string }` when the binding
 * cannot be loaded, so the caller can surface a clear error rather than a
 * silent fallback to local-only (which would diverge from the configured
 * authority).
 */
export function checkLibSqlAvailability(): { available: boolean; reason?: string } {
    const target = resolveStoreTarget();
    if (target.kind !== 'libsql') {
        return { available: true }; // local-file — better-sqlite3 is always available
    }
    if (!target.url) {
        return { available: false, reason: 'storeTarget is libsql but storeTarget.url is not set' };
    }
    try {
        require('libsql');
        return { available: true };
    } catch (e) {
        return {
            available: false,
            reason: `libsql binding not available: ${e instanceof Error ? e.message : String(e)}. ` +
                'Install it with `npm install libsql` or switch storeTarget to local-file.',
        };
    }
}
