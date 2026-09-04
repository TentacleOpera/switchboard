import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ResolvedDbPath {
    path: string;
    source: 'env' | 'global_default' | 'explicit';
}

const CLOUD_SYNC_KEYWORDS = [
    'dropbox',
    'onedrive',
    'icloud',
    'google drive',
    'googledrive',
    'nextcloud',
    'owncloud',
    'box sync',
];

/**
 * Returns the directory path for global machine storage (~/.switchboard).
 */
export function getGlobalStoreDir(): string {
    const home = os.homedir();
    return path.join(home, '.switchboard');
}

/**
 * Validate that target path is not inside a git work tree or cloud-synced folder.
 * Refuses paths inside git repositories to prevent committing machine state.
 */
export function validateGlobalDbPath(targetPath: string): { ok: boolean; reason?: string } {
    const resolved = path.resolve(targetPath);
    const lower = resolved.toLowerCase();

    for (const kw of CLOUD_SYNC_KEYWORDS) {
        if (lower.includes(kw)) {
            return {
                ok: false,
                reason: `Global database path cannot be inside cloud-synced folder containing '${kw}': ${resolved}`,
            };
        }
    }

    // Traverse upwards checking for .git (file or directory)
    let cur = path.dirname(resolved);
    while (cur && cur !== path.dirname(cur)) {
        const gitEntry = path.join(cur, '.git');
        if (fs.existsSync(gitEntry)) {
            return {
                ok: false,
                reason: `Global database path cannot be inside a git work tree at '${cur}': ${resolved}`,
            };
        }
        cur = path.dirname(cur);
    }

    return { ok: true };
}

/**
 * Ensure ~/.switchboard directory exists with mode 0700.
 */
export function ensureGlobalStoreDir(): string {
    const storeDir = getGlobalStoreDir();
    if (!fs.existsSync(storeDir)) {
        fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    }
    try {
        fs.chmodSync(storeDir, 0o700);
    } catch {
        // Best effort on non-POSIX filesystems
    }
    return storeDir;
}

/**
 * Resolve the global database path.
 * Sole authority for global database location.
 */
export function resolveGlobalDbPath(explicitPath?: string): ResolvedDbPath {
    if (explicitPath && explicitPath.trim() !== '') {
        const expanded = explicitPath.trim().startsWith('~')
            ? path.join(os.homedir(), explicitPath.trim().slice(1))
            : explicitPath.trim();
        const resolved = path.resolve(expanded);
        const check = validateGlobalDbPath(resolved);
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid database path: ${check.reason}`);
        }
        return { path: resolved, source: 'explicit' };
    }

    if (process.env.SWITCHBOARD_GLOBAL_DB_PATH && process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim() !== '') {
        const envPath = path.resolve(process.env.SWITCHBOARD_GLOBAL_DB_PATH.trim());
        const check = validateGlobalDbPath(envPath);
        if (!check.ok) {
            throw new Error(`[GlobalStore] Invalid SWITCHBOARD_GLOBAL_DB_PATH: ${check.reason}`);
        }
        return { path: envPath, source: 'env' };
    }

    ensureGlobalStoreDir();
    const defaultPath = path.join(getGlobalStoreDir(), 'switchboard.db');
    const check = validateGlobalDbPath(defaultPath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Default global database path failed validation: ${check.reason}`);
    }
    return { path: defaultPath, source: 'global_default' };
}

/**
 * Get the global database path string.
 */
export function getGlobalDbPath(explicitPath?: string): string {
    const resolved = resolveGlobalDbPath(explicitPath);
    return resolved.path;
}

/**
 * Get the cold archive database path string in the global store.
 */
export function getGlobalArchiveDbPath(): string {
    ensureGlobalStoreDir();
    const archivePath = path.join(getGlobalStoreDir(), 'kanban-archive.db');
    const check = validateGlobalDbPath(archivePath);
    if (!check.ok) {
        throw new Error(`[GlobalStore] Global archive path failed validation: ${check.reason}`);
    }
    return archivePath;
}

/**
 * Ensure file permissions for database are restricted to 0600.
 */
export function ensureDbPermissions(dbPath: string): void {
    if (fs.existsSync(dbPath)) {
        try {
            fs.chmodSync(dbPath, 0o600);
        } catch {
            // Best effort
        }
    }
}
